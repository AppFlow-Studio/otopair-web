```
Branch: temur-dev | Commit: b068f3e | Agent: 1 Source & Scrape Forensics
Generated: 2026-06-25T16:34:56+0100
```

# 01 — Source & Scrape Forensics

Scope: how the live v3 pipeline decides WHICH sources/URLs to hit and fetches them. Entry point verified first-hand: `internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3`, whose STEP 7 calls `scrapeVehicleSources(ctx, vehicle)` at `convex/vehicleEnrichment/v3pipeline.ts:1580` [CONFIRMED].

Verdict up front: the scrape/source-selection layer is make-bound and clean for cross-make leaks (see Cross-Make Leak Analysis). The discovery + scoring subsystem that writes `source_registry` / `blocked_domains` tables is almost entirely DECOUPLED from the live scrape path — it is effectively write-only telemetry.

---

## Source Selection Logic

The live decision of which parts URLs to fetch is made entirely from a hardcoded in-code constant, NOT from any DB table.

- `scrapeVehicleSources` calls `getSourceConfig(vehicle.make)` (`convex/vehicleEnrichment/scraper.ts:68`), which does a case-insensitive lookup against the in-memory `SOURCE_REGISTRY` object (`convex/vehicleEnrichment/sourceRegistry.ts:206-286`) [CONFIRMED]. `getSourceConfig` / `hasSources` / `SOURCE_REGISTRY` are referenced ONLY from `scraper.ts` (grep: no other non-self importer) [CONFIRMED].
- If a config exists → structured direct-URL fetch path. If not → open-web search path (`searchPartsPages`). Branch at `scraper.ts:82-98` [CONFIRMED].

URL-template / slug derivation (`sourceRegistry.ts`) [CONFIRMED]:
- `modelSlugFn(model, trim)`: BMW uses `trimSlug(trim)` (trim-only, lowercased, `[^a-z0-9_]` stripped, `sourceRegistry.ts:64-66,210`); everyone else uses `modelTrimSlug(model, trim)` (`model_trim`, same sanitization, `:69-73,188,227`).
- `yearSpecificUrl(year, modelSlug, partSlug)` — the primary URL; the make slug is BAKED IN per registry entry:
  - BMW: `https://www.bmwpartsdeal.com/oem-${year}-bmw-${modelSlug}-${partSlug}.html` (`:212`)
  - Toyota: `toyotapartsdeal.com/oem-${year}-toyota-...` (`:229`); Honda: `hondapartsdeal.com/oem-${year}-honda-...` (`:246`)
  - oempartsonline family: `https://${subdomain}.oempartsonline.com/oem-${year}-${makeLower}-${modelSlug}-${partSlug}.html` where both `subdomain` and `makeLower` are derived from the SAME `make` argument (`:182-193`).
- `genericUrl(modelSlug, partSlug)` — no-year fallback, same make-baked host (`:191-192,213-214,230-231,247-248`).
- `getPartsPageUrls` / `getGenericPartsPageUrls` enumerate `new Set(Object.values(partSlugs))` (dedup by slug) and map each unique slug through the URL fn (`:78-89`) [CONFIRMED].

`part_slug_map` (field-name → URL slug):
- The LIVE map is the in-code `*_PART_SLUGS` constants: `BMW_PART_SLUGS` (`:98-114`, 15 entries deduping to ~9 fetches: brake_pads/brake_disc/battery each shared), `TOYOTA_PART_SLUGS` / `HONDA_PART_SLUGS` / `OEM_PARTS_ONLINE_SLUGS` (`:116-149`, 8 entries → ~7 unique slugs) [CONFIRMED].
- The DB schema field `source_registry.part_slug_map` (`schema.ts:773`) is `v.optional(v.any())` and is NEVER written or read by any live code (grep: only schema.ts + this audit) [CONFIRMED] — dead column.

Manual / maintenance-schedule queries: `getManualSearchQueries(config, vehicle)` (`:92-94`) returns the per-make `manual.searchQueries(year, make, model)` (2 broad queries each, embedding year+make+model, `:196-199, 218-221, 235-238, 252-255`). When no config exists, `buildDefaultManualQueries(vehicle)` builds 3 queries with year+make+model+trim (`scraper.ts:131-138`) [CONFIRMED].

