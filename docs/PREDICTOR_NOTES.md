# WC·26 Predictor — Project Notes, Findings & Plan

> The working document for turning the WC·26 fan site's forecasting engine into a serious,
> betting-grade match predictor. Read this first. Last updated: **2026-06-22**.

---

## 0. TL;DR

- This repo started as a fork of the **WC·26 fan site** (`lavyagarg240294/wc26`) — a $0, static, no-build
  World Cup 2026 companion with a genuinely good forecasting model hidden inside it.
- **Goal:** build an "insanely strong" match predictor good enough to bet real money — while staying
  **$0 / keyless** where possible.
- **Reality check (read this):** a 61%-accurate model is *not* a money-maker. You don't bet on who wins;
  you bet when *your* probability differs from the *bookmaker's*. The scoreboard for betting is **ROI** and
  **closing-line value (CLV)**, not accuracy. None of that infrastructure exists yet. See §5.
- **Phase 0 is done:** the model is extracted into a clean, tested, single-source module
  (`model/core.mjs`) with an upgraded backtest + calibration harness. See §7.
- **Two findings that reshape everything** (see §4): (1) the model's predictive power lives almost entirely
  in the **pre-match Elo seeds**, not the in-tournament machinery; (2) the model looks **under-confident**
  in the mid-range, so a calibration layer is well-motivated.

---

## 1. What this project is

A fast, dependency-free static site for the **2026 World Cup** (48 teams, 104 matches), hosted on GitHub
Pages, fed by GitHub Actions that commit JSON into the repo. The browser only ever reads baked JSON —
nothing it shows requires a key or a backend. Total running cost: **$0**.

The piece we care about is the **win-probability model** in `app.js` (~4,900 lines of vanilla JS). It is
better than most public football models, which is why it's worth building on.

### Provenance & safety
- Forked from `https://github.com/lavyagarg240294/wc26` (MIT licensed).
- Audited before adoption: no install hooks, no obfuscation, no `eval`/`Function()` tricks (the `atob`
  calls just decode shareable prediction links). All outbound calls go to reputable hosts (FIFA, ESPN,
  football-data.org, Reddit, Bluesky, Wikipedia, World Bank, news RSS, api.anthropic.com). Secrets are read
  only from `process.env` (GitHub Actions secrets) and sent only to their own legitimate APIs. **Clean.**

---

## 2. Architecture (how the data flows)

```
visitor's browser ── reads ──► index.html + app.js + data/*.json   (GitHub Pages, static)
                                          ▲
GitHub Actions (cron/loops) ── write ─────┘
   PRIMARY   api.fifa.com          → score, minute, events, lineups, photos   → results/details/photos.json
   STATS     site.api.espn.com     → possession, shots, corners, fouls         → details.json
   xG/EFI    fifatrainingcentre PDF → official xG, line breaks, pressures…      → efi.json   (fetch-efi.py)
   SQUADS    API-Football (opt key) → caps/goals/club                           → squads.json
   FALLBACK  football-data.org (key)→ FT-score safety net
```

