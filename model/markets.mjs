/**
 * model/markets.mjs — map the model's score distribution to betting markets.
 *
 * matchProbabilities() already returns the fully-adjusted Poisson rates (lambdas:{h,a}) — strength,
 * attack/defence overlay, host, etc. all baked in. From those we rebuild the pre-match scoreline grid
 * (Dixon-Coles τ applied, no live state) and read off every market we care about:
 *   1X2, Over/Under totals, Asian Handicap, Both-Teams-To-Score.
 *
 * These are the LOWER-MARGIN markets where our full-distribution model has a structural advantage over
 * a book's blunter pricing — and where Phase 1.5 logging happens BEFORE any betting, so the goal-count
 * diagnostic (Phase 2.5) can catch the classic Poisson failure (under-predicting blowouts ⇒ over-valuing
 * the Under) before we ever stake a Totals bet.
 *
 * NOTE: these read the raw scoreline distribution. The 1X2 early-tournament shrink + stake draw-reshape
 * that matchProbabilities applies are 1X2-only calibration overlays and are intentionally NOT here; goal
 * markets should come from the honest distribution and get their own calibration in Phase 2.
 */
import { scoreGrid, MODEL } from "./core.mjs";

/** Normalised scoreline cells [{h,a,p}] (Σp=1) from Poisson rates, pre-match (τ applied). */
export function scoreDistribution(lamH, lamA, o = MODEL) {
  const g = scoreGrid(lamH, lamA, { live: false }, o);
  return g.cells.map(c => ({ h: c.h, a: c.a, p: c.p / g.tot }));
}

/** 1X2 straight from the distribution (no shrink/stake overlay). */
export function oneXtwo(cells) {
  let h = 0, d = 0, a = 0;
  for (const c of cells) { if (c.h > c.a) h += c.p; else if (c.h < c.a) a += c.p; else d += c.p; }
  return { h, d, a };
}

/** Both teams to score. */
export function btts(cells) {
  let yes = 0; for (const c of cells) if (c.h > 0 && c.a > 0) yes += c.p;
  return { yes, no: 1 - yes };
}

/**
 * Over/Under a totals line. Whole-number lines (2.0) can push; half lines (2.5) cannot.
 * @returns {{over,under,push}}  push=0 for half lines.
 */
export function overUnder(cells, line) {
  let over = 0, under = 0, push = 0;
  for (const c of cells) { const t = c.h + c.a; if (t > line) over += c.p; else if (t < line) under += c.p; else push += c.p; }
  return { over, under, push };
}

/**
 * Asian Handicap on the HOME side. `line` is added to the home goal margin (e.g. -1.0 = home gives 1).
 * Whole-number lines can push; half lines cannot. Quarter lines (.25/.75) are NOT handled here — the
 * value engine (Phase 3) splits a quarter bet across the two adjacent half/whole lines via splitQuarter().
 * @returns {{home,away,push}}
 */
export function asianHandicap(cells, line) {
  if (Math.abs((Math.abs(line) % 1) - 0.25) < 1e-9 || Math.abs((Math.abs(line) % 1) - 0.75) < 1e-9)
    throw new Error(`asianHandicap: quarter line ${line} — use splitQuarter() at the value stage`);
  let home = 0, away = 0, push = 0;
  for (const c of cells) { const m = (c.h - c.a) + line; if (m > 0) home += c.p; else if (m < 0) away += c.p; else push += c.p; }
  return { home, away, push };
}

/** Decompose a quarter line into its two adjacent half/whole lines (each gets half the stake). */
export function splitQuarter(line) {
  const lo = Math.floor(line * 2) / 2, hi = lo + 0.5; // e.g. -0.75 → [-0.5,-1.0] (sign handled by caller direction)
  return [lo, hi];
}

/** Everything at once for a match, given the model's adjusted Poisson rates. */
export function allMarkets(lamH, lamA, { totalsLines = [1.5, 2.5, 3.5], ahLines = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5] } = {}, o = MODEL) {
  const cells = scoreDistribution(lamH, lamA, o);
  return {
    "1x2": oneXtwo(cells),
    btts: btts(cells),
    totals: Object.fromEntries(totalsLines.map(l => [l, overUnder(cells, l)])),
    ah: Object.fromEntries(ahLines.map(l => [l, asianHandicap(cells, l)])),
    expectedGoals: cells.reduce((s, c) => s + (c.h + c.a) * c.p, 0),
  };
}