`subdomain` map (`OEM_PARTS_ONLINE_SUBDOMAINS`, `:152-180`) groups badge-engineered makes to one host: GM brands→`g`, Chrysler/Dodge/Jeep/Ram→`mopar`, Mercedes/"Mercedes-Benz"→`mercedes`, VW/Volkswagen→`volkswagen`, etc. Unmapped registered make falls to `make.toLowerCase()` (`:183`). 27 makes registered total (3 Phase-1 + 24 oempartsonline). [CONFIRMED]

CROSS-REF (not my lane): the actual field extraction from the scraped markdown (Batch 1A prompt, JSON-LD price parsing) is owned by the extraction/pricing agents. I only trace which bytes are fetched.

---

## Scrape Mechanics & Fallback Chain

Two fetch modes, both routed through `convex/vehicleEnrichment/firecrawl.ts` (Firecrawl v2 API, base `https://api.firecrawl.dev/v2`, `firecrawl.ts:11`) [CONFIRMED]. NOTE: recon seed said "v1" — code is v2.

PARTS (registered make) — `scrapePartsPages` (`scraper.ts:244-359`) [CONFIRMED]:
1. Cache check (see Caching). On a current-format hit, returns immediately — no fetch.
2. Per unique slug, fetch year-specific URL via `fetchUrlWithHtml(yearSpecificUrls[i])` (`scraper.ts:296`).
3. Fallback within a slug: if markdown `< 100` chars AND a generic URL exists AND still within budget → refetch `genericUrls[i]` (`scraper.ts:299-307`).
4. Deterministic JSON-LD prices parsed from raw HTML BEFORE markdown truncation, deduped by `oem_part_number` (`scraper.ts:311-322`).
5. If both URLs return short/empty → `continue` (skip this slug; "Batch 2 fills via web_search") (`scraper.ts:325-328`).
6. Whole-loop time budget `PARTS_SCRAPE_BUDGET_MS = 210_000` (`scraper.ts:43,284,288-293`); per-page abort `FETCH_URL_TIMEOUT_MS = 45_000` (`firecrawl.ts:113,116-117`). Budget exhaustion → stop, proceed with what was gathered [CONFIRMED].

PARTS (registered make) — TOP-LEVEL fallback: if the whole registry loop returns 0 chars of markdown, `scrapeVehicleSources` swaps in `searchPartsPages` (open-web search) (`scraper.ts:85-93`) [CONFIRMED].

PARTS (unregistered make) — `searchPartsPages` (`scraper.ts:141-240`) [CONFIRMED]:
- Cache check, then 3 open-web queries each embedding `${year} ${make} ${trim||model}` (`scraper.ts:161-166`) → `searchAndFetch(query, 3, true)` (includeHtml for JSON-LD parsing from any domain).
- Per result: compute host, skip if in `BLOCKED_DOMAINS` (post-fetch, `scraper.ts:186-187`), parse prices keyed by `(oem, domain)` (`scraper.ts:191-201`), append ≤8k markdown chunk.

So the full parts fallback chain is: **cache hit → year-specific registry URL → generic registry URL → (per-slug skip) → whole-registry-empty → open-web search (BLOCKED_DOMAINS-filtered) → empty.** [CONFIRMED]

MANUAL — `scrapeManual` (`scraper.ts:363-419`): cache check, then per query `searchAndFetch(query, 3)` (markdown only), post-fetch `BLOCKED_DOMAINS` filter (`scraper.ts:389-393`), ≤8k chunks, `MAX_MARKDOWN_CHARS = 40_000` global cap [CONFIRMED].

Parts + manual run concurrently via `Promise.allSettled` (`scraper.ts:103-106`); wheel-size scrape runs separately (`scraper.ts:101`, CROSS-REF: wheel/tire subsystem). A rejected promise degrades to empty, never throws (`scraper.ts:108-109`) [CONFIRMED].

Firecrawl wrappers (`firecrawl.ts`): `searchAndFetch` (POST `/search`, `:23-93`), `fetchUrlWithHtml` (POST `/scrape`, markdown+rawHtml, optional `PARTS_DIRECT_FETCH=on` server-side fetch first, `:115-173`), `fetchUrl` (markdown only, `:179-206`), `extractPriceFirecrawl`/`firecrawlJsonExtract` (json format, used by price re-extraction — CROSS-REF pricing agent). All swallow errors → `[]`/`null` (`:46-52,89-92,155-172`) [CONFIRMED].

