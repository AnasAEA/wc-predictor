/**
 * model/core.mjs — canonical WC·26 forecasting core.
 *
 * Pure functions: no DOM, no global state, no I/O. This is the SINGLE SOURCE OF TRUTH for the
 * Dixon-Coles bivariate-Poisson model. `scripts/backtest.mjs` imports it directly; `app.js` still
 * carries an inline copy (its render path is the live site) — wiring app.js onto this module is the
 * remaining integration step. Until then, any change here must be mirrored there (the parity test in
 * test/model.test.mjs guards the numbers).
 *
 * The pipeline (mirrors the old app.js winProb):
 *   strength (Elo, SoS-adjusted, xG-blended)  →  goal supremacy  →  two Poisson rates (λH, λA)
 *   →  attack/defence overlay  →  host / stakes / live red-cards / minutes  →  Dixon-Coles score grid
 *   →  outcome probabilities (+ early-tournament draw-aware shrink).
 */

// ---- tunable constants (every magic number the model uses, in one place) --------------------------
export const MODEL = Object.freeze({
  DC_RHO: -0.11,            // Dixon-Coles low-score dependence (negative = football's draw inflation)
  MU_GROUP: 1.35, MU_KO: 1.25, // base goals/side; knockouts are played tighter
  K: 22, DRIFT: 70, HOST_ELO_BONUS: 40, SOS_PASSES: 4, // Elo update: cool K, hard ±drift cap, host nudge
  SUP_CLAMP: 2.5, SUP_DIV: 300, // Elo gap → supremacy: (eloH-eloA)/SUP_DIV, clamped ±SUP_CLAMP
  XG_BLEND: 0.7,            // result signal = 0.7·xG + 0.3·goals (when xG present)
  GOALS_ONLY_WT: 0.6,       // down-weight games with no xG (noisier)
  AD_BETA: 0.10, AD_PRIOR_MID: 1786, AD_PRIOR_SCALE: 150, // attack/defence Elo-implied prior
  AD_CLAMP: [0.6, 1.6], AD_MULT_CLAMP: [0.7, 1.45],       // clamp raw A/D, and the λ multiplier
  AD_SHRINK_N: 4,          // James-Stein: weight on data = n/(n+AD_SHRINK_N)
  AD_TRUST_MAX: 0.6, AD_TRUST_RAMP: 24, AD_SKEW_KEEP: 0.75, // global trust ramp; Elo keeps ≥75% of who-wins
  AD_MIN_GAMES: 2,         // overlay dormant until BOTH sides have ≥2 games
  HOST_LAM_FOR: 0.13, HOST_LAM_AGAINST: -0.06,            // host: +13% own rate, −6% opponent's
  RED_DOWN: 0.30, RED_UP: 0.35,                           // live man-advantage (scaled by time left)
  SHRINK_MAX: 0.18, SHRINK_GAMES: 6,                      // early-tournament draw-aware shrink
  SHRINK_BASE: { h: 0.35, d: 0.30, a: 0.35 },
  LAM_FLOOR: 0.18, GRID: 9,                               // λ floor; score grid is GRID×GRID (0..8)
});

import { makeGoalDist } from "./goal_dist.mjs";

const clampRange = ([lo, hi], v) => Math.max(lo, Math.min(hi, v));

// ---- Poisson + Dixon-Coles low-score correction --------------------------------------------------
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880];
export const poisson = (k, l) => Math.exp(-l) * Math.pow(l, k) / FACT[k];
export const dcTau = (x, y, lh, la, rho = MODEL.DC_RHO) =>
  x === 0 && y === 0 ? 1 - lh * la * rho :
  x === 0 && y === 1 ? 1 + lh * rho :
  x === 1 && y === 0 ? 1 + la * rho :
  x === 1 && y === 1 ? 1 - rho : 1;

/**
 * Per-game, order-independent signal that eloRatings + attackDefenceRatings consume.
 * @param {{hc:string,ac:string,host:?string,gh:number,ga:number,xgH:?number,xgA:?number}} g
 *        host is the host TEAM CODE (or null); xg* null → goals-only.
 * @returns {{hc,ac,host,seffH,g,att:{h,a},def:{h,a},wt}}
 */
