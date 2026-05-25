# Halo-variant promotion + per-part pricing + transmission canonicalizer + enrichment booking gate

> Branch: `waleed-dev-oto` (forked from `waleed-dev`, merged `origin/temur-dev`)
> Scope: vehicle enrichment correctness + director part-fitments view + headless repair/backfill tooling + booking gate / completion notification

This branch fixes a cluster of related correctness bugs in the vehicle enrichment pipeline, replaces three hardcoded BMW/transmission whitelists with data-driven equivalents, ships a per-OEM-part pricing contract, adds a part-drill-down view to the director panel, ships five headless repair/backfill actions so existing rows can be brought up to date without full re-enrichment, **and adds the backend half of the "Setting up..." lock** — a server-side booking gate plus a push notification fired when enrichment transitions to complete.

No schema migrations required. Every code change is additive at the table level.

---

## TL;DR by area

| Area | What changed | Why |
|---|---|---|
| Halo variants | New curated table (`convex/lib/haloVariantRules.ts`) replaces hardcoded BMW M-car logic. Covers BMW M, AMG, RS, Type R, Blackwing, Hellcat, Trackhawk, Shelby, STI, GR, Lexus F, Z06, etc. + Haiku fallback for long-tail. | Decode pipeline was filing M3 as "3 Series" → wrong wheel-size fitments + false `m_sport` package. Generalizes to every make. |
| Pricing — per-unit | Batch 2 prompt explicitly contracts per-unit prices; storage no longer divides by `fitments.length`. | Spark plug $156/unit on M550i was total ÷ 1 fitment row. |
| Pricing — per-part | Batch 2 now returns `parts_breakdown[]` per service; pipeline writes one `part_prices` row per OEM SKU. | Old per-service contract couldn't surface per-part prices for multi-part services on European makes — BMW oil filter + drain plug gasket both showed zero prices while Honda equivalents got the divide-by-2 artifact ($3.40 each). |
| Engine oil fitment | New `engine_oil_oem` field across the full Batch 1/2 pipeline, mirroring `coolant_oem`. | Oil change had no oil line item — `coolant_flush` correctly bundled coolant but oil_change did not. |
| Transmission type | New `lib/transmissionTypeInference.ts` (Haiku + in-memory cache + canonical-vocab fast path). Removed hardcoded marketing-name whitelists from `vehicle_pipeline.ts` and `v3pipeline.ts`. | Porsche PDK and Honda Civic automatic both showed `type: unknown` despite enriched `fluid_type`. AI's `transmission_type` was parsed but never wired to the writer. |
| Director UI | `vehicle_configs` detail modal now lists every attached part with a collapsible accordion per service. Clicking a part opens a side drawer showing prices + sources + evidence. | No surface existed to inspect what parts a config had attached. |
| Repair tooling | Five headless actions in `convex/diagnoseVin.ts` — per-VIN repair, per-VIN reprice, per-VIN oil backfill, bulk oil backfill, bulk price backfill. | Code-only fixes don't repair already-enriched rows. These bring existing data up without full re-enrichment. |
| Booking gate + completion notification | Server-side gate in `bookings.create` blocks parts-dependent services while `enrichment_status !== "complete"`. Push notification fires once on the partial → complete transition (idempotent across re-runs). New `diagnoseVin:enrichmentLockState` query for QA. | Backend half of the "Setting up..." UX: a freshly-decoded VIN can't be booked for oil change / brake replacement / etc. until enrichment finishes (~8 min), then the owner is pinged that the car is ready. |
| Brake-config ticket audit | **No code change in this branch** — audit finding only, documented in §9. Surface for the team: `serviceParts.ts` already has the full variant resolver (`getPartsForService` etc.). But a hyphens-vs-underscores mismatch between `services.slug` (hyphens) and `part_fitments.service_type` (underscores, written by `v3pipeline.ts:493`) means every parts-dependent service lookup currently returns empty fitments. **Affects every parts-dependent service in production, not just brakes.** Two fix paths documented. | The brake-config ticket's backend is already built — once the slug fix lands, no new resolver code is needed. |

---

## 1. Halo-variant system (replaces BMW-specific hardcoding)

VIN `WBS43AY0XNFM51260` (2022 BMW M3 Competition) was being filed as `model="3 Series", trim="M3 Competition"`. Downstream wheel-size.com lookups hit 330i fitments, and VDB option strings like `"M Sport Steering Wheel"` triggered the loose `/\bM\s*Sport\b/` rule → false `m_sport` package → quoting upsold the wrong brake/rotor parts.

Generalized because the same class hits AMG, RS, Type R, Blackwing, Hellcat, Trackhawk, Shelby, STI, GR, Lexus F, Z06, NSX, GT-R, etc.

### New files

| File | Purpose |
|---|---|
| `convex/lib/haloVariantRules.ts` | Curated table of ~30 halo-variant rules across BMW / MB / Audi / Honda / Acura / Cadillac / Dodge / Jeep / Ford / Chevy / Lexus / Subaru / Toyota / Nissan / Porsche / Hyundai / Kia / VW. Each rule carries `promotedModel` + `hardwareStandard` flag. Pure / synchronous `findHaloVariant(make, model, trim)`. |
| `convex/lib/haloVariantInference.ts` | Haiku-based long-tail fallback. In-memory cached. Called only when a curated rule misses AND downstream catalog returns zero results. |

