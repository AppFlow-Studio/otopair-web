```
Branch: temur-dev | Commit: b068f3e | Agent: 2 Extraction Forensics
Generated: 2026-06-25T16:34:56+0100
```

# Extraction Forensics (AI Batch) — Agent 2

Scope: how scraped/searched text becomes structured fields + candidate parts via Anthropic calls, inside the LIVE v3 spine (`enrichVehicleBatchV3` → `_pollBatch1V3` → `_pollBatch2V3`). Every claim is tagged and cited. The live AI client is `utils/batchClient.ts` (Message Batches API). `claudeExtractor.ts`, `extractionPrompts.ts`, and `gapFill.ts` are **legacy/dead** relative to the live flow (trace below).

## Batch/Call Inventory

The live pipeline makes exactly **three Anthropic Message-Batch submissions**, plus an **optional in-Batch-2 Tier-2 re-extraction** real-time call. All batch requests go through `submitBatch()` (`utils/batchClient.ts:67`).

| # | customId | Where submitted | model (effective) | web_search | maxSearchUses | blockedDomains | maxTokens | temp | Purpose |
|---|----------|-----------------|-------------------|-----------|---------------|----------------|-----------|------|---------|
| 1A | `batch1a` | `v3pipeline.ts:1598-1605` (submitted :1647) | **Sonnet** `claude-sonnet-4-6` (no `model` field → fallback `req.model ?? MODEL_SONNET`, `batchClient.ts:74`) | OFF | `0` (`:1604`) | none | 8192 | 0 | Structured extraction from pre-scraped OEM parts catalog + owner's-manual markdown. NO web search. [CONFIRMED] |
| 1B | `batch1b` | `v3pipeline.ts:1606-1614` | **Sonnet** `claude-sonnet-4-6` (no `model` field → SONNET) | ON | `1` (`:1612`) | `BLOCKED_DOMAINS` (`:1613`) | 16384 | 0 | Web-search fill of intervals / fluid specs / battery / tire specs / attributes. Independent of 1A. [CONFIRMED] |
| 1C | `batch1c` | `v3pipeline.ts:1624-1632` (conditional: only if `vdbRepairRaw.actions.length > 0`, `:1620`) | **Haiku** `claude-haiku-4-5-20251001` (explicit `model: MODEL_HAIKU`, `:1631`) | OFF | `0` (`:1630`) | none | 4096 | 0 | VDB action→service-slug mapping (structured-only). Piggybacked on the Batch-1 submission. [CONFIRMED] |
| 2 | `batch2` | `v3pipeline.ts:2053-2063` | **Sonnet** `claude-sonnet-4-6` (no `model` field → SONNET) | ON | `1` (`:2060`) | `BLOCKED_DOMAINS` (`:2061`) | 16384 | 0 | Two jobs in one call: (Job 1) gap-fill null fields via web search; (Job 2) per-OEM-part pricing + labor hours. [CONFIRMED] |
| Tier-2 reextract | n/a (real-time) | `priceReextract.ts:156` via `reextractPartPrice`, called from `v3pipeline.ts:2529` | **Sonnet** `claude-sonnet-4-5-20250929` (`utils/claudeClient.ts:26`, `MODEL`) | OFF (extract-only, `callClaudeExtractOnly`) | n/a | n/a | 256 | 0 | Verify one Batch-2 LLM price against its own cited page text. ONLY runs when `PARTS_REEXTRACT_BATCH2 === "on"` AND in the legacy `PARTS_FIRECRAWL_PRICING === "off"` price path. [CONFIRMED] |

