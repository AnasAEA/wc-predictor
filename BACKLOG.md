# WC·26 — Feature backlog & information architecture

_Refreshed at build 65 (2026-06-13). Free/keyless sources only; no backend; no build step for the site itself._

---

## Information architecture — how we grow without clutter

We're going to add a lot. The rule is **grow down (depth), not wide (tabs)**, and push depth into detail sheets and sub-navs so the default of every screen stays scannable.

**Principles**
1. **Top-level tabs stay at 5** — Matches · Teams · Groups · Predict · Stats. A new tab must own a genuinely new *domain*; the default answer is "no new tab."
2. **A tab that accumulates distinct categories gets an in-tab segmented sub-nav** — not more top tabs. (Stats needs this first.)
3. **Per-entity depth lives in detail sheets** — Match sheet (have), Player sheet (have), **Team sheet (to build)**. Lists stay light; one tap reveals depth.
4. **Global preferences consolidate into one Settings sheet** (a gear chip) — not an ever-growing row of topbar chips.
5. **Global navigation = a Search / ⌘K overlay** — jump to any team/player/match from anywhere, instead of cramming entry points into tabs.
6. **Progressive disclosure** — collapsible sections, "see all", modals. Default view shows the 80% case; the rest is a tap away.

**Two foundations unlock most of the backlog cheaply — build these first:**
- **(A) Stats sub-nav** — segmented control: `Players · Teams · Discipline · Records · Tournament`. Every new leaderboard/record then slots into a section instead of lengthening one scroll.
- **(B) Settings sheet** — a gear chip opening a sheet for theme/dark-mode, notifications, music, timezone, lite-mode, calendar-subscribe. Frees the topbar and gives new prefs a home.

**Placement map (where each thing lives)**

| Surface | Owns |
|---|---|
| **Matches** tab / **Match sheet** | schedule + filters; per-match: summary, timeline, lineups, momentum, stats, **H2H**, **venue + weather**, **win-probability**, player profiles |
| **Teams** tab / **Team sheet (new)** | 48 grid + My Team; per-team: **road-to-final**, form, group, fixtures, squad, **rotation/minutes**, **compare** |
| **Groups** tab | standings, qualification outlook, **scenarios/permutations**, **knockout projection** |
| **Predict** tab | predictor, scoring, share, **knockout scenarios** |
| **Stats** tab + **sub-nav (new)** | Players (Boot, **assists**, **keepers**, most-fouled) · Teams (per-match stats, **clean sheets**) · **Discipline** (cards, **suspension watch**) · **Records** (superlatives) · Tournament (pulse, **confederations**) |
| **Settings sheet (new, gear)** | **dark mode**, **notifications**, music, timezone, **lite/data mode**, **calendar subscribe** |
| **Global** | **Search / ⌘K**, refresh-nudge (have), ticker, jump-to-now (have) |

---

## Detailed feature list

Status: ✅ shipped · ⬜ backlog. Effort: S < a session · M ≈ a session · L multi-session. → = where it lives.

