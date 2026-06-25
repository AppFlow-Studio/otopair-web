# Pricing FALLBACK data vs OLP — what they are, how far apart they sit, and what changes when RepairPal is removed

**Date:** 2026-06-13 / Branch: waleed-flagship
**Comparison universe:** 17 real vehicle configs x 13 labor services. 170 fallback-comparable rows (10 anchored services), 36 OLP rows the fallback cannot touch, 1 eval fixture excluded.
**Artifacts:** proof/olp-vs-fallback/data.json (per-row dataset + headline + per-service + per-tier), proof/olp-vs-fallback/build.js (join/stats), proof/olp-vs-fallback/db_dump.json (raw DB query). OLP source: proof/olp/raw/<config_key>.json. Live read-only query: convex/devOnly/fallbackVsOlp.ts.

---

## TL;DR

- **The fallback is a MODEL; OLP is MEASUREMENT.** The fallback (tier_estimate) is one Camry book-hours value stretched by a 4-category x 7-tier multiplier matrix — deductive, vehicle-agnostic except for tier, confidence 0.3, and it also acts as a price floor. OLP is real per-vehicle scraped flat-rate hours, 564-607 jobs per car, no modeling.
- **On the 170 comparable rows the fallback tracks OLP TIGHTER than today RepairPal-fed book_hours:** median |delta| 20% vs 26%, within +/-25% 64.7% vs 49.1%. Both lean high vs OLP.
- **Its weakness is concentrated, not diffuse.** Routine services (battery, diff, alignment, transmission, brake-fluid) are where the fallback actually beats the current RepairPal data. The failure is spark_plugs (engine_access) — the single I4 Camry anchor cannot represent V8/H6 plug access — and it compounds on the high-multiplier tiers (T4 Porsche).
- **The fallback covers PARTS too** (dollars, via a separate multiplier matrix). OLP covers labor hours only — it cannot replace the parts side at all.
- **3 OLP-covered services have NO fallback at all** (rotor_replacement, power_steering_flush, timing_belt) because the Camry baseline has no anchor hour for them. 36 OLP rows fall into this gap — only a real source can fill them.
- **Recommendation:** adopt OLP as the real labor source so the tier model reverts to its intended cold-start/floor role. Where OLP is unavailable or scope-mismatched, the fallback is acceptable except spark_plugs and the high tiers.

---

## 1. STRUCTURAL / CONCEPTUAL DIFFERENCES

These are two fundamentally different kinds of object. The fallback is a deductive model; OLP is empirical observation.

| Dimension | FALLBACK (tier_estimate) | OLP |
|---|---|---|
| **What it is** | A computed estimate: one anchor car hours x a tier multiplier | Real per-vehicle flat-rate hours scraped from a labor portal |
| **What determines the number** | Camry_book_hours(service) x LABOR_MATRIX[labor_category(service)][tier(config)]. Produced by computeTierFloor() in convex/lib/quoteEngine.ts. | A direct laborHours field on the OLP laborJobs array, keyed by year + engine slug + drivetrain. No dollar-to-hours reversal. |
| **Vehicle specificity** | None beyond tier. Every car in a tier with the same labor category gets the identical hours. A T1 Civic and a T1 Accord get the same oil_change hours. | Per specific engine variant + drivetrain (e.g. 4.4l-v8-twin-turbo-n63 vs 1.4l-i4-tsi). 564-607 distinct jobs per car. |
| **Coverage (labor)** | Only the 10 services with a Camry anchor hour in seedCamryBaseline.ts. No anchor = no fallback for rotor_replacement, power_steering_flush, timing_belt. | 17/18 configs resolved (94%); 201 of 221 service-pairs have OLP present. No service has zero fleet coverage. |
| **Parts vs labor** | BOTH. A parallel parts engine (resolvePartsCost) scales service_vehicle_specs.parts_cost_low/high in dollars by a separate 9-category pricing_parts_multipliers matrix. | Labor hours only. OLP carries no parts pricing. It cannot substitute for the parts fallback. |
| **Provenance** | Deductive. Camry anchor (source=vdb_camry_baseline, conf 0.9) x spec-locked multiplier matrix (source=spec_v2_locked). | Empirical. Real shop flat-rate data, fetched per vehicle. |
| **Confidence** | 0.3 (hardcoded). Lowest in the system. | Would enter as a high-trust anchor (~0.8) once integrated, equivalent to RepairPal weight. |
| **Dual role** | Both the cold-start estimate AND a floor: if real labor < floor, the floor value silently substitutes (tier_floor_applied), keeping the real source tag. | No floor role. It is one observation feeding the weighted median. |
| **Failure mode** | Refuses (ok:false) if the service has no labor category, no multiplier row for the tier, no Camry config, or no Camry anchor hour. Wrong-shape when the I4 Camry cannot represent the target engine architecture. | Missing rows for chain engines on timing_belt (correct), and scope mismatches where the OLP job scope differs from ours (oil_change synthetic-only, etc.). |

