/**
 * vehicleEnrichment/rpCatalog.ts — RevolutionParts storefront helpers (pure).
 *
 * Jul 28 2026: the RevolutionParts platform retired the deterministic
 * category-URL scheme. `oem-{year}-{make}-{model}-{part}.html` now
 * 301→302-chains to the storefront HOMEPAGE on every *.oempartsonline.com
 * subdomain (verified 20/20 URLs across 5 makes × 4 fetchers — see
 * reports/scrapling_vs_firecrawl_probe_2026-07-28.md), and the *partsdeal.com
 * sites 404 it outright. The working flow is:
 *
 *   /search?search_str=<query>   →   /oem-parts/<make>-<part-name>-<oem> detail
 *
 * Detail pages carry JSON-LD Product (price), a fitment table, and
 * supersession prose; a superseded OEM number in a detail URL 301s to its
 * current replacement.
 *
 * This module holds the PURE pieces of that flow (no ctx, unit-testable):
 * the homepage guard and detail-link extraction. Naming note: "rp" =
 * RevolutionParts — "olp" is reserved for the openlaborproject labor probe.
 */

/**
 * True when a fetched page is the storefront HOMEPAGE — where both rotten
 * category URLs and unresolved searches 30x-chain to. The homepage carries
 * featured-product tiles (JSON-LD and price markup), so without this guard a
 * redirect-to-home reads as a plausible parts page and poisons the markdown,
 * the deterministic price parse, and the 30-day scrape cache.
 * Homepage <title> shape: "Online Subaru Parts Superstore | OEM Parts Online"
 * (search pages are "Search Results | …", detail pages "<years> <part> <oem> | …").
 */
export function isStorefrontHomepage(
  html: string | null | undefined,
  markdown: string | null | undefined,
): boolean {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html ?? "")?.[1];
  if (title && /^Online .{0,40}Parts Superstore/i.test(title.trim())) return true;
  // Markdown-only fetches: the title line survives conversion near the top.
  return /Online .{0,40}Parts Superstore \| OEM Parts Online/i.test(
    (markdown ?? "").slice(0, 400),
  );
}

/**
 * Ordered, de-duplicated /oem-parts/… detail links from a search-results page,
 * resolved against the storefront base URL. Order preserves the site's own
 * relevance ranking, so callers can take the top N. Query strings/fragments are
 * stripped so the same product tile never yields two URLs. Works on raw HTML
 * (href="…") and on markdown-converted pages (](/oem-parts/…)) so a
 * markdown-only fetch still yields links.
 */
export function extractDetailLinks(
  content: string | null | undefined,
  storeBaseUrl: string,
): string[] {
  if (!content) return [];
  const base = storeBaseUrl.replace(/\/+$/, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of [
    /href="(\/oem-parts\/[^"?#]+)/g,
    /\]\((\/oem-parts\/[^)?#\s]+)/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(`${base}${m[1]}`);
      }
    }
  }
  return out;
}
