/**
 * betting/value_engine.mjs — turn a (calibrated) model probability + odds into EV, a Kelly fraction, and
 * a suggested stake; plus a bankroll simulator for grading. Pure + key-independent.
 *
 * Staking policy (matches the plan):
 *   - PAPER phase  → FLAT 0.5–1% of bankroll on any +EV signal (survive variance while the sample builds)
 *   - LIVE phase   → FRACTIONAL Kelly (¼ by default), hard-capped, only after positive CLV on ≥50 settled bets
 * Kelly is computed NUMERICALLY by maximising expected log-growth over the full outcome distribution, so it
 * is correct for Asian/Totals bets that can PUSH or half-win/half-lose (a closed-form win/lose Kelly isn't).
 */
import { settleUnits, pnl } from "./clv.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  bankroll: 1000, flatPct: 0.005, kellyFraction: 0.25, kellyCap: 0.02, minEV: 0.03,
});

/** Simple two-outcome (no push) EV and full-Kelly fraction — for 1X2. */
export const evBinary = (p, odds) => p * odds - 1;
export const kellyBinary = (p, odds) => { const b = odds - 1; return b > 0 ? Math.max(0, Math.min(1, (p * odds - 1) / b)) : 0; };

/**
 * Outcome distribution of a selection from the model's score cells: aggregate by units-won, attach the
 * per-unit payoff at the given odds. Works for any market/line incl. quarter lines.
 * @returns {{dist:[{units,prob,payoff}], ev}}
 */
export function outcomeDist(cells, market, line, selection, odds) {
  const byUnits = new Map();
  for (const c of cells) { const u = settleUnits(market, line, selection, c.h, c.a); byUnits.set(u, (byUnits.get(u) || 0) + c.p); }
  const dist = [...byUnits].map(([units, prob]) => ({ units, prob, payoff: pnl(units, odds) }));
  const ev = dist.reduce((s, o) => s + o.prob * o.payoff, 0);
  return { dist, ev };
}

/** Full-Kelly fraction maximising Σ prob·log(1 + f·payoff). 0 when there's no edge. Push/quarter-safe. */
export function kellyNumeric(dist, { cap = 1, iters = 100 } = {}) {
  const ev = dist.reduce((s, o) => s + o.prob * o.payoff, 0);
  if (ev <= 0) return 0;
  const g = f => dist.reduce((s, o) => s + o.prob * Math.log(Math.max(1e-12, 1 + f * o.payoff)), 0);
  let lo = 0, hi = Math.min(cap, 0.999); // ternary search on the concave growth curve
  for (let i = 0; i < iters; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (g(m1) < g(m2)) lo = m1; else hi = m2; }
  return (lo + hi) / 2;
}

/** Suggested stake under both policies, given EV and the full-Kelly fraction. */
export function suggestStake({ ev, kelly, config = DEFAULT_CONFIG }) {
  const { bankroll, flatPct, kellyFraction, kellyCap } = config;
  const flat = ev > 0 ? bankroll * flatPct : 0;
  const kelly$ = ev > 0 ? bankroll * Math.min(kellyCap, kellyFraction * kelly) : 0;
  return { flat: +flat.toFixed(2), kelly: +kelly$.toFixed(2) };
}

/** One call: EV + full-Kelly + stakes for a market selection (binary 1X2 via p, or cells for line markets). */
export function evaluate({ market, line, selection, odds, p = null, cells = null, config = DEFAULT_CONFIG }) {
  let ev, kelly;
  if (market === "1x2" && p != null) { ev = evBinary(p, odds); kelly = kellyBinary(p, odds); }
  else { const od = outcomeDist(cells, market, line, selection, odds); ev = od.ev; kelly = kellyNumeric(od.dist); }
  return { ev, kelly, stake: suggestStake({ ev, kelly, config }) };
}

/**
 * Simulate a bankroll over settled bets (chronological). Each bet needs { pnl } (profit per unit at the
 * odds taken) and { kelly } (full-Kelly fraction at placement). Stakes are a fraction of the RUNNING
 * bankroll. Returns end bankroll, ROI on turnover, and the running curve, for both policies.
 */
export function simulateBankroll(bets, config = DEFAULT_CONFIG) {
  const sim = mode => {
    let bank = config.bankroll, staked = 0, curve = [bank];
    for (const b of bets) {
      const frac = mode === "flat" ? config.flatPct : Math.min(config.kellyCap, config.kellyFraction * (b.kelly || 0));
      const stake = bank * frac; staked += stake; bank += stake * (b.pnl || 0); curve.push(bank);
    }
    return { end: +bank.toFixed(2), profit: +(bank - config.bankroll).toFixed(2), turnover: +staked.toFixed(2), roi: staked ? +((bank - config.bankroll) / staked).toFixed(4) : 0, curve };
  };
  return { n: bets.length, flat: sim("flat"), kelly: sim("kelly") };
}