**RECON SEED CORRECTIONS / CONFIRMATIONS:**
- **OPEN-Q ANSWERED — "do 1A/1B run Sonnet or get overridden to Haiku?"** [CONFIRMED] 1A and 1B run **Sonnet** (`claude-sonnet-4-6`). Neither request sets a `model` field (`v3pipeline.ts:1598-1614`), so `submitBatch` applies `req.model ?? MODEL_SONNET` (`batchClient.ts:74`, `MODEL_SONNET = "claude-sonnet-4-6"` at `:22`). Only 1C is forced to Haiku (`:1631`). The debug log at `v3pipeline.ts:1638` literally prints `model: sonnet (default)` for every request. **The batchClient header comment (`:8-9`) claiming "Haiku → all extraction, Sonnet not used in batch pipeline" is STALE and contradicted by the code.** [CONFIRMED]
- maxSearchUses recon (1A=0, 1B=1, 2=1) — [CONFIRMED] verbatim.
- Web search tool wiring: when `maxSearchUses > 0`, `submitBatch` attaches `tools: [{ type: "web_search_20250305", name: "web_search", blocked_domains: [...] }]` (`batchClient.ts:79-87`). `blocked_domains` is only attached when `blockedDomains` is non-empty (`:83-85`). So 1A/1C get NO tools at all; 1B/2 get web_search + blocked_domains. [CONFIRMED]
- `BLOCKED_DOMAINS` content (`sourceRegistry.ts:29-36`, re-exported via `blockedDomains.ts:8`): `kbb.com, justanswer.com, carscounsel.com, firestonecompleteautocare.com, yourmechanic.com, chargerforums.com`. These are passed to the API so blocked-domain results never enter Claude's context. [CONFIRMED]

**LIVE vs LEGACY clients:**
- LIVE: `utils/batchClient.ts` (batch 1A/1B/1C/2) + `utils/claudeClient.ts` (`callClaudeExtractOnly`, used by `priceReextract.ts:36`). [CONFIRMED]
- DEAD relative to live v3: `claudeExtractor.ts` (model `claude-sonnet-4-5-20250929`, `:17`), `extractionPrompts.ts`, `gapFill.ts`. Trace: grep of `vehicleEnrichment/` shows `gapFill` is imported by **nobody**; `extractionPrompts`/`claudeExtractor` are imported only by `gapFill.ts` and `pipelineTest.ts` (a test). `v3pipeline.ts` imports none of them (grep returned empty). [CONFIRMED] So the older real-time `callClaudeWithWebSearch`/`retryNullFields` path is not on the live spine.

## Prompts & Schemas (per call)

### Batch 1A — `BATCH_1_SYSTEM` + `buildBatch1Prompt` (`prompts/batch1Prompt.ts`)
- **System** (`:15-57`): "data extraction specialist… You are NOT searching the web. You are reading pre-scraped source documents." Rules: extract values ONLY from provided docs; training knowledge allowed ONLY for 4 stable fields (`brake_fluid_type`, `power_steering_type`, `parking_brake_type`, `timing_system`) at confidence 0.75; null beats a guess; OEM-format validation per make (BMW/Toyota/Honda examples); **"Do NOT extract or return any prices"** (`:45-49` — pricing is captured deterministically from JSON-LD, the markdown flattens sale+MSRP+"You Save"); supersession handling (pick the CURRENT superseding part, `:38-43`); confidence tiers (`:51-56`); NHTSA vPIC values are authoritative and must not be overridden (`:57`). [CONFIRMED]
- **User** (`:59-229`): vehicle line + 4 sections — `NHTSA vPIC DATA` (JSON of drivetrain/turbo/transmission/fuel_injection/timing/cylinders/displacement/fuel_type, `:67-82`), `OEM PARTS CATALOG (scraped)` clipped to **20,000 chars** (`:85`), `OWNER'S MANUAL` clipped to **20,000 chars** (`:89`), optional `PACKAGES` section, then a fully-spelled-out target JSON schema.
- **Output schema** (`:131-213`): a single object with keys `fluids`, `intervals` (each interval = `{miles:{value,…}, months:{…}, status, display_string}`), `attributes`, **`oem_parts` (a FLAT object — one part-number field per role: `oil_filter_oem`, `front_brake_pad_oem`, … 31 fields, `:163-196`)**, `battery`, `spark_plug`, `parking_brake_type`, `trim_specs`. Optional top-level `packages` block (`:101-114`) keyed by package code, each with its own `oem_parts` of differing part numbers. **Every part role holds ONE value — not an array.** [CONFIRMED]

