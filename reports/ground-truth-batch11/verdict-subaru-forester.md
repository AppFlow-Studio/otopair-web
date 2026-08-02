# Subaru Forester verdict (batch 11)

**VERDICT: PARTIAL** — fluids/specs/intervals side is near-perfect (all fluid traps avoided), but hard-parts side shows systemic same-platform wrong-generation/wrong-vehicle contamination (1 P1 + 4 P2), the batch-10 P0 class again. Fill 86% (self-reported), gaps honest.

**Traps avoided: 6/7** — (2) CVT fluid family: stored CVTF-II AND actively refuted High Torque SOA748V0300; (3) plug interval 60k/60mo, no XT SILFR6-type plug; (4) oil filter drift: gave 15208AA15A, not AA160/AA21A — defensible (see refuted); (5) drivetrain semantics: AWD, gear oil 75W-90 GL-5 (SOA427V1700 = Extra-S) present, differential_service exists, rear diff NOT treated as N/A; (6) EPS: ps_fluid null; (7) coolant 9.0-qt decoy avoided by absence (no capacity reported). **Trap 1 (SJ FB25B contamination) HIT at parts level** — spec-level discriminators all passed (FB25D, 4.4 qt, 60k plugs) but SJ/older-gen part numbers leaked into air filter and front pads (defects 1, 2).

PASS highlights: engine FB25D (GT 1); 0W-20 (GT 2a); **4.4 qt oil — the sharpest SJ discriminator** (GT 2b); CVT type + CVTF-II (GT 3a/3b); coolant TYPE Super Coolant blue (GT 4a); coolant interval EXACT 137,500 mi / 132 mo (GT 4c, sanity flag fired appropriately, flag-only); plug qty 4 + 60k interval (GT 5); oil 6k/6mo + tire rotation 6k/6mo (GT 7); brake fluid flush 30k (GT 7/11); cabin filter 72880FL000 present (GT 6b); rear pads 26696AL020 verified 2019-2024 Forester; trans filter 31835AA030 verified 2014-2025 Forester CVT; refute gates correctly killed Ascent rear pads 26696XC00A and FA24-turbo plug 22401AA92A (SILKFR8A6). Prices in/near band where present (oil filter $7.02 sale vs GT $7.50–8.60 online; cabin $18.32; pads $69.65–102.05/set; rotors priced per-unit with qty 2 — no per-set confusion).

Refuted candidates (adversarially verified, NOT defects):
- Oil filter 15208AA15A ≠ GT catalog 15208AA170: parts.subaru.com lists AA15A for the 2019 Forester; it is the current universal replacement for FB25 engines (supersession past AA160/AA170). Defensible — flag-not-fail.
- Rear brake pads 26696AL020: confirmed 2019-2024 Forester OEM rear pad kit (Amazon/dealer fitment), despite AL (Legacy/Outback) chassis code in the number.
- CVT transmission filter 31835AA030: genuine CVT cooler filter, Forester 2014-2025 — valid.
- Cabin filter chosen as 72880FL00A vs GT 72880FL000: FL00A is a genuine Subaru cabin filter listed for the Forester family; revision-suffix pattern (000→00A) — flag-not-fail, both entries persisted.
- Spark-plug refute of 22401AA92A was CORRECT (2.4L FA24 turbo plug, Ascent/Legacy XT) — honest gap, not an over-refute.
- Oil filter price $7.02 slightly below GT online band — sale price, honest.

DEFECTS:

P1-1. **Engine air filter 16546AA12A is the 2009-2014 SJ/older-gen part, NOT the 2019 SK filter** (GT 6a: 16546AA16A). Verified: Amazon/parts.subaru.com fit AA12A to Forester 2009-2014 (broader 2007-2019 dealer range is Legacy fitment). Chosen into core signature at conf 0.95 from subaru.oempartsonline.com (2 sources, 5 price rows); the correct 16546AA16A appears NOWHERE in the output. This is GT trap 1 (SJ contamination) landing at part level — the "2007-2019 Subaru" dealer-domain year-range spanning models is exactly the batch-10 trusted-dealer wrong-vehicle P0 class.

P2-1. Front brake pads 26296SC011 = 2010-2018 fitment (verified: dealer sites + Amazon "2010-2016 Impreza/Forester/Legacy"), wrong for 2019 SK. Aggravating: the fitment refute gate FLAGGED it and a multi-source override kept it (`fitment_refute_kept_multisource:front_brake_pad:26296SC011` in run_errors) — the gate was right, the override was wrong. Correct SK front pad (26296FL01A family) absent.

P2-2. Front rotor 26300XC01A + rear rotor 26700XC00A = **2019-2025 Ascent only** (verified parts.subaru.com/oempartsonline — no Forester fitment), yet both won core-signature selection. The correct Forester rotors 26300SJ010 / 26700SJ000 (sourced from parts.subaru.com) sit in the parts list as unpriced secondaries.

P2-3. Serpentine belt core-signature winner 23780AA10A = 2019+ Ascent/Legacy/Outback (FA24 family) belt; the correct 2019 Forester belt 23780AA200 (parts.subaru.com, verified 2019 Forester fitment) is present but unpriced and lost selection.

P2-4. Coolant PART SOA868V9210 chosen as primary = old GREEN "Subaru Long Life Coolant" (factory fill for pre-Super-Coolant engines), incoherent with the pipeline's own (correct) coolant_type "Subaru Super Coolant"; correct SOA868V9270 (GT 4a) present as unpriced secondary. Wrong fluid family if actually purchased.

SYSTEMIC (mechanism behind P1-1/P2-2/P2-3/P2-4): in every case the CORRECT part exists in the parts list, sourced from parts.subaru.com, with an EMPTY prices array — and the wrong-vehicle part with attached prices won core-signature arbitration. Selection appears to prefer priced/multi-priced entries over catalog-authoritative unpriced ones. Fix candidate: parts.subaru.com year-scoped fitment should outrank price-count; and duplicate-role pairs (2×cabin, 2×belt, 2×front rotor, 2×rear rotor, 3×coolant, 3×brake fluid) should force an arbitration pass instead of silent winner-take-all.

P3: filter_replacement interval 45k/36mo matches neither booklet air-filter 30k nor cabin 12mo/12k (GT 7) — single merged row under-serves cabin, over-serves air; transmission_service scheduled 60k/48mo + differential_service scheduled 60k vs W&M inspect-only under normal use (GT 3c/7) — over-service, defensible as common practice; honest gaps: spark-plug part null (GT 22401AA940 was dealer-only until Dec 2023 — hard target), CVT-fluid part number null (type stored correctly), engine-oil part null (SOA427V1410 refuted — not verified whether over-refute), coolant capacity absent; triplicate brake-fluid entries (SOA868V9220/9221/9222) unverified DOT variants — dedup/coherence surface.

Audit-side note (not a pipeline defect): one part entry in audit-forester.json has null name/oem (brake_fluid_flush role) due to transient CLI dump failures on my side; cross-checked against collect-forester.json, which is complete — it corresponds to brake fluid SOA868V9220 (parts.subaru.com), price set $6.35/$7.11/$7.22 identical to the SOA868V9221 row.
