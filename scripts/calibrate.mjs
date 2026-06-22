/**
 * scripts/calibrate.mjs — Phase 2 calibration harness (sketch).
 *
 * Collects leave-prior model predictions as binary {p, y} samples PER MARKET (1X2, Totals), fits
 * identity/temperature/platt/beta (model/calibrate.mjs), and reports reliability + which form wins.
 * Writes the fitted 1X2 calibrator (from the real-seed 2026 data) to data/calibration.json.
 *
 *   node scripts/calibrate.mjs
 *
 * HONESTY: calibration needs the model's REAL raw-probability distribution. The 2026 run (real Elo seeds)
 * is the legitimate training set — but it's tiny (≈38 matches) and grows daily. The 2022 run uses FLAT
 * seeds, so its raw probabilities are differently distributed; it validates the harness MECHANICS only and
 * its params must NOT be deployed on the real-seed model. calibration.json is marked `status` accordingly.
 */
import { writeFileSync } from "node:fs";
import { gameSignal, eloRatings, attackDefenceRatings, matchProbabilities } from "../model/core.mjs";
import { scoreDistribution, overUnder } from "../model/markets.mjs";
import { load2026, load2022 } from "./backtest.mjs";
import { fitBest, reliability, METHODS } from "../model/calibrate.mjs";

const TOTALS_LINES = [1.5, 2.5, 3.5];
const MIN_FOR_DEPLOY = 200; // binary 1X2 samples (~67 matches) before we'd trust a deployed calibrator

// leave-prior loop → binary samples per market
function collect({ plays, seed }) {
  const oneX = []; const totals = Object.fromEntries(TOTALS_LINES.map(l => [l, []]));
  for (let i = 0; i < plays.length; i++) {
    const prior = plays.slice(0, i).map(gameSignal);
    const ratings = eloRatings(prior, seed), ad = attackDefenceRatings(prior, seed);
    const m = plays[i], rate = c => ratings[c] ?? seed(c);
    const side = m.host === m.hc ? "H" : m.host === m.ac ? "A" : null;
    const playedH = plays.slice(0, i).filter(x => x.hc === m.hc || x.ac === m.hc).length;
    const playedA = plays.slice(0, i).filter(x => x.hc === m.ac || x.ac === m.ac).length;
    const wp = matchProbabilities({ eloH: rate(m.hc), eloA: rate(m.ac), seedH: seed(m.hc), seedA: seed(m.ac), ko: m.ko,
      ad: { adH: ad[m.hc], adA: ad[m.ac] }, ftCount: i, playedH, playedA, host: side, names: { h: m.hc, a: m.ac } });
    const act = m.gh > m.ga ? "H" : m.gh < m.ga ? "A" : "D";
    oneX.push({ p: wp.h, y: act === "H" ? 1 : 0 }, { p: wp.d, y: act === "D" ? 1 : 0 }, { p: wp.a, y: act === "A" ? 1 : 0 });
    const cells = scoreDistribution(wp.lambdas.h, wp.lambdas.a), t = m.gh + m.ga;
    for (const L of TOTALS_LINES) totals[L].push({ p: overUnder(cells, L).over, y: t > L ? 1 : 0 });
  }
  return { oneX, totals };
}

const pct = x => (x * 100).toFixed(1) + "%";
function reportMarket(name, samples) {
  if (samples.length < 6) { console.log(`  ${name}: only ${samples.length} samples — skipping`); return null; }
  const { best, all } = fitBest(samples);
  console.log(`  ${name}  (n=${samples.length})`);
  for (const f of all) console.log(`     ${f.method.padEnd(12)} logloss ${f.before.logLoss.toFixed(3)}→${f.after.logLoss.toFixed(3)}  ECE ${pct(f.before.ece)}→${pct(f.after.ece)}${f.method === best.method ? "   ← best" : ""}`);
  const rel = reliability(samples);
  console.log(`     raw reliability pred→obs: ` + rel.rows.filter(r => r.n).map(r => `${Math.round(r.pred * 100)}→${Math.round(r.obs * 100)}(${r.n})`).join("  "));
  return best;
}

function run(label, ds) {
  console.log(`\n────────── ${label} ──────────`);
  const s = collect(ds);
  const best1x2 = reportMarket("1X2", s.oneX);
  for (const L of TOTALS_LINES) reportMarket(`Totals ${L}`, s.totals[L]);
  return { best1x2, n1x2: s.oneX.length };
}

console.log("WC·26 calibration harness (sketch) — methods:", Object.keys(METHODS).join(", "));
run("WC2022 (FLAT seeds — MECHANICS ONLY, do not deploy)", load2022());
const live = run("WC2026 (real seeds — the legitimate training set)", load2026());

const status = live.n1x2 >= MIN_FOR_DEPLOY ? "active" : "sketch";
const out = {
  updated: new Date().toISOString(), status,
  note: status === "active" ? "fit on real-seed leave-prior 2026 data" : `insufficient data (n=${live.n1x2} < ${MIN_FOR_DEPLOY}) — NOT for live use yet`,
  markets: { "1x2": { method: live.best1x2.method, params: live.best1x2.params, n: live.best1x2.n } },
};
writeFileSync(new URL("../data/calibration.json", import.meta.url), JSON.stringify(out, null, 0) + "\n");
console.log(`\nwrote data/calibration.json  ·  status=${status}  ·  1X2=${live.best1x2.method}  (apply only when status=active)`);
