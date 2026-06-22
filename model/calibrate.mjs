/**
 * model/calibrate.mjs — probability calibration. Pure + dependency-free.
 *
 * The raw model is mis-calibrated (shadow mode caught it over-valuing longshots — a Poisson-tail artefact:
 * independent Poisson spreads too much mass onto a minnow scoring 1–2, inflating its win/draw probability).
 * Calibration maps raw probabilities → honest ones, fit to minimise log-loss on settled outcomes.
 *
 * Everything is framed as BINARY {p, y} samples (y∈{0,1}), so 1X2 (one-vs-rest), Totals and AH all pool
 * through the same code. For a live 1X2 forecast we calibrate H/D/A independently then renormalise.
 *
 * Methods (identity at their neutral params, so "no calibration" is representable and fitting is well-posed):
 *   identity                                                  baseline
 *   platt        sigmoid(a·logit(p) + b)         a=1,b=0      classic logistic recalibration
 *   temperature  p^(1/T) / (p^(1/T)+(1-p)^(1/T)) T=1          one knob; squashes over/under-confidence
 *   beta         sigmoid(c + a·ln p − b·ln(1−p))  a=1,b=1,c=0  bends the two tails independently (Poisson fix-ish)
 *
 * Pipeline: core.mjs → predict.mjs → calibrate.mjs. A fitted calibrator is just { method, params } — tiny,
 * serialisable to data/calibration.json, and reversible (drop it to go back to raw).
 */

const EPS = 1e-6;
const clamp01 = p => Math.min(1 - EPS, Math.max(EPS, p));
export const sigmoid = z => 1 / (1 + Math.exp(-z));
export const logit = p => { const c = clamp01(p); return Math.log(c / (1 - c)); };

export const METHODS = {
  identity: { params0: [], apply: (_, p) => p },
  platt: { params0: [1, 0], apply: ([a, b], p) => sigmoid(a * logit(p) + b) },
  temperature: { params0: [1], apply: ([t], p) => { const T = Math.max(1e-3, t), a = Math.pow(clamp01(p), 1 / T), b = Math.pow(1 - clamp01(p), 1 / T); return a / (a + b); } },
  beta: { params0: [1, 1, 0], apply: ([a, b, c], p) => sigmoid(c + a * Math.log(clamp01(p)) - b * Math.log(1 - clamp01(p))) },
};

export const logLoss = (samples, apply, params) => {
  let s = 0; for (const { p, y } of samples) { const q = clamp01(apply(params, p)); s += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); } return s / samples.length;
};
export const brier = (samples, apply, params) => {
  let s = 0; for (const { p, y } of samples) { const q = apply(params, p); s += (q - y) ** 2; } return s / samples.length;
};

/** Reliability bins + expected calibration error over binary samples (apply optional → raw). */
export function reliability(samples, apply = (_, p) => p, params = [], bins = 10) {
  const B = Array.from({ length: bins }, () => ({ sp: 0, sy: 0, n: 0 }));
  for (const { p, y } of samples) { const q = apply(params, p), i = Math.min(bins - 1, Math.floor(q * bins)); B[i].n++; B[i].sp += q; B[i].sy += y; }
  let ece = 0; const N = samples.length;
  const rows = B.map((b, i) => { const pred = b.n ? b.sp / b.n : 0, obs = b.n ? b.sy / b.n : 0; ece += b.n / N * Math.abs(obs - pred); return { lo: i / bins, pred, obs, n: b.n }; });
  return { ece, rows };
}

/** Generic derivative-free minimiser (Nelder–Mead) — fine for the 1–3 params here. */
function nelderMead(f, x0, { iters = 400 } = {}) {
  const n = x0.length; if (n === 0) return { x: [], f: f([]) };
  let S = [x0.slice()]; for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += (x[i] !== 0 ? 0.1 * x[i] : 0.1); S.push(x); }
  let F = S.map(f);
  const sort = () => { const idx = S.map((_, i) => i).sort((a, b) => F[a] - F[b]); S = idx.map(i => S[i]); F = idx.map(i => F[i]); };
  for (let it = 0; it < iters; it++) {
    sort(); const w = n;
    const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const refl = c.map((cj, j) => cj + (cj - S[w][j])), fr = f(refl);
    if (fr < F[0]) { const exp = c.map((cj, j) => cj + 2 * (cj - S[w][j])), fe = f(exp); if (fe < fr) { S[w] = exp; F[w] = fe; } else { S[w] = refl; F[w] = fr; } }
    else if (fr < F[n - 1]) { S[w] = refl; F[w] = fr; }
    else { const con = c.map((cj, j) => cj + 0.5 * (S[w][j] - cj)), fc = f(con); if (fc < F[w]) { S[w] = con; F[w] = fc; } else for (let i = 1; i <= n; i++) { S[i] = S[i].map((xj, j) => S[0][j] + 0.5 * (xj - S[0][j])); F[i] = f(S[i]); } }
  }
  sort(); return { x: S[0], f: F[0] };
}

/** Fit one method to binary samples by minimising log-loss. Returns the fitted calibrator + metrics. */
export function fit(samples, method = "platt") {
  const m = METHODS[method]; if (!m) throw new Error(`calibrate: unknown method ${method}`);
  const before = { logLoss: logLoss(samples, m.apply, m.params0), brier: brier(samples, m.apply, m.params0), ece: reliability(samples).ece };
  const { x: params } = m.params0.length ? nelderMead(p => logLoss(samples, m.apply, p), m.params0) : { x: [] };
  const after = { logLoss: logLoss(samples, m.apply, params), brier: brier(samples, m.apply, params), ece: reliability(samples, m.apply, params).ece };
  return { method, params, n: samples.length, before, after };
}

/** Pick the method with the best (lowest) log-loss; identity wins ties so we never over-fit for nothing. */
export function fitBest(samples, methods = ["identity", "temperature", "platt", "beta"]) {
  const fits = methods.map(m => fit(samples, m)).sort((a, b) => a.after.logLoss - b.after.logLoss);
  return { best: fits[0], all: fits };
}

/** Apply a saved { method, params } to a single probability. */
export const applyCalibrator = ({ method, params }, p) => METHODS[method].apply(params, p);

/** Calibrate a 1X2 triple one-vs-rest, then renormalise to a valid distribution. */
export function calibrate1x2(cal, { h, d, a }) {
  const ch = applyCalibrator(cal, h), cd = applyCalibrator(cal, d), ca = applyCalibrator(cal, a), s = ch + cd + ca || 1;
  return { h: ch / s, d: cd / s, a: ca / s };
}
