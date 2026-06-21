# Architecture — WC·26

A technical overview of how this site is built. For setup/deploy, see [`README.md`](README.md).

## What it is

A static, **no-build** fan site for the FIFA World Cup 2026 (June 11 – July 19): all 104 matches in the visitor's timezone, a favourite team that re-themes the whole UI, live group tables, a full predictor with an interactive knockout bracket (tap winners to crown a champion), squads and lineups. Hosted free on GitHub Pages. Live data is refreshed by GitHub Actions that commit JSON into the repo — **the browser never calls a sports API directly, so no keys are ever exposed client-side**.

## Design constraints

These are deliberate, not accidental:

- **No build step, no framework, no bundler.** The site is plain `index.html` + `styles.css` + `app.js` (one vanilla IIFE). What's in the repo *is* the site.
- **No API keys in client code.** Keys live only in GitHub Actions secrets; the page reads pre-committed JSON from `data/`.
- **All kickoff times are stored in UTC** in `matches.json` and converted at render time via `Intl.DateTimeFormat` — never a hardcoded local time.
- **`localStorage` is only for per-visitor prefs** (favourite team, timezone, saved prediction). Tournament data always comes from `data/*.json`.
- **One design system, driven by CSS variables.** The accent colour is `--acc1`; picking a favourite team recolours the whole UI to its kit (contrast-guarded).

## File map

- **`index.html`** — the shell: header (search · settings · team chips), tab nav (Matches / Teams / Groups / Predict / Stats), the ticker strip, all dialogs, the confetti canvas, and the jump-to-now button. Views are `#view-<name>` sections; `RENDER[name]` maps each to its renderer. Dialogs include the match popup (`openMatch` — a finished game shows a credited **Match report**, a live one shows a lazy-loaded **Live commentary** feed, never both), the rich **team sheet** (`openTeam`), the **player profile** (`openPlayer`), the favourite-team picker, the **About the tournament** / **About this project** sheets, and a once-only first-launch **welcome**.
- **`styles.css`** — the "Floodlit, on paper" design system. All colours are CSS variables; team theming overrides `--acc1` / `--acc2`.
- **`app.js`** — everything else: state, timezone handling, results resolution, standings math, the predictor engine (third-place allocator + bracket resolution), per-view renderers, pickers, and data loading/polling. One vanilla IIFE, sectioned with comment banners.

### Data files (`data/`)

| File | Contents | Source |
|---|---|---|
| `matches.json` | 104 fixtures — UTC kickoffs, stage/group, venue, knockout-slot placeholders | openfootball (public domain), **static** |
| `teams.json` | 48 teams — names, kit colours, confederation, World Cup titles, an **Elo** strength rating (feeds the win-probability model), and curated WC pedigree (`apps` / `best` / `coach`) | static |
| `results.json` | per-match `{st,h,a,hp,ap,ht,at,min,ko}` — score/status only; the small file polled every ~60s. `ko` carries the feed's real kickoff when it drifts from the static schedule | scores Action |
| `details.json` | per-match `{xi,ev,stats}` — lineups, goal/card/sub timeline, team stats; split out so it isn't re-polled every minute. The client merges it over `results.json` | scores Action |
| `photos.json` | official player headshots harvested from FIFA (`"ShortName\|CODE"` → URL) | scores Action |
| `reports.json` | credited match reports from ESPN's free `summary` feed, keyed by match number | scores Action |
| `commentary/<num>.json` | heavy live play-by-play, one file per match so the client lazy-loads only what a popup opens | scores Action |
| `squads.json` | 26-man squads (from official FIFA squad lists; caps/goals frozen at tournament start) | static + optional refresh |
| `ics/*.ics` | static per-team + all-matches calendars for webcal subscription | `make-ics.mjs`, one-off |

The empty-state files (`results`/`reports`) are seeded `{"matches":{}}` so the site works before the first Action run. The client always reads one merged object per match via `res()`.

### Scripts (`scripts/`)

- **`fetch-results.mjs`** — the data engine (Node 20 ESM). **Primary source: `api.fifa.com/api/v3`** (free, no key) for live score + minute, plus an event timeline and lineups per in-play match. It joins feed rows to fixtures **by team pair, never by match number** (FIFA's numbering isn't chronological — joining on it once wrote a live score onto the wrong fixture). **Fallbacks:** worldcup26.ir → football-data.org (needs `FOOTBALL_DATA_TOKEN`). It then enriches with team **stats**, a credited **report**, and **commentary** from one ESPN `summary` call. Writes the slim `results.json` and heavy `details.json` separately, each only when its half changed. `--dry-run` tests without writing.
- **`fetch-squads.mjs`** — *optional*. Refreshes caps/goals/club from API-Football (needs `API_FOOTBALL_KEY`). The committed squads already ship from official FIFA lists, so this isn't required to run the site.
- **`make-icons.py`** / **`make-og.py`** — Pillow, one-shot. Generate the PWA/home-screen icons and the 1200×630 social card from the site's centre-circle mark.
- **`make-ics.mjs`** — one-off, no deps. Generates the webcal calendars (keep the VEVENT format in sync with `matchVEVENT()` in `app.js`).
- **`make-share-cards.mjs`** — build-time only, and the one place with npm deps (`satori` + `@resvg/resvg-js`). Renders a per-finished-match OG card + a `share/<num>.html` redirect stub. The site itself stays dependency-free; `node_modules` is gitignored.

