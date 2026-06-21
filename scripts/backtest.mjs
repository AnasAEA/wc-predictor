/**
 * Leave-prior-only backtest of the win-probability model (replicates app.js eloSeq + winProb's core).
 * For each finished match it rebuilds ratings from ONLY the earlier results, predicts, then scores vs reality.
 * Compares the single-pass online Elo with the iterated strength-of-schedule (SoS) rating now in app.js, and
 * ends with a synthetic connected-group test that exercises the SoS propagation the real (disconnected,
 * one-game-per-team) group-stage data cannot yet reach.  Run: node scripts/backtest.mjs
 */
import { readFileSync } from "node:fs";
const teams = JSON.parse(readFileSync("data/teams.json", "utf8"));
const fixtures = JSON.parse(readFileSync("data/matches.json", "utf8")).matches;
const results = JSON.parse(readFileSync("data/results.json", "utf8")).matches;
const efi = JSON.parse(readFileSync("data/efi.json", "utf8")).matches;
const HOST_OF = { USA: "US", Mexico: "MX", Canada: "CA" };
const hostCode = m => HOST_OF[(m.city || "").split(", ").pop()] || null;
const seed = c => teams[c]?.elo || 1700;
const hc_ = m => m.home?.team, ac_ = m => m.away?.team;
const K = 22, DRIFT = 70;
const clampTo = (c, v) => seed(c) + Math.max(-DRIFT, Math.min(DRIFT, v - seed(c)));
const expct = (rH, rA, host, hc, ac) => 1 / (1 + Math.pow(10, -((rH + (host === hc ? 40 : 0)) - (rA + (host === ac ? 40 : 0))) / 400));

const done = fixtures.filter(m => { const r = results[m.id]; return r && r.st === "FT" && r.h != null && hc_(m) && ac_(m); }).sort((a, b) => a.utc.localeCompare(b.utc));

// turn a list of fixtures into the order-independent per-game signal eloSeq consumes
const prep = list => list.map(m => {
  const hc = hc_(m), ac = ac_(m), r = results[m.id];
  let seffH = r.h > r.a ? 1 : r.h < r.a ? 0 : 0.5; const ef = efi[m.num];
  if (ef?.xg) { const xH = ef.home === hc ? ef.xg[0] : ef.xg[1], xA = ef.home === hc ? ef.xg[1] : ef.xg[0]; seffH = 0.7 * Math.max(0, Math.min(1, 0.5 + (xH - xA) / 4)) + 0.3 * seffH; }
  const mg = Math.abs(r.h - r.a), g = mg <= 1 ? 1 : mg === 2 ? 1.5 : mg === 3 ? 1.75 : 1.75 + (mg - 3) / 8;
  return { hc, ac, host: hostCode(m), seffH, g };
});

// single-pass online Elo (the prior model)
function eloOnline(games) {
  const E = {}, get = c => E[c] ?? seed(c);
  for (const x of games) { const d = K * x.g * (x.seffH - expct(get(x.hc), get(x.ac), x.host, x.hc, x.ac)); E[x.hc] = clampTo(x.hc, get(x.hc) + d); E[x.ac] = clampTo(x.ac, get(x.ac) - d); }
  return c => E[c] ?? seed(c);
}
// iterated strength-of-schedule rating (the new model) — online walk + SoS refinement for multi-game teams
function eloIter(games) {
  const ng = {}; for (const x of games) { ng[x.hc] = (ng[x.hc] || 0) + 1; ng[x.ac] = (ng[x.ac] || 0) + 1; }
  const E0 = {}, g0 = c => E0[c] ?? seed(c);
  for (const x of games) { const d = K * x.g * (x.seffH - expct(g0(x.hc), g0(x.ac), x.host, x.hc, x.ac)); E0[x.hc] = clampTo(x.hc, g0(x.hc) + d); E0[x.ac] = clampTo(x.ac, g0(x.ac) - d); }
  let R = {}; for (const c in ng) R[c] = E0[c] ?? seed(c);
  for (let pass = 0; pass < 4; pass++) {
    const acc = {};
    for (const x of games) { const d = K * x.g * (x.seffH - expct(R[x.hc], R[x.ac], x.host, x.hc, x.ac)); acc[x.hc] = (acc[x.hc] || 0) + d; acc[x.ac] = (acc[x.ac] || 0) - d; }
    const F = {}; for (const c in ng) F[c] = ng[c] < 2 ? (E0[c] ?? seed(c)) : clampTo(c, seed(c) + (acc[c] || 0));
    R = F;
  }
  return c => R[c] ?? seed(c);
}

