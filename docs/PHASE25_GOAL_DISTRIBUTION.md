# Phase 2.5 — Goal Distribution (Poisson vs Negative-Binomial), pre-built & A/B-ready

> Diagnosed first, then built pluggable so we can A/B the moment enough matches settle. **No deployment yet** —
> the decision is gated on the live data at the calibration gate. Companion to
> [`PHASE2_CALIBRATION.md`](PHASE2_CALIBRATION.md) and [`PHASE3_VALUE_ENGINE.md`](PHASE3_VALUE_ENGINE.md).

---

## What shipped

| File | What | Pure? |
|---|---|---|
| `model/goal_dist.mjs` | Poisson + **Negative-Binomial** PMFs (mean-parameterised; α→0 ⇒ Poisson), `lgamma`, `makeGoalDist`, `dispersionIndex`, and **`fitDispersion`** (MLE α + NB-vs-Poisson log-likelihood). | ✅ tested |
| `model/core.mjs` | `scoreGrid` now takes an optional `opts.goalDist` (e.g. `{name:"negbin",alpha}`). **Default is exact Poisson — golden vector unchanged.** | ✅ |
| `scripts/backtest.mjs` | Goal-distribution **study + A/B**: dispersion index, mean-shift, fitted α, and Poisson vs μ-bumped-Poisson vs NegBin on accuracy/Brier/log-loss/ECE. | — |
| `test/goaldist.test.mjs` | 6 tests (lgamma, PMF↔core parity, NB mean/var, α recovery, scoreGrid swap). Suite **46/46**. | ✅ |

---

## Diagnosis (the key step — don't fix blind)

The −0.25 total mean-shift could be a μ problem *or* overdispersion. The harness measured both:

**WC2026 (real seeds, 76 goals-per-side observations):**
```
goals/side: actual mean 1.487, var 2.386, dispersion Var/Mean = 1.605   (Poisson assumes 1.0)
model mean λ 1.361  →  mean-shift −0.126 per side
fitted NegBin α 0.146  ·  logLik NB −114.4 vs Poisson −115.4  ·  NegBin fits better
```

**It's both — and overdispersion dominates.** Var/Mean = 1.6 is well above Poisson's 1.0 (vs 1.34 in WC2022),
plausibly because the 48-team format creates more lopsided games (more blowouts *and* more shut-outs). So this
isn't just a μ that's 0.13 too low; the variance is genuinely fatter than Poisson allows.

### But the A/B says: don't switch yet
On the metrics that decide bets, the three candidates are nearly tied on 38 matches:

| WC2026 variant | acc | Brier | log-loss | ECE |
|---|---|---|---|---|
| Poisson (current) | 60.5% | **0.571** | **0.958** | 7.4% |
| Poisson μ→1.47 | 60.5% | 0.574 | 0.964 | 6.8% |
| NegBin α=0.15 | 60.5% | 0.576 | 0.966 | **6.5%** |

NegBin fits the **goal counts** better (log-likelihood + ECE both improve) but is **slightly worse on 1X2
Brier/log-loss** here — spreading mass to the tails muddies the win/draw/loss split a touch on a tiny sample.
That's the expected tension: NegBin should help **Totals/Asian** markets (where the goal distribution *is* the
bet) more than 1X2.

---

## The call (deliberately deferred, now cheap to make)

- **Don't deploy NegBin on 38 matches.** The dispersion estimate (1.6 on 76 obs) is itself high-variance, and
  the outcome metrics don't yet favour it. Switching now would be fitting noise — the same discipline that
  kept calibration at `sketch`.
- **It's built and A/B-ready.** `scripts/backtest.mjs` runs the comparison every time; the moment ~30–40 more
  matches settle we re-read it and decide **per market** (very plausibly: Poisson for 1X2, NegBin for Totals/AH).
- **Likely outcome:** a small μ bump *and* NegBin for the goal markets. We'll let the data confirm.

> Note: the Dixon-Coles τ low-score nudge is still applied under NegBin. With a fatter base tail it's
> double-counting a little at 0-0/1-1; if we deploy NegBin we'll re-fit ρ (or drop τ for the goal markets).

## Reconvene at the gate
When calibration `n ≥ 200` flips to `active`, compare **Calibrated Poisson vs Calibrated NegBin on live CLV**
(per market) and lock in what goes live. The engine is fully armed for that test.