Key data files (`data/`):
- `matches.json` — 104 fixtures (UTC kickoffs, venues, stage/group). Static.
- `teams.json` — 48 teams: names, kit colours, confederation, **seeded World-Football Elo** (the model's
  single most important input — see §4 finding #1).
- `results.json` — per-match `{st,h,a,…}` score/status (the small file polled every ~60s).
- `details.json` — per-match lineups, event timeline, match stats.
- `efi.json` — FIFA Enhanced Football Intelligence: **official xG**, possession, phases of play, line
  breaks, pressures, per-player distance. Parsed from public FIFA PDFs. Post-match only. **35 matches so far.**
- `wc2022.json` — the *entire* 2022 World Cup (64 matches, scorers, squads, final classification). Used for
  backtesting (with caveats — see §7).

Tournament state in the dataset as of writing: **38 matches FT, 1 live, 65 scheduled** (group stage).

---

## 3. How the model works

The forecast is a **Dixon-Coles bivariate-Poisson** scoreline model on top of a **strength-of-schedule-
adjusted Elo** that blends in official xG. Pipeline (now in `model/core.mjs`, mirrored from `app.js`):

1. **Team strength = Elo.** Seeded once per team in `teams.json`, then updated after each result by
   `eloRatings()`:
   - The result *signal* is **70% xG / 30% actual goals** (when xG exists) — so a fluky 1-0 doesn't
     over-credit a team that was outplayed.
   - Two stages: (a) an **online sequential walk** (the established rating), then (b) a **strength-of-
     schedule fixed-point** that re-rates each multi-game team against opponents' *current* ratings. Stage
     (b) lets a result ripple to a non-playing team through a shared opponent.
   - K=22 (cool), per-team drift hard-capped at **±70** so a short group stage or one blowout can't swamp a
     4-year-seeded prior. Host gets a +40 Elo bump when playing at home.
2. **Elo gap → goal supremacy.** `supR = clamp((eloH − eloA)/300, ±2.5)`, splitting two Poisson rates
   around a base μ (1.35 group / 1.25 knockout — knockouts are tighter).
3. **Attack/Defence overlay** (`attackDefenceRatings()`) — reshapes the *total* goals using opponent-
   adjusted, **James-Stein-shrunk** attack/defence estimates (every team has barely played, so estimates
   are pulled hard toward an Elo-implied prior). Gated off until both teams have ≥2 games. "Skew-locked" so
   Elo keeps ≥75% of *who-wins* and the overlay only owns the *total*.
4. **Multiplicative adjustments:** host edge (+13% own rate / −6% opponent's), group qualification stakes
   (`stakeAdjust` — only fires on evidenced "a draw sends both through" / "both need a win" scenarios),
   live red cards (scaled by minutes left), live minutes-remaining scaling.
5. **Dixon-Coles τ correction** (ρ = −0.11) inflates the 0-0 / 1-1 cells that independent Poisson
   under-counts (real football draws more than independence implies).
6. **Score grid** (9×9 Poisson matrix) → P(home / draw / away), expected goals, and the top-3 most-likely
   scorelines.
7. **Early-tournament shrink** — while teams have barely shown form, hedge pre-match probabilities toward a
   draw-aware base (0.35 / 0.30 / 0.35), decaying to 0 by ~6 games played between the two sides.

---

## 4. Findings (what the backtest told us)

Run it yourself: `node scripts/backtest.mjs`.

### WC2026 — leave-prior backtest over the 38 finished matches (real seeds + FIFA xG)
| Metric | Model | Random baseline |
|---|---|---|
| Outcome accuracy (W/D/A) | **60.5%** | 33.3% |
| Mean prob on actual result | **40.6%** | 33.3% |
| Brier score | **0.571** | 0.667 |
| Log-loss | **0.958** | 1.099 |
| Exact scoreline | 7/38 | — |
| Calibration error (ECE) | **7.4%** | — |

A solid, well-built hobby model. **But these numbers say nothing about beating the market** (the model has
never seen a betting line).

### Finding #1 — the predictive power lives in the *seeds*, not the machinery
Re-running on WC2022 with **flat 1700 seeds** (no team-quality prior; strength learned only from in-
tournament results) scored **29.7% accuracy — below random.** The clever SoS + attack/defence updating
barely moves the needle over 3 group games.

> **Implication for betting:** getting the **pre-match strength prior right** (and reacting fast to **team
> news** — injuries, suspensions, rotation) dwarfs everything else. The fancy in-tournament parts are
> polish; the priors are the engine. Phase 5 (team-news into λ, better historical priors) is where real
> model edge will come from — *after* we can measure it against the market.

### Finding #2 — the model is under-confident in the mid-range
On WC2026, reliability bins showed e.g. "says ~55% → happened ~78%" and "says ~46% → happened ~55%" (small
n, but a consistent direction). ECE 7.4%.

> **Implication:** a **calibration layer** (isotonic/Platt, Phase 2) is well-motivated and could be a cheap,
> real gain. For betting, *calibrated* probabilities matter more than *accurate* ones.

### Finding #3 — the old backtest under-represented the model
The previous `scripts/backtest.mjs` re-implemented the model by hand and **silently omitted the
attack/defence overlay**. This is exactly the "two copies that drift" problem Phase 0 fixed — there is now
one shared core (`model/core.mjs`) that both the site and the backtest use.

---

## 5. The betting reality check (do not skip)

The honest framing before any money moves:

- **You don't bet on who wins. You bet when your probability ≠ the bookmaker's de-vigged probability.**
  The closing line is the single most accurate forecast in existence (it aggregates every sharp model plus
  money). Beating it consistently is *extremely* hard; most models lose to it after the ~5% margin and
  betting limits.
- **Accuracy is the wrong scoreboard.** A 70%-accurate model can lose money (favorites are priced in); a
  40%-accurate model can win money (finding overpriced underdogs). The real scoreboards are **ROI** and
  **CLV (closing-line value)** — did you beat the closing price?
- **What's missing today:** odds ingestion, de-vigging, value/edge detection, Kelly staking, bankroll
  tracking, a bet log, and an ROI/CLV backtest. *All of it.*
- **Timing:** it's 2026-06-22; the tournament ends 2026-07-19. Building a betting system mid-tournament off
  38 games is rushed. The plan therefore **front-loads measurement** (paper-trade + CLV) before real
  stakes. That's not timidity — it's the only way to know the model isn't lighting money on fire.
- **Honest ceiling:** even done perfectly, a thin, hard-won edge is the realistic best case — *not* a money
  printer. The $0/keyless constraint lowers the ceiling further (limited free odds history for calibration).

---

## 6. The plan (staged)

**Guiding principle:** the market is the benchmark, **CLV is the scoreboard**, real money only after the
system shows positive CLV on paper.

- **Phase 0 — Foundation (DONE).** Extract the model into one tested module; upgrade the backtest with
  calibration; validate the harness. → §7.
- **Phase 1 — Get the market in.** Add a free odds feed (e.g. The Odds API free tier — needs one free key,
  500 req/mo, covers the World Cup) → `data/odds.json`. **De-vig** → true implied probabilities. This is the
  benchmark and the source of every edge.
- **Phase 2 — Calibration.** Reliability curves + isotonic/Platt calibration, validated on history (not the
  38 games). Motivated directly by finding #2.
- **Phase 3 — Value + staking engine.** Edge = calibrated model_p − de-vigged market_p, above a minimum
  threshold. **Fractional Kelly** (¼-Kelly, capped) + bankroll model + bet log.
- **Phase 4 — CLV tracking.** Log every flagged bet at *placement* odds, compare to *closing* odds.
  Positive CLV over ~2–3 weeks = the model genuinely beats the market. Runs as **paper-trading first.**
- **Phase 5 — Model enrichment** (only after 0–4 show signal): team news into λ (finding #1); historical /
  club-form priors; use the wasted `efi.json` (xG, line breaks, pressures) in the overlay; context (rest
  days, altitude — Mexico City!, real "neutral" venues).

---

## 7. Phase 0 — what shipped

### New / changed files
| File | What |
|---|---|
| `model/core.mjs` | **Canonical model.** Pure, dependency-free functions: `eloRatings`, `attackDefenceRatings`, `matchProbabilities`, `scoreGrid`, `gameSignal`, `poisson`, `dcTau`. Every tunable is a named constant in one frozen `MODEL` object. Single source of truth. |
| `scripts/backtest.mjs` | Rewritten to **import the core** (kills the duplicate model). Runs the full production pipeline + reports **calibration** (reliability bins + ECE) on WC2026 and WC2022. |
| `test/model.test.mjs` | Locks the math with a deterministic **golden vector** + behavioral checks + a live-backtest regression guard. |

### Verified
- Extraction is **faithful**: WC2026 reproduces the prior numbers (60.5% / Brier 0.571 / LL 0.958). The
  0.5% accuracy diff vs the old backtest is the attack/defence overlay the old one omitted — now correct.
- **`app.js` is untouched** (the live render path). It still carries its own inline copy of the math. Wiring
  it onto `model/core.mjs` is low-risk (clean event delegation, zero inline handlers) but it's a live file,
  so it's deferred to its own verifiable step. **Until then, any change to `core.mjs` must be mirrored in
  `app.js`** — the golden-vector test guards against silent drift.
- Full test suite: **15/15 pass** (7 model + 8 data-integrity).

### WC2022 backtest caveat
`wc2022.json`'s `tier` field is **final finish** (1 = champion … 7 = group exit), *not* a pre-tournament
seed — using it as model input would be look-ahead leakage. We have no genuine Nov-2022 Elo in-repo, so the
2022 run uses **flat 1700 seeds**: it's an **engine/calibration check only**, not a fair test of predictive
power. A real 2022 validation needs real pre-tournament seeds (a Phase-1 data fetch — eloratings.net is
JS-rendered and ClubElo is club-only, so this needs a deliberate source).

---

## 8. How to run it

```bash
# one-time: the site itself has no build; tooling needs Node (project uses Node 22)
node --version            # expect v22.x

# run the model backtest (WC2026 + WC2022 + calibration)
node scripts/backtest.mjs

# run the test suite
npm test                  # = node --test  → 15/15

# serve the site locally (static; no keys needed)
python3 -m http.server 8000   # then open http://localhost:8000/
# stop it:  pkill -f "http.server 8000"
```

> **Local environment note:** Node was initially broken on this machine (a Homebrew `simdjson` version skew
> — node@22 wanted `libsimdjson.30` but only 26/33 were present). Fixed with `brew reinstall node@22`. If
> `node` errors with a dyld `libsimdjson` message again, that's the fix.

---

## 9. Glossary

- **Elo** — a relative strength rating; difference between two ratings maps to an expected result.
- **Dixon-Coles** — a football scoreline model: two Poisson goal counts + a low-score correction (ρ) that
  fixes independent Poisson's under-counting of 0-0 / 1-1 draws.
- **xG (expected goals)** — the goals an average team would score from the chances created, weighted by
  chance quality. A better read of performance than the final score.
- **SoS (strength of schedule)** — adjusting a team's rating for how strong its opponents were.
- **Brier score** — mean squared error of probabilistic forecasts (lower better; 0.667 ≈ random for 3-way).
- **Log-loss** — penalises confident wrong calls hard (lower better; 1.099 ≈ random for 3-way).
- **ECE (expected calibration error)** — average gap between predicted probability and observed frequency.
- **De-vig** — removing the bookmaker's margin from odds to recover their true implied probabilities.
- **CLV (closing-line value)** — whether you bet at a better price than the closing line; the best long-run
  predictor of betting profitability.
- **Kelly criterion** — the bet size that maximises long-run log-growth of a bankroll; fractional Kelly
  (e.g. ¼) trades growth for much lower variance.
```
