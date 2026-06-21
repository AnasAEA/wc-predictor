/* One-off snapshot of the full FIFA / Coca-Cola Men's World Ranking → data/fifa-ranking.json
 *
 * The live FIFA ranking is frozen during the tournament (the next update publishes after the final), so a static
 * commit is correct and robust — no Action, no runtime cost. Re-run to refresh:  node scripts/make-fifa-ranking.mjs [dateId]
 * Source: inside.fifa.com/api/ranking-overview (keyless) for the table; api.fifa.com/api/v3/teams/{id} for confederation.
 */
import { readFileSync, writeFileSync } from "fs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const j = u => fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json" } }).then(r => r.json());
const DATE = process.argv[2] || "id14870";

const teams = JSON.parse(readFileSync("data/teams.json", "utf8"));
const norm = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
// FIFA's display names vs ours
const ALIAS = {
  korearepublic: "southkorea", iriran: "iran", usa: "unitedstates", turkiye: "turkey",
  capeverdeislands: "caboverde", capeverde: "caboverde", chinapr: "china", curacao: "curacao",
  cotedivoire: "cotedivoire", bosniaandherzegovina: "bosniaherzegovina", congodr: "drcongo",
};
const byName = {}; for (const c in teams) byName[norm(teams[c].name)] = c;
const ourCode = name => { const n = norm(name); return byName[n] || byName[ALIAS[n]] || null; };

const r = await j(`https://inside.fifa.com/api/ranking-overview?locale=en&dateId=${DATE}`);
const items = r.rankings.map(x => x.rankingItem);
const rankingDate = (r.rankings[0]?.lastUpdateDate || "").slice(0, 10);   // the ranking's real publication date (NOT our download date)
console.log("ranking rows:", items.length, "| published:", rankingDate || "(unknown)", "| next update:", r.rankings[0]?.nextUpdateDate || "none (latest)");
// confederations — parallel batches of 12
const conf = {};
for (let i = 0; i < items.length; i += 12)
  await Promise.all(items.slice(i, i + 12).map(it => j(`https://api.fifa.com/api/v3/teams/${it.idTeam}?language=en`).then(d => { conf[it.idTeam] = d.IdConfederation || null; }).catch(() => {})));

const out = items.map(it => {
  const q = ourCode(it.name);
  return { r: it.rank, name: it.name, code: it.countryCode, conf: conf[it.idTeam] || null, pts: Math.round(it.totalPoints), flag: it.flag?.src || null, ...(q ? { q } : {}) };
});
const matchedQ = new Set(out.filter(t => t.q).map(t => t.q));
console.log("qualifiers matched:", matchedQ.size, "/ 48");
const missing = Object.keys(teams).filter(c => !matchedQ.has(c)).map(c => `${c}=${teams[c].name}`);
if (missing.length) { console.log("UNMATCHED qualifiers (need an alias):", missing); process.exit(1); }
const noConf = out.filter(t => !t.conf).length;
console.log("rows missing confederation:", noConf);
writeFileSync("data/fifa-ranking.json", JSON.stringify({ updated: new Date().toISOString(), dateId: DATE, rankingDate, teams: out }));
console.log("wrote data/fifa-ranking.json", JSON.stringify(out[0]), "…", JSON.stringify(out.at(-1)));