export function gameSignal({ hc, ac, host = null, gh, ga, xgH = null, xgA = null }) {
  const hasXg = xgH != null && xgA != null;
  let seffH = gh > ga ? 1 : gh < ga ? 0 : 0.5;
  if (hasXg) seffH = MODEL.XG_BLEND * clampRange([0, 1], 0.5 + (xgH - xgA) / 4) + (1 - MODEL.XG_BLEND) * seffH;
  const mg = Math.abs(gh - ga);
  const g = mg <= 1 ? 1 : mg === 2 ? 1.5 : mg === 3 ? 1.75 : 1.75 + (mg - 3) / 8; // margin-of-victory weight
  // attack/defence blended values (0.7·xG + 0.3·goals), and a down-weight when xG is absent
  const aH = hasXg ? MODEL.XG_BLEND * xgH + (1 - MODEL.XG_BLEND) * gh : gh;
  const aA = hasXg ? MODEL.XG_BLEND * xgA + (1 - MODEL.XG_BLEND) * ga : ga;
  return { hc, ac, host, seffH, g, att: { h: aH, a: aA }, def: { h: aA, a: aH }, wt: hasXg ? 1 : MODEL.GOALS_ONLY_WT };
}

/**
 * Opponent-adjusted Elo: an online sequential walk, then a strength-of-schedule fixed point.
 * @param {Array} games  output of gameSignal, in chronological order
 * @param {(code:string)=>number} seed  pre-tournament rating for a code
 * @returns {Object<string,number>} code → rating
 */
export function eloRatings(games, seed, o = MODEL) {
  const { K, DRIFT, HOST_ELO_BONUS: HB, SOS_PASSES } = o;
  const clamp = (c, v) => seed(c) + Math.max(-DRIFT, Math.min(DRIFT, v - seed(c)));
  const exp = (rH, rA, host, hc, ac) =>
    1 / (1 + Math.pow(10, -((rH + (host === hc ? HB : 0)) - (rA + (host === ac ? HB : 0))) / 400));
  const ng = {}; for (const x of games) { ng[x.hc] = (ng[x.hc] || 0) + 1; ng[x.ac] = (ng[x.ac] || 0) + 1; }
  // (1) sequential online walk — the established rating, and the FINAL rating for any one-game team
  const E0 = {}, g0 = c => E0[c] ?? seed(c);
  for (const x of games) {
    const d = K * x.g * (x.seffH - exp(g0(x.hc), g0(x.ac), x.host, x.hc, x.ac));
    E0[x.hc] = clamp(x.hc, g0(x.hc) + d); E0[x.ac] = clamp(x.ac, g0(x.ac) - d);
  }
  // (2) strength-of-schedule refinement — re-derive each multi-game team from seed vs opponents' CURRENT ratings
  let R = {}; for (const c in ng) R[c] = E0[c] ?? seed(c);
  for (let pass = 0; pass < SOS_PASSES; pass++) {
    const acc = {};
    for (const x of games) {
      const d = K * x.g * (x.seffH - exp(R[x.hc], R[x.ac], x.host, x.hc, x.ac));
      acc[x.hc] = (acc[x.hc] || 0) + d; acc[x.ac] = (acc[x.ac] || 0) - d;
    }
    const F = {}; for (const c in ng) F[c] = ng[c] < 2 ? (E0[c] ?? seed(c)) : clamp(c, seed(c) + (acc[c] || 0));
    R = F;
  }
  return R;
}

/**
 * Attack/defence "game-character" estimates, opponent-adjusted and shrunk to an Elo-implied prior.
 * @param {Array} games  output of gameSignal, chronological
 * @param {(code:string)=>number} seed
 * @returns {Object<string,{A:number,D:number,n:number}>}  A>1 scores more, D>1 concedes more
 */
export function attackDefenceRatings(games, seed, o = MODEL) {
  const { AD_BETA: beta, AD_PRIOR_MID: mid, AD_PRIOR_SCALE: scale, AD_CLAMP, AD_SHRINK_N } = o;
  const rec = {}; // code → [{att,def,opp,wt}]
  for (const x of games) {
    (rec[x.hc] ??= []).push({ att: x.att.h, def: x.def.h, opp: x.ac, wt: x.wt });
    (rec[x.ac] ??= []).push({ att: x.att.a, def: x.def.a, opp: x.hc, wt: x.wt });
  }
  let sw = 0, sa = 0; for (const c in rec) for (const g of rec[c]) { sw += g.wt; sa += g.att * g.wt; }
  const L = games.length >= 4 && sw ? sa / sw : 1.25; // league mean goals/side; fallback until enough data
  const zOf = c => (seed(c) - mid) / scale;
  const prior = c => ({ A: Math.exp(0.5 * beta * zOf(c)), D: Math.exp(-0.5 * beta * zOf(c) * 0.8) });
  const p1 = {}; // pass 1: raw league-relative, used only as the opponent adjuster
  for (const c in rec) { let aw = 0, as = 0, ds = 0; for (const g of rec[c]) { aw += g.wt; as += g.att * g.wt; ds += g.def * g.wt; } p1[c] = { A: as / aw / L, D: ds / aw / L }; }
  const out = {};
  for (const c in rec) {
    const n = rec[c].length; let A, D;
    if (n >= 2) { // ≥2 opponents → normalise each game by who you faced
      let aw = 0, as = 0, ds = 0;
      for (const g of rec[c]) { aw += g.wt; as += (g.att / L / (p1[g.opp]?.D || 1)) * g.wt; ds += (g.def / L / (p1[g.opp]?.A || 1)) * g.wt; }
      A = as / aw; D = ds / aw;
    } else { A = p1[c].A; D = p1[c].D; }
    A = clampRange(AD_CLAMP, A); D = clampRange(AD_CLAMP, D);
    const pr = prior(c), k = n / (n + AD_SHRINK_N); // James-Stein shrink toward the Elo prior
    out[c] = { A: k * A + (1 - k) * pr.A, D: k * D + (1 - k) * pr.D, n };
  }
  return out;
}