### Batch 1B — `BATCH_1B_SYSTEM` + `buildBatch1bPrompt` (`prompts/batch1bPrompt.ts`)
- **System** (`:26-38`): "vehicle data specialist… search the web for accurate maintenance intervals, fluid specs, technical specs." Targeted 1-2 searches per field; confidence tiers (0.95 OEM / 0.85 reputable / 0.75 training, below → null); FWD ⇒ diff/transfer-case `not_applicable`; valid JSON only. [CONFIRMED]
- **User** (`:40-111`): receives ONLY the vehicle identity (no scraped content — deliberately independent of 1A per the file header `:6-12`). Schema mirrors 1A's intervals/fluids/battery/attributes/trim_specs **but adds** `diff_fluid`, `transfer_case_fluid` intervals, `trans_fluid_type`/`diff_fluid_type`/`transfer_case_fluid_type`, `battery_type`/`battery_location`. **No `oem_parts` block — 1B does not return part numbers.** [CONFIRMED]

### Batch 1C — VDB mapping (`buildVDBMappingPrompt` / `parseVDBMappingResponse`, imported into `v3pipeline.ts`)
- Purpose: map raw VDB repair `actions[]` → Otopair service slugs so VDB intervals + labor can be applied (`v3pipeline.ts:1617-1633`, parsed `:1833-1871`). Structured-only, Haiku, no web search. Confidence-0.9 writes so Batch 2 can't overwrite (`:1855`, `:1832`). Output consumed by `applyVDBMappingResult` → `upsertServiceInterval`. [CONFIRMED] (Prompt builder lives outside the audited files — CROSS-REF: `vehicleEnrichment/` VDB module, owner = pipeline/sources agent.)

### Batch 2 — `BATCH_2_SYSTEM` + `buildBatch2Prompt` (`prompts/batch2Prompt.ts`)
- **System** (`:21-38`): "two jobs." **JOB 1 GAP FILL**: web-search each field under "FIELDS NEEDING GAP FILL", 1-2 queries, null if not found. **JOB 2 PRICING + LABOR**: look up retail prices for each provided OEM number **AND every OEM number the model itself reports** (`:25`), labor hours per service. Rules: **prices are PER-UNIT** (one bottle / one filter / one axle pad-set; a V8 returns price of ONE plug not 8, `:28-31`); report the **current sale price**, never MSRP/"was"/struck-through/"You Save" (`:32`); **preferred shape is itemized `parts_breakdown` — one entry per OEM part number**, multi-part services (oil_change = filter + drain-plug gasket + oil bottle) MUST itemize, never collapse (`:33`); service-level `parts_cost_low/high` are OPTIONAL redundant sums (`:34`); labor rate $125/hr fixed (`:35`); omit a part from `parts_breakdown` if no price found (`:37`). **Design note `:8-17`: the system prompt is intentionally minimal — no source-tier rankings or blacklists in-prompt because "Claude ignores prompt-based blacklists"; blocking is enforced mechanically via `blockedDomains.ts`.** [CONFIRMED]
- **User** (`:136-205`): vehicle line + `FIELDS NEEDING GAP FILL` (the `nullFields[]` mapped through `FIELD_DESCRIPTIONS`, `:169-170`) + `OEM PART NUMBERS (from Batch 1, for pricing lookup)` (the flat `oemParts` map, `:175-176`; when empty, the prompt tells Claude to discover and price the parts itself, `:149`). Then a target JSON schema and the full 25-service `SERVICE_LIST` (`:108-134`) that the `services[]` array must cover (`is_applicable:false` for N/A).
- **Output schema** (`:182-191`): `{ gap_fields: {field:{value,source_url,source_type,confidence}}, services: [ServiceEntry] }`. Each `ServiceEntry` (example `:151-165`): `service_name`, `is_applicable`, `labor_hours{value,…}`, **`parts_breakdown: [ {oem_part_number, price_low, price_high, source_url, confidence} ]`** (`:156-159`), optional `parts_cost_low/high`, `confidence`, `tech_notes`. **`parts_breakdown` is an ARRAY of per-OEM-number entries; each entry is ONE part role's price.** [CONFIRMED]

### Tier-2 price re-extraction — `buildLlmPricePrompt` (`priceParser.ts:241-268`)
- **System** (`:246-257`): "parts-pricing extractor… Return ONLY the price the customer actually pays RIGHT NOW for THIS exact part." Explicit DO-NOT list (MSRP / list / "was" / struck-through / "You Save" / shipping / different part). Reply `{"price":…, "msrp":…, "oem":…}` JSON only. [CONFIRMED]
- **User** (`:259-265`): target OEM (+ optional part name) + the product page text clipped to **12,000 chars** (`MAX_LLM_PAGE_CHARS`, `priceReextract.ts:76`, `:150-151`). [CONFIRMED]

