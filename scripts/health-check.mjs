/**
 * Health watchdog for the LIVE WC·26 site (GitHub Pages). Fetches what a real visitor sees and asserts the
 * things that, if broken, mean the site is down, stale, or serving corrupt data. Exit 0 = healthy, 1 = problems
 * (health.yml opens/updates a GitHub issue so you get notified). No deps; Node 20+. Run locally:
 *   SITE_URL=https://lavyagarg240294.github.io/wc26/ node scripts/health-check.mjs
 */
const SITE = (process.env.SITE_URL || "https://lavyagarg240294.github.io/wc26/").replace(/\/?$/, "/");
const problems = [], warn = [];
const bust = p => SITE + p + (p.includes("?") ? "&" : "?") + "hc=" + Date.now();   // skip the Pages CDN cache
async function get(p, asJson) {
  const r = await fetch(bust(p), { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return asJson ? r.json() : r.text();
}

// 1. site is up and actually serving the app shell
try {
  const html = await get("index.html");
  if (!/app\.js\?v=/.test(html)) problems.push("index.html is served but has no app.js?v= reference (broken deploy?)");
} catch (e) { problems.push("site unreachable: index.html " + e.message); }

// 2. core static data is present and the right shape
let matches = null;
try {
  matches = await get("data/matches.json", true);
  const n = matches?.matches?.length;
  if (n !== 104) problems.push(`matches.json has ${n} fixtures (expected 104)`);
} catch (e) { problems.push("matches.json " + e.message); }
try {
  const teams = await get("data/teams.json", true);
  const n = Object.keys(teams || {}).length;
  if (n !== 48) problems.push(`teams.json has ${n} teams (expected 48)`);
  else { const miss = Object.entries(teams).find(([, t]) => !t.name || !t.coach || t.apps == null); if (miss) problems.push(`teams.json[${miss[0]}] missing name/coach/apps`); }
} catch (e) { problems.push("teams.json " + e.message); }

// 3. live scores file is valid JSON and FRESH when a match is actually in play (the scores loop being down is
//    the most likely real failure). Window: kickoff−5min … kickoff+130min.
try {
  const results = await get("data/results.json", true);
  if (!results || typeof results.matches !== "object") problems.push("results.json is not the expected {matches:{}} shape");
  const updated = results?.updated ? Date.parse(results.updated) : 0;
  const ageMin = updated ? (Date.now() - updated) / 60000 : Infinity;
  const now = Date.now();
  const liveNow = (matches?.matches || []).some(m => { const t = Date.parse(m.utc); return now > t - 5 * 6e4 && now < t + 130 * 6e4; });
  if (liveNow && ageMin > 25) problems.push(`a match is in play but results.json is ${Math.round(ageMin)} min stale — the scores loop may be down`);
  else if (ageMin > 36 * 60) warn.push(`results.json last changed ${Math.round(ageMin / 60)}h ago (no live match right now — usually fine)`);
} catch (e) { problems.push("results.json " + e.message); }

// 4. key assets a visitor needs actually load
for (const a of ["app.js", "styles.css", "assets/flags/BR.svg", "site.webmanifest", "sw.js"]) {
  try { const r = await fetch(bust(a)); if (!r.ok) problems.push(`${a} → HTTP ${r.status}`); }
  catch (e) { problems.push(`${a} ${e.message}`); }
}

console.log(`Health check ${new Date().toISOString()} · ${SITE}`);
warn.forEach(w => console.log("  ⚠ " + w));
if (problems.length) {
  console.error("PROBLEMS (" + problems.length + "):");
  problems.forEach(p => console.error("  ✗ " + p));
  process.exit(1);
}
console.log("  ✓ all " + (4) + " check groups passed" + (warn.length ? ` (${warn.length} warning)` : ""));
