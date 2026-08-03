# Round 15 (batch B) — 5 cold European/Japanese VINs, 2026-07-31

Five **cold** VINs (none previously in the DB), launched through the natural
entry path `vehicleEnrichment/runHeadless:go` — decode → upsert → schedule, no
`force`, no `targetConfigId` pin. Deployment `incredible-poodle-745`,
`ENRICHMENT_STRUCTURED_OUTPUTS=off`.

Raw audits: `audit-<VIN>.json` (from `devOnly/auditRunFlow:auditByVin`).

Distinct from `../round15-2026-07-31/`, which re-audited the round-14 VINs.

## Headline

| Vehicle | status | fill (cfg/run) | applic. fill | parts | quotable | quotability | searches | dur |
|---|---|---|---|---|---|---|---|---|
| MB C43 AMG (S205 wagon) | partial | 76 / 48 | 39 | 2 | **0/2** | 0.33 | 34 | 26.4m |
| Mazda3 (BP) | partial | 66 / 34 | **17** | **2** | 2/2 | 0.45 | **0** | 23.5m |
| Porsche 911 GT3 RS (991) | partial | 81 / 40 | 36 | 10 | 8/10 | 0.58 | 21 | 37.2m |
| Porsche Cayenne E-Hybrid (9YA) | partial | 83 / 44 | 45 | 10 | 9/10 | 0.67 | 27 | 36.0m |
| VW Tiguan (AWD SEL) | partial | 84 / 52 | 42 | 7 | **7/7** | 0.67 | 34 | 32.1m |

All five finalized `partial`. Cost was low (21k–23k tokens in, 6k–20k out,
0–34 searches per vehicle) — an order of magnitude under the 220-search BMW of
the previous round, and coverage tracks that.

## P0 — the 911 GT3 RS was given Cayenne brake pads

| role | 911 GT3 RS (991) | Cayenne E-Hybrid (9YA) |
|---|---|---|
| air_filter | `991-110-130-92` | `PAB-133-843-A` |
| cabin_filter | `991-572-371-00` | `PAB-819-439` |
| front_rotor | `99135140581` | `9Y0-615-302-A` |
| rear_rotor | `99135240402` | `9y0615601a` |
| spark_plug | `99917023790` | `9a790560100` |
| **front_brake_pad** | **`9y0698151an`** | **`9y0698151an`** |
| **rear_brake_pad** | **`9y0698451ae`** | **`9y0698451ae`** |

Every other role separates correctly along platform lines. Both brake-pad roles
are byte-identical across the two vehicles, and they carry the **`9Y0` Cayenne
E3 prefix**; `xxx698151` / `xxx698451` is VAG front/rear pad-set numbering. A
991 GT3 RS uses Porsche `991.351.xxx` pad numbers. The 911's pads are the
Cayenne's.

This is a **present-but-wrong** violation on a safety-critical, quotable role
— and it presents as healthy: `triangle_ok: true`, `refute_flagged: false`,
priced, `confidence 0.7`, and it counts toward the 911's 8/10 quotable.

Ruled out:
- **Sibling inheritance** — `SIBLING_INHERIT_RULES` (types.ts:389) covers only
  `timing_system`, `turbo`, `fuel_injection_type`, `spark_plug_quantity`.
- **Chassis clone** — `cloneFromChassisMatch` stamps `data_quality:
  "chassis_clone"`; both rows are `"scraped"`. The 911's `chassis_code` is
  `null`, the Cayenne's is `9YA`.
- **Cache-key collision** — `buildCacheKey` is
  `make_model_year_trim_sourceType` (scraperQueries.ts:37); the models differ.

Remaining explanation: the parts scrape for the 911 landed on a **Cayenne
detail page on the correct store** (`porsche.oempartsonline.com`), and nothing
verified that the page's own fitment covers the target vehicle. Both rows share
one generic RevolutionParts title, `"1 Set Of Brake Pads Front"`, and one
identical price ($274.88 / $167.96).

RevolutionParts detail pages carry a **"This Part Fits" table** — the probe
harness matches it (`scripts/scrapling-gate.py` `RE_FITMENT`) — but nothing in
`convex/vehicleEnrichment/` parses it. The only reference to that concept
anywhere is a prompt description in `reverseFitment.ts:35`.

The LLM `fitment-verify` pass (v3pipeline.ts:4900+) should have been the
backstop and did not fire: the 911's run carries **no** `fitment_refuted` tag.
Worth checking whether the pads fell outside `VERIFY_MAX_PARTS`, or whether the
verifier confirmed them — the latter would be more serious.

## P1 — batch 2 returned an empty applicable-services set on 5 of 5

`applicable_services_structural_fallback_used` on **every** vehicle;
`applicable_services_unknown` on none.

Two readings, both true:

- **The Round-13 fix works.** This is its first exercise on genuinely cold
  vehicles (the previous round's 4 hits used the *prior-run* fallback, which a
  cold VIN cannot use). Instead of the Yaris canary's `applicable_services_unknown`
  with zero roles checked, the DB-derived structural list carried every run.
- **The keystone bug is at 100% reproduction.** The fallback firing on 5/5
  means batch 2 shipped an empty `services[]` five times out of five. It is
  now well-handled and loudly tagged rather than fixed. The fallback list is
  structural, so it cannot express vehicle-specific applicability — which is
  the likeliest driver of `applicable_fill_rate` sitting at 17–45.

## P1 — corroboration is effectively nil

