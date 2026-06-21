# WC·26 — Metrics & Analytics Study

A deep audit of **what data we can show**, grounded in what the feeds actually return (probed live, June 2026).
The headline finding: **we currently surface ~5% of the data we already fetch for free.** Most "richer analytics"
needs *no new API at all* — just extracting more from the ESPN + FIFA responses we already download every poll.

---

## 0. The three sources we already have (all keyless except one fallback)

| Source | Key? | We use it for | What it *also* carries (unused) |
|---|---|---|---|
| **api.fifa.com/api/v3** | none | score, minute, goals/cards/subs, lineups, photos | exact pitch coords (LineupX/Y), weather, attendance, ball + territorial possession, tactics/formation, coaches, officials |
| **site.api.espn.com** (hidden) | none | possession, shots, SOT, corners, fouls (5 stats), commentary, reports | **23 more team stats**, **per-player match stats**, per-team **leaders**, **head-to-head history**, **last-5 form**, **betting odds**, attendance, **referee** |
| football-data.org | free token | FT-score fallback | — |

Neither FIFA nor ESPN publishes **xG, shot coordinates, heatmaps, distance covered, or player ratings** for WC26 —
those are the *only* things that need a new source (see §4).

---

## 1. What ESPN already gives us — and we throw away

### 1a. Team stats: we extract **5 of 28**
We use `poss, sh, sot, cor, fls`. The same `summary` response also has:

> offsides · **saves** · shot accuracy % · penalty goals/shots · **accurate passes · total passes · pass %** ·
> **accurate crosses · total crosses · cross %** · **long balls (total/accurate/%)** · **blocked shots** ·
> **tackles (total/won/%)** · **interceptions** · **clearances (total/effective)** · yellow/red cards

That's a full **passing / pressing / defending** profile per team, per match — already downloaded, discarded.

### 1b. Per-player match stats (currently: none from the feed)
Every player in `rosters[].roster[]` carries a per-match line:
`appearances, shots, shots-on-target, goals, assists, fouls committed, fouls suffered, offsides, yellow/red`,
plus for keepers `saves, shots faced, goals conceded`. Each player also has `formationPlace`, `jersey`,
`subbedIn/subbedOut`, and `athlete.id` (→ a stable photo URL). **We compute player tournament numbers from the
event timeline today; ESPN hands us the per-match box score directly.**

### 1c. Per-team "leaders" (top performer per category)
`totalShots`, `accuratePasses`, `defensiveInterventions`, `saves` — e.g. *"Rodri — 116 accurate passes",
"Diney Borges — 18 defensive interventions", "Vozinha — 7 saves."* Instant "who ran the game" callouts.

### 1d. Context we show nothing of
- **Head-to-head history** + **last-5 form** (real results, both teams) — we currently model our own form.
- **Betting odds / moneyline** (DraftKings etc.) → implied **win/draw/loss probability** + spread + over-under.
- **Match facts**: attendance (`67,640`), **referee** (`Adham Mohammad`), venue, and from FIFA **weather**.

### 1e. FIFA's unique extras
- **LineupX / LineupY** — exact normalized pitch coordinates per player (a *true* formation pitch, not a guessed grid).
- **Ball possession + territorial possession + final-third possession** (where the game was played).
- Tactics/formation string, coaches, full officials list.

---

## 2. Tier 1 — rich features from data we already have (no new API, low risk)

Everything here is "extract more in `fetch-results.mjs` → render in `app.js`." Zero new dependencies.

**Match detail**
- Full **team-stat panel**: passing accuracy, crosses, long balls, tackles, interceptions, clearances, saves,
  offsides, blocked shots, shot accuracy — as paired bars (we have the bar component already).
- A **"who controlled it" strip**: possession + territorial + final-third + pass completion.
- **Player-of-the-match style leaders** (top shooter / passer / defender / keeper) with photo.
- **Per-player match line** in the player popup ("In this match: 2 shots, 1 on target, 3 fouls won, 88% passes").
- **Real formation pitch** from LineupX/Y (replaces the positional grid).
- **Match facts row**: attendance · referee · weather · venue.
- **Pre-match panel**: H2H record + both teams' last-5 form + implied odds.

**Player profile**
- Tournament aggregates across the *new* per-match stats: shots, SOT, shot conversion, fouls won/committed,
  offsides, (keepers) save %, goals prevented vs conceded.
- Position-aware "headline stat" (already started for GK/DF — now backed by real shot/save data).

**Teams**
- A **style fingerprint** from the 28 stats: possession %, pass accuracy, directness (long-ball share),
  press intensity (tackles+interceptions), discipline (fouls/cards) — a radar or "this team in 5 numbers."
- Real **form guide** (last-5 W/D/L with scorelines) and per-match leaders.

**Stats page (new leaderboards, all from per-player + team data)**
- Players: most shots, best conversion, fouls drawn, most saves, save %, chances-created proxy (assists+key
  involvement), discipline.
- Teams: pass accuracy, tackles, interceptions, clearances, directness, shot accuracy, set-piece reliance.
- A **team-style table** ranking the 48 by playing identity.

**Tournament-wide trends (cheap to compute, very "analytics-y")**
- Goals per match, cards per match, average possession spread, penalties, comeback count — **by matchday/round**,
  shown as sparklines. "The knockouts are tighter than the groups" — that kind of narrative, data-backed.

---

## 3. Tier 2 — analytics we compute ourselves (our models, no external data)

