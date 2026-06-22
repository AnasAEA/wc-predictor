# Phase 3 — Value & Staking Engine (armed, paper-only)

> Built now so the system is fully armed the moment the calibration gate opens. **No real money.** During
> the paper phase it stakes FLAT; fractional Kelly is computed and tested but only deploys after positive
> CLV on ≥50 settled bets. Companion to [`PHASE2_CALIBRATION.md`](PHASE2_CALIBRATION.md) and
> [`PHASE4_SHADOW.md`](PHASE4_SHADOW.md).

---

## What shipped

| File | What | Pure? |
|---|---|---|
| `betting/value_engine.mjs` | `evBinary`/`kellyBinary` (1X2), `outcomeDist` + **`kellyNumeric`** (push/quarter-safe Kelly via expected-log-growth maximisation), `suggestStake` (flat + ¼-Kelly capped), `evaluate`, and `simulateBankroll` for grading. | ✅ tested |
| `scripts/calibrate.mjs` | **Safe auto-refit**: always fit a draft; deploy only when `n ≥ 200` AND the new params shift no probability by > 15% vs the live ones (circuit-breaker). Plus the **Phase 2.5 goal mean-shift** diagnostic. | needs data |
| `scripts/shadow-log.mjs` | Now applies the calibrator **only when `status==="active"`** (1X2), else raw; records EV, full-Kelly, and both stake suggestions per signal. | needs data |
| workflows | `odds.yml` + `odds-close.yml` now run `calibrate.mjs` before `shadow-log.mjs` and commit `calibration.json`. | — |
| `test/value.test.mjs` | 6 tests (EV, analytic vs numeric Kelly, stake policy + cap, dispatch, bankroll sim). Suite **40/40**. | ✅ |

## Why numeric Kelly
A closed-form win/lose Kelly is wrong for Asian/Totals bets that can **push or half-win/half-lose**.
`kellyNumeric` maximises `Σ prob·log(1 + f·payoff)` over the full outcome distribution, so it's correct for
every market and returns 0 whenever EV ≤ 0.

---

## The safety net on auto-refit (your design, implemented)

Each cron run: **always fit** the calibrator (`draft`), then **conditionally deploy**:

```
n < 200                      → status "sketch",  hold (don't apply)
n ≥ 200, no prior active      → status "active",  first-activation (nothing to protect)
n ≥ 200, shift ≤ 15%          → status "active",  accept the new params
n ≥ 200, shift > 15%          → status "active",  REJECT — keep the previous active params, log a warning
```

`shift` = max |Δp| between the draft and the live calibrator over a probe grid. This stops a single anomalous
batch (e.g. three rain-soaked 0-0s) from blowing up live predictions. `calibration.json` carries `markets`
(deployed), `draft` (latest fit, for watching it converge), and `sanity` (the decision + max shift).

---

## Phase 2.5 finding (already firing)
The harness now reports model vs actual mean goals:

```
Phase 2.5 goal mean: model 2.72 vs actual 2.97  (Δ −0.25)  ⚠ mean-shift
```

The model **under-predicts goals by ~0.25/game**. Beta calibration makes Totals ECE look great (2.0%) but
partly by inflating "Under" — a probabilistic patch over a **mean** error, exactly the trap to avoid. The fix
isn't calibration; it's the goal model (raise base μ and/or move to **Negative-Binomial**). Tracked for the
full Phase 2.5 decision once more totals settle (small sample for now).

---

## Current staking config (env-overridable)
`bankroll $1000 · flat 0.5% · ¼-Kelly · 2% cap · min EV 3%`. Flat is what the paper phase actually "bets";
Kelly numbers are logged in parallel so we can compare policies on the settled sample later via
`simulateBankroll`.

## Gate to real money (unchanged)
calibration `active` → shadow signals settle → `simulateBankroll` shows **positive CLV on ≥50 settled paper
bets** → only then switch from flat to ¼-Kelly with real stakes. Until every one of those is true, this stays
paper.
