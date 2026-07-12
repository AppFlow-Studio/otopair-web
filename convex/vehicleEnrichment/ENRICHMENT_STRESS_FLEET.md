# Enrichment Stress Fleet — adversarial vehicles

Companion to `fleetEval.ts` (the machine-readable version of this table) and
`ENRICHMENT_TEST_SUITE.md` (the general procedure). Every vehicle here was
picked because it **attacks a specific known-weak mechanism** — these are the
tests expected to fail, chosen after the Jul 2026 Audi A4 post-mortem
(coolant 9.5-from-one-blog, VAG fluid SKUs rejected, price budget starvation).

**Core invariant:** the pipeline may be *ignorant* (null / flagged / gap-
ledgered) but never *confidently wrong*.

## Fleet

VINs are structurally valid + vPIC-validated (decode clean, correct engine).
Ground truths cited below; wave-2 numbers marked *(verify)* get re-checked
against owner's manuals before that wave runs.

### Wave 1 — expected failures

| # | Vehicle | VIN | Attack | Ground truth |
|---|---|---|---|---|
| 1 | 2020 Ford F-350 6.7L Power Stroke | `1FT8W3BT8LED00001` | HD diesel capacities vs `getCapacityBand` (coolant rejectMax=24) | Oil 13.0 qt w/filter (2020 owner's manual via ford-trucks.com; hotshotsecret.com). Coolant total 31.7–35.1 qt (hotshotsecret.com) |
| 2 | 2020 Toyota GR Supra 3.0 | `WZ1DB4C05LW030001` | BMW B58 parts on a Toyota config → foreign-brand signature; NHTSA engine model is BLANK | Oil 6.9 qt / 6.5 L w/filter, 0W-20, B58B30M (amsoil.com, blauparts.com) |
| 3 | 2019 Chevy Silverado 1500 5.3 L84 | `1GCUYDED2KZ100001` | Original 16.9-qt poison class; L82/L84/L87 sibling tables; truth 16.6 sits ABOVE V8 typical ceiling 16 | Oil 8.0 qt 0W-20 (GM TechLink 2019-20 PDF). Coolant ≈16.6 qt total (garage.wiki) |
| 4 | 2019 Nissan Altima 2.5 S CVT | `1N4BL4BV3KC110001` | NS-3 CVT SKUs (KE909-class) → new nissan pattern; blank NHTSA cylinders | Oil 5.4 qt / 5.1 L w/filter, 0W-20, PR25DD (noln.net, automobile-catalog.com) |

### Wave 2 — run after wave-1 fixes deploy

| # | Vehicle | VIN | Attack |
|---|---|---|---|
| 5 | 2021 Tesla Model 3 | `5YJ3E1EA4MF000001` | EV honesty: oil/spark/trans must be not_applicable, battery = 12V |
| 6 | 2021 Toyota Prius | `JTDKAMFU6M3000001` | 0W-16 viscosity, eCVT, 2ZR-FXE *(verify oil 4.4 qt)* |
| 7 | 2016 Mercedes C300 W205 | `55SWF4JB4GU100001` | MB A-number fluid SKUs, long suffixes, M274 *(verify oil ~6.1 qt)* |
| 8 | 2005 Honda Odyssey EX-L | `5FNRL38745B100001` | 20-yr-old sparse data → marketplace-only price results must be ledgered; timing BELT (J35A7 via knownEngineFacts) |
| 9 | 2019 Chevy Equinox 2.0T LTG | `2GNAXVEX1K6100001` | ACDelco dash-code fluids (10-9243) → new GM pattern *(verify oil 5.0 qt; note: this VIN decodes FWD — swap for AWD variant if differential attack wanted)* |
| 10 | 2015 VW Golf GTI EA888 | `3VW4T7AU3FM000001` | MQB family sharing with the enriched Audi A4's parts (make_id guards) |
| 11 | 2018 Alfa Romeo Stelvio Ti Q4 | `ZASPAKBN3J7C00001` | Historic Motorcraft-battery contamination; sparse-make patterns |
| 12 | 2020 Hyundai Sonata SEL 2.5 | `5NPEL4JA7LH000001` | NHTSA returns "GDI THETA III" (marketing family name) → synthetic-code filter; real code G4KN |

## Procedure

```bash
# 0. Decode precheck (cheap, no enrichment spend):
npx convex run vehicle_pipeline:processVin '{"vin":"<VIN>"}'

# 1. Full run (one at a time; ~$0.30–1.00, 5–20 min; avoid 09:30 UTC cron):
npx convex run vehicleEnrichment/runPublic:go '{"vin":"<VIN>"}'

# 2. Evaluate:
npx convex run vehicleEnrichment/fleetEval:evaluateConfig '{"vin":"<VIN>"}'

# 3. Whole-wave scorecard:
npx convex run vehicleEnrichment/fleetEval:evaluateFleet '{"wave":1}'
```

Failure triage rule: a failed assertion is a FINDING, not a flake. Root-cause
it, fix it with a regression unit test (pattern: `tests/oemPartPatterns_fluids.test.ts`),
deploy, and re-evaluate before advancing to the next wave.

## Final scorecard (2026-07-11)

**11 / 12 PASS.** Zero confidently-wrong capacities, zero foreign-brand parts,
zero marketplace price rows, zero silent gaps, zero stuck runs across the
fleet. The one FAIL is an honest coverage shortfall, not a correctness bug:
`mercedes_c300` live quotability 0.45 vs 0.5 — its two remaining unpriced
parts have discoverable sources that refuse OEM-number verification (MB pages
don't echo A-numbers cleanly), and the pipeline correctly refuses to store
unverified prices. All gaps ledgered.

## Findings log

| Date | Vehicle | Hypothesis | Observed | Fix |
|---|---|---|---|---|
| 2026-07-11 | F-350 6.7 | Correct ~32 qt coolant rejected by rejectMax=24 | CONFIRMED — coolant stored null (honest, but missing) | Diesel-aware `getCapacityBand` (`CapacityBandContext.diesel`, derived from fuel_type): HD diesel coolant band 8–40, typical 18–36 |
| 2026-07-11 | F-350 6.7 | — | 5W-40 stored; expectation wrongly demanded 10W-30 (both Ford-approved) | Fleet expectation → `oil_viscosity_one_of` |
| 2026-07-11 | Silverado L84 | Sibling tables poison coolant | Stored 13.8 (drain-fill figure) from a lone YOUTUBE source that beat two agreeing sources at 17.4/17.6 — typicality-first sort backfired | (a) youtube/tiktok/vimeo → LOW_AUTHORITY (dropped at gather); (b) `decideCapacity` composite trust score (typical + authority + multi-domain, no single signal dominates) |
| 2026-07-11 | Altima 2.5 | Nissan SKUs / CVT | Engine code QR25DE — the 2007-2018 generation's engine; web-fallback Haiku lifted it from mixed-generation search results | Year-pinned fallback prompt (may answer null); PR25DD set via verified fixEngineFields |
| 2026-07-11 | all wave 1 | — | 17-22 parts/run deferred by the 600s price deadline → quotability 0.09-0.45 until nightly cron | Finalize now schedules an immediate config-targeted zero-price backfill (≤12 parts) when deferrals exist |
| 2026-07-11 | Supra B58 | BMW parts foreign-rejected on Toyota config | NOT confirmed — PASSED 10/10 (Toyota publishes its own SKUs for the A90; no foreign-format numbers surfaced) | none needed |
| 2026-07-11 | wave 2 ×5 | per-make patterns | Engine-oil SKUs are the most hallucination-prone extraction: 5 of 8 vehicles ended rejected ("GC555401QDSP", truncated MB "989510711") or llm_null — ledger + re-ask worked, but oil_change stayed unquotable | `universalFallback` (Engine oil per quart, $11 default) on the engine_oil role — quote proceeds at market synthetic price; enriched SKU wins when it lands |
| 2026-07-11 | Stelvio / Sonata | capacity truth | Pipeline was RIGHT (5.5 qt / 5.9 qt); the fleet's expected ranges were the wrong ground truth | expectations corrected with sources — lesson: verify truths BEFORE the wave, near-boundary "failures" cut both ways |
| 2026-07-11 | Sonata 2.5 | "GDI THETA III" synthetic filter | Marketing name filtered ✓, but the fallback returned G4NA — the 2.0L Nu from a different model line (displacement mismatch) | Year-pinned prompt insufficient for variant confusion; G4KN set via verified fixEngineFields. RESIDUAL RISK: fallback codes can be wrong-variant — consider a displacement cross-check or curated code→displacement map if it recurs |
| 2026-07-11 | Tesla Model 3 | EV honesty | PASSED the real test: zero hallucinated oil/spark/trans fitments (na_services_honest clean). Engine code is the synthetic placeholder — the honest state for an EV; config key carries "unknownl_unknowncyl" (cosmetic, product-level EV support gap) | evaluator: `allow_synthetic_engine_code` for EVs |