### Modified files

- **`convex/lib/packageRules.ts`** — added `redundant_when_halo?: boolean` flag on `PackageRule`. Tagged `m_sport`, `m_performance`, `m_performance_brakes`, `amg_line`, `amg_performance_brakes`, `audi_s_line` + their trim-inference variants. Tightened the `m_sport` regex to require a hardware qualifier (`Package|Suspension|Brakes|Differential|Plus|Pro|II`) so `M Sport Steering Wheel` no longer matches even on non-halo BMWs. Removed the over-eager `\bX[3-7]\s*M\b` from the M-Sport trim inference rule (X-M cars are real M-cars, handled by the halo table).
- **`convex/lib/vehicleDatabases.ts`** — `assessAvailablePackages` now calls `findHaloVariant()`, skips any rule with `redundant_when_halo` when the halo's `hardwareStandard` is true.
- **`convex/vehicle_pipeline.ts`** — `processVin` calls `findHaloVariant()` after AI normalization; if it matches, `finalModel` is replaced with the promoted name so the new model row is created under the correct name (M3, not 3 Series).
- **`convex/vehicleEnrichment/utils/wheelSizeScraper.ts`** — `scrapeWheelSizeOptions` consults `findHaloVariant()` first, then falls back to `inferHaloVariantWithHaiku()` when both the rule misses AND wheel-size returns zero results. Three log lines added so the promotion is visible in Convex logs.

### How to extend

Add one row to `HALO_VARIANT_RULES` in `haloVariantRules.ts`. No code changes at any call site.

---

## 2. Pricing — per-unit storage (Bug A)

M550i spark plug shown as `$156/unit` in the director UI. Investigation: Batch 2 returned a service-level `parts_cost_low`; storage divided by `fitments.length` (count of distinct OEM SKUs per service, almost always 1), so a total like $1,250 for 8 plugs stamped as `$156/plug` after a divide-by-1.

### Changes

- **`convex/vehicleEnrichment/prompts/batch2Prompt.ts`** — RULE 1 now explicitly contracts `parts_cost_low/high` as **per-unit retail of one OEM part**, with worked examples (spark plug, brake pad set, oil filter, battery). Eliminates the per-unit-vs-total ambiguity Claude was guessing on.
- **`convex/vehicleEnrichment/v3pipeline.ts`** — Removed `priceVal / fitments.length`. Stores `priceVal` directly on every fitment. The old division never compensated for true quantity.

---

## 3. Pricing — per-part contract (Bug C, real fix)

Same category, two cars: Honda Civic showed both oil filter + drain plug gasket at exactly `$3.40` from `hondapartsnow.com` (the divide-by-2 artifact). BMW M550i showed `$0` for both. Root cause: Batch 2's prompt asked for **one price per service**, not per OEM part. For Honda this worked because both SKUs lived on the same page near identical prices. For BMW (filter on FCP Euro at $X, gasket on a different page at $Y), Claude couldn't synthesize a single number and returned `null`, which the write loop's `if (svc.parts_cost_low?.value == null) continue` guard then skipped.

### Changes