## Merge/Priority Logic

**Batch 1 internal merge (1A > 1B), `mergeBatch1` (`v3pipeline.ts:253-268`):**
- Starts with a clone of 1A's parsed fields (`merged = {...a}`, `:257`). For each 1B key, it copies the 1B value **only if 1A's value is null AND 1B's value is non-null** (`:259-261`). So **1A (scraped) wins on every field it filled; 1B (web search) only fills 1A's nulls.** Confirms recon "1A>1B" precedence. The earlier recon line ref (`:1819-1836`) is wrong — the merge fn is at `:253-268`; the *call* is `mergeBatch1(fields1a, fields1b)` at `:1934`. [CONFIRMED]
- Parse order at the call site (`:1932-1934`): `parseBatch1a(r1a.data)` → `parseBatch1b(r1b.data)` (only if 1B present and not errored) → merge. If 1B errored, pipeline continues with 1A only (`:1922-1924`, `:1933`).

**Post-merge overrides applied BEFORE applicability rules (`:1957-1970`):**
1. `applyKnownEngineFacts(fields, engineCode)` (`:1957`) — curated engine-family facts.
2. `applyVerifiedEngineFields(fields, engine)` (`:1963`) — per-row human-verified engine fields win over the LLM.
3. `applyApplicabilityRules(fields, vPicData)` (`:1970`) — e.g. chain engine ⇒ null timing-belt parts; FWD ⇒ null diff/transfer-case. These run AFTER the human overrides so a director-corrected belt car isn't re-nulled (comment `:1951-1956`). [CONFIRMED]

**Batch 2 merge into Batch-1 fields (`_pollBatch2V3`, `:2196-2218`):**
- `allFields = {...args.batch1Fields}` (Batch-1 result is the base, `:2196`).
- `parseBatch2(r2.data, nullFields)` → `gapFields` + `services` (`:2201-2203`).
- Gap fields: applied **only where `allFields[k].value == null`** (`:2204-2208`) — Batch 2 never overwrites a Batch-1 value, only fills its nulls.
- Pricing→fields: `mapPricingToFields(services)` then again **only fills nulls** (`:2211-2216`).
- **Net precedence: Batch 1A (scraped) > Batch 1B (web) > Batch 2 (gap/web). VDB-1C interval/labor writes at confidence 0.9 are designed so Batch-2's 0.75-ish fallbacks never beat them (`:1832`, `:1855`).** [CONFIRMED]

**Gap-field source-type relabel:** in `parseBatch2`, a kept gap value gets `source_type = source_url ? "web_search" : "gap_fill"` (`:453`), and blocked-domain sources are rejected at parse time (`:450`). [CONFIRMED]

## Where Parts Enter

**Part NUMBERS first enter from model output in Batch 1A**, as a **flat object** `data.oem_parts` — one string value per role. Parsed by `parseBatch1a` (`v3pipeline.ts:141-153`): it iterates a fixed list of 31 `_oem` field keys and does `f[k] = parseField(parts[k])` — i.e. **one `FieldResult` (single value) per part role, never an array** (`:142-153`). Package-variant numbers enter via the optional top-level `packages` block, parsed by `parsePackageParts` (`:195-…`) into `Map<packageCode, {field→FieldResult}>` — still one value per (package, role). [CONFIRMED]

**Part PRICES first enter from model output in Batch 2**, inside each service's `parts_breakdown[]` array. Parsed by `parseBatch2` (`:459-496`): `rawBreakdown = Array.isArray(s.parts_breakdown) ? … : []` (`:465`), each entry mapped to `{oem_part_number, price_low, price_high, source_url, source_domain, confidence}` (`:466-481`), then `.filter(e => e.oem_part_number && e.price_low != null)` (`:482`). The typed shape is `PartPriceBreakdownEntry` / `ServicePricingResult.parts_breakdown: PartPriceBreakdownEntry[]` (`types.ts:59-66`, `:68-81`). **So prices arrive as an ARRAY of per-OEM-number entries; numbers arrive as a flat single-value object.** [CONFIRMED]

