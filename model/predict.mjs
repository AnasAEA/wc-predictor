/**
 * model/predict.mjs — live predictor: build current team ratings from all FINISHED matches, then
 * forecast any (upcoming) fixture. Pure — all data is passed in, nothing is read from disk or the DOM.
 *
 * This is the prediction path the shadow logger uses, and the same one app.js could eventually call so
 * the site and the betting layer share one set of numbers. It mirrors the glue in scripts/backtest.mjs
 * (which uses a leave-prior subset); here we always use every finished match.
 */
import { gameSignal, eloRatings, attackDefenceRatings, matchProbabilities } from "./core.mjs";
import { allMarkets, scoreDistribution } from "./markets.mjs";

const HOST_OF = { USA: "US", Mexico: "MX", Canada: "CA" };
const hostOf = m => HOST_OF[(m.city || "").split(", ").pop()] || null;

/**
 * @param {Object} data { teams, fixtures, results, efi }
 *   teams    code → { name, elo, ... }
 *   fixtures array of match objects (with id, num, utc, stage, city, home.team, away.team)
 *   results  matchId → { st, h, a, ... }
 *   efi      matchNum → { home, xg:[..], ... }
 * @returns {{ ratings, ad, ftCount, seed, played, predict }}
 */
export function buildState({ teams, fixtures, results, efi = {} }) {
  const seed = c => teams[c]?.elo || 1700;
  const finished = fixtures
    .filter(m => { const r = results[m.id]; return r && r.st === "FT" && r.h != null && m.home?.team && m.away?.team; })
    .sort((a, b) => a.utc.localeCompare(b.utc));
  const plays = finished.map(m => {
    const hc = m.home.team, ac = m.away.team, r = results[m.id], ef = efi[m.num];
    const play = { hc, ac, gh: r.h, ga: r.a, host: hostOf(m) };
    if (ef?.xg) { play.xgH = ef.home === hc ? ef.xg[0] : ef.xg[1]; play.xgA = ef.home === hc ? ef.xg[1] : ef.xg[0]; }
    return play;
  });
  const games = plays.map(gameSignal);
  const ratings = eloRatings(games, seed);
  const ad = attackDefenceRatings(games, seed);
  const playedCount = c => plays.reduce((n, x) => n + (x.hc === c || x.ac === c ? 1 : 0), 0);

  /** Forecast one fixture → { wp, lambdas, cells (score dist), markets }. null if teams unknown. */
  function predict(m) {
    const hc = m.home?.team, ac = m.away?.team; if (!hc || !ac) return null;
    const host = hostOf(m), side = host === hc ? "H" : host === ac ? "A" : null;
    const wp = matchProbabilities({
      eloH: ratings[hc] ?? seed(hc), eloA: ratings[ac] ?? seed(ac), seedH: seed(hc), seedA: seed(ac),
      ko: m.stage !== "group", ad: { adH: ad[hc], adA: ad[ac] }, ftCount: finished.length,
      playedH: playedCount(hc), playedA: playedCount(ac), host: side, hostCity: (m.city || "").split(",")[0],
      names: { h: teams[hc]?.name || hc, a: teams[ac]?.name || ac },
    });
    const cells = scoreDistribution(wp.lambdas.h, wp.lambdas.a);
    const markets = allMarkets(wp.lambdas.h, wp.lambdas.a);
    return { wp, lambdas: wp.lambdas, cells, markets };
  }

  return { ratings, ad, seed, ftCount: finished.length, played: playedCount, predict };
}
