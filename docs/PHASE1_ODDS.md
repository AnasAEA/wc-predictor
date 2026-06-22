# Phase 1 — Market Layer (odds + de-vig + market mapping)

> Status as of 2026-06-22. The pure, key-independent math is **built and tested (24/24)**. The live odds
> *flow* needs one free API key (a single manual step, below) — until then everything no-ops cleanly.
> Companion to [`PREDICTOR_NOTES.md`](PREDICTOR_NOTES.md) and [`CRITIQUE_AND_REVISED_PLAN.md`](CRITIQUE_AND_REVISED_PLAN.md).

---

## What shipped

| File | What | Runs without key? |
|---|---|---|
| `betting/devig.mjs` | De-vigging: **multiplicative**, **power**, **Shin** (iterative solver, power fallback), **betfair-mid**. Recovers true implied probabilities from decimal odds. | ✅ pure |
| `model/markets.mjs` | Maps the model's score distribution → **1X2, Over/Under, Asian Handicap, BTTS** (the lower-margin markets where our full-distribution model has an edge). | ✅ pure |
| `scripts/fetch-odds.mjs` | Pulls WC2026 odds from The Odds API → `data/odds.json`, with quota tracking + hard-stop, name→fixture mapping, and **open / latest / close** capture per match for CLV. | needs key |
| `.github/workflows/odds.yml` | Cron (~2h) Action that runs the fetcher and commits `data/odds.json`. Date-guarded to the tournament. | needs secret |
| `test/betting.test.mjs` | 9 tests: de-vig normalisation, **Shin's favorite-longshot correction**, market partitioning, AH/Totals push logic, model wiring. | ✅ |

### Shin correction, demonstrated
Decimal odds `[1.30, 5.50, 11.0]` (heavy fav / mid / longshot):

```
Multiplicative:  73.8%  17.4%  8.7%
Shin (z=0.022):  75.1%  16.9%  8.0%   ← longshot shaded DOWN, favorite UP
```

Using multiplicative would systematically fake underdog "value." Default de-vig is **Shin**; we keep all
three and will let the data pick the best-calibrated in Phase 2.

---

## ⚙️ One-time setup (starts the data clock — do this ASAP)

The forward-only validation set only begins accumulating once odds flow. Per the plan, **time is the
limiting asset**, so:

1. Get a **free** key at <https://the-odds-api.com> (500 requests/month — covers the World Cup).
2. Add it as a repo secret: **Settings → Secrets and variables → Actions → New repository secret**,
   name `ODDS_API_KEY`.
3. (Optional) tune via repo **Variables** (same screen, "Variables" tab):
   `ODDS_REGIONS` (default `eu,us` — `eu` carries **Pinnacle + Betfair**, our sharp CLV reference) and
   `ODDS_MARKETS` (default `h2h,spreads,totals`).
4. **Actions → Update Odds → Run workflow** to kick the first fetch, then it runs on cron.

### Quota math (don't blow the 500)
Cost is **markets × regions per call**, *not* per event (one call returns all WC matches). `eu,us` ×
`h2h,spreads,totals` = up to 6 credits/call. At ~2h cadence that's ~72/day — **too heavy for 500/mo over a
month.** Options: drop to `eu` only (Pinnacle+Betfair, the sharps that matter) → ~3/call → ~36/day, or widen
the cron interval, or fetch the full set only inside 24h of kickoffs. The script hard-stops below
`ODDS_QUOTA_FLOOR` (default 40) so it can't silently exhaust the month.

---

## `data/odds.json` shape

```jsonc
{
  "updated": "ISO", "quota": { "remaining": 461, "used": 39 },
  "matches": {
    "m37": {
      "commence": "ISO", "home": "BR", "away": "RS",
      "open":   { "t": "ISO", "sharp": "pinnacle", "books": { "pinnacle": { "h2h": [1.9, 3.4, 4.2],
                  "totals": { "2.5": { "over": 1.95, "under": 1.9 } },
                  "spreads": { "-0.5": { "home": 1.95, "away": 1.9 } } } } },
      "latest": { /* most recent snapshot */ },
      "close":  { /* captured within 15 min of kickoff = the sharp closing line, for CLV */ }
    }
  }
}
```
`h2h`/`spreads` are oriented to **our** home/away (not the feed's), so they line up with the model directly.

---

## Next (Phase 2, once odds are flowing)
1. **De-vig bake-off** — score multiplicative vs power vs Shin by how well each predicts actual results.
2. **Calibration (Platt)** — calibrate model probabilities; pool historical + live to lift sample size.
3. **Goal-count diagnostic (Phase 2.5)** — log model Totals vs the Pinnacle close; only if a systematic
   Over/Under bias shows do we move off independent Poisson (bivariate-Poisson / Negative-Binomial).
4. Only then: value engine + flat-stake paper bets + CLV tracking (Phases 3–4).