| Vehicle | adapters that ran | claims | single-source | multi-family agreement |
|---|---|---|---|---|
| Tiguan | pipeline, sylvania, trico | 23 | 23 | **0** |
| Mazda3 | **pipeline only** | 3 | 3 | **0** |
| C43 | pipeline, **brembo**, rockauto | 7 | 7 | **0** |
| 911 | pipeline, rockauto, sylvania, trico | 24 | 23 | 1 |
| Cayenne | pipeline, rockauto, sylvania, trico | 28 | 26 | 2 |

`field_corroboration`: 0%, 0%, 0%, 4%, 7%. Nothing in this batch is meaningfully
backed by two independent families.

- **`brembo` ran on one vehicle of five** — and produced no minimums even
  there. Brembo is an OE supplier to both Porsche and Mercedes-AMG; these are
  the vehicles it should cover best.
- **`wix_filters` ran on zero**, despite the Tiguan and both Porsches carrying
  filter numbers for it to confirm.
- **`rotor_minimums: 0` on all five**, with `rotor_min` error tags 1–3 each.
  The rotor data supply remains unsolved.

## P1 — the Mazda3 ran zero web searches

`web_searches: 0`, `tokens_out: 5767` (others: 15k–20k), `applicable_fill_rate:
17`, 2 parts, 3 claims, no adapter but `pipeline_extraction`. Effectively an
unenriched config that still finalized `partial` and reported `run: complete`.

**Second occurrence of this signature** — the Rogue Sport in the previous round
also logged `web_searches: 0`. Not yet explained; batch 1B appears to produce
nothing rather than to fail loudly.

## P2 — EPA never joins on a fresh run

`epa: null` on all five, as on all five of the previous round.

Not a matcher bug: **`refreshEpaForConfig` has no call site outside its own
file.** The only caller of anything in `epaFuelEconomy.ts` is the 24h cron
(`crons.ts:255` → `refreshStaleEpa`, `limit: 50`). The per-config wire-in named
in the module's own header (`epaFuelEconomy.ts:36`) was never made, so a newly
enriched config cannot carry EPA data until a later cron tick sweeps it up.

## P2 — labor is mostly default_fallback

| Vehicle | aggregated | default_fallback |
|---|---|---|
| Tiguan | 10 | 18 |
| Mazda3 | 9 | 18 |
| 911 | 4 | 23 |
| Cayenne | 2 | 25 |

Interval `months_fill` 26–41%; `default_fallback` 9–14 rows of 27–28 each.

## What went right

- **Identity is clean on all five.** `plugs_match_cylinders: true` everywhere;
  cylinders 4/4/6/6/6 and displacement 2.0/2.0/4.0/3.0/3.0 all match NHTSA
  vPIC. The `engines.cylinders`-carrying-displacement defect did **not**
  reproduce, including on the three vehicles whose displacement is a plausible
  cylinder count (C43 and Cayenne at 3.0, 911 at 4.0).
- **Engine-code recovery worked on 2 of 3 placeholders.** `2l_4cyl → DGUA`
  (EA888 Gen3B) and `4l_6cyl → MA176` (the 4.0 GT3 flat-six) are both correct.
  The Cayenne kept its `3l_6cyl` placeholder and is the one miss.
- **The PHEV was handled correctly.** vPIC reports the Cayenne's *primary* fuel
  as `Electric`; the pipeline stored `"Electric / Gasoline"` and kept
  `spark_plug_quantity: 6`, so oil, plugs and fuel-system service were not
  wrongly suppressed.
- **Transmission fluid specs are specific and right** — `MB 236.17 ATF
  (9G-Tronic 725.0)`, `Pentosin FFL-3 (PDK)`, `Porsche 00004321054 / VW G 060
  162 A2 (ZF 8HP)`. The Tiguan self-flagged `trans_fluid_suspect` +
  `trans_speeds_suspect` rather than asserting confidently.
- **Part numbers that landed are largely correct** — Tiguan `06L115562B` (oil
  filter, EA888 Gen3B), `5Q0129620B`, `3Q0698151`; Mazda3 `PE5R-18-110`;
  Porsche `991-110-130-92`. The Tiguan is the batch's best result at 7/7.
- **NHTSA recall/complaint joins worked** on all five.

## Notes / non-defects

- **The C43 is an S205 wagon** (vPIC `Body Class: Wagon`, `Series: AMG C43
  4-M`), a variant not sold in the US. Sparse US catalog coverage is partly a
  legitimate data-availability fact, not solely a pipeline failure. It still
  found and priced nothing (`0/2`, both `no_trusted_price` from
  `mbparts.mbusa.com`).
- **The 911's $8,230 battery is not a mis-parse.** `scraped_name` is
  `"Lightweight Battery (Lithium-Ion Battery)"` — a real, very expensive GT3 RS
  option. The defect is *role selection*: the exotic optional battery was
  chosen as the core `battery` role rather than the standard AGM.
- **The Mazda3's `PE-VPS` is correct**, not a misdecode — vPIC confirms
  `Engine Model: PE`, 2.0 L, 155 hp.

## Suggested order

1. Parse the RevolutionParts "This Part Fits" table and gate part acceptance on
   it. That is the deterministic fix for the P0, and it is the one signal the
   scrape already downloads and throws away.
2. Determine why the 911's pads survived `fitment-verify` — cap overflow vs a
   wrong "confirmed" verdict.
3. Find why batch 2 returns an empty `services[]` on every cold vehicle.
4. Wire `refreshEpaForConfig` into the pipeline (one scheduler call).
5. Explain the zero-search runs (Mazda3, and the Rogue Sport before it).
6. Adapter reach: why `brembo` ran on 1/5 and `wix_filters` on 0/5.
