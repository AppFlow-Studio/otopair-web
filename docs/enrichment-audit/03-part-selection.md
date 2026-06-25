```
Branch: temur-dev | Commit: b068f3e | Agent: 3 Part-Selection & Fitment Forensics
Generated: 2026-06-25T16:41:58+0100
```

> Scope: root-cause the "Ford-pad-on-an-Alfa" bug (#1 launch blocker). All findings
> first-hand from code at commit b068f3e plus read-only MCP queries against the
> `temurbek` deployment (cloud `ardent-crab-641` — the preview deployment per
> MEMORY; local dev `third-bird-914` is NOT exposed via MCP). Tags: [CONFIRMED] =
> read in code, [CONFIRMED-DATA] = verified via read-only DB query, [INFERRED] =
> reasoned.

## Selection Algorithm (criterion-by-criterion, line refs)

The live selection spine is two pure-ish stages:

1. **Candidate hydration + role grouping + winner pick** — `resolveWinningPartForService`
   (`convex/serviceParts.ts:716-1119`), called from the Review&Pay query
   `getPricedPartsForServices` (`serviceParts.ts:1289`) AND from booking-create
   `computePricedPartsSnapshot` (`convex/booking_quotes.ts:632`, which calls
   `resolveWinningPartForService` at `booking_quotes.ts:685/693/709`). Both freeze
   the same winner; `getOemPartsForBooking` (`serviceParts.ts:283-326`) replays the
   frozen `priced_parts_snapshot` for display. One selector, three surfaces.
2. **The 7-layer tiebreak** — pure `selectPart` (`convex/partSelector.ts:142-296`),
   invoked once per role group at `serviceParts.ts:1068`.

### Stage 1 — what reaches `selectPart` (`resolveWinningPartForService`)

In strict order:

- **Labor-only short-circuit** — `serviceParts.ts:741-743`: spec `laborOnly`/
  `handledByDedicatedFlow` returns no parts.
- **Fitment collection** — `fitmentsForServiceType` (`serviceParts.ts:619-646`)
  queries `part_fitments` ONLY via index `by_config_service`
  (`schema.ts:429` = `[vehicle_config_id, service_type]`), for both dash/underscore
  slug forms, plus reference-borrowed services (`serviceParts.ts:749-759`).
  **[CONFIRMED] The sole scoping key is `vehicle_config_id` + `service_type`. There
  is no make/model/year/trim predicate.** A part_fitment row carries no make field
  at all (`schema.ts:403-425`).
- **Package gating** — `serviceParts.ts:761-764`: drop package-conditional fitments
  the owner hasn't confirmed.
- **Subcategory billing allowlist** — `serviceParts.ts:785` via
  `isBillableSubcategoryViaRule` (director `service_parts_rules`). Filters by
  subcategory string only, never by part make.
- **Part hydration** — `serviceParts.ts:782-788`: `ctx.db.get(f.part_id)` +
  `summarizePartPrices(ctx, f.part_id)`. **[CONFIRMED] `oem_parts.make_id` is loaded
  into `part` but is NEVER read or compared anywhere downstream.**
- **Role grouping** — `serviceParts.ts:810-821`: group candidates by
  `roleForSubcategory(slug, part.subcategory, part.category)`. The 7-layer scorer runs
  *within* a role group, never across roles. So all `front_brake_pad` SKUs on the
  config compete in one group regardless of which make they belong to.
- **Position narrowing** — `serviceParts.ts:843-864`: front/rear filter by
  `fitment.position` / subcategory prefix only.
- **Universal-consumable fallback / unusable-group swap** — `serviceParts.ts:866-901`,
  `:939-1004`: synthesize a priced seed for missing/garbage CORE consumable roles.
  Make-agnostic.
- **Director-pinned override** — `serviceParts.ts:1009-1030`: a `service_parts_rules`
  pinned `part_id` for the subcategory wins outright (beats VIN-sticky + scorer).
- **VIN-sticky override** — `serviceParts.ts:1033-1050`: a prior install on this exact
  VIN (`vehicle_part_preferences.is_default`) wins outright.
- **Scorer inputs built** — `serviceParts.ts:1052-1066`: `{ part_id, confidence
  (=fitment.confidence ?? 0), mechanic_verified, data_quality (normalized from
  fitment OR part), prices (from priceSummary.sources_used) }`.
- **Scorer call** — `serviceParts.ts:1068-1071`: `selectPart(inputs, { gateEnabled:
  true, gateThreshold: 0.7 })` (`PART_CONFIDENCE_GATE_THRESHOLD`, `serviceParts.ts:46`).
- Winner → `roleWinners`, primary chosen `serviceParts.ts:1102-1108`, displayed via
  `toPricedFitment` (`serviceParts.ts:1121-1153`).

### Stage 2 — `selectPart` 7-layer tiebreak (`partSelector.ts:142-296`)

Verified first-hand; recon seed is accurate. In priority order, each layer narrows
`pool`; first to leave one survivor wins:

| # | Name | Code | Criterion | Direction |
|---|------|------|-----------|-----------|
| 0 | Mechanic Verified | `:153-174` | `mechanic_verified===true`. Exactly one → wins outright (`:155-163`). >1 → continue among them; 0 → all continue. | short-circuit |
| gate | Confidence Gate | `:179-209` | keep `confidence >= 0.7`. If 1 passes → wins (`:195-196`). If some pass → pool shrinks. If NONE pass → **fall back to full pool**, set `low_confidence=true` (`:198-208`). | filter |
| 1 | Fitment Confidence | `:240` | max `c.confidence` | desc |
| 2 | Data Quality | `:243-252` | min `QUALITY_RANK` (oem 0 > dealer 1 > aftermarket 2 > generic 3, `:29-34`) | asc |
| 3 | Price Source Count | `:254` | max `price_count` | desc |
| 4 | Price Stability (CV) | `:257` | min `price_cv` | asc |
| 5 | Recency | `:260-269` | min `most_recent_price_days_ago` | asc |
| 6 | Median-Price Proximity | `:272-284` | min `abs(trimmed_median − categoryMean)` | asc |
| 7 | Lexicographic | `:287-295` | min `part_id.localeCompare` | always decisive |

**Critical semantics of "confidence" (Layer 1 / gate):** the value is
`fitment.confidence` (`serviceParts.ts:1054`), which is the enrichment LLM's
self-reported extraction confidence written at `v3mutations.ts:519/535` — it is NOT
an applicability/fitment check. **[CONFIRMED]** A high `confidence` means "the LLM was
sure it read this part number off a page," not "this part fits this car."

**Price-source-count (Layer 3) counts unverified domains.** `price_count` =
`priceSummary.sources_used.length`; `summarizePriceRows` (`part_prices.ts:66-150`)
filters only by `price_type` (poison/non-pooled) and `price > 0` (`:90-97`). **[CONFIRMED]
There is no source-reputation/verification filter** — mopar/alphaonline/fordpartsgiant
rows all count equally toward Layer 3. The reported heuristic "AI confidence + most
price sources" is therefore **CONFIRMED as the operative tiebreak chain** (Layer 1
confidence, then Layer 3 source count), with Layer 2 data-quality between them — but
note data_quality is near-uniformly `"scraped"→"generic"` in practice (see below), so
Layer 2 rarely separates.

