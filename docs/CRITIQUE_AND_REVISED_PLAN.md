# Critique Analysis & Revised Plan

> A response to an external technical review of the model + betting plan (2026-06-22). Each critique is
> graded **Accept / Accept-with-nuance / Reframe / Defer**, grounded in the backtest harness where the
> claim is testable. Then a revised roadmap that targets the valid points in dependency order.
> Companion to [`PREDICTOR_NOTES.md`](PREDICTOR_NOTES.md).

---

## 0. Verdict on the review

It's a strong, sharp review — most of it is correct and several points are genuinely important (Shin de-vig,
Platt over isotonic, sharp-line CLV, the shift to Asian Handicap/Totals). My job was not to rubber-stamp it
but to test what's testable and reframe what's argued from theory. **One model critique (K too high) turned
out to be empirically moot on our current data; one structural constraint the review under-weights (no free
historical odds) reshapes the sequencing.** Details below.

---

## 1. Scorecard

| # | Critique | Verdict | One-line |
|---|---|---|---|
| 1 | K=22 too high for a short tournament | **Reframe** | Tested: ~zero effect now (seed-dominated). Lower to ~12 as cheap insurance, not edge. |
| 2 | Poisson under-predicts blowouts → NegBin/Copula | **Accept, evidence-gated** | Only matters for Totals/AH. Add goal-count calibration first; swap distribution only if it misses. |
| 3 | Static/tri-host home advantage; Azteca altitude | **Accept** | Phase 5. Altitude hits all non-acclimatized teams, not just hosts. |
| 4 | Odds API free-tier rate-limit trap | **Accept w/ correction** | Bulk endpoint returns all events per call; cost scales by markets×regions. 500/mo works with discipline. |
| 5 | De-vig with Shin/Power, not multiplicative | **Strongly accept** | Favorite-longshot bias is real; implement several, pick the best-calibrated empirically. |
| 6 | Track CLV vs Pinnacle/Betfair, not soft books | **Accept w/ practical note** | Bet soft, measure vs sharp. Mind data availability + jurisdiction. |
| 7 | Isotonic overfits small n → Platt | **Strongly accept** | Platt (2 params) at low n; pool history to raise n; revisit isotonic later. |
| 8 | ¼-Kelly variance; flat-bet until 50+ samples | **Accept** | Flat 0.5–1% through the paper phase; fractional Kelly only after a sample exists. |
| 9 | Define "closing line"; snapshot at bet-time AND close | **Accept** | Capture odds at placement and ~1 min before kickoff (post team-news). |
| 10 | Rest days & travel (tri-national) | **Accept** | Quantifiable λ multiplier from dates + venue coords. Phase 5. |
| 11 | Team news → λ (manual importance weight) | **Strongly accept** | Highest-edge item; aligns with Finding #1 (priors/context > machinery). |
| 12 | Expected motivation / dead rubbers | **Defer** | Extends `stakeAdjust`; most valuable for live betting (later phase). |
| 13 | Shift 1X2 → Asian Handicap / Totals | **Strongly accept, elevate** | Native to our score grid, lower margin. Depends on #2 (goal-dist calibration). |

---

## 2. The two findings that change the picture

### A. The K=22 critique is empirically moot on current data (tested)
The review reasoned that K=22 over-reacts. We have the harness, so we swept it instead of guessing:

```
K sweep, WC2026 (38 group matches):   Brier 0.571 and ECE 7.4% — IDENTICAL for K = 6,10,14,18,22,30,40
K sweep, WC2022 (64, flat, connected): Brier 0.660→0.663 across K = 6…60 (lower K marginally better)
```

Why: in the group stage the leave-prior match graph is near-disjoint (each team's prediction sees ≤1–2 prior
games), so the Elo *update* barely engages before the prediction is made. Even on the fully-connected 2022
graph the effect is tiny. **The direction of the critique is right (lower K is marginally safer) but the
magnitude is negligible — seed quality swamps it.** Action: set K≈12 as harmless insurance and **re-sweep
once knockout data exists** (where the graph connects and K could finally bite). This is not where edge lives.