const F = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880];
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / F[k]; const RHO = -0.11;   // Dixon-Coles (negative = football draw-inflation)
const tau = (x, y, lh, la) => x === 0 && y === 0 ? 1 - lh * la * RHO : x === 0 && y === 1 ? 1 + lh * RHO : x === 1 && y === 0 ? 1 + la * RHO : x === 1 && y === 1 ? 1 - RHO : 1;
function predict(m, rating, playedH, playedA, shrinkOn) {
  const hc = hc_(m), ac = ac_(m), mu = 1.35; const sup = Math.max(-2.5, Math.min(2.5, (rating(hc) - rating(ac)) / 300));
  let lh = mu + sup / 2, la = mu - sup / 2; const host = hostCode(m); if (host === hc) { lh *= Math.exp(0.13); la *= Math.exp(-0.06); } else if (host === ac) { la *= Math.exp(0.13); lh *= Math.exp(-0.06); }
  lh = Math.max(0.18, lh); la = Math.max(0.18, la); let pH = 0, pD = 0, pA = 0, best = { h: 0, a: 0, p: 0 };
  for (let rh = 0; rh < 9; rh++) for (let ra = 0; ra < 9; ra++) { const p = pois(rh, lh) * pois(ra, la) * tau(rh, ra, lh, la); if (rh > ra) pH += p; else if (rh < ra) pA += p; else pD += p; if (p > best.p) best = { h: rh, a: ra, p }; }
  const t = pH + pD + pA; let prH = pH / t, prD = pD / t, prA = pA / t;
  if (shrinkOn) { const s = 0.18 * Math.max(0, 1 - (playedH + playedA) / 6); if (s > 0) { prH = (1 - s) * prH + s * 0.35; prD = (1 - s) * prD + s * 0.30; prA = (1 - s) * prA + s * 0.35; } }
  return { pH: prH, pD: prD, pA: prA, score: best };
}
function run(eloFn, shrinkOn) {
  let brier = 0, ll = 0, corr = 0, exact = 0, n = 0, sp = 0;
  for (let i = 0; i < done.length; i++) {
    const m = done[i], prior = prep(done.slice(0, i)), rating = eloFn(prior);
    const pH_ = done.slice(0, i).filter(x => hc_(x) === hc_(m) || ac_(x) === hc_(m)).length, pA_ = done.slice(0, i).filter(x => hc_(x) === ac_(m) || ac_(x) === ac_(m)).length;
    const pr = predict(m, rating, pH_, pA_, shrinkOn), r = results[m.id], act = r.h > r.a ? "H" : r.h < r.a ? "A" : "D", pAct = act === "H" ? pr.pH : act === "A" ? pr.pA : pr.pD; sp += pAct;
    brier += (pr.pH - (act === "H")) ** 2 + (pr.pD - (act === "D")) ** 2 + (pr.pA - (act === "A")) ** 2; ll += -Math.log(Math.max(1e-9, pAct));
    const pred = pr.pH >= pr.pD && pr.pH >= pr.pA ? "H" : pr.pA >= pr.pD ? "A" : "D"; if (pred === act) corr++; if (pr.score.h === r.h && pr.score.a === r.a) exact++; n++;
  }
  return { acc: Math.round(corr / n * 100), exact, meanP: Math.round(sp / n * 100), brier: (brier / n).toFixed(3), ll: (ll / n).toFixed(3), n };
}

