/**
 * Tests for the calibration module (model/calibrate.mjs). Pure, deterministic.
 *   node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { METHODS, fit, fitBest, logLoss, reliability, applyCalibrator, calibrate1x2, sigmoid, logit } from "../model/calibrate.mjs";

test("methods are identity at their neutral params", () => {
  for (const p of [0.05, 0.3, 0.5, 0.85]) {
    assert.ok(Math.abs(METHODS.platt.apply([1, 0], p) - p) < 1e-9, "platt identity at a=1,b=0");
    assert.ok(Math.abs(METHODS.temperature.apply([1], p) - p) < 1e-9, "temperature identity at T=1");
    assert.ok(Math.abs(METHODS.beta.apply([1, 1, 0], p) - p) < 1e-9, "beta identity at a=1,b=1,c=0");
    assert.equal(METHODS.identity.apply([], p), p);
  }
});

test("sigmoid/logit round-trip", () => {
  for (const p of [0.1, 0.4, 0.75]) assert.ok(Math.abs(sigmoid(logit(p)) - p) < 1e-9);
});

test("fitting reduces log-loss on an over-confident set", () => {
  // model always says 0.80, but the event is a coin flip ⇒ calibration should pull it toward 0.50
  const samples = []; for (let i = 0; i < 200; i++) samples.push({ p: 0.8, y: i % 2 });
  const id = logLoss(samples, METHODS.identity.apply, []);
  const f = fit(samples, "platt");
  assert.ok(f.after.logLoss < id - 0.1, `platt cuts log-loss (${id.toFixed(3)}→${f.after.logLoss.toFixed(3)})`);
  assert.ok(Math.abs(applyCalibrator(f, 0.8) - 0.5) < 0.05, "0.8 recalibrated toward 0.5");
});

test("fitBest never does worse than identity", () => {
  const samples = []; for (let i = 0; i < 120; i++) samples.push({ p: 0.7, y: i % 3 === 0 ? 1 : 0 }); // ~33% base under a 0.7 claim
  const { best } = fitBest(samples);
  const id = logLoss(samples, METHODS.identity.apply, []);
  assert.ok(best.after.logLoss <= id + 1e-9, "best ≤ identity");
});

test("reliability ECE is ~0 for a perfectly calibrated set", () => {
  // p in {0.2,0.8}; each outcome occurs at exactly its stated rate
  const samples = [];
  for (let i = 0; i < 100; i++) samples.push({ p: 0.2, y: i < 20 ? 1 : 0 });
  for (let i = 0; i < 100; i++) samples.push({ p: 0.8, y: i < 80 ? 1 : 0 });
  assert.ok(reliability(samples).ece < 1e-9, "perfectly calibrated ⇒ ECE 0");
});

test("calibrate1x2 renormalises to a valid distribution", () => {
  const cal = { method: "beta", params: [1.3, 0.9, 0.1] };
  const out = calibrate1x2(cal, { h: 0.5, d: 0.3, a: 0.2 });
  assert.ok(Math.abs(out.h + out.d + out.a - 1) < 1e-9, "sums to 1");
  assert.ok(out.h > 0 && out.d > 0 && out.a > 0, "all positive");
});
