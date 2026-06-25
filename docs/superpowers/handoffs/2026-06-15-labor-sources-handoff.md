# Labor Sources — Session Handoff (2026-06-15)

**Branch:** `waleed-fix`  ·  **Status:** Phase 3 shipped + reviewed + post-fixed; a design conversation about *extending* sources reached a strategic conclusion that changes the roadmap (read §4).

---

## 1. TL;DR

- **Phase 3 (multi-source labor) is fully implemented, final-reviewed, and post-fixed.** All committed on `waleed-fix` (`d98788b`..`df6faf0`). `tsc -p convex` clean; full suite **463 passing** with only the known pre-existing reds (`customer_late`, `partSelector`; `timeSlotAvailability` is an order-flake that passes standalone). **Nothing is live** — the two new sources are flag-gated **default-OFF**.
- The final review found **no critical issues** and **2 important** ones — **both now fixed**.
- A follow-on design discussion about getting a real 2nd/3rd labor source hit a wall (see §4). **Net: the automated multi-web-source / RepairPal-dollar approach doesn't work**, and there's an **open strategic decision** (§5) for the next session.

---

## 2. What shipped this session (commits on `waleed-fix`)

**Phase 3 plan execution** (subagent-driven, each task spec- + quality-reviewed):

| Commit | What |
|---|---|
| `d98788b` | `web_labor`/`oem_labor` strong; `repairpal_labor` reclassified to corroborator |
| `5b490f3`, `eb6ed4a` | contested ≥2-strong-disagree → confidence **0.75** + `labor_sources_disagree` (+ MAD-edge test) |
| `ac6cb51`, `e2c8e92` | RepairPal firecrawl `$→hr` resolver (+ polish) |
| `5197428` | open-web `web_labor` hours resolver |
| `61412f4` | shared `firecrawlJsonExtract` helper (deduped the firecrawl POST 3→1) |
| `04544cd`, `10f2f8b` | `laborAllSources` orchestrator (+ polish) |
| `e2c6acf`, `67f7c34` | pipeline wiring + `laborRelabor` fleet backfill (+ polish) |
| `ba7e82a` | regenerate `api.d.ts` |

**Post-review fixes:**

| Commit | What |
|---|---|
| `dd3596a` | **Fix #1** — a strong source must *drive* `book_hours` (be within the agreement band of it) to earn confidence 0.8, not merely survive MAD. Guards the "out-voted by low-weight corroborator but still stamped 0.8" bug. +2 regression tests. |
| `9af307f` → `a2d7095` | **Fix #2** — backfill applicability. First attempt read `service_vehicle_specs.is_applicable` (verifier proved that column is written only by the *legacy* per-engine pipeline → empty/no-op for v3-enriched configs). **Corrected** to gate via `services/applicability.ts::getApplicableServices` (the canonical structural gate the booking surface + Oto use), fail-open. |
| `57df908` | web resolver reuses tested `robustStats.median`; warns once (not per-URL) on missing `FIRECRAWL_API_KEY`; added `laborFlagsFromEnv` unit test |
| `df6faf0` | `convex/devOnly/laborWebSpread.ts` — throwaway diagnostic probe (see §4) |

---

## 3. Final review (5-lens adversarial workflow) outcome

- **Critical:** none.
- **Important (both FIXED):** (1) the confidence out-vote bug → `dd3596a`; (2) backfill applicability drift → `a2d7095`.
- **Refuted during verification (not issues):** RepairPal `…-cost` URL suffix is correct; the `repairpal_slug` pipeline-vs-backfill "divergence" is dead code, not a coverage gap.
- **Minors fixed:** stale `olp_labor (0.8)` comment; `robustStats.median` reuse; warn-once on missing key; `laborFlagsFromEnv` test.

---

## 4. Strategic pivot — READ THIS (why the roadmap changed)

We tried to design a real 2nd/3rd labor source so "**3 sources agree in range = correct**" (the desired bar) could actually be met. Grounded it with a **live data probe** (`convex/devOnly/laborWebSpread.ts`, run on a 2018 Honda Civic 1.5T across oil change / spark plugs / brake pads / coolant flush, all web results per service):

