```
Branch: temur-dev | Commit: b068f3e | Agent: 0 Schema Cartographer
Generated: 2026-06-25T16:34:56+0100
```

# Enrichment Pipeline — Schema Map

Scope: every table the v3 enrichment pipeline reads or writes, the evidence/consensus
data model, and the FK graph that links vehicle identity → specs → parts → prices →
labor → services. All citations are `convex/<file>.ts:line` against commit `b068f3e`.

Deployment note: the MCP exposes 5 deployments (`temurbek`=ardent-crab-641,
`production`=mellow-cat-431, `ahmad`, `daniel`, `waleed`). The audit anchor's
`third-bird-914` (local dev) is NOT exposed by MCP; all `[CONFIRMED-DATA]` below is
from `temurbek` (ardent-crab-641), the preview deployment, which holds live enriched
rows (`enrichment_evidence` = 26,737 rows). [CONFIRMED-DATA]

---

## Table Catalog

For each table: `schema.ts` line, one-line meaning, key fields/types, indexes, and
**EVIDENCE** (stores multiple observed values per field) vs **CANONICAL** (one resolved
value per row). Row counts are `[CONFIRMED-DATA]` from `temurbek`; `-1`/`n/a` means MCP
could not auto-count (table empty or not in MCP's discovered set at query time).

### Core vehicle reference (CANONICAL)

| Table | schema.ts | Meaning | Rows |
|---|---|---|---|
| `makes` | :45 | Manufacturer dictionary (name, slug, oem_part_pattern). idx `by_name`,`by_slug`. | n/a |
| `models` | :60 | Model under a make. FK `make_id→makes`. idx `by_make_id`. | n/a |
| `generations` | :72 | **@deprecated** (header :68 "retired in favour of chassis_specs"). FK `model_id→models`. idx `by_model`,`by_years`. Still referenced as optional FK `vehicle_configs.generation_id`. | n/a |
| `trims` | :89 | Trim under a model (name, year_start/end, steering_type). FK `model_id→models`. idx `by_model_id`. | 357 |
| `engines` | :98 | 24-field engine spec (absorbed deprecated `engine_specs`). FK `trim_id→trims`, `make_id→makes`. Carries fluid capacities, `verified_fields[]` (human-corrected keys, :134), `last_enriched_at`. idx `by_trim_id`,`by_engine_code`,`by_engine_family`,`by_make`. **CANONICAL** (resolved engine). | 363 |
| `transmissions` | :144 | 16-field trans spec (absorbed deprecated `transmission_specs`). FK `trim_id→trims`,`make_id→makes`. idx `by_trim`,`by_trim_type`. | 369 |
| `chassis_variants` | :166 | Drivetrain variant per trim (drivetrain_type). FK `trim_id→trims`. idx `by_trim`,`by_trim_drivetrain`. | n/a |
| `chassis_specs` | :180 | **Platform-stamped** specs shared across all trims on a chassis (brake/ps fluid, lug torque, wipers, battery group, steering_type, parking_brake_type — migrated from `generations`). Keyed by `chassis_code` string, FK `make_id→makes`. idx `by_chassis_code`,`by_make`. | 28 |
| `vehicle_configs` | :211 | **THE canonical join key** (config_key string). FKs: `make_id`,`model_id`,`generation_id?`,`engine_id?→engines`,`transmission_id?→transmissions`,`cloned_from_config_id?→self`. Carries `enrichment_status`,`fill_rate`,`confidence_avg`,`last_enriched_at`,`last_verified_at`,`enrichment_version`,`verification_count`,`pricing_tier`,`packages_available[]`. 8 indexes incl `by_config_key`,`by_nhtsa_vin_key`,`by_engine`,`by_make_model_year`,`by_enrichment_status`,`by_pricing_tier`. **CANONICAL** (resolved per-vehicle). | 381 |
| `drivetrain_configs` | :292 | Differential/transfer-case fluids per config. FK `vehicle_config_id→vehicle_configs`. idx `by_vehicle_config`. | 363 |
| `trim_specs` | :307 | Trim-variable specs (tires `tire_options[]`, battery CCA, brake sensor). FKs `trim_id?→trims`,`vehicle_config_id?→vehicle_configs`. Has @deprecated wiper/battery/lug fields (:356 "migrating to chassis_specs"). idx `by_trim`,`by_vehicle_config`. | 93 |

### Parts & fitments

| Table | schema.ts | Meaning | EVIDENCE/CANONICAL | Rows |
|---|---|---|---|---|
| `oem_parts` | :375 | Canonical parts catalog (oem_part_number, name, brand, part_tier, category/subcategory, supersession). FK `make_id?→makes`. idx `by_part_number`,`by_category`,`by_subcategory`,`by_make_category`,`by_brand`. **CANONICAL**. | 1,373 |
| `part_fitments` | :403 | Part↔config applicability (service_type, quantity_needed, position, `package_code?`, `service_role?` core/as_needed/kit, `confidence`, `mechanic_verified`). FKs `part_id→oem_parts`,`vehicle_config_id→vehicle_configs`. idx `by_vehicle_config`,`by_part`,`by_config_service`,`by_config_service_package`. Replaces deprecated `*_part_fitments`. **CANONICAL** (resolved applicability). | 4,738 |
| `part_prices` | :433 | **Scraped per-SKU prices** (price, price_type, source_url, source_domain, msrp, discount, refreshed_at). FK `part_id→oem_parts`. idx `by_part`,`by_part_source`. **NO `is_latest` FLAG** — staleness handled only by `refreshed_at` (verify-flagged in Open Questions). EVIDENCE-like (multiple price rows per part pooled at query time) but **no latest-flag dedup**. | 2,940 |
| `repairpal_endpoint_estimates` | :458 | Per-(config,service) raw RepairPal estimate cache; labor projected into `labor_observations`, parts into `part_prices` (source_domain="repairpal_endpoint"). FKs `vehicle_config_id`,`service_id`. idx `by_config_service`,`by_config`. | n/a |
| `price_backfill_log` | :826 | Reversibility log for price-backfill deletes (`deleted_row: v.any()`). idx `by_batch`. | n/a |

### Observation / preference tables (post-job telemetry — CROSS-REF Agent pricing)

| Table | schema.ts | Meaning |
|---|---|---|
| `shop_part_preferences` | :497 | Materialized "which part this shop reaches for" (use_count, is_default, swap_away/not_used counts). FKs shop/service/config/part. |
| `vehicle_part_preferences` | :523 | Per-VIN sticky part preference. idx `by_vin_service`. |
| `part_snapshots` | :548 | Append-only price/usage sensor readings per closed job (booking_id, shop, mechanic, denormalized vehicle context, part identity, unit_cost). Two-pass corrections via `corrects_snapshot_id`/`superseded_by_id`. |
| `labor_quote_snapshots` | :627 | Per-service mechanic-vs-catalog time/price observation. |
| `parts_quote_snapshots` | :665 | Per-part catalog-guess-vs-mechanic observation. |

### Enrichment pipeline (all Waleed-unique)

| Table | schema.ts | Meaning | EVIDENCE/CANONICAL | Rows |
|---|---|---|---|---|
| `enrichment_evidence` | :716 | **The evidence store.** One row per observed value (entity_type, entity_id=STRINGified Convex id :718, field_name, observed_value: `v.any()`, observed_type, source_url/domain, source_type, confidence, enrichment_run_id?, observed_at, **is_latest?**, created_at). idx `by_entity`,`by_entity_field`,`by_source_domain`,`by_enrichment_run`. **EVIDENCE — multi-value, the heart of this audit.** | **26,737** |
| `enrichment_runs` | :736 | One row per pipeline execution (status, token/cost meters, `last_heartbeat_at` :752 force-unstick, fill_rate, fields_changed[], batch_ids[], scrape_cache_hit). FK `vehicle_config_id`. idx `by_vehicle_config`,`by_status`,`by_created_at`. | **401** |
| `source_registry` | :767 | Per-domain scrape source config + reliability (reliability_score, total_observations, accuracy_rate, is_blocked). FK `make_id?`. idx `by_make`,`by_domain`,`by_blocked`. | n/a |
| `blocked_domains` | :788 | Blocklist (domain, reason, accuracy_at_block). idx `by_domain`. | n/a |
| `scrape_cache` | :797 | Firecrawl markdown cache keyed by `cache_key`; carries `part_prices_json` (parsed JSON-LD SKU prices, :813) + `format_version`. idx `by_cache_key`,`by_expires_at`,`by_make_year`. | n/a |
| `scrape_jobs` | :833 | Marketplace scrape job runs. idx `by_source`,`by_status`,`by_created_at`. | n/a |
| `vin_queue` | :873 | VIN ingest queue → `vehicle_config_id?`. idx `by_vin`,`by_status`,`by_source_status`,`by_year`. | n/a |
| `mechanic_verifications` | :850 | Post-job mechanic spec verifications (status pending/accepted/rejected, `verifications: v.any()`, `review_decisions`). FKs `mechanic_id→mechanics`,`vehicle_config_id`,`service_id?`,`reviewer_id?→director_users`. idx `by_vehicle_config`,`by_mechanic`,`by_job`,`by_service`,`by_status`. | n/a |

### Services & labor

| Table | schema.ts | Meaning | EVIDENCE/CANONICAL | Rows |
|---|---|---|---|---|
| `services` | :899 | Canonical service catalog (23 live rows) with applicability flags + Pricing-v2 `parts_kind`/`parts_unit_spec_source`, `labor_determinant`, `repairpal_slug`. FKs to category + pricing-category tables. idx `by_slug`,`by_category`,`by_pricing_category`. **CANONICAL**. | 23 |
| `service_categories` | :968 | UI grouping. | n/a |
| `service_options` | :975 | Per-service option rows (labor_hours, parts band). FK `service_id`. | n/a |
| `service_parts_rules` | :990 | Director-editable parts rule per service (core/as_needed subcategories, pinned_parts, qty_override). FK `service_id`. idx `by_service`. | n/a |
| `service_vehicle_specs` | :1027 | **[A] bridge table** engine×service (labor_hours, oem interval, parts band, Pricing-v2 `parts_baseline_unit_count`). FKs `engine_id`,`service_id`,`vehicle_config_id?`. idx `by_engine_id`,`by_service_id`,`by_engine_and_service`. | n/a |
| `service_intervals` | :1063 | OEM interval per config (miles/months, status, confidence, source_count, mechanic_verified). FKs `vehicle_config_id`,`service_id`. idx `by_vehicle_config`,`by_config_service`. **CANONICAL (resolved)** — note `source_count`/`mechanic_verified` are consensus-derived summaries. | 2,664 |
| `labor_times` | :1080 | **Resolved** book+empirical labor per config×service (book_hours, empirical p25/p75, multi-source guardrail flags `labor_sources_disagree`). FK `vehicle_config_id?`,`service_id`. idx `by_vehicle_config`,`by_vehicle_config_and_service`,`by_engine_family`. **CANONICAL** (robust-median output). | 2,694 |
| `labor_observations` | :1111 | **Append-only per-source labor observations** — "mirror of part_prices for service times" (:1105). hours, source, tier (catalog/empirical), weight, `sibling_slug`, `match_key`. FKs `vehicle_config_id`,`service_id`. idx `by_config_service`,`by_config_service_source`,`by_engine_family_service`. **EVIDENCE** (multi-value, weighted-median consumed by `labor_times`). | 55 |

### Pricing v2 (CROSS-REF Agent pricing — listed for FK completeness)

| Table | schema.ts | Meaning |
|---|---|---|
| `pricing_tiers` | :4483 | T1–T4 tier dictionary. |
| `pricing_service_categories` | :4500 | 8 functional buckets. |
| `pricing_multipliers` | :4515 | tier×category matrix cell. |
| `pricing_fallback_snapshots` | :4535 | Append-only pricing-edit history. |
| `pricing_baselines` | :4566 | Camry anchor price per service (cents). |
| `pricing_vehicle_assignments` | :4583 | Per-config tier + brake/powertrain flags. FK `vehicle_config_id`,`tier_id`. |
| `ccb_absolute_prices` | :4605 | CCB carve-out absolute bands. |
| `pricing_parts_categories` / `pricing_parts_multipliers` | :4620 / :4629 | 9 parts cats × 7 tiers. |
| `pricing_labor_categories` / `pricing_labor_multipliers` | :4637 / :4645 | 4 labor cats × 7 tiers (spec name `labor_tier_estimates`). |

> NOTE: the recon seed's `pricing_labor_multipliers @ ~:1391` and a standalone
> `labor_multipliers` table do **NOT** exist. The only matching table is
> `pricing_labor_multipliers @ :4645`. [CONFIRMED]

---

## Entity Relationship Graph

ASCII FK graph (→ = `v.id(...)` reference). `[evd]` denotes the evidence/observation
store for that resolved table. `entity_id` in `enrichment_evidence` is a **STRING**
(`v.string()` :718), NOT a typed `v.id`, so it has no enforced FK — it holds the
stringified `_id` of `vehicle_configs` / `engines` / `transmissions` / etc.

```
                          makes ──┬──> models ──> trims ──┬──> engines [absorbed engine_specs]
                            │      │                       ├──> transmissions [absorbed transmission_specs]
                            │      │                       ├──> chassis_variants
                            │      │                       └──> trim_specs ─┐
                            │      │                                        │
              chassis_specs (by chassis_code string)                       │
                            │                                              │
                            ▼                                              ▼
   ┌───────────────────── vehicle_configs (THE join key) <─── trim_specs.vehicle_config_id
   │      ▲   ▲   ▲   ▲        │  │  │  │
   │      │   │   │   │        │  │  │  └─ generation_id? ──> generations (@deprecated)
   │      │   │   │   │        │  │  └──── transmission_id? ─> transmissions
   │      │   │   │   │        │  └─────── engine_id? ───────> engines
   │      │   │   │   │        └────────── cloned_from_config_id? ─> vehicle_configs (self)
   │      │   │   │   │
   │      │   │   │   └── drivetrain_configs.vehicle_config_id
   │      │   │   └────── service_intervals.vehicle_config_id ──> service_id ─> services
   │      │   └────────── labor_times.vehicle_config_id ──┐
   │      │              labor_observations.vehicle_config_id  [evd of labor_times]
   │      │                       │                        │
   │      └── part_fitments.vehicle_config_id ──> part_id ─> oem_parts ──> part_prices.part_id [evd-like, NO is_latest]
   │                                                              ▲
   │                                                              └── repairpal_endpoint_estimates (parts→part_prices)
   │
   ├── enrichment_runs.vehicle_config_id ──> vehicle_configs
   │        ▲
   │        └── enrichment_evidence.enrichment_run_id (optional)
   │
   └── enrichment_evidence.entity_id (STRING; un-typed) ──soft──> vehicle_configs | engines |
            transmissions | trim_specs | drivetrain_configs | oem_parts | service_intervals
            (entity_type discriminator: "engine" | "transmission" | "trim_spec" |
             "drivetrain_config" | "vehicle_config" | "part" | "interval")  [evd of ALL above]

   mechanic_verifications.vehicle_config_id ──> vehicle_configs
   pricing_vehicle_assignments.vehicle_config_id ──> vehicle_configs (CROSS-REF pricing)
   source_registry.make_id ──> makes ;  blocked_domains (no FK, domain string only)
   scrape_cache.{make_id,model_id} ──> makes/models
```

Resolution direction: raw observations land in **`enrichment_evidence`** (and
**`labor_observations`** for times, **`part_prices`** for SKU prices) → consensus/median
resolves them → written to the **CANONICAL** rows (`engines`, `transmissions`,
`vehicle_configs`, `trim_specs`, `drivetrain_configs`, `service_intervals`, `labor_times`).
`entity_id` is the join from evidence back to the canonical row it describes.

---

## Evidence/Consensus Data Model

### How each observed value is stored
Every observed value for a field is **one row** in `enrichment_evidence`
(schema.ts:716): `(entity_type, entity_id, field_name, observed_value, source_type,
confidence, enrichment_run_id, is_latest)`. `observed_value` is `v.any()` in schema
(:720) but the live writer `addEvidenceBatch` declares it `v.string()` and stores the
stringified value plus `observed_type` for round-tripping (v3mutations.ts:873). The v3
pipeline builds rows in `writeEvidence` (v3pipeline.ts:1005–1024) — one row per non-null
field key, `entity_type` from `getEntityType()` (v3pipeline.ts:1035–1044), `source_type`
defaulting to `"training_data"` when the LLM didn't tag a source, `confidence` defaulting
to `0.5`. [CONFIRMED]

### `source_type` enum
Defined on `FieldResult.source_type` (types.ts:15) — matches recon seed exactly:
```
"web_search" | "scraped" | "training_data" | "sibling_engine" | "gap_fill"
   | "nhtsa" | "director_verified" | null
```
The **schema** column is the looser `source_type: v.string()` (:724), so other writers
emit additional literals not in that enum: `"consensus_review"` (evidenceConsensus.ts:121),
and `"mechanic"` is the value the consensus scorer special-cases (consensus.ts:50,83).
So the operative set of values is the union of the `FieldResult` enum + `consensus_review`
+ `mechanic`. [CONFIRMED]

### The `confidence` field
`confidence?: v.number()` 0.0–1.0 (schema :725). Pipeline default `0.5` when untagged
(v3pipeline.ts:1020). Consensus uses it as `avgConfidence`/`maxConfidence` (below).

### How multiple values for one field coexist
They simply **accumulate** as separate rows with the same
`(entity_type, entity_id, field_name)` — there is no upsert/dedup. The
`by_entity_field` index (:732) lets the consensus reader collect them.
[CONFIRMED-DATA] For engine `w571twnbejqday44snvjnyfb5x84gx82`, field `oil_viscosity`
has **4** rows spanning **2 different enrichment runs** (`tx759bsw…` value `"0W-20
(VW 508 00)"` from platinumvw.com; `tx7ecdn7…` value `"0W-20"` from oiltype.net) —
**all four `is_latest: true`.**

### Consensus computation (`services/consensus.ts` — the LIVE resolver)
`computeConsensus()` (consensus.ts:26):
1. Filter to `is_latest === true` (:35) — throws if none survive (:37).
2. Normalize each value via `normalizeFieldValue` (:42).
3. Single-observation fast path (:48): verified iff `source_type === "mechanic"`.
4. Group by normalized value (:62), score each candidate (:75):
   - **If a `"mechanic"` observation exists** in the group:
     `score = avgConfidence*0.4 + (sourceCount/total)*0.3 + maxConfidence*0.3`, then
     `score = min(score*1.2, 1.0)` (:91–96).
   - **Otherwise** (no mechanic): `score = avgConfidence*0.3 + (sourceCount/total)*0.4
     + maxConfidence*0.3` (:98–101).
   > CORRECTION to recon seed: the seed wrote `mechanic*0.4 + source_count*0.3 +
   > max_confidence*0.3 (x1.2)` as if always-on. The actual first term is
   > **avgConfidence** (not a mechanic factor), and the 0.4/0.3/0.3 weighting + 1.2×
   > boost apply **only** in the mechanic-present branch; the no-mechanic branch is
   > 0.3/0.4/0.3 with no boost. [CONFIRMED]
5. Conflict iff 2nd candidate's score > 0.5 (:114). `needs_review = hasConflict &&
   !winner.hasMechanicVerification` (:118).

A second, distinct consensus job `evidenceConsensus.ts` also reads `is_latest`
(:270 `fieldEvidence.filter(e => e.is_latest)`, :296 skips non-latest) and writes
`source_type:"consensus_review"` conflict-flag rows (it deletes prior consensus_review
rows first, :106–111, then inserts with `is_latest:true` :125).

### **`is_latest`: where it is STAMPED, and the staleness defect**
- **STAMPED TRUE** at insert in every writer, **unconditionally**:
  - `addEvidenceBatch` (v3mutations.ts:901) — the live v3 path. Hardcoded
    `is_latest: true` for every row; **no query for or patch of prior rows.**
  - `evidenceConsensus.ts:125`, `adversarialVerification.ts:194`,
    `anomalyDetection.ts:98` — all hardcode `is_latest: true`.
- **STAMPED FALSE (mark-old-stale): NOT FOUND in any live path.** `grep is_latest`
  across `convex/` returns **zero** `is_latest: false` writes anywhere
  (only the 4 `true` writers above + the read-filters in consensus.ts:35,
  evidenceConsensus.ts:270/296). [CONFIRMED]
- The **only** documented "mark previous evidence is_latest=false on correction" logic
  was **removed** from the live verification path: `services/verification.ts:25–42`
  is an explicit "REMOVED from this function" comment block listing
  `"corrected" fields → mark previous evidence is_latest=false` (:29) as moved out.
  The surviving `processMechanicVerification` (verification.ts:43–81) only inserts a
  `mechanic_verifications` row with `status:"pending"` and writes **no** evidence and
  **no** is_latest patch. [CONFIRMED]

**Consequence (answers the Open-Q):** a second enrichment of the same config does
**NOT** mark prior evidence `is_latest=false`. Prior rows stay `is_latest=true`
forever, so `consensus.ts`'s "filter to latest" (:35) is effectively a **no-op** —
it sees *all historical observations across all runs*, not just the most recent.
[CONFIRMED] + [CONFIRMED-DATA] (100/100 sampled engine rows = `is_latest:true`,
0 = `false`; same field has 4 latest rows across 2 runs).

### Labor / price evidence (parallel evidence stores)
- `labor_observations` (:1111) is the labor analogue of evidence: append-only per-source
  rows with `weight`, robust-median-resolved into `labor_times.book_hours`. It has **no
  is_latest** — every observation is permanent; resolution is purely by weighted median.
- `part_prices` (:433) is the SKU-price analogue: append-only per-source prices, **no
  is_latest** (verify-flagged in recon — CONFIRMED no such field), pooled at query time;
  staleness is only expressible via `refreshed_at`.

---

## Suspected Legacy/Duplicate Tables

| Table / status | Evidence |
|---|---|
| `generations` — **DEAD (deprecated, in schema)** | Header :68 "@deprecated — retired in favour of chassis_specs". Its structural fields (steering_type, parking_brake_type, has_rear_wiper, cabin_filter_access) were migrated into `chassis_specs` (:196–200). Only lingering tie is the optional FK `vehicle_configs.generation_id` (:221). Kept until FKs removed. [CONFIRMED] |
| `engine_specs`, `transmission_specs` — **DELETED from schema** | Schema header :16–20 lists 10 deprecated tables NOT included. `engines` (:97 "Absorbs deprecated engine_specs") and `transmissions` (:143 "Absorbs deprecated transmission_specs") are the live replacements. [CONFIRMED] |
| `engine_part_fitments`, `transmission_part_fitments`, `trim_part_fitments` — **DELETED** | Replaced by unified `part_fitments` (:370 "Replaces deprecated *_part_fitments tables"). [CONFIRMED] |
| `vehicle_specs`, `ai_enrichment_logs`, `manual_review_queue`, `enriched_engine_configs`, `service_insights` — **DELETED** | Listed in header :16–20 as removed deprecated tables; not present in `defineSchema`. [CONFIRMED] |
| `trim_specs` wiper/battery/lug fields — **DEPRECATED columns (live table)** | :356 "@deprecated — migrating to chassis_specs. Remove after migrateToChassisSpecs runs." The table itself is live (93 rows). [CONFIRMED-DATA] |
| `service_vehicle_specs` — **bridge (live but transitional)** | :1026 "Bridge table: long-term migrate to service_intervals + labor_times." Still written/read by Pricing-v2. [CONFIRMED] |
| `vehicleEnrichment/pipelineBatch.ts` — **DEAD action file** (not a table) | CROSS-REF Agent-1 (pipeline): seed confirms header "DEPRECATED — do not use"; live spine is `v3pipeline.ts`. Out of my lane. |
| `part_prices` "is_latest" — **field does not exist** | Schema :433–445 — confirmed no `is_latest`. This is a real staleness gap, not a legacy duplicate. [CONFIRMED] |

**Canonical-vs-dead, confirmed by the code that writes rows:** the live v3 writers
target `engines`/`transmissions`/`vehicle_configs`/`trim_specs`/`drivetrain_configs`
(via `_pollBatch1V3` writeNormalizedData per the audit anchor) and `enrichment_evidence`
(via `addEvidenceBatch`, v3mutations.ts:866). No live writer targets any header-listed
deprecated table; `generations` receives no writes from the v3 pipeline (only an
optional read-FK from `vehicle_configs`). [CONFIRMED]

---

## Cross-refs

- **Pipeline spine (Agent 1):** evidence is written by `v3pipeline.ts:1005` →
  `addEvidenceBatch` (v3mutations.ts:866); `pipelineBatch.ts` is the dead legacy file.
- **Consensus/resolution math (Agent on consensus):** `services/consensus.ts:26` (live
  scorer) and `vehicleEnrichment/evidenceConsensus.ts` (conflict-flag writer + reliability).
- **Pricing v2 (Agent pricing):** `pricing_*` tables :4483–4651, `pricing_vehicle_assignments`,
  `service_vehicle_specs.parts_baseline_unit_count`, `repairpal_endpoint_estimates`→`part_prices`.
- **Mechanic verification (Agent verification):** `services/verification.ts`
  (`processMechanicVerification`) + `mechanic_verifications` table; the
  is_latest-staleness logic that was removed from here lives in their domain now.
- **Parts/fitment resolver (Agent parts):** `part_fitments.service_role` fallback to
  `lib/servicePartsReference.roleForSubcategory` (:417); `service_parts_rules` (:990).

---

## Open Questions

1. **is_latest is never set false — by design or bug?** [CONFIRMED] no live writer marks
   prior evidence stale, yet `consensus.ts:35` and `evidenceConsensus.ts:270/296` filter
   on `is_latest`. Either the filter is intentionally a no-op (consensus is meant to weigh
   ALL historical observations) or the "mark stale" step removed in `verification.ts:29`
   was never re-homed. This is my **highest-impact finding** and the likely root of any
   "stale value wins" report. Needs the pipeline/verification owners to confirm intent.
2. **`part_prices` has no `is_latest` and no `price_type` discriminator enforced** — the
   recon-flagged staleness concern is confirmed at the schema level; how the quote engine
   dedups stale vs fresh SKU prices (only `refreshed_at`?) is in the pricing/parts lane.
3. **`enrichment_evidence.entity_id` is an untyped string** (:718) — no referential
   integrity; orphaned evidence rows (config deleted/cloned) are possible and would still
   pass the `is_latest` filter. Not verified against data.
4. **MCP cannot see `third-bird-914` (local dev)** — all `[CONFIRMED-DATA]` is from
   `temurbek`/ardent-crab-641 (preview). If dev-only data diverges, those counts differ.
5. **`-1`/uncounted tables** (`source_registry`, `blocked_domains`, `scrape_cache`,
   `pricing_labor_multipliers`, `enrichment_evidence` initial stat) — `enrichment_evidence`
   re-counted cleanly to 26,737; the others returned `-1` on the bulk `table_stats` call
   (likely empty or MCP discovery lag), not separately confirmed.