- **`convex/vehicleEnrichment/prompts/batch2Prompt.ts`** — Service response shape adds `parts_breakdown: [{ oem_part_number, price_low, price_high, source_url, confidence }, ...]`. RULES 2-3 demand itemization; RULE 6 says omit unfound parts (don't null-fill). Example payload updated.
- **`convex/vehicleEnrichment/types.ts`** — New `PartPriceBreakdownEntry` interface. `ServicePricingResult.parts_breakdown: PartPriceBreakdownEntry[]`.
- **`convex/vehicleEnrichment/v3pipeline.ts`** — `parseBatch2` parses the breakdown, sanitizes URLs, strips blocked domains, drops entries without a usable `price_low`.
- **`convex/vehicleEnrichment/v3queries.ts`** — `getFitmentsByConfigAndService` joins `oem_part_number` from `oem_parts` so the write loop can match Batch 2's breakdown back to `part_id` without an N+1.
- **`convex/vehicleEnrichment/v3pipeline.ts`** (write loop) — Rewritten. Iterates `parts_breakdown` first, writes each per-part price independently of the service-level total. Falls back to service-level price only when Claude couldn't itemize.
- **`convex/vehicleEnrichment/pipelineBatch.ts`** — Legacy v6/v7 parser emits empty `parts_breakdown: []` to satisfy the shared type.

### Result

A BMW oil_change with `parts_cost_low: null` now still writes prices for the filter, gasket, and oil bottle as long as Claude itemized them per-SKU. Honda's $3.40 / $3.40 artifact goes away — each part gets its own per-SKU search and price.

---

## 4. Engine oil fitment (Bug B)

`coolant_flush` correctly bundled the OEM coolant SKU; `oil_change` had no equivalent for engine oil. The only oil info captured was the viscosity string (`oil_viscosity: "0W-30"`) — no OEM bottle SKU, no price line.

### Changes — `engine_oil_oem` mirrors `coolant_oem` exactly across 10 touchpoints

| File | Change |
|---|---|
| `convex/vehicleEnrichment/prompts/batch1Prompt.ts` | JSON example + reminder with worked SKU examples (BMW 83215A2AF99, Toyota 00279-0WQTE, MB A0009898301). Prompt prefers the 1-qt/1-L bottle SKU so quoting multiplies by `oil_capacity_qts`. |
| `convex/vehicleEnrichment/prompts/batch2Prompt.ts` | Field description for pricing call. |
| `convex/vehicleEnrichment/v3pipeline.ts` | `parseBatch1a` parser (3 sites), `PART_FIELD_META` entry mapped to `serviceSlug: "oil_change"`, category `fluid`, subcategory `engine_oil`. |
| `convex/vehicleEnrichment/types.ts` | Added to `V4_FIELD_KEYS`. |
| `convex/vehicleEnrichment/pipelineBatch.ts` | Legacy parser includes the field. |
| `convex/vehicleEnrichment/tier2Enrichment.ts` | `ENRICHABLE_FIELDS` + the gap-fill query both include it. |
| `convex/vehicleEnrichment/sourceRegistry.ts` | Slug map entry → `engine_oil`. |
| `convex/vehicleEnrichment/sourceDiscovery.ts` | Keyword set for scraper extraction. |

`quantity_needed: 1` on the resulting fitment; quoting multiplies by `engine_specs.oil_capacity_qts` at quote time — identical pattern to how coolant is sized via `coolant_capacity_qts`.

---

## 5. Transmission type canonicalizer (replaces hardcoded vocabulary)

Porsche PDK and 2012 Honda Civic EX automatic both showed `type: unknown` with `fluid_type: enriched`. Root cause: Claude's `attributes.transmission_type` arrived in `fields.transmission_type` via `parseBatch1a`, but the write call at `v3pipeline.ts:654` passed only `fluid_type` and `data_quality` — `type` was never forwarded. The decode-time normalizer (`mapTransmissionStyle` in `vehicle_pipeline.ts`) was an 8-marketing-term whitelist that didn't recognize NHTSA's `"Direct shift gearbox (DSG)"` either.

### Approach

Avoided hardcoding by introducing a single Haiku-based canonicalizer with an in-memory cache. Removed both hardcoded keyword lists.

### New file

**`convex/lib/transmissionTypeInference.ts`** — `canonicalizeTransmissionType(raw)`:

- **Fast path** — input already in canonical vocab (`"automatic"`, `"manual"`, `"CVT"`, `"DCT"`, case-insensitive). Zero cost, no Claude call. Only hardcoded thing in the module, and it's our own published vocabulary.
- **Haiku classifier** — anything else (`PDK`, `DSG`, `S tronic`, `SpeedShift MCT`, `Tiptronic`, `Direct Shift Gearbox`, `Single-Speed Reduction Gear`, etc.) goes to Haiku with a strict one-token-response prompt. Result cached per `raw.toLowerCase()`.
- Returns `null` when Haiku is unavailable or response doesn't match the canonical set — callers leave the field untouched, no garbage writes.

### Modified

- **`convex/vehicleEnrichment/v3pipeline.ts`** — `writeNormalizedData` now passes `type: (await canonicalizeTransmissionType(fields.transmission_type?.value)) ?? undefined` to `updateTransmissionSpecs`. **This is the actual wiring fix — Claude's answer now reaches the DB.** Also removed inline `mapTransmissionStyleLocal`.
- **`convex/vehicle_pipeline.ts`** — `processVin` uses `canonicalizeTransmissionType` instead of the old keyword whitelist. Removed `mapTransmissionStyle` export entirely.

When a new transmission marketing term lands (e.g. "Lexus Direct Shift-CVT"), one Haiku call answers it and every subsequent VIN with that string is a cache hit. No code change ever needed.

---

## 6. Director panel — part fitments view

`vehicle_configs` detail modal previously showed a chip-style summary of fitments-per-service with no way to inspect individual parts. Replaced with a grouped accordion + side-drawer drill-down.

### New Convex queries — `convex/directorCars.ts`

- **`vehicleConfigFitments(vehicle_config_id)`** — returns all `part_fitments` for a config, grouped by `service_type`, base fitments before package-specific ones. Each row enriched with `oem_part_number`, `name`, `brand`, `category`, `subcategory`, `partTier`, `priceCount`.
- **`partFitmentDetail(part_id, vehicle_config_id?)`** — full part identity + all `part_prices` (sorted) + `enrichment_evidence` scoped to the vehicle_config (pipeline writes part-field evidence under `entity_type="part", entity_id=vehicle_config_id`).

### Modal extension — `app/(director-panel)/director/components/Primitives.tsx`

Added a generic `rightDrawer?: { open, onClose, width?, children }` prop on `Modal`. Stacks alongside the existing `auditDrawer` — both can be open simultaneously. Drawer chrome (border, shadow, radius) handled by Modal; caller provides header/body/footer in `children`. Fixed a React shorthand/longhand warning on the button styles (split `border:'none'` into `borderTop/Left/Right` longhands when `borderBottom` was being set conditionally).

### Tab wiring — `app/(director-panel)/director/components/tabs/TabVehicleConfigs.tsx`

- `ConfigModal` calls `vehicleConfigFitments` query, renders one collapsible card per service (compact by default — just header + count). Click a service header to expand its parts inline; **Expand all** toggle in the section header.
- Each part row shows OEM number, name, brand, package badge (or "base"), quantity, confidence. Click row → side drawer slides in.
- `PartFitmentDrawerBody` component shows part identity, all recorded prices (sorted, with clickable source URLs), and the enrichment evidence list.
- New state `partDrawerPartId: Id<'oem_parts'> | null` — resets when modal closes / config changes.

---

## 7. Headless repair / backfill tooling — `convex/diagnoseVin.ts`

Code-only fixes don't repair existing rows. Five actions for the operator to bring DB state current without full re-enrichment.

| Action | Scope | What it does |
|---|---|---|
| `byVin` | per-VIN | (pre-existing) inspect the resolved state of a VIN |
| `repairVin` | per-VIN | Re-runs wheel-size with halo promotion + strips packages tagged `redundant_when_halo` when the vehicle matches a halo rule with `hardwareStandard=true` |
| `repricePartsForVin` | per-VIN | Sonnet + web_search re-asks per-unit OEM prices for every fitment, writes to `part_prices`. Dedupes by SKU — pays Claude once per OEM number even when the same SKU appears under multiple services |
| `backfillEngineOilForVin` | per-VIN | Single Claude call to find the make's bottle SKU + price, `upsertPartAndFitment` + `upsertPartPrice`. Idempotent (`force: true` to overwrite) |
| `backfillAllEngineOilFitments` | bulk | Walks configs newest-first, in-memory cached by `(make, oil_viscosity)`. Args: `limit` (default 25, cap 100), `skipExisting`, `dryRun`, `makeFilter` |
| `backfillAllPartPrices` | bulk | Walks `oem_parts` newest-first, dedup by SKU. Args: `limit` (default 50, cap 200), `skipExisting` (false = full reprice), `dryRun`, `makeFilter` |

### Recommended order for an existing pre-fix VIN

```bash
npx convex run diagnoseVin:repairVin '{"vin":"..."}'             # tires + m_sport strip
npx convex run diagnoseVin:backfillEngineOilForVin '{"vin":"..."}' # add missing oil
npx convex run diagnoseVin:repricePartsForVin '{"vin":"..."}'      # per-unit reprice
```

For bulk fill-the-gaps across the DB:

```bash
npx convex run diagnoseVin:backfillAllEngineOilFitments '{"limit":50,"dryRun":true}'
npx convex run diagnoseVin:backfillAllPartPrices '{"limit":100,"dryRun":true}'
```

Each bulk action returns `{ candidates, summary, results }` so you can diff before/after and watch for the `claude_unknown` bucket (parts Claude can't find a price for — dealer-gated BMW SKUs are the common case).

---

## 8. Booking gate + completion notification (backend half of "Setting up…")

Closes the backend portion of the My Cars / booking-flow lock task. Frontend pieces ("Setting up..." pill, error string parsing in the booking flow) are scoped to a separate workspace and will land in a follow-up PR.

### Sub-tasks shipped here

- ☑ **Server-side booking gate** — `bookings.create` rejects parts-dependent services when `enrichment_status !== "complete"`.
- ☑ **Push notification on completion** — fires exactly once per (config, owner) on the partial → complete transition.
- ☑ **QA diagnostic** — `diagnoseVin:enrichmentLockState` returns the lock state at a glance.

### Sub-tasks deferred to FE workspace

- ☐ My Cars UI: "Setting up..." pill while pending or partial
- ☐ Booking flow: catch the gate error and render the "still setting up" state instead of a generic error toast
- ☐ Live-alerts rendering of `category: "vehicle_enrichment_complete"`

### 8a. Booking gate — `convex/bookings.ts:756-781`

Inserted after the existing ownership check, before the time-slot reservation patch (so a denied booking doesn't burn a slot hold). Labor-only services bypass the gate.

```ts
const service = await ctx.db.get(args.service_id);
if (!(service as any).is_labor_only) {
  const config = (vehicle as any).vehicle_config_id
    ? await ctx.db.get((vehicle as any).vehicle_config_id)
    : null;
  if ((config as any)?.enrichment_status !== "complete") {
    throw new Error(
      "VEHICLE_ENRICHMENT_INCOMPLETE: We're still setting up this vehicle's parts catalog. " +
      "Please try again in a few minutes — we'll notify you when it's ready.",
    );
  }
}
```

The error message starts with `VEHICLE_ENRICHMENT_INCOMPLETE:` so the FE can pattern-match it to render the lock state cleanly instead of surfacing a generic error toast. Anything else (missing service row, missing config) throws a normal error.

### 8b. Completion notification — `notifyEnrichmentComplete` mutation

**New internal mutation in `convex/vehicleEnrichment/v3mutations.ts`**:
- Resolves vehicle(s) attached to the config via `vehicles.by_vehicle_config`.
- For each vehicle, queries `vehicle_owners` by VIN (active only).
- For each active owner, calls `enqueueNotificationOutbox` (exported from `convex/bookings.ts`) with:
  - `channel: "push"`
  - `category: "vehicle_enrichment_complete"`
  - `dedupe_key: enrichment_complete_${configId}_${userId}` (per-owner)
  - `payload: { vehicle_id, vehicle_config_id, vin, year, make, model, trim, title, body }`

The payload includes display-ready `title` (`"Your car is ready"`) and `body` (`"YEAR MAKE MODEL is set up — you can now book parts-dependent services."`) so the FE alert renderer can use them verbatim.

**Trigger site** — `convex/vehicleEnrichment/v3pipeline.ts`, after the post-fallback fill-rate recalc:

```ts
const updated = await ctx.runQuery(
  internal.vehicleEnrichment.v3queries.getVehicleConfigById,
  { vehicleConfigId: args.vehicleConfigId },
);
const previousStatus = (currentVcForFinal as any)?.enrichment_status;
const newStatus = (updated as any)?.enrichment_status;
if (previousStatus !== "complete" && newStatus === "complete") {
  await ctx.runMutation(
    internal.vehicleEnrichment.v3mutations.notifyEnrichmentComplete,
    { vehicle_config_id: args.vehicleConfigId },
  );
}
```

`currentVcForFinal` was already read earlier in the handler (line 2040, well before any writes), so comparing it to the post-fallback final state catches the genuine transition without re-firing on re-enrichment of an already-complete config.

**Dedup behavior**: `enqueueNotificationOutbox` already de-dupes against `pending` / `dispatching` rows by `dedupe_key`, so the trigger is safe to re-invoke. The previousStatus guard is the stronger idempotency — once a config has reached `complete`, subsequent `enrichVehicleBatchV3` runs see `previousStatus === "complete"` and skip the notify call entirely.

### 8c. QA diagnostic — `diagnoseVin:enrichmentLockState`

```bash
npx convex run diagnoseVin:enrichmentLockState '{"vin":"..."}'
```

Returns:
```jsonc
{
  "status": "ok",
  "vin": "...",
  "enrichment_status": "partial",
  "fill_rate": 62,
  "is_locked": true,
  "last_enriched_at": 1735...,
  "config_id": "...",
  "locked_service_count": 18,
  "sample_locked_services": ["Oil Change", "Spark Plug Replacement", ...]
}
```

When `enrichment_status === "complete"`, `is_locked` is `false` and `locked_service_count` is `0`. Lets QA verify the lock at a glance without parsing the full `byVin` output.

### 8d. Shared helper export

**`convex/bookings.ts`** — added `export` keyword to `enqueueNotificationOutbox`. This is the only modification to the existing notification helper; behavior is unchanged. Required so `v3mutations.ts` can import it without duplicating the dedup logic.

---

## 9. Brake-config ticket audit — backend is mostly done, but a slug-format bug blocks it

> **Heads up for whoever picks up the brake-config booking flow ticket.** The data layer + resolver are already built — you do NOT need to add a `brake_variants` table or a per-VIN package answer mechanism. But there's a foundational slug-format mismatch that has to be fixed before the existing resolver returns anything for parts-dependent services. **This is currently blocking not just brakes — every parts-dependent service lookup in production is silently returning zero fitments today.**

### 9a. What already exists (do NOT re-implement)

`convex/serviceParts.ts` is the booking-time parts resolver. Five symbols:

| Symbol | What it does |
|---|---|
| `getPartsForService(serviceSlug, vehicleOwnerId)` | Returns `{ status: "needs_user_input", questions }` OR `{ status: "resolved", fitments }`. Reads `vehicle_owner_specs.confirmed_packages` / `denied_packages`, filters `part_fitments` by `package_code == null OR confirmed.has(package_code)`. **This IS the brake variant resolver the ticket calls for.** |
| `getOemPartsForBooking(bookingId)` | Pre-job informational view (base parts only). Already wired to [components/booking-detail-panel.tsx:625](components/booking-detail-panel.tsx:625). |
| `getPricedPartsForServices(vehicleOwnerId, serviceIds[])` | Same resolution logic + joins `part_prices` via `summarizePartPrices` for Review & Pay breakdown. |
| `getPendingPackageQuestions(vehicleOwnerId)` | Lists every unanswered package question across all services. |
| `recordPackageAnswers(vehicleOwnerId, confirmed[], denied[])` | Persists per-VIN answers to `vehicle_owner_specs`. |

**No `brake_variants` table is needed.** Variants are encoded via `part_fitments.package_code` (null = base, set = package-specific override) + `vehicle_owner_specs.confirmed_packages` (the user's per-VIN answers). Better architecture than what the brake-config ticket assumed.

**Architecture finding for the front/rear axle selection** — Front/Rear/Both is NOT separate services. It's a `service_options` row with `option_type: "axle_position"` per [convex/seed.ts:1037-1097](convex/seed.ts:1037). One `brake-pad-replacement` service with three picker options (Front only / Rear only / Both). The auto-pair UX is purely a FE concern; the backend doesn't need wheel-level granularity.

### 9b. The bug — slug format mismatch (writer vs reader)

Three string-format islands in the codebase that should be one:

| Source | Format | Example |
|---|---|---|
| Production `services.slug` (from [seed_services_catalog.ts:132](convex/seed_services_catalog.ts:132)) | **hyphens** | `brake-pad-replacement` |
| `packageRules.services_affected` (from [lib/packageRules.ts:96](convex/lib/packageRules.ts:96)) | **hyphens** ✓ matches services | `["brake-pad-replacement", "brake-rotor-replacement"]` |
| `SERVICE_NAME_TO_SLUG` in [v3pipeline.ts:493](convex/vehicleEnrichment/v3pipeline.ts:493) (writes `part_fitments.service_type` during enrichment) | **underscores** ✗ does NOT match | `"Brake Pad Replacement - Front" → "brake_pad_replacement"` |

**Net effect:** When `getPartsForService("brake-pad-replacement", ownerId)` runs:
- **Step 1 — package question filtering**: `services_affected.includes("brake-pad-replacement")` MATCHES the package rules ✓ — the per-VIN question DOES surface correctly.
- **Step 2 — fitment lookup**: queries `part_fitments` where `service_type === "brake-pad-replacement"` (hyphens) — but rows were written with `service_type === "brake_pad_replacement"` (underscores). **Zero rows match. Returns `{ status: "resolved", fitments: [] }`.**

So the resolver silently degrades: the FE prompts the user "do you have carbon ceramic brakes?", the user answers, the answer persists — and the booking spec STILL gets no fitments because the index lookup fails. Booking falls back to the service's `default_parts_estimate` (a flat estimate), which is exactly the legacy behavior the brake-config ticket is trying to replace.

**Scope of impact:** This affects EVERY parts-dependent service, not just brakes. Oil change (`oil-change` vs `oil_change`), filter replacement, spark plugs, etc. all have the same mismatch. The only reason this hasn't been noticed in production is the FE has been falling back to `default_parts_estimate` for every service.

### 9c. Two fix paths

**Option A — change the writer to emit hyphens (recommended, but needs a backfill)**

Update `SERVICE_NAME_TO_SLUG`, `INTERVAL_TO_SERVICE`, and `PART_FIELD_META.serviceSlug` in [v3pipeline.ts:493](convex/vehicleEnrichment/v3pipeline.ts:493) to use hyphens everywhere. Then a one-shot backfill on existing `part_fitments` to rewrite `service_type` from underscored to hyphenated form:

```ts
// Pseudo — paginated walk through part_fitments
for (const f of allFitments) {
  if (f.service_type && f.service_type.includes("_")) {
    await ctx.db.patch(f._id, { service_type: f.service_type.replace(/_/g, "-") });
  }
}
```

Same backfill applies to `service_intervals.service_type` and `labor_times.service_type` if they share the format. After backfill, every reader path works without code changes.

**Option B — normalize at read time (no backfill, less invasive)**

Update `getFitmentsByConfigAndService` in [v3queries.ts:113](convex/vehicleEnrichment/v3queries.ts:113) (and the equivalent direct reads in `serviceParts.ts`) to query both forms:

```ts
const fitments = [
  ...await ctx.db.query("part_fitments").withIndex("by_config_service", q =>
    q.eq("vehicle_config_id", configId).eq("service_type", slug)).collect(),
  ...await ctx.db.query("part_fitments").withIndex("by_config_service", q =>
    q.eq("vehicle_config_id", configId).eq("service_type", slug.replace(/-/g, "_"))).collect(),
];
```

Cheaper to ship, but leaves the data inconsistent (new writes still go in underscored, old code paths could be confused later). Recommended only if a backfill is risky in the current window.

### 9d. Brake-config ticket sub-task status after this branch

Once the slug fix lands (Option A or B), Waleed's brake-config backend is **done**. Mapping back to the original ticket's checklist:

| Sub-task | Status |
|---|---|
| Front/back/both selection logic + auto-pair behavior | Backend ready (`service_options` picker exists). FE work only. |
| Brake variant resolution from VIN → variant lookup | ✓ `getPartsForService` handles it (no `brake_variants` table needed) |
| Resolution hierarchy: per-VIN override → mechanic history → trim default | ✓ override + base. **Mechanic history tier is NOT implemented** — could fall back to `shop_part_preferences` if needed; skip for MVP. |
| Multiple brake configs → defer to per-VIN package config flow | ✓ `status: "needs_user_input"` does exactly this |
| Wire `parts_cost_low/high` for resolved variant into booking spec | ✓ `getPricedPartsForServices` does this with averaged `part_prices` |
| Pre-job mechanic verification with locked-pricing-revision flow | Out of scope for this branch — existing mechanic verification undo flow handles the revision UX |
| m_sport / Performance / carbon-ceramic packaging correctness | ✓ Fixed in this branch via `redundant_when_halo` flag |

### 9e. QA matrix readback (when the slug fix lands)

The brake-config ticket's QA matrix should produce these results once the slug mismatch is resolved:

| Vehicle | `packages_available` | After user confirms | Resolved fitments |
|---|---|---|---|
| **BMW M3 Competition** | (none brake-related — M-cars ship M Performance hardware standard, halo skips redundant packages) | n/a — no question fires | Base M3 brake fitments |
| **BMW 3 Series base** | (none) — m_sport requires hardware qualifier match now | n/a | Base 3-Series brake fitments |
| **BMW 330i with M Sport Package** | `m_sport` (detected from `"M Sport Package"` option string) | User confirms → `m_sport` in confirmed_packages | Base + m_sport-coded brake fitments (upgraded pads/rotors) |
| **Audi RS4** | (skipped by halo — RS ships ceramic-capable hardware) | n/a | Base RS4 fitments |
| **Audi A4 with S line** | `audi_s_line` | User confirms | Base + s_line-coded fitments |

All of this is already-built behavior. The only thing blocking it is the slug fix.

---

## File-level summary (uncommitted changes on this branch)

### New files
- `convex/lib/haloVariantRules.ts` — curated halo-variant table + sync lookup
- `convex/lib/haloVariantInference.ts` — Haiku-based long-tail fallback
- `convex/lib/transmissionTypeInference.ts` — Haiku transmission canonicalizer
- `convex/backfillTires.ts` — bulk tire-data backfill (was already in tree from prior work)
- `convex/diagnoseVin.ts` — `byVin` + 5 repair/backfill actions

### Modified files
- `convex/lib/vehicleDatabases.ts` — `assessAvailablePackages` uses halo gate
- `convex/lib/packageRules.ts` — `redundant_when_halo` flag + tightened m_sport regex
- `convex/vehicle_pipeline.ts` — halo promotion + Haiku canonicalizer + removed hardcoded `mapTransmissionStyle`
- `convex/vehicleEnrichment/v3pipeline.ts` — `parseBatch2` parses `parts_breakdown`, new per-part write loop, transmission `type` wired through, removed inline normalizer, halo + oil + part fields
- `convex/vehicleEnrichment/v3queries.ts` — `getFitmentsByConfigAndService` joins `oem_part_number`
- `convex/vehicleEnrichment/prompts/batch1Prompt.ts` — added `engine_oil_oem`
- `convex/vehicleEnrichment/prompts/batch2Prompt.ts` — per-unit contract + `parts_breakdown` + `engine_oil_oem`
- `convex/vehicleEnrichment/types.ts` — `PartPriceBreakdownEntry`, `engine_oil_oem` in `V4_FIELD_KEYS`
- `convex/vehicleEnrichment/pipelineBatch.ts` — `engine_oil_oem`, empty `parts_breakdown: []` for legacy path
- `convex/vehicleEnrichment/tier2Enrichment.ts` — `engine_oil_oem` in enrichable + gap-fill query
- `convex/vehicleEnrichment/sourceRegistry.ts` — slug map for `engine_oil_oem`
- `convex/vehicleEnrichment/sourceDiscovery.ts` — keyword set for `engine_oil_oem`
- `convex/vehicleEnrichment/utils/wheelSizeScraper.ts` — halo promotion + Haiku fallback
- `convex/directorCars.ts` — `vehicleConfigFitments` + `partFitmentDetail` queries
- `convex/bookings.ts` — booking gate after ownership check (line ~756); `enqueueNotificationOutbox` now exported
- `convex/vehicleEnrichment/v3mutations.ts` — `notifyEnrichmentComplete` mutation appended; imports `enqueueNotificationOutbox` from `bookings.ts`
- `convex/vehicleEnrichment/v3pipeline.ts` — partial→complete transition check + notify trigger after post-fallback recalc
- `convex/diagnoseVin.ts` — `enrichmentLockState` query added (alongside the existing repair/backfill actions)
- `app/(director-panel)/director/components/Primitives.tsx` — generic `rightDrawer` slot
- `app/(director-panel)/director/components/tabs/TabVehicleConfigs.tsx` — accordion + drill-down drawer + part list types

### Generated
- `convex/_generated/api.d.ts` — auto-regen for the new queries/actions

---

## Test plan

- [ ] **Typecheck clean** — `npx tsc --noEmit -p convex` reports no errors in our touched files (the pre-existing Stripe API version + missing vitest types warnings persist and are unrelated).
- [ ] **Halo promotion (fresh decode)** — decode a new M3 / Civic Type R / RS4 VIN and verify `models.name` is the promoted form, not the base series.
- [ ] **Halo package skip** — decode an M3 VIN, verify `vehicle_configs.packages_available` does NOT contain `m_sport`.
- [ ] **wheel-size promotion** — log line `[wheel-size-api] Halo variant promoted: ...` appears for M-cars; tire fitments returned match the halo model (e.g. M3 staggered 275/35R19 + 285/30R20).
- [ ] **Transmission type write** — re-enrich a Civic EX + a Porsche PDK; verify `transmissions.type` lands as `automatic` / `DCT` respectively (not `unknown`). Watch for log line `[trans-canonicalize] "..." → ...`.
- [ ] **Per-part pricing (fresh enrichment)** — enrich a BMW M550i; verify oil filter, drain plug gasket, and engine oil bottle each have their own `part_prices` rows with distinct prices and source URLs.
- [ ] **Engine oil fitment (fresh enrichment)** — same M550i, verify a `part_fitments` row exists for `service_type="oil_change"` whose part has `subcategory="engine_oil"`.
- [ ] **Director part-fitments view** — open `/director#configs`, click a config row, expand a service group, click a part row → drawer opens with prices + sources. Modal width adapts when audit drawer is also open.
- [ ] **Per-VIN repair tooling** — pick a pre-fix M-car VIN and run the three-step recipe above; verify `diagnoseVin:byVin` shows the corrected state.
- [ ] **Bulk dry-run** — `backfillAllEngineOilFitments '{"limit":10,"dryRun":true}'` lists 10 candidates without writes; same for `backfillAllPartPrices`.
- [ ] **Booking gate — incomplete config** — pick a VIN whose `enrichment_status` is `partial` (or use `enrichmentLockState` to confirm). Attempt to book a parts-dependent service (oil change, brake pad replacement). Mutation throws `Error("VEHICLE_ENRICHMENT_INCOMPLETE: We're still setting up...")`. **Critically, the time slot is NOT marked unavailable** — verify the `time_slots` row still shows `is_available: true` after the throw.
- [ ] **Booking gate — labor-only bypass** — same incomplete VIN, attempt to book a labor-only service (tire rotation, wheel alignment, inspection). Booking succeeds.
- [ ] **Booking gate — complete config** — `enrichment_status === "complete"`. Parts-dependent booking succeeds.
- [ ] **Lock state diagnostic** — `npx convex run diagnoseVin:enrichmentLockState '{"vin":"..."}'` returns the expected shape for both locked and unlocked vehicles.
- [ ] **Completion notification — happy path** — add a fresh VIN, wait for enrichment to flip from `partial`/`enriching` → `complete`. Verify a row appears in `notification_outbox` with `category: "vehicle_enrichment_complete"`, `channel: "push"`, `user_id` = the active owner, payload includes year/make/model. `[v8] enrichment_status: ... → complete — notifying owners` log line should appear.
- [ ] **Completion notification — idempotency** — re-trigger `enrichVehicleBatchV3` for the same already-complete VIN (e.g. via the validation path). No new `notification_outbox` row is created — log should show `previousStatus === "complete"` skipping the notify call.
- [ ] **Completion notification — multi-owner fan-out** — VIN with two active co-owners; enrichment flip produces TWO outbox rows (one per `user_id`), each with the same dedupe-key root but distinct `user_id`.
- [ ] **End-to-end QA recipe (the original sub-task #6)**:
  ```bash
  npx convex run diagnoseVin:enrichmentLockState '{"vin":"<FRESH_VIN>"}'   # is_locked: true
  # attempt parts-dependent booking → VEHICLE_ENRICHMENT_INCOMPLETE
  # wait ~8 min
  npx convex run diagnoseVin:enrichmentLockState '{"vin":"<FRESH_VIN>"}'   # is_locked: false
  # check notification_outbox for the push row
  # retry the booking → succeeds
  ```

---

## Risks / rollback

- **No schema changes** — purely additive to the enrichment vocabulary. Rolling back is `git revert` only.
- **Per-part pricing contract is a Claude-prompt change** — old responses are still parseable (the new write loop falls back to service-level price when `parts_breakdown` is absent or empty), so this can't break existing in-flight enrichments.
- **Transmission canonicalizer requires `ANTHROPIC_API_KEY`** — if it's missing, callers fall through to `null` and the row keeps its prior `type`. No regression vs. the old whitelist (which also returned `undefined` for unrecognized strings).
- **Bulk backfill actions are hard-capped** (oil: 100/run, prices: 200/run) and dry-run-able. Designed to be babysat in passes.
- **Booking gate is a server-side throw** — UX impact: any user attempting to book a parts-dependent service on a freshly-decoded VIN will hit a hard error until enrichment completes (~8 min). FE handling lives in a separate workspace; until the FE catches `VEHICLE_ENRICHMENT_INCOMPLETE:`, users will see a generic error toast. If that UX gap is unacceptable for ship day, gate this section behind a feature flag or revert just the `bookings.ts:756-781` insertion (~25 lines) and keep the rest. The notification + diagnostic survive a partial revert cleanly.
- **Cross-file import** — `convex/vehicleEnrichment/v3mutations.ts` now imports `enqueueNotificationOutbox` from `convex/bookings.ts`. No circular dependency at runtime (the v3 pipeline doesn't transitively import bookings logic the other way), and Convex codegen handles ES module resolution at bundle time. If this becomes a problem the helper can be moved to `convex/lib/notifications.ts` as a 5-line refactor.
- **Slug-format mismatch (NOT fixed in this branch — see §9)** — `part_fitments.service_type` is written with underscores by `v3pipeline.ts:493` SERVICE_NAME_TO_SLUG, but `services.slug` and `packageRules.services_affected` use hyphens. Every `getPartsForService` / `getOemPartsForBooking` lookup currently returns empty fitments. This branch does NOT fix it (deliberately scoped to documentation only) because the fix has two reasonable shapes and one of them requires a row-rewrite backfill on `part_fitments`. Worth resolving before the brake-config ticket ships. §9 has the full breakdown + recommended Option A / Option B.

---

## Pre-existing notes (NOT introduced by this branch)

- Stripe API version mismatch warnings in `directorStripeLive.ts`, `http.ts`, `stripe.ts` — pre-existing, unrelated.
- `convex/oto/canonicalize.test.ts` missing `vitest` types — pre-existing.

---

## Acknowledgments

Built on top of `temur-dev`'s halo branch state and the schema baseline from the prior `waleed-dev` director-panel work. The repair/backfill action layout follows the existing `convex/backfillTires.ts` pattern (paginated walk + dryRun + makeFilter + in-memory dedup).
