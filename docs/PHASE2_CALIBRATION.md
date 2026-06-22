# Phase 2 — Calibration (sketch)

> Built ahead of need so it's ready the instant enough live matches settle. **Status: sketch** — the
> mechanics are done and validated, but the calibrator is NOT deployed yet (too little real-seed data).
> Companion to [`PREDICTOR_NOTES.md`](PREDICTOR_NOTES.md) · follows [`PHASE4_SHADOW.md`](PHASE4_SHADOW.md).

---

## What shipped

| File | What | Pure? |
|---|---|---|
| `model/calibrate.mjs` | Binary calibration: **identity / temperature / Platt(logit) / Beta**, log-loss + Brier + reliability/ECE, a dependency-free Nelder–Mead fitter, `fitBest`, and `calibrate1x2` (one-vs-rest + renormalise). A fitted calibrator is just `{method, params}`. | ✅ tested |
| `scripts/calibrate.mjs` | Harness: leave-prior model predictions → binary `{p,y}` samples **per market** (1X2, Totals) → fit + report reliability → write `data/calibration.json`. | needs data |
| `test/calibrate.test.mjs` | 6 tests: identity-at-neutral-params, fit cuts log-loss, fitBest ≤ identity, ECE=0 on a perfect set, 1X2 renormalises. Suite **34/34**. | ✅ |

Each method is **identity at its neutral params**, so "no calibration" is representable and `fitBest` never
chooses to make things worse than raw.

---

## Findings (the reliability curves)

**WC2026, real seeds, 1X2** (the legitimate training set, n=114 binary samples):
```
model pred → observed:   17→10    26→23    35→29    46→55    55→78    66→33
                         └ over-confident ┘         └ under-confident ┘
```
A textbook **S-curve**: the model **over-values longshots** (17%→10% — the Poisson-tail artefact shadow mode
first caught) and is **under-confident in the mid-range** (55%→78%).

**Beta calibration wins on every market**, because it bends the two tails independently — exactly what the
Poisson flaw needs:

| Market (2026) | log-loss raw → beta | ECE raw → beta |
|---|---|---|
| 1X2 | 0.564 → 0.552 | 7.4% → 3.8% |
| Totals 2.5 | 0.697 → 0.681 | 1.2% → 1.0% |
| Totals 3.5 | 0.697 → 0.667 | 10.4% → 2.0% |

Temperature and Platt help less precisely (single/2-param can't bend both tails asymmetrically). This
matches the prediction that the tail problem needs a richer functional form than vanilla Platt.

> **Note (carried from the Phase 2.5 plan):** calibration here is a *band-aid* over a distribution flaw.
> The root fix is the goal model itself (zero-inflated / bivariate-Poisson / Negative-Binomial), decided by
> the goal-count diagnostic. Watch that calibration isn't flattening mid-range favorites to pay for the tail.

---

## Why it is NOT deployed yet (the gate)

`scripts/calibrate.mjs` writes `data/calibration.json` with a **`status`**:
- `sketch` → n < `MIN_FOR_DEPLOY` (200 binary 1X2 samples ≈ 67 matches). **Do not apply.** (Current: n=114.)
- `active` → enough real-seed data; safe for the value engine to apply.

The WC2022 run is deliberately included as **mechanics validation only** — it uses FLAT seeds, so its raw
probabilities are differently distributed and its params must never be deployed on the real-seed model.

Fitting a calibrator on 38 matches and betting it would just trade one over-fit for another — the whole
reason we front-loaded the harness is to be *ready*, not to deploy early.

---

## Pipeline & next steps

```
core.mjs → predict.mjs → calibrate.mjs   (reversible: drop the calibrator to go back to raw)
```

1. Let real-seed samples accumulate toward n≈200 (knockouts will add connected, higher-information games).
2. Auto-refit: add `node scripts/calibrate.mjs` to the odds workflow so `calibration.json` stays current.
3. When `status` flips to `active`, have `shadow-log.mjs` apply `calibrate1x2` / market calibration before
   computing EV — the longshot signals (Curaçao 21%→~8%) should collapse, leaving only genuine edges.
4. Phase 2.5 goal-count diagnostic → decide whether to fix the Poisson tail at the source.