**From model output to `part_prices` rows (`_pollBatch2V3`):** the write loop iterates `services` (`:2452`), resolves each service's existing fitments via `getFitmentsByConfigAndService` (`:2458`), then branches on `process.env.PARTS_FIRECRAWL_PRICING` (`:2464`):
- **`=== "off"` → LEGACY path (`:2465-2589`):** deterministic JSON-LD prices first (`:2470-2483`, `price_type:"sale"`), then itemized `parts_breakdown` written per part (`:2486-2571`, `price_type` = `sale`/`unverified`/`llm_estimate`), with an optional Tier-2 re-extract verify (`:2527-2550`, only if `PARTS_REEXTRACT_BATCH2 === "on"`), then a service-level fallback (`:2574-2589`, `llm_estimate`). [CONFIRMED]
- **else → FIRECRAWL path (DEFAULT, `:2590-2654`):** collects the UNION of discovered URLs per part (deterministic JSON-LD URL + `parts_breakdown` source URLs), runs `priceAllSources(urls, …, extractPriceFirecrawl)` (`:2631`), and writes **only validated `status==="sale"` rows** as `price_type:"sale"` (`:2632-2643`). Parts with no trusted price get NO row (logged, `:2647-2652`). **In this default path the LLM's `parts_breakdown` price_low is used only as a URL source to re-verify via Firecrawl — the raw LLM number is NOT written.** CROSS-REF Agent 3 (pricing): `extractPriceFirecrawl`/`priceAllSources` is Firecrawl-API, not Anthropic. [CONFIRMED]

**[CONFIRMED-DATA]** — `part_prices` on deployment `temurbek` (= preview `ardent-crab-641`; 2940 rows): a 100-row sample shows the overwhelmingly dominant `price_type` is **`online_discount`** (a POISON type from a *separate* marketplace pricing pipeline, `lib/priceTypes.ts:16-20`), with at least one `llm_estimate` row observed (the legacy flag-off path) and **zero `sale`/`unverified`** in that sample. This corroborates that the v3-extraction Batch-2 price writes (`sale`/`llm_estimate`/`unverified`) are a *minority* contributor versus the marketplace scraper — CROSS-REF Agent 3. The `online_discount` value is not written anywhere in `vehicleEnrichment/*.ts` (grep of `price_type:` literals returns only `sale`, `llm_estimate`, `UNVERIFIED_PRICE_TYPE`, `REPAIRPAL_ENDPOINT_PRICE_TYPE`).

## Candidate Multiplicity Origin

**Verdict: the "4 parts for one slot" is interpretation (i) — legitimate `parts_breakdown[]` itemization of a multi-part service, NOT 4 competing candidates for one part role.** [CONFIRMED]

Pinpoint:
- **`parts_breakdown` is an array of DISTINCT part roles, one entry per OEM number.** The Batch-2 prompt explicitly tells the model to itemize a multi-part service into separate entries: "Multi-part services (oil_change has filter + drain plug gasket + engine oil bottle) MUST itemize" (`batch2Prompt.ts:33`); the schema example shows two different OEM numbers in one service's `parts_breakdown` (`:156-159`). The type is `parts_breakdown: PartPriceBreakdownEntry[]` keyed by `oem_part_number` (`types.ts:59-74`). So a 4-entry breakdown = filter + gasket + oil + (e.g.) cap O-ring — four DIFFERENT parts, each its own role. [CONFIRMED]
- **The write loop itemizes, it does not pick a winner among competitors.** `for (const entry of svc.parts_breakdown)` (`v3pipeline.ts:2503`, legacy; `:2622`, firecrawl) writes one `part_prices` row per entry per matching fitment — no "choose 1 of N candidates" step. [CONFIRMED]
- **The one genuine ONE-number→MANY-IDs fan-out is the `numberToPartIds` map (`:2493-2501`, mirror `:2613-2620`)**: a single OEM number can map to **multiple `part_id`s** because the same number appears as multiple fitments under one service (e.g. **base trim + package variant**, comment `:2487-2492`). That is "one part role priced once, stamped onto its base+package fitment rows" — still NOT four competing candidates for one slot. [CONFIRMED]
- **A second, orthogonal multiplicity is per-SOURCE pricing**: one part_id legitimately gets multiple `part_prices` rows, one per retailer URL. **[CONFIRMED-DATA]** the `part_prices` sample shows the same role (e.g. a BMW rear brake rotor `part_id` repeated across `bmwpartsdeal.com` and `parts.bmwofsouthatlanta.com`) with different prices — multiple SOURCES for one part, which the median/aggregator later collapses. This is sourcing, not candidate selection.

