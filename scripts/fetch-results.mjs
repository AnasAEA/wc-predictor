/**
 * Writes data/results.json for the WC·26 site. Runs in GitHub Actions, Node 20+, no deps.
 *
 * Source chain (first that succeeds wins):
 *   1. PRIMARY  api.fifa.com/api/v3  — free, no key, authoritative. Live score + minute,
 *              and (per in-play / just-finished match) a structured event timeline
 *              (goals / cards / subs with minute + player) + lineups. CORS-enabled, but we
 *              still fetch server-side so a vanished endpoint never breaks a visitor's page.
 *   2. FALLBACK worldcup26.ir       — free, no key. Live score + minute only (no events).
 *   3. FALLBACK football-data.org   — needs FOOTBALL_DATA_TOKEN. Reliable at full-time.
 *
 * Match mapping: FIFA's `MatchNumber` is NOT chronological and does NOT equal our openfootball `num`
 * (FIFA #8 == our m5), so we join feed rows to fixtures by their TEAMS, never by number. FIFA team codes
 * are 3-letter (MEX/RSA/QAT); we learn the 3-letter→our-code map by matching team NAMES against teams.json
 * (44/48 auto; 4 aliases), then pair each row to the fixture with that team pair (knockouts: by kickoff slot).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("data/matches.json", "utf8")).matches;
const teams = JSON.parse(readFileSync("data/teams.json", "utf8"));
const byNum = Object.fromEntries(fixtures.map(f => [f.num, f]));

const UA = "Mozilla/5.0 (compatible; wc26-bot/1.0; +https://github.com/lavyagarg240294/wc26)";
const loc = v => Array.isArray(v) ? (v[0]?.Description || "") : (typeof v === "string" ? v : "");
// "90'+8'" -> 90.08 (sort key that keeps stoppage time after the base minute)
const minKey = s => { const m = String(s || "").match(/(\d+)(?:'?\+(\d+))?/); return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0) : 0; };

/* ---------------- primary: api.fifa.com ---------------- */
const FIFA = "https://api.fifa.com/api/v3";
const COMP = "17", SEASON = "285023";       // FIFA World Cup 2026™
const LIVE_FETCH_CAP = 14;                  // max per-match live calls per run (spreads a cold start)

async function fifaGet(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`FIFA HTTP ${r.status}`);
  return r.json();
}

// official player photos harvested from FIFA lineups → data/photos.json, keyed "ShortName|CODE"
const harvestedPhotos = {};
// player vitals from the FIFA squad endpoint → data/playerbio.json, keyed the same way: { d:DOB, h:cm, w:kg }
const harvestedBio = {};
function harvestPhotos(team, code) {
  if (!team || !code) return;
  for (const p of (team.Players || [])) {
    const url = p.PlayerPicture?.PictureUrl, nm = loc(p.ShortName) || loc(p.PlayerName);
    if (url && nm) harvestedPhotos[nm + "|" + code] = url;
  }
}
// FIFA's per-team squad endpoint carries official headshots for EVERY player pre-tournament (no key, no waiting
// for a team to play). Backfill teams whose coverage is INCOMPLETE (not just empty) — keyed by BOTH full and short
// name so roster taps (squad names) and timeline taps (feed names) both resolve. `teamIdByCode` is learned in
// fromFifa from the calendar. NB: targeting "incomplete" (not "no photos") is what stops a team like Portugal, which
// had a couple of names leak in from a feed but never played, from staying stuck at a handful of the 26 forever.
const teamIdByCode = {};
const SQUAD_PHOTO_CAP = 24;
async function harvestSquad(needsSquad) {   // one squad fetch backfills BOTH photos and vitals (DOB/height/weight)
  const todo = Object.keys(teamIdByCode).filter(needsSquad);
  let teams = 0;
  for (const code of todo) {
    if (teams >= SQUAD_PHOTO_CAP) break;
    try {
      const sq = await fifaGet(`${FIFA}/teams/${teamIdByCode[code]}/squad?idCompetition=${COMP}&idSeason=${SEASON}&language=en`);
      let added = 0;
      for (const p of (sq.Players || [])) {
        const url = p.PlayerPicture?.PictureUrl;
        const d = (p.BirthDate || "").slice(0, 10), h = +p.Height || 0, w = +p.Weight || 0;
        const bio = (d || h || w) ? { ...(d ? { d } : {}), ...(h ? { h } : {}), ...(w ? { w } : {}) } : null;
        for (const nm of [loc(p.PlayerName), loc(p.ShortName)]) {
          if (!nm) continue;
          if (url) harvestedPhotos[nm + "|" + code] = url;
          if (bio) harvestedBio[nm + "|" + code] = bio;
        }
        if (url || bio) added++;
      }
      if (added) teams++;
    } catch { /* skip this team this run */ }
  }
  if (teams) console.log(`FIFA squad: backfilled photos/vitals for ${teams} team(s)`);
}

// credited match reports (→ data/reports.json) + live commentary (→ data/commentary/<num>.json), both harvested
// from ESPN's free summary feed (the same call we already make for stats). Keyed by our openfootball match number.
const harvestedReports = {}, harvestedCommentary = {};
const stripHtml = s => String(s || "")
  .replace(/<photo[^>]*>[\s\S]*?<\/photo>/gi, "").replace(/<photo[^>]*\/?>/gi, "")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&#?[a-z0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
