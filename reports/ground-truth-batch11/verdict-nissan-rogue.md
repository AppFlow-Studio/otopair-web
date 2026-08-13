# Nissan Rogue verdict (batch 11) — 2017 Rogue SV AWD, VIN 5N1AT2MV8HC781921

**VERDICT: PARTIAL** (one P1 in the stored CVT-fluid spec field; everything purchasable is correct). **Fill score: 94** (pipeline fill_rate; honest nulls for gear_oil/ps_fluid). **Traps avoided: 9/10.**

Config: `2017_nissan_rogue_base_qr25de`, chassis T32 — engine identity correct (QR25DE, no order-code passthrough this time), trim wrong ("Base", see D5).

## Trap scorecard (GT "Adversarial traps" 1–10)

| # | Trap | Result |
|---|------|--------|
| 1 | NS-2 / ATF instead of NS-3 CVT fluid | **FAIL (spec field)** — part line is genuine NS-3 (999MP-CSHNS3 ✅) but `trans:fluid`/`transmission.fluid` stored **"Nissan Matic S"** (stepped-automatic ATF). See D1 |
| 2 | Spark plug 3-way cross (22401-JA01B S35 / 22401-1VA1C Rogue Sport / "Altima=wrong" over-fire) | AVOIDED — stored 22401-3TA1B, the correct Altima-shared T32 plug (GT 5a) |
| 3 | Rogue Sport / MR20 contamination | AVOIDED — every part QR25DE/T32-fitting; oil 4.9 qt not MR20 values |
| 4 | First-gen S35 / Rogue Select parts | AVOIDED |
| 5 | Cabin-filter facelift split (4BA0A vs 5HA0A) | AVOIDED via supersession — see Refuted #1 |
| 6 | Oil interval inflation (7.5k/10k) | AVOIDED — 5,000 mi / 6 mo stored, matches BOTH official schedules (GT 7) |
| 7 | "Sealed lifetime CVT — no service" | AVOIDED — transmission_service 60k + full drain-and-fill kit (NS-3 fluid, internal filter 31728-28X0A, external cooler filter 31726-28X0A, pan gasket 31397-1XF0C) |
| 8 | Fabricated PS-fluid line (vehicle is EPS) | AVOIDED — `part:ps_fluid` null, no PS interval/spec anywhere (GT 10a) |
| 9 | Coolant color/era | AVOIDED — Nissan Long Life blue, part 999MP-L25500P (GT 4a) |
| 10 | Hybrid trim bleed (MR20DD values) | AVOIDED |

## PASS highlights