/**
 * Sum the GRID×GRID score matrix into outcome mass + expected goals + per-cell scorelines.
 * Goal counts default to exact Poisson; pass opts.goalDist (e.g. {name:"negbin",alpha}) to swap the
 * distribution without touching anything upstream. (The Dixon-Coles τ is unchanged — with NegBin it's a
 * reasonable low-score nudge but worth re-checking; see goal_dist.mjs.)
 */
export function scoreGrid(lamH, lamA, { live = false, lead = 0, baseH = 0, baseA = 0 } = {}, o = MODEL) {
  const N = o.GRID; let pH = 0, pD = 0, pA = 0, exH = 0, exA = 0; const cells = [];
  const pmf = o.goalDist ? makeGoalDist(o.goalDist) : poisson;
  for (let rh = 0; rh < N; rh++) for (let ra = 0; ra < N; ra++) {
    const p = pmf(rh, lamH) * pmf(ra, lamA) * (live ? 1 : dcTau(rh, ra, lamH, lamA, o.DC_RHO));
    const fin = lead + rh - ra;
    if (fin > 0) pH += p; else if (fin < 0) pA += p; else pD += p;
    cells.push({ h: baseH + rh, a: baseA + ra, p });
    exH += (baseH + rh) * p; exA += (baseA + ra) * p;
  }
  const tot = pH + pD + pA || 1;
  return { pH, pD, pA, exH, exA, cells, tot };
}

/**
 * Full match forecast. All strength/context inputs are explicit primitives so the function stays pure.
 * @param {Object} p
 *   eloH, eloA      SoS-adjusted ratings of home/away
 *   seedH, seedA    pre-tournament seeds (for the "in form here" reason only)
 *   ko              knockout tie?
 *   ad              { adH:{A,D,n}, adA:{A,D,n} } or null
 *   ftCount         finished matches so far (drives the overlay trust ramp)
 *   playedH,playedA games each side has played (drives early-tournament shrink)
 *   host            'H' | 'A' | null  (which side is the host)
 *   hostCity        optional string for the reason text
 *   names           { h, a } display names for reasons
 *   stake           optional { lamMult, draw:{mode,w}, reason } group qualification stake
 *   live, remFrac, lead, baseH, baseA, reds:{h,a}   live-match state (omit for pre-match)
 * @returns {{h,d,a,live,ko,adv,predicted,drawMode,xg,lambdas,reasons}}
 */