### B. The constraint the review under-weights: no free historical odds
Every betting-layer claim — which de-vig method is best (#5), whether the model is calibrated (#7), whether
AH/Totals are beatable (#13) — can only be validated against **historical closing odds**. The $0/keyless
path (Odds API free tier) gives **live, going-forward** odds, *not* deep history. So:

> **Validation is forward-only and slow.** We can't backtest the betting layer on the past for free; we have
> to *collect* odds from now and paper-trade. This makes "start logging odds immediately" the single most
> time-critical action, and means honest validation spans the rest of the tournament. Plan accordingly.

---

## 3. How we target each accepted critique

### Model (diagnostics-first — we now have parameter sweeps + opts threading in the backtest)
- **#1 K:** set K≈12; add a standing K/ρ/μ/shrink sweep to the diagnostics run; re-evaluate at the knockouts.
- **#2 blowouts:** add a **goal-count calibration diagnostic** (predicted vs actual distribution of total
  goals, and per-Totals-line hit rates). *Only if* it shows tail under-prediction do we move from independent
  Poisson to **bivariate Poisson** (shared component) or **Negative Binomial** (overdispersion). No new
  complexity without the diagnostic demanding it. Also raise the score grid past 8 goals for blowout mass.
- **#3 home/altitude:** disaggregate the flat host bump into (a) a venue **altitude** term applied to *every*
  non-acclimatized team in Mexico City/Guadalajara/Toluca, and (b) a smaller, calibrated host-crowd term.
  Quantify from historical altitude/home splits.

### Betting infrastructure (Phases 1–4, revised)
- **#4 rate limits:** one bulk Odds API call per cycle (all WC events at once); request only the
  markets/regions we use; poll on a kickoff-aware schedule (frequent only inside 24h, dense inside 1h).
  Budget the 500/mo explicitly in code.
- **#5 de-vig:** implement **multiplicative, power, and Shin** de-vig; log all three; periodically score
  which de-vigged probabilities best predict outcomes and use the winner as the benchmark. Default to Shin.
- **#6 CLV benchmark:** pull **Pinnacle** (and Betfair Exchange where available) via the EU region for the
  *closing* reference; record soft-book prices separately as the *placement* reference. Bet soft, grade sharp.
- **#7 calibration:** **Platt scaling** only at current n; build the training set by **pooling historical
  WCs + the live tournament** to lift n; keep isotonic on the shelf for when n is in the hundreds.
- **#8 staking:** **flat 0.5–1%** of bankroll through the entire paper phase; switch to **¼-Kelly (capped)**
  only after ≥50 graded paper bets with positive CLV; use **simultaneous Kelly** for correlated bets on the
  same match.
- **#9 closing line:** snapshot odds at **placement** and again at **T-1 min** (the real close, after team
  news); CLV = placement price vs that close. Persist both in the bet log.

### Enrichment (Phase 5 — where Finding #1 says the edge actually is)
- **#11 team news → λ:** when confirmed lineups drop (~1h pre-KO, already fetched), apply a per-player
  **importance weight** to the team's attack/defence rating (start manual/heuristic from minutes + goal
  share; no NLP needed). This is the top-priority enrichment.
- **#10 rest & travel:** rest-day differential + travel distance (venue coords) → small λ multiplier.
- **#12 motivation:** extend `stakeAdjust` into an "expected motivation" term for dead rubbers / must-win
  third games; primarily for the eventual live-betting phase.

### Market selection
- **#13 AH/Totals:** map the existing score-grid output to **Over/Under** and **Asian Handicap** probabilities
  (the grid already contains everything needed). Target these lower-margin markets first. **Gate on #2** —
  Totals edge is only real if the goal distribution is calibrated, so the goal-count diagnostic is a
  prerequisite, not an afterthought.

---

## 4. Revised roadmap

Unchanged principle: **market = benchmark, CLV = scoreboard, real money only after positive paper CLV.**

- **Phase 0 — Foundation. DONE.** + now: backtest threads tunable `opts` (parameter sweeps enabled).
- **Phase 1 — Odds in the loop (DO FIRST, time-critical per §2.B).**
  - Odds API Action → `data/odds.json`, kickoff-aware polling, 500/mo budget.
  - Implement multiplicative + power + **Shin** de-vig; capture Pinnacle/Betfair as the sharp reference.
  - **Start logging immediately** so a forward-validation set begins accumulating.
- **Phase 1.5 — Market mapping.** Score grid → 1X2 **and** O/U + Asian Handicap probabilities.
- **Phase 2 — Calibration (Platt; pooled history).** Driven by the reliability findings + de-vig comparison.
- **Phase 2.5 — Goal-distribution diagnostic.** Decide independent-Poisson vs bivariate-Poisson/NegBin on
  evidence; unblocks trustworthy Totals/AH.
- **Phase 3 — Value + staking.** Edge = calibrated p − Shin-de-vigged sharp p, above threshold; **flat
  staking** to start; bet log with placement + close snapshots.
- **Phase 4 — CLV tracking (paper).** Grade vs sharp close; ≥50 bets + positive CLV before any real money.
- **Phase 5 — Enrichment.** Team-news λ (top), rest/travel, altitude/home disaggregation, motivation.
- **Phase 6+ — Live betting.** Only after the pre-match system is proven.

**Immediate next step:** Phase 1 — stand up odds ingestion + the three de-vig methods, because nothing
downstream can be validated until odds are flowing and accumulating (§2.B).

---

## 5. Where I pushed back on the review

- **K=22:** not a real problem on our data (tested); lowering it is fine but cosmetic. Don't mistake it for edge.
- **NegBin/Copula:** correct in theory, but premature — add the goal-count diagnostic first; only swap the
  distribution if the data shows a tail miss. Avoid complexity that isn't earning its keep (same discipline
  as the isotonic warning).
- **Free-tier "burn in a day":** based on per-match polling; the bulk endpoint makes 500/mo workable. Real
  risk is markets×regions multiplying credit cost, not event count.
- **The bigger gap:** the review treats validation as available; under $0/keyless it is **forward-only**, which
  is the real scheduling constraint and the reason Phase 1 must start now.
