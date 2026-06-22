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
function backtest({ plays, seed }) {
  let brier = 0, ll = 0, corr = 0, exact = 0, sumP = 0;
  const points = []; // {p, hit} over all H/D/A classes, for calibration
  for (let i = 0; i < plays.length; i++) {
    const m = plays[i], prior = plays.slice(0, i);
    const games = prior.map(gameSignal);
    const ratings = eloRatings(games, seed);
    const ad = attackDefenceRatings(games, seed);
    const rate = c => ratings[c] ?? seed(c);
    const teamSide = (host, hc, ac) => host === hc ? "H" : host === ac ? "A" : null;
    const playedH = prior.filter(x => x.hc === m.hc || x.ac === m.hc).length;
    const playedA = prior.filter(x => x.hc === m.ac || x.ac === m.ac).length;
    const wp = matchProbabilities({
      eloH: rate(m.hc), eloA: rate(m.ac), seedH: seed(m.hc), seedA: seed(m.ac), ko: m.ko,
      ad: { adH: ad[m.hc], adA: ad[m.ac] }, ftCount: i, playedH, playedA,
      host: teamSide(m.host, m.hc, m.ac), names: { h: m.nameH, a: m.nameA },
    });
    const act = m.gh > m.ga ? "H" : m.gh < m.ga ? "A" : "D";
    const pAct = act === "H" ? wp.h : act === "A" ? wp.a : wp.d;
    sumP += pAct; ll += -Math.log(Math.max(1e-9, pAct));
    brier += (wp.h - (act === "H")) ** 2 + (wp.d - (act === "D")) ** 2 + (wp.a - (act === "A")) ** 2;
    const pred = wp.h >= wp.d && wp.h >= wp.a ? "H" : wp.a >= wp.d ? "A" : "D";
    if (pred === act) corr++;
    const top = wp.predicted[0]; if (top && top.h === m.gh && top.a === m.ga) exact++;
    points.push({ p: wp.h, hit: act === "H" }, { p: wp.d, hit: act === "D" }, { p: wp.a, hit: act === "A" });
  }
  const n = plays.length;
  return { n, acc: corr / n, meanP: sumP / n, brier: brier / n, ll: ll / n, exact, points };
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

function main() {
  console.log(`WC·26 model backtest — shared core (model/core.mjs)  ·  DC_RHO=${MODEL.DC_RHO}, K=${MODEL.K}, μ=${MODEL.MU_GROUP}`);
  report(load2026());
  report(load2022());
  console.log("");
}

// run only when invoked directly (so tests can import the functions)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

export { load2026, load2022, backtest, calibration };
