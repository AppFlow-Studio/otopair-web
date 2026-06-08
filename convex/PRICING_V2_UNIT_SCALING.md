# Pricing v2 — Unit Scaling

How OtoPair prices any service on any vehicle from a single 2020 Camry baseline.

This is the **scaling layer** added in Phase 5 on top of the locked Pricing v2 spec (May 29, 2026). The spec defines the multiplier matrix; this layer defines how a per-axle / per-cylinder / per-quart Camry band converts to a service total on a V8 Audi RS6 (or any other car).

---

## The formula

```
service_total_parts_band  =  camry_baseline_band
                          ×  parts_multiplier[parts_category, vehicle_tier]
                          ×  AWD_surcharge_if_applicable
                          ×  (vehicle_unit_count / camry_baseline_unit_count)
```

The first three factors are the spec. The fourth — `unit_count / baseline_count` — is the scaling layer.

### Worked examples

**2024 Alfa Stelvio Ti @ T2c — brake pads, both axles**
- Camry baseline: `$55–$62` per axle (front pad set, 04465-AZ227)
- T2c brake_pads multiplier: `2.7×`
- Per-axle engine band: `$148.50–$167.40`
- Vehicle unit count: 2 axles (booking position = "both"), baseline = 1 axle
- **Service total: `$297–$335`**

**2023 BMW M5 (S63) @ T3a — spark plugs, V8**
- Camry baseline: `$80–$90` for 4 plugs
- T3a spark_plugs multiplier: `2.5×`
- Per-cylinder engine band: `$50–$56.25`  (the $80–$90 × 2.5 / 4 cyl)
- Vehicle unit count: 8 cylinders, baseline = 4
- **Service total: `$400–$450`**

**2026 Ford F-150 EcoBoost @ T2b — oil change, 6qt sump**
- Camry baseline: `$50–$56` for 5qt sump
- T2b oil_filter multiplier: `1.8×`
- Per-qt engine band: `$18–$20.16`
- Vehicle unit count: 6 qts (from `engines.oil_capacity_qts`), baseline = 5
- **Service total: `$108–$120.96`**

---

## The three building blocks

### 1. Camry anchor (`service_vehicle_specs` keyed to the 2020 Camry LE FWD engine)

One row per service. Carries the dealer parts-counter ±6% band AND the new `parts_baseline_unit_count` — how many units that band represents on the Camry. Seeded by `seeds/seedCamryBaseline:run`.

### 2. Tier multiplier matrix (`pricing_parts_multipliers`)

9 parts categories × 7 tiers = 63 cells. Seeded by `seeds/seedPricingV2:seedAll`. Locked by Yassin's May 2026 spec — do not edit cells without spec sign-off.

### 3. Unit scaling (`services.parts_kind` + `lib/serviceUnits.ts`)

Classifies each of the 23 canonical services by how its parts quantity scales across vehicles. Seeded by `seeds/seedServiceParts:run`.

---

## The 5 `parts_kind` values

| Kind | Scaling source | Camry baseline | Example services |
|---|---|---|---|
| `labor_only` | n/a | n/a — no parts | diagnostic_scan, tire_rotation, wheel_alignment, state_inspection, … |
| `per_axle` | booking position (`front`/`rear`/`both` → 1 or 2) | 1 axle | brake_pad_replacement, rotor_replacement |
| `per_cylinder` | `engines.spark_plug_quantity ?? engines.cylinders` | 4 cyl | spark_plugs |
| `per_unit_spec` | `engines.<capacity_field>` (declared on the service via `parts_unit_spec_source`) | varies | oil_change (5qt), coolant_flush (7qt), transmission_service (4qt) |
| `per_wheel` | fixed 4 | 4 | tire_balance, tire_replacement |
| `fixed_kit` | always 1 | 1 | filter_replacement, battery_replacement, timing_belt, brake_fluid_flush, power_steering_flush, differential_service, fuel_system_cleaning |

`per_unit_spec` reads from one of these engine fields, named by `services.parts_unit_spec_source`:
- `oil_capacity_qts`
- `coolant_capacity_qts`
- `transmission_fluid_capacity_qts`
- `differential_fluid_capacity_qts`

The allowlist lives in `lib/serviceUnits.ts:VALID_ENGINE_SPEC_FIELDS`. Adding a new spec source means extending both the schema (new `engines.*` field) and that constant.

---

## Data flow

```
┌────────────────────────────────┐
│ Mobile: ReviewPayContent /     │   Reads selectedServiceOptions →
│         payment.tsx            │   builds service_positions map
└──────────────┬─────────────────┘
               │ useBookingQuoteFallback(shop, owner, services, positions)
               ▼
┌────────────────────────────────┐
│ Server: quotes:                │   Resolves vin → vehicle_config,
│ previewForBookingQuery         │   detects tier if missing.
└──────────────┬─────────────────┘
               │ resolveQuoteSeries
               ▼
┌────────────────────────────────┐
│ lib/quoteEngine.ts:buildQuote  │   Per service:
│   1. resolveLaborHours         │     hours from labor_times or tier_estimate
│   2. resolvePartsCost          │     band × multiplier × AWD surcharge
│   3. resolveServiceUnitCount   │     count from engine field / position
│   4. scale by count/baseline   │
└──────────────┬─────────────────┘
               │ Quote.parts: { low, high, per_unit_low, per_unit_high,
               │                unit_count, baseline_count, unit_label }
               ▼
┌────────────────────────────────┐
│ Mobile: getEffectiveParts      │   AI in-band → AI price (no swap)
│                                │   AI out-of-band → engine band wins
└──────────────┬─────────────────┘
               │ Customer sees per-unit band on each OEM row +
               │ scaled total on the service summary line
               ▼
┌────────────────────────────────┐
│ useCreateBookingConvex →       │   Submits midpoint of engine band as
│ bookings.createBatch           │   parts_cost when engine corrected.
│                                │   Server stamps engine_corrected_parts.
└────────────────────────────────┘
```