LEGACY/DEAD scrape paths (verified not in live spine) [CONFIRMED]:
- `searchPreGather.ts::preGatherSources`, `buildSearchQueries.ts` (`buildPreGatherQueries`, `getOemCatalogUrl`, `OEM_DOMAINS`): imported ONLY by `pipelineTest.ts:284-298` (`preGatherSources`) and self. Not reachable from `enrichVehicleBatchV3`.
- `pipelineBatch.ts`: header literally `// DEPRECATED — replaced by v3pipeline.ts. Do not use.` (`pipelineBatch.ts:1`). It also imports `scrapeVehicleSources` (`:45,558`) but is itself dead.

---

## Caching

Table `scrape_cache` (`schema.ts:797-822`), index `by_cache_key` (`:820`). Queries/mutations in `convex/vehicleEnrichment/scraperQueries.ts` [CONFIRMED].

Cache key (THE contamination boundary): `buildCacheKey(make, model, year, sourceType, trim)` → `` `${make}_${model}_${year}_${trimSeg}_${sourceType}`.toLowerCase().replace(/\s+/g,"_") `` where empty trim → `"base"` (`scraperQueries.ts:23-34`) [CONFIRMED]. **Make is the first segment**, so two different makes can never collide on a key.

TTLs (`scraperQueries.ts:133`, set at store time): `owner_manual` = 90 days, `pricing` = 7 days, else (`parts_catalog`) = 30 days. NOTE: `scraper.ts` passes `expiresAt = now + TTL_PARTS_MS` (30d, `scraper.ts:37,233,353,414`) for BOTH parts and manual — the 90-day `ttl_days` is stored as metadata but the actual `expires_at` honored by `getCachedScrape` is 30 days for manual too (`getCachedScrape` checks `expires_at`, `scraperQueries.ts:68`). Minor inconsistency, not a leak [CONFIRMED].

Cache-hit short-circuit:
- `getCachedScrape` returns null if no row or `expires_at < now` (`scraperQueries.ts:62-68`).
- Parts paths require `cached.format_version === CACHE_FORMAT_VERSION` (=3) to count as a hit (`scraper.ts:152, 257`; `CACHE_FORMAT_VERSION` at `scraperQueries.ts:19`). Older markdown-only rows (v<3) are treated as MISS so the price path re-fetches HTML [CONFIRMED].
- Manual path accepts ANY non-expired row (no format gate, `scraper.ts:372`) [CONFIRMED].
- v3 bump rationale (per comment `scraperQueries.ts:11-18`): TRIM was added to the key after an M340i/330i shared one row, and a Jetta's poisoned cache resurrected for 30 days. So trim-collision was a real historic bug, now fixed by including trim in the key [CONFIRMED].

`storeScrapeCache` upserts by `cache_key`, stamping `format_version = 3` and `part_prices_json` (`scraperQueries.ts:111-174`). Cache is written when `markdown.length > 0 || allPartPrices.length > 0` (`scraper.ts:222, 342`) [CONFIRMED].

[CONFIRMED-DATA] On deployment `temurbek` (ardent-crab-641 preview): `scrape_cache` count returned `-1` from `table_stats` (MCP could not count — likely too large or a sentinel); not independently confirmable via this tool. `source_registry`=455, `blocked_domains`=28, `vin_queue`=-1.

---

## Blocklist Enforcement Map

There are THREE separate blocklists. They are NOT synced to each other in the live path.

1) `BLOCKED_DOMAINS` (hardcoded array, `sourceRegistry.ts:29-36`; re-exported by `blockedDomains.ts:8`). 6 entries: kbb.com, justanswer.com, carscounsel.com, firestonecompleteautocare.com, yourmechanic.com, chargerforums.com. Enforcement points [CONFIRMED]:
   - LIVE batch web_search (PRE-fetch, native Anthropic API param): passed as `blockedDomains: BLOCKED_DOMAINS` to Batch 1B (`v3pipeline.ts:1613`) and Batch 2 (`v3pipeline.ts:2061`), threaded into `submitBatch` → `tools[].blocked_domains` (`utils/batchClient.ts:79-86`). These never enter Claude's context. STRONGEST barrier.
   - LIVE open-web parts search (POST-fetch, host filter): `scraper.ts:186-187` (`searchPartsPages`).
   - LIVE manual search (POST-fetch, host filter): `scraper.ts:389-393` (`scrapeManual`).
   - Match logic everywhere: `host === d || host.endsWith("."+d)` with `www.` stripped (`scraper.ts:186-187, 389-390`).

