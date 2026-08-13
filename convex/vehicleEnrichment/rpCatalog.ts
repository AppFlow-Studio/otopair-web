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

// ─── Detail-page VEHICLE identity (round 15b) ────────────────────
//
// WHY THIS EXISTS. A `/oem-parts/…` detail page is MAKE-scoped, not
// vehicle-scoped: one Porsche storefront serves 911, Cayenne, Macan and
// Panamera parts off the same path shape. Round 15b shipped a 2019 911 GT3 RS
// with the CAYENNE's brake pads (`9Y0698151AN` / `9Y0698451AE` — `9Y0` is the
// Cayenne E3 platform; a 991 uses `991-…` numbers), priced, `triangle_ok`,
// `refute_flagged: false`, counted as quotable.
//
// The vehicle was never missing from the data. The page's own <title> reads:
//
//   "2019-2025 Porsche Cayenne 1 Set Of Brake Pads Front 9Y0-698-151-AN | OEM Parts Online"
//
// and the pipeline stored `scraped_name: "1 Set Of Brake Pads Front"` — the
// vehicle segment was stripped before any gate saw it. `checkRoleIdentity`
// then validated the COMPONENT NOUN ("Brake Pads Front" — correct) and passed.
// Nothing anywhere asked whether the part was for THIS vehicle.
//
// NOT USABLE: the "Vehicle Fitment" tab. Verified live 2026-07-31 — the tab is
// lazy-loaded, so the server-rendered HTML carries only the tab NAV and a
// "Make sure this part fits your Car" vehicle-picker prompt. The <title> is the
// only server-rendered vehicle statement on the page.
//
// FAIL-OPEN LAW (same shape as partIndex's `no_index`): the dangerous verdict
// is "mismatch", because that is the one that discards a part. It is returned
// ONLY on positive contradiction — a parsed year range that excludes the target
// year, or a DIFFERENT known model of the same make named in the title while
// ours is absent. Everything else — untitled page, unparseable title, a title
// that names no model at all ("2018-2021 Hyundai Oil Filter …") — is "unknown",
// which means "we don't know" and must leave the caller's candidate alone.

export type DetailTitleVehicle = {
  /** First year of the fitment range in the title, when present. */
  yearMin: number | null;
  /** Last year of the range; equals yearMin for a single-year title. */
  yearMax: number | null;
  /** Title text before the " | OEM Parts Online" suffix, normalized. */
  head: string;
};

/** Storefront title suffix, e.g. " | OEM Parts Online". */
const TITLE_SUFFIX = /\s*\|\s*[^|]*$/;

/**
 * Parse a RevolutionParts detail page's <title> into its year range + head.
 *
 * Title shapes seen live:
 *   "2019-2025 Porsche Cayenne 1 Set Of Brake Pads Front 9Y0-698-151-AN | OEM Parts Online"
 *   "2018-2021 Hyundai Oil Filter 26300-35505 | …"   (make, NO model)
 *   "2020 Subaru Forester Oil Filter … | …"          (single year)
 */
export function parseDetailTitle(
  html: string | null | undefined,
): DetailTitleVehicle | null {
  try {
    const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? "")?.[1];
    if (!raw) return null;
    const decoded = raw
      .replace(/&amp;/g, "&")
      .replace(/&#0?39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (!decoded) return null;
    const head = decoded.replace(TITLE_SUFFIX, "").trim();
    if (!head) return null;
    // Leading "2019-2025" or "2019" only. A year that appears LATER in the
    // title is part of a product name, not a fitment range, so it is ignored.
    const ym = /^(\d{4})\s*(?:[-–—]\s*(\d{4}))?\b/.exec(head);
    const yearMin = ym ? Number(ym[1]) : null;
    const yearMax = ym ? (ym[2] ? Number(ym[2]) : Number(ym[1])) : null;
    return { yearMin, yearMax, head };
  } catch {
    return null;
  }
}

export type VehicleFitVerdict = {
  verdict: "match" | "mismatch" | "unknown";
  /** Machine-readable cause, for the run's error channel. */
  reason:
    | "no_title"
    | "year_out_of_range"
    | "other_model_named"
    | "model_named"
    | "year_in_range"
    | "no_vehicle_signal";
  /** The sibling model the title named, when that drove a mismatch. */
  observedModel?: string;
  /** The parsed title head, carried so a rejection is auditable. */
  title?: string;
};

/** Word-boundary presence test that tolerates model names with digits and
 *  punctuation ("911", "3 Series", "CX-5", "Mazda3"). */
function namesModel(head: string, model: string): boolean {
  const m = model.trim().toLowerCase();
  if (m.length < 2) return false;
  const hay = ` ${head.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ")} `;
  const needle = ` ${m.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ")} `;
  return hay.includes(needle);
}

/**
 * Does this detail page's title contradict the vehicle we are enriching?
 *
 * `siblingModels` are the OTHER model names registered under the same make —
 * the vocabulary that lets "Cayenne" be recognised as a model rather than as
 * part of a product name. Without it a title naming a rival model is
 * indistinguishable from one naming no model at all, so an empty list can only
 * ever yield "unknown" on the model axis (the year axis still applies).
 */
export function detailPageVehicleVerdict(args: {
  html: string | null | undefined;
  targetYear: number;
  targetModel: string;
  siblingModels?: readonly string[];
}): VehicleFitVerdict {
  const parsed = parseDetailTitle(args.html);
  if (!parsed) return { verdict: "unknown", reason: "no_title" };
  const { yearMin, yearMax, head } = parsed;

  // ── Year axis. A parsed range that excludes the target is a hard contradiction.
  if (yearMin != null && yearMax != null) {
    if (args.targetYear < yearMin || args.targetYear > yearMax) {
      return {
        verdict: "mismatch",
        reason: "year_out_of_range",
        title: head,
      };
    }
  }

  // ── Model axis. Ours named → match, regardless of which siblings appear
  //    (a "fits 911 and Cayman" title is a genuine multi-model part).
  if (namesModel(head, args.targetModel)) {
    return { verdict: "match", reason: "model_named", title: head };
  }
  for (const sib of args.siblingModels ?? []) {
    if (!sib || sib.trim().toLowerCase() === args.targetModel.trim().toLowerCase()) continue;
    if (namesModel(head, sib)) {
      return {
        verdict: "mismatch",
        reason: "other_model_named",
        observedModel: sib,
        title: head,
      };
    }
  }

  // Title carries a usable year range but names no model either way — the
  // Hyundai shape. Positive on the only axis we could read.
  if (yearMin != null) {
    return { verdict: "unknown", reason: "year_in_range", title: head };
  }
  return { verdict: "unknown", reason: "no_vehicle_signal", title: head };
}
