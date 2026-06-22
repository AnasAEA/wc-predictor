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
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { gameSignal, eloRatings, attackDefenceRatings, matchProbabilities } from "../model/core.mjs";
import { scoreDistribution, overUnder } from "../model/markets.mjs";
import { load2026, load2022 } from "./backtest.mjs";
import { fitBest, reliability, METHODS, applyCalibrator } from "../model/calibrate.mjs";

const TOTALS_LINES = [1.5, 2.5, 3.5];
const MIN_FOR_DEPLOY = 200;   // binary 1X2 samples (~67 matches) before we'd trust a deployed calibrator
const SHIFT_LIMIT = 0.15;     // reject a refit that moves any probability by more than this vs the live one
const CAL_PATH = new URL("../data/calibration.json", import.meta.url);

// max |Δp| between two calibrators over a probe grid — the circuit-breaker against an anomalous batch
function maxProbShift(a, b) {
  let m = 0; for (let p = 0.02; p < 0.99; p += 0.02) m = Math.max(m, Math.abs(applyCalibrator(a, p) - applyCalibrator(b, p)));
  return m;
}

// leave-prior loop → binary samples per market
function collect({ plays, seed }) {
  const oneX = []; const totals = Object.fromEntries(TOTALS_LINES.map(l => [l, []]));
  let predGoals = 0, actGoals = 0; // Phase 2.5: mean-shift watch (calibration CAN'T fix a biased mean)
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
    predGoals += wp.lambdas.h + wp.lambdas.a; actGoals += t;
  }
  return { oneX, totals, goalBias: plays.length ? { pred: predGoals / plays.length, act: actGoals / plays.length } : null };
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
  if (s.goalBias) { const d = s.goalBias.pred - s.goalBias.act;
    console.log(`  Phase 2.5 goal mean: model ${s.goalBias.pred.toFixed(2)} vs actual ${s.goalBias.act.toFixed(2)}  (Δ ${d >= 0 ? "+" : ""}${d.toFixed(2)})${Math.abs(d) > 0.2 ? "  ⚠ mean-shift — calibration can't fix this; consider Negative-Binomial" : ""}`); }
  return { best1x2, n1x2: s.oneX.length, goalBias: s.goalBias };
}

console.log("WC·26 calibration harness (sketch) — methods:", Object.keys(METHODS).join(", "));
run("WC2022 (FLAT seeds — MECHANICS ONLY, do not deploy)", load2022());
const live = run("WC2026 (real seeds — the legitimate training set)", load2026());

// ---- safe auto-refit: ALWAYS fit (draft); CONDITIONALLY deploy -----------------------------------
const draft = { "1x2": { method: live.best1x2.method, params: live.best1x2.params, n: live.best1x2.n } };
const prev = existsSync(CAL_PATH) ? JSON.parse(readFileSync(CAL_PATH, "utf8")) : null;
const prevActive = prev?.status === "active" ? prev.markets?.["1x2"] : null;

let status, deployed, sanity;
if (live.n1x2 < MIN_FOR_DEPLOY) {
  status = "sketch"; deployed = draft; sanity = { decision: "hold", reason: `n=${live.n1x2} < ${MIN_FOR_DEPLOY}` };
} else if (!prevActive) {
  status = "active"; deployed = draft; sanity = { decision: "first-activation" };   // nothing to protect yet
} else {
  const shift = maxProbShift(prevActive, draft["1x2"]);   // circuit-breaker
  if (shift <= SHIFT_LIMIT) { status = "active"; deployed = draft; sanity = { decision: "accepted", maxShift: +shift.toFixed(4), limit: SHIFT_LIMIT }; }
  else { status = "active"; deployed = prev.markets; sanity = { decision: "rejected", maxShift: +shift.toFixed(4), limit: SHIFT_LIMIT, note: "anomalous batch — kept previous active params" }; }
}

const out = {
  updated: new Date().toISOString(), status,
  note: status === "active" ? "fit on real-seed leave-prior 2026 data" : `insufficient data (n=${live.n1x2} < ${MIN_FOR_DEPLOY}) — NOT for live use yet`,
  markets: deployed, draft, sanity,
  goalBias: live.goalBias ? { pred: +live.goalBias.pred.toFixed(3), act: +live.goalBias.act.toFixed(3) } : null,
};
writeFileSync(CAL_PATH, JSON.stringify(out, null, 0) + "\n");
console.log(`\nwrote data/calibration.json  ·  status=${status}  ·  deployed 1X2=${deployed["1x2"].method}  ·  sanity=${sanity.decision}`);
if (sanity.decision === "rejected") console.log(`  ⚠ refit rejected: max shift ${sanity.maxShift} > ${SHIFT_LIMIT} — kept previous active params.`);