- **The open web publishes labor _dollars_, not flat-rate _hours_.** Usable labor *hours* were found for only **1 of 4** services (brake pads), and those came from **dealer-SEO content-farm** pages (`cogginhonda{ftpierce,deland,orlando}.com` — same source under different city subdomains, not independent; one even quoted a *2021* Civic). Oil/plugs/coolant returned **zero** usable hours — just dollar prices (`$157`, `$140 labor`), YouTube videos, and forums.
- **User constraint (firm):** we **cannot reliably convert labor dollars → hours** — shop rates vary by region/shop/year, so there's no trustworthy divisor. This also invalidates the Phase-3 `repairpal_labor` source (it's a `$range ÷ $130` conversion).
- **Therefore:** **OLP is the only reliable _automated_ HOURS source we have.** The multi-web-source idea can't fix coverage because the hours data isn't on the open web; "3 sources agree on hours" is unreachable from public web data.
- **RepairPal:** we found it *does* expose real flat-rate labor times (not just dollars). **Decision: do NOT build any automated/bulk RepairPal source.** Those times are **MOTOR/Chilton-licensed**, and the enrichment pipeline + fleet backfill = bulk extraction across many vehicles/services, which violates RepairPal's ToS and MOTOR's licensing. Only legitimate use is **one-off, user-driven (director) lookups**. *(The technical method is intentionally omitted from this handoff — we are not pursuing it.)*

**Dead-end summary:** open-web hours (data isn't there) ❌ · dollar→hour conversion, incl. RepairPal `$→hr` (unreliable) ❌ · automated/bulk RepairPal real-times (licensing) ❌.

---

## 5. OPEN STRATEGIC DECISION (for next session)

Where does a reliable **automated** HOURS source #2 come from? Two legitimate paths — **user needs to choose**:

- **(A) License the flat-rate data.** MOTOR / Chilton, or a packager (Mitchell1 / AllData / Identifix). Real industry-standard hours, *owned and defensible*. → build an importer like the OLP one. This is the only clean way to get true multi-source agreement at scale.
- **(B) Keep automation on OLP + empirical.** OLP at cold-start + the shop's own **post-job actual labor times** (already captured; becomes the source of truth as volume grows). Use RepairPal real-times only as a **manual, single-vehicle director lookup** (legit, fits the Phase-4 UI), not an automated source.

**Blocking question for the user:** is a MOTOR/Mitchell/Chilton license available or wanted (→ A), or do we commit to OLP + empirical (→ B)?

**Cleanup implied either way (do NOT execute until the decision is made):** `repairpal_labor` (`$→hr`) and likely `web_labor` should come **out of the automated pipeline** — both rest on the unreliable dollar conversion / absent web-hours data. They're default-off so nothing is live; revisit the orchestrator + flags once §5 is decided.

---

## 6. Loose ends / housekeeping

- **`convex/devOnly/laborWebSpread.ts`** — committed (`df6faf0`) as a devOnly diagnostic. Keep or delete next session; it documents the §4 finding and can re-pull the spread for any car.
- **Dev deployment** — the current `waleed-fix` code was pushed to the configured **dev** deployment via `npx convex dev --once` (to run the probe). `FIRECRAWL_API_KEY` lives on the deployment, **not** in `.env.local` — so any firecrawl probe must run on the deployment, not a local script.
- **Shadow-diff / dry-run tool — NOT built.** The spec makes it the mandated gate *before* flipping the new flags (a read-only report of `book_hours`/`confidence`/`disagree` deltas without persisting). Build it before any flag flip — but scope it to whichever sources survive the §5 decision (it may be moot if web/RepairPal are dropped).
- **Deferred minor follow-ups (none urgent):**
  - Retire/align legacy `convex/vehicleEnrichment/olpRelabor.ts` + `scripts/olp-relabor.mjs` (still hardcodes `olp_labor` weight **0.8** vs canonical **0.7**; last-writer-wins, manual-only path).
  - Rare both-strongs-MAD-dropped disagree→0.75 guard (`sourcesDisagree && strong.length >= 1`).
  - `laborRelaborAll` unbounded `vehicle_configs.collect()` (8MB risk at fleet scale; `by_enrichment_status` index exists but is unused).
  - Per-row recompute redundancy in `laborAllSources` (3× per service); web resolver double-fetch (`searchAndFetch` markdown then re-scrapes each URL).
- **DEPLOY/SEED:** the guardrail/tier-floor fallback is inert until `npx convex run seeds/seedCamryBaseline:run` runs on the deployment (dev had 0 Camry rows).

---

## 7. Pointers

- **Spec:** `docs/superpowers/specs/2026-06-14-labor-sources-repairpal-web.md`
- **Plan:** `docs/superpowers/plans/2026-06-14-labor-sources-repairpal-web.md`
- **Memory:** `labor-multisource-phase1.md` (updated this session)
- **Confidence model:** `convex/lib/labor_aggregation.ts` · **bands/classification:** `convex/lib/laborBands.ts` · **orchestrator:** `convex/vehicleEnrichment/laborResearch.ts` · **backfill:** `convex/vehicleEnrichment/laborRelabor.ts` · **applicability gate:** `convex/services/applicability.ts`
