# Enrichment Session Handoff — Jul 29–30, 2026

**Branch:** `feat/3-portals` · **Deployment:** dev `third-bird-914` · **All work is UNCOMMITTED** (deployed from the working tree, Convex-typechecked clean).

---

## ⚠ Read this first

**`ENRICHMENT_STRUCTURED_OUTPUTS` is set to `off` deliberately.** Do not turn it on until the schemas are rewritten.

The Anthropic structured-outputs API rejects any schema with **more than 16 union-typed parameters**. `buildBatch1aOutputSchema` emits **402** and `buildBatch1bOutputSchema` emits **244**, because every field is nullable — which is how the pipeline's "a missing value is legitimate" law is expressed in JSON Schema (`type: ["string","null"]`).

Result: **every batch request errored and enrichment was 100% broken** from the moment the platform migration deployed until a live canary VIN caught it. No test could detect this — the schemas are structurally valid, the suite passes, the deploy is clean; only a real API call fails.

**The fix (task #21):** in `convex/vehicleEnrichment/utils/batchSchemas.ts`, express absence as **optional properties** (omit from `required`) with non-nullable types. Structured outputs permits optional properties. Verify the parsers treat an absent key exactly like null (`parseField(undefined)` → `emptyField`), add a test pinning union-typed parameter count under 16 per schema, then re-enable and re-canary.

A related fix already shipped: `batchClient.getBatchResults` now persists the API's own error message instead of the bare type `"errored"` — that omission is why this took log-diving to find.

---

## What shipped

### Jul 29 — foundations
- **Rotor thickness wiring (G1–G8)** — the resolver now receives cached markdown and the real fitted-axle set, persists what it sources, per-axle observed labels, `oem_spec_flagged` quality for sanity-flagged values (graded as an estimate, never a clean spec), scoped reject-clears, director backfill routed through validation.
- **NHTSA ODI join** — `nhtsaOdi.ts`, `vehicle_recalls` + `config_reliability_signals`, per-config refresh + daily cron. Public domain, immediately sellable.
- **Claude platform migration** — structured outputs, newer web tools with citations and per-request domain lists (closes F18), prompt caching in batches, env-gated model selection. All behind kill switches. *(See the P0 above.)*
- **Run hygiene** — zombie reaper (**swept 43 stuck runs**, 42 silent ~115 days), poll-chain write fencing, purge guard, fetch timeouts, `verified_fields` honored at finalize, cache-freshness laundering fixed.
- **Provenance persistence (W1.5)** — finalize-gate outcomes land in structured `sanity_flags` with a stage taxonomy instead of dying in a string array.
- **Claim ledger + 6 free source adapters** — deterministic family-diversity consensus; Brembo, WIX, Summit/Centric, Sylvania, Trico, AMSOIL. **Not yet wired into the pipeline** (task #10).

### Jul 30 — capability
- **P0.1 routing fixes** — 9 census bugs. `serpentine_belt`, `transfer_case_service`, `wiper_blade_replacement` + 4 more seeded as **data-only services** (`is_bookable: false`) so their data flows without changing the booking menu (23 bookable, unchanged). Six missing Batch-2 slug mappings restored, diff/transfer-case interval collision split, `ps_fluid` intervals given a 1B slot, dead 1A price parses deleted, `parseBatch1b` rewritten, all 124 fields now described. Guard test `serviceSlugAlignment.test.ts` makes this bug class fail loudly.
- **EPA fuel-economy join** — MPG/CO2/fuel cost + government corroboration of displacement/cylinders/turbo.
- **Manual library** — OEM maintenance PDFs via search-first discovery (per-make URL construction proved non-viable), Files API upload-once, native-PDF extraction with citations. **Extraction has never fired live** — highest-risk untested surface.
- **Determinism probe harness** — scheduler-chain, strictly sequential runs. Sentinel VINs deliberately `null`.
- **Sibling inheritance** — `SIBLING_SAFE_FIELDS` narrowed **17 → 4** after audit; `drivetrain`, `trans_fluid_type`, `parking_brake_type`, `power_steering_type` etc. rejected with counter-examples (the original list would have re-created the variant mis-ID failures of rounds 1–13). Inherited values capped at 0.7 confidence.
- **Part-number existence oracle** — **829,678 Toyota part numbers** indexed from catalog sitemaps; real numbers resolve, fakes return `absent`. `no_index` is a distinct verdict so an unindexed make can never be reported as "part doesn't exist". Fail-closed write gate in **log mode**. RevolutionParts is Cloudflare-403'd site-wide → recorded as an honest failure, zero rows.
- **Operator collapse** — four "different" parts domains are one company (Original Parts Giant); the ledger now dedups within a family by operator, not hostname.

---

## Canary validation (2020 Toyota Yaris, VIN `3MYDLBJV2LY704792`)

Config went `partial`/fill 0 → **`complete`/fill 83**.

**Proven working:** `serpentine_belt` interval now lands (30,000 mi, `enriched`) — data silently discarded on every prior run. Badge-engineering trap handled (resolved Mazda's `P5` engine code for the rebadged Mazda2; parts carry Toyota's `-WB` Mazda-sourced suffix). `plugs_match_cylinders: true` (4 cyl / 4 plugs). R13 rival-on-confirm fired and kept a multi-source flagged part. Structured sanity flags carry stages. NHTSA join returned 1 recall / 9 complaints.

**Confirmed gaps** (all match the census): corroboration **0%** · months intervals **19%** · labor **100% default_fallback** · rotor minimums 0 · 11/27 intervals `default_fallback` · parts triangle 7/10.

**Needs diagnosis:** `observed_title` captured on **0 of 10** parts (that's the R12 component-identity evidence that catches a battery *cable* in a battery slot); **EPA didn't join** despite the hook being scheduled.

**Cost:** ~$3.30 for the run — **281 web searches dominate the bill, not tokens** (152k in / 36k out, 28.5 min). Relevant to the P1 budget turn-up.

---

## Open work, in recommended order

1. **Task #21 — rewrite the batch schemas** (nullable unions → optional properties), then re-enable structured outputs and re-canary. Everything else validates against the fallback path until this lands.
2. Diagnose the two canary findings: missing `observed_title`, EPA non-join.
3. **Task #10 — wire the claim ledger into the pipeline** (`field_claims` table, adapters invoked at finalize, flag-only first). This is what moves corroboration off 0%.
4. **P0.2** — persist the VDB/wheel-size data the pipeline already fetches and discards (lug torque, tire pressures, rotor diameters). Free second source family.
5. **P0.3/P0.4** — engine-coherence gate and the parts triangle gate (fitment ⇒ verified ⇒ trusted price), log mode, wired to existing repair machinery.
6. **P1** — budget turn-up (stale-price refresh is `0` = off; batch-2 can get a single search), slug unification, Scrapling worker (unlocks Centric/AMSOIL/ShowMeTheParts), evidence vault, interval-provenance and capacity floors.
7. Run the remaining 4 canary VINs: `1C4JJXFM7MW797676` (transfer case), `5TDACAB54RS004749` (Grand Highlander identity), `4T1B11HK6KU794401` (Camry, manual verified), `JF2SKAWC7KH421343` (non-Toyota → proves `no_index` never quarantines).

## Reference

- Full audit + registers (F1–F36, G1–G40): `docs/enrichment-audit/2026-07-29-full-pipeline-audit.md`
- Reinforcement plan (P0–P2): `docs/enrichment-audit/2026-07-30-reinforcement-plan.md`
- Audit harness: `npx convex run devOnly/auditRunFlow:auditByVin '{"vin":"..."}'`
- Artifacts: [audit + roadmap](https://claude.ai/code/artifact/ab5b70d8-148a-48f5-aabc-866d53a86cc3) · [field sourcing census](https://claude.ai/code/artifact/7f536f11-cd73-4dbd-90cf-114586bec09c) · [research findings](https://claude.ai/code/artifact/291af144-1027-42d5-84a5-29810c194b7d)

## Test/deploy state

Suite: ~1,700 passing. Known failures: `tests/customer_late.test.ts` (pre-existing, chip filed) and `tests/timeSlotAvailability.test.ts` (pre-existing, load-dependent flake — passes in isolation). Convex deploys clean.
