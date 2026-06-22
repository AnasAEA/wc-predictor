/**
 * scripts/fetch-odds.mjs — pull WC2026 odds from The Odds API into data/odds.json.
 *
 * Runs in a GitHub Action (keyless EXCEPT this one free key, held in the ODDS_API_KEY secret). The browser
 * never sees it. This starts — and keeps feeding — the forward-only validation set that the $0 constraint
 * forces on us, so the sooner it runs, the sooner we can calibrate + measure CLV.
 *
 * QUOTA DISCIPLINE (free tier ≈ 500/mo; cost = markets × regions per call, NOT per event):
 *   - one bulk /odds call returns every WC event at once;
 *   - we read x-requests-remaining / x-requests-used and HARD-STOP below QUOTA_FLOOR so we never blow the
 *     month mid-tournament;
 *   - kickoff-aware: full market set only matters near KO; we always fetch but you can thin REGIONS/MARKETS.
 *
 * PER-MATCH CAPTURE (for CLV, bounded — no unbounded history):
 *   open   = first odds we ever saw for the match
 *   latest = most recent snapshot
 *   close  = snapshot taken inside CLOSE_WINDOW_MIN of kickoff (the sharp closing line; set once)
 *
 *   ODDS_API_KEY=xxx node scripts/fetch-odds.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SPORT = "soccer_fifa_world_cup";
const REGIONS = (process.env.ODDS_REGIONS || "eu,us").split(",");      // eu carries Pinnacle + Betfair (the sharps)
const MARKETS = (process.env.ODDS_MARKETS || "h2h,spreads,totals").split(","); // spreads/totals = our edge markets
const SHARP_BOOKS = ["pinnacle", "betfair_ex_eu", "betfair_ex_uk", "betfair"]; // preference order for the CLV reference
const QUOTA_FLOOR = Number(process.env.ODDS_QUOTA_FLOOR || 40);        // stop if fewer than this remain
const CLOSE_WINDOW_MIN = 15;
const OUT = new URL("../data/odds.json", import.meta.url);

const J = p => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const teamsRaw = J("../data/teams.json"); const teams = teamsRaw.teams || teamsRaw;
const fixtures = J("../data/matches.json").matches;

// name → our code (The Odds API uses full English names); a few aliases for the usual mismatches
const deb = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const ALIAS = { "usa": "US", "united states": "US", "south korea": "KR", "korea republic": "KR",
  "iran": "IR", "ir iran": "IR", "ivory coast": "CI", "cote d'ivoire": "CI", "cape verde": "CV",
  "turkey": "TR", "turkiye": "TR", "czech republic": "CZ", "czechia": "CZ", "dr congo": "CD" };
const NAME2CODE = { ...Object.fromEntries(Object.entries(teams).map(([c, t]) => [deb(t.name), c])), ...ALIAS };
const codeOf = name => { const d = deb(name); return NAME2CODE[d] || Object.entries(NAME2CODE).find(([n]) => n && (n.includes(d) || d.includes(n)))?.[1] || null; };

// find our fixture id from the two team codes + a commence time (nearest scheduled meeting)
function matchId(hc, ac, commenceISO) {
  const t = +new Date(commenceISO);
  const cands = fixtures.filter(f => { const a = f.home?.team, b = f.away?.team; return a && b && ((a === hc && b === ac) || (a === ac && b === hc)); });
  if (!cands.length) return null;
  return cands.sort((x, y) => Math.abs(+new Date(x.utc) - t) - Math.abs(+new Date(y.utc) - t))[0].id;
}

// reshape one bookmaker's markets into { h2h:[h,d,a], totals:{line:{over,under}}, spreads:{line:{home,away}} }
function shapeBook(bk, hc, ac, evHome, evAway) {
  const out = {}; const homeIsEvHome = codeOf(evHome) === hc;
  for (const m of bk.markets || []) {
    if (m.key === "h2h") {
      const get = nm => m.outcomes.find(o => o.name === nm)?.price;
      const draw = m.outcomes.find(o => o.name === "Draw")?.price;
      out.h2h = [get(evHome), draw, get(evAway)].map(x => x ?? null);
      if (!homeIsEvHome) out.h2h = [out.h2h[2], out.h2h[1], out.h2h[0]]; // orient to OUR home/away
    } else if (m.key === "totals") {
      out.totals ??= {};
      for (const o of m.outcomes) { const L = o.point; out.totals[L] ??= {}; out.totals[L][o.name === "Over" ? "over" : "under"] = o.price; }
    } else if (m.key === "spreads") {
      out.spreads ??= {};
      for (const o of m.outcomes) {
        const isHome = codeOf(o.name) === hc; const line = isHome ? o.point : -o.point; // store from OUR home perspective
        out.spreads[line] ??= {}; out.spreads[line][isHome ? "home" : "away"] = o.price;
      }
    }
  }
  return out;
}

async function main() {
  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    console.log("ODDS_API_KEY not set — nothing to fetch.\n" +
      "  1. Get a free key at https://the-odds-api.com (500 req/mo).\n" +
      "  2. Add it as the ODDS_API_KEY repo secret (Settings → Secrets → Actions).\n" +
      "  3. Re-run the Odds workflow. (Exiting 0 so CI stays green until the key exists.)");
    return;
  }
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { matches: {} };
  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds?` +
    new URLSearchParams({ apiKey: KEY, regions: REGIONS.join(","), markets: MARKETS.join(","), oddsFormat: "decimal", dateFormat: "iso" });
  const res = await fetch(url);
  const remaining = Number(res.headers.get("x-requests-remaining"));
  const used = Number(res.headers.get("x-requests-used"));
  console.log(`quota: ${remaining} remaining / ${used} used`);
  if (!res.ok) { console.error(`Odds API ${res.status}: ${await res.text()}`); process.exit(1); }
  if (Number.isFinite(remaining) && remaining < QUOTA_FLOOR) {
    console.warn(`⚠ quota ${remaining} < floor ${QUOTA_FLOOR} — keeping previous odds.json, not consuming more.`);
    return;
  }
  const events = await res.json();
  const now = Date.now(), out = { updated: new Date().toISOString(), quota: { remaining, used }, matches: { ...prev.matches } };
  let mapped = 0; const unmapped = [];
  for (const ev of events) {
    const hc = codeOf(ev.home_team), ac = codeOf(ev.away_team);
    if (!hc || !ac) { unmapped.push(`${ev.home_team} v ${ev.away_team}`); continue; }
    const id = matchId(hc, ac, ev.commence_time); if (!id) { unmapped.push(`${hc} v ${ac} (no fixture)`); continue; }
    const books = {};
    for (const bk of ev.bookmakers || []) books[bk.key] = shapeBook(bk, hc, ac, ev.home_team, ev.away_team);
    const sharp = SHARP_BOOKS.find(b => books[b]) || null;
    const snap = { t: out.updated, sharp, books };
    const rec = out.matches[id] || { commence: ev.commence_time, home: hc, away: ac };
    rec.commence = ev.commence_time;
    rec.open ??= snap;
    rec.latest = snap;
    if (!rec.close && +new Date(ev.commence_time) - now <= CLOSE_WINDOW_MIN * 60000) rec.close = snap; // capture the close once
    out.matches[id] = rec; mapped++;
  }
  writeFileSync(OUT, JSON.stringify(out, null, 0) + "\n");
  console.log(`wrote ${mapped} matches to data/odds.json` + (unmapped.length ? `  · unmapped: ${unmapped.join(", ")}` : ""));
}

main().catch(e => { console.error(e); process.exit(1); });
