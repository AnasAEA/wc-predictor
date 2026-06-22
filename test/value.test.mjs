/**
 * Tests for the value/staking engine (betting/value_engine.mjs). Pure, deterministic.
 *   node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evBinary, kellyBinary, outcomeDist, kellyNumeric, suggestStake, evaluate, simulateBankroll, DEFAULT_CONFIG } from "../betting/value_engine.mjs";
import { modelEV } from "../betting/clv.mjs";

const approx = (a, b, e = 1e-6, m) => assert.ok(Math.abs(a - b) <= e, `${m || ""} expected ${b}, got ${a}`);

test("binary EV and Kelly", () => {
  approx(evBinary(0.5, 2.0), 0, 1e-9, "fair coin at evens ⇒ 0 EV");
  assert.ok(evBinary(0.55, 2.0) > 0);
  approx(kellyBinary(0.55, 2.0), 0.10, 1e-6, "Kelly f = edge/b = 0.10");
  assert.equal(kellyBinary(0.4, 2.0), 0, "no edge ⇒ 0 stake");
});

test("numeric Kelly matches closed-form for a no-push bet", () => {
  // odds 2.0 ⇒ win payoff +1, loss −1; p=0.55
  const dist = [{ units: 1, prob: 0.55, payoff: 1 }, { units: -1, prob: 0.45, payoff: -1 }];
  approx(kellyNumeric(dist), 0.10, 5e-3, "numeric ≈ analytic Kelly");
  const noEdge = [{ units: 1, prob: 0.45, payoff: 1 }, { units: -1, prob: 0.55, payoff: -1 }];
  assert.equal(kellyNumeric(noEdge), 0, "EV ≤ 0 ⇒ 0");
});

test("outcomeDist normalises and its EV matches modelEV", () => {
  const cells = [{ h: 2, a: 0, p: 0.4 }, { h: 1, a: 1, p: 0.35 }, { h: 0, a: 2, p: 0.25 }];
  const od = outcomeDist(cells, "totals", 2.5, "over", 1.9);
  approx(od.dist.reduce((s, o) => s + o.prob, 0), 1, 1e-9, "probs sum to 1");
  approx(od.ev, modelEV(cells, "totals", 2.5, "over", 1.9), 1e-9, "EV consistent with clv.modelEV");
});

test("suggestStake follows the policy", () => {
  const s = suggestStake({ ev: 0.05, kelly: 0.04, config: DEFAULT_CONFIG }); // ¼·0.04 = 0.01 < 0.02 cap
  approx(s.flat, DEFAULT_CONFIG.bankroll * DEFAULT_CONFIG.flatPct, 1e-6, "flat = 0.5% bankroll");
  approx(s.kelly, DEFAULT_CONFIG.bankroll * DEFAULT_CONFIG.kellyFraction * 0.04, 1e-6, "¼-Kelly under the cap");
  assert.equal(suggestStake({ ev: -0.01, kelly: 0.2, config: DEFAULT_CONFIG }).flat, 0, "no stake on −EV");
  const capped = suggestStake({ ev: 0.5, kelly: 0.9, config: DEFAULT_CONFIG });
  approx(capped.kelly, DEFAULT_CONFIG.bankroll * DEFAULT_CONFIG.kellyCap, 1e-6, "Kelly stake hits the cap");
});

test("evaluate dispatches 1X2 (prob) vs line markets (cells)", () => {
  const v1 = evaluate({ market: "1x2", selection: "home", odds: 2.2, p: 0.5 });
  approx(v1.ev, 0.1, 1e-9, "1X2 EV = p·odds − 1");
  const cells = [{ h: 2, a: 0, p: 0.6 }, { h: 0, a: 1, p: 0.4 }];
  const v2 = evaluate({ market: "ah", line: -0.5, selection: "home", odds: 1.9, cells });
  assert.ok(typeof v2.ev === "number" && v2.kelly >= 0, "line market evaluates");
});

test("bankroll simulation compounds wins and losses", () => {
  const bets = [{ pnl: 0.9, kelly: 0.1 }, { pnl: -1, kelly: 0.1 }, { pnl: 0.9, kelly: 0.1 }];
  const sim = simulateBankroll(bets, DEFAULT_CONFIG);
  assert.equal(sim.n, 3);
  assert.ok(sim.flat.curve.length === 4, "curve has start + one point per bet");
  assert.ok(sim.flat.end !== DEFAULT_CONFIG.bankroll, "bankroll moves");
  assert.ok(typeof sim.flat.roi === "number", "ROI computed");
});