export function matchProbabilities(p, o = MODEL) {
  const live = !!p.live;
  const nm = side => (side === 'H' ? p.names?.h : p.names?.a) || side;
  const mu = p.ko ? o.MU_KO : o.MU_GROUP;
  const supR = Math.max(-o.SUP_CLAMP, Math.min(o.SUP_CLAMP, (p.eloH - p.eloA) / o.SUP_DIV));
  const lamH0 = mu + supR / 2, lamA0 = mu - supR / 2;
  let lamH = lamH0, lamA = lamA0; const reasons = [];
  if (p.ko) reasons.push({ key: 'ko', dir: 'N', mag: 0.08, text: 'Knockout tie, played tighter' });

  // attack/defence overlay — dormant until BOTH sides have ≥2 games and the global ramp opens
  const adH = p.ad?.adH, adA = p.ad?.adA;
  const adW = o.AD_TRUST_MAX * Math.min(1, (p.ftCount || 0) / o.AD_TRUST_RAMP);
  if (adW > 0 && adH && adA && adH.n >= o.AD_MIN_GAMES && adA.n >= o.AD_MIN_GAMES) {
    const mH = clampRange(o.AD_MULT_CLAMP, adH.A * adA.D), mA = clampRange(o.AD_MULT_CLAMP, adA.A * adH.D);
    lamH *= Math.pow(mH, adW); lamA *= Math.pow(mA, adW);
    const T = lamH + lamA, lnR = o.AD_SKEW_KEEP * Math.log(lamH0 / lamA0) + (1 - o.AD_SKEW_KEEP) * Math.log(lamH / lamA);
    lamH = T / (1 + Math.exp(-lnR)); lamA = T - lamH; // skew-lock: Elo keeps ≥75% of who-wins, AD owns the total
    if (adH.D > 1.08 && adA.D > 1.08) reasons.push({ key: 'matchup', dir: 'N', mag: 0.06, text: 'Two leaky defences, goals likely' });
    else if (adH.D < 0.92 && adA.D < 0.92) reasons.push({ key: 'matchup', dir: 'N', mag: 0.06, text: 'Two tight defences, low and tight' });
  }

  // surface only the in-tournament FORM the SoS-Elo added on top of the seed (the raw gap is intentionally silent)
  const seedGap = ((p.seedH ?? p.eloH) - (p.seedA ?? p.eloA)) / o.SUP_DIV;
  const formGap = (p.eloH - p.eloA) / o.SUP_DIV - seedGap;
  if (Math.abs(formGap) >= 0.06) reasons.push({ key: 'form', dir: formGap >= 0 ? 'H' : 'A', mag: Math.abs(formGap), text: `${nm(formGap >= 0 ? 'H' : 'A')} in form here` });

  if (p.stake) { lamH *= p.stake.lamMult; lamA *= p.stake.lamMult; if (p.stake.reason) reasons.push(p.stake.reason); }

  if (p.host === 'H' || p.host === 'A') {
    const hs = p.host === 'H';
    lamH *= Math.exp(hs ? o.HOST_LAM_FOR : o.HOST_LAM_AGAINST);
    lamA *= Math.exp(hs ? o.HOST_LAM_AGAINST : o.HOST_LAM_FOR);
    reasons.push({ key: 'host', dir: hs ? 'H' : 'A', mag: 0.19, text: `Host edge${p.hostCity ? ` in ${p.hostCity}` : ''}` });
  }

  const remFrac = live ? Math.max(0.02, p.remFrac ?? 1) : 1;
  lamH *= remFrac; lamA *= remFrac;
  if (live && p.reds) {
    const f = remFrac, reds = p.reds;
    if (reds.h) { lamH *= Math.pow(1 - o.RED_DOWN * f, reds.h); lamA *= Math.pow(1 + o.RED_UP * f, reds.h); }
    if (reds.a) { lamA *= Math.pow(1 - o.RED_DOWN * f, reds.a); lamH *= Math.pow(1 + o.RED_UP * f, reds.a); }
    if (reds.h !== reds.a) { const downH = reds.h > reds.a; reasons.push({ key: 'redcard', dir: downH ? 'A' : 'H', mag: 0.6 * f + 0.2, dot: true, text: `${nm(downH ? 'H' : 'A')} down to 10` }); }
  }
  lamH = Math.max(o.LAM_FLOOR, lamH); lamA = Math.max(o.LAM_FLOOR, lamA);

  const lead = live && p.lead != null ? p.lead : 0, baseH = live ? (p.baseH || 0) : 0, baseA = live ? (p.baseA || 0) : 0;
  const grid = scoreGrid(lamH, lamA, { live, lead, baseH, baseA }, o);
  let probH = grid.pH / grid.tot, probD = grid.pD / grid.tot, probA = grid.pA / grid.tot;

  if (!live) { // early-tournament draw-aware shrink, decays as teams play more
    const sh = o.SHRINK_MAX * Math.max(0, 1 - ((p.playedH || 0) + (p.playedA || 0)) / o.SHRINK_GAMES);
    if (sh > 0) {
      probH = (1 - sh) * probH + sh * o.SHRINK_BASE.h;
      probD = (1 - sh) * probD + sh * o.SHRINK_BASE.d;
      probA = (1 - sh) * probA + sh * o.SHRINK_BASE.a;
    }
  }
  if (p.stake?.draw) { // reshape the draw to the qualification incentive, refill home/away proportionally
    const d = p.stake.draw;
    const newD = d.mode === 'boost' ? Math.min(0.55, probD + d.w * (0.50 - probD)) : probD * d.w;
    const oldRest = probH + probA || 1, rest = 1 - newD;
    probH = probH / oldRest * rest; probA = probA / oldRest * rest; probD = newD;
  }

  const predicted = grid.cells.slice().sort((x, y) => y.p - x.p).slice(0, 3).map(c => ({ h: c.h, a: c.a, p: c.p / grid.tot }));
  return {
    h: probH, d: probD, a: probA, live, ko: !!p.ko,
    adv: p.ko ? { h: probH + 0.5 * probD, a: probA + 0.5 * probD } : null, // KO: a 90' draw → ET/pens, split 50/50
    predicted, drawMode: predicted[0] && predicted[0].h === predicted[0].a,
    xg: { h: grid.exH / grid.tot, a: grid.exA / grid.tot }, lambdas: { h: lamH, a: lamA },
    reasons: reasons.sort((x, y) => y.mag - x.mag).slice(0, 3),
  };
}
