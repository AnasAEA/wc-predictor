/**
 * scripts/report.mjs — distil the whole betting layer into one browser-readable file: data/model_report.json.
 * The web app's "Model" cockpit reads this single file (plus bet_log/calibration/odds for live bits).
 * Runs in the odds cron after shadow-log. Pure of any key.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { load2026, backtest, calibration } from "./backtest.mjs";
import { fitBest, reliability, METHODS } from "../model/calibrate.mjs";
import { dispersionIndex, fitDispersion } from "../model/goal_dist.mjs";
import { simulateBankroll, DEFAULT_CONFIG } from "../betting/value_engine.mjs";

const url = p => new URL(`../${p}`, import.meta.url);
const readJ = p => existsSync(url(p)) ? JSON.parse(readFileSync(url(p), "utf8")) : null;
const r2 = x => x == null ? null : +x.toFixed(2);
const r3 = x => x == null ? null : +x.toFixed(3);
const r4 = x => x == null ? null : +x.toFixed(4);

// ---- model performance (leave-prior 2026) + calibration -----------------------------------------
const bt = backtest(load2026());
const samples = bt.points.map(p => ({ p: p.p, y: p.hit ? 1 : 0 }));
const { best } = fitBest(samples);
const relRaw = reliability(samples).rows.filter(r => r.n).map(r => ({ pred: r3(r.pred), obs: r3(r.obs), n: r.n }));
const eceCal = reliability(samples, METHODS[best.method].apply, best.params).ece;

// ---- goal distribution diagnostic ----------------------------------------------------------------
const obs = bt.goalSamples.map(s => s.k), di = dispersionIndex(obs);
const meanLam = bt.goalSamples.reduce((s, x) => s + x.mean, 0) / bt.goalSamples.length;
const fitA = fitDispersion(bt.goalSamples);

// ---- live state ----------------------------------------------------------------------------------
const cal = readJ("data/calibration.json"), odds = readJ("data/odds.json"), betlog = readJ("data/bet_log.json");
const entries = betlog ? Object.values(betlog.entries) : [];
const open = entries.filter(e => e.result == null);
const settled = entries.filter(e => e.result != null).sort((a, b) => (a.commence || "").localeCompare(b.commence || ""));
const byMarket = {}; for (const e of entries) byMarket[e.market] = (byMarket[e.market] || 0) + 1;
const teamName = c => (readJ("data/teams.json").teams || readJ("data/teams.json"))[c]?.name || c;

const openTop = open.sort((a, b) => b.ev - a.ev).slice(0, 40).map(e => ({
  match: `${teamName(e.home)} v ${teamName(e.away)}`, home: e.home, away: e.away, commence: e.commence,
  market: e.market, line: e.line, selection: e.selection, odds: e.placement_odds,
  ev: r4(e.ev), modelProb: r4(e.model_prob_used ?? e.model_prob_raw), marketProb: r4(e.market_prob_shin),
  calibrated: !!e.calibrated, stakeFlat: e.stake_flat, kelly: r4(e.kelly_full),
}));

// settled grading + bankroll sim
const tally = { win: 0, "half-win": 0, push: 0, "half-loss": 0, loss: 0 };
for (const e of settled) tally[e.result] = (tally[e.result] || 0) + 1;
const pnlUnits = settled.reduce((s, e) => s + (e.pnl || 0), 0);
const clvs = entries.filter(e => e.clv != null).map(e => e.clv);
const clvAvg = clvs.length ? clvs.reduce((s, x) => s + x, 0) / clvs.length : null;
const bank = simulateBankroll(settled.map(e => ({ pnl: e.pnl || 0, kelly: e.kelly_full || 0 })), DEFAULT_CONFIG);

const out = {
  updated: new Date().toISOString(),
  paper: true, config: { bankroll: DEFAULT_CONFIG.bankroll, flatPct: DEFAULT_CONFIG.flatPct, kellyFraction: DEFAULT_CONFIG.kellyFraction, minEV: DEFAULT_CONFIG.minEV },
  status: cal?.status || "sketch", calMethod: best.method, calN: cal?.markets?.["1x2"]?.n ?? samples.length / 3 | 0, calTarget: 200,
  oddsUpdated: odds?.updated || null, quota: odds?.quota || null,
  performance: {
    n: bt.n, acc: r3(bt.acc), meanP: r3(bt.meanP), brier: r3(bt.brier), ll: r3(bt.ll), exact: bt.exact,
    eceRaw: r4(reliability(samples).ece), eceCal: r4(eceCal), reliability: relRaw,
  },
  goals: { dispersion: r3(di.ratio), meanActual: r3(di.mean), meanModel: r3(meanLam), shiftPerSide: r3(meanLam - di.mean), alpha: r3(fitA.alpha), nbImproved: fitA.improved },
  signals: {
    total: entries.length, open: open.length, settledCount: settled.length, withClose: entries.filter(e => e.closing_odds != null).length,
    byMarket, openTop,
    settledSummary: { tally, pnlUnits: r3(pnlUnits), clvAvg: r4(clvAvg), nClv: clvs.length,
      bankroll: { start: DEFAULT_CONFIG.bankroll, end: bank.flat.end, roi: bank.flat.roi, curve: bank.flat.curve.map(r2) } },
  },
};
writeFileSync(url("data/model_report.json"), JSON.stringify(out, null, 0) + "\n");
console.log(`report: perf acc ${out.performance.acc} brier ${out.performance.brier} · ${out.signals.open} open / ${out.signals.settledCount} settled · status ${out.status} → data/model_report.json`);