## Doc-vs-Code Gap on the 7-Layer Selector

- **The 7-layer spec lives in code, not in a pricing doc.** The authoritative
  description is the `partSelector.ts` module docstring (`partSelector.ts:8-23`); it
  matches the implementation exactly (verified layer-by-layer above). `tests/
  partSelector.test.ts` exercises it. **No DOC→CODE drift in the layer ordering.**
- **`convex/PRICING_V2.md` is a different subsystem.** Its "Layer 1/3/5" language
  (`PRICING_V2.md:67-103`) is the **LABOR** quality gate (`labor_times`,
  `resolveLaborHours`), not part selection. Do not conflate. [Cross-ref Agent 4:
  pricing/labor.]
- **DOC↔CODE gap that matters for this bug:** `partSelector.ts:8-9` claims the order
  is "fitment-first: we'd rather quote a confident, OEM-quality part… than a
  well-priced part we're less sure fits." **The code cannot honor this promise**
  because "fitment confidence" (Layer 1) is the LLM's read-confidence, and "OEM
  quality" (Layer 2) is `data_quality` (`"scraped"`→`"generic"`), neither of which
  encodes whether the part actually fits the make/model. The docstring's stated intent
  is unachievable with the inputs it is given.
- **`anomalyDetection.ts` header overclaims.** `anomalyDetection.ts:11` lists "Part
  prices (per service_type)" as a checked dimension, but `gatherAnomalyData`
  (`:47-58`) gathers only configs/intervals/laborTimes/services/engines — **no
  part_prices, no oem_parts**. [CONFIRMED] There is no price-anomaly check that could
  flag an $11 pad sitting where an $85 pad belongs.