---

## How to add a new service

You need to touch **one seed file** plus **one Camry spec row**. No engine or mobile code change.

1. **Catalog row** — add the service to whatever onboarding flow inserts into `services` (slug, name, default_labor_hours, parts_multiplier_category_id, labor_multiplier_category_id). Then:

2. **`seeds/seedServiceParts.ts`** — add a row to the `SPECS` array:
   ```ts
   { slug: "your_new_service",
     parts_kind: "per_axle",        // pick from the 5 enum values
     parts_unit_label: "axle",      // display copy
     // parts_unit_spec_source only for per_unit_spec
   },
   ```
   Re-run: `npx convex run seeds/seedServiceParts:run`

3. **`seeds/seedCamryBaseline.ts`** — add a row to the `BASELINE` array with the Camry's dealer parts band AND the baseline unit count:
   ```ts
   { service_slug: "your_new_service",
     parts_low: 80, parts_high: 90,
     oem_part_number: "ABC-1234",
     parts_cost_basis: "Toyota OEM at NYC counter ±6%",
     applies_to: "shared",            // or "awd_only"
     parts_baseline_unit_count: 1,    // how many units the band represents on the Camry
   },
   ```
   Plus a labor entry in `CAMRY_LABOR_HOURS`. Re-run: `npx convex run seeds/seedCamryBaseline:run`

4. **Verify** — re-run `npx convex run devOnly/validateQuoteEngine:runAll`. The existing 18 examples must still pass; consider adding a new fixture exercising your service against 1–2 tiers.

---

## How to classify a vehicle's brake_system

The engine refuses to quote brake_pad / rotor services on any vehicle whose `pricing_vehicle_assignments` row is missing `brake_system`. Per spec: never assume steel (would under-charge a CCB Porsche by 4–5×).

For T1–T2c vehicles (no CCB option in those tiers): `devOnly/backfillBrakeSystem:run` is idempotent and inserts `iron_standard / ice` defaults for every unclassified config. Safe to re-run after enrichment lands new vehicles.

For T3a / T3b / T4: classify manually via `pricing:assignVehicleTier` (requires auth). These tiers include CCB-optional and CCB-standard cars; the operator must know which trim ships with CCB.

---

## How to debug a wrong quote

1. **Is the engine returning the band?** Call `quotes:previewForBookingQuery` directly from the Convex dashboard with the vehicle_owner_id + service_ids. Inspect `quotes[i].parts.per_unit_low/high` + `unit_count` + `unit_label`.

2. **Is the per-vehicle unit count right?** For per_cylinder, check `engines.spark_plug_quantity` (or `cylinders`). For per_unit_spec, check the field named in `services.parts_unit_spec_source`. For per_axle, the value comes from `service_positions` — the mobile UI builds this from `selectedServiceOptions[serviceId]`.

3. **Is the Camry baseline stamped with unit count?** Check `service_vehicle_specs.parts_baseline_unit_count` for the Camry engine row. If null, `serviceUnits` defaults to `1` (correct for fixed_kit, wrong for everything else).

4. **Is the multiplier present?** Check `pricing_parts_multipliers` for the `(parts_category, tier)` cell. Missing rows → engine refuses.

5. **Did the engine refuse?** Check `q.refuse_to_quote` + `q.reason`. Common causes:
   - `brake_system not classified` — see above
   - `service has no parts_multiplier_category` — onboarding gap
   - `no Camry baseline parts cost for service` — re-seed Camry baseline
   - `differential service not applicable to FWD vehicle` — engine guards FWD

---

## Files

| File | Purpose |
|---|---|
| `convex/schema.ts` | `services.parts_kind/unit_label/unit_spec_source`; `service_vehicle_specs.parts_baseline_unit_count`; `engines.*_capacity_qts` |
| `convex/lib/serviceUnits.ts` | `resolveServiceUnitCount` + `unitScale` |
| `convex/lib/quoteEngine.ts` | `buildQuote` calls `resolveServiceUnitCount`, scales totals, populates `Quote.parts` metadata |
| `convex/quotes.ts` | `previewForBookingQuery` accepts + forwards `service_positions` |
| `convex/seeds/seedServiceParts.ts` | 23-service classification |
| `convex/seeds/seedCamryBaseline.ts` | Camry anchor + `parts_baseline_unit_count` |
| `convex/seeds/setupPricingV2.ts` | One-shot runner that chains all Pricing v2 seeds |
| `convex/devOnly/backfillBrakeSystem.ts` | Safe-default brake_system for T1–T2c |
| `hooks/useBookingQuoteFallback.ts` (mobile) | Exposes `unitCount`, `perUnitLow/High`, `unitLabel` per service |
| `app/booking/mechanic/[id]/payment.tsx` + `components/booking/sheets/ReviewPayContent.tsx` (mobile) | `getEffectiveParts` swaps to engine band when AI out-of-range; per-OEM row shows `$X – $Y / <label>` |

---

## One-shot setup (new deployment / recovery)

```sh
# From otopair-web (CONVEX_DEPLOYMENT points at target):
npx convex run seeds/setupPricingV2:run
```

Runs the four seeds + the safe-default brake_system backfill in the correct order. Idempotent — re-runs against an already-seeded deployment are no-ops on existing rows.
