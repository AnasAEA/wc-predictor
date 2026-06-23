/**
 * scripts/shadow-log.mjs — Phase 4 plumbing in SHADOW MODE.
 *
 * Every time it runs (chained after the odds fetch), it compares the live model to the de-vigged sharp
 * line and logs any selection whose model EV clears a threshold to data/bet_log.json — a chronologically
 * accurate, append-only record of theoretical bets. No money, no calibration yet: it exists so that by the
 * time the calibration (Phase 2) and value engine (Phase 3) are ready, we already have a clean signal log
 * to test against, instead of reconstructing it retroactively (where bugs hide).
 *
 * Lifecycle of a bet_log entry, keyed by match|market|line|selection:
 *   1. first time EV ≥ threshold  → create with placement odds + timestamp + model/market probs
 *   2. within the close window     → fill closing_odds + timestamp_close (the sharp closing line)
 *   3. once the match is FT         → fill result + pnl + clv
 *
 *   node scripts/shadow-log.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildState } from "../model/predict.mjs";
import { shin } from "../betting/devig.mjs";
import { modelWinProb, settle, clv } from "../betting/clv.mjs";
import { evaluate, DEFAULT_CONFIG } from "../betting/value_engine.mjs";
import { calibrate1x2 } from "../model/calibrate.mjs";

const EV_THRESHOLD = Number(process.env.SHADOW_EV_THRESHOLD || DEFAULT_CONFIG.minEV); // log a signal at ≥3% model EV
const CLOSE_WINDOW_MIN = Number(process.env.CLOSE_WINDOW_MIN || 20);
const SHARP_PREF = ["pinnacle", "betfair_ex_eu", "betfair_ex_uk", "betfair"];
const CONFIG = { ...DEFAULT_CONFIG, bankroll: Number(process.env.BANKROLL || DEFAULT_CONFIG.bankroll) };
const OUT = new URL("../data/bet_log.json", import.meta.url);
const J = p => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

const teamsRaw = J("../data/teams.json"); const teams = teamsRaw.teams || teamsRaw;
const fixtures = J("../data/matches.json").matches;
const results = J("../data/results.json").matches;
const efi = (() => { try { return J("../data/efi.json").matches || {}; } catch { return {}; } })();
const odds = existsSync(new URL("../data/odds.json", import.meta.url)) ? J("../data/odds.json") : { matches: {} };

// calibration: apply ONLY when the gate has opened (status === "active"); otherwise fall back to raw
const calFile = existsSync(new URL("../data/calibration.json", import.meta.url)) ? J("../data/calibration.json") : null;
const calActive = calFile?.status === "active";
const cal1x2 = calActive ? calFile.markets?.["1x2"] : null;

const state = buildState({ teams, fixtures, results, efi });
const log = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { updated: null, entries: {} };
const entries = log.entries;
const now = Date.now();
const key = (id, market, line, sel) => `${id}|${market}|${line}|${sel}`;
const sharpOf = books => SHARP_PREF.find(b => books?.[b]) || null;

// candidate selections per market from one bookmaker's shaped odds → [{market,line,selection,odds, mProbs}]
function candidates(book, marketProbsByLine) {
  const out = [];
  if (book.h2h && book.h2h.every(x => x)) {
    const dv = shin(book.h2h).probs; // [H,D,A]
    out.push({ market: "1x2", line: 0, selection: "home", odds: book.h2h[0], marketProb: dv[0] });
    out.push({ market: "1x2", line: 0, selection: "draw", odds: book.h2h[1], marketProb: dv[1] });
    out.push({ market: "1x2", line: 0, selection: "away", odds: book.h2h[2], marketProb: dv[2] });
  }
  for (const [L, o] of Object.entries(book.totals || {})) {
    if (o.over && o.under) { const dv = shin([o.over, o.under]).probs;
      out.push({ market: "totals", line: +L, selection: "over", odds: o.over, marketProb: dv[0] });
      out.push({ market: "totals", line: +L, selection: "under", odds: o.under, marketProb: dv[1] }); }
  }
  for (const [L, o] of Object.entries(book.spreads || {})) {
    if (o.home && o.away) { const dv = shin([o.home, o.away]).probs;
      out.push({ market: "ah", line: +L, selection: "home", odds: o.home, marketProb: dv[0] });
      out.push({ market: "ah", line: +L, selection: "away", odds: o.away, marketProb: dv[1] }); }
  }
  return out;
}

let created = 0, closed = 0, settled = 0, scanned = 0;
for (const [id, rec] of Object.entries(odds.matches)) {
  const fx = fixtures.find(f => f.id === id); if (!fx) continue;
  const r = results[id]; const isFT = r && r.st === "FT" && r.h != null;
  const sharp = rec.latest?.sharp || sharpOf(rec.latest?.books);
  const book = rec.latest?.books?.[sharp];
  const started = +new Date(rec.commence) <= now;

  // 1+2) only predict/scan while the match is upcoming (we need a pre-match forecast)
  if (book && !started && !isFT) {
    const pred = state.predict(fx); if (!pred) continue; scanned++;
    const cal1x2Probs = cal1x2 ? calibrate1x2(cal1x2, { h: pred.wp.h, d: pred.wp.d, a: pred.wp.a }) : null;
    const nearClose = +new Date(rec.commence) - now <= CLOSE_WINDOW_MIN * 60000;
    for (const c of candidates(book, sharp)) {
      // model probability of THIS selection — calibrated for 1X2 when the gate is open, else raw
      const rawProb = modelWinProb(pred.cells, c.market, c.line, c.selection);
      const calProb = c.market === "1x2" && cal1x2Probs ? cal1x2Probs[c.selection === "home" ? "h" : c.selection === "draw" ? "d" : "a"] : rawProb;
      // EV/Kelly/stake: 1X2 uses the (calibrated) selection prob; line markets use the score-cell distribution
      const ve = c.market === "1x2"
        ? evaluate({ market: "1x2", line: c.line, selection: c.selection, odds: c.odds, p: calProb, config: CONFIG })
        : evaluate({ market: c.market, line: c.line, selection: c.selection, odds: c.odds, cells: pred.cells, config: CONFIG });
      const ev = ve.ev;
      const k = key(id, c.market, c.line, c.selection);
      if (!entries[k] && ev >= EV_THRESHOLD) {
        entries[k] = {
          match_id: id, home: fx.home.team, away: fx.away.team, commence: rec.commence,
          timestamp_placement: rec.latest.t, timestamp_close: null,
          market: c.market, line: c.line, selection: c.selection,
          model_prob_raw: +rawProb.toFixed(4), model_prob_used: +calProb.toFixed(4), calibrated: c.market === "1x2" && !!cal1x2Probs,
          market_prob_shin: +c.marketProb.toFixed(4), ev: +ev.toFixed(4),
          raw_edge: c.market === "1x2" ? +(calProb - c.marketProb).toFixed(4) : null,
          kelly_full: +ve.kelly.toFixed(4), stake_flat: ve.stake.flat, stake_kelly: ve.stake.kelly, bankroll: CONFIG.bankroll,
          placement_odds: c.odds, sharp, closing_odds: null, result: null, pnl: null, clv: null,
        };
        created++;
      }
      // 2) capture the closing line for any OPEN entry on this selection
      if (entries[k] && entries[k].closing_odds == null && nearClose) {
        entries[k].closing_odds = c.odds; entries[k].timestamp_close = rec.latest.t;
        entries[k].clv = clv({ placementOdds: entries[k].placement_odds, closingOdds: c.odds, placementProb: entries[k].market_prob_shin, closingProb: c.marketProb }).clvOdds;
        closed++;
      }
    }
  }

  // 2b) authoritative closing line from the persisted rec.close snapshot (fetch-odds captures it in the KO window).
  // This is the real closing line for CLV: it runs for EVERY match — including ones already started/finished, the
  // case the upcoming-only block above can never reach — and overwrites any earlier latest-based estimate. Idempotent
  // on re-runs once timestamp_close matches rec.close.t. Without this, closing_odds/CLV stayed null on every settled
  // bet, leaving the CLV gate (the actual scoreboard) un-measurable.
  if (rec.close) {
    const csharp = rec.close.sharp || sharpOf(rec.close.books);
    const cbook = rec.close.books?.[csharp];
    if (cbook) for (const c of candidates(cbook)) {
      const e = entries[key(id, c.market, c.line, c.selection)];
      if (e && e.timestamp_close !== rec.close.t) {
        if (e.closing_odds == null) closed++;
        e.closing_odds = c.odds; e.timestamp_close = rec.close.t;
        e.clv = clv({ placementOdds: e.placement_odds, closingOdds: c.odds, placementProb: e.market_prob_shin, closingProb: c.marketProb }).clvOdds;
      }
    }
  }

  // 3) settle finished matches
  if (isFT) for (const [k, e] of Object.entries(entries)) {
    if (e.match_id === id && e.result == null) {
      const s = settle(e.market, e.line, e.selection, r.h, r.a, e.placement_odds);
      e.result = s.result; e.pnl = +s.pnl.toFixed(4); settled++;
    }
  }
}

log.updated = new Date().toISOString();
log.meta = { ev_threshold: EV_THRESHOLD, total: Object.keys(entries).length };
writeFileSync(OUT, JSON.stringify(log, null, 0) + "\n");

const open = Object.values(entries).filter(e => e.result == null).length;
console.log(`shadow-log: scanned ${scanned} upcoming · +${created} new signals · ${closed} closing-lines · ${settled} settled`);
console.log(`            ${Object.keys(entries).length} entries total (${open} open) · EV≥${EV_THRESHOLD} · calibration=${calActive ? "ACTIVE (1X2)" : "raw (gate closed)"} · → data/bet_log.json`);
