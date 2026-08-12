# RAV4 verdict (batch 11) — 2012 Toyota RAV4 Base 2.5L 2AR-FE, VIN 2T3ZF4DV9CW150689

**OVERALL: FAIL.** Fluids/identity flawless; parts layer shipped a 5-part wrong-model-year cluster plus a V6 coil, and the flagship 10k-oil-interval trap fired as `scheduled` at 0.95 conf. Fill 92 (self-reported; real gaps: trans type UNKNOWN, coolant capacity absent, battery group absent).

**Identity check:** audited artifacts show configKey `2012_toyota_rav4_standard_2ar_fe`, trim "Standard", chassis A30, drivetrain FWD — matches NHTSA Base/Standard decode. NO "sport" mis-ID present in the delivered collect/audit output (the sport key referenced in the audit brief does not appear; if an earlier run emitted it, it was corrected before this snapshot). PASS.

**Trap avoidance: 5/8.**
- ✅ T-IV vs WS: ATF WS everywhere (part 00289-ATFWS + trans:fluid "Toyota Genuine ATF WS"); serviceable-unit semantics kept (filter/pan-gasket line items, no sealed-trans claim). The critical trap, cleanly avoided.
- ✅ 2AZ-FE decoys: none (4.6 qt, 2.5-era parts).
- ✅ Coolant 8.9L decoy: avoided (capacity absent, not wrong).
- ✅ Spin-on oil filter: avoided — cartridge 04152-YZZA1 ✅.
- ✅ PS fluid: ps_fluid null, no PS service row (EPS handled — the Cobalt P1-c class did NOT recur).
- ❌ Oil interval 10k (trap 5): FIRED — see P1-a.
- ❌ 2013+/next-gen decoy parts (trap 3): FIRED x4 — see P1-b (includes the exact GT decoy cabin filter 87139-07020).
- ❌ V6 contamination (trap 2): FIRED via ignition coil 90919-A2002 — see P1-c. (Plug qty 4 ✅, oil 4.6 qt ✅, no U151F trans claim — only the coil leaked.)

**PASS highlights:** 2AR-FE ✅; 0W-20 / 4.6 qt ✅ (GT 2a/2b); SLLC pink coolant ✅ (4a); oil filter 04152-YZZA1 cartridge with prices $4.60-4.68 inside GT band (2c/8); drain plug gasket 90430-12031 ✅; ATF WS ✅ (3b); brake fluid 00475-1BF03 DOT3 ✅ (11); serpentine belt 90916-02668 verified 2009-2018 RAV4 2.5 ✅; thermostat 90916-A3003 verified 2AR-FE fit ✅; pads 04465-0R010 / 04466-42060 and rotors 43512-0R010 / 42431-0R010 are genuine RAV4 catalog numbers; intervals: plugs 120k ✅, coolant 100k/120mo ✅, tire rotation 5k/6mo ✅, filters 30k ✅ (GT 5/4c/7/6a-b). Price semantics clean: plug priced per-unit qty 4, pads per-set, rotors per-unit qty 2 — no per-set/per-unit confusion.

**Refuted candidates (adversarially verified, NOT recorded as defects):**
1. Trans strainer 35330-08010 "V6-5AT-only" (rav4world claims I4 uses 35330-28010) — REFUTED as P1: toyotapartsdeal fitment table lists 2006-2012 RAV4 incl. 4-cyl 2.5L. Conflict downgraded into P2-b.
2. Thermostat 90916-A3003 — suspected non-2AR part; verified fits 2008-2018 RAV4 2.5L incl. 2AR-FE. PASS.
3. Serpentine belt 90916-02668 — suspected Camry-only; verified 2009-2018 RAV4 2.5 (Mitsuboshi, one of two valid PNs alongside 90916-A2021). PASS.

## DEFECTS

**P1-a. Oil interval 10,000 mi / 12 mo as `scheduled`, conf 0.95, source_count 2** (GT row 7, trap 5). 2012 RAV4 W&MG = 5,000 mi / 6 mo (0W-20 is preferred-not-required; the 10k interval starts with the 2013 4th gen). Verified via Firestone 2006-2012 RAV4 schedule + Beechmont Toyota. 2x underservice sold as OEM schedule — worst-severity interval defect (contrast: tire rotation got 5k/6mo RIGHT from the same schedule, so the oil row specifically absorbed the 2013+ decoy).

