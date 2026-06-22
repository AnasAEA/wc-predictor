/**
 * model/goal_dist.mjs — pluggable goal-count distributions for the score grid. Pure + dependency-free.
 *
 * Independent Poisson forces Var = Mean. Real football goals are usually slightly OVERDISPERSED (Var > Mean):
 * more 0-0s and blowouts, fewer middling scores than Poisson expects. The Negative-Binomial adds a single
 * dispersion knob α with Var = μ + α·μ², and → Poisson as α → 0. Both are parameterised by the MEAN μ (the
 * model's λ), so swapping the distribution doesn't touch the strength/λ pipeline upstream.
 *
 * scoreGrid() in core.mjs calls makeGoalDist(spec) when opts.goalDist is set; default stays exact Poisson.
 */

// Lanczos log-gamma (good to ~1e-10) — lets NegBin take a non-integer dispersion r = 1/α.
const LG = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = 0.99999999999980993; const t = x + 7.5;
  for (let i = 0; i < LG.length; i++) a += LG[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Poisson PMF by mean (matches core's table-based poisson for small k; general for any k). */
export const poissonPMF = (k, mu) => Math.exp(k * Math.log(mu) - mu - lgamma(k + 1));

/** Negative-Binomial PMF with mean μ and dispersion α (Var = μ + α·μ²). α→0 ⇒ Poisson. */
export function negbinPMF(k, mu, alpha) {
  if (alpha <= 1e-9 || mu <= 0) return poissonPMF(k, mu);
  const r = 1 / alpha, p = r / (r + mu);
  return Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
}

/** Factory: spec → (k, mean) → probability. */
export function makeGoalDist(spec) {
  if (!spec || spec.name === "poisson") return (k, mu) => poissonPMF(k, mu);
  if (spec.name === "negbin") { const a = Math.max(1e-9, spec.alpha ?? 0); return (k, mu) => negbinPMF(k, mu, a); }
  throw new Error(`goal_dist: unknown distribution ${spec.name}`);
}

/** Sample dispersion index Var/Mean (>1 ⇒ overdispersed ⇒ NegBin candidate). */
export function dispersionIndex(values) {
  const n = values.length, mean = values.reduce((s, x) => s + x, 0) / n;
  const varr = values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, var: varr, ratio: varr / mean, n };
}

/**
 * MLE-fit a single global dispersion α on {mean, k} samples (model λ vs observed goals), by maximising the
 * NegBin log-likelihood. Returns α plus NB vs Poisson log-likelihood so we can see if it's actually better.
 */
export function fitDispersion(samples, { lo = 1e-4, hi = 3, iters = 100 } = {}) {
  const ll = a => samples.reduce((s, { mean, k }) => s + Math.log(Math.max(1e-12, negbinPMF(k, mean, a))), 0);
  let L = lo, H = hi; // ternary search (log-likelihood is unimodal in α here)
  for (let i = 0; i < iters; i++) { const m1 = L + (H - L) / 3, m2 = H - (H - L) / 3; if (ll(m1) < ll(m2)) L = m1; else H = m2; }
  const alpha = (L + H) / 2;
  const llPois = samples.reduce((s, { mean, k }) => s + Math.log(Math.max(1e-12, poissonPMF(k, mean))), 0);
  return { alpha, llNB: ll(alpha), llPois, improved: ll(alpha) > llPois };
}
