/**
 * Leave-prior backtest of the win-probability model — now driven by the SHARED model/core.mjs
 * (so the backtest and the site can never disagree on the math). For each finished match it rebuilds
 * ratings + attack/defence from ONLY the earlier results, predicts, then scores vs reality.
 *
 * Unlike the old backtest, this runs the FULL production pipeline (Elo + SoS + attack/defence overlay
 * + host + early shrink), and reports calibration (reliability bins + ECE) alongside accuracy/Brier/LL.
 *
 *   node scripts/backtest.mjs
 *
 * Two datasets:
 *   1. WC2026 (data/*.json) — the live tournament, with real FIFA xG seeded from teams.json Elo.
 *   2. WC2022 (data/wc2022.json) — 64 finished matches as an ENGINE / CALIBRATION check only:
 *      we have no genuine Nov-2022 Elo, so every team starts FLAT (1700) and strength is learned purely
 *      from in-tournament results. This is NOT a fair test of predictive power (no team-quality prior);
 *      it stresses the SoS propagation + draw modelling on a fully-connected 64-match graph that the
 *      2026 group stage (disjoint single edges) cannot yet reach. Real 2022 validation needs real seeds.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gameSignal, eloRatings, attackDefenceRatings, matchProbabilities, MODEL } from "../model/core.mjs";
import { dispersionIndex, fitDispersion } from "../model/goal_dist.mjs";

const J = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const HOST_OF = { USA: "US", Mexico: "MX", Canada: "CA" };
const hostOf2026 = m => HOST_OF[(m.city || "").split(", ").pop()] || null;

// ---- normalise each dataset to a flat, chronological list of plays -------------------------------
// play := { hc, ac, host(code|null), ko, gh, ga, xgH?, xgA?, nameH, nameA }
function load2026() {
  const teams = J("data/teams.json"); const teamsT = teams.teams || teams;
  const fixtures = J("data/matches.json").matches;
  const results = J("data/results.json").matches;
  const efi = J("data/efi.json").matches || {};
  const plays = fixtures
    .filter(m => { const r = results[m.id]; return r && r.st === "FT" && r.h != null && m.home?.team && m.away?.team; })
    .sort((a, b) => a.utc.localeCompare(b.utc))
    .map(m => {
      const hc = m.home.team, ac = m.away.team, r = results[m.id], ef = efi[m.num];
      const play = { hc, ac, host: hostOf2026(m), ko: m.stage !== "group", gh: r.h, ga: r.a,
        nameH: teamsT[hc]?.name || hc, nameA: teamsT[ac]?.name || ac };
      if (ef?.xg) { play.xgH = ef.home === hc ? ef.xg[0] : ef.xg[1]; play.xgA = ef.home === hc ? ef.xg[1] : ef.xg[0]; }
      return play;
    });
  return { label: "WC2026 (real seeds + FIFA xG)", plays, seed: c => teamsT[c]?.elo || 1700, fair: true };
}

function load2022() {
  const d = J("data/wc2022.json");
  const GROUPS = new Set("ABCDEFGH".split(""));
  const plays = d.matches.map(m => ({
    hc: m.a, ac: m.b, host: "QA", ko: !GROUPS.has(m.st), gh: m.s[0], ga: m.s[1],
    nameH: d.names[m.a] || m.a, nameA: d.names[m.b] || m.b,
  }));
  const FLAT = 1700;
  return { label: "WC2022 (FLAT 1700 seeds — engine/calibration check, NOT predictive)", plays, seed: () => FLAT, fair: false };
}

// ---- leave-prior loop: predict each match from strictly-earlier matches only ----------------------
// `opts` (default MODEL) is threaded into the core so we can sweep parameters (K, ρ, μ…) for diagnostics.
function backtest({ plays, seed }, opts = MODEL) {
  let brier = 0, ll = 0, corr = 0, exact = 0, sumP = 0;
  const points = []; // {p, hit} over all H/D/A classes, for calibration
  const goalSamples = []; // {mean:λ, k:goals} per side, for dispersion fitting
  for (let i = 0; i < plays.length; i++) {
    const m = plays[i], prior = plays.slice(0, i);
    const games = prior.map(gameSignal);
    const ratings = eloRatings(games, seed, opts);
    const ad = attackDefenceRatings(games, seed, opts);
    const rate = c => ratings[c] ?? seed(c);
    const teamSide = (host, hc, ac) => host === hc ? "H" : host === ac ? "A" : null;
    const playedH = prior.filter(x => x.hc === m.hc || x.ac === m.hc).length;
    const playedA = prior.filter(x => x.hc === m.ac || x.ac === m.ac).length;
    const wp = matchProbabilities({
      eloH: rate(m.hc), eloA: rate(m.ac), seedH: seed(m.hc), seedA: seed(m.ac), ko: m.ko,
      ad: { adH: ad[m.hc], adA: ad[m.ac] }, ftCount: i, playedH, playedA,
      host: teamSide(m.host, m.hc, m.ac), names: { h: m.nameH, a: m.nameA },
    }, opts);
    const act = m.gh > m.ga ? "H" : m.gh < m.ga ? "A" : "D";
    const pAct = act === "H" ? wp.h : act === "A" ? wp.a : wp.d;
    sumP += pAct; ll += -Math.log(Math.max(1e-9, pAct));
    brier += (wp.h - (act === "H")) ** 2 + (wp.d - (act === "D")) ** 2 + (wp.a - (act === "A")) ** 2;
    const pred = wp.h >= wp.d && wp.h >= wp.a ? "H" : wp.a >= wp.d ? "A" : "D";
    if (pred === act) corr++;
    const top = wp.predicted[0]; if (top && top.h === m.gh && top.a === m.ga) exact++;
    points.push({ p: wp.h, hit: act === "H" }, { p: wp.d, hit: act === "D" }, { p: wp.a, hit: act === "A" });
    goalSamples.push({ mean: wp.lambdas.h, k: m.gh }, { mean: wp.lambdas.a, k: m.ga });
  }
  const n = plays.length;
  return { n, acc: corr / n, meanP: sumP / n, brier: brier / n, ll: ll / n, exact, points, goalSamples };
}

// ---- calibration: 10 reliability bins + expected calibration error --------------------------------
function calibration(points, bins = 10) {
  const B = Array.from({ length: bins }, () => ({ sp: 0, sh: 0, n: 0 }));
  for (const { p, hit } of points) { const i = Math.min(bins - 1, Math.floor(p * bins)); B[i].n++; B[i].sp += p; B[i].sh += hit ? 1 : 0; }
  let ece = 0; const N = points.length;
  const rows = B.map((b, i) => { const pred = b.n ? b.sp / b.n : 0, obs = b.n ? b.sh / b.n : 0; ece += b.n / N * Math.abs(obs - pred); return { lo: i / bins, pred, obs, n: b.n }; });
  return { ece, rows };
}

const pct = x => (x * 100).toFixed(1) + "%";
function report(ds) {
  const r = backtest(ds);
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`${ds.label}   (${r.n} finished matches)`);
  console.log(`  Outcome accuracy (W/D/A):  ${pct(r.acc)}        (33.3% = random)`);
  console.log(`  Mean prob on actual:       ${pct(r.meanP)}        (33.3% = random)`);
  console.log(`  Brier score:               ${r.brier.toFixed(3)}        (0.667 = random, lower better)`);
  console.log(`  Log-loss:                  ${r.ll.toFixed(3)}        (1.099 = random, lower better)`);
  console.log(`  Exact scoreline hits:      ${r.exact}/${r.n}`);
  const cal = calibration(r.points);
  console.log(`  Calibration (ECE):         ${pct(cal.ece)}        (0% = perfectly calibrated, lower better)`);
  console.log(`  Reliability  pred→obs :    ` + cal.rows.filter(x => x.n).map(x => `${Math.round(x.pred * 100)}→${Math.round(x.obs * 100)}(${x.n})`).join("  "));
  if (!ds.fair) console.log(`  ⚠  flat-seed engine check — not a measure of real predictive power (see header).`);
  return r;
}

// Goal-distribution diagnostic + A/B: is the mean-shift a μ problem or overdispersion? Which dist predicts best?
function goalStudy(ds) {
  console.log(`\n══════════ GOAL DISTRIBUTION STUDY · ${ds.label} ══════════`);
  const base = backtest(ds);
  // 1) empirical dispersion of observed goals-per-team vs the model's average λ (mean-shift check)
  const obs = base.goalSamples.map(s => s.k), di = dispersionIndex(obs);
  const meanLam = base.goalSamples.reduce((s, x) => s + x.mean, 0) / base.goalSamples.length;
  console.log(`  goals/side: actual mean ${di.mean.toFixed(3)}, var ${di.var.toFixed(3)}, dispersion Var/Mean ${di.ratio.toFixed(3)} (1.0=Poisson)`);
  console.log(`  model mean λ ${meanLam.toFixed(3)}  →  mean-shift ${(meanLam - di.mean >= 0 ? "+" : "")}${(meanLam - di.mean).toFixed(3)} per side`);
  // 2) MLE-fit the dispersion α on (λ, goals)
  const fit = fitDispersion(base.goalSamples);
  console.log(`  fitted NegBin α ${fit.alpha.toFixed(3)}  ·  logLik NB ${fit.llNB.toFixed(1)} vs Poisson ${fit.llPois.toFixed(1)}  ·  ${fit.improved ? "NegBin fits better" : "Poisson fine"}`);
  // 3) A/B the three candidates on outcome + calibration
  const muUp = meanLam > 0 ? MODEL.MU_GROUP * (di.mean / meanLam) : MODEL.MU_GROUP; // μ rescaled to kill the mean-shift
  const variants = {
    "Poisson (current)": MODEL,
    [`Poisson μ→${muUp.toFixed(2)}`]: { ...MODEL, MU_GROUP: muUp, MU_KO: MODEL.MU_KO * (muUp / MODEL.MU_GROUP) },
    [`NegBin α=${fit.alpha.toFixed(2)}`]: { ...MODEL, goalDist: { name: "negbin", alpha: fit.alpha } },
  };
  console.log(`  A/B:                          acc     Brier   LogLoss  ECE`);
  for (const [name, opt] of Object.entries(variants)) {
    const r = backtest(ds, opt), c = calibration(r.points);
    console.log(`     ${name.padEnd(22)}  ${(r.acc * 100).toFixed(1)}%   ${r.brier.toFixed(3)}   ${r.ll.toFixed(3)}    ${(c.ece * 100).toFixed(1)}%`);
  }
}

function main() {
  console.log(`WC·26 model backtest — shared core (model/core.mjs)  ·  DC_RHO=${MODEL.DC_RHO}, K=${MODEL.K}, μ=${MODEL.MU_GROUP}`);
  report(load2026());
  report(load2022());
  goalStudy(load2026());
  goalStudy(load2022());
  console.log("");
}

// run only when invoked directly (so tests can import the functions)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

export { load2026, load2022, backtest, calibration };
