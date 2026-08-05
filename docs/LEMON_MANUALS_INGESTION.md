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
  → selectRelevantLeaves(tree)          keep "Service Specifications / Standards and
                                        Service Limits / Lubrication / Fluid / Capacity" leaves;
                                        dedupe; cap to ~12 to bound fetches
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

## 10. Open questions / next steps

- [ ] **Make-folder map:** enumerate LEMON's make folders (homepage index) and map our make strings, incl. divergences (`Dodge and Ram`, `Nissan-Datsun`, `Mercedes Benz`, `General Motors`, `Land Rover`).
- [ ] **Trim matching:** confirm the fuzzy matcher against real cases (drivetrain + engine qualifiers). Decide fallback when no trim matches (pick base trim? skip?).
- [ ] **Leaf allowlist:** finalize which section paths we harvest (specs/fluids/capacities/lubrication — and whether Labor Times feeds the labor subsystem, separately).
- [ ] **Provenance value:** pick the exact `data_quality` string for LEMON-sourced fields and confirm it's non-protected.
- [ ] **Rate/etiquette:** the operator dislikes crawlers; keep fetches bounded + cached, per-vehicle on demand (not a fleet sweep).
- [ ] **Fix the unrelated 4 TS errors** blocking `convex dev` for the team (`useEnsureConvexUser.ts`, `inspection-template.ts`).
```
