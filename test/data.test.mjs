/**
 * Data-integrity + smoke tests for the WC·26 site. No deps — Node's built-in runner:
 *   node --test            (or: npm test)
 * These codify the cross-checks that matter most, so a bad Action commit (corrupt JSON,
 * orphaned ids, a split leak, a missing flag) fails CI instead of reaching visitors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const J = p => JSON.parse(readFileSync(p, "utf8"));
const matches = J("data/matches.json").matches;
const teamsRaw = J("data/teams.json");
const teams = teamsRaw.teams || teamsRaw;
const results = J("data/results.json").matches || {};
const details = J("data/details.json").matches || {};
const squads = J("data/squads.json").squads || {};
const ids = new Set(matches.map(m => m.id));
const codes = new Set(Object.keys(teams));

test("104 matches, all with unique ids and required fields", () => {
  assert.equal(matches.length, 104);
  assert.equal(ids.size, 104, "match ids are unique");
  for (const m of matches) {
    assert.ok(m.id && m.num && m.stage && m.utc && m.home && m.away, `match ${m.id} has core fields`);
    assert.ok(!Number.isNaN(Date.parse(m.utc)), `${m.id} has a valid UTC kickoff`);
  }
  const nums = new Set(matches.map(m => m.num));
  assert.equal(nums.size, 104, "match numbers 1..104 are unique");
});

test("48 teams, every one appears in a group fixture, kit colours valid", () => {
  assert.equal(codes.size, 48);
  const inGroups = new Set();
  for (const m of matches) if (m.stage === "group") for (const s of [m.home, m.away]) {
    if (s.team) { inGroups.add(s.team); assert.ok(codes.has(s.team), `group team ${s.team} is in teams.json`); }
  }
  assert.equal(inGroups.size, 48, "all 48 teams play in the group stage");
  for (const [c, t] of Object.entries(teams)) {
    assert.ok(t.name, `${c} has a name`);
    assert.match(t.c1, /^#[0-9A-Fa-f]{6}$/, `${c} kit colour c1 is a hex`);
    assert.match(t.c2, /^#[0-9A-Fa-f]{6}$/, `${c} kit colour c2 is a hex`);
    // every team needs a strength rating for the win-probability model (seeded World Football Elo)
    assert.ok(Number.isFinite(t.elo) && t.elo > 1400 && t.elo < 2400, `${c} has a sane elo (got ${t.elo})`);
  }
  // fetch-results.mjs joins FIFA feed rows to fixtures by matching team NAMES (normalized) → our code, so those
  // normalized names MUST be unique; a collision would route a live score onto the wrong team. (Regression guard
  // for the FIFA-MatchNumber≠our-num bug, where Qatar–Switzerland's live score showed up on Australia–Türkiye.)
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  const normNames = Object.values(teams).map(t => norm(t.name));
  assert.equal(new Set(normNames).size, normNames.length, "team names are unique after normalization");
});

test("results.json: only score/status fields; valid status, scores, resolved codes", () => {
  const SLIM = new Set(["st", "h", "a", "hp", "ap", "ht", "at", "min", "ko"]);
  for (const [id, r] of Object.entries(results)) {
    assert.ok(ids.has(id), `results id ${id} is a real match`);
    for (const k of Object.keys(r)) assert.ok(SLIM.has(k), `results.json[${id}].${k} is a slim field (no split leak)`);
    if (r.st) assert.ok(["SCHED", "LIVE", "HT", "FT"].includes(r.st), `${id}.st valid`);
    if (r.st === "FT") assert.ok(r.h != null && r.a != null, `${id} FT has a score`);
    for (const f of ["ht", "at"]) if (r[f]) assert.ok(codes.has(r[f]), `${id}.${f}=${r[f]} is a valid code`);
  }
});

test("details.json: only heavy fields, keys are real matches", () => {
  const SLIM = new Set(["st", "h", "a", "hp", "ap", "ht", "at", "min", "ko"]);
  for (const [id, d] of Object.entries(details)) {
    assert.ok(ids.has(id), `details id ${id} is a real match`);
    for (const k of Object.keys(d)) assert.ok(!SLIM.has(k), `details.json[${id}].${k} is not a slim field (no split leak)`);
  }
});

test("squads: 48 teams of 26 players, valid codes", () => {
  assert.equal(Object.keys(squads).length, 48);
  for (const [c, sq] of Object.entries(squads)) {
    assert.ok(codes.has(c), `squad code ${c} is a team`);
    assert.equal((sq.players || []).length, 26, `${c} has 26 players`);
  }
});

test("a self-hosted SVG flag exists for every team", () => {
  for (const c of codes) {
    const p = `assets/flags/${c}.svg`;
    assert.ok(existsSync(p), `${p} exists`);
    assert.match(readFileSync(p, "utf8").slice(0, 200), /<svg|<\?xml/i, `${c}.svg is an SVG`);
  }
});

test("webcal calendars present (all + per team)", () => {
  assert.ok(existsSync("data/ics/all.ics"), "all.ics exists");
  const files = new Set(readdirSync("data/ics"));
  for (const c of codes) assert.ok(files.has(`${c}.ics`), `${c}.ics exists`);
});

test("app.js, scripts and config parse (syntax smoke test)", () => {
  for (const f of ["app.js", "scripts/fetch-results.mjs", "scripts/fetch-squads.mjs", "scripts/make-ics.mjs", "scripts/make-share-cards.mjs"]) {
    assert.doesNotThrow(() => execFileSync("node", ["--check", f], { stdio: "pipe" }), `${f} parses`);
  }
  assert.doesNotThrow(() => J("site.webmanifest"), "site.webmanifest is valid JSON");
});