**One critical nuance for reading the comparison.** The same fallback number surfaces two ways: (Case B) pure cold-start, source=tier_estimate, conf 0.3, no real data exists; or (Case D) floor-bump, where real data existed but was below the floor, so the floor value is used but the source tag stays the real layer and tier_floor_applied=true. A consumer reading only source cannot tell Case D from a clean real quote — they must check tier_floor_applied.

**Deployment caveat (honest):** the dev deployment (flippant-mink-750) has NO seeded Camry baseline — 0 vdb_camry_baseline rows, 0 Camry configs. The live computeTierFloor would return null fleet-wide today; the fallback is non-functional there until seedCamryBaseline:run executes. The fallback hours in this analysis were reconstructed from the documented ground-truth Camry anchors x the live DB multipliers — and that live matrix matched the ground-truth matrix cell-for-cell.

---

## 2. QUANTITATIVE DIFFERENCES

### Camry anchor hours (the baseline every fallback number scales from)

| Service | Camry book_hours | labor category |
|---|---|---|
| oil_change | 0.5 | routine |
| filter_replacement | 0.3 | routine |
| brake_fluid_flush | 0.7 | routine |
| battery_replacement | 0.4 | routine |
| coolant_flush | 1.0 | routine |
| transmission_service | 1.5 | routine |
| differential_service | 1.15 | routine |
| wheel_alignment | 1.0 | routine |
| spark_plugs | 1.15 | engine_access |
| brake_pad_replacement | 1.4 | brakes |
| **rotor_replacement** | **none** | brakes -> fallback UNAVAILABLE |
| **power_steering_flush** | **none** | routine -> fallback UNAVAILABLE |
| **timing_belt** | **none** | engine_access -> fallback UNAVAILABLE |

Active v2 labor multiplier matrix (confirmed live in DB, matches ground truth cell-for-cell):

| category | T1 | T2a | T2b | T2c | T3a | T3b | T4 |
|---|---|---|---|---|---|---|---|
| routine | 1.0 | 1.0 | 1.1 | 1.2 | 1.3 | 1.5 | 1.7 |
| engine_access | 1.0 | 1.2 | 1.5 | 1.5 | 2.0 | 2.2 | 3.0 |
| brakes | 1.0 | 1.0 | 1.1 | 1.2 | 1.3 | 1.5 | 2.0 |
| diagnostics | 1.0 | 1.2 | 1.4 | 1.5 | 1.7 | 2.0 | 2.5 |

At T1 (11 of 17 configs) every multiplier is 1.0, so the fallback hours equal the raw Camry anchor exactly.

### Headline — fallback-vs-OLP NEXT TO current-book-vs-OLP

| Metric | Fallback vs OLP | Current book_hours (RepairPal-fed) vs OLP | OLP read direction |
|---|---|---|---|
| Comparable rows | 170 | 165 (same rows) | — |
| Median signed delta | +15% | +18% | both lean high |
| Mean signed delta | +15.2% | +21.4% | — |
| **Median |delta|** | **20%** | **26%** | fallback closer |
| **Within +/-25%** | **64.7%** | **49.1%** | fallback closer |
| Over OLP / Under OLP | 96 / 44 | 90 / 46 | both over-read |

**Direction matters: the fallback OVER-shoots OLP on net (96 over vs 44 under).** OLP is the lower reading. But today RepairPal-fed data over-reads even more on the same rows. On these comparable rows the modeled fallback is the tighter fit to real scraped data — a counterintuitive but verified result.

### Per-service: fallback-vs-OLP vs current-vs-OLP (signed median delta, within +/-25%)