### Service worker & PWA

`sw.js` is **network-first**: HTML / `app.js` / `styles.css` / `*.json` always come from the network when online (so a visitor is never trapped on a stale build; an in-app nudge prompts a reload on a new version), with the cache as an offline fallback. Flags, icons and fonts are cache-first. `site.webmanifest` + the generated icons make the site installable.

### GitHub Actions (`.github/workflows/`)

- **`results.yml`** — a **self-relaunching polling loop** (not a plain cron, which GitHub throttles to ~hourly — too slow for live). One run polls every ~1 min near kickoffs / 30 min in quiet hours for ~5h, commits any changed data, then re-dispatches itself, until the tournament ends.
- **`results-restart.yml`** — a safety-net cron that restarts the loop only if none is running (its own concurrency group, so it can't kill the healthy loop).
- **`tests.yml`** — runs `node --test` on every push.
- **`health.yml`** — an always-on watchdog that checks the **live** site (up? data valid? scores fresh while a match is in play? assets load?) and opens/closes a GitHub issue on failure/recovery.
- **`squads.yml`** / **`share-cards.yml`** — manual squad refresh / OG-card generation.

## Data model notes

- **Knockout slots are placeholders until resolved.** A slot is `{team:"BR"}` (known) or a placeholder like `{ph:"Winner Group A", short:"1A"}` / `{short:"3rd A/B/C/D"}` / `{feeds:73}`. `slotInfo()` resolves these from results; unresolved slots render as italic placeholders.
- **Third-place routing.** The 48-team format sends 8 of 12 third-placed teams to specific Round-of-32 slots, each constrained to certain groups. The predictor implements FIFA's constraint with a backtracking allocator (`allocateThirds()`) and seeds a valid default set so the bracket is interactive immediately.
- **Standings tiebreak** is points → goal difference → goals for → code. FIFA's deeper criteria (head-to-head, disciplinary, drawing of lots) aren't computable from scores alone — an acknowledged simplification; once knockout teams are known, the resolved real teams are used as ground truth.
- **Two "day" concepts.** The matches list groups by the real **calendar date** (`dayKey`). The ticker and match-of-day use a slate-aware **`viewDay`** (rolls at ~10am local) so a night's football reads as one block past midnight. The ticker shows a sliding **two-practical-day window** — yesterday's finals + today's fixtures (times → live → finals) — and slides forward at the 10am boundary.

## Design system

- **Fonts:** Archivo (display), Instrument Sans (body), Spline Sans Mono (numbers/times — always `tabular-nums`).
- **Palette:** paper `#FAFBF9`, ink `#0D1B2A`, pitch green `#0BA360` (default accent), gold `#E8B931` (third-place / champion), live red `#FF3B30` (live state only — never decorative).
- **Logo:** a pure-geometry pitch **centre-circle mark** (`assets/mark.svg`) — gold circle + edge-to-edge halfway line + kick-off spot on a floodlit-green tile. Reused for the favicon, PWA icons, the OG card and the welcome screen (where it draws itself on first open).
- **Flags** (`flag(code)`): bundled local SVGs in `assets/flags/` (originally from flagcdn), each rendered in a uniform 3:2 box via `object-fit:cover` with a hairline ring so even white flags separate from the paper.
- **Live hero is a stack** (`heroStack()`): every live match is its own hero card (simultaneous kickoffs are normal). The spinning live/goal indicator is the public-domain (CC0) `assets/football.svg`. When nothing's live, a single next-kickoff card carries the countdown.
- **Motion** respects `prefers-reduced-motion`; mobile-first, tables collapse to single-column under 560px. Optional background music ("Stadium mix") is a shuffled royalty-free playlist, off by default.

## Local development

The site fetches `data/*.json`, so `file://` won't work (CORS). Use a static server:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
# or: npx serve .
```

Run the tests (no deps; Node 20+):

```bash
node --test           # validates squads, flags, calendars + a syntax smoke test
```

**Deploying** is just a push to `main` (GitHub Pages serves it). When changing `app.js`/`styles.css`, bump the cache-busting version in three places together: `BUILD` in `app.js`, the `?v=` query on both files in `index.html`, and `CACHE` in `sw.js`.

## License

MIT — see [`LICENSE`](LICENSE). Football data, team names, flags and related marks belong to their respective owners; this is an unofficial fan project, not affiliated with FIFA.