**If a synthesizer downstream sees "4 candidates for one slot," the likely true causes (in priority order) are:** (a) multi-part itemization in `parts_breakdown[]` — different roles, expected; (b) one OEM number fanned to base+package fitments via `numberToPartIds`; (c) multiple per-source `part_prices` rows for one `part_id`. **None of these is "4 rival part numbers for a single role."** The model's part-NUMBER output (`oem_parts`) is structurally one value per role (`batch1Prompt.ts:163-196`, `parseBatch1a` `:142-153`), so a single role cannot acquire 4 competing numbers from the extraction layer. [CONFIRMED]

## Cross-refs

- **Scraping / source markdown / VDB mapping prompt builder** (what fills `sources.partsMarkdown`/`manualMarkdown`, `buildVDBMappingPrompt`): owned by the pipeline/sources agent — see `v3pipeline.ts:1580` (`scrapeVehicleSources`) and the VDB block `:1617-1633`. One-line note only.
- **Firecrawl pricing + median aggregation + `online_discount`/marketplace prices**: owned by Agent 3 (pricing). See `firecrawl.ts:240` (`extractPriceFirecrawl`), `priceReextract.ts:223-259` (`resolveVerifiedPrice`/`priceAllSources`), `lib/priceTypes.ts`, and `part_prices.ts` (writes `online_discount`).
- **`writeNormalizedData` sections A–H** (fitments/intervals/labor table writes): owned by the storage/normalization agent — `v3pipeline.ts:684`.
- **Labor research orchestration** (`laborAllSources`, OLP/RepairPal/web): owned by the labor agent — `v3pipeline.ts:2417`.
- **Applicability / sanity / OEM validation rules**: `applicabilityRules.ts`, `validation/sanityChecks.ts`, `validation/oemValidation.ts` (called `v3pipeline.ts:1970`, `:2241-2242`).

## Open Questions

1. **`parts_breakdown` cardinality distribution** — COULD NOT TRACE via DB. The parsed `parts_breakdown` is not persisted as a table; it is consumed transiently in `_pollBatch2V3` and exploded into per-row `part_prices`. So the real distribution of "entries per service" cannot be read from Convex; it would require capturing a raw Batch-2 response. Code guarantees each entry is a distinct `oem_part_number` (`batch2Prompt.ts:33`, parse `v3pipeline.ts:482`), which is sufficient to answer the multiplicity question, but the live cardinality histogram is NOT FOUND in DB. [INFERRED bound only]
2. **`PARTS_FIRECRAWL_PRICING` live value** — the env var is not in the repo (it's runtime config). Code default (`!== "off"`) is the Firecrawl path (`v3pipeline.ts:2464`, `:2590`). **[CONFIRMED-DATA]** the DB sample shows `llm_estimate` rows DO exist, implying the legacy `"off"` path has run at least sometimes (or on older data) on `temurbek`; but the dominant `online_discount` comes from the marketplace pipeline, not either v3 path, so the sample cannot definitively prove which v3 path is currently default-on for THIS deployment. Treat "Firecrawl path = default" as code-confirmed, runtime-unverified.
3. **`PARTS_REEXTRACT_BATCH2` live value** — runtime-only; default-off (the Tier-2 verify at `v3pipeline.ts:2527` requires `=== "on"`). Not determinable from code/DB. NOT FOUND.
4. **Local dev deployment `third-bird-914`** — not exposed in the MCP `list_deployments` set (only `temurbek`/`production`/`ahmad`/`daniel`/`waleed`). The `temurbek` MCP alias resolves to the **preview** `ardent-crab-641` per project memory, which is where I confirmed data. Local `third-bird-914` rows were not inspectable via MCP.
