/**
 * Tests for model/goal_dist.mjs (Poisson / Negative-Binomial goal counts + dispersion fitting)
 * and that scoreGrid honours opts.goalDist.  node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { poissonPMF, negbinPMF, makeGoalDist, dispersionIndex, fitDispersion, lgamma } from "../model/goal_dist.mjs";
import { scoreGrid, poisson, MODEL } from "../model/core.mjs";

const approx = (a, b, e = 1e-9, m) => assert.ok(Math.abs(a - b) <= e, `${m || ""} expected ${b}, got ${a}`);

test("lgamma matches known factorials", () => {
  approx(Math.exp(lgamma(5)), 24, 1e-6, "Γ(5)=4!");
  approx(Math.exp(lgamma(1)), 1, 1e-9, "Γ(1)=1");
});

test("poissonPMF matches the core table-based poisson and sums to 1", () => {
  for (let k = 0; k < 9; k++) approx(poissonPMF(k, 1.4), poisson(k, 1.4), 1e-9, `pmf k=${k}`);
  let s = 0; for (let k = 0; k < 40; k++) s += poissonPMF(k, 2.3); approx(s, 1, 1e-6, "Poisson sums to 1");
});

test("NegBin → Poisson as α→0, has the right mean and variance, sums to 1", () => {
  for (let k = 0; k < 6; k++) approx(negbinPMF(k, 1.5, 1e-12), poissonPMF(k, 1.5), 1e-6, "α→0 ⇒ Poisson");
  const mu = 1.6, alpha = 0.2; let s = 0, m = 0, m2 = 0;
  for (let k = 0; k < 60; k++) { const p = negbinPMF(k, mu, alpha); s += p; m += k * p; m2 += k * k * p; }
  approx(s, 1, 1e-6, "NegBin sums to 1");
  approx(m, mu, 1e-4, "mean = μ");
  approx(m2 - m * m, mu + alpha * mu * mu, 1e-3, "var = μ + α·μ²");
});

test("dispersionIndex flags overdispersion", () => {
  const di = dispersionIndex([0, 0, 0, 1, 1, 5, 0, 4, 0, 2]); // a fat-tailed sample
  assert.ok(di.ratio > 1.2, "Var/Mean > 1 for overdispersed data");
});

test("fitDispersion recovers a planted α and beats Poisson", () => {
  // build samples from NegBin(mean=1.5, α=0.4) by its CDF — fit should land near 0.4
  const mu = 1.5, trueA = 0.4, samples = [];
  let acc = 0; const cdf = []; for (let k = 0; k < 40; k++) { acc += negbinPMF(k, mu, trueA); cdf.push(acc); }
  for (let i = 0; i < 4000; i++) { const u = (i + 0.5) / 4000; samples.push({ mean: mu, k: cdf.findIndex(c => c >= u) }); }
  const fit = fitDispersion(samples);
  assert.ok(Math.abs(fit.alpha - trueA) < 0.1, `recovered α≈${fit.alpha.toFixed(2)} (true 0.4)`);
  assert.ok(fit.improved, "NegBin log-likelihood beats Poisson on overdispersed data");
});

test("scoreGrid honours opts.goalDist (negbin spreads the tail)", () => {
  const base = { ...MODEL };
  const pois = scoreGrid(1.6, 1.2, {}, base);
  const nb = scoreGrid(1.6, 1.2, {}, { ...base, goalDist: { name: "negbin", alpha: 0.3 } });
  // both are valid distributions
  approx(pois.tot, pois.pH + pois.pD + pois.pA, 1e-9);
  // NegBin puts more mass on the 0-0 corner than Poisson (fatter low tail)
  const cell00 = g => g.cells.find(c => c.h === 0 && c.a === 0).p / g.tot;
  assert.ok(cell00(nb) > cell00(pois), "NegBin inflates 0-0 vs Poisson");
});
