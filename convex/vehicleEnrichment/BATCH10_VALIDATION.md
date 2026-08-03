# Batch 10 Validation — Jul 25 2026

**Code state:** commit `7f56cd7` (post-batch-9 stack: variant-ID MVP + rounds 4–7) plus the *source-provenance display* changes shipped in this session (deployed to `dev:third-bird-914` before the batch ran; read-side only — no pipeline behavior change).

**What this validates:** first batch after the batch-9 round of fixes (JLR part-pattern widening, enrich-start vehicle attach), plus a fresh look at the whole accuracy surface against **independently compiled ground truth** (owner's-manual PDFs read directly for 4 of 5 vehicles; every suspect part number web-verified adversarially by a dedicated agent per vehicle).

**Verdict: NOT at the 100% bar.** Fluids, specs, and OEM intervals are near-perfect (all 24 adversarial "trap" fields across the 5 ground truths passed), transmission fluids went 5/5 for the second consecutive batch, and prices were in retail band where present — but **every config carried at least one confidently-wrong value**, dominated by one new defect class: *same-platform / wrong-engine-or-generation parts scraped from genuine OEM dealer domains*, which sails past both the source-authority and brand-pattern gates.

## The batch

| VIN | Vehicle | Run | Fill | Headline |
|---|---|---|---|---|
| WBAGN63423DR24841 | 2003 BMW 745Li (E66, N62B44) | complete | 95 | Best Euro result ever: 25+ parts, 0 wrong; 1 bad interval |
| 1FTPW14556FB15661 | 2006 Ford F-150 5.4L 3V | complete | 86 | Fluids 5/5 traps; 4 wrong-variant parts (one class) |
| 1G1AT58H897221703 | 2009 Chevy Cobalt 2.2 LAP | complete | 91 | Engine block flawless; Cruze-parts cluster + EPS + trans contradiction |
| 5FRYD4H2XEB028867 | 2014 Acura MDX (J35Y5, SH-AWD) | complete | 80 | ~30 PASS; one wrong-viscosity oil part |
| 3GYFNBE34ES609578 | 2014 Cadillac SRX (LFX, FWD) | complete | 91 | All 4 traps passed; E85 false positive + wrong-gen belt |

Cost: ~1.4M tokens in / ~28k out per run (~$1.20 blended each), 58–72 web searches per run, 14–17 min wall-clock, 5 runs in parallel with no interference.

## What PASSED (proving prior rounds hold)

- **Trans fluids 5/5** (2nd consecutive batch): ZF Lifeguard 6 + pan part (BMW), MERCON V *not SP* + plain-MERCON transfer case (Ford), DEXRON-VI (Cobalt-if-auto, SRX), DW-1 (MDX). Round-6 flag-only corrector stayed silent everywhere = correct.
- **All ground-truth traps avoided**: BKR6-not-BKR7 plug + E60-air-filter contamination (BMW); FA-1754-not-FA-1883, no-cabin-filter-hallucination, 13.9-qt-dry-fill trap (Ford); 41-103-not-41-109 plug + 7.4-qt LAP-discriminator coolant (Cobalt); DILZKR7B11G plug, DPSF-not-DPF-II, 5.7-qt-not-4.5 oil (MDX); 13.5-qt coolant, hydraulic-PS-with-DEXRON-VI nuance, non-lifetime ATF (SRX).
- **EPS handled right on MDX** (ps_fluid null) — but not on Cobalt (see P1-3).
- **Duty/tow logic**: F-150 tow-package detection correctly selected the 30k towing ATF schedule.
- **Refute gates made correct kills**: SRX cabin filter 13508023 (real GM part, wrong vehicle), Ford VC-7-B, Cobalt rotor/battery/thermostat junk part numbers.
- **Two candidate defects REFUTED by verification** (do not "fix" these): MDX cabin filter 80292-SDA-407 is the OEM *supersession* of TZ5-A41 (persisting past `part_pattern_suspect` was right); Cobalt air filter 25894265 is the correct 2008-10 design (the owner's manual number is the stale one).

## Confirmed defects → round-8 fix list

### P1 — confidently wrong values
1. **Same-platform/wrong-engine parts contamination (3 vehicles, 8 parts) — the batch's headline defect class.**
   - Ford: rear rotor `5L3Z-1125-BA` (a FRONT 7-lug rotor; correct rear `4L3Z-2C026-AB`), thermostat `RT-1194` (Duratec-family), serp belt `5L3Z-8620-BA` (4.2L V6), intake gasket `4L3Z-9461-AA` (4.6L).
   - Cobalt: oil filter `PF2257G` + housing o-ring `55593191` + ignition coil `25186687` — all Cruze/Sonic/Aveo small-engine parts (the o-ring proves wrong-engine reasoning: the LAP has a spin-on filter, no housing). `part_pattern_suspect:Chevrolet:3` fired but rows persisted.
   - SRX: serp belt `12677093` (2017-22 Colorado/Canyon 3.6 LGZ; correct `12636139`).
   - **Why gates missed it:** all are *real* OEM parts from *trusted dealer domains* with correct brand patterns. Fix: engine-scoped (and axle-position-scoped) applicability check in `utils/partFitmentVerifier.ts` — verify the scraped page's engine/position context against the variant fingerprint, not just brand pattern + domain authority.
2. **Wrong-viscosity oil part (MDX)**: `08798-9032` = Honda 5W-20 *blend* on the 0W-20 J35Y5 (conf 0.75, one source, no source_domains, no flag). Fix: coherence gate — engine-oil part's viscosity must match `engine.oil_viscosity` (also catches BMW's cosmetic 0W-30-field vs 5W-30-part mismatch). Correct part: `08798-9163`.
3. **Electric-PS car stored as hydraulic (Cobalt)**: `ps_fluid_type:"hydraulic"` + phantom 32 oz + *scheduled* PS flush — an unperformable sellable service. Fix: EPS applicability rule (like the diesel spark-plug suppression) keyed off fingerprint/known EPS platforms; MDX shows the extractor CAN get this right.
4. **Transmission speeds/type contradiction (Cobalt)**: `Automatic` + `speeds:5` (no 5-spd auto Cobalt exists; NHTSA gear count is the manual's). VDB style string said "Manual" — conflict never reconciled or surfaced. If the VIN is actually the F23 manual, fluid/part/capacity are all categorically wrong. Fix: speeds must be consistent with resolved type in `transmissionTypeReconcile.ts`; surface decoder trans conflicts into the fingerprint + flags.
5. **E85 flex-fuel false positive (SRX)**: NHTSA "E85 Max" is an LFX *family* attribute; EPA (vehicle 34235) + the 2014 manual both say gasoline-only (2012-13 were FFV, 2014 dropped it). Fix: year-gated FFV rule or EPA cross-check in `fuelTypeResolver.ts`.
6. **Brake-fluid interval (BMW)**: 12 mo stored vs BMW's documented 2 years. (Also Cobalt coolant 30k/24mo on DEX-COOL vs 5yr/150k — a green-coolant interval on OAT chemistry; SRX brake fluid 45k/36mo vs manual 150k/10yr.) Fix: fluid-family-aware interval bands in `adversarialVerification.ts`.

### P2 — identity & data-shape
7. **Trim identity regressions**: F-150 stored "FX4 SuperCrew" (decoders said Lariat); BMW stored "745i"/E65 (VIN says 745Li/E66 — `nhtsa_vin_key` had it right and the config lost the L). Same class as batch-9's Subaru finding; check `identityResolution.ts` trim precedence.
8. **`default_fallback` interval rows carry `status:"scheduled"`** (all 5 configs; fuel-system-clean/battery/rotors/tires at conf 0.5, source_count 0). Fix: distinct status (e.g. `estimated`) + UI badge so invented cadences can't read as OEM schedule.
9. **MDX ATF interval 60k** vs Maintenance Minder code-3 band 20k–40k (single vdb source).
10. **DPSF part gap (MDX)**: diff fluid type/capacity/interval all correct but no purchasable part row (`08200-9007A`) → Differential Service parts-unquotable on an SH-AWD flagship.
11. **Orphan core-role gear-oil fitment on FWD SRX** (`88900401` on differential_service, role core) — currently suppressed by `has_differential:false`, but the writer shouldn't persist it.
12. **Trans-fluid verifier KB error**: expected "MERCON LV" for the 4R75E (LV = 6R80 2009+). Stored MERCON V was correct; flag-only design saved it. Fix the KB row in `utils/transFluidVerifier.ts`.
13. **Cobalt drain-plug gasket `97136425`**: unfindable P/N (likely hallucinated; the 2.2's plug has an integrated washer); persisted with zero source_domains. Fix: require source for commodity part numbers or null them.

### P3 — cosmetic / hygiene (grouped)
- Engine-code passthroughs: Ford "995" order code in `engine.code` + config_key (should resolve to 5.4L 3V family label).
- Label precision: Ford coolant "OAT"→HOAT; BMW "G11"→G48; "Timing Kit" naming on a belt-only part (MDX); "oil filter housing cap o-ring" on spin-on engines (Ford adapter gasket is real; Cobalt's is contamination, see P1-1).
- Sanity-band false positives **confirmed**: F-150 coolant 20.9 qt is *exactly* the owner's-guide value (duty/size-aware band needed); MDX transfer-case 0.45 qt HGO-1 is exact.
- Price hygiene: BMW dealer-channel-only pooling (1.5–3x street for identical Mann/NGK parts); one Cobalt price from a cruzetalk forum URL; one Ford price from a 1996 Windstar catalog page; Cobalt air-filter price sourced from a 2017-Traverse page.
- Gaps (honest nulls, listed for backfill): Ford coolant part (post-refute) + PS fluid part; Cobalt + SRX cabin filters (real parts exist: CF125 / CF176); SRX tire-rotation interval; MDX air-filter + plug prices; Ford front-axle 80W-90 not representable (single diff-fluid slot); fuel-filter service absent from catalog.
- F-150 plug gap 1.37mm vs 0.040-0.050" band; air-filter interval 15k vs OEM 30k (over-service).

## Source-provenance display (shipped this session)

- `enrichment_evidence` already stored per-field `source_url` / `source_type` / `source_domain` / `confidence`; batch-10 runs confirmed rows carry full URLs (`web_search` with exact page, `training_data`, `nhtsa`).
- Read-side shipped: `evidenceForRun` now returns URL/type/entityType; new `evidenceForConfig` (latest-per-field via bounded `by_entity` reads, `observed_at` dedupe — `is_latest` is untrustworthy) and `intervalsForConfig` (intervals + per-row provenance); `partsForConfig` gained `sourceDomains[]` + joined `source`.
- Deep Dive UI: Source link + type badge on Evidence panel (now follows the timeline-selected run, with "This run / Current best" toggle), Parts source chips, new OEM-intervals panel.
- Remaining manual check: open Director → Enrichment → Deep Dive on a batch-10 VIN and click through the links.

## Determinism note
`core_signature` captured for all 5 (single run each; no repeat-run diff this batch).