- **`v3pipeline.ts:2220` comment is misleading.** It says validation runs "so bad
  values get nulled first," but `validateAllOemParts` (the OEM-part validator) only
  FLAGS, never nulls (see next section). Nulling is true only for sanity/applicability
  rules.

## Fitment Validation: Present or Absent

**ABSENT. There is no make/model/year/trim validation of the chosen part — at any
stage. This is a root-cause class.** Evidence, exhaustive:

- **Selection path:** the only `make_id` references in `serviceParts.ts`,
  `partSelector.ts`, `lib/servicePartsReference.ts`, `lib/partRoleQuantity.ts` are the
  universal-consumable seed (`make_id: null`, `servicePartsReference.ts:100,742`).
  `partSelector.ts` imports nothing Convex and receives no make at all. **[CONFIRMED]**
- **`part_fitments` carries no make** (`schema.ts:403-425`); the table is keyed solely
  on `vehicle_config_id`. Every fitment query in `fitments.ts` uses
  `by_vehicle_config`/`by_config_service` and `attachPart` just does
  `db.get(part_id)` (`fitments.ts:52-55`) — no make consistency check. **[CONFIRMED]**
- **Write-side validators do not block wrong-make parts:**
  - `sanitizePartNumber` (`contentSanitization.ts:194-213`): checks the make pattern
    but on mismatch **explicitly falls through and keeps the value** (`:203-206`
    "Doesn't match make-specific pattern — but still might be valid… fall through").
    For a make with NO pattern entry (e.g. Alfa Romeo — absent from
    `OEM_PART_PATTERNS`, `contentSanitization.ts:133-162`) there is no make check at
    all; only the generic `isPlausiblePartNumber` (`:168-188`) runs, which a Ford
    number passes. **[CONFIRMED]**
  - `validateAllOemParts`/`validateOemPartNumber` (`validation/oemValidation.ts:45-101`):
    only FLAGS (`flagged:true`, value retained, `:92-97`); never nulls. Also has no
    Alfa pattern → falls to `GENERAL_PATTERN` (`:32`) which a Ford number passes.
    Crucially, the writer `writeNormalizedData` F-section reads `fields[k].value`
    (`v3pipeline.ts:877`) and **never inspects `.flagged`** — flagged values are
    written anyway. **[CONFIRMED]**
  - Even a *correct* make pattern would not catch this bug: the validators check the
    part against the **config's** make pattern (Alfa's, which is absent), not the
    part's true make (Ford). A wrong-make number checked against the wrong make's
    (missing) pattern cannot be rejected. **[CONFIRMED]**
- **`applyApplicabilityRules`** (`applicabilityRules.ts:116-174`) nulls fields by
  drivetrain/timing-system/body-class only — never validates a part NUMBER against the
  make. **[CONFIRMED]**