2) `DISCOVERY_BLOCKLIST` (hardcoded marketplace list, `sourceDiscovery.ts:74-86`). 11 entries (ebay, amazon, walmart, alibaba, aliexpress, wish, temu, facebook, craigslist, offerup, mercari). Enforcement point [CONFIRMED]: ONLY inside `discoverSourcesForMake` via `isMarketplace(domain)` (`sourceDiscovery.ts:103-104, 359`). It gates which discovered domains get scored/promoted into `source_registry`. It is NEVER consulted by any live scrape/fetch and is NEVER synced to the `blocked_domains` table. **Open Question (a) answer: DISCOVERY_BLOCKLIST is enforced ONLY within discovery; it is not synced anywhere and has zero effect on live scraping.**

3) `blocked_domains` TABLE (`schema.ts:788-795`, index `by_domain`). Read via `getBlockedDomains` query (`v3queries.ts:409-414`). Enforcement points [CONFIRMED]:
   - `sourceDiscovery.ts:330-337` — merged with `BLOCKED_DOMAINS` into `allBlocked`, gates discovery candidates (`:358`).
   - `tier2Enrichment.ts:244` and `v3TestSuite.ts:432,592` — read it.
   - It is the WRITE target of the auto-block path (`services/sourceScoring.ts:122-136`) and seeds (`seeds/seedBlockedDomains.ts`, `seeds/blockEbay.ts`).
   - CRITICAL GAP: the `blocked_domains` TABLE is NOT read by the live scrape (`scraper.ts`) NOR passed to the live batch web_search. The live batch uses only the 6-entry hardcoded `BLOCKED_DOMAINS` constant. So a domain auto-blocked in the table (or seeded, e.g. ebay.com) is still NOT excluded from `searchPartsPages`/`scrapeManual` or Batch 1B/2 web_search unless it is ALSO in the hardcoded array. [CONFIRMED]

[CONFIRMED-DATA] `blocked_domains` on `temurbek` = 28 rows, but they are DUPLICATED ~4x (kbb/justanswer/carscounsel/firestone/yourmechanic/chargerforums/ebay each appear 4 times) — because `seedBlockedDomains` only guards with `.first()` on the whole table (`seeds/seedBlockedDomains.ts:10-14`) yet was clearly re-run after the table was non-empty in earlier seed rounds, and `blockEbay` re-inserts on its own check. EVERY row is `blocked_by: "manual"`; there are ZERO `blocked_by: "auto_accuracy"` rows. This is direct evidence that the sourceScoring auto-block (`services/sourceScoring.ts:117-136`) has NEVER fired in this deployment.

CONTRADICTION with code comments [CONFIRMED]: `blockedDomains.ts:3-6` claims "Domain blocking is enforced natively via the Anthropic web_search blocked_domains parameter in batchClient.ts." True for the 6-entry constant, but the doc's implication that the seeded TABLE drives this is FALSE — the table never reaches batchClient in the live path. ebay.com being seeded into `blocked_domains` does NOT block ebay from live parts/manual search.

---

## Source Discovery & Scoring

Both subsystems exist and run, but neither feeds the live scrape URL selection.

DISCOVERY — `sourceDiscovery.ts::discoverSourcesForMake` (`:312-465`) [CONFIRMED]:
- Trigger (LIVE): scheduled from `_pollBatch2V3` post-completion IF the make has `< 3` rows in `source_registry` (`v3pipeline.ts:2766-2788`, 5s delay). Also callable from `v3TestSuite.ts:489` and `discoverAllSources` (`:471-505`, manual/cron-style, staggered 30s).
- Flow: 7 search queries (`:340-348`) → `searchAndFetch(query,5)` → filter by `isBlocked(allBlocked)` + `isMarketplace(DISCOVERY_BLOCKLIST)` + existing/dup (`:355-360`) → `scoreDomain` (`:119-179`, weighted: parts≤30 + prices≤20 + specs≤10 + content + vehicleSpecific 10) → top 5 (`:380-382`) → re-fetch + `extractFieldsFromMarkdown` viability test (`:387-419`) → promote via `addSourceRegistry` with `reliability_score: 0.5` and `deriveUrlTemplate(...)` (`:421-444`).
- `deriveUrlTemplate` (`:181-207`) naively string-replaces year/trim/model/make tokens with `{year}`/`{trimSlug}`/`{modelSlug}`/`{make}` — fragile (see leak analysis).

