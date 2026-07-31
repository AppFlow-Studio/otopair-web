# RP-catalog lookup recipe — Scrapling MCP (for batch-12 ground-truth research)

Replaces the manual-browser part of GT step 2 (dealer-catalog confirmation of OEM
numbers, fitment ranges, MSRPs) with agent-driven fetches through the Scrapling
MCP server. Set up Jul 28 2026; see `.mcp.json` (server `scrapling`, venv
`%USERPROFILE%\.venvs\scrapling`, **scrapling 0.4.12 pinned**, Python 3.14.6).
Naming: this tooling is "rp"/"scrapling" — never "olp", which is the
openlaborproject labor probe.

## Why

Brand catalogs (`toyota.oempartsonline.com` etc., RevolutionParts platform) 403
plain fetchers — confirmed Jul 28 2026 — which is what made this step manual.
Scrapling's stealth browser (Camoufox) gets through, costs no Firecrawl credits,
and its `css_selector` param trims pages server-side before they hit context.

## Target families (same platform, same recipe)

- `{sub}.oempartsonline.com` — registry subdomains in `sourceRegistry.ts`
  (`OEM_PARTS_ONLINE_SUBDOMAINS`: ford, g (GM brands), hyundai, kia, genesis,
  mercedes, volkswagen, audi, subaru, nissan, infiniti, mazda, volvo, porsche,
  lexus, mopar (Chrysler/Dodge/Jeep/Ram), landrover, jaguar, mitsubishi)
- `bmwpartsdeal.com` / `toyotapartsdeal.com` / `hondapartsdeal.com` (Phase-1 registry)
- `gmpartsgiant.com` and other `*partsgiant`/`*partsdeal` GT anchors

Official eStores (`parts.<dealer>.com`, `autoparts.<make>.com`) are NOT
RevolutionParts — try the same ladder but expect different walls/selectors.

## Verified live Jul 28 2026 (subaru subdomain, Scrapling 0.4.12)

- **The cheap tier is enough**: TLS-impersonated plain HTTP (curl_cffi
  `impersonate="chrome"`) returns 200 where plain fetchers 403. The stealth
  browser is a *fallback*, not the default — in MCP terms use `get` first,
  `stealthy_fetch` only if `get` gets blocked.
- **The registry category-URL scheme is DEAD (at least on subaru)**:
  `oem-{year}-{make}-{model}-{part}.html` → 301 → `v-oem-…-html` → 302 →
  vehicle picker/homepage. Even the stealth browser lands on the homepage, so
  this is URL rot, not a bot wall. ⇒ production `scrapePartsPages` is likely
  ingesting homepages for OLP-subdomain makes — flagged separately.
- **Detail pages are the payload**: `/oem-parts/{make}-{part-name}-{oemnumber}`
  → 200, JSON-LD `"@type":"Product"` (price carrier) + fitment table. NOTE:
  detail pages do NOT carry `.price-section-price` — that class family belongs
  to the old category pages; on the new scheme read prices from JSON-LD.
- **Supersession for free**: a superseded OEM in the URL 301s to the current
  part (`…15208aa15a` → `…15208aa21a`). Record the redirect pair — it IS the
  supersession chain, from the horse's mouth.
- **Homepage-landing hazard**: homepage title `Online <Make> Parts Superstore |
  OEM Parts Online` and it contains featured-product price markers — always
  check the `<title>`; a "Superstore" title means the lookup did NOT resolve.

## Per-vehicle procedure

1. **Entry point = search, not category URLs**: fetch (MCP `get`)
   `https://{sub}.oempartsonline.com/search?search_str=<OEM-number>` — or a
   keyword+vehicle search (`search_str=2019+forester+oil+filter`) when the OEM
   number is the thing being discovered. Search results are tile listings
   (no prices) — follow the `/oem-parts/…` link they surface.
2. **Detail page**: fetch with
   `css_selector: "h1, .fitment-table, script[type='application/ld+json']"`
   (locked from live inspection: classes `fitment-table`, `fitment-table-body`,
   `fitment-make`, `fitment-model`, `fitment-engine` exist on detail pages).
   That yields part title + full year/model/engine fitment rows + JSON-LD price
   in a few hundred tokens.
3. **Fitment confirmation** = the `.fitment-table` rows (year range, model,
   engine) + the H1 (e.g. "2010-2025 Subaru Oil Filter 15208AA21A").
4. **Bulk**: `bulk_get` a vehicle's whole part list (one URL per OEM number via
   the search→detail pattern) in one call; escalate individual blocked URLs to
   `stealthy_fetch`.
5. **Sessions**: only needed for browser-tier work (`open_session` stealth,
   `session_id: "gt-<vehicle>"`); the fast tier needs none.
6. **Adversarial traps**: fetch the WRONG variant's part detail pages too and
   quote their fitment rows verbatim — e.g. batch-11's LYX-vs-LTG plug decoys.
7. **Record** value + source URL (use the FINAL post-redirect URL) + confidence
   into `gt-<vehicle>.md` exactly as batches 10/11 — provenance format
   unchanged. Screenshots (`screenshot` tool) only where a verdict needs visual
   evidence.

## Politeness rules (unchanged from pipeline norms)

- Catalog/dealer domains only; sequential fetches; reuse the session;
  ≤ ~30 pages per vehicle; no hammering search endpoints.
- Firecrawl `/search` remains the tool for anything search-shaped —
  Scrapling is fetch-only.

## Status / open items

- [x] venv + scrapling 0.4.12 + `.mcp.json` (project-scoped)
- [x] `scrapling install` browser deps
- [x] Smoke test: fast tier passes the wall; `.fitment-table` +
      JSON-LD selector locked (see "Verified live" above)
- [x] Gate probe (`scripts/scrapling-gate.py`, both passes) → verdict in
      `reports/scrapling_vs_firecrawl_probe_2026-07-28.md`: registry scheme
      dead on ALL legs (rot, not bot wall); working scheme succeeds on ALL
      legs; prod Scrapling tier deferred — registry migration is the real fix
- [x] **P0 registry URL-rot fix** — SHIPPED to dev Jul 28 2026:
      `scrapePartsPages` now does site-scoped SERP→detail discovery
      (storefront /search is results-stripped for datacenter IPs — keep the
      year in queries, it steers to right-generation pages), homepage guard
      in `rpCatalog.ts`, poisoned cache invalidated via
      `CACHE_FORMAT_VERSION` 4→5. Tucson e2e: 6 detail pages, 6 right-gen
      prices, 2 supersession chains.
- MCP tools become available to Claude Code on next session start in this repo
  (approve the project server, verify with `/mcp`).
