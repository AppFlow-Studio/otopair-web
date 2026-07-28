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

---

# Wave 2 — Jul 27 2026 (round-9 stack)

**Code state:** commit `d31e0a7` (round-9 gates, written from the wave-1 audit above, deployed to `dev:third-bird-914` before wave 2 ran). 9 runs: 5 fresh vehicles (real VINs sourced + verified; note the user's "2023 Grand Highlander" does not exist as a model year — a 2024 was used) + the 4 round-8 checklist re-runs from `reports/batch11_plan_2026-07-25.md`.

**Verdict: NOT at the bar, and the failure mode moved up a level.** Round-9's semantics all validated (see below), and the MDX re-run came back clean — but 4 of 5 fresh vehicles FAILED, dominated by a class no part/interval gate can reach: **vehicle-identity resolution**. Wave 2 is the strongest evidence yet for the variant-fingerprint P1 plan (`reports/variant_identification_scope_2026-07-21.md`).

## The wave

| VIN | Vehicle | Run | Fill | Verdict | Headline |
|---|---|---|---|---|---|
| KM8J3CAL1MU359440 | 2021 Tucson Ultimate (G4KJ, TL) | complete | 90 | **FAIL** | Chassis mis-ID "NX4" → 3 false refutes + wrong-gen plug survived |
| 1HGCV1F33NA018579 | 2022 Accord Sport 1.5T (L15BE) | complete | 92 | PARTIAL | 11th-gen parts at 0.95; 1 refute FP (correct oil filter deleted) |
| 5TDACAB54RS004749 | 2024 Grand Highlander Hybrid | complete | 93 | **FAIL** | Decoded/keyed as plain Highlander Hybrid — model-level identity loss |
| 3GNAXNEG5RL211320 | 2024 Equinox Premier 1.5T | partial | 88 | **FAIL** | vPIC's own "LSD" 2025-RPO error ingested; CVT fluid on the 6AT |
| 4S4GUHL66S3702757 | 2025 Crosstrek Limited (FB25D) | complete | 83 | **FAIL** | Chimera CVT-fluid string; legacy rotor at 0.95; engine code "NA" |
| 1G1AT58H897221703 | 2009 Cobalt (re-run) | complete | 79 | 4/7 | Speeds reconcile ✅; 25894265 refute FP (pre-registered); 1-part coverage collapse |
| 1FTPW14556FB15661 | 2006 F-150 (re-run) | partial | 94 | 4/6 | Wrong-part refutes hold; FX4-vs-Lariat trim P1 recurred; 20.9qt over-suppressed |
| 3GYFNBE34ES609578 | 2014 SRX (re-run) | partial | 88 | 2/5 | FFV gate never fired; refutes don't persist across purges; new wrong belt |
| 5FRYD4H2XEB028867 | 2014 MDX (re-run) | partial | 90 | **3/3 ✅** | Batch-10 P1 fixed (0W-20 oil part); both must-keeps held; clean |

Per-vehicle detail: `reports/ground-truth-batch11/verdict-*.md` (fresh) and `verdict-*-rerun.md` (checklist re-runs).

## Round-9 validation scorecard

**Working as designed (validated on multiple vehicles):**
- **Interval status semantics** — zero wear items stored "scheduled" anywhere in 9 runs; wear/fallback/non-scraped rows all "estimated"; OEM-scraped rows "scheduled". Wave-1's whole interval P-class did not recur.
- **Component-type rule** — MDX: thermostat *housing* 19410-5J6-A00 correctly refuted (verified: it's the water passage, not the thermostat).
- **Year-band rule + retention fix on a correct identity** — Crosstrek: both wave-1 Forester winners (SJ air filter 16546AA12A, multisource-kept pad 26296SC011) correctly killed this time.
- **Round-8 holdovers** — Cobalt speeds 5→4 reconcile fired; MERCON V no-LV; MDX viscosity gate (#14).
- **CVT spec reconcile correctly silent** on the GH Hybrid's legitimate WS-on-eCVT.

**Round-9 costs (the trade-off bit, as pre-registered in checklist #15):**
- **Refute false-positive hard-deletes**: Cobalt air filter 25894265 (batch-10-verified correct; killed off "2.0L"-titled listings), Accord oil filter 15400-PLM-A02, Tucson ×3 (all downstream of the NX4 chassis mis-ID). Distinct-domain retention makes single-domain-corroborated CORRECT parts one bad Haiku verdict from deletion.
- **Coverage thinning without backfill**: Cobalt rebuilt 1 of ~14 part roles post-purge; Crosstrek 7 parts; Equinox 10. Kills leave honest gaps but nothing refills them.
- **Sanity over-suppression**: F-150's exactly-correct 20.9 qt coolant capacity DROPPED (sole source was a forum) where batch-10 kept-with-flag.

## Confirmed defects → round-10 fix list

### P1 — the identity layer (new dominant class; the variant-fingerprint work is the real fix)
1. **Chassis/generation mis-ID poisons downstream gates (Tucson)**: `chassis:"NX4"` on a TL car made the refute gate kill 3 correct parts and pass the wrong-gen plug. A wrong identity is worse than no identity — gates ran with confidence on a false premise.
2. **Model-level identity loss (Grand Highlander → Highlander)**: shared-engine sibling models make wrong values look multi-source-consistent; no downstream gate can catch it. Decode must preserve the full model token before any enrichment.
3. **Trusted-decoder upstream error ingested verbatim (Equinox)**: vPIC returns 2025 RPO "LSD" for a 2024 VIN → keyed into config identity, anchoring 2025-gen content (CVT fluid on the 6T45). Need an RPO/engine-code vs model-year sanity gate on DECODE output.
4. **Trim guard ineffective (F-150, 2nd consecutive failure on its target VIN)**: FX4-vs-Lariat again; round-8's normalizer-trim rejection never fired. Also engine-code passthroughs persist ("995" F-150; literal "NA" Crosstrek).

### P1 — fluid-family gaps
5. **Inverse fluid reconcile direction (Equinox)**: automatic-type + CVT-family spec is uncovered by round-9's `transFluidSpecReconcile` (it only handles CVT-type + stepped-spec). Add the mirror rule → DEXRON-VI class.
6. **Chimera/wrong-family CVT strings pass the round-7 gate (Crosstrek)**: "Subaru CVT Fluid TC (CVT-HT-LV)" mixes a Toyota spec name with TR690 fluids on a TR580 (correct: CVTF-III per TSB 01-167-08R) — no flag fired. The fluid-family verifier needs Subaru CVTF generation rows + a spec-string-coherence check.
7. **Round-8 gates that never fire**: SRX FFV flag (2nd consecutive miss on its target VIN), Cobalt DEX-COOL interval floor (30k/24mo shipped again). Both fixes exist in code but demonstrably don't execute on their target configs — debug why (ordering? gating conditions?), don't rewrite them.

### P2 — refute machinery
8. **Refute persistence**: refuted parts return on purge+re-run (SRX cabin filter 13508023, correctly killed in batch-10, reinstated at 0.95). Persist refuted (config, oem) pairs as a durable blocklist consulted by `upsertPartAndFitment`.
9. **Refute precision**: require positive year-range evidence (not just "2.0L"-titled listings) before HARD delete of a previously-verified part; consider a keep-with-refute_flagged default for parts that were mechanic/batch-verified in a prior run.
10. **Refute-as-PN-blacklist**: killing 5L3Z-8620-BA (F-150) / 12677093 (SRX) lets a *different* wrong-vehicle part of the same class in (SRX got a Trailblazer belt). The verifier should validate the REPLACEMENT too, or the role should stay null pending catalog-scoped backfill.
11. **Backfill after kill**: refute leaves an honest gap that nothing refills (Cobalt 1-part collapse; Crosstrek 8 empty roles). A catalog-scoped re-extraction pass for killed roles.
12. **Sanity keep-with-flag**: single-source in-band capacities should flag, not drop (F-150 20.9 qt regression).

### P3 (carried/new, grouped)
- Accord: 60k "severe turbo" plug interval; Equinox: AWD oil capacity on FWD config (drivetrain field ignored by capacity picker), nonexistent PN 84588699, PF64 filter GM number in the engine-oil slot; Crosstrek: speeds:8 on a CVT; MDX: ATF 60k vs MM-3 band + DPSF part gap (carryover), timing-belt year drift; GH: typo'd trans type string + speeds:1, premium cabin filter as default; assorted price hygiene (EUR domains, forum sources, $144 "gasket").

## GT corrections filed by auditors (pipeline beat the ground truth)
- Crosstrek: OM specifies 0W-16 (not 0W-20) and 4.6 qt — GT rows corrected in verdict; coolant SOA868V9272 is the current supersession.
- Accord/others: oil filter 15400-PLM-A02 confirmed correct for the 1.5T (its deletion was the pipeline's error, not its extraction).

## Cost / mechanics
9 runs ≈ $11 (wave-2), batch-11 total ≈ $17 across 14 runs. 5-parallel staggered launch worked; all CLI wrappers hit the known timeout artifact; results read via `b8collect` + `v3queries` dump script.

---

# Wave 3 — Jul 28 2026 (round-10 validation)

**Code state:** `49f80bb` (round-10: identity layer + refute durability) + hotfix `4d53885` (missing `verifyEngineCode` import crashed the action on short engine codes — Equinox/Cobalt/SRX stuck at `pending` until fixed; caught only in live server logs, both typecheckers missed it). 7 re-runs (~$8.50): the 5 wave-2 fresh vehicles + Cobalt + SRX, delta-audited against their wave-2 verdicts (`verdict-*-w3.md` per vehicle).

## Scorecard

| Vehicle | Wave 2 | Wave 3 | Headline |
|---|---|---|---|
| Grand Highlander | FAIL | **PASS (cond.)** | Model identity restored + cascaded (spin-on filter, 0W-8, contamination purged); trim series-code artifact + coverage regression remain |
| SRX | 2/5 | **4/5** | FFV gate FIRED; belt honest-null; cabin filter correct; FWD-diff class gate still missing; pre-round-10 correct kill reversed (blocklist needs seeding) |
| Cobalt | 4/7 | **5/7** | FP-protection validated *and discriminating*; 1→17 parts; DEX-COOL 50k `adversarial_corrected` landed |
| Accord | PARTIAL | **near-PASS** | Traps 11/12; 3 TP / 0 FP refutes; both 11th-gen parts killed w/ verified replacements; FP-deleted filter back |
| Tucson | FAIL | PARTIAL | 0 false refutes, 2/2 right kills, all 3 wrongly-deleted parts restored; killed roles not refilled; corrector harmed a correct interval |
| Equinox | FAIL | FAIL (narrowed) | 6 fixed, traps 4/7→6/7; LSD survives (search can't refute a code valid one MY later); fluid double-flagged but still ships |
| Crosstrek | FAIL | FAIL | CVTF-III exact + speeds stripped; but keep-demoted retention resurrected 2 killed parts into core signature (no sourced rival to win instead) |

## Round-10 mechanisms — validated vs. costed

**Validated:** model-specificity preservation (GH), decode trim precedence (no new trim regressions), FFV gate (SRX, correct diagnosis text), sanity keep-with-flag (Equinox capacity kept-capped instead of dropped), year-band refutes on correct identities (Tucson 2/2, Accord 3/3, zero FPs on those cars), catalog-attested FP protection (Cobalt 25894265 + Accord PLM-A02 both back and kept while real kills continued), interval write-back mechanics (Cobalt DEX-COOL), role backfill produced 3 verified-correct new Accord parts.

**Costed (the round-11 list):**
1. **Retention needs a third state (top item).** Round-9 killed too much (nulls); round-10 keeps too much: on the Crosstrek, kept-demoted wrong parts WIN core signature because the correct rival was never sourced. A refute must be overridable only by year-scoped fitment evidence (price rows and domain counts must not count), and every kill/demote must trigger backfill; a demote without a sourced rival is a wrong winner.
2. **Seed the blocklist from historical refutes.** It only remembers post-deploy kills — SRX's 24236933 (killed pre-deploy) walked back in priced. One-time migration from batch-10/wave-2 verdict records.
3. **RPO×year table.** Adversarial search structurally cannot refute "LSD" (valid one model-year later on the same nameplate). Deterministic (RPO × MY) validity for GM-style short codes; 2024 Equinox → unique LYX.
4. **Fluid correction authority.** Equinox CVT-fluid is now double-flagged (round-7 verifier `expected=DEXRON-VI` + round-10 mirror gate) and still ships. When ≥2 independent gates agree on a deterministic family constant, correct or null — the round-6 harm precedent doesn't apply to multi-gate family constants.
5. **Interval corrector went 1-for-3.** DEX-COOL fix right; Tucson coolant 120k→50k and Equinox brake-fluid months→miles both harmed correct values — the round-6 corrector-harm signature in the path I just enabled. Restrict the write-back to chemistry-floor-class corrections only.
6. **`no_differential` class gate (4th recurrence, SRX).** Number-blacklisting demonstrably can't fix a class problem — fresh wrong diff parts appear each run.
7. Identity residue: Tucson chassis "LET" (unknown codes fail open — consider table-known-nameplate strictness), Crosstrek `_na` key (needs positive FB25D resolution + re-key), GH trim "Hybrid 15 Series" katashiki artifact, GH coverage regression (sibling-migration for verified-cross/universal parts after an identity correction).
8. New defect classes surfaced: phantom PNs from advanceautoparts (2nd instance — domain-level distrust for unverifiable SKUs), wrong-CATEGORY part in a role (Crosstrek "battery" = telematics DCM battery — fitment gates can't see category), `vdb_schedule` rows overriding Maintenance-Minder semantics (Accord), K-series gasket on services (3-for-3 recurrence — verify accessory parts attached to service bundles).

**Bottom line:** batch-11 closes with the identity layer proven fixable and largely fixed (GH reversal, zero identity-driven false refutes), the refute machinery's precision/memory now the dominant open class, and a crisply scoped round-11.