| Service (cat) | Camry h | Fallback med delta | FB within 25% | Current med delta | Cur within 25% | Verdict |
|---|---|---|---|---|---|---|
| brake_fluid_flush (routine) | 0.7 | **0%** | **100%** | +14% | 88% | Fallback best routine fit; beats current |
| differential_service (routine) | 1.15 | **0%** | **94%** | -38.5% | 25% | **Fallback far better** — sidesteps FWD chassis_clone near-zero stubs |
| wheel_alignment (routine) | 1.0 | **0%** | **88%** | +42% | 12% | **Fallback far better** — OLP ~flat 1.0h matches anchor; RepairPal ran high |
| battery_replacement (routine) | 0.4 | **-4%** | 71% | +40% | 41% | **Fallback far better** — RepairPal over-counted coding/registration |
| transmission_service (routine) | 1.5 | -11% | 77% | -26% | 35% | Fallback closer; scope (OLP may add pan/filter) |
| coolant_flush (routine) | 1.0 | +20% | 94% | +25% | 77% | Both fine; fallback slightly high but tight |
| filter_replacement (routine) | 0.3 | +20% | 59% | 0% | 59% | Tight at T1; tiny anchor inflates on T2c+ |
| oil_change (routine) | 0.5 | +67% | 18% | +67% | 24% | **SCOPE GAP** — see below; high on both sides |
| brake_pad_replacement (brakes) | 1.4 | +40% | 41% | 0% | 88% | **Current wins** — 1.4h anchor over-states OLP ~1.2h |
| spark_plugs (engine_access) | 1.15 | +28% | **6%** | +33% | 35% | **WORST FIT** — anchor is wrong-shape for engine architecture |
| power_steering_flush (routine) | — | **UNAVAILABLE** | — | +25% | 65% | No Camry anchor; 17 OLP rows exist |
| rotor_replacement (brakes) | — | **UNAVAILABLE** | — | +11% | 71% | No Camry anchor; 17 OLP rows exist |
| timing_belt (engine_access) | — | **UNAVAILABLE** | — | -26% | 50% (n=2) | No Camry anchor (Camry is chain) |

### Per-tier

| Tier | n rows | configs | Median delta | Mean delta | Within +/-25% |
|---|---|---|---|---|---|
| T1 | 110 | 11 | 0% | +13.1% | 70% |
| T2c | 40 | 4 (3 BMW + Volvo) | +20% | +5.5% | 67.5% |
| T3a | 10 | 1 (Mercedes AMG C63) | +22% | +24.3% | 50% |
| T4 | 10 | 1 (Porsche 911 Turbo S) | **+43%** | **+69.2%** | **10%** |

The error grows monotonically with tier. T1 is essentially exact (the multiplier is 1.0). T4 over-inflates almost everything because the high multipliers (engine_access x3.0, brakes x2.0, routine x1.7) blow up every small Camry anchor.

### The concentrated failure: spark_plugs, both directions

The single I4 Camry anchor (1.15h) cannot represent engine plug-access architecture, and the tier multiplier amplifies an already-wrong-shape number:

- **2020 BMW M550i (T2c, V8 N63):** fallback = 1.15 x 1.5 = 1.725h vs OLP 4.5h = -62% undershoot.
- **2018 Porsche 911 Turbo S (T4, H6):** fallback = 1.15 x 3.0 = 3.45h vs OLP 1.0h = +245% overshoot.

Same service, opposite failures. Only 5.9% of spark_plugs rows land within +/-25%. The Porsche T4 config overshoots OLP on all 10 anchored services (spark_plugs +245%, oil_change +112%, brake_pad +75%, coolant +70%, differential +50%).

### Scope mismatches (do NOT read these as fallback inaccuracy)

- **oil_change (+67%):** OLP selected row is synthetic drain-fill only (~0.3h); the Camry 0.5h is full flat-rate oil-change time. (See verification note below — the per-row scope note stated cause is wrong; the direction is right.)
- **transmission_service (-11%):** OLP likely includes pan/filter; our anchor is fluid-only.
- **differential_service (0% fallback):** OLP prices full diff/transaxle service for all configs; FWD cars have no real diff in our data. The flat 1.15h anchor happens to match OLP and sidesteps the FWD near-zero stubs (Jetta 0.2h) that wreck the current-vs-OLP number (-38.5%).

---

## 3. IMPLICATIONS FOR REMOVING REPAIRPAL

**What RepairPal was.** repairpal_motor (weight 0.8) fed labor_observations -> weighted median -> labor_times.book_hours. With a single corroborated RepairPal observation a config reaches confidence 0.8-0.9, clearing the MIN_VDB_CONFIDENCE = 0.75 quote gate. RepairPal covered 7 of the 13 services (oil_change, spark_plugs, timing_belt, brake_pad_replacement, rotor_replacement, battery_replacement, wheel_alignment).

**What breaks when it is removed.** Every config with a RepairPal observation for those 7 services recomputes to LLM-only confidence (0.4-0.6), fails the 0.75 gate, and falls to tier_estimate (conf 0.3). The 6 RepairPal-gap services (filter_replacement, coolant_flush, power_steering_flush, transmission_service, differential_service, brake_fluid_flush) are already on tier_estimate today — no additional degradation there.

**So the live question is exactly "modeled tier estimate vs real scraped data," service by service:**

### Where the fallback is a fine substitute (deploy with confidence)

These routine services actually track OLP better than the RepairPal data we are losing:

- **battery_replacement** — fallback -4% / 71% within vs current +40% / 41%. RepairPal over-counted registration time the tier model never sees.
- **wheel_alignment** — fallback 0% / 88% vs current +42% / 12%. OLP is a flat ~1.0h shop minimum the anchor matches.
- **differential_service** — fallback 0% / 94% vs current -38.5% / 25%. The flat anchor avoids the FWD chassis_clone noise.
- **brake_fluid_flush** — fallback 0% / 100% within. Cleanest routine fit in the whole dataset.
- **transmission_service** — fallback -11% / 77% vs current -26% / 35%.
- **coolant_flush** — fallback +20% / 94%. Consistent, small offset.

### Where the fallback alone is materially WRONG (OLP coverage matters most)

- **spark_plugs (engine_access)** — the structural failure. -62% to +245% depending on engine architecture; only 6% within +/-25%. The I4 anchor cannot model V6/V8/H6 plug access in either direction. Do not ship spark_plugs on the fallback for T2c+ vehicles.
- **brake_pad_replacement (brakes)** — fallback +40% / 41% vs current 0% / 88%. Here the current RepairPal data is the better source; the 1.4h anchor over-states OLP ~1.2h. Losing RepairPal here is a real regression that OLP would recover (OLP median delta 0%).
- **High tiers (T3a, T4)** — the multiplier amplifies anchor error. T4 is 10% within +/-25%. Any T3/T4 vehicle on pure fallback is suspect across the board.

### Where the fallback CANNOT help at all (only a real source closes the gap)

- **rotor_replacement** (17 OLP configs), **power_steering_flush** (17), **timing_belt** (2): no Camry anchor -> computeTierFloor returns null. 36 of the OLP-present rows are structurally un-quotable by the fallback. Removing RepairPal removes the only real source for rotor_replacement and timing_belt; without OLP these have nothing.

### Recommendation

1. **Adopt OLP as the real labor source** (new source tag, e.g. olp_labor, weight ~0.8 into labor_observations). This is structurally cleaner than RepairPal: direct hours (no RATE_MID dollar-to-hours conversion), per-engine specificity (564+ jobs/car), and it covers all 6 RepairPal-gap services plus the 3 services the fallback cannot touch.
2. **Update the confidence logic** in convex/lib/labor_aggregation.ts — the high-trust ceiling check currently keys on repairpal_motor by name. Generalize it to "any high-trust anchor" (RepairPal OR OLP), otherwise OLP at weight 0.8 still produces <=0.6 and fails the 0.75 quote gate. This is the single load-bearing code change.
3. **This reverts the tier model to its intended role** — cold-start estimate + floor — instead of the primary quote path for the whole enriched fleet.
4. **Before adopting OLP hours directly, resolve scope on:** oil_change (synthetic vs full-service slug), transmission_service (pan/filter scope), differential_service (null OLP for FWD configs), and filter spark_plugs by engine type.
5. **Until OLP is integrated, treat as high-risk on pure fallback:** spark_plugs (all tiers), brake_pad_replacement, anything T3a/T4, and seed the 3 missing Camry anchors (rotor_replacement, power_steering_flush, timing_belt) so the fallback at least exists for them. Also: seed the Camry baseline on the live deployment — the fallback is currently non-functional there.

---

## 4. VERIFICATION (honest)

Three independent verification lenses (arithmetic, framing, data-join) ran against the dataset.

- **data-join: SOUND, zero issues.** Config-key joins complete (17/17), eval fixture correctly excluded, tier read from pricing_tier (runtime source of truth — 3 BMW/Volvo configs have stale assignment-table tiers but pricing_tier is what the engine uses and was used here), live DB matrix matches ground truth on all 28 cells, all 170 comparable rows verified, delta formula correct.
- **arithmetic: MINOR ISSUE (cosmetic).** per_service.fallback_median_h for spark_plugs displays 1.2 but the true median of the 17 fallback values is 1.15. This is an IEEE-754 rounding artifact in a display field only (r1(1.15) -> 1.2). Every per-row fallback_hours stores 1.15 exactly and all delta stats use the exact value — headlines and per-tier numbers are unaffected. All other arithmetic spot-checks pass (T1/T2c/T3a/T4 cases verified).
- **framing: MINOR ISSUE (annotation, not number).** The oil_change scope note says "ours bundles filter" as the cause of the gap. That is inaccurate for the fallback side — seedCamryBaseline.ts tracks oil_change (0.5h) and filter_replacement (0.3h) as separate services, and OLP also lists air filter separately. The real cause is OLP measuring a synthetic drain-fill (~0.3h) vs the Camry full flat-rate (0.5h). The quantitative direction is correct (fallback IS high vs OLP, +67%); only the stated reason is wrong. A secondary framing note flags that the differential_service "FWD cars have no diff" annotation conflates a physical fact with a data-quality concern — but the comparison itself is internally consistent.

**Net:** no material numeric error. Two annotation/display artifacts, both flagged above, neither of which changes any headline, per-service, or per-tier statistic.