We already have an **Elo** rating per team and the live match state. From those + the Tier-1 stats:
- **Live win probability** (Elo prior blended with score + minute) — a proper in-match probability curve.
- **Performance vs result**: shot/possession dominance vs the scoreline → "deserved it / smash-and-grab" tags.
- **Strength of schedule** + **knockout-path difficulty** (we already project the bracket — quantify how hard each
  route is by opponents' Elo).
- **Momentum**: rolling shots/possession in 10-min buckets from the event timeline → a momentum chart.
- **Squad load / rotation & fatigue** (we have minutes already — extend with "freshness" into knockouts).
- **Group permutation engine** (we already do best/worst finish) → surface "qualification scenarios" richer:
  exact results that put each team through.

---

## 4. Tier 3 — what genuinely needs a NEW source (xG, shot maps, heatmaps, ratings)

Neither keyless feed has these. **A 2026 development reshapes the options: on 20 Jan 2026 Stats Perform (Opta)
terminated FBref/Sports-Reference's advanced-stats feed and forced its deletion — 8 days after Opta became FIFA's
exclusive WC2026 data distributor.** FBref advanced metrics are *gone*, and official Opta-derived WC26 stats will
be walled off. So the realistic free options, robust → fragile:

| Source | Adds | Access | WC26? | Caveats |
|---|---|---|---|---|
| **openfootball** + **Wikidata** | schedule/groups/venues; player age, height, foot, photo, nationality | **keyless, CORS-OK** (Wikidata browser-fetchable; CC0/public-domain) | yes | zero-risk enrichment, not match analytics |
| **API-Football** (api-sports.io) | **player ratings**, dribbles, duels, key passes, pass accuracy, tackles per match; *sometimes* xG | **key** (we already optionally support it) | yes | free tier **100 req/day** + possible season-gating → **post-match cache only**, verify WC26 season is free-queryable. The one *legal, documented* advanced layer |
| **StatsBomb open-data** | full event data incl. **xG**, shot/pass coords, 360 freeze-frames → shot maps, pass networks | **keyless git JSON** (cleanest license) | **past WCs only** (comp 43); WC26 released post-event *if at all* | perfect for **historical context** ("how they did at WC22"), not live |
| **SofaScore** (unofficial) | **live xG**, player **ratings**, **heatmaps**, shot map, momentum | unofficial JSON, **Action-only** (no CORS, Cloudflare) | yes | ToS-prohibited, rate-limited/blocked; heavy throttling + retries |
| **FotMob** (unofficial) | live xG, ratings, shot map, momentum | unofficial, **signed `x-fm-req` header** | yes | ToS-prohibited **and** the signed header breaks on their schedule — higher maintenance than SofaScore |
| ~~FBref~~ | ~~xG, progressive passes, pressures~~ | — | — | **DEAD as of Jan 2026 — do not build on it** |
| Transfermarkt | **market values**, transfer history | scrape, Action-only | yes | anti-bot, ToS-restricted; values are TM's IP |

**Recommendation (revisit after Tier 1, per the agreed plan):**
- **Legal, robust advanced layer → API-Football free tier**, used *post-match* (cache aggressively against the
  100/day cap; confirm the WC26 season is free-queryable first). Gives **player ratings, duels, dribbles, key
  passes, tackles, pass accuracy** — the metrics ESPN lacks — without ToS risk. Key lives in an Action secret.
- **Historical depth → StatsBomb open-data** (past World Cups, comp 43): power gorgeous **shot maps / pass
  networks / xG-flow** as "context" visuals now, and get WC26 free *if* they release it later.
- **Enrichment spine → openfootball + Wikidata** (keyless, public-domain): richer player cards (age/height/photo)
  and schedule/venues with zero fragility. Wikidata is even browser-fetchable.
- **Live xG/shot-maps → SofaScore (only if we decide we want it):** harvested server-side in the Action,
  best-effort, silent fallback, cached per match — exactly like the ESPN layer. Prefer it over FotMob (no signed
  header). Eyes open: it's ToS-grey and can break; skip if we want sleep-at-night robustness.

> Honesty rule (carried from the project's constraints): anything we can't source we don't fabricate. xG/ratings
> show only where a real provider gives them; otherwise the panel simply isn't there.
> **Explicitly do NOT rely on:** FBref advanced stats (removed), Understat (club leagues only — no national teams),
> or ESPN for xG/win-probability (soccer `summary` has neither — those blocks are US-sports only).

---

## 5. Suggested order (value ÷ effort)

1. **Extract the other 23 ESPN team stats + per-player box score + leaders + gameInfo into `details.json`.**
   One focused change to `fetch-results.mjs`; unlocks Tiers 1a–1d at once. *(biggest win, lowest risk)*
2. **Render** the full team-stat panel + per-player match line + leaders + match facts in the popup.
3. **Team style fingerprint** + new Stats-page leaderboards.
4. **Tournament trend sparklines** (by round).
5. **Live win-probability + performance-vs-result** (Tier 2, our model).
6. **Real formation pitch** from FIFA LineupX/Y.
7. *(optional, opt-in)* **SofaScore xG layer** in the Action → xG, shot maps, ratings.

Steps 1–6 are all from data we already pay nothing for. Step 7 is the only one that adds an external dependency.

---

## 6. Constraints that shape all of the above
- **Keyless-first, server-side.** New sources are fetched in the Action (keys, if ever, only in Action secrets),
  never the browser. The site degrades to what's cached, never breaks.
- **The scores Action owns `results/details/photos/reports.json` + `commentary/`.** Richer data rides in
  `details.json` (already gitignored from manual commits) — never hand-committed with code.
- **No fabricated numbers.** Missing data → the panel is absent, not invented.
- **$0 forever.** Static Pages + Actions; no paid tiers.
