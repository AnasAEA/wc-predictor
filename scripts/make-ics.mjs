/**
 * Generates static .ics calendars for webcal subscription (auto-updating in the user's calendar app).
 * The match schedule is static (kickoff times + venues are fixed), so this is a one-off:
 *   node scripts/make-ics.mjs   → data/ics/all.ics + data/ics/<CODE>.ics (one per team)
 * The client links to them as webcal:// URLs. Per-team files cover the group fixtures (knockout
 * slots are placeholders until resolved). Mirrors the in-app .ics format (scripts must stay in sync
 * with matchVEVENT() in app.js).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const matches = JSON.parse(readFileSync("data/matches.json", "utf8")).matches;
const teamsRaw = JSON.parse(readFileSync("data/teams.json", "utf8"));
const teams = teamsRaw.teams || teamsRaw;

const esc = s => String(s).replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
const stamp = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const fold = line => { let o = ""; while (line.length > 73) { o += line.slice(0, 73) + "\r\n "; line = line.slice(73); } return o + line; };
const NOW = stamp(new Date().toISOString());
const side = s => s.team ? (teams[s.team]?.name || s.team) : (s.ph || "TBD");

const vevent = m => {
  const title = `${side(m.home)} v ${side(m.away)}`;
  const stage = m.group ? `Group ${m.group}` : m.round;
  const start = stamp(m.utc), end = stamp(new Date(new Date(m.utc).getTime() + 115 * 60000).toISOString());
  return [
    "BEGIN:VEVENT", `UID:wc26-m${m.num}@wc26.site`, `DTSTAMP:${NOW}`, `DTSTART:${start}`, `DTEND:${end}`,
    fold(`SUMMARY:${esc(title + " — " + stage)}`),
    fold(`LOCATION:${esc(m.stadium + ", " + m.city)}`),
    fold(`DESCRIPTION:${esc("FIFA World Cup 2026 · " + stage + " · Match " + m.num)}`),
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT60M", fold(`DESCRIPTION:${esc(title + " kicks off in 1 hour")}`), "END:VALARM",
    "END:VEVENT",
  ].join("\r\n");
};
const cal = (name, ms) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WC26//Companion//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  fold(`X-WR-CALNAME:${esc(name)}`), "REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H",
  ...ms.map(vevent), "END:VCALENDAR",
].join("\r\n");

mkdirSync("data/ics", { recursive: true });
writeFileSync("data/ics/all.ics", cal("FIFA World Cup 2026 — all 104 matches", matches));
let n = 0;
for (const code of Object.keys(teams)) {
  const ms = matches.filter(m => m.home.team === code || m.away.team === code);
  if (ms.length) { writeFileSync(`data/ics/${code}.ics`, cal(`${teams[code].name} · World Cup 2026`, ms)); n++; }
}
console.log(`wrote data/ics/all.ics + ${n} team calendars`);