SCORING — `services/sourceScoring.ts::updateSourceScores` (`:23-160`) [CONFIRMED]:
- Trigger (LIVE): `_pollBatch2V3` → `runSourceScoring` mutation (`v3pipeline.ts:2757-2761` → `v3mutations.ts:1045-1052` → `updateSourceScores`).
- Computes per-domain agree/disagree vs consensus, updates `reliability_score`/`accuracy_rate`/`total_observations`, auto-registers unseen domains (`:140-158`), and AUTO-BLOCKS at `accuracy < 0.4 && total > 20` by patching `is_blocked` and inserting into `blocked_domains` with `blocked_by: "auto_accuracy"` (`:117-136`).

THE DEAD-END [CONFIRMED]: `source_registry.url_template` is written by discovery/scoring but the only function that consumes a template, `buildUrlFromTemplate` (`sourceDiscovery.ts:291-306`), is NEVER called anywhere (grep: defined+exported, zero callers). The live scrape reads the hardcoded `SOURCE_REGISTRY` constant, never the DB table. The DB `source_registry` table's ONLY live read is `getSourcesForMake` for the `< 3` discovery-gate count (`v3pipeline.ts:2769`) and the scoring/discovery loops themselves. So discovery+scoring are effectively self-referential telemetry that cannot change which URLs the pipeline scrapes.

[CONFIRMED-DATA] `source_registry` = 455 rows on `temurbek`. Sampled rows show: `fcpeuro.com` (BMW make_id, 41 obs, accuracy 0.88), `ebay.com` registered with `is_blocked: false` despite being in `blocked_domains` (confirms the two systems are disjoint), and clearly broken templates: `https://shop.{make}usa.com/...`, `mbusa.com/.../{year}/MY26PCWarrantyBooklet.pdf` (hardcoded filename), `fjmercedes.com/{make}/gle/maintenance-schedule/` (hardcoded `/gle/`). These would generate nonsense URLs if ever used — but they are not used. All sampled rows are `blocked_by`-less and none are auto-blocked.

Open Question (b) answer — auto-block vs next-run timing race [CONFIRMED]: even if auto-block fired, it writes only to the `blocked_domains` table + `source_registry.is_blocked`. Since the live scrape/batch never reads either for filtering, there is NO race that matters for live scraping — an auto-blocked domain keeps being reachable by `searchPartsPages`/`scrapeManual`/Batch web_search regardless of timing. (And per the data, it has never fired anyway.) The only place `is_blocked`/table-block takes effect is the NEXT discovery run's candidate filter.

---

## Cross-Make Leak Analysis

Question: could URL/slug construction or source selection EVER fetch a Ford parts page while enriching an Alfa Romeo?

VERDICT: NO in the live path. The three recon barriers are CONFIRMED first-hand, with one correction.

Barrier 1 — registered makes embed their make slug in the URL host/path [CONFIRMED]: every `yearSpecificUrl`/`genericUrl` bakes the make into the hostname (`bmwpartsdeal.com`, `${subdomain}.oempartsonline.com`) and into the path (`-${makeLower}-`). `subdomain` and `makeLower` both derive from the single `make` arg (`sourceRegistry.ts:182-193`). There is no make-agnostic global URL list and no place where one vehicle's make string reaches another make's host. (Recon cited `sourceRegistry.ts:182-202`; precise lines are `:182-193` for the oempartsonline builder, `:211-214/229-231/246-248` for Phase-1.)

Barrier 2 — cache key is make-first [CONFIRMED]: `buildCacheKey` puts make as segment 1 (`scraperQueries.ts:23-34`); plus model+year+trim+sourceType. Cross-make collision is impossible. (The historic cache bug was trim-collision WITHIN a make, now fixed by adding trim — not a cross-make issue.)