// ESPN summary.article → {hl, rep:[paragraphs], by, src, url}. Articles publish a little after FT, so a finished
// match is re-polled (within a 2-day window) until one lands; null until then.
function parseArticle(sum) {
  const a = sum.article;
  if (!a || !a.story) return null;
  const paras = String(a.story).split(/<\/p>/i).map(stripHtml).filter(p => p && p.length > 4).slice(0, 6);
  if (!paras.length) return null;
  return {
    hl: stripHtml(a.headline) || undefined,
    rep: paras,
    by: (a.byline || a.source || "").trim() || undefined,
    src: "ESPN",
    url: a.links?.web?.href || a.links?.mobile?.href || undefined,
  };
}
// ESPN summary.commentary[] (chronological) → latest-first [{t,x,k?}] with a light goal/card/sub tag
function parseCommentary(sum) {
  const c = sum.commentary;
  if (!Array.isArray(c) || !c.length) return null;
  const items = c.map(x => {
    const txt = (x.text || "").trim();
    if (!txt) return null;
    const low = ((x.play?.type?.text || "") + " " + txt).toLowerCase();
    let k;
    if (/\bgoal\b/.test(low) && !/disallow|no goal|own goal chance|nearly|almost/.test(low)) k = "goal";
    else if (/red card|sent off/.test(low)) k = "red";
    else if (/yellow card|booked|caution/.test(low)) k = "yellow";
    else if (/substitution|subbed/.test(low)) k = "sub";
    return { t: x.time?.displayValue || "", x: txt, ...(k ? { k } : {}) };
  }).filter(Boolean).reverse();
  if (!items.length) return null;
  const url = (sum.header?.links || []).find(l => (l.rel || []).includes("summary") || (l.rel || []).includes("desktop"))?.href;
  return { src: "ESPN", url: url || undefined, items };
}
// Build the goals/cards/subs timeline (+ basic lineups) from a FIFA live-match object.
function buildEvents(lv) {
  const sides = [["h", lv.HomeTeam], ["a", lv.AwayTeam]];
  const nameById = {}, numById = {};
  for (const [, t] of sides) for (const p of (t?.Players || [])) {
    nameById[p.IdPlayer] = loc(p.ShortName) || loc(p.PlayerName);
    if (p.ShirtNumber != null) numById[p.IdPlayer] = p.ShirtNumber;   // jersey → exact client-side match (disambiguates same-surname team-mates)
  }
  const name = id => nameById[id] || "";
  const num = id => numById[id];

  const ev = [];
  for (const [side, t] of sides) {
    if (!t) continue;
    for (const g of (t.Goals || [])) {
      const k = g.Type === 3 ? "OG" : g.Type === 1 ? "P" : "G";   // best-effort: 3=own goal, 1=penalty
      const e = { _k: minKey(g.Minute), t: g.Minute, k, tm: side, p: name(g.IdPlayer) };
      if (num(g.IdPlayer) != null) e.n = num(g.IdPlayer);
      if (g.IdAssistPlayer) { e.a = name(g.IdAssistPlayer); if (num(g.IdAssistPlayer) != null) e.an = num(g.IdAssistPlayer); }
      ev.push(e);
    }
    for (const b of (t.Bookings || []))
      ev.push({ _k: minKey(b.Minute), t: b.Minute, k: b.Card === 2 ? "R" : "Y", tm: side, p: name(b.IdPlayer), ...(num(b.IdPlayer) != null ? { n: num(b.IdPlayer) } : {}) });
    for (const s of (t.Substitutions || []))
      ev.push({ _k: minKey(s.Minute), t: s.Minute, k: "S", tm: side, on: loc(s.PlayerOnName) || name(s.IdPlayerOn), off: loc(s.PlayerOffName) || name(s.IdPlayerOff) });
  }
  ev.sort((x, y) => x._k - y._k);
  ev.forEach(e => delete e._k);

  // lineups (starting XI) — Status 1 == starter (2 == bench). Position 0=GK 1=DEF 2=MID 3=FWD.
  const xiSide = t => {
    const starters = (t?.Players || []).filter(p => p.Status === 1)
      .map(p => [p.ShirtNumber, loc(p.ShortName) || loc(p.PlayerName), p.Position]);
    return starters.length ? { f: t.Tactics || "", xi: starters, coach: loc((t.Coaches || [])[0]?.Name) } : null;
  };
  const xh = xiSide(lv.HomeTeam), xa = xiSide(lv.AwayTeam);
  const xi = (xh || xa) ? { h: xh || {}, a: xa || {} } : null;

  return { ev, xi };
}

