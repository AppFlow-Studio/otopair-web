# Batch 11 Validation — Wave 1 — Jul 27 2026

**Code state:** commit `c2fce51` (round-8 stack, deployed to `dev:third-bird-914` Jul 25). Wave 1 = 5 **fresh mainstream vehicles** from a user-supplied list; the 4 round-8 checklist re-runs (Cobalt/F-150/SRX/MDX, `reports/batch11_plan_2026-07-25.md`) and 5 more fresh vehicles are deferred to wave 2.

**VIN provenance note:** the user-supplied VIN list was almost entirely fabricated (8/10 failed the ISO-3779 check digit; 4 undecodable). Wave 1 ran on replacement VINs sourced from public auction/listing records, each locally check-digit-verified and vPIC-decoded clean before launch. Only the Camry VIN was usable as supplied. There is **no check-digit gate in the pipeline** (`vehicle_pipeline.ts:processVin` accepts anything the decoders tolerate) — worth a cheap guard eventually (P3).

**What this validates:** first fresh-vehicle batch on the round-8 stack, against independently compiled ground truth (owner's-manual/W&M-guide-first, one dedicated researcher per vehicle, every suspect part adversarially web-verified before being recorded as a defect).

**Verdict: NOT at the 100% bar.** Fluids and specs are near-perfect again (ATF WS not T-IV, HCF-2 not DW-1, CVTF-II with High-Torque actively refuted, EPS nulls 5/5, `estimated` fallback rows confirmed everywhere) — but 4 of 5 configs shipped at least one confidently-wrong **part**, and batch-10's headline class (*wrong-generation/wrong-engine OEM parts from trusted dealer domains*) not only recurred, wave 1 exposed its **selection-side mechanism**: on the Forester, every wrong part won arbitration **while the correct part sat in the same list unpriced**. One new P1 class appeared: **internally contradictory fluid records** (Rogue: spec says Matic S, part says NS-3).

## The batch

| VIN | Vehicle | Run | Fill | Verdict | Headline |
|---|---|---|---|---|---|
| 4T1B11HK6KU794401 | 2019 Toyota Camry SE (A25A-FKS) | complete | 90 | PARTIAL | 1 wrong-gen gasket; 3 intervals contradict W&M guide |
| 2T3ZF4DV9CW150689 | 2012 Toyota RAV4 2.5 (2AR-FE) | complete | 92 | **FAIL** | 10k-not-5k oil interval + 4-part wrong-year cluster + V6 coil |
| 2HKRM4H74FH610287 | 2015 Honda CR-V EX-L (K24W9) | partial | 94 | PARTIAL | 2 prior-gen K24Z parts; 4.6-not-4.4 qt oil; MM intervals off |
| 5N1AT2MV8HC781921 | 2017 Nissan Rogue SV (QR25DE) | complete | 94 | PARTIAL | Trans-fluid spec "Matic S" vs correct NS-3 part (contradiction) |
| JF2SKAWC7KH421343 | 2019 Subaru Forester Touring (FB25D) | complete | 86 | PARTIAL | 5 wrong parts won arbitration over correct-but-unpriced entries |

Per-vehicle detail: `reports/ground-truth-batch11/gt-*.md` + `verdict-*.md` (Camry, RAV4 = toyota-*, CR-V = honda-crv, Rogue = nissan-rogue, Forester = subaru-forester).

## What PASSED (proving prior rounds hold)

- **Trans fluid parts 5/5, third consecutive batch**: ATF WS ×2 (Camry 8AT, RAV4 4AT — the widely-published T-IV answer correctly avoided), HCF-2 (CR-V — not DW-1/HMMF), NS-3 part (Rogue), CVTF-II (Forester — High-Torque CVTF actively refuted). *But see P1-2: the Rogue's spec string contradicts its own part.*
- **EPS suppression 5/5** (all wave-1 vehicles are electric-PS): `ps_fluid` null everywhere, no phantom PS flush anywhere — the batch-10 Cobalt P1 class did not recur on 5 chances.
- **Round-8 `estimated` status confirmed on all 5 configs** — fallback interval rows no longer masquerade as OEM schedule (batch-10 P2-8 closed).
- **Refute gates made correct kills**: Camry engine-oil part 00279-0WQTE-01 (0W-20 quart on the 0W-16 engine — the batch-10 MDX viscosity class, now caught at fitment level); Forester plug 22401AA92A and High-Torque CVTF.
- **Trap avoidance held broadly**: 34/43 ground-truth traps avoided across 5 vehicles; RAV4 cartridge-not-spin-on filter, Camry 120k-not-60k plug interval, CR-V Fit-plug and Accord-air-filter decoys, Rogue S35-plug decoy, Forester turbo-coolant decoy all passed.
- **Candidate defects REFUTED by adversarial verification (do NOT "fix" these):**
  - Camry oil filter `90915-YZZN1` is CORRECT — the A25A-FKS is spin-on; the ground-truth's cartridge row was a **GT error** (corrected in verdict).
  - Rogue cabin filter `27277-4BU0A` is the current supersession replacing both 4BA0A and 5HA0A — pipeline beat the GT row.
  - RAV4 trans strainer `35330-08010`, thermostat `90916-A3003`, serp belt `90916-02668`; CR-V rear-diff fluid `08200-9007` (IS Dual Pump II); Forester oil filter `15208AA15A` (current universal supersession), rear pads, CVT filter, cabin filter.

## Confirmed defects → round-9 fix list

### P1 — confidently wrong values

1. **Wrong-generation/wrong-year OEM parts, 4 of 5 vehicles (10 parts) — batch-10's headline class, recurred and now mechanistically understood.** Three sub-mechanisms:
   - *Year-band title matching* (RAV4, 4 parts): dealer pages titled "2012-2018 Toyota …" (a Camry/other-model year band) matched on year while RAV4 fitment starts 2013/2015 — plug `90919-01259`, air filter `17801-0V020`, cabin filter `87139-07020` (the exact GT decoy), battery `28800-28100`; plus V6 coil `90919-A2002` on the I4.
   - *Prior-gen same-platform carryover* (CR-V `17055-R40-A01` + `15312-R40-A01` (K24Z parts, 2015 is DI spin-on); Camry `17177-0H020` (2AZ-era) + `90301-79006` cartridge o-ring on a spin-on engine; Forester `16546AA12A` SJ air filter).
   - **NEW — selection bias (Forester, 5 parts):** in *every* wrong-part defect the correct part was present from parts.subaru.com with an empty `prices` array, and the priced wrong-vehicle entry won core-signature/display arbitration. Priced-ness is acting as an authority signal. Fix loci: part selection/arbitration (b8collect signature pick + whatever feeds Deep Dive primary part), `utils/partFitmentVerifier.ts` year/generation applicability gate (verify the scraped page's year-fitment context against the variant fingerprint, not just brand pattern + domain).
2. **Internally contradictory fluid record (Rogue)**: `transmission.fluid` = "Nissan Matic S" (stepped-ATF spec) while the purchasable part is genuine NS-3 `999MP-CSHNS3` and the OM says non-NS-3 destroys the CVT. Round-7 `trans_fluid_suspect` fired but the contradictory spec persisted. Fix: when the fluid-family gate confirms the part, reconcile the spec string to it (or null + flag), `fluidBrandConsistency.ts` / `transFluidVerifier.ts`.
3. **OEM-schedule interval contradictions stored as `scheduled`**:
   - RAV4 oil 10,000 mi/12 mo (conf 0.95) → 2012 W&MG says 5k/6mo (10k begins MY2013) — an under-service order of severity on the highest-volume service.
   - CR-V spark plugs 30k → MM code 4 ≈ 105k (3.5× early, sellable over-service).
   - Camry + RAV4 transmission service 60k `scheduled` → both OEM guides say no replacement under normal driving (RAV4 60k is the towing schedule).
   - Fix: OEM-guide-vs-aftermarket interval arbitration — a `scheduled` row needs OEM-schedule-grade sourcing; dealer-convention cadences (brake-fluid 24/36mo on Toyota) belong in `estimated`.
4. **Refute-gate override regression (Forester)**: `fitment_refute_kept_multisource` kept 2010-2018 front pads `26296SC011` AFTER the fitment refute correctly fired. Multi-source counts of the *same wrong year-band pages* defeat a correct kill. Fix in the refute-retention logic of `utils/partFitmentVerifier.ts`.

### P2 — identity & data-shape

5. **Oil capacity trap value (CR-V)**: 4.6 qt is the K24Z7 number; K24W9 is 4.4 qt — same prior-gen bleed as the parts class but in a spec field the coherence gates don't cover.
6. **Wrong component type under a service role (Rogue)**: "Thermostat" part `11060-3TA0B` is the housing/water-outlet, not the element (21200-series). Component-type check per role.
7. **Coolant part vs coolant type contradiction (Forester)**: type string correctly "Super Coolant" but part row is old green `SOA868V9210` (correct `SOA868V9270` present, unpriced — same selection bias as P1-1c).
8. **Trim identity**: Rogue stored trim "Base" (non-existent Rogue trim; listings said SV, first decode said S — three answers, none reconciled); Camry cluster-key `l_le_se_xle` leaves SE-specifics unpinned (no wrong values found this run). Feeds the variant-fingerprint P1 scope doc.
9. **Fluid-part gaps making services unquotable**: CR-V `part:atf_fluid` + `part:coolant` null (08200-HCF2 / OL999-9011 exist); Forester CVT-fluid + engine-oil part null after correct refutes (no backfill of the *correct* candidate).
10. **Verifier-KB error (Rogue)**: flag text names JF017E/RE0F10D for the Rogue 2.5 (actual JF016E/RE0F10H). No functional impact (both NS-3) — fix the KB row (`utils/transFluidVerifier.ts`), batch-10 P2-12 pattern.

### P3 — hygiene (grouped)

- Wear items as `scheduled`: brake pads 50k on Camry/RAV4/CR-V (should be estimated/inspect) — systemic, 3rd batch.
- Tire rotation 10k (Rogue) vs OEM 5k/6mo; filter_replacement taxonomy can't split air (30k) vs cabin (10-12k) intervals — Camry paid it as a P2, Forester as P3.
- Price hygiene: advanceautoparts placeholder dupes (CR-V), $61.29 coolant outlier + EUR-market auto-doc.ie row (Camry), anonymous price rows (RAV4), 4 RAV4 price rows quoting wrong parts (follows P1-1).
- `part_pattern_suspect:HONDA:3` = 3 false positives, 0 true positives while the actually-wrong R40 parts passed — pattern gate is aimed at the wrong layer (year-fitment, not string shape).
- Per-set/per-unit: CR-V front "wiper set" is a single 650mm insert.
- Misc: RAV4 `trans:type UNKNOWN` (knowable U241E); CR-V transfer-case field holding rear-diff forum data (flag fired correctly); triplicate brake-fluid part entries (Forester); coil/gasket parts filed under spark_plugs service (Camry/RAV4, batch-10 pattern).
- No check-digit gate on VIN intake (see provenance note).

## Cost / mechanics

5 runs in parallel on `dev:third-bird-914`, all completed server-side in ~16-19 min; CLI `go` wrappers hit the known action-timeout artifact ("Error" print) — results read via `b8collect` + `v3queries` dump. `purgeAndRerun` returns `no_config_found` on never-enriched VINs — fresh VINs must use `runPublic:go` (plan doc updated understanding; worth a fallthrough fix eventually).

## Wave 2 (pending)

Remaining from the user's list: 2021 Tucson Ultimate, 2022 Accord Sport, 2023 Grand Highlander Hybrid, 2024 Equinox Premier, 2025 Crosstrek Limited (real VINs still to be sourced) + the 4 round-8 checklist re-runs from `reports/batch11_plan_2026-07-25.md`.
