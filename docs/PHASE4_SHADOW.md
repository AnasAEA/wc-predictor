# Phase 4 (early) — Bet Log & CLV in Shadow Mode

> Built ahead of Phases 2–3 on purpose: in a forward-only world, **time is the limiting reagent**. Running
> the bet-log plumbing now in *shadow mode* accumulates a chronologically accurate signal log from day one,
> so calibration (Phase 2) and the value engine (Phase 3) have clean data to test against instead of being
> reconstructed retroactively (where bugs hide). **No money, no calibration yet.** Status: 2026-06-22.

---

## What shipped

| File | What | Pure? |
|---|---|---|
| `betting/clv.mjs` | Unified settlement for 1X2 / Totals / Asian Handicap incl. **quarter lines** (half-win/half-loss), `pnl`, `modelEV` (EV integrated over the score distribution), `settle`, `clv`. | ✅ tested |
| `model/predict.mjs` | Live predictor: build current ratings from all finished matches → forecast any fixture → markets + score cells. Shared by the shadow logger (and, later, app.js). | ✅ |
| `scripts/shadow-log.mjs` | Each run: model vs Shin-de-vigged sharp line → log every selection with **EV ≥ threshold** to `data/bet_log.json`; fill closing odds near KO; settle after FT. | needs data |
| `scripts/fetch-odds.mjs` | Added `--near-ko-only`: spends quota only when a kickoff is imminent (closing-line capture). | needs key |
| `.github/workflows/odds-close.yml` | 15-min cron that no-ops unless a KO is near; captures the close + updates the log. | — |
| `test/betting.test.mjs` | +5 tests (settlement, quarter lines, EV, settle labels, CLV sign). Full suite **28/28**. | ✅ |

## Why EV, not raw probability edge
On Asian/Totals markets, push and quarter-line structure make a pure "model_p − market_p" meaningless. EV
(`Σ cells · pnl(settleUnits, odds)`) folds in the odds *and* the push structure, so it's the universal value
trigger across every market. (For 1X2 it reduces to `p·odds − 1`.)

---

## First shadow run already earned its keep
Run against the first real `odds.json` (32 upcoming matches), the logger produced **99 signals at EV ≥ 3%** —
and immediately exposed a critical flaw: the **raw model over-values longshots**. Examples:

```
CW–CI  home  @17.12   model 21%   Pinnacle 4%   "EV +257%"   ← absurd
TN–NL  home  @19.56   model 15%   Pinnacle 4%   "EV +185%"   ← absurd
```

47 of 99 signals had EV > 20%. These are **not** edges — they're miscalibration (the early-tournament
draw-aware shrink inflating underdogs, and/or seed gaps too small for minnows). **This is the point of shadow
mode:** it caught the model lighting money on fire *before a dollar moved*, and confirms Phase 2 calibration
is a hard gate before any value engine. The signals are logged precisely so calibration can be fit against them.

---

## `data/bet_log.json` shape (Action-owned)
```jsonc
{ "updated": "ISO", "meta": { "ev_threshold": 0.03, "total": 99 },
  "entries": {
    "m41|1x2|0|away": {
      "match_id": "m41", "home": "AR", "away": "AT", "commence": "ISO",
      "timestamp_placement": "ISO", "timestamp_close": null,
      "market": "1x2", "line": 0, "selection": "away",
      "model_prob_raw": 0.146, "market_prob_shin": 0.131, "ev": 0.035, "raw_edge": 0.015,
      "placement_odds": 7.10, "sharp": "pinnacle",
      "closing_odds": null, "result": null, "pnl": null, "clv": null
    }
  } }
```
Entry key = `match|market|line|selection` (idempotent — re-runs update, never duplicate).

---

## Quota note (free tier ≈ 500/mo is genuinely tight)
- Baseline `odds.yml`: every **4h** (was 2h) → ~6 calls/day × 3 credits (eu × h2h/spreads/totals) ≈ 18/day.
- `odds-close.yml`: every 15 min but **only calls the API when a KO is within `NEAR_KO_MIN`** (default 45) —
  a few calls per match-day, concentrated where CLV matters.
- `fetch-odds.mjs` hard-stops below `ODDS_QUOTA_FLOOR` (40) so the month can't be exhausted mid-tournament.
- Tune `ODDS_REGIONS` / `ODDS_MARKETS` / cron / `NEAR_KO_MIN` (repo Variables) if the budget runs short.

## Next (unchanged gates)
Phase 2 calibration (Platt; the longshot bias above is exhibit A) → Phase 2.5 goal-count diagnostic →
Phase 3 value engine (EV trigger already in place, add quarter-aware staking + thresholds) → Phase 4 proper
(grade accumulated CLV; ≥50 settled paper bets + positive CLV before any real stake).
