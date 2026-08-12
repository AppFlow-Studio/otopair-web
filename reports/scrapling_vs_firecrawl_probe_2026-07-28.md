# Scrapling vs Firecrawl probe — RevolutionParts catalogs (Jul 28 2026)

UC2 decision gate of the Scrapling adoption plan (plan: "Scrapling: contribution
& use cases", approved Jul 28). Driver: `scripts/scrapling-gate.py`; raw per-URL
JSON in `reports/scrapling-gate/raw/` (pass 1) and `raw-newscheme/` (pass 2);
machine summaries in `summary.json` / `summary-newscheme.json`.

**Method.** Four legs per URL — `firecrawl_std` (v2 /scrape, maxAge:0),
`firecrawl_stealth` (proxy:"stealth", premium credits), `scrapling_http`
(curl_cffi TLS impersonation, free), `scrapling_stealth` (Camoufox headless,
free) — with 1.5s politeness gaps, from the dev machine's residential IP
(Firecrawl legs run from Firecrawl's own datacenter infra, so its numbers
already reflect the deployed POV). Classification guards against the
homepage-redirect trap: a page titled `Online <Make> Parts Superstore` or a
final URL of `/` is `redirected_home`, never `success`, because the homepage
carries featured-product JSON-LD/price markers that would otherwise fake a pass.

## Pass 1 — registry category URLs (the scheme the pipeline fetches today)

20 URLs: 5 batch-validated vehicles (2019 Forester Touring, 2021 Tucson
Ultimate, 2017 Rogue SV, 2006 F-150 Lariat, 2024 Equinox Premier) × 4 part
slugs, built exactly like `sourceRegistry.ts oemPartsOnlineConfig`.

| Leg | success | redirected_home | blocked | error | median ms |
|---|---|---|---|---|---|
| firecrawl_std | 0 | **20** | 0 | 0 | 2661 |
| firecrawl_stealth | 0 | **18** | 0 | 2¹ | 3413 |
| scrapling_http | 0 | **20** | 0 | 0 | 866 |
| scrapling_stealth | 0 | **20** | 0 | 0 | 3798 |

¹ Firecrawl API-side `500 Internal Server Error`, transient — not a target-site verdict.

**Verdict: the registry URL scheme is dead — this is URL rot, not a bot wall.**
Every fetcher, on every subdomain (subaru, hyundai, nissan, ford, g), follows
`oem-{y}-{make}-{model}-{part}.html` → 301 → `v-oem-…-html` → 302 → homepage.
Nothing was "blocked"; everything landed on the same junk.

### Production impact (independent of Scrapling — needs its own fix)

- `scrapePartsPages` fetched these URLs via Firecrawl, which returned the
  **homepage** (200, huge body): the markdown entered the Batch-1 extraction
  prompt as a "Parts Page", the junk was **cached for 30 days** as
  current-format, and — because homepage markdown is non-empty — the open-web
  search fallback in `scrapeVehicleSources` **never fired**. All ~19
  OLP-subdomain makes affected; the `<100-char` short-page guard never trips
  because homepages are large. (Precision note, added after reading
  `parsePartPrices` + the price pass: homepage featured tiles mostly canNOT
  mint wrong part prices — Layer-1 JSON-LD needs an mpn/sku, Layer-3 caps at
  one record, and the price pass only applies a cached price whose normalized
  OEM matches an extracted part. The real harm is zero deterministic coverage,
  prompt noise, the suppressed fallback, cache poisoning, and wasted credits —
  not wrong prices.)
- Also paying for nothing: the pipeline's stealth-proxy retries on these
  domains buy the same homepage at premium credit cost.
- Sibling family checks: `toyotapartsdeal.com` **404s** the old scheme (loud
  failure → pages skipped, Batch-2 web_search fills — coverage loss, no junk).
  `hondapartsdeal.com` **rejects impersonated-TLS handshakes outright**
  (curl error 35 ×3) — first observed case that genuinely needs a browser tier.

## Pass 2 — the working scheme (`/search?search_str=<OEM>` → `/oem-parts/…`)

5 seeds, one known-good OEM per make from GT batches (15208AA21A, 26300-35505,
15208-65F0E, FL820S, 12683541). Search page probed per leg; first
`/oem-parts/…` link followed and probed per leg.

**Result: 5/5 detail pages `success` on ALL four legs**, every one with JSON-LD
`"@type":"Product"` AND fitment-table markers. Detail-page latencies:

| Leg | median ms (detail) | notes |
|---|---|---|
| scrapling_http | **459** | free, sub-second, full content |
| firecrawl_std | 2445 | works fine — from datacenter IPs too |
| firecrawl_stealth | 3169 | succeeds but pointless here (premium for no gain) |
| scrapling_stealth | 3113 | reserve for TLS walls (hondapartsdeal-class) |

Bonus verified behaviors: superseded OEMs 301 to the current part
(15208AA15A → 15208AA21A — the redirect IS the supersession chain), and search
works for both OEM numbers and keyword+vehicle queries.

## Amendment (later on Jul 28, found during the P0 registry fix)

Pass 2's **search-page legs overstated Firecrawl**: the classifier accepted
"Search Results" 200s without checking for result links. In fact the
storefront's own `/search` endpoint serves **datacenter IPs a results-stripped
200** — the same `search_str=Tucson+oil+filter` URL returns 18 `/oem-parts/`
links via residential TLS-impersonated HTTP and **0 links in Firecrawl's
rawHtml, rendered html, AND markdown**. Detail-page legs were checked on real
content markers and stand: Firecrawl fetches `/oem-parts/…` pages fine.

Consequence for the registry fix: storefront-search discovery from Convex/
Firecrawl is not viable; the shipped scraper uses **site-scoped SERP discovery**
(`Firecrawl /search "site:{store} {model} {part words}"`, results arrive
already scraped) with detail-slug preference. This is also the first concrete,
measured case where a self-hosted Scrapling tier has capability Firecrawl
lacks (residential/TLS-impersonated fetch of the storefront search endpoint) —
relevant if SERP discovery ever underperforms.

## Gate verdict (against the plan's UC3 criteria)

- Criterion "Firecrawl-standard block rate ≥ ~30% on these domains": **not met
  on the working scheme** (0% blocked; Firecrawl std succeeds everywhere).
  The pass-1 100% failure is rot, not blocking, and no fetch tier fixes rot.
- Therefore **UC3 as a production rescue tier is NOT justified for the
  oempartsonline family**. The production fix is a **registry-scheme
  migration** (fetch by search→detail, or new category discovery) — Firecrawl
  can fetch the new scheme fine.
- Scrapling's production role, if any, is **optional cost/latency
  optimization** (its free HTTP tier is ~5× faster than Firecrawl std and
  saves all catalog-scrape credits) plus **TLS-wall coverage**
  (hondapartsdeal). Decide after the registry migration, not before.
- **UC1 (GT research via MCP) is fully validated** — the fast tier does
  sub-second authenticated-feeling lookups the manual step needed a browser
  for; recipe in `reports/batch12_rp_lookup_recipe.md`.

## Recommended next actions

1. **P0 registry fix (new work item, not Scrapling)**: stop fetching the dead
   category scheme for OLP-subdomain makes; move `scrapePartsPages` to
   search→detail URLs (needs OEM-or-keyword seeds — the Batch-1/VDB part
   fields can seed part-number searches, or keyword+model searches per slug);
   add a homepage-title guard (`Online .* Superstore`) so redirect rot can
   never enter markdown/prices/cache again; purge `scrape_cache` rows whose
   markdown starts with the storefront homepage.
2. Use the Scrapling MCP recipe for batch-12 GT research (done — installed).
3. Re-evaluate the optional Scrapling prod tier only after (1) ships.

Probe cost: ~45 Firecrawl std + ~45 stealth scrapes (incl. searches), 4
transient FC API 500s, ~15 min wall time, no target-site errors.
