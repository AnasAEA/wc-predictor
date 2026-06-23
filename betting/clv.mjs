/**
 * betting/clv.mjs — settlement, expected value, and closing-line value. Pure + key-independent.
 *
 * One unified settlement model handles 1X2, Totals and Asian Handicap — including the QUARTER lines
 * Pinnacle quotes (e.g. O 2.25, AH -0.75): a quarter bet is half-staked on each of the two adjacent
 * half/whole lines, so it can half-win / half-lose / push. We express every outcome as "units" of the
 * stake that won (+1 win, +0.5 half-win, 0 push, −0.5 half-loss, −1 loss); `pnl(units, odds)` turns that
 * into profit per unit staked, and `modelEV` integrates it over the model's score distribution.
 *
 * EV (not raw prob difference) is the universal value trigger: it folds in the odds and the push/quarter
 * structure that a pure probability edge can't represent on Asian markets.
 */
import { shin } from "./devig.mjs";

const HALF = 0.5;
/** The .0/.5 component lines a (possibly quarter) line splits into. Whole/half → itself. */
export function componentsOf(line) {
  const k = line / HALF;
  if (Number.isInteger(k)) return [line];
  const lo = Math.floor(k) * HALF;
  return [lo, lo + HALF];
}

/** How much a selection beat a single .0/.5 component line `c`, given an actual scoreline. */
function coverValue(market, selection, c, gh, ga) {
  if (market === "totals") { const t = gh + ga; return selection === "over" ? t - c : c - t; }
  if (market === "ah") { const base = (gh - ga) + c; return selection === "home" ? base : -base; }
  throw new Error(`coverValue: ${market} is not a line market`);
}
/** Settle on a single component line: +1 win / 0 push (whole line only) / −1 loss. */
function subUnits(cv, c) {
  if (cv > 0) return 1; if (cv < 0) return -1;
  return Number.isInteger(c) ? 0 : (cv > 0 ? 1 : -1); // cv==0 only possible on a whole line ⇒ push
}

/**
 * Units of stake won for any market/line/selection at an actual scoreline.
 * @returns one of {1, 0.5, 0, -0.5, -1}
 */
export function settleUnits(market, line, selection, gh, ga) {
  if (market === "1x2") {
    const res = gh > ga ? "home" : gh < ga ? "away" : "draw";
    return selection === res ? 1 : -1;
  }
  const comps = componentsOf(line);
  return comps.reduce((s, c) => s + subUnits(coverValue(market, selection, c, gh, ga), c), 0) / comps.length;
}

/** Profit per 1 unit staked, given the units-won and the decimal odds. */
export function pnl(units, odds) { return units > 0 ? (odds - 1) * units : units; }

/**
 * Model expected value (profit per unit) of a selection at given odds, integrated over score cells.
 * @param {Array<{h,a,p}>} cells normalised score distribution
 */
export function modelEV(cells, market, line, selection, odds) {
  let ev = 0; for (const c of cells) ev += c.p * pnl(settleUnits(market, line, selection, c.h, c.a), odds);
  return ev;
}

/** Model probability that a selection "wins" (counts a half-win as 0.5), for reporting alongside EV. */
export function modelWinProb(cells, market, line, selection) {
  let p = 0; for (const c of cells) { const u = settleUnits(market, line, selection, c.h, c.a); if (u > 0) p += c.p * u; }
  return p;
}

/**
 * Closing-line value. Positive = the bet looks good vs the close.
 *   clvOdds = placement_odds / closing_odds − 1   (you locked a bigger price than the close)
 *   clvProb = devigged P(selection) at close − at placement   (the market moved toward your pick)
 * Pass de-vigged probabilities for clvProb (the rigorous version); odds are raw decimal.
 * NOTE: the rigorous metric is clvProb; clvOdds is the quick raw-odds proxy. (The intuitive sign is the
 * opposite of (closing−placement)/placement: beating the close means placement_odds > closing_odds.)
 */
export function clv({ placementOdds, closingOdds, placementProb = null, closingProb = null }) {
  const out = { clvOdds: placementOdds && closingOdds ? placementOdds / closingOdds - 1 : null };
  out.clvProb = placementProb != null && closingProb != null ? closingProb - placementProb : null;
  return out;
}

/**
 * Closing fair-probability of an AH/totals selection at a line that may no longer be on the board at close.
 * AH/totals lines drift before kickoff and the sharp book posts only one line, so we pool a de-vigged
 * P(selection) ladder across ALL closing books (Shin per book, averaging duplicate lines), bracket the wanted
 * line between its two nearest rungs and interpolate. Probability space is monotonic and ~linear in the line and
 * is de-vig-consistent with the placement prob, so the resulting clvProb compares like with like.
 * @returns {prob, odds:1/prob (fair)} or null when the line can't be bracketed (we don't extrapolate-guess).
 */
export function interpClose(books, market, line, selection) {
  if (market !== "ah" && market !== "totals") return null;
  const acc = {};                                       // line → { sum, n } of de-vigged P(selection)
  for (const bk of Object.values(books || {})) {
    const table = market === "totals" ? bk.totals : bk.spreads;
    if (!table) continue;
    for (const [L, o] of Object.entries(table)) {
      const pair = market === "totals" ? [o.over, o.under] : [o.home, o.away];
      if (!pair[0] || !pair[1]) continue;
      const dv = shin(pair).probs;
      const p = (market === "totals" ? selection === "over" : selection === "home") ? dv[0] : dv[1];
      (acc[+L] ??= { sum: 0, n: 0 }); acc[+L].sum += p; acc[+L].n++;
    }
  }
  const pts = Object.entries(acc).map(([L, v]) => ({ L: +L, prob: v.sum / v.n })).sort((a, b) => a.L - b.L);
  let lo = null, hi = null;
  for (const p of pts) { if (p.L <= line && (!lo || p.L > lo.L)) lo = p; if (p.L >= line && (!hi || p.L < hi.L)) hi = p; }
  if (!lo || !hi) return null;                          // can't bracket → leave it null, don't fabricate
  const prob = lo.L === hi.L ? lo.prob : lo.prob + ((line - lo.L) / (hi.L - lo.L)) * (hi.prob - lo.prob);
  return prob > 0 && prob < 1 ? { prob, odds: 1 / prob } : null;
}

/** Settle a logged bet to a result label + realised pnl, given final goals and the odds taken. */
export function settle(market, line, selection, gh, ga, odds) {
  const u = settleUnits(market, line, selection, gh, ga);
  const label = u === 1 ? "win" : u === 0.5 ? "half-win" : u === 0 ? "push" : u === -0.5 ? "half-loss" : "loss";
  return { result: label, units: u, pnl: pnl(u, odds) };
}