**P1-b. Wrong-model-year parts cluster (4 parts) — 2013+/Camry-platform decoys from trusted dealer domains** (GT rows 5, 6a, 6b, 9; trap 3):
- Spark plug **90919-01259** → fits 2012-2017 Camry / 2015-2018 RAV4; NOT 2009-2012 RAV4. Correct: **90919-01253** (DENSO SC20HR11). No supersession chain 01253→01259 exists. Wrong reach/heat-range risk on install.
- Engine air filter **17801-0V020** → 2013-2018 RAV4 / 2012+ Camry; NOT 2012 RAV4 (toyotapartsdeal fitment). Correct: **17801-31120** (or 17801-AD010). Won't seat in the 3rd-gen airbox.
- Cabin filter **87139-07020** → the EXACT GT decoy (trap 3); fitment = 2012+ Camry, 2013+ 4Runner/Corolla/Avalon — no 2006-2012 RAV4. Correct: **87139-02090**.
- Battery **28800-28100** → 356 CCA unit for 2012-2017 Camry / 2015-2018 RAV4; GT row 9 = Group 35 (~640 CCA class) for this tray.
Root-cause signature: dealer pages titled "2012-2018 Toyota <part>" (Camry-led year band) matched on the year 2012 while RAV4-specific fitment starts 2013/2015 — page-year-range vs model-fitment confusion. All four prices in the audit file ($13.96 plug, $19.71-22.60 air, $19.71-26.99 cabin, $239-279 battery) are quotes for the WRONG parts. Same P0 class as batch-10 (same-platform wrong-engine OEM parts from trusted dealer domains), now in wrong-generation form.

**P1-c. V6 ignition coil 90919-A2002 on I4 config** (GT trap 2). 90919-A2002 is the 2GR-FE V6 service coil (Avalon/Camry V6/Sienna/RAV4 V6). The 2AR-FE uses 90919-02252-family coils. Wrong-engine contamination; also qty 1 (engine has 4) and priced partly from lexuspartsnow.com.

**P2-a. transmission_service 60,000 mi / 36 mo as `scheduled`, conf 0.75** (GT 3d). US normal schedule = inspect only, no replacement; 60k is the towing/special-conditions interval. Conservative but presented as universal OEM schedule; the 36-month term has no W&MG basis.

**P2-b. Transmission kit fitment suspect**: pan gasket **35168-21011** fitment lists Avalon/Camry/Highlander/Sienna — no RAV4 at all; strainer 35330-08010 has conflicting evidence (dealer catalog: fits 2006-2012 RAV4 2.5; rav4world: V6-5AT-only, I4 = 35330-28010). At minimum unverified for the U241E in this FWD VIN; sold with a $56-60 price row.

**P2-c. brake_fluid_flush 24 mo as `scheduled`, conf 0.85** (GT row 11). US W&MG has no fixed brake-fluid replacement interval (inspect at services); a dealer-convention flush presented as OEM schedule. Same class as Cobalt P2-a but milder (non-damaging).

**P3-a. trans:type UNKNOWN** (GT 3a) — knowable: 4-speed Super ECT, U241E for this 2WD VIN. Honest gap, but a decode-level fill miss on a HIGH-conf GT field.

**P3-b. brake_pad_replacement 50k as `scheduled`** (conf 0.8, source 1) — wear item as fixed schedule; recurrence of the batch-10 systemic pattern (here "enriched" rather than default_fallback; the true fallback rows — rotors 70k, tires 50k, battery 60k, fuel system 60k — are all correctly `estimated`).

**P3-c. Hygiene**: intake manifold gasket (171770P021) and ignition coil attached to spark_plugs service (plug change on 2AR-FE doesn't require manifold removal... it does require removing the coils but not replacing them); two anonymous price rows (oem/name null) for drain-gasket and battery under oil_change/battery_replacement; coolant_flush price spread mixes $61.29 (gallon SLLC) with $21-23 rows on a null-oem line; battery_replacement estimated at 60k miles with no month term (batteries age by time).

Cross-refs: P1-b root cause ("2012-2018" dealer page year-band ≠ model fitment year) is a NEW mechanism distinct from batch-10's same-platform wrong-engine class — needs a fitment-table year+model gate, not just an engine gate. EPS and default_fallback-status regressions from batch 10 did NOT recur.