- **`runAdversarialVerification`** (`adversarialVerification.ts`) gathers only engine /
  trim_specs / service_intervals (`:124-147`) and writes corrections only to `engine`
  and `trim_spec` tables (`:203-225`, service intervals explicitly skipped `:226`).
  **It never touches `oem_parts`/`part_fitments`** — it cannot fix a wrong part
  number. **[CONFIRMED]**
- **`evidenceConsensus.runBatchConsensus`** (`evidenceConsensus.ts:207-412`) does
  per-field text consensus + source-reliability scoring over `enrichment_evidence`. It
  does not validate part fitment and does not feed `selectPart`. [CONFIRMED] Out-of-spine.
  [Cross-ref Agent 4: consensus/source-scoring.]

## Root-Cause Hypotheses (RANKED)

**Ground truth obtained [CONFIRMED-DATA]** on the live Alfa config
`w578qc0czknp00j29h1f1v0axh8728k5` ("2024 Alfa Romeo Stelvio Ti", make_id
`j57d643mm0pf5ydfasyp98dh6n8726tv`): it has **65 part_fitments**, and its
`front_brake_pad` role group contains **three SKUs of three different makes**:

| SKU | make | make_id | conf | source_count | price rows |
|-----|------|---------|------|--------------|------------|
| `KB3Z-2001-A` | **Ford** (`…84gkfp`, name="Ford") | wrong | 0.87 | 9 | 7 rows ~$11–24 (fordpartsgiant, levittownfordparts, tascaparts, ford.oempartsonline, ranger5g; URLs say "ford-ranger-brake_pads") + bleed-in alfaonline $56 / mopar $11.87 |
| `68400577AA` | **Alfa Romeo** (correct, Mopar/FCA) | right | 0.95 | 2 | alfaonline $56, mopar $11.87, stelvioforum $200 |
| `8R0698151L` | **Audi** (`…84hvfm`, name="Audi") | wrong | 0.87 | 2 | — |

This matches the reported symptom almost exactly (Ford KB3Z-… for ~$11 vs correct
Alfa 6840…AA for ~$85; the live numbers are `KB3Z-2001-A` and `68400577AA`). **Both
forensic mechanisms are present simultaneously.** Ranked by how directly each makes the
bug possible:

**H1 — No fitment validation gates wrong-make parts into the candidate pool (PRIMARY,
root-cause class).** Because hydration scopes by `vehicle_config_id` only
(`serviceParts.ts:634-635`) and nothing ever compares `oem_parts.make_id` to the
config's make, a Ford pad and an Audi pad sit in the Alfa's `front_brake_pad` group as
legitimate candidates. Explains: wrong part selected from a correct page; ~4 candidates
for one slot (here literally 3 makes × multiple runs = many rows); cross-make winner.
**[CONFIRMED + CONFIRMED-DATA].** This is the irreducible defect — every other
hypothesis is downstream of it.