Barrier 3 — unregistered makes (e.g. Alfa Romeo, not in `SOURCE_REGISTRY`) fall to open-web search with the make IN every query [CONFIRMED]: `searchPartsPages` queries embed `${year} ${make} ...` (`scraper.ts:161-166`); manual default queries embed make too (`scraper.ts:131-138`). Results are not constrained to a make-specific domain, but every query is make-scoped and the BLOCKED_DOMAINS post-filter applies. The LLM/parser could in principle ingest a wrong-make page if the search engine surfaced one — but that is a relevance/extraction-quality risk (owned by the extraction/pricing agents), NOT a deterministic URL-construction leak. The historic `chargerforums.com` incident ("used BMW data for Dodge", `blocked_domains` reason) is exactly this class and was patched by adding it to BLOCKED_DOMAINS.

Barrier 4 (additional, found this audit) — Batch 1B/2 web_search blocking is native/pre-fetch [CONFIRMED]: `BLOCKED_DOMAINS` reaches the Anthropic API as `blocked_domains` (`batchClient.ts:79-86`), so flagged cross-make-prone domains never enter Claude's context.

RESIDUAL CROSS-MAKE RISK (low, not in live scrape selection):
- The DEAD discovery `source_registry` table holds make-misattributed/broken templates (e.g. `shop.{make}usa.com`, ebay templates carrying `-550i-xDrive-` BMW path under a BMW make_id) [CONFIRMED-DATA]. If any future code ever wires `buildUrlFromTemplate` to drive scraping, the `{make}` substitution would produce cross-make-shaped garbage URLs (`shop.fordusa.com`, etc.). Today this is inert because the table is never read for URLs. This is the single highest-impact latent risk to flag.
- `marketplaceScraper.scrapeMarketplace` uses make-bound `site:cargurus.com ${make_name} ...` queries to source VINs (`marketplaceScraper.ts:326-331`); VINs carry their own make, and enrichment is keyed off the decoded VIN (`marketplaceScraper.ts:632-648`). No cross-make parts leak. (CROSS-REF: VIN-sourcing agent.)

---

## Cross-refs

- Field extraction from scraped markdown, Batch 1A/1B/2 prompts, JSON-LD price parsing semantics → Extraction & Pricing agents (`v3pipeline.ts` Batch builders, `priceParser.ts`).
- Wheel/tire size scraping (`scraper.ts:101`, `utils/wheelSizeScraper`) → Wheel/Tire agent.
- VIN sourcing / `vin_queue` / `marketplaceScraper` round-robin → VIN-ingest agent.
- `cacheValidation.ts` (stale-config background revalidation) reuses `searchAndFetch`/`fetchUrl` but is a separate lifecycle path → Lifecycle/Validation agent.
- `tier2Enrichment.ts`, `evidenceConsensus.ts`, `services/sourceScoring.ts` consensus math → Consensus/Evidence agent.

---

## Open Questions

1. `scrape_cache` and `vin_queue` returned count `-1` from MCP `table_stats` on `temurbek` — could not confirm row counts or sample a live cache key/TTL via this tool. Code analysis of caching stands; live cache-hit rates unverified. [COULD NOT TRACE via DB]
2. Audit anchor names dev deployment `third-bird-914`, but MCP `list_deployments` exposes only `temurbek`=ardent-crab-641 (preview), `production`=mellow-cat-431, plus ahmad/daniel/waleed. I queried `temurbek` (the preview the anchor pins). `third-bird-914` is not reachable via this MCP; its blocked_domains/source_registry state is unverified.
3. The 90-day `owner_manual` TTL stored in `scrape_cache.ttl_days` is never honored — `expires_at` is always `now + 30d` from `scraper.ts`. Is the 90-day intent abandoned, or a latent bug? Code says 30d wins. [CONFIRMED code, intent unclear]
4. Is the discovery+scoring subsystem (455 `source_registry` rows, never read for scraping) intended to eventually drive `buildUrlFromTemplate`, or is it dead weight to be deleted? It currently consumes Firecrawl credits + Haiku/scoring compute with zero effect on live scrape selection. [DESIGN INTENT UNKNOWN]
5. Duplicate `blocked_domains` rows (~4x) indicate seeds were re-run without a per-domain idempotency guard. Harmless to the live path (table not read for live blocking) but noise for any consumer that does read it (discovery/tier2). [CONFIRMED-DATA]
