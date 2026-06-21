/**
 * Fetches all 48 World Cup squads from API-Football (free tier) → data/squads.json.
 * Run manually via the "Update squads" workflow. Requires env API_FOOTBALL_KEY.
 * Uses ~49 of the 100 free daily requests. Merges over the seeded file:
 * keeps caps/goals/club/coach where the API doesn't provide them.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error("Missing API_FOOTBALL_KEY"); process.exit(1); }

const teams = JSON.parse(readFileSync("data/teams.json", "utf8"));
const prev = existsSync("data/squads.json")
  ? JSON.parse(readFileSync("data/squads.json", "utf8")) : { squads: {} };

const ALIAS = {};
for (const [code, t] of Object.entries(teams)) ALIAS[norm(t.name)] = code;
Object.assign(ALIAS, {
  [norm("United States")]: "US", [norm("USA")]: "US",
  [norm("Korea Republic")]: "KR", [norm("South Korea")]: "KR",
  [norm("Czechia")]: "CZ", [norm("Czech Republic")]: "CZ",
  [norm("Türkiye")]: "TR", [norm("Turkey")]: "TR",
  [norm("Côte d'Ivoire")]: "CI", [norm("Ivory Coast")]: "CI",
  [norm("Cabo Verde")]: "CV", [norm("Cape Verde Islands")]: "CV", [norm("Cape Verde")]: "CV",
  [norm("Bosnia and Herzegovina")]: "BA", [norm("Bosnia & Herzegovina")]: "BA",
  [norm("DR Congo")]: "CD", [norm("Congo DR")]: "CD",
  [norm("IR Iran")]: "IR", [norm("England")]: "GB-ENG", [norm("Scotland")]: "GB-SCT",
});
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
}
const POS = { Goalkeeper: "GK", Defender: "DF", Midfielder: "MF", Attacker: "FW" };
const api = async path => {
  const r = await fetch("https://v3.football.api-sports.io" + path, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) throw new Error(`API ${r.status} on ${path}`);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error(JSON.stringify(j.errors));
  return j.response;
};

const apiTeams = await api("/teams?league=1&season=2026");
console.log(`API returned ${apiTeams.length} teams`);
const out = { updated: new Date().toISOString(), note: "Squads via API-Football; seeded stats preserved where available", squads: { ...prev.squads } };

let done = 0;
for (const t of apiTeams) {
  const code = ALIAS[norm(t.team?.name)];
  if (!code) { console.warn("No code match for", t.team?.name); continue; }
  try {
    const sq = await api(`/players/squads?team=${t.team.id}`);
    const players = (sq[0]?.players || []).map(p => {
      // preserve caps/goals/club from the seeded official lists when names match
      const old = prev.squads?.[code]?.players?.find(x => norm(x.name).includes(norm(p.name).slice(0, 8)) || norm(p.name).includes(norm(x.name).slice(0, 8)));
      return {
        ...(p.number != null ? { n: p.number } : {}),
        pos: POS[p.position] || "MF",
        name: old?.name || p.name,
        ...(old?.caps != null ? { caps: old.caps, goals: old.goals } : {}),
        ...(old?.club ? { club: old.club } : {}),
        ...(p.photo ? { photo: p.photo } : {}),
      };
    });
    if (players.length >= 20) {
      out.squads[code] = { coach: prev.squads?.[code]?.coach || null, players };
      done++;
    } else if (prev.squads?.[code]) {
      // API squad too thin to replace the hand-seeded list — but still backfill headshots onto it by name match
      const apiPlayers = sq[0]?.players || [];
      let added = 0;
      const seeded = prev.squads[code].players.map(x => {
        if (x.photo) return x;
        const m = apiPlayers.find(p => p.photo && (norm(p.name).includes(norm(x.name).slice(0, 8)) || norm(x.name).includes(norm(p.name).slice(0, 8))));
        if (m) { added++; return { ...x, photo: m.photo }; }
        return x;
      });
      out.squads[code] = { ...prev.squads[code], players: seeded };
      console.log(`API squad thin for ${code}; kept seeded list${added ? ` + ${added} photos` : ""}`);
    }
  } catch (e) { console.warn("squad fetch failed", code, e.message); }
  await new Promise(r => setTimeout(r, 250)); // stay friendly to rate limits
}

writeFileSync("data/squads.json", JSON.stringify(out));
console.log(`Wrote squads.json — ${done} squads refreshed, ${Object.keys(out.squads).length} total`);
