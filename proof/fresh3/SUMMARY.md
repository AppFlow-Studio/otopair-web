# 3 cars populated LIVE — Yassin's exact request

> "please populate 3 vehicles, show us the new data with your new filters and math in place. And compare it against the old."

Three cars that exist on **ardent-crab (OLD)** but were **not** on flippant-mink, enriched **fresh** through the new pipeline today via `vehicleEnrichment/runPublic:go {vin}`. Decode → create → full enrichment (parts + RepairPal labor). Each is an honest OLD↔NEW on the same vehicle.

| Car | VIN | OLD (ardent-crab) | NEW (flippant-mink, enriched today) |
|---|---|---|---|
| 2026 Ford Expedition Tremor (3.5L EcoBoost V6) | 1FMJU1RGXTEA03585 | specs + parts + **unvalidated `vdb` labor** | RepairPal-gated labor, 18/25 parts priced |
| 2023 Nissan Rogue SV (1.5L VC-Turbo) | JN8BT3BB9PW213363 | specs + parts, **NO labor** | RepairPal-gated labor, 24/25 parts priced |
| 2022 Toyota RAV4 (A25A-FXS hybrid) | JTMCB3FV4ND089342 | specs + parts, **NO labor** | RepairPal-gated labor, 24/25 parts priced |

## What the comparison actually shows
Two axes, stated plainly so neither side is oversold:
- **Labor** is the headline (the system Yassin doubted): old was unvalidated/absent, new is RepairPal-gated.
- **Parts prices**: the old *scraped* data carries real poison the new two-tier gate rejects (see below). Caveat: the new pipeline priced these fresh cars with vetted single-source estimates, so a new number isn't automatically "more correct" — e.g. the Expedition air-filter old median (~$9.6) is fine and the new $17.97 estimate is high.

### Parts-price poison found in the OLD scrape (ardent-crab)
| Car | Part | OLD scraped | NEW |
|---|---|---|---|
| RAV4 | Battery | **$180 scraped from a forum thread** (rav4world.com/threads/…battery-changeout) | $129.95 |
| Expedition | Oil Filter (FL-500-S) | $2.30–$45 — the $45 row is an oil-change **kit**, the $9.31 row is an **air-filter** page | $12.71 |
| Expedition | Engine Air Filter (FA-1883, 9 src) | $4.90–$11.27 — a **cabin/pollen** filter (FP-79) + a wrong OEM mixed in | $17.97 |
| Expedition | Spark Plug | **$96** (summitracing, wrong SKU) | $12.95 |
| Rogue | Spark Plug (22401-6RC1E) | **$70.89 = a 3-pack total stored as the per-plug price** (3×$23.63) | $23.63 ea |
| Rogue | Front Brake Pads (D1060-6RR0A) | $36.5–$37.0 — one row is a **rear** pad (D4060) priced as front | $84.93 |
| Rogue | Battery (999M1-NCH6A) | $171.56 — priced as a **different variant** (NBH6A) | $278.99 |
| RAV4 | Spark Plug (90919-01289) | **$62.24 = a 4-pack total as the per-plug price** (4×$15.46) | $15.46 ea |
| RAV4 | Front Brake Pads (04465-0E060) | $27–$43 — one row is a **different OEM variant** (04465-48230) | $74.93 |
| Rogue | Oil Filter (15208-65F1E) | $6.92 — clean, single source ✓ | $6.37 |

The pack-total-as-unit sparks and the forum-thread battery are the standouts: quoting off the old data would over-bill a spark job 3–4× and source a battery price from a chat thread. The poison-exclusion median + two-tier classification is what drops those rows.

**Correction (own it):** an earlier note here and in chat said these cars' old parts were "mostly fine." That was based on the one clean part (Rogue oil filter). With the full pull, several parts carry poison — corrected above and in the dashboard.

### Ford Expedition Tremor — OLD labor was *unvalidated*, and wrong
OLD labor came from `vdb_repair_estimates` (confidence 0.9 but **`empirical_sample_size: 0`** — confidence not earned) plus `training_data` round guesses. NEW is RepairPal-MOTOR gated.

| Service | OLD book_h | OLD source / conf | NEW book_h | NEW source / conf |
|---|---|---|---|---|
| Oil change | 0.35 | vdb / 0.9 (unvalidated) | **0.5** | RepairPal / 0.9 ✓ |
| **Spark plugs** | **0.92** | vdb / 0.9 (unvalidated) | **2.6** | RepairPal / 0.8 ✓ |
| Brake pads | 1.5 | training (guess) / 0.75 | **1.1** | RepairPal / 0.8 ✓ |
| Wheel alignment | 1.0 | training (guess) / 0.75 | **2.0** | RepairPal / 0.8 ✓ |
| Battery | 0.5 | training (guess) / 0.75 | **0.4** | RepairPal / 0.9 ✓ |

The spark-plug line is the headline: a twin-turbo V6 (plugs buried under the intake) cannot be a **0.92-hour** job. The old VDB number was ~3× too low. RepairPal says **2.6h**. A shop quoting off 0.92h would dramatically under-bill — that's the "inconsistency," and it came from an unvalidated source, not a shop rate.

### Nissan Rogue SV & Toyota RAV4 — OLD had *no* labor at all
Both configs on ardent-crab carry specs and parts but **zero** `labor_times` rows. The old system simply never produced labor for them. NEW gives both a full RepairPal-gated set:

| Service | Rogue NEW | RAV4 NEW |
|---|---|---|
| Oil change | 0.5h ✓ | 0.6h ✓ |
| Spark plugs | 1.2h ✓ | 1.2h ✓ |
| Brake pads | 1.0h ✓ | 0.9h ✓ |
| Wheel alignment | 1.6h ✓ | 2.3h ✓ |
| Battery | (agg) | 0.6h ✓ |

### Sanity: hours scale with engine (not random like a shop rate would be)
Spark-plug hours, NEW: Expedition **2.6h** (V6 twin-turbo) > RAV4 **1.2h** ≈ Rogue **1.2h** (4-cyl). Time tracks the engine; it doesn't scatter.

### Parts
NEW coverage: Rogue 24/25, RAV4 24/25, Expedition 18/25 locked roles priced (Expedition is a big truck — 6 roles still unfound). Prices pass the two-tier verification + poison-exclusion median. Example same-part check (Rogue oil filter 15208-65F1E): OLD $6.92 scraped → NEW $6.37 — consistent, no poison either way.

## Method (reproducible)
```bash
# enrich fresh on flippant-mink (NEW):
npx convex run vehicleEnrichment/runPublic:go '{"vin":"1FMJU1RGXTEA03585"}'   # Expedition
npx convex run vehicleEnrichment/runPublic:go '{"vin":"JN8BT3BB9PW213363"}'   # Rogue
npx convex run vehicleEnrichment/runPublic:go '{"vin":"JTMCB3FV4ND089342"}'   # RAV4
# read NEW:
npx convex run devOnly/laborValidation:report '{}'
npx convex run devOnly/partsCoverage:coverage '{"configKey":"2023_nissan_rogue_sv_engine"}'
# OLD read on ardent-crab via Convex MCP raw-table reads (labor_times / part_prices).
```
Note: the `runPublic:go` CLI call returns an "Error" because its 20-min synchronous poller exceeds Convex's action time limit — the enrichment itself runs async and completes (verified: all 3 reached `enrichment_status: complete`).