- **Fluids core**: 0W-20 ✅, 4.9 qt exact ✅ (GT 2a/2b, ~5.4 qt trap dodged), coolant blue LL ✅, brake fluid 999MP-A4100P (Nissan DOT 3) ✅, ps_fluid null ✅.
- **Filters/plugs**: oil filter 15208-65F0E ✅ (GT 2c), air filter 16546-4BA1A ✅ (GT 6a), spark plug 22401-3TA1B qty 4 ✅ (GT 5a/5b) — all three plug decoys dodged including the reverse trap (the Altima part IS correct here).
- **Intervals**: oil 5k/6mo (both OEM schedules, vdb_schedule 3 sources) ✅; plugs 105k ✅ (GT 5c); coolant 105k/84mo first-replace exact ✅ (GT 4c); CVT 60k inside GT 30–60k band ✅ (GT 3d); brake fluid 20k in band ✅; filter_replacement 15k in band ✅.
- **Prices** (GT row 8): oil filter $6.58 in $6–10 ✅; air filter $25.48 in $20–35 ✅; cabin filter $29.03/$34.06 in $25–42 ✅; spark plug $24.78 **per unit** in $17–36 with qty 4 — no per-set/per-unit confusion ✅.
- **Battery**: 24410-JA10B = the T32 factory Group 35 / 550 CCA battery (supersession chain to 999M1-ND35C listed for 2017 Rogue) — matches GT row 9.
- **Brake parts all verified for T32 2.5** (batch-10's P0 wrong-engine class did NOT recur): front pads D1060-4BT0C (2014–2019 Rogue 2.5 ✅), rear pads D4060-4CU2A ✅, front rotor 40206-4BT0B ✅, rear rotor 43206-4BT0B (2013–2020 QR25DE FWD/AWD ✅). Serp belt 11720-3TA0C = 2013–2020 Rogue 2.5 current suffix ✅.
- **Batch-10 systemic P3 FIXED**: the 4 default_fallback rows (fuel system 60k, battery 60k, rotors 70k, tires 50k) now carry status **"estimated"**, not "scheduled" — round-8 fix confirmed live.
- Round-7 trans-fluid reconcile flag fired (`trans_fluid_suspect ... stored=Nissan Matic S:expected=Nissan CVT Fluid NS-3`) — the safety net saw D1 even though (by design, post-batch-8) it did not overwrite.

## Refuted candidates (adversarially checked, pipeline vindicated)

1. **Cabin filter 27277-4BU0A** (vs GT 6b's 27277-5HA0A) — VINDICATED. 4BU0A is the *current superseding* part: nissanpartsdeal/oempartsonline list it as replacing BOTH 27277-4BA0A and 27277-5HA0A, fitment 2014–2020 Rogue incl. 2017 S/SV/SL explicitly. Pipeline beat the GT row; trap 5 avoided. Prices ($29.03/$34.06) inside the GT band.
2. **Ignition coil 22448-1KT1A** — suspected Sentra/Juke cross; actually the shared L33/Z52/R52/**T32**/B17 coil, listed for T32 Rogue on nissanparts.cc/parts.nissanusa.com. Correct.
3. **Rear rotor 43206-4BT0B** — suspected wrong-position/platform; confirmed 2013–2020 Rogue QR25DE rear (non-EPB) on parts.nissanusa.com. Correct.
4. **Battery 24410-JA10B** — confirmed Group 35 550 CCA factory part for T32. Correct.
5. **Differential_service 20k/24mo** (AWD rear diff) — aggressive but defensible under Nissan Schedule 1 severe-use guidance; not GT-covered; no defect recorded.

## DEFECTS

**P1**
1. **`trans:fluid` / `transmission.fluid` = "Nissan Matic S"** — Matic S is Nissan's ATF for stepped automatics, never spec'd for any CVT; OM: "Using transmission fluid other than Genuine NISSAN CVT Fluid NS-3 will damage the CVT" (GT 3a/3b, trap 1). The customer/shop-facing spec string and `core_signature` carry the wrong fluid class. Mitigations that keep this from P0: (a) the purchasable part line is genuine NS-3 999MP-CSHNS3 quart, so anything ordered through the parts path is correct; (b) the round-7 reconcile flag fired in run_errors naming exactly this contradiction (flag-only by design since batch-8). Record remains internally contradictory and unresolved.

**P2**
2. **"Thermostat" role = 11060-3TA0B, which is the thermostat HOUSING / water outlet**, not the thermostat element (fits 2014–2020 Rogue 2.5 — right vehicle, wrong component type; the QR25DE thermostat proper is a 21200-series part). A shop ordering off this line for a coolant_flush gets an $85 plastic outlet with no thermostat in it. Same family as batch-10's role/part semantic misses, but right-vehicle so P2 not P0-class.

**P3**
3. **Tire rotation 10,000 mi vs OEM 5,000 mi** (GT 7; Nissan pairs rotation with the 5k/6mo oil service on both schedules). 2x under-service, single source, yet stored at confidence 0.9 / data_quality vdb_schedule.
4. **Trim "Base"** (configKey `..._base_...`) — "Base" is not a Rogue trim (S/SV/SL); both listing sources say **SV**, first aborted decode said "S". Affects wheel/tire (and potentially SL 18" brake) selection only; all maintenance parts verified trim-agnostic for 2.5, so P3 per scope — but identity provenance ignored the listing evidence twice.
5. **Variant KB names the CVT "Jatco JF017E / RE0F10D"** (run_errors flag text) — the 2017 Rogue 2.5 uses the JF016E (RE0F10H); JF017E is the Murano/Pathfinder unit. No functional impact (both NS-3) but the transmission-model mapping in the verifier KB is wrong for this config.
6. **transmission_service months companion = 24** alongside 60,000 mi — a 24-month time trigger fires at ~2 yrs (~24k mi typical), contradicting its own mileage basis; over-service direction, but the pair is incoherent.

## GAPs (honest absences, not defects)

- Plug gap 1.1 mm not stored (GT 5b); coolant capacity 8.1 L not stored (GT 4b); brake_fluid_flush has no months companion (GT: 24 mo); coolant subsequent-interval (75k/60mo after first 105k) not representable.
- Rear-diff gear oil part null despite AWD + differential_service interval present — capacity candidates rejected as single-mid-tier-source (run_errors), honest.
- Oil filter $14.99 rows from autozone/oreilly under the OEM part number are almost certainly OEM-equivalent listings, not 15208-65F0E (provenance hygiene note; OEM-source price $6.58 is in-band).

## PATTERN

The parts path and the spec path disagree and only a flag bridges them: extraction stored a wrong fluid *name* (Matic S) while shopping found the right fluid *part* (NS-3). A cheap reconcile — when the purchasable fluid part's own product title ("NS3 CVT Fluid") contradicts the stored spec string, prefer/overwrite the spec from the OEM part title on dealer domains — would have self-healed D1 without the risks that killed the round-6 corrector, because the evidence is the pipeline's own high-confidence (0.97) part, not a fresh web claim. Also: supersession awareness cut both ways this batch — it vindicated the cabin filter but the verdict process (and GT authors) need supersession chains checked before flagging any part-number mismatch.