### A. Matches & live match detail
- ✅ Live scores (self-relaunching 1-min polling Action)
- ✅ Goal / card / sub **timeline**
- ✅ **Lineups** on a formation pitch (head-cropped official photos)
- ✅ **Match stats** (possession, shots, on-target, corners, fouls) + match-flow **momentum**
- ✅ **Player profiles** — tap any name (timeline / pitch / Boot / squad)
- ⬜ **Venue + weather** — kickoff conditions per match (open-meteo, keyless; city→lat/long static). → Match sheet + small card chip. **M**
- ⬜ **Head-to-head** — recent meetings between the two teams. → Match sheet. **M–L** (needs a history source)
- ✅ **Win-probability** — a Poisson model from team ratings (World Cup pedigree + current-tournament form) on the match sheet, shown pre-match (a lean) and updated in-play by the live scoreline + minutes remaining; clearly labelled an estimate.
- ⬜ **Penalty shootout detail** — kick-by-kick in KO ties. → Match sheet. **S**
- ✅ **Match of the day** — a gold banner under the hero highlighting the marquee fixture in the next slate of games (scored by stage weight + the teams' World Cup pedigree + host bonus); hidden when it's already the hero. → Matches.
- ✅ **Day in review** — a date-navigable digest (tap any day header, or browse with ‹ ›) split into two areas: a **recap** (results, total goals, top scorer, biggest result) and a **preview** (a gold "One to watch" marquee pick + the rest of the day's fixtures). → Matches. Pure client, zero payload.

### B. Teams
- ✅ 48-team grid, 26-man squads, player profiles, My Team + `.ics` export, team re-theming
- ✅ **Team detail sheet** — tapping a team anywhere (grid, group table, leaderboards, match modal) opens a sheet with overview (conf · group · titles · live position), recent form, every fixture (results + upcoming, each drills into the match), the group standing + qualification outlook, a one-tap **Follow** (re-themes the UI), and the full squad (collapsible).
- ✅ **Road to the final** — on the team sheet, a projected knockout route (R32 → Final) from live standings: each round's opponent (the stronger projected team in that side of the bracket) + date/venue, tapping through to the knockout fixture. Shows a "projected to miss the Round of 32" note for teams currently outside the 32. Reuses a full-bracket projector built on the knockout-projection allocator.
- ✅ **Player comparison** — head-to-head of two players (tournament goals/assists/clean sheets/cards + career caps/goals/club), winning value highlighted. "⇄ Compare" from any player profile opens the search overlay in compare mode to pick the second; tolerant name matching bridges feed vs squad names.
- ✅ **Squad rotation / minutes played** — a "Minutes & rotation" section on the team sheet built from each match's `xi` + substitution events: per-player total minutes (nominal 90' full-time), starts vs sub appearances, and a per-match rotation strip (started / subbed off / off the bench / unused). Taps through to the player profile.
- ✅ **Subscribe to a team's calendar** (webcal) — static per-team + all-matches `.ics` files (committed, generated by `scripts/make-ics.mjs`); the team sheet offers "Subscribe to fixtures" (webcal, auto-updating in the calendar app) alongside "Download .ics", and Settings has a "Subscribe to all 104 matches" row.

### C. Groups
- ✅ 12 live tables, "what each team needs" outlook, FLIP reorder animation
- ✅ **Third-place race tracker** — ranks all 12 third-placed teams by FIFA's criteria (pts → GD → GF) with the "top 8 advance" cut line drawn in, since the 48-team format's best-thirds math can't be read off 12 separate tables. → Groups (below the legend). Pure client math, no extra data.
- ⬜ **Qualification scenarios / permutations** — which results send whom through (incl. full third-place permutations). → Groups. **M**
- ✅ **Knockout projection** — a collapsible "Projected Round of 32 — if the groups ended today" in Groups: resolves all 16 ties from live standings (winners/runners-up + best-8 thirds via FIFA's slot constraints), read-only and independent of the user's saved bracket. Reuses a refactored pure thirds-allocator.
- ✅ **Confederation breakdown** — each confederation's combined record (W-D-L) and points-per-game, ranked, in the Stats → Tournament sub-section. Pure client math.

### D. Predict
- ✅ Seeded interactive knockout bracket, thirds allocator, compact share link, champion teaser, **"your call vs reality" scoring**
- ⬜ **Knockout scenarios** — explore alternate bracket outcomes. → Predict. **M**
- ⬜ **Share & compare predictions** — needs a backend for a real leaderboard; local-only "vs a friend's link" otherwise. **L** (likely skip)

### E. Stats & records  _(home: Stats tab + new sub-nav)_
- ✅ Tournament pulse, **Golden Boot**, per-match team stats, yellow/red cards
- ✅ **Assists / playmakers race** — a "Playmakers · assists" leaderboard in the Players sub-section, taps through to the profile.
- ✅ **Clean sheets** (team shutouts) — leaderboard in the Teams sub-section.
- ✅ **Goalkeepers · clean sheets** (per-keeper) — credits the starting GK (pos 0 in the lineup) with each shutout; leaderboard in the Players sub-section, tapping through to the keeper's profile.
- ✅ **Suspension watch** — Discipline sub-section flags who's banned next match (red / 2nd yellow) and who's "on a yellow", derived from the card tallies. Note explains FIFA clears single yellows after the QF.
- ✅ **Records & superlatives** — biggest win, highest-scoring match, fastest & latest goals (each taps through to its match/player). → Records sub-section. _Comebacks / longest-unbeaten still open (need lead-change tracking)._
- ✅ **Fair play table** (cleanest teams) — FIFA fair-play points (−1 yellow / −3 red) ranked in Stats → Discipline. _Most-fouled / most-minutes still open._

### F. Personalisation, chrome & settings
- ✅ Team theming, timezone picker, jump-to-now, new-version refresh nudge, **installable PWA**
- ✅ **Settings sheet** — gear → consolidated prefs (declutters the topbar)
- ✅ **Dark mode** — system-aware + manual toggle in Settings (no-flash head script)
- ✅ **Sounds** — anthem + a synthesized **goal horn** (opt-in). _More background tracks need audio files (royalty-free); won't add random songs._
- ✅ **Match alerts (while open)** — opt-in Settings toggle: a goal notification for your team and a "kicks off soon" reminder, via the Notification API (no push backend). Fires from the existing 60 s poll, only when the tab is backgrounded; gracefully shows On/Off/Blocked/N-A. _Like the goal horn, OS delivery needs verifying on a device where you grant permission._
- ✅ **Quick search / ⌘K** — a global overlay (search chip + ⌘K/Ctrl-K, or "/") that jumps to any team, player (by name or club) or match (by team/city/stage), relevance-ranked (prefix beats mid-word); each result opens the right sheet.
- ✅ **Lite / data-saver mode** — a Settings toggle that suppresses the hot-linked player photos (the bulk of as-you-browse image weight) and falls back to flags everywhere; skips the `photos.json` fetch entirely when enabled at load, lazy-loads it if turned off later. → Settings.

### G. Platform & scale  _(do before knockouts)_
- ✅ **Self-hosted SVG flags** — real flags from `assets/flags/` (fixes emoji-flag breakage on Windows).
- ✅ **Self-hosted fonts** — Archivo / Instrument Sans / Spline Sans Mono served locally (no Google dependency), SW-cached.
- ✅ **Test suite + CI** — `node --test` data-integrity + smoke tests; a Tests workflow on code/static-data pushes.
- ✅ **Opt-in analytics** — cookieless GoatCounter, off by default (zero third-party load until configured).
- ✅ **Champion card** — shareable canvas image of your predicted champion (Predict).
- ✅ **About the tournament** sheet — 48-team format explainer + hosts/dates.
- ✅ **Split heavy match detail out of `results.json`** — the 60s-polled file is now scores/status only (`results.json`, ~2 KB); `ev`/`xi`/`stats` live in `details.json`, fetched by the client only when scores change and merged into `S.matchData`. Writer emits both (carry-forward via a merged prev view); share-cards + the workflow updated.
- ✅ **Offline service worker** — `sw.js`, network-first for HTML/JS/CSS/JSON (online is always fresh; the version nudge still prompts reloads), cache-first for flags/icons/fonts. Cache keys strip `?t=`/`?v=`; activate() purges old caches.
- ⬜ **i18n** — multi-language UI. **L** — a dedicated effort (extract every string + translation system); a partial translation reads worse than none, so deferred whole rather than half-shipped.
- 🟡 **Accessibility pass** (two waves shipped) — global keyboard `:focus-visible` ring on every interactive element, blanket `prefers-reduced-motion` reset, accessible names on all 8 dialogs + labelled close buttons, `aria-current` on the active tab, Enter/Space activation for every custom `role="button"`, and an `aria-live` region that announces goals as they're detected. _Still open: full SR walkthrough, contrast spot-check._
- ⬜ **Goal sound / richer celebration**. **S**

---

## Suggested order
1. **Foundation A — Stats sub-nav** (unlocks E with no clutter).
2. **Foundation B — Settings sheet** (unlocks F; declutters the topbar).
3. Quick wins into the new homes: **assists race**, **clean sheets**, **suspension watch** (Stats), **dark mode** (Settings).
4. **Team detail sheet / road-to-final** (the big Teams upgrade).
5. **Records**, **venue+weather**, **search**, then scale (#G).

## Known issues / watch
- **`results.json` growth** — see G; fine now, split before knockouts.
- **Squad ↔ feed name matching** — profiles fuzzy-match squad full names to FIFA short-name photo keys; misses fall back to the flag (graceful).

When adding data fields, update in order: the schema note in `CLAUDE.md`, the writer script, then the renderer.