const on = run(eloOnline, true), it = run(eloIter, true);
console.log(`\nLeave-prior backtest over ${on.n} finished matches  (production setting: draw-aware shrink ON)`);
console.log("                                 single-pass online   iterated (SoS)");
console.log(`Outcome accuracy (W/D/A):             ${on.acc}%                ${it.acc}%`);
console.log(`Mean prob on actual outcome:          ${on.meanP}%                ${it.meanP}%   (33% = random)`);
console.log(`Brier (lower better, .667 = random):   ${on.brier}              ${it.brier}`);
console.log(`Log-loss (lower better, 1.099 = rand): ${on.ll}              ${it.ll}`);
console.log(`Exact scoreline hits:                 ${on.exact}/${on.n}                ${it.exact}/${it.n}`);
console.log(on.brier === it.brier && on.acc === it.acc
  ? "\n→ IDENTICAL, as expected: every finished game is a team's FIRST, so the match graph is disjoint single\n  edges — there is no shared-opponent path for any strength-of-schedule method to use yet. It activates from\n  matchday 2 (and connects fully in the knockouts). Synthetic proof it then works + converges:"
  : "\n→ NOTE: the two diverged on real data (unexpected at matchday 1) — investigate.");

// ---- synthetic connected group: A,B,C,D each play twice, so common-opponent structure exists ----
function synthElo(games, fn) { return fn(games); }
const G = (hc, ac, hg, ag) => ({ hc, ac, host: null, seffH: hg > ag ? 1 : hg < ag ? 0 : 0.5, g: Math.abs(hg - ag) <= 1 ? 1 : Math.abs(hg - ag) === 2 ? 1.5 : 1.75 });
// seed all four equal so any rating difference is EARNED from results, not the prior
for (const c of ["AAA", "BBB", "CCC", "DDD"]) teams[c] = { elo: 1700, name: c };
const base = [G("AAA", "CCC", 1, 0), G("BBB", "DDD", 1, 0), G("CCC", "DDD", 2, 0)];   // C also beat D, so C has 2 games
const withAB = [...base, G("AAA", "BBB", 5, 0)];                                        // now A thrashes B (B's stock falls)
const cBefore = { on: eloOnline(base)("CCC"), it: eloIter(base)("CCC") };
const cAfter = { on: eloOnline(withAB)("CCC"), it: eloIter(withAB)("CCC") };
console.log(`\nDoes A 5-0 B move C's rating?  C lost to A, so A is C's shared opponent with the new A-B game.`);
console.log(`  single-pass online:  C = ${cBefore.on.toFixed(1)}  →  ${cAfter.on.toFixed(1)}   (Δ ${(cAfter.on - cBefore.on).toFixed(1)} — the A-B result never reaches C)`);
console.log(`  iterated (SoS):      C = ${cBefore.it.toFixed(1)}  →  ${cAfter.it.toFixed(1)}   (Δ +${(cAfter.it - cBefore.it).toFixed(1)} — A thrashing B reveals A is strong, so C's loss to A looks better → C rises)`);
// convergence: show the SoS fixed-point settling pass by pass on the connected set
const ng = {}; for (const x of withAB) { ng[x.hc] = (ng[x.hc] || 0) + 1; ng[x.ac] = (ng[x.ac] || 0) + 1; }
const E0 = {}, g0 = c => E0[c] ?? seed(c);
for (const x of withAB) { const d = K * x.g * (x.seffH - expct(g0(x.hc), g0(x.ac), x.host, x.hc, x.ac)); E0[x.hc] = clampTo(x.hc, g0(x.hc) + d); E0[x.ac] = clampTo(x.ac, g0(x.ac) - d); }
let R = {}; for (const c in ng) R[c] = E0[c] ?? seed(c);
const trace = [];
for (let pass = 0; pass < 6; pass++) {
  const acc = {}; for (const x of withAB) { const d = K * x.g * (x.seffH - expct(R[x.hc], R[x.ac], x.host, x.hc, x.ac)); acc[x.hc] = (acc[x.hc] || 0) + d; acc[x.ac] = (acc[x.ac] || 0) - d; }
  const Fr = {}; for (const c in ng) Fr[c] = ng[c] < 2 ? (E0[c] ?? seed(c)) : clampTo(c, seed(c) + (acc[c] || 0)); R = Fr;
  trace.push(R["CCC"]);
}
console.log(`  convergence of C over passes: ${trace.map(v => v.toFixed(2)).join(" → ")}  (settles, bounded by ±${DRIFT})`);
