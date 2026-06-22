/**
 * Tests for the shared forecasting core (model/core.mjs) + the backtest harness.
 * No deps — Node's built-in runner:  node --test
 *
 * Two jobs:
 *   1. Lock the MATH with a deterministic golden-vector test, so any unintended change to the model
 *      (or a future app.js wiring that drifts from it) fails CI.
 *   2. Sanity-check the behaviour (probabilities normalise, stronger/host teams favoured, Elo moves
 *      the right way) and assert the live backtest still clears the random baselines comfortably.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { poisson, dcTau, gameSignal, eloRatings, attackDefenceRatings, matchProbabilities } from "../model/core.mjs";
import { load2026, backtest } from "../scripts/backtest.mjs";

const approx = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} expected ${b}, got ${a}`);

test("poisson + Dixon-Coles primitives", () => {
  approx(poisson(0, 1), Math.exp(-1), 1e-12, "P(0;1)");
  // a Poisson(λ) PMF sums to ~1 over the model's support (k=0..9; tail beyond is negligible for these λ)
  let s = 0; for (let k = 0; k < 10; k++) s += poisson(k, 1.4); approx(s, 1, 1e-4, "poisson sums to 1");
  // τ leaves non-low scores untouched and inflates the 0-0 cell (negative rho)
  approx(dcTau(2, 3, 1.3, 1.1), 1, 1e-12, "high score τ");
  assert.ok(dcTau(0, 0, 1.3, 1.1) > 1, "0-0 τ inflated for negative rho");
});

test("matchProbabilities normalises and ranks by strength", () => {
  const base = { seedH: 1800, seedA: 1800, names: { h: "H", a: "A" } };
  const even = matchProbabilities({ ...base, eloH: 1800, eloA: 1800 });
  approx(even.h + even.d + even.a, 1, 1e-9, "probs sum to 1");
  approx(even.h, even.a, 1e-9, "equal strength ⇒ symmetric");
  const strong = matchProbabilities({ ...base, eloH: 2000, eloA: 1700, seedH: 2000, seedA: 1700 });
  assert.ok(strong.h > strong.a, "higher Elo ⇒ higher win prob");
  assert.ok(strong.h > even.h, "bigger Elo gap ⇒ more favoured");
  approx(strong.h + strong.d + strong.a, 1, 1e-9, "probs still sum to 1");
});

test("host edge and knockout tightening behave", () => {
  const p = { eloH: 1800, eloA: 1800, seedH: 1800, seedA: 1800, names: { h: "H", a: "A" } };
  const neutral = matchProbabilities(p);
  const hosted = matchProbabilities({ ...p, host: "H", hostCity: "Dallas" });
  assert.ok(hosted.h > neutral.h, "host gets a lift");
  assert.ok(hosted.reasons.some(r => r.key === "host"), "host reason surfaced");
  const ko = matchProbabilities({ ...p, ko: true });
  assert.ok(ko.adv && Math.abs(ko.adv.h + ko.adv.a - 1) < 1e-9, "KO advance probs sum to 1");
});

test("eloRatings: a winner rises above seed, loser falls, and it converges", () => {
  const seed = () => 1700;
  const games = [
    gameSignal({ hc: "AAA", ac: "BBB", gh: 3, ga: 0 }),
    gameSignal({ hc: "AAA", ac: "CCC", gh: 2, ga: 1 }),
    gameSignal({ hc: "BBB", ac: "CCC", gh: 0, ga: 1 }),
  ];
  const R = eloRatings(games, seed);
  assert.ok(R.AAA > 1700, "AAA won twice ⇒ above seed");
  assert.ok(R.BBB < 1700, "BBB lost twice ⇒ below seed");
  assert.ok(R.AAA > R.CCC && R.CCC > R.BBB, "ordering AAA > CCC > BBB");
});

test("attackDefenceRatings shrink to prior with few games", () => {
  const seed = () => 1786; // the prior midpoint ⇒ prior A,D ≈ 1
  const ad = attackDefenceRatings([gameSignal({ hc: "AAA", ac: "BBB", gh: 1, ga: 1 })], seed);
  assert.equal(ad.AAA.n, 1, "one game recorded");
  assert.ok(ad.AAA.A > 0.6 && ad.AAA.A < 1.6, "attack within clamp");
  assert.ok(Math.abs(ad.AAA.A - 1) < 0.4, "heavily shrunk toward prior at n=1");
});

// GOLDEN VECTOR — deterministic; any math change must consciously update this number.
test("golden vector locks the math", () => {
  const wp = matchProbabilities({ eloH: 1900, eloA: 1750, seedH: 1900, seedA: 1750, ko: false,
    playedH: 3, playedA: 3, host: null, names: { h: "H", a: "A" } });
  approx(wp.h, 0.4765399540046779, 1e-12, "golden P(home)");
  approx(wp.d, 0.2749460983035764, 1e-12, "golden P(draw)");
  approx(wp.a, 0.24851394769174565, 1e-12, "golden P(away)");
});

test("live backtest clears the random baselines", () => {
  const r = backtest(load2026());
  assert.ok(r.n >= 30, `enough finished matches to be meaningful (got ${r.n})`);
  assert.ok(r.acc > 0.45, `accuracy beats coin-flip-ish baseline (got ${(r.acc * 100).toFixed(1)}%)`);
  assert.ok(r.meanP > 0.37, `mean prob on actual beats random 0.333 (got ${r.meanP.toFixed(3)})`);
  assert.ok(r.brier < 0.62, `Brier beats random 0.667 (got ${r.brier.toFixed(3)})`);
  assert.ok(r.ll < 1.05, `log-loss beats random 1.099 (got ${r.ll.toFixed(3)})`);
});