async function fromFifa(prev, needsPhotos) {
  const cal = await fifaGet(`${FIFA}/calendar/matches?idCompetition=${COMP}&idSeason=${SEASON}&language=en&count=104`);
  const rows = cal.Results || [];
  if (!rows.length) throw new Error("FIFA calendar empty");
  // FIFA's MatchNumber is NOT chronological and does NOT equal our openfootball `num` (e.g. FIFA #8 == our m5),
  // so we must never join on it — that writes the live match's score onto the wrong fixture. Identify each feed
  // row by its TEAMS instead. First learn FIFA's 3-letter IdCountry -> our code by matching team names against
  // teams.json (auto-covers 44/48); a few aliases cover the names FIFA spells differently than we do.
  const ALIAS = { KOR: "KR", BIH: "BA", IRN: "IR", COD: "CD" };
  const norm = s => (Array.isArray(s) ? s[0]?.Description : s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  const ourByName = {};
  for (const [c, t] of Object.entries(teams)) ourByName[norm(t.name)] = c;
  const toOur = {};                                   // FIFA IdCountry -> our code
  for (const x of rows) for (const s of [x.Home, x.Away]) {
    const id = s?.IdCountry;
    if (id && /^[A-Z]{3}$/.test(id) && !toOur[id]) { const c = ALIAS[id] || ourByName[norm(s.TeamName)]; if (c) toOur[id] = c; }
  }

  // Pair each feed row to our fixture by the unordered pair of teams — robust to FIFA's numbering and to
  // simultaneous kickoffs. Knockout slots stay placeholders in our schedule until the bracket fills, so for
  // those fall back to the kickoff slot (a unique minute); they carry no live data yet anyway.
  const pairKey = (a, b) => [a, b].sort().join("|");
  const byPair = {}, bySlot = {};
  for (const f of fixtures) {
    if (f.home?.team && f.away?.team) byPair[pairKey(f.home.team, f.away.team)] = f;
    (bySlot[(f.utc || "").slice(0, 16)] ??= []).push(f);
  }
  const byNum = {};
  for (const f of fixtures) byNum[f.num] = f;
  const fifaForFixture = {};
  for (const x of rows) {
    const hc = toOur[x.Home?.IdCountry], ac = toOur[x.Away?.IdCountry];
    if (hc && x.Home?.IdTeam) teamIdByCode[hc] = x.Home.IdTeam;          // learn code→FIFA team id for the squad-photo backfill
    if (ac && x.Away?.IdTeam) teamIdByCode[ac] = x.Away.IdTeam;
    let f = (hc && ac) ? byPair[pairKey(hc, ac)] : null;                 // group + resolved knockouts: by team pair
    // Knockout placeholders can't pair-match. FIFA's MatchNumber is unreliable for GROUP matches (it orders them
    // by group/matchday, not chronologically), but for KNOCKOUTS it's canonical and verified aligned (73→73…104→104),
    // and unlike a kickoff-minute slot it survives a reschedule — so use it, guarded to only land on a knockout fixture.
    if (!f) { const n = Number(x.MatchNumber); const byN = byNum[n]; if (n >= 73 && byN && byN.stage !== "group") f = byN; }   // source AND target must be knockout (73-104)
    if (!f) { const slot = bySlot[(x.Date || "").slice(0, 16)]; if (slot && slot.length === 1) f = slot[0]; }   // last resort
    if (f && !fifaForFixture[f.id]) fifaForFixture[f.id] = x;
  }

  const now = Date.now();
  const matches = {};
  const needLive = [];
  let liveCount = 0, doneCount = 0;

  for (const f of fixtures) {
    const x = fifaForFixture[f.id]; if (!x) continue;
    const kickoff = Date.parse(x.Date || f.utc);
    const ms = x.MatchStatus;                       // 1 = upcoming, 0 = finished, 3 = live (documented)
    let st;
    if (ms === 1) st = "SCHED";
    else if (ms === 3) st = "LIVE";
    else if (Number.isFinite(kickoff) && now < kickoff) st = "SCHED";   // missing/odd status on a future kickoff → not a finished 0-0
    else st = (kickoff && now >= kickoff && now < kickoff + 150 * 60000) ? "LIVE" : "FT"; // hedge ms 0

    const entry = { st };
    // Persist the feed's real kickoff when it drifts from openfootball's static time (>1 min). The static
    // schedule can be hours off the actual FIFA slate; the client overlays `ko` so countdowns, day-grouping
    // and the live hero all agree with reality. Set for every status — SCHED needs it most (future kickoffs).
    if (Number.isFinite(kickoff) && x.Date && Math.abs(kickoff - Date.parse(f.utc)) > 60000)
      entry.ko = new Date(kickoff).toISOString();
    // Orientation: we join by an unordered team pair, so the feed's Home may be our fixture's away. For group
    // matches (home/away fixed by openfootball) flip score/pens/events so the client — which credits entry.h to
    // f.home.team — stays correct. The feed currently matches our orientation, so this is a latent safety net.
    const swap = f.stage === "group" && f.home.team && toOur[x.Home?.IdCountry] && f.home.team !== toOur[x.Home.IdCountry];
    if (st !== "SCHED") {
      const hs = swap ? x.AwayTeamScore : x.HomeTeamScore, as = swap ? x.HomeTeamScore : x.AwayTeamScore;
      const hps = swap ? x.AwayTeamPenaltyScore : x.HomeTeamPenaltyScore, aps = swap ? x.HomeTeamPenaltyScore : x.AwayTeamPenaltyScore;
      if (Number.isFinite(hs)) entry.h = hs;
      if (Number.isFinite(as)) entry.a = as;
      if (Number.isFinite(hps)) entry.hp = hps;
      if (Number.isFinite(aps)) entry.ap = aps;
      const mt = parseInt(x.MatchTime, 10);
      if ((st === "LIVE" || st === "HT") && Number.isFinite(mt)) entry.min = mt;   // a minute is only meaningful while live
    }
    if (f.stage !== "group") {                      // resolve knockout teams for the bracket (carry feed orientation)
      if (x.Home?.IdCountry && toOur[x.Home.IdCountry]) entry.ht = toOur[x.Home.IdCountry];
      if (x.Away?.IdCountry && toOur[x.Away.IdCountry]) entry.at = toOur[x.Away.IdCountry];
    }

    const prevE = prev[f.id];
    const inPlay = st === "LIVE" || st === "HT";
    const captured = prevE && prevE.ev;             // already grabbed this finished match's events
    const hc = f.home.team || entry.ht, ac = f.away.team || entry.at;
    const needPhotos = (hc && needsPhotos(hc)) || (ac && needsPhotos(ac));   // (re)harvest photos for any team still missing players
    if (inPlay || (st === "FT" && (!captured || needPhotos))) needLive.push({ f, x, entry, swap });
    else if (st === "FT" && captured) { entry.ev = prevE.ev; if (prevE.xi) entry.xi = prevE.xi; }

    matches[f.id] = entry;
    if (inPlay) liveCount++; else if (st === "FT") doneCount++;
  }

  // enrich in-play + newly-finished matches with events + lineups (bounded per run). Live matches first, so a
  // backlog of finished-match photo backfills can't exhaust the cap before the currently-live games are enriched.
  needLive.sort((a, b) => ((b.entry.st === "LIVE" || b.entry.st === "HT") ? 1 : 0) - ((a.entry.st === "LIVE" || a.entry.st === "HT") ? 1 : 0));
  let fetched = 0;
  for (const { f, x, entry, swap } of needLive) {
    if (fetched >= LIVE_FETCH_CAP) break;
    try {
      const lv = await fifaGet(`${FIFA}/live/football/${COMP}/${SEASON}/${x.IdStage}/${x.IdMatch}?language=en`);
      fetched++;
      if (lv.Period === 4 && entry.st === "LIVE") entry.st = "HT";   // 4 == half-time
      const { ev, xi } = buildEvents(lv);
      if (swap) for (const e of ev) e.tm = e.tm === "h" ? "a" : "h";   // keep event sides on openfootball's orientation
      if (ev.length) entry.ev = ev;
      if (xi) entry.xi = swap ? { h: xi.a, a: xi.h } : xi;
      const homeCode = f.home.team || entry.ht, awayCode = f.away.team || entry.at;
      harvestPhotos(swap ? lv.AwayTeam : lv.HomeTeam, homeCode); harvestPhotos(swap ? lv.HomeTeam : lv.AwayTeam, awayCode);
    } catch { /* keep the score-only entry */ }
  }

  console.log(`api.fifa.com: 104 fixtures · ${liveCount} live · ${doneCount} finished · ${fetched} enriched`);
  return matches;
}

/* ---------------- fallback: worldcup26.ir ---------------- */
function parseScorers(s) {
  if (!s || s === "null") return [];
  return String(s).replace(/[{}“”]/g, "").split(",").map(x => x.trim()).filter(x => x && x !== "null").slice(0, 12);
}
async function fromWorldCup26() {
  const [gr, tr] = await Promise.all([
    fetch("https://worldcup26.ir/get/games"),
    fetch("https://worldcup26.ir/get/teams"),
  ]);
  if (!gr.ok || !tr.ok) throw new Error(`wc26.ir HTTP ${gr.status}/${tr.status}`);
  const games = (await gr.json()).games || [];
  const apiTeams = (await tr.json()).teams || [];
  if (!games.length) throw new Error("wc26.ir returned no games");

  const idCode = {};
  for (const t of apiTeams) {
    let code = String(t.iso2 || "").toUpperCase();
    if (t.fifa_code === "ENG") code = "GB-ENG";
    else if (t.fifa_code === "SCO") code = "GB-SCT";
    if (teams[code]) idCode[t.id] = code;
  }
  // Join by TEAMS, not by g.id: worldcup26.ir's `id` is its own DB id, not our match num — joining on it routes
  // scores to the wrong fixture (the identical bug we hit with FIFA's MatchNumber). Pair on the resolved codes;
  // knockout slots (placeholder teams) can't pair-match, so for those only fall back to the source id, guarded to
  // land on a knockout fixture so a group game's id can never leak onto another match.
  const pairKey = (a, b) => [a, b].sort().join("|");
  const byPair = {};
  for (const f of fixtures) if (f.home?.team && f.away?.team) byPair[pairKey(f.home.team, f.away.team)] = f;
  const matches = {};
  for (const g of games) {
    const hc = idCode[g.home_team_id], ac = idCode[g.away_team_id];
    let f = (hc && ac) ? byPair[pairKey(hc, ac)] : null;
    if (!f) { const byId = byNum[Number(g.id)]; if (byId && byId.stage !== "group") f = byId; }
    if (!f) continue;
    const fin = String(g.finished).toUpperCase() === "TRUE";
    const te = String(g.time_elapsed || "").toLowerCase().trim();
    let st;
    if (fin) st = "FT";
    else if (["ht", "half", "halftime", "half-time"].includes(te)) st = "HT";
    else if (["notstarted", "", "scheduled", "tbd", "postponed"].includes(te)) st = "SCHED";
    else st = "LIVE";
    const entry = { st };
    if (st !== "SCHED") {
      const h = parseInt(g.home_score, 10), a = parseInt(g.away_score, 10);
      if (Number.isFinite(h)) entry.h = h;
      if (Number.isFinite(a)) entry.a = a;
      const min = parseInt(g.time_elapsed, 10);
      if (Number.isFinite(min)) entry.min = min;
      const gh = parseScorers(g.home_scorers), ga = parseScorers(g.away_scorers);
      if (gh.length) entry.gh = gh;
      if (ga.length) entry.ga = ga;
    }
    if (f.stage !== "group") {
      if (idCode[g.home_team_id]) entry.ht = idCode[g.home_team_id];
      if (idCode[g.away_team_id]) entry.at = idCode[g.away_team_id];
    }
    matches[f.id] = entry;
  }
  console.log(`worldcup26.ir (fallback): ${Object.keys(matches).length} games`);
  return matches;
}

/* ---------------- fallback: football-data.org ---------------- */
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
}
const ALIAS = {};
for (const [code, t] of Object.entries(teams)) ALIAS[norm(t.name)] = code;
Object.assign(ALIAS, {
  [norm("United States")]: "US", [norm("USA")]: "US", [norm("Korea Republic")]: "KR", [norm("South Korea")]: "KR",
  [norm("Czechia")]: "CZ", [norm("Czech Republic")]: "CZ", [norm("Türkiye")]: "TR", [norm("Turkey")]: "TR",
  [norm("Côte d'Ivoire")]: "CI", [norm("Ivory Coast")]: "CI", [norm("Cabo Verde")]: "CV", [norm("Cape Verde")]: "CV",
  [norm("Bosnia and Herzegovina")]: "BA", [norm("DR Congo")]: "CD", [norm("Congo DR")]: "CD", [norm("IR Iran")]: "IR",
});
const toCode = name => ALIAS[norm(name)] || null;
const shift = (day, d) => { const t = new Date(day + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

async function fromFootballData() {
  const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
  if (!TOKEN) throw new Error("FOOTBALL_DATA_TOKEN unset");
  const r = await fetch("https://api.football-data.org/v4/competitions/WC/matches", { headers: { "X-Auth-Token": TOKEN } });
  if (!r.ok) throw new Error("football-data HTTP " + r.status);
  const api = (await r.json()).matches || [];
  const STATUS = s => s === "IN_PLAY" ? "LIVE" : s === "PAUSED" ? "HT" : s === "FINISHED" ? "FT" : "SCHED";
  const byDay = {};
  for (const f of fixtures) (byDay[f.utc.slice(0, 10)] ??= []).push(f);
  const matches = {};
  for (const am of api) {
    const day = (am.utcDate || "").slice(0, 10);
    const hc = toCode(am.homeTeam?.name), ac = toCode(am.awayTeam?.name);
    const cands = [...(byDay[day] || []), ...(byDay[shift(day, -1)] || []), ...(byDay[shift(day, 1)] || [])];
    const f = cands.find(x => x.utc === am.utcDate) ||
      (hc && ac && cands.find(x => (x.home.team === hc && x.away.team === ac) || (x.home.team === ac && x.away.team === hc))) ||
      (cands.length === 1 ? cands[0] : null);
    if (!f) continue;
    const swap = hc && f.home.team && f.home.team !== hc && f.away.team === hc;
    const ft = am.score?.fullTime || {}, pen = am.score?.penalties || {};
    const entry = { st: STATUS(am.status) };
    if (ft.home != null) { entry.h = swap ? ft.away : ft.home; entry.a = swap ? ft.home : ft.away; }
    if (pen.home != null) { entry.hp = swap ? pen.away : pen.home; entry.ap = swap ? pen.home : pen.away; }
    if (am.minute != null) entry.min = am.minute;
    if (f.stage !== "group") { if (hc) entry.ht = swap ? ac : hc; if (ac) entry.at = swap ? hc : ac; }
    matches[f.id] = entry;
  }
  console.log(`football-data.org (fallback): mapped ${Object.keys(matches).length} matches`);
  return matches;
}

/* ---------------- stats enrichment: ESPN fifa.world (possession/shots/corners) ---------------- */
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
// the ESPN summary carries 28 team stats, per-team "leaders", and match facts — pull the useful slice into
// details.json (we long shipped only 5). Compact keys; the client (STAT_ROWS) decides labels + order.
// NB: possessionPct is 0-100 but passPct/shotPct arrive as 0-1 fractions — inconsistent, so we skip those two
// and let the client derive pass accuracy from the accurate/total counts (pass / passT) instead.
const ESPN_STAT_MAP = [
  ["poss", "possessionPct"], ["sh", "totalShots"], ["sot", "shotsOnTarget"], ["blk", "blockedShots"],
  ["sv", "saves"], ["off", "offsides"], ["cor", "wonCorners"], ["fls", "foulsCommitted"],
  ["pass", "accuratePasses"], ["passT", "totalPasses"], ["cross", "accurateCrosses"], ["lball", "accurateLongBalls"],
  ["tkl", "totalTackles"], ["intc", "interceptions"], ["clr", "effectiveClearance"],
  ["yc", "yellowCards"], ["rc", "redCards"],
];
function parseEspnStats(sum, f, entry) {
  const teams = sum.boxscore?.teams || [];
  if (teams.length < 2) return null;
  const num = (t, name) => { const s = (t.statistics || []).find(x => x.name === name); const v = s && parseFloat(s.displayValue); return Number.isFinite(v) ? v : null; };
  const byCode = {};
  for (const t of teams) { const c = toCode(t.team?.displayName); if (c) byCode[c] = t; }
  const H = byCode[f.home.team || entry.ht], A = byCode[f.away.team || entry.at];
  if (!H || !A) return null;
  const pair = name => { const h = num(H, name), a = num(A, name); return (h != null && a != null) ? [h, a] : null; };
  const stats = {};
  for (const [key, espn] of ESPN_STAT_MAP) { const v = pair(espn); if (v) stats[key] = v; }
  // per-team leaders (top performer per category) — names are display-only, no join needed
  const lead = [];
  for (const t of (sum.leaders || [])) {
    const code = toCode(t.team?.displayName); if (!code) continue;
    for (const cat of (t.leaders || [])) {
      const top = cat.leaders?.[0], n = top?.athlete?.displayName, v = top?.displayValue;
      if (n && v != null) lead.push({ c: code, k: cat.name, n, v: String(v) });
    }
  }
  // match facts — attendance + referee
  const facts = {};
  const att = sum.gameInfo?.attendance; if (Number.isFinite(att) && att > 0) facts.att = att;
  const ref = (sum.gameInfo?.officials || []).find(o => /referee/i.test(o.position?.name || o.position?.displayName || ""))?.displayName;
  if (ref) facts.ref = ref;
  // per-player match box scores (rosters[].roster[].stats) → keyed by the raw ESPN name so the client can join it
  // to FIFA/squad names with the same tolerant surname match it uses for photos.
  const PS_MAP = { totalShots: "sh", shotsOnTarget: "sot", totalGoals: "g", goalAssists: "a", foulsCommitted: "fc", foulsSuffered: "fa", offsides: "of", saves: "sv", goalsConceded: "ga", yellowCards: "yc", redCards: "rc" };
  const pstats = {};
  for (const t of (sum.rosters || [])) for (const p of (t.roster || [])) {
    const nm = p.athlete?.displayName; if (!nm) continue;
    const st = {};
    for (const s of (p.stats || [])) { const k = PS_MAP[s.name], v = +s.value; if (k && v) st[k] = v; }
    if (Object.keys(st).length) pstats[nm] = st;
  }
  return { stats: Object.keys(stats).length ? stats : null, lead: lead.length ? lead : null, facts: Object.keys(facts).length ? facts : null, pstats: Object.keys(pstats).length ? pstats : null };
}
async function enrichStats(matches, prev, prevReports) {
  const RECENT = 2 * 864e5;                                 // chase a finished match's (later-published) report for ~2 days
  const need = fixtures.filter(f => {
    const e = matches[f.id]; if (!e) return false;
    if (e.st === "LIVE" || e.st === "HT") return true;       // live → fresh stats + commentary every poll
    if (e.st !== "FT") return false;
    const since = Date.now() - new Date(f.utc).getTime();
    const freshlyDone = since < 5 * 36e5;   // keep refreshing stats+commentary for ~3h after FT — also regenerates a
                                            // commentary file if a rare push race + `reset --hard` discarded it
    const oldFmt = prev[f.id]?.stats && !prev[f.id].stats.pass;   // pre-"rich stats" rows (only the old 5) → backfill once to 16
    return freshlyDone || !prev[f.id]?.stats || oldFmt || (since < RECENT && !prevReports[f.num]?.rep);
  });
  // live games first — the LIVE_FETCH_CAP is shared, and a busy day's backlog of finished matches still chasing
  // reports must not starve currently-live matches of fresh stats + commentary.
  need.sort((a, b) => (["LIVE", "HT"].includes(matches[b.id]?.st) ? 1 : 0) - (["LIVE", "HT"].includes(matches[a.id]?.st) ? 1 : 0));
  for (const f of fixtures) {                              // carry cached stats for finished matches we won't refetch
    const e = matches[f.id];
    if (e && e.st === "FT" && !need.includes(f)) {     // carry finished-match detail we won't refetch
      if (prev[f.id]?.stats) e.stats = prev[f.id].stats;
      if (prev[f.id]?.lead) e.lead = prev[f.id].lead;
      if (prev[f.id]?.facts) e.facts = prev[f.id].facts;
      if (prev[f.id]?.pstats) e.pstats = prev[f.id].pstats;
    }
  }
  if (!need.length) return;
  const dates = [...new Set(need.map(f => f.utc.slice(0, 10).replace(/-/g, "")))];
  const byMin = {};                                        // UTC-minute → [{id, codes:Set<ourCode>}] (≥1 when matches kick off simultaneously)
  for (const d of dates) {
    try {
      const sb = await fetch(`${ESPN}/scoreboard?dates=${d}`, { headers: { "User-Agent": UA } }).then(r => r.json());
      for (const e of (sb.events || [])) {
        if (!e.date) continue;
        const codes = new Set((e.competitions?.[0]?.competitors || []).map(c => toCode(c.team?.displayName)).filter(Boolean));
        (byMin[e.date.slice(0, 16)] ??= []).push({ id: e.id, codes });
      }
    } catch { /* skip this date */ }
  }
  let calls = 0, ok = 0;
  for (const f of need) {
    if (calls >= LIVE_FETCH_CAP) break;
    const entry = matches[f.id], hc = f.home.team || entry.ht, ac = f.away.team || entry.at;
    const cands = byMin[f.utc.slice(0, 16)] || [];
    // pick the event whose teams match this fixture (so simultaneous kickoffs don't collide). Require a team
    // match — no lone-candidate fallback: ESPN's fifa.world feed carries non-WC games at the same minute, and a
    // blind lone pick could staple another match's stats onto ours.
    const eid = cands.find(c => (hc || ac) && (!hc || c.codes.has(hc)) && (!ac || c.codes.has(ac)))?.id;
    if (!eid) continue;
    calls++;
    try {
      const sum = await fetch(`${ESPN}/summary?event=${eid}`, { headers: { "User-Agent": UA } }).then(r => r.json());
      const ex = parseEspnStats(sum, f, matches[f.id]);
      if (ex) {
        if (ex.stats) matches[f.id].stats = ex.stats;
        if (ex.lead) matches[f.id].lead = ex.lead;
        if (ex.facts) matches[f.id].facts = ex.facts;
        if (ex.pstats) matches[f.id].pstats = ex.pstats;
        if (ex.stats || ex.lead || ex.facts || ex.pstats) ok++;
      }
      const rep = parseArticle(sum); if (rep) harvestedReports[f.num] = rep;        // credited write-up
      const com = parseCommentary(sum); if (com) harvestedCommentary[f.num] = com;   // live/full play-by-play
    } catch { /* skip */ }
  }
  if (ok) console.log(`ESPN stats: enriched ${ok} match(es)`);
  const nr = Object.keys(harvestedReports).length, nc = Object.keys(harvestedCommentary).length;
  if (nr || nc) console.log(`ESPN content: ${nr} report(s), ${nc} commentary feed(s)`);
}

/* ---------------- run ---------------- */
const path = "data/results.json", dPath = "data/details.json";
let prev = {}, prevDetail = {};
try { if (existsSync(path)) prev = JSON.parse(readFileSync(path, "utf8")); } catch { /* malformed/conflicted — overwrite */ }
try { if (existsSync(dPath)) prevDetail = JSON.parse(readFileSync(dPath, "utf8")); } catch { /* ignore */ }
const prevMatches = prev.matches || {}, prevDetailMatches = prevDetail.matches || {};
// the fetch/enrich carry-forward reads ev/xi/stats off the previous entries — those now live in details.json,
// so feed the fetch logic a merged view (slim scores + heavy detail) exactly like the pre-split single file.
const prevMerged = {};
for (const id of new Set([...Object.keys(prevMatches), ...Object.keys(prevDetailMatches)]))
  prevMerged[id] = { ...(prevDetailMatches[id] || {}), ...(prevMatches[id] || {}) };
let prevPhotos = {};
try { if (existsSync("data/photos.json")) prevPhotos = JSON.parse(readFileSync("data/photos.json", "utf8")); } catch { /* ignore */ }
// per-team photo coverage. A full FIFA squad backfill keys 26 players by full+short name, so a complete team has
// >= 26 keys; anything below that is still missing players and gets (re)backfilled. Lineup harvests add 1 key per
// appearing player, so a not-yet-played team sits well under 26 and is correctly treated as incomplete.
const photoCounts = {}; for (const k of Object.keys(prevPhotos)) { const c = k.split("|")[1]; photoCounts[c] = (photoCounts[c] || 0) + 1; }
const photoIncomplete = c => (photoCounts[c] || 0) < 26;
// same coverage idea for vitals (data/playerbio.json) — fetch a team's squad if it's missing either photos OR bios
let prevBio = {};
try { if (existsSync("data/playerbio.json")) prevBio = JSON.parse(readFileSync("data/playerbio.json", "utf8")); } catch { /* ignore */ }
const bioCounts = {}; for (const k of Object.keys(prevBio)) { const c = k.split("|")[1]; bioCounts[c] = (bioCounts[c] || 0) + 1; }
const bioIncomplete = c => (bioCounts[c] || 0) < 26;
// previously-captured reports (keyed by match number) — so we stop re-polling a finished match once its report lands
let prevReports = { matches: {} };
try { if (existsSync("data/reports.json")) prevReports = JSON.parse(readFileSync("data/reports.json", "utf8")); } catch { /* ignore */ }
const prevReportMatches = prevReports.matches || {};

const DRY = process.argv.includes("--dry-run");
let matches;
try {
  matches = await fromFifa(prevMerged, photoIncomplete);
} catch (e1) {
  console.warn("Primary api.fifa.com failed:", e1.message, "— trying worldcup26.ir");
  try { matches = await fromWorldCup26(); }
  catch (e2) {
    console.warn("worldcup26.ir failed:", e2.message, "— trying football-data.org");
    try { matches = await fromFootballData(); }
    catch (e3) { console.error("All sources failed:", e3.message); process.exit(1); }
  }
}

try { await enrichStats(matches, prevMerged, prevReportMatches); } catch (e) { console.warn("ESPN stats enrichment failed:", e.message); }
try { await harvestSquad(c => photoIncomplete(c) || bioIncomplete(c)); } catch (e) { console.warn("squad backfill failed:", e.message); }   // no-op if FIFA primary didn't run

// DATA-LOSS GUARD: a fallback feed (worldcup26.ir / football-data) only returns the fixtures it knows about, and
// the writer below overwrites results.json/details.json wholesale. So overlay this run's matches onto the previous
// snapshot — a sparse fallback can then only UPDATE a fixture, never DELETE a finished score we already published.
// (FIFA-primary already returns all 104 fixtures, so this is a no-op there.)
matches = { ...prevMerged, ...matches };

// Split the payload: results.json keeps only the small scores/status fields (it's polled every ~60s by every
// open page); the heavy per-match detail (timeline, lineups, team stats, fallback scorers) goes to details.json,
// fetched by the client only when scores actually change. Keeps the hot-path file tiny once knockouts fill it.
const SLIM = ["st", "h", "a", "hp", "ap", "ht", "at", "min", "ko"];
const slim = {}, detail = {};
for (const [id, m] of Object.entries(matches)) {
  const s = {}, d = {};
  for (const k in m) (SLIM.includes(k) ? s : d)[k] = m[k];
  slim[id] = s;
  if (Object.keys(d).length) detail[id] = d;
}
const now = new Date().toISOString();
if (DRY) {
  const ev = Object.entries(detail).filter(([, m]) => m.ev).map(([id, m]) => `${id}:${m.ev.length}ev`);
  console.log("DRY RUN — not writing. matches:", Object.keys(slim).length, "| detail rows:", Object.keys(detail).length, "| with events:", ev.join(", ") || "none");
  console.log(JSON.stringify(Object.fromEntries(Object.entries(detail).slice(0, 1)), null, 1));
} else {
  if (JSON.stringify(prevMatches) !== JSON.stringify(slim)) {
    writeFileSync(path, JSON.stringify({ updated: now, matches: slim }));
    console.log("results.json updated");
  } else console.log("No score changes — skipping results.json");
  if (JSON.stringify(prevDetailMatches) !== JSON.stringify(detail)) {
    writeFileSync(dPath, JSON.stringify({ updated: now, matches: detail }));
    console.log("details.json updated");
  } else console.log("No detail changes — skipping details.json");
}

// player photos: merge newly-harvested into data/photos.json (write only when changed)
if (!DRY && Object.keys(harvestedPhotos).length) {
  const pPath = "data/photos.json";
  let prevPhotos = {};
  try { if (existsSync(pPath)) prevPhotos = JSON.parse(readFileSync(pPath, "utf8")); } catch { /* overwrite */ }
  const merged = { ...prevPhotos, ...harvestedPhotos };
  if (JSON.stringify(prevPhotos) !== JSON.stringify(merged)) {
    writeFileSync(pPath, JSON.stringify(merged));
    console.log(`photos.json updated (${Object.keys(merged).length} players)`);
  }
}

// player vitals (DOB/height/weight): merge into data/playerbio.json (write only when changed)
if (!DRY && Object.keys(harvestedBio).length) {
  const bPath = "data/playerbio.json";
  let prev = {};
  try { if (existsSync(bPath)) prev = JSON.parse(readFileSync(bPath, "utf8")); } catch { /* overwrite */ }
  const merged = { ...prev, ...harvestedBio };
  if (JSON.stringify(prev) !== JSON.stringify(merged)) {
    writeFileSync(bPath, JSON.stringify(merged));
    console.log(`playerbio.json updated (${Object.keys(merged).length} keys)`);
  }
}

// credited match reports: merge newly-harvested over the committed set (reports persist once captured).
if (!DRY && Object.keys(harvestedReports).length) {
  const merged = { ...prevReportMatches, ...harvestedReports };
  if (JSON.stringify(prevReportMatches) !== JSON.stringify(merged)) {
    writeFileSync("data/reports.json", JSON.stringify({ updated: now, matches: merged }));
    console.log(`reports.json updated (${Object.keys(merged).length} reports)`);
  }
}
// live commentary: one file per match so the client lazy-loads only what it opens; write a match's file only when it changed.
if (!DRY && Object.keys(harvestedCommentary).length) {
  mkdirSync("data/commentary", { recursive: true });
  let wrote = 0;
  for (const [num, com] of Object.entries(harvestedCommentary)) {
    const cPath = `data/commentary/${num}.json`;
    let prevCom = null;
    try { if (existsSync(cPath)) prevCom = readFileSync(cPath, "utf8"); } catch { /* overwrite */ }
    const next = JSON.stringify(com);
    if (prevCom !== next) { writeFileSync(cPath, next); wrote++; }
  }
  if (wrote) console.log(`commentary updated (${wrote} match file(s))`);
}
