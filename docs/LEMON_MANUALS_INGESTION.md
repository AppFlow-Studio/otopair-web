# LEMON Manuals — Ingestion Research & Design

**Status:** Design / investigation. One code change landed so far (see [§7](#7-current-code-state)).
**Date:** 2026-08-05
**Owner decision on file:** Waleed explicitly accepted the copyright/legal risk of using this source and directed us to connect it. This doc records *what the source is*, *how it's structured*, and *how to ingest it the way the pipeline already extracts manuals*. It does not re-litigate the risk decision.

---

## 1. What LEMON Manuals is

A free, offshore repository of automotive **factory service manuals** (not owner's manuals). Self-described on its own pages:

- Tagline: *"scientia non olet"* ("knowledge has no smell").
- Launch banner: *"So it begins. Don't worry, this is not in the correct legal jurisdiction!"*
- NFO: manuals are *"from a commercial manual provider… never seen the light of day before"*; the project is *"ideologically motivated and accept[s] neither advertising nor donations."*

**Three rotating domains** (built to survive takedowns — if one dies they buy another):

| Domain | Country |
|---|---|
| `lemon-manuals.la` | Laos (primary on launch) |
| `lemon-manuals.org.ua` | Ukraine |
| `lemon-manuals.gy` | Guyana |

**Coverage (from the NFO):** 56 model years (1960–2025), ~10,000 vehicles (make/year/model), ~200,000 variants, ~60M pages, service manuals + technical bulletins + labor times. Includes the older **CHARM** corpus (see [§5](#5-what-charm-is)).

> ⚠️ This is a piracy host. It is **not OEM** and is **not** a neutral republisher — treat it strictly as a low-trust mirror. Any data sourced from it must carry non-OEM provenance.

---

## 2. Site structure (the important part)

The live site is a **static directory tree** (Apache-style autoindex + generated HTML), not a JS SPA. Path grammar:

```
/{Make}/{Year}/{Trim}/
    ├── Repair and Diagnosis/                    ← content, split across sub-folders/pages
    ├── Repair and Diagnosis (Single Page)/      ← the whole tree of links on ONE page
    └── Labor Times/
```

Example trim folder: `/Honda/2021/CR-V EX, AWD/` (trims are drivetrain/engine-qualified, e.g. `CR-V EX, AWD`, `Accord Sport, 1.5L Eng`).

### 2a. "Single Page" is an INDEX, not content
The `Repair and Diagnosis (Single Page)` doc is a ~3.3 MB nested `<ul>/<li>` **link tree** (~9,363 `href`s, ~12.5k `<li>`). It literally says *"You are viewing the full tree of links on one page."* Keyword scan: `mile` = 0, `interval` = 0 — because it's only link labels. **Its value is as a machine-readable index** of every content page's URL.

### 2b. Leaf pages are clean, tabular content
The actual data lives on leaf pages the tree links to. The highest-value leaves for us are **"Service Specifications → Standards and Service Limits"** pages, which are real HTML `<table>`s. Verified example — `…/Engine Cooling System - Service Specifications/Standards and Service Limits (2020-21)/Cooling System/`:

| Item | Value |
|---|---|
| Coolant capacity (coolant change) | 6.3 L (1.66 US gal) |
| Coolant type | Honda Long Life Antifreeze/Coolant Type 2 |
| Thermostat opening temp | 169–176 °F begins / 194 °F full |
| Expansion tank cap pressure | 93–123 kPa (13.5–17.8 psi) |

This is exactly the **fluids / capacities / specs** class of data the enrichment pipeline already extracts.

### 2c. What LEMON does NOT have
It's a **repair/service manual**, so there is **no owner's-manual mileage maintenance schedule** (oil every X miles / Y months). That data comes from the OEM-manual path ([§6](#6-how-the-pipeline-already-parses-manuals)), not LEMON.

---

## 3. The `.zip` bundle route — blocked by design (do not automate)

Each vehicle has a `/bundle/{Make}/{Year}/{Trim}/` "Download .zip" link. It is **not** a direct file — it's an HTML page with a POST form gated by an anti-automation check:

```html
<label>To prevent automated downloads, please type "human": </label>
<input name="captcha" pattern="[hH][uU][mM][aA][nN]">
```

The page states: *"This… effectively prevents the vast majority of automated web crawlers"* and *"**please do not automate the download of these .zip files.** Instead… bulk download the full database using a torrent."*

**Decision: we will not build an automated bypass of this CAPTCHA/bot-gate.** That's a firm line independent of the copyright question. The gate is only on `.zip` bundles — the HTML content pages ([§2b](#2b-leaf-pages-are-clean-tabular-content)) are ungated.

---

## 4. The torrent route (bulk / offline)

The operator's sanctioned bulk method. `/lemon-manuals.torrent` (327 KB bencoded file).

- **17 trackers** (public UDP + HTTPS).
- **Piece length 64 MB**, 16,310 pieces, **~1.1 TB total**, only **12 files**.
- Data is stored in **`.mtbl`** files — the [mtbl](https://github.com/farsightsec/mtbl) immutable sorted key→value format (open source; Python bindings: `pymtbl`). `index.json` maps a vehicle → page keys inside the `.mtbl` blobs.

| File | Size | Notes |
|---|---|---|
| `lemon-manuals/charm/images.mtbl` | **510 GB** | CHARM scanned images |
| `lemon-manuals/lemon/images.mtbl` | **448 GB** | LEMON scanned images |
| `lemon-manuals/charm/pages.mtbl` | 31.7 GB | CHARM **text** |
| `lemon-manuals/lemon/pages.mtbl` | **29.4 GB** | LEMON **text** ← the useful one |
| `lemon-manuals/lemon/index.json` | 133 MB | vehicle → page-key index |
| `lemon-manuals/charm/index.json` | 5 MB | |
| `lemon-website.exe` / linux binaries / source | ~22 MB | their local server — **skip** |

**~958 GB of the 1.1 TB is images. Only ~61 GB is text.**

### Can you pull just pieces? Yes.
1. **File selection (no code):** any torrent client (qBittorrent) can deselect files. Grab only `lemon/index.json` + `lemon/pages.mtbl` = **~29.5 GB**, skip the 448 GB image blob. That's the whole LEMON text corpus.
2. **Sub-file piece prioritization (rarely worth it):** with `libtorrent` you can prioritize only the 64 MB pieces covering a key's byte range in `pages.mtbl`. Not worth it when the full text is ~30 GB.

### Two cautions
- **Do not run `lemon-website.exe` or the bundled Linux binaries** — untrusted code from a piracy torrent. `mtbl` is an open format; read `index.json` + `pages.mtbl` with `pymtbl` in our own code.
- **Torrent cannot run on Convex or Anthropic servers** — it needs raw UDP/TCP sockets, a long-lived process, and local disk. Convex actions only have `fetch`. So the torrent, if used, runs on **a machine we operate**, and Convex reads the pre-extracted result.

---

## 5. What CHARM is

From the NFO: *"the classic CHARM manuals for cars from 1982–2013."* CHARM is a **separate, pre-existing** car-manual database (an older leak) that LEMON bundles in — recompressed — for extra coverage. LEMON = their new 1960–2025 commercial-sourced set; CHARM = the older 1982–2013 set. CHARM is image-heavy (510 GB images vs 32 GB text).

---

## 6. How the pipeline already parses manuals ("the way we already do")

There are **two** existing manual paths. Neither should be reinvented.

### Path A — Web manual markdown → batch extractor (the general path)
1. `scrapeManual()` — [`convex/vehicleEnrichment/scraper.ts:586`](../convex/vehicleEnrichment/scraper.ts) — runs web searches, collects markdown from result pages (skipping `BLOCKED_DOMAINS`), caches it under scrape-cache `sourceType: "owner_manual"`, returns `{ markdown, urls }`.
2. That `manualMarkdown` is passed into `buildBatch1Prompt(vehicle, vPicData, partsMarkdown, manualMarkdown, packages)` — [`v3pipeline.ts:2958`](../convex/vehicleEnrichment/v3pipeline.ts), request `batch1a`.
3. Claude does **structured extraction only** (no web search) against the `batchSchemas` output schema (`BATCH_1A_FIELD_ROW_KEYS`, `BATCH_1A_INTERVAL_KEYS`, `OEM_PART_KEYS`) — fluids, capacities, specs, part numbers, etc.

**This is the seam LEMON should feed.** If LEMON content becomes `manualMarkdown`, the existing batch1a extractor parses it with zero new extraction logic.

### Path B — OEM PDF → forced-tool extraction (maintenance schedules)
`manualLibrary.ts` discovers an OEM **PDF**, uploads it to the Anthropic Files API, and extracts the **maintenance schedule** (`service_intervals`, `data_quality: "oem_manual"`) via a forced tool call with citations. **LEMON is not relevant to Path B** — it serves no PDFs and no mileage schedule (see [§2c](#2c-what-lemon-does-not-have)).

---

## 7. Current code state

One change has landed:

- **`convex/vehicleEnrichment/manualLibrary.ts`** — `lemon-manuals.la` added to `MANUAL_MIRROR_DOMAINS` (the `-40`, never-OEM mirror list). This is currently **inert**: Path B is PDF-only and LEMON serves no PDFs, so it never produces a candidate. It's a correct provenance marker but does nothing until the HTML route below exists. (Deploy validated with `npx convex dev --once --typecheck disable`; the project has 4 **pre-existing, unrelated** TS errors in `hooks/useEnsureConvexUser.ts` and `lib/inspection-template.ts` that block a normal `convex dev`.)

---

## 8. Proposed ingester (website route)

A Convex-native adapter that turns a vehicle into LEMON manual markdown for the existing batch1a extractor. Selective, on-demand, no torrent infra.

**New module:** `convex/vehicleEnrichment/sourceAdapters/lemonManuals.ts` (matches the existing `sourceAdapters/` pattern).

Pipeline for one vehicle:

```
resolve make → LEMON make folder (handle divergences: "Dodge and Ram", "Nissan-Datsun", "Mercedes Benz")
  → GET /{Make}/{Year}/                 list trim folders
  → fuzzy-match our {trim, drivetrain, engine} to a LEMON trim folder
  → GET  …/Repair and Diagnosis (Single Page)/    (the link-tree index, §2a)
  → selectRelevantLeaves(tree)          allowlist is PER-MAKE VOCABULARY, not Honda's:
                                        Honda "Standards and Service Limits", Toyota
                                        "Service Specifications" + "…Standard Capacity",
                                        Ford "General Specifications"/"Capacities"/
                                        "Lubricants, Fluids, Sealers and Adhesives".
                                        Subsystem bonus breaks equal-weight ties;
                                        dedupe by path AND by content; cap ~12 fetches
  → GET each leaf                       (§2b clean spec tables)
  → htmlLeafToMarkdown()                strip chrome; render <table> rows to readable text
  → concat as "--- Source: {url} ---\n{md}"   (same shape scrapeManual returns)
```

**Extraction:** feed the resulting markdown into **Path A** ([§6](#6-how-the-pipeline-already-parses-manuals)) — i.e. include it in `manualMarkdown` so `batch1a` extracts it. No bespoke parser.

**Provenance:** LEMON is a mirror. Extracted rows must **not** be stamped `oem_manual`/`deterministic`. Use a non-protected quality (e.g. `enriched`) so `shouldOverwriteInterval`/field-precedence lets OEM, deterministic, and mechanic-verified data always win.

**Design rules to keep (mirrors the rest of the pipeline):**
- **Fail-open:** every network path returns empty/null, never throws — must not be able to break an enrichment run.
- **Cache** the fetched markdown (reuse the scrape cache, `sourceType: "owner_manual"`, with the LEMON source URL) so we don't re-hit the host.
- **Cap** total chars and leaf count; bound per-request fetches.
- **Never** touch the `.zip` bundle / CAPTCHA (§3).

**Deliverables (suggested build order):**
1. Adapter module with **pure, testable** helpers (make-folder map, trim matcher, leaf selector, HTML-table→markdown) + a `fetchLemonManual` action returning `{ markdown, urls }`.
2. A **preview** internalAction (`previewLemonIngest`) that returns the markdown + selected leaf URLs + char counts, so we can eyeball data quality on a few vehicles before wiring.
3. Wire into `scrapeManual` as an **additive, fail-open** manual source so `batch1a` extracts it in production.

---

## 9. Website route vs torrent route — recommendation

| | Website route (Convex `fetch`) | Torrent route (own box) |
|---|---|---|
| Runs on | Convex actions, today | A VM/box we operate — **not** Convex |
| Selectivity | Per-vehicle, on demand | Bulk; file-select text (~30 GB) |
| Fits pipeline | Yes — `fetch → markdown → batch1a` | No — needs a pre-extract step first |
| Durability | Depends on site staying up | We own the data; survives takedown |
| Ops burden | ~none | Stand up + store ~30 GB |
| Legal footprint | Transient reads | Hosting a full copy |

**Recommendation:** start with the **website route** — it's Convex-native, selective, and drops into the existing extractor. Reach for the torrent only if takedown-resilience or broad offline coverage becomes a requirement; then the shape is `torrent → our box → pre-extract into Convex → pipeline reads Convex`, with the website route as the on-demand front.

---

## 9b. What the four asks actually get

| Ask | Status | Reality |
|---|---|---|
| **Vehicle Specs** | ✅ live | Fluids, capacities, torque, service limits. Working on Honda, Toyota and Ford after the per-make vocabulary fix. |
| **OEM Intervals** | ⚠️ Honda only | The "LEMON has no schedule" claim was **wrong**. Honda's FSM embeds the Maintenance Minder tables — "Maintenance Main/Sub Items" + a Normal/Severe schedule with real figures ("air cleaner element every 15,000 miles (24,000 km)", "brake fluid every 3 years"). Now harvested at top weight and fed to `batch1a`'s existing `intervals` block. **Absent** on BMW 330i and Toyota Camry/RAV4; Ford's "Maintenance Schedules" pages are stubs that point at the Owner's Guide. |
| **Labor times** | ✅ live, sparse | 11 catalog services on a populated trim — but only ~10% of trims have a labor index at all (§10). |
| **Parts** | ❌ not available | LEMON publishes **no part numbers**: zero hits for part-number paths in the index, and zero Honda-format p/n (`15400-PLM-A02`) across sampled spec/maintenance leaves. Parts stay on the OEM-storefront path. |

---

## 10. Coverage reality — measured, not assumed

Sampled live on 2026-08-06. **Read this before quoting a yield number.**

| | Measured |
|---|---|
| Labor Times populated | **~10% of trims.** 2/24 sampled (Honda 2021: 1/12, Ford 2019: 1/12); plus 2020 BMW 330i and 2021 Honda CR-V EX AWD. Empty ones return **HTTP 200 with a ~1.5 KB stub**, so status alone can't tell you. |
| Labor coverage when populated | **11 of 14** mappable catalog services on a 2021 CR-V EX AWD. (Was 13 before variant-aware row selection — two of those were an arbitrary pick out of a front/rear table and are now correctly withheld, and the pad number was wrong.) |
| Labor row shape | Multi-variant: `All,Both Axles 1.8` / `Front,Both Sides 1.0` / `Rear,Both Sides 1.0`, then `Combination Procedure:` add-on rows. The axle named by the service selects the row; unresolvable variance returns null. |
| Spec-leaf vocabulary | Not shared across makes. Honda "Standards and Service Limits" ×18; Toyota ×0 (uses "Service Specifications" ×470); Ford ×0 for **both** (uses "General Specifications"/"Capacities"). |

Consequences the code has to live with, and does:
- The trim resolver picks the best NAME match, not the trim that happens to have labor data — a 2021 CR-V **EX-L** AWD resolves to a trim with zero labor while **EX** AWD has 392 operations. That is LEMON's shape, not a bug; the source fails open and contributes nothing on a miss.
- LEMON is one weighted voice (`lemon_labor`, 0.7) among OLP / web / Estimator. A ~10% hit rate is additive, never load-bearing.

---

## 11. Open questions / next steps

- [x] **Make-folder map** — divergences mapped (`Dodge and Ram`, `Nissan-Datsun`, `Mercedes Benz`); unknown makes fall through and are validated by actually fetching the year dir.
- [x] **Trim matching** — whole-word tokens (so `LE` ≠ `XLE`), drivetrain rewarded AND contradictions penalised (so an FWD car stops getting the AWD manual), displacement echo, deterministic tiebreak. No match → fail open, no fallback guess.
- [x] **Leaf allowlist** — finalised per-make (§8) with a subsystem tiebreak and content dedupe. Labor Times feeds the labor subsystem **separately** via `lemonLabor.ts` → `laborAllSources`.
- [ ] **Provenance value:** pick the exact `data_quality` string for LEMON-sourced fields and confirm it's non-protected. (Today LEMON rides `scrapeManual` → `batch1a` like any other web manual and is registered in `MANUAL_MIRROR_DOMAINS`, so it can never claim OEM — but the string has not been pinned deliberately.)
- [ ] **Rate/etiquette:** the operator dislikes crawlers; keep fetches bounded + cached, per-vehicle on demand (not a fleet sweep). The SPEC path rides the `owner_manual` scrape cache; **the labor path is uncached** and refetches the index + up to 20 leaves per run.
- [ ] **Unrelated pre-existing TS errors** in `app/` (`TabCars.tsx`, `bookings/page.tsx`, `mechanic-dashboard.tsx`). `convex/` itself typechecks clean.
```