**H2 — Wrong-make part NUMBERS were written to the Alfa config because no write-time
make filter rejects them.** `writeNormalizedData` writes `make_id: makeId`
(`v3pipeline.ts:906/947`) = the **config's** make (Alfa), but `oem_part_number` = the
LLM-extracted value `val` (`v3pipeline.ts:883`), with `sanitizePartNumber` letting a
Ford/Audi number through (see Fitment Validation). So the *fitment* points at a part
whose number is Ford/Audi. (Note the stored part rows actually keep the TRUE make_id —
Ford/Audi — because of H3's dedup, not Alfa.) Explains: a Ford part number appearing on
an Alfa at all. **[CONFIRMED].**

**H3 — `upsertPartAndFitment` dedups `oem_parts` by `oem_part_number` ALONE and
overwrites `make_id`.** `v3mutations.ts:464-497`: lookup via index `by_part_number`
(`:466-468`); on hit it `patch`es including `make_id: args.make_id` (`:478`). **The
dedup key is the bare part number, no make qualifier. [CONFIRMED].** Effect: a single
global `oem_parts` row per number, shared across every config/make that ever cited it,
and its `make_id` is rewritten to whoever wrote last. This is *also* why price rows
cross-pollinate: prices key on `part_id` (`v3mutations.ts:565-595`,
`part_prices.summarizePartPrices` by `by_part`), so the Ford `KB3Z-2001-A` row
accumulated alfaonline/mopar Stelvio prices AND fordpartsgiant Ranger prices on the
same `part_id` — inflating its Layer-3 source_count to 9. Explains: 9 sources on the
wrong part outranking 2 on the right part; unverified Mopar/alphaonline rows feeding the
count; price contamination. **[CONFIRMED + CONFIRMED-DATA].** (Mechanism distinction
the recon asked for: the LLM did NOT merely mislabel a part on a correct page — there
are genuinely-distinct Ford/Audi part rows fitted to the Alfa config. H1 is the leak;
H3 is what makes the wrong part look well-sourced.)

**H4 — Selector tiebreaks actively favor the contaminated Ford part once it's in the
pool.** With the gate at 0.7, all three pads pass. Layer 1 confidence would actually
favor the Alfa (0.95 > 0.87) **in this exact snapshot** — so the selector does not
*always* pick Ford here. BUT the pool is noisy (65 fitments, many duplicate
`front_brake_pad` rows across runs at 0.85–0.95), and whenever confidences tie at the
top, Layer 3 (Price Source Count) hands it to the Ford part (9 vs 2). And `data_quality`
is uniformly `"scraped"` (`oem_parts.data_quality`, all sampled rows) → normalized to
`"generic"` (`partSelector.normalizeDataQuality:44`), so Layer 2 cannot rescue the
correct OEM part. Explains: the "most price sources wins" symptom; why an unverified
high-count source outranks the verified low-count one. **[CONFIRMED + CONFIRMED-DATA].**

**H5 — Duplicate un-merged fitments per slot (the "~4 candidates" symptom).** Each
enrichment run re-inserts a fresh `front_brake_pad` fitment (different `part_id` =
different number/make) rather than converging; the config shows multiple runs'
fitments coexisting (`_creationTime` clusters across `1779…`, `1780703…`, `1780774…`).
Dedup at `upsertPartAndFitment` matches on `(config, service, part_id, package_code)`
(`v3mutations.ts:499-513`) so two *different* numbers never collapse. Explains: 4+
candidates for one slot. **[CONFIRMED + CONFIRMED-DATA].**

**Why H1 outranks H3/H4:** even if dedup were per-make (H3 fixed) and the scorer were
perfect (H4), a Ford pad fitted to the Alfa config would still be a valid candidate and
could still win — because nothing checks that the candidate fits the Alfa. H1 is the
necessary condition for the bug; the rest amplify it.

## Minimal Fix Surfaces

(Describing surfaces only — no edits made.)

1. **Add make/model fitment validation at candidate hydration (closes H1 — highest
   leverage).** In `resolveWinningPartForService` after `ctx.db.get(f.part_id)`
   (`serviceParts.ts:782-788`), drop any candidate whose `part.make_id` is set and
   != the config's `make_id` (allow `make_id == null` for universal consumables). The
   config's make is reachable via `fetchSpecBundle`'s `config` (`serviceParts.ts:594-615`)
   or a direct `db.get(vehicleConfigId)`. This single guard would have removed both the
   Ford and Audi pads from the Alfa group. Mirror the same guard in `getPartsForService`
   (`serviceParts.ts:230-246`) and the legacy branch of `getOemPartsForBooking`
   (`serviceParts.ts:372-394`).

2. **Make the dedup key make-qualified (closes H3 + price contamination).** Change
   `upsertPartAndFitment`'s part lookup (`v3mutations.ts:464-469`) from `by_part_number`
   alone to `(oem_part_number, make_id)` — requires a compound index on `oem_parts`
   (e.g. `by_part_number_make`). Stop overwriting `make_id` on a foreign-make hit
   (`:478`). This isolates Ford `KB3Z-2001-A` (Ranger) from any Alfa SKU and prevents
   Stelvio prices from landing on a Ford `part_id`.

3. **Make write-time part validation rejecting, not just flagging (reduces H2).** Either
   (a) have `writeNormalizedData` F-section skip fields with `flagged===true`
   (`v3pipeline.ts:877-915`), or (b) make `sanitizePartNumber` return `null` on a
   confident make-pattern mismatch instead of falling through
   (`contentSanitization.ts:203-206`). Both require seeding an Alfa Romeo pattern (and
   any missing makes) into `OEM_PART_PATTERNS` / `oemValidation.OEM_PATTERNS`. Lower
   priority — defense in depth behind #1/#2.

4. **Demote unverified price sources in Layer 3 (dampens H4).** Either filter
   `summarizePriceRows` (`part_prices.ts:90-97`) by a source-reputation/`source_registry`
   reliability gate, or change selectPart Layer 3 to weight by verified-source count.
   Cosmetic once #1 removes the wrong part entirely.

## Cross-refs

- **Pricing math / labor quality-gate / `summarizePartPrices` outlier rejection &
  PRICING_V2 "Layer" semantics → Agent 4** (`convex/part_prices.ts`,
  `convex/PRICING_V2.md`, `docs/enrichment-audit/04-pricing-consensus.md`).
- **`evidenceConsensus.ts` source-reliability scoring & `source_registry` auto-block →
  Agent 4** (consensus/source-scoring subsystem).
- **Schema deprecations (engine_part_fitments etc.) and unified `part_fitments`
  migration → Agent 1 / 00-schema-map** (`schema.ts:16-20`,
  `docs/enrichment-audit/00-schema-map.md`).
- **Enrichment LLM extraction of part numbers (Batch 1 prompts, `PART_FIELD_MAP`) →
  Agent 2** (`convex/vehicleEnrichment/v3pipeline.ts` writeNormalizedData inputs).
- **Brake axle scope (`position` front/rear) → owned by brake-scope source of truth**
  (`convex/lib/brakeScope.ts`); only consumed here for position narrowing.

## Open Questions

- **Exact symptom SKUs vs live SKUs.** The brief cites `KB3Z-2120` / `6840057AAA`; the
  live `temurbek`/`ardent-crab-641` Alfa config carries `KB3Z-2001-A` (Ford) /
  `68400577AA` (Alfa). Same prefixes/bug, slightly different suffixes — likely a
  different enrichment run or the report rounded the numbers. The reported `KB3Z-2120`
  and `6840057AAA` return count 0 in this deployment; they may exist in local dev
  `third-bird-914` (not MCP-exposed). The mechanism is identical regardless.
- **Which surface the customer actually saw the $11 on.** I confirmed the contaminated
  pool and that Layer 3 favors the 9-source Ford part on a confidence tie, but I did not
  reconstruct a specific booking's `priced_parts_snapshot` to prove the Ford pad was the
  frozen winner on a real order. Would require a booking row tied to this config
  (read-only `bookings` query) — not done to stay in lane/scope.
- **Engine/chassis clone cross-make leak.** `cloneFromChassisMatch` /
  `backfillEngineSiblings` (`v3mutations.ts:1182-1208`, `:2000-2025`) copy a source
  config's `part_id` into sibling configs with no make check. If a chassis/engine
  sibling group ever spans makes (rebadges, shared platforms), this is a second
  injection path for H1. Not observed in the Alfa data; flagged for follow-up.
- **`vehicle_part_preferences` / director pin make-blindness.** VIN-sticky
  (`serviceParts.ts:1033`) and director pins (`:1009`) also lack a make check; if a
  wrong-make part were ever pinned/stuck it would win outright. Out of immediate scope.
