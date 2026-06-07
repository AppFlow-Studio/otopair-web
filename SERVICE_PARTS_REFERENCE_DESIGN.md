# Service Parts Reference — Tiered Parts Design

**Date:** 2026-06-07 · **Branch:** `waleed-flagship`
**Source of truth:** `Otopair_Service_Parts_Reference (1).pdf` (23 canonical services, May 2026)
**Goal:** every service pulls — and prices — exactly the parts the reference says it consumes
(core / as-needed / kit), including fluids (engine oil, coolant, brake fluid, ATF, PS fluid,
gear oil) and consumables (grease, crush washers, wheel weights), with labor-only services
never billing parts.

---

## 0. The critical finding that shapes this design

`resolveWinningPartForService` (`convex/serviceParts.ts:310`) selects **ONE winner across all
of a service's fitments**. The 7-layer selector was designed to pick among candidate SKUs *for
the same part role* (e.g. two oil-filter part numbers), but it runs across *roles*: for
`oil_change`, the candidate pool is oil filter + drain-plug gasket + engine oil, and exactly one
of them is crowned and priced. **Multi-part services are structurally under-priced today.**

Fix: **selection happens per role, not per service.** Group candidates by role
(`oem_parts.subcategory`), run `selectPart` within each role group, return one winner *per
role*, price them all.

**Three more verified findings (consumer/validator/gating audit, 2026-06-07):**

- `getPricedPartsForServices` / `PricedPartsForService` / `secondaryWinner` have **zero live UI
  consumers** — free to reshape. The live quote surface is `computePricedPartsSnapshot`'s flat
  `priced_parts_snapshot` rows; every reader `.map`s or `.reduce`s the list, so multiple rows
  per service is structurally safe. Schema validator additions must be `v.optional`.
- **Fluid capacity is never applied in the live quote path.** Oil is quoted at ONE bottle —
  `quantity_needed ?? 1` in both `toPricedFitment` and `appendWinnerRow`; `oil_capacity_qts`
  reaches quoting nowhere. §4.5 fixes a live pricing bug, not just an enhancement.
- `convex/services/applicability.ts :: isServiceApplicable()` already implements the
  reference's N/A rules (chain-driven → no timing belt, electric PS → no flush, EV, no-diff,
  staggered+directional, min_model_year) but is **dead code with zero callers**. Wire it into
  `listBookableForVehicle` (which today enforces none of the `requires_*` flags).

## 1. Role taxonomy (normalizing the PDF's tiers)

`service_role`: `"core" | "as_needed" | "kit"`

