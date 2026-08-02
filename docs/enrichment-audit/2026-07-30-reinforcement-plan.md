# Enrichment Reinforcement Plan — P0–P2

**Date:** 2026-07-30 · **Basis:** field sourcing census (all 124 V4 fields × code map × 447-config live census) · **Owner directive:** in-house only, no paid data subscriptions; enrichment depth is the product.

**The census verdict:** extraction quality is not the bottleneck — routing and plumbing are. Whole services drop silently, 22/36 part roles are asked of pages never fetched, paid deterministic data (VDB, wheel-size) is discarded while the LLM is asked the same question three times, and every value averages 1.05 sources.

**Law (unchanged):** present-but-wrong is worse than missing · verifiers flag, never overwrite · rival-over-delete · all new gates ship log-mode first.

---

## P0 — Recover what we already pay for (hours–days)

### P0.1 Routing fixes (census bugs R1–R9)
1. `services` gains additive `is_bookable: v.optional(v.boolean())` (default true). Seed **serpentine_belt** with `is_bookable: false` — we do NOT offer the service, but the dataset keeps its parts/intervals/labor (sellable). `listBookableForVehicle` filters on it. Ends the silent interval+labor drop on every run.
2. Complete `SERVICE_NAME_TO_SLUG` for all 6 missing Batch-2 SERVICE_LIST entries (wipers become priceable).
3. Unify the two divergent `SERVICE_LIST` constants (types.ts 22 vs batch2Prompt 25) into one export.
4. Split the `INTERVAL_TO_SERVICE` collision: transfer-case intervals must not overwrite differential intervals (distinct service rows or distinct columns).
5. Give `ps_fluid_miles/months` a real slot in the 1B prompt + schema + parser.
6. Delete the dead 1A price parses (rotor ×2, battery — schema forbids the block they read).
7. Fix `parseBatch1b` parsing 40+ fields its schema can't return; correct the stale "drivetrain from 1B" comments.
8. Add `FIELD_DESCRIPTIONS` entries for all 44 bare fields (gap-fill asks with real descriptions).
9. Align the 1C VDB vocabulary with seeded service slugs (no more silently dropped VDB rows).

### P0.2 Stop discarding paid deterministic data
Write what `extractVDBFields` already returns but never persists: `wheelTorque → lug_nut_torque_ft_lbs`, front/rear tire pressures → scalar columns, front/rear **rotor diameters** (new columns — corroborates rotor identity), `camType`, `transSpeeds` cross-check. Wheel-size pressures → scalar columns too. Written as claims (source_family per origin) AND direct fill when the field is empty — instant second source family for fields currently LLM-asked ×3.

### P0.3 Engine-coherence gate (deterministic, the "4 plugs on a 4-cyl" guarantee)
Per-run invariant: `cylinders ↔ spark_plug_quantity` (dual-plug table from R4: HEMI etc.), `displacement ↔ cylinders` plausibility band, `engine_code ↔ fuel_type` marker check. Incoherent → structured flag (stage `identity_coherence`), config can never read complete while incoherent (log-mode first), identity re-resolution scheduled.

### P0.4 Triangle gate (log mode) + repair wiring
Invariant per binding core role: **fitment exists ⇒ fitment verified ⇒ ≥1 trusted price**. Any broken leg → structured flag (stage `triangle`) + auto-schedule the existing repair machinery (`repairMissingRoles`, price discovery). Nightly fleet sweep of the same invariant. Quotability measures this; the gate enforces and repairs it.

### P0.5 EPA fuel-economy join (free, public domain)
`epaFuelEconomy.ts`: fueleconomy.gov REST (+ bulk file later) keyed on year/make/model/engine. Adds MPG city/hwy/combined, fuel cost, CO2 as new sellable fields AND emits claims corroborating displacement/cylinders/turbo/fuel_type — the government-backed second opinion feeding P0.3.

## P1 — Coverage + the in-house scraping ladder (days–weeks)

1. **Slug unification:** replace hand-written per-make keyword lists with one generated canonical map (36 role keys × default keyword, per-make overrides only for real terminology differences). Fetch in role-priority order (binding core roles first) under the existing scrape budget.
2. **Budget turn-up (results-first, owner directive 2026-07-30: cost is not the constraint):** the pipeline deliberately starves several result-producing paths. Raise/enable: `PARTS_PRICE_REFRESH_BUDGET` (default 0 = stale-price refresh OFF), the zero-price backfill leg (also 0), batch-2 search uses cap (currently min(1+gaps,5) — raise ceiling), `detailLinkBudget` (1-2 detail pages per slug → 3-4 for core roles), role-resource/rival budgets (census showed `skipped_budget`), `PARTS_PRICE_DISCOVERY_MAX`. Measure result deltas per knob. (SearXNG dropped from the plan — it's a cost tool that can degrade result quality; Firecrawl stays the search rung.)
3. **Scrapling worker productionized:** queue-driven HTTP service (same box); activates the `needs_headless` adapters (Summit/Centric, AMSOIL) + ShowMeTheParts + Gates.
4. **Raw-evidence vault:** gzipped raw HTML of every claim-cited page into Convex file storage, keyed by claim. Re-parse forever; audit-grade provenance for the dataset.
5. **Interval provenance floor** (gate leg, log first): parts-bearing services' intervals must be OEM-backed (manual / VDB schedule / OEM page); core service on `default_fallback` → partial.
6. **Capacity floor:** extend the capacity resolver from 2 → all 7 capacity fields; claim-ledger corroboration required for quote-grade capacities (single-source stays < 0.75 by ledger construction).
7. **Claim ledger pipeline wiring** (task #10): `field_claims` table; finalize invokes registry adapters for gap/core fields (budgeted, fail-open); consensus disagreement → lateSanityFlags stage `claim_ledger` + rival candidate, never overwrite.

## P2 — Depth (weeks)

1. **Variant Fingerprint + determinism releases** (the structural identity answer).
2. **Manual library** (Claude Files API + native PDF, per make/model/year; citations): the interval-provenance fill engine + torque/procedures/bulb-fuse recovery.
3. **vPIC standalone DB + EPA bulk in containers:** DEFERRED — only if API rate limits actually start costing us results. The live APIs work today; a self-hosted database is complexity without new data. (Tool filter, owner directive: only tools that move the needle on results/data.)
4. **Field-level sibling inheritance** (dormant `SIBLING_SAFE_FIELDS`), months-interval recovery, rotor GT batch (Centric/Brembo as labeled-discard suppliers — task #9).

## Fetch ladder (end state — results-first)
plain fetch → Claude web_fetch (citations) → **Firecrawl (kept — search + stealth, budgets raised)** → Scrapling worker (domains nothing else can reach) — raw HTML archived at every rung. Tool filter: a tool enters the stack only when it produces data we cannot get today; cost optimizations that add operational complexity are rejected.

## Success metrics
Zero silent service drops (belt/wiper data lands) · discarded-data fields carry ≥2 source families · coherence + triangle violations trend to zero across the fleet · Firecrawl call volume down release-over-release · corroboration rate on top-30 fields → 80%+.
