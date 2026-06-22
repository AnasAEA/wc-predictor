/**
 * Tests for the Phase 1 pure libraries: de-vigging (betting/devig.mjs) and market mapping
 * (model/markets.mjs). Both are key-independent, so they're fully verifiable offline.
 *   node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { multiplicative, power, shin, betfairMid, devig } from "../betting/devig.mjs";
import { allMarkets, oneXtwo, overUnder, asianHandicap, btts, scoreDistribution } from "../model/markets.mjs";
import { matchProbabilities } from "../model/core.mjs";
import { settleUnits, pnl, modelEV, settle, componentsOf, clv } from "../betting/clv.mjs";

const sums1 = (a, msg) => assert.ok(Math.abs(a.reduce((s, x) => s + x, 0) - 1) < 1e-9, `${msg} sums to 1`);

// ---- de-vigging ----------------------------------------------------------------------------------
test("all de-vig methods return normalised probabilities", () => {
  const odds = [2.10, 3.40, 3.80]; // a typical 1X2 with ~5% margin
  for (const m of [multiplicative, power, shin]) {
    const r = m(odds); sums1(r.probs, m.name);
    assert.ok(r.overround > 0.02 && r.overround < 0.12, `${m.name} recovers a sane margin`);
    assert.ok(r.probs.every(p => p > 0 && p < 1), `${m.name} probs in (0,1)`);
  }
});

test("Shin corrects the favorite-longshot bias vs multiplicative", () => {
  // heavy favorite + big longshot ⇒ books pad the longshot most; Shin should shade the longshot DOWN
  const odds = [1.30, 5.50, 11.0];
  const mult = multiplicative(odds).probs, sh = shin(odds).probs;
  const longshot = odds.length - 1;
  assert.ok(sh[longshot] < mult[longshot], "Shin assigns the longshot less probability than multiplicative");
  assert.ok(sh[0] > mult[0], "Shin assigns the favorite more probability");
  assert.ok(shin(odds).z >= 0 && shin(odds).z < 1, "z in [0,1)");
});

test("power method solves Σ=1 and de-vig() dispatches", () => {
  const odds = [1.80, 3.60, 4.80];
  const p = power(odds); sums1(p.probs, "power"); assert.ok(p.k >= 1, "k ≥ 1");
  sums1(devig(odds, "shin"), "devig shin");
  sums1(devig(odds), "devig default");
  assert.throws(() => devig(odds, "nope"), /unknown method/);
});

test("betfair midpoint de-vig normalises back/lay", () => {
  const r = betfairMid([2.02, 3.55, 3.95], [2.06, 3.65, 4.10]);
  sums1(r.probs, "betfair"); assert.ok(r.overround < 0.03, "exchange margin is small");
});

test("devig input validation", () => {
  assert.throws(() => multiplicative([1.5]), /≥2/);
  assert.throws(() => shin([2.0, 0.9]), /> 1/);
});

// ---- market mapping ------------------------------------------------------------------------------
test("score distribution normalises and yields consistent 1X2", () => {
  const cells = scoreDistribution(1.6, 1.1);
  sums1(cells.map(c => c.p), "score grid");
  const x = oneXtwo(cells);
  sums1([x.h, x.d, x.a], "1X2");
  assert.ok(x.h > x.a, "higher home rate ⇒ home favoured");
});

test("over/under and AH partition probability mass", () => {
  const cells = scoreDistribution(1.5, 1.3);
  const ou = overUnder(cells, 2.5);
  sums1([ou.over, ou.under, ou.push], "O/U 2.5");
  assert.equal(ou.push, 0, "half-line totals never push");
  const ouWhole = overUnder(cells, 2);
  assert.ok(ouWhole.push > 0, "whole-line total can push (exactly 2 goals)");
  const ah = asianHandicap(cells, -0.5);
  sums1([ah.home, ah.away, ah.push], "AH -0.5");
  assert.equal(ah.push, 0, "half handicap never pushes");
  assert.ok(asianHandicap(cells, -1).push > 0, "whole handicap can push (exact 1-goal margin)");
  assert.throws(() => asianHandicap(cells, -0.75), /quarter line/);
});

test("AH 0.0 (draw no bet) equals 1X2 minus the draw, renormalised", () => {
  const cells = scoreDistribution(1.4, 1.2);
  const x = oneXtwo(cells), ah0 = asianHandicap(cells, 0);
  assert.ok(Math.abs(ah0.home - x.h) < 1e-9 && Math.abs(ah0.away - x.a) < 1e-9, "AH0 home/away = raw win probs");
  assert.ok(Math.abs(ah0.push - x.d) < 1e-9, "AH0 push = draw");
});

// ---- settlement / EV / CLV -----------------------------------------------------------------------
test("1X2 and half/whole-line settlement", () => {
  assert.equal(settleUnits("1x2", 0, "home", 2, 1), 1);
  assert.equal(settleUnits("1x2", 0, "away", 2, 1), -1);
  assert.equal(settleUnits("1x2", 0, "draw", 1, 1), 1);
  assert.equal(settleUnits("totals", 2.5, "over", 2, 1), 1, "3 goals > 2.5");
  assert.equal(settleUnits("totals", 2.5, "under", 2, 0), 1, "2 goals < 2.5");
  assert.equal(settleUnits("totals", 2.0, "over", 1, 1), 0, "exactly 2 ⇒ push on whole line");
  assert.equal(settleUnits("ah", -0.5, "home", 1, 0), 1, "win by 1 covers -0.5");
  assert.equal(settleUnits("ah", -1.0, "home", 1, 0), 0, "win by exactly 1 ⇒ push on -1.0");
  assert.equal(settleUnits("ah", -1.0, "home", 2, 0), 1, "win by 2 covers -1.0");
});

test("quarter-line settlement gives half-win / half-loss", () => {
  assert.deepEqual(componentsOf(-0.75), [-1.0, -0.5]);
  assert.deepEqual(componentsOf(2.25), [2.0, 2.5]);
  // AH home -0.75, win by exactly 1: -0.5 leg wins, -1.0 leg pushes ⇒ +0.5
  assert.equal(settleUnits("ah", -0.75, "home", 1, 0), 0.5);
  // AH home -0.75, draw: both legs lose ⇒ -1
  assert.equal(settleUnits("ah", -0.75, "home", 1, 1), -1);
  // Totals over 2.25 with exactly 2 goals: O2.0 pushes, O2.5 loses ⇒ -0.5
  assert.equal(settleUnits("totals", 2.25, "over", 1, 1), -0.5);
});

test("pnl and modelEV are consistent with the distribution", () => {
  assert.equal(pnl(1, 2.5), 1.5);
  assert.equal(pnl(-1, 2.5), -1);
  assert.equal(pnl(0, 2.5), 0);
  assert.equal(pnl(0.5, 3.0), 1.0); // half-win at 3.0 ⇒ (3-1)/2
  assert.equal(pnl(-0.5, 3.0), -0.5);
  // a fair coin priced at 2.0 has ~0 EV; priced at 2.2 it's positive
  const cells = [{ h: 1, a: 0, p: 0.5 }, { h: 0, a: 1, p: 0.5 }];
  assert.ok(Math.abs(modelEV(cells, "1x2", 0, "home", 2.0)) < 1e-9, "fair price ⇒ 0 EV");
  assert.ok(modelEV(cells, "1x2", 0, "home", 2.2) > 0, "generous price ⇒ +EV");
});

test("settle labels and CLV sign", () => {
  assert.equal(settle("totals", 2.25, "over", 1, 1, 1.9).result, "half-loss");
  assert.equal(settle("1x2", 0, "home", 3, 0, 1.8).result, "win");
  // beating the close: you took 2.10, it closed at 1.90 ⇒ positive CLV
  assert.ok(clv({ placementOdds: 2.10, closingOdds: 1.90 }).clvOdds > 0);
  assert.ok(clv({ placementOdds: 1.80, closingOdds: 2.00 }).clvOdds < 0, "worse than close ⇒ negative");
});

test("allMarkets wires to the model's adjusted lambdas", () => {
  const wp = matchProbabilities({ eloH: 1950, eloA: 1700, seedH: 1950, seedA: 1700, playedH: 3, playedA: 3, names: { h: "H", a: "A" } });
  const mk = allMarkets(wp.lambdas.h, wp.lambdas.a);
  sums1([mk["1x2"].h, mk["1x2"].d, mk["1x2"].a], "allMarkets 1X2");
  sums1([mk.btts.yes, mk.btts.no], "BTTS");
  assert.ok(mk.expectedGoals > 0 && mk.expectedGoals < 8, "sane xG total");
  assert.ok(mk.totals[2.5].over + mk.totals[2.5].under > 0.99, "totals 2.5 partitions");
});