- **core** — on essentially every invoice; locked price. Includes *where-equipped* core items
  (crush washer, cartridge-filter O-ring, Euro wear sensors): their per-vehicle existence is
  resolved by enrichment (the fitment exists or it doesn't) or by a spec flag
  (`has_brake_pad_sensor`, `lsd_additive_required`).
- **as_needed** — situational discovery items (worn coils, thermostat-if-bad, hardware-if-worn);
  these make the quote a *range* instead of a lock.
- **kit** — variant bundles (timing kit + water pump; transmission pan service adds filter +
  gasket; fuel-system medium/deep tiers). Included when the variant is selected; MVP defaults
  to the base variant (drain & fill, light fuel service).

NOT to be confused with (all pre-existing): `oem_parts.part_tier` (oem/aftermarket *quality*),
`VehicleTier` T1–T4 (Temur's pricing tiers), `pricing_tiers` table. New field name is
`service_role` to avoid all three collisions.

## 2. Canonical reference module — `convex/lib/servicePartsReference.ts`

Pure data + pure functions, no ctx. Encodes for each of the 23 services (underscore slugs from
`seeds/seedServices.ts`, matching `part_fitments.service_type`):

- `laborOnly: boolean` (the 8: diagnostic_scan, pre_purchase_inspection, check_engine_light,
  state_inspection, emissions_test, tire_rotation, wheel_alignment, battery_test)
- `roles[]`: `{ roleKey, label, serviceRole, primary?, condition?, quantity, universalFallback? }`
  - `roleKey` aligns with `oem_parts.subcategory` (existing: oil_filter, drain_plug_gasket,
    engine_oil, coolant, spark_plug, front_brake_pad, …; new ones below)
  - `primary: true` marks the headline role (pads for brake job, rotors for rotor job) — used
    for back-compat `winner` field
  - `condition`: `"where_equipped" | "has_brake_pad_sensor" | "lsd_additive_required" |
    "serviceable_filter" | "cvt" | "tpms"` — `where_equipped` resolves implicitly (fitment
    exists or not); flag conditions read spec tables at quote time
  - `quantity`: `{ kind: "fixed", n }` | `{ kind: "per_cylinder" }` | `{ kind: "per_axle", n: 2 }`
    | `{ kind: "fluid", capacityField, unit, packageSize }` (qty = ceil(capacity / packageSize))
  - `universalFallback`: `{ name, defaultPriceUsd }` — when no per-config enriched fitment
    exists for a **core** role, the resolver synthesizes a universal consumable line so core
    coverage never silently drops (grease, washers, DOT4, weights, additives)

### The 15 parts-bearing services (from the PDF)

| service | core roles | as_needed | kit |
|---|---|---|---|
| oil_change | engine_oil (fluid×oil_capacity_qts), oil_filter*, drain_plug_gasket (where_equipped), oil_filter_housing_oring (where_equipped/cartridge) | — | — |
| filter_replacement | air_filter*, cabin_filter | — | — |
| spark_plugs | spark_plug* (per_cylinder) | ignition_coil, intake_manifold_gasket | — |
| timing_belt | timing_belt* | — | timing_kit (tensioner/idlers/seals), water_pump, coolant, serpentine_belt |
| coolant_flush | coolant* (fluid×coolant_capacity_qts) | flush_chemical (universal), thermostat | — |
| transmission_service | atf_fluid* (fluid×fluid_capacity_drain_fill_qts), drain_plug_gasket | — | trans_filter (serviceable_filter), trans_pan_gasket |
| tire_balance | wheel_weights* (universal) | — | — |
| tire_replacement | (separate tire flow — tire/tpms_valve_kit/weights/disposal noted, not resolved here) | — | — |
| brake_pad_replacement | front/rear_brake_pad* (per axle), caliper_grease (universal) | brake_hardware_kit, brake_wear_sensor (has_brake_pad_sensor → core) | — |
| rotor_replacement | front/rear_rotor* (×2/axle), front/rear_brake_pad, caliper_grease (universal) | brake_hardware_kit, brake_wear_sensor (has_brake_pad_sensor → core) | — |
| brake_fluid_flush | brake_fluid* (fluid×brake_fluid_capacity_oz, universal fallback by DOT spec) | — | — |
| battery_replacement | battery* | terminal_protection (universal) | — |
| power_steering_flush | ps_fluid* (fluid×ps_fluid_capacity_oz) | ps_reservoir_filter, reservoir_cap_oring | — |
| differential_service | gear_oil* (fluid×diff_fluid_capacity_qts), drain_plug_gasket ×2 | friction_modifier (lsd_additive_required → core), diff_cover_gasket | — |
| fuel_system_cleaning | fuel_system_cleaner* (universal) | — | induction_spray (medium), intake_manifold_gasket + throttle_cleaner (deep) |

`*` = primary role.

## 3. Schema change (additive only)

`part_fitments.service_role: v.optional(v.string())` — "core" | "as_needed" | "kit". Old rows
lack it → resolver falls back to reference lookup by (service_type, subcategory). No other
schema change required for resolution. `bookings.priced_parts_snapshot` validator gains
optional `service_role` + `quantity_basis` per row (additive).

## 4. Resolver — per-role selection (`serviceParts.ts`)

In `resolveWinningPartForService` after package gate + position filter + hydration:

1. Group candidates by `roleKey = part.subcategory ?? part.category`.
2. `selectPart` per group (unchanged 7-layer logic + confidence gate within the group).
3. Role winner's `service_role` = `fitment.service_role ?? referenceRole(slug, roleKey) ?? "core"`.
4. **Universal fallback:** reference core roles with no group AND a `universalFallback` →
   resolve the seeded universal part (`oem_parts` `make_id=null`, `category="consumable"`,
   subcategory=roleKey) and price it via the normal `summarizePartPrices` path.
5. **Fluid quantity:** roles with `quantity.kind === "fluid"` get qty = ceil(capacity /
   packageSize) from `engines` / `transmissions` / `chassis_specs` / `drivetrain_configs`;
   missing capacity → qty 1 + `quantity_basis: "unknown_capacity"` (never block the quote).
6. Return shape (back-compat): `ResolvedServiceWinner` keeps `winner` (= primary role's winner)
   + `losers` (primary role's alternates) and adds `roleWinners: RoleWinner[]` (all roles,
   each `{ candidate, roleKey, serviceRole, quantity, quantityBasis }`), per-role `trace`.
7. `getPricedPartsForServices`: `PricedPartsForService` adds `parts: PricedFitment[]` (all role
   winners; `PricedFitment` gains `service_role`, `role_key`, `quantity_basis`);
   `partsTotal` = Σ core+kit-selected winners; new `asNeededTotal` = Σ as_needed (range adder).
8. `computePricedPartsSnapshot`: one snapshot row per role winner (rows already an array).
9. **Labor-only guard:** `service.is_labor_only === true` → return no parts immediately.

## 5. Enrichment expansion (`convex/vehicleEnrichment/`)

New `*_oem` fields — every edit point in lockstep (PART_FIELD_MAP `v3pipeline.ts:516`,
`parseBatch1a` :136, `parsePackageParts` :189, `V4_FIELD_KEYS` types.ts:304, batch-1 prompt
schema + fluid-SKU instructions, sourceRegistry slugs where pages exist):

| new field | category/subcategory | service | role |
|---|---|---|---|
| oil_filter_housing_oring_oem | gasket/oil_filter_housing_oring | oil_change | core (cartridge engines; null otherwise) |
| ignition_coil_oem | ignition/ignition_coil | spark_plugs | as_needed |
| intake_manifold_gasket_oem | gasket/intake_manifold_gasket | spark_plugs | as_needed |
| timing_kit_oem | timing/timing_kit | timing_belt | kit |
| water_pump_oem | cooling/water_pump | timing_belt | kit |
| atf_fluid_oem | fluid/atf_fluid | transmission_service | core |
| trans_filter_oem | filter/trans_filter | transmission_service | kit |
| trans_pan_gasket_oem | gasket/trans_pan_gasket | transmission_service | kit |
| brake_fluid_oem | fluid/brake_fluid | brake_fluid_flush | core |
| ps_fluid_oem | fluid/ps_fluid | power_steering_flush | core |
| gear_oil_oem | fluid/gear_oil | differential_service | core |
| friction_modifier_oem | fluid/friction_modifier | differential_service | as_needed |
| brake_hardware_kit_front_oem / _rear_oem | brake/front(rear)_brake_hardware_kit | brake_pad_replacement | as_needed |
| brake_wear_sensor_front_oem / _rear_oem | brake/front(rear)_brake_wear_sensor | brake_pad_replacement | as_needed (core when has_brake_pad_sensor) |

Prompt rule (extends the existing oil/coolant rule at `batch1Prompt.ts:204`): for every fluid
field return the **OEM fluid SKU** (bottle part number), never the spec string; null when N/A
(e.g. atf null on manual, gear_oil null without serviceable diff, brake wear sensors null on
non-sensor cars, oring null on spin-on engines). Conditional existence is thereby encoded by
the data itself.

`upsertPartAndFitment` gains `service_role` arg; stamps it on fitments. It also **rejects**
labor-only service_types (defense in depth). Rotor-job pads: solved at *resolve* time, not
enrichment time — a reference role may declare `fitmentService: "brake_pad_replacement"` and
the resolver pulls that role's candidates from the borrowed service_type. No duplicate fitment
rows, no enrichment cross-write.

**Universal consumables lane** (no per-config enrichment): seed mutation writes `oem_parts`
rows (`make_id` null, category `consumable`) + `part_prices` seed rows (`price_type:
"manual_seed"`) for: caliper_grease, brake_cleaner?, terminal_protection, wheel_weights,
fuel_system_cleaner, induction_spray, coolant_flush_chemical, dot3/dot4/dot4lv brake fluid,
rtv_sealant. Resolver falls back to these per §4.4. Director can correct prices later;
mechanic ± nudges still apply.

## 6. Cleanups / backfills (extend `convex/vehicleEnrichment/backfills.ts`, flag-gated dry-run→live)

1. **Orphan fitments:** 845/1060 fitments reference deleted `oem_parts` ids → delete (logged,
   reversible via log table, same pattern as the price backfill).
2. **Role stamping:** existing fitments get `service_role` from the reference by
   (service_type, subcategory).
3. Malformed `position: "Front, LEFT, RIGHT"` row → "front".
4. `battery_replacement.requires_parts` → true (seed + live patch).
5. Labor-only stray sweep (currently zero rows — cheap insurance, keeps invariant enforced).

## 7. What stays untouched

- `partSelector.ts` 7-layer logic (now runs per role group — same algorithm).
- `quoteUnitPrice` / `PARTS_PRICE_SOURCE` median flag (all new lines flow through it).
- package_code gating, VIN-sticky preference (applies within the primary role group).
- Temur's quoteEngine/vehicleTiers fixed-pricing path (separate system).
- Tire replacement flow (separate tire tables).
- Wiper/serpentine orphan service_types (not in the 23 — flagged to team, not deleted).
