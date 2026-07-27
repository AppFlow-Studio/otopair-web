# F-150 verdict (batch 10)

Fluids/intervals near-perfect — 5/5 traps (MERCON V not SP; plain-MERCON t-case; rear-only 75W-140+XL-3 2.75qt=5.5pt exact; NO cabin filter; 20.9qt coolant exact). ATF 30k justified by detected tow_package (towing schedule by design). Verifier-KB bug confirmed: expected "MERCON LV" is wrong for 4R75E. Air filter 4L3Z-9601-BA VINDICATED (= FA-1754 current suffix). Coil DG-511 ✅, FT-105 ✅, pads BR-1083/BR-1012 ✅, battery BXT-65-750 ✅.

DEFECTS:
P2 (all same class — same-platform, wrong engine/position, from genuine Ford dealer domains, no gate fired):
1. Rear rotor 5L3Z-1125-BA = FRONT 7-lug rotor (correct rear: 4L3Z-2C026-AB 6-lug).
2. Thermostat RT-1194 (=4L5Z-8575-B Duratec 185°F) — correct: 3L3Z-8575-AC.
3. Serp belt 5L3Z-8620-BA = 4.2L V6 w/AC belt — correct 5.4L: 5L3Z-8620-CA.
4. Intake manifold gasket 4L3Z-9461-AA = 4.6L part.
5. Trim "FX4 SuperCrew" vs VDB/NHTSA Lariat (trim not VIN-encoded; only evidence says Lariat; identityResolution regression).
P3: engine_code "995" order-code passthrough (pollutes config_key); coolant "OAT" should be HOAT; coolant sanity band false positive CONFIRMED (20.9 exact); plug gap 1.37mm vs 1.02-1.27 band; front rotor stale 04-05 number (supersedes to same part — acceptable); air filter interval 15k vs OEM 30k (over-service); 4 default_fallback status=scheduled (SYSTEMIC 5/5 w/ Cobalt+BMW+MDX+SRX); $17.50 oil filter price from a 1996 Windstar catalog URL (provenance hygiene).
GAPs: coolant part null (VC-7-B refuted, overzealous but honest); ps fluid part null (XL14 rejected); front-axle 80W-90 not representable (single diff slot); fuel filter service absent from catalog.

PATTERN: engine-level fitment check on scraped dealer pages would catch all 4 P2 parts; they're real Ford parts on trusted domains so source-authority + pattern gates pass them.
