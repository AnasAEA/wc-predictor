/**
 * betting/devig.mjs — convert bookmaker decimal odds into true implied probabilities.
 *
 * The market is our benchmark; the de-vig method we use to recover the book's *true* probabilities
 * materially changes where we think value is. The naive multiplicative method ignores the
 * favorite-longshot bias (books take more margin on longshots), so it systematically over-states
 * underdog probability — and a model fed that benchmark will hallucinate underdog "value" everywhere.
 *
 * We implement three methods and let the data pick the winner (Phase 2: score each by how well its
 * de-vigged probabilities predict actual results, keep the best-calibrated). Default = Shin.
 *
 *   multiplicative(odds)  — p_i = (1/o_i) / Σ(1/o_j).            Simple, biased. Baseline only.
 *   power(odds)           — p_i = (1/o_i)^k, k solved so Σ = 1.  Buchdahl's "power" method.
 *   shin(odds)            — Shin (1992): models insider-trading proportion z; corrects longshot bias.
 *   betfairMid(back,lay)  — exchange has no vig; the fair prob is the back/lay midpoint, normalised.
 *
 * All take an array of decimal odds (e.g. [2.10, 3.40, 3.80]) and return
 *   { probs:number[], method, overround, ...extras }   with Σ probs === 1.
 */

const inv = odds => odds.map(o => 1 / o);
const sum = a => a.reduce((s, x) => s + x, 0);
const validate = odds => {
  if (!Array.isArray(odds) || odds.length < 2) throw new Error("devig: need ≥2 decimal odds");
  if (odds.some(o => !(o > 1))) throw new Error("devig: decimal odds must all be > 1");
};

/** Basic / multiplicative: scale inverse-odds to sum to 1. Ignores favorite-longshot bias. */
export function multiplicative(odds) {
  validate(odds);
  const q = inv(odds), S = sum(q);
  return { probs: q.map(x => x / S), method: "multiplicative", overround: S - 1 };
}

/**
 * Power method: find k with Σ (1/o_i)^k = 1, then p_i = (1/o_i)^k.
 * Σ(1/o_i) > 1 and each 1/o_i < 1, so the sum decreases in k ⇒ a unique k ≥ 1. Bisection is robust.
 */
export function power(odds, { tol = 1e-12, maxIter = 200 } = {}) {
  validate(odds);
  const q = inv(odds);
  const f = k => sum(q.map(x => Math.pow(x, k))) - 1;
  let lo = 1, hi = 1; // expand hi until the sum drops below 1
  while (f(hi) > 0 && hi < 1e6) hi *= 2;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2, v = f(mid);
    if (Math.abs(v) < tol) { lo = hi = mid; break; }
    if (v > 0) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2, probs = q.map(x => Math.pow(x, k)), S = sum(probs);
  return { probs: probs.map(p => p / S), method: "power", overround: sum(q) - 1, k };
}

/**
 * Shin's method. With π_i = 1/o_i and booksum Σ = Σπ_j, for a given insider proportion z:
 *     p_i(z) = ( sqrt( z² + 4(1−z)·π_i²/Σ ) − z ) / ( 2(1−z) )
 * Σ p_i(z) decreases monotonically from sqrt(Σ) (>1, at z=0) toward Σπ_i²/Σ (<1, as z→1),
 * so a unique z ∈ [0,1) gives Σ p_i = 1. Bisection on z. Falls back to power() if it can't bracket.
 */
export function shin(odds, { tol = 1e-12, maxIter = 200 } = {}) {
  validate(odds);
  const pi = inv(odds), S = sum(pi);
  const pAt = z => pi.map(p => (Math.sqrt(z * z + 4 * (1 - z) * (p * p) / S) - z) / (2 * (1 - z)));
  const g = z => sum(pAt(z)) - 1;
  // g(0) = sqrt(S) - 1 > 0; we need a z where g(z) < 0 to bracket the root
  let lo = 0, hi = 0.5;
  while (g(hi) > 0 && hi < 1 - 1e-9) hi = (hi + 1) / 2;
  if (g(hi) > 0) { const pw = power(odds); return { ...pw, method: "shin", note: "fellback-to-power", z: null }; }
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2, v = g(mid);
    if (Math.abs(v) < tol) { lo = hi = mid; break; }
    if (v > 0) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2, probs = pAt(z), Sp = sum(probs);
  return { probs: probs.map(p => p / Sp), method: "shin", overround: S - 1, z };
}

/**
 * Betfair (exchange) de-vig: no bookmaker margin, so the fair probability per outcome is the midpoint
 * of the back and lay implied probabilities; normalise across outcomes to absorb the small spread.
 * @param {number[]} back  best available back (decimal) per outcome
 * @param {number[]} lay   best available lay  (decimal) per outcome
 */
export function betfairMid(back, lay) {
  if (back.length !== lay.length) throw new Error("devig: back/lay length mismatch");
  const mid = back.map((b, i) => (1 / b + 1 / lay[i]) / 2), S = sum(mid);
  return { probs: mid.map(p => p / S), method: "betfair-mid", overround: S - 1 };
}

export const METHODS = { multiplicative, power, shin };

/** Convenience: run a named method (default shin) and return just the probs. */
export function devig(odds, method = "shin") {
  const fn = METHODS[method]; if (!fn) throw new Error(`devig: unknown method ${method}`);
  return fn(odds).probs;
}
