// =============================================================================
// vehicleEnrichment/categoryHarvest.ts — heal rungs that close core-role gaps
// from CATALOG STRUCTURE instead of open-web research (Aug 2026).
//
// RUNG 1 — vehicle-scoped CATEGORY pages. RevolutionParts stores publish
// `/v-{vehicle-slug}/{category}` pages whose URL *is* the fitment statement:
// the store's own picker generated the slug for exactly this year/model/
// engine. The scraper's detail gate (`/oem-parts/` only) DISCARDS these even
// when the SERP surfaces them — on the GLC-43 the ignition category page for
// the exact vehicle was hit #2 for "spark plug" and was thrown away while the
// role sat empty. This rung: resolve the vehicle slug (cached URL, else one
// SERP), fetch the vehicle ROOT to discover its real category list, fetch the
// few categories that cover the MISSING roles, parse product tiles (JSON-LD
// via parsePartPrices + markdown detail links), role-gate every title through
// checkRoleIdentity, then batch fitment-verify. Vehicle-scoped catalog
// attestation is strong evidence, so a candidate writes unless the verifier
// positively REFUTES it. Prices ride along from the same JSON-LD.
//
// RUNG 2 — RockAuto OEM/Interchange backtrack, for roles rung 1 could not
// close. Seeds are the role's own REFUTED numbers (wrong-but-real parts that
// RockAuto resolves); each seed's listing yields an OEM/Interchange set. THE
// LAW (sourceAdapters/rockauto.ts): that set belongs to one aftermarket part
// across MANY vehicles and is never fitment-equivalent — so interchange
// numbers are CANDIDATES only: same-make format gate (sanitizePartNumber),
// then the fitment verifier, and ONLY a positively CONFIRMED number writes.
// Present-but-wrong stays forbidden; the verifier is the vehicle evidence.
//
// Both rungs are wired into resourceRoles.healAfterRun between the
// refute-harvest and the research repair, self-noop when nothing is missing,
// and die per-rung without breaking the heal. Rung 1 additionally runs IN-RUN
// (during Batch-2 polling) scoped to EARLY_ROLE_KEYS, so those roles are born
// catalog-attested rather than extracted-then-refuted.
// Kill: PARTS_CATEGORY_HARVEST=off / PARTS_CATEGORY_HARVEST_EARLY=off /
// PARTS_INTERCHANGE_BACKTRACK=off.
//
// NOT A RUNG, AND WHY (probed live Aug 2026). An "assembly siblings" rung was
// built on the premise that a `/oem-parts/` DETAIL page renders the exploded
// assembly and links its callout parts — so one fetch of the front-pad page
// would also yield the rotor. It does not. Fetched live,
// g.oempartsonline.com/oem-parts/gm-air-filter-23321606 returns 482 KB of HTML
// containing exactly ONE `/oem-parts/` link (its own canonical URL) and 22
// `cdn-illustrations.revolutionparts.io` IMAGES: the diagram is raster, and
// its callouts are not links. A detail page is a leaf, not a hub.
//
// The capability that premise was reaching for already exists here: on this
// platform the CATEGORY page is the many-parts page, which is what rung 1
// fetches. Anyone revisiting this should start from the illustration hash in
// those image URLs (`/strapr1/{hash}/{hash}.png`) and find whether a
// diagram-scoped PAGE exists behind it — that, not the detail page, would be
// the hub.
// =============================================================================

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { attestParts, parseInterchangeNumbers } from "./sourceAdapters/rockauto";
import { adapterFetch } from "./sourceAdapters/http";
import {
  buildCatalogPath,
  MIN_BRAND_CORROBORATION,
  parseCatalogNodes,
  parsePositionedListings,
  pickEngineNode,
  pickNodeByPatterns,
  positionOfRoleKey,
  rankInterchangeCandidates,
  ROCKAUTO_ROLE_LOCATION,
  type CatalogNode,
  type InterchangeSet,
} from "./sourceAdapters/rockautoCatalog";
import { getSourceConfig } from "./sourceRegistry";
import { fetchUrlWithHtml, searchAndFetch } from "./firecrawl";
import { parsePartPrices, normalizeOemNumber } from "./priceParser";
import { checkRoleIdentity } from "./roleIdentity";
import { sanitizePartNumber } from "./contentSanitization";
import { verifyPartFitments } from "./utils/partFitmentVerifier";
import {
  EARLY_ROLE_KEYS,
  EARLY_SERVICE_SLUGS,
  earlyHarvestScope,
  missingCoreRoles,
} from "./quotability";
import { classifyFuelClass } from "./variantFingerprint";
import { PART_FIELD_MAP } from "./v3pipeline";

// ─── Pure helpers (unit-tested in tests/categoryHarvest.test.ts) ────────────

/** `/v-2020-mercedes-benz-glc43-amg--4matic--3-0l-v6-gas` from any URL under
 *  it, or null when the URL is not vehicle-scoped (e.g. a detail page). */
export function extractVehicleSlugPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/(v-[a-z0-9][a-z0-9-]*)(?:\/|$)/i.exec(url);
  return m ? `/${m[1]}` : null;
}

export interface CategoryLink {
  /** e.g. "brakes--rear-brakes" */
  slug: string;
  url: string;
  label: string | null;
}

/** Category links under a vehicle slug, from the vehicle root page's own nav
 *  (markdown or HTML — both carry the hrefs). The store's real category list
 *  beats any hardcoded guess. */
export function extractCategoryLinks(
  content: string | null | undefined,
  slugPath: string,
): CategoryLink[] {
  if (!content) return [];
  const out: CategoryLink[] = [];
  const seen = new Set<string>();
  const esc = slugPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Markdown links first (label captured), then bare hrefs.
  const mdRe = new RegExp(`\\[([^\\]]{1,120})\\]\\((https?://[^)\\s]*${esc}/([a-z0-9][a-z0-9-]*))\\)`, "gi");
  for (const m of content.matchAll(mdRe)) {
    const slug = m[3].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, url: m[2], label: m[1].trim() || null });
  }
  const hrefRe = new RegExp(`(https?://[^"'()\\s]*${esc}/([a-z0-9][a-z0-9-]*))`, "gi");
  for (const m of content.matchAll(hrefRe)) {
    const slug = m[2].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, url: m[1], label: null });
  }
  return out;
}

/** Category-slug hints per role. Matched against the slug AND label text —
 *  first hit wins, so order encodes preference. Position-bearing roles only
 *  accept a category of the matching side (or a position-less one).
 *
 *  Live-fire lesson (GLC-63 mis-resolution, Aug 2026): a loose hint is worse
 *  than none — /ignition/ picked `electrical--ignition-lock` (the KEY
 *  cylinder) for spark plugs, and /cooling/ picked
 *  `belts-and-cooling--accessory-drive-belt…` for coolant. Hints are ordered
 *  most-specific-first and every role carries a negative screen. */
const ROLE_CATEGORY_HINTS: Record<string, RegExp[]> = {
  // A BARE /filter/ IS THE SAME MISTAKE AS THE BARE /ignition/ ABOVE, and it
  // went unnoticed for longer because it fails quietly instead of loudly.
  // Live-fire (2021 Lincoln Nautilus on ford.oempartsonline.com, Aug 13 2026):
  // the store publishes FIVE `*--filters` categories and the one that sorts
  // first in the page is `air-and-fuel-delivery--filters`. Fetched, it holds 48
  // products — 4 air filters and ZERO oil filters, while `engine--filters`
  // holds 6 oil filters and `hvac--filters` holds the cabin filter. So the bare
  // /filter/ hint, sitting at priority 1 for oil and priority 2 for cabin, sent
  // BOTH roles to the fuel/air page and neither could ever be found on a Ford.
  // Family-specific hints now come first; the bare /filter/ stays as a
  // last resort for stores that publish only one filters category (Mercedes'
  // `maintenance-and-lubrication--filters` holds all three), and the negative
  // screens below make the outcome independent of page order.
  oil_filter: [/oil-filter/, /engine--filters/, /lubrication/, /filter/, /maintenance/],
  // `engine--air-intake` and `air-and-fuel-delivery--filters` return byte-identical
  // product sets on this store — RevolutionParts aliases them — so these two
  // hints are interchangeable in practice and ordering between them is moot.
  air_filter: [/air-filter/, /air-intake/, /air-and-fuel/, /filter/, /maintenance/],
  cabin_filter: [/cabin/, /hvac--filters/, /hvac/, /climate/, /filter/, /maintenance/],
  // `ignition--secondary-ignition` is definitionally where plugs live; the coil
  // category is the wrong part and was only ever reached because it was named
  // explicitly. (On Ford the two alias to the same set, so this is a no-op
  // there and a correctness fix on stores where they differ.)
  spark_plug: [/spark-plug/, /spark/, /secondary-ignition/, /ignition--ignition-coil/, /^ignition--/],
  front_brake_pad: [/front-brake/, /brakes--front/, /brake/],
  rear_brake_pad: [/rear-brake/, /brakes--rear/, /brake/],
  front_rotor: [/front-brake/, /brakes--front/, /brake/],
  rear_rotor: [/rear-brake/, /brakes--rear/, /brake/],
  battery: [/--battery/, /battery/, /charging/],
  coolant: [/coolant|antifreeze/, /cooling-system/, /radiator/, /maintenance.*fluid|fluid.*maintenance/],
  atf_fluid: [/transmission.*fluid|fluid.*transmission/, /transmission/],
  engine_oil: [/engine-oil/, /--oil/, /maintenance/],
  drain_plug_gasket: [/oil-pan/, /maintenance/, /engine/],
  serpentine_belt: [/accessory-drive|serpentine/, /belt/],
  oil_filter_housing_oring: [/filter/, /engine/, /maintenance/],
};

/** Categories a role must NEVER take, however well a hint matched.
 *
 *  A block is ORDER-INDEPENDENT where hint priority is not, so the three filter
 *  roles carry one each: on a store that publishes several `*--filters`
 *  categories, whichever one happens to sort first would otherwise win on a
 *  loose hint no matter how the list is ordered. */
const ROLE_CATEGORY_BLOCKS: Record<string, RegExp> = {
  spark_plug: /lock|switch|key|starter/,
  battery: /cable|lock|switch|starter|alternator/,
  coolant: /belt|hose|pump|fan/,
  atf_fluid: /mount|cooler-line/,
  // The engine oil filter is never in the fuel/air, cabin or gearbox families.
  oil_filter: /air-and-fuel|air-intake|hvac|cabin|transmission|transaxle/,
  // The cabin filter is never under the engine or the fuel system.
  cabin_filter: /air-and-fuel|air-intake|engine--|transmission|transaxle|oil-filter/,
  // The engine air filter is never the cabin one or a gearbox filter.
  air_filter: /cabin|hvac|oil-filter|transmission|transaxle/,
};

/** Pick the vehicle slug from SERP result URLs — EXACT-vehicle or nothing.
 *
 *  Live-fire lesson (Aug 2026): a best-effort scorer resolved the 2020
 *  GLC 43 to `/v-2020-mercedes-benz-glc63-amg--4matic--4-0l-v8-gas` — the
 *  GLC 63 V8 — because "glc"+"amg" outscored the missing "43", and the rung
 *  went on to harvest the wrong vehicle's rotors (the fitment verifier
 *  refuted both, but the source must not lie in the first place). Rules:
 *   - the year must appear in the slug;
 *   - EVERY digit-bearing model token must appear ("43" kills glc63);
 *   - at least one alphabetic model token must appear;
 *   - displacement is CONTRADICTION-checked, not required (Aug 9 2026,
 *     Jeep GC round-2 post-mortem): a slug carrying a displacement token
 *     ("4-0l") that differs from ours ("3-6l") is rejected — the GLC63 still
 *     dies here — but a slug carrying NO displacement token passes. Many
 *     RevolutionParts slugs omit the engine entirely, and the old hard
 *     "must appear" gate no-opped the whole rung (no_vehicle_slug) for
 *     every such store: the 2020 Grand Cherokee's missing spark plugs sat
 *     one un-fetched category page away.
 *  No candidate passing all gates → null, and the caller reports an honest
 *  no_vehicle_slug instead of harvesting a neighbor. */
export function pickVehicleSlug(
  urls: readonly string[],
  vehicle: { year: number; model: string; displacement?: string | null },
): string | null {
  const modelTokens = String(vehicle.model)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0);
  const digitTokens = modelTokens.filter((t) => /\d/.test(t));
  const alphaTokens = modelTokens.filter((t) => !/\d/.test(t) && t.length > 1);
  const dispL = (() => {
    const n = parseFloat(String(vehicle.displacement ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n.toFixed(1).replace(".", "-") + "l" : null;
  })();

  let best: { path: string; score: number } | null = null;
  for (const url of urls) {
    const path = extractVehicleSlugPath(url);
    if (!path) continue;
    const slug = path.toLowerCase();
    const flat = slug.replace(/[^a-z0-9]+/g, "");
    if (!flat.includes(String(vehicle.year))) continue;
    if (!digitTokens.every((t) => flat.includes(t))) continue;
    if (alphaTokens.length > 0 && !alphaTokens.some((t) => flat.includes(t))) continue;
    if (dispL) {
      // A slug that states SOME displacement that is not ours contradicts the
      // vehicle — fatal. A slug that states none is merely silent — allowed.
      const stated = slug.match(/\d+-\d+l/g);
      if (stated && stated.length > 0 && !stated.includes(dispL)) continue;
    }
    const score =
      digitTokens.length +
      alphaTokens.filter((t) => flat.includes(t)).length +
      (dispL && slug.includes(dispL) ? 1 : 0);
    if (!best || score > best.score) best = { path, score };
  }
  return best?.path ?? null;
}

/** Is this role even eligible for the category rung?
 *
 *  A role with no hints is skipped in silence by `categoriesForRoles`, which
 *  reads downstream as "the catalog had nothing" when the truth is "we never
 *  looked". The caller uses this to tell the two apart in its log. */
export function hasCategoryHints(roleKey: string): boolean {
  return ROLE_CATEGORY_HINTS[roleKey] !== undefined;
}

function positionOfRole(roleKey: string): "front" | "rear" | null {
  if (roleKey.startsWith("front_") || roleKey.includes("_front")) return "front";
  if (roleKey.startsWith("rear_") || roleKey.includes("_rear")) return "rear";
  return null;
}

function categoryPosition(slugAndLabel: string): "front" | "rear" | null {
  if (/front/.test(slugAndLabel)) return "front";
  if (/rear/.test(slugAndLabel)) return "rear";
  return null;
}

/** Pick up to `cap` category pages that together cover the missing roles.
 *  Returns role→category assignment; a role with no matching category is
 *  simply not assigned (rung 2 / repair take it). */
export function categoriesForRoles(
  missingRoleKeys: readonly string[],
  links: readonly CategoryLink[],
  cap = 4,
): { url: string; slug: string; roles: string[] }[] {
  const byUrl = new Map<string, { url: string; slug: string; roles: string[] }>();
  for (const roleKey of missingRoleKeys) {
    const hints = ROLE_CATEGORY_HINTS[roleKey];
    if (!hints) continue;
    const rolePos = positionOfRole(roleKey);
    const block = ROLE_CATEGORY_BLOCKS[roleKey];
    let chosen: CategoryLink | null = null;
    outer: for (const hint of hints) {
      for (const link of links) {
        const hay = `${link.slug} ${(link.label ?? "").toLowerCase()}`;
        if (block && block.test(hay)) continue;
        if (!hint.test(hay)) continue;
        const catPos = categoryPosition(hay);
        if (rolePos && catPos && catPos !== rolePos) continue;
        chosen = link;
        break outer;
      }
    }
    if (!chosen) continue;
    const existing = byUrl.get(chosen.url);
    if (existing) existing.roles.push(roleKey);
    else if (byUrl.size < cap) byUrl.set(chosen.url, { url: chosen.url, slug: chosen.slug, roles: [roleKey] });
  }
  return [...byUrl.values()];
}

export interface CategoryCandidate {
  roleKey: string;
  oem: string;
  title: string | null;
  price: number | null;
  sourceUrl: string;
}

export interface PageProduct {
  oem: string;
  title: string | null;
  price: number | null;
  sourceUrl: string;
}

/** Every product visible on a fetched storefront page: JSON-LD tiles
 *  (number+name+price) plus grouped markdown `/oem-parts/` detail links.
 *  Shared by the category rung and the fluid-product fetchers. */
export function extractPageProducts(input: {
  html: string | null;
  markdown: string | null;
  url: string;
}): PageProduct[] {
  const products: PageProduct[] = [];
  if (input.html) {
    try {
      for (const p of parsePartPrices(input.html, input.url)) {
        products.push({
          oem: p.oem_part_number_raw || p.oem_part_number,
          title: p.name ?? null,
          price: Number.isFinite(p.price) && p.price > 0 ? p.price : null,
          sourceUrl: p.source_url || input.url,
        });
      }
    } catch {
      /* JSON-LD parse is best-effort */
    }
  }
  if (input.markdown) {
    // RevolutionParts category markdown renders each product as SEVERAL links
    // to the same detail URL — a title link and a part-number link — and the
    // URL may carry a markdown title attribute: [Disk Brake Pad](…/oem-parts/…
    // "Disk Brake Pad"). Two structural traps (found live on the GLC-43
    // rear-brakes page): the `"title"` inside the parens breaks a naive
    // (url) regex, and the URL tail STRIPS LEADING ZEROS (…-4207803 for
    // 000-420-78-03) so a URL-derived number fails the make format gate. So:
    // group links by URL, take the title from the prose link and the number
    // from the number-shaped link text, and fall back to the URL tail only
    // when no number link exists.
    const linkRe = /\[([^\]]{2,160})\]\((https?:\/\/[^)\s]*\/oem-parts\/[^)\s]+?)(?:\s+"[^"]*")?\)/gi;
    const byUrl = new Map<string, { titles: string[]; numbers: string[] }>();
    for (const m of input.markdown.matchAll(linkRe)) {
      const text = m[1].replace(/\\+/g, " ").replace(/\s+/g, " ").trim();
      const url = m[2];
      const entry = byUrl.get(url) ?? { titles: [], numbers: [] };
      // A number-shaped link text (allows the display hyphenation).
      const flat = text.replace(/[^A-Za-z0-9]/g, "");
      if (/^[A-Z]?\d{7,}$/i.test(flat)) entry.numbers.push(text);
      else if (text.length >= 3) entry.titles.push(text);
      byUrl.set(url, entry);
    }
    for (const [url, entry] of byUrl) {
      const tailMatch = /(\d{6,})[a-z0-9]*\/?$/i.exec(url);
      const oem = entry.numbers[0] ?? tailMatch?.[1] ?? null;
      if (!oem) continue;
      products.push({
        oem,
        title: entry.titles[0] ?? null,
        price: null,
        sourceUrl: url,
      });
    }
  }

  return products;
}

/** Candidates for the given roles from one fetched category page. Every
 *  candidate's title must PASS the role's identity lexicon — no title, no
 *  candidate (vehicle-scoped page or not, a number with no component
 *  identity is exactly how wrong parts happen). */
export function candidatesFromCategoryPage(input: {
  html: string | null;
  markdown: string | null;
  url: string;
  make: string;
  roleKeys: readonly string[];
}): CategoryCandidate[] {
  const out: CategoryCandidate[] = [];
  const seen = new Set<string>();
  const products = extractPageProducts({ html: input.html, markdown: input.markdown, url: input.url });
  for (const roleKey of input.roleKeys) {
    for (const prod of products) {
      if (!prod.title) continue;
      const verdict = checkRoleIdentity(roleKey, prod.title);
      if (verdict.verdict !== "pass") continue;
      const sanitized = sanitizePartNumber(prod.oem, input.make);
      if (!sanitized) continue;
      const key = `${roleKey}|${normalizeOemNumber(sanitized)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ roleKey, oem: sanitized, title: prod.title, price: prod.price, sourceUrl: prod.sourceUrl });
    }
  }
  return out;
}

/** Same-make interchange candidates from a RockAuto OEM/Interchange set. The
 *  cross-brand members (the Subaru number in a Honda pad's set) die on the
 *  make format gate; the survivors are still only CANDIDATES for the
 *  verifier. */
export function interchangeCandidates(input: {
  interchange: readonly string[];
  make: string;
  exclude?: ReadonlySet<string>;
  cap?: number;
}): string[] {
  const cap = input.cap ?? 4;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.interchange) {
    if (out.length >= cap) break;
    const sanitized = sanitizePartNumber(raw, input.make);
    if (!sanitized) continue;
    const norm = normalizeOemNumber(sanitized);
    if (seen.has(norm) || input.exclude?.has(norm)) continue;
    seen.add(norm);
    out.push(sanitized);
  }
  return out;
}

// ─── Shared context loader ──────────────────────────────────────────────────

async function loadMissingContext(
  ctx: any,
  vehicleConfigId: any,
  /** Wave 3: slugs to ASSUME applicable when no run has recorded any yet —
   *  lets the in-run brake harvest work on a FIRST enrichment, where
   *  quotability hasn't been computed. Only ever universal services. */
  assumeSlugs?: readonly string[],
) {
  const resolved: any = await ctx.runQuery(
    internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
    { vehicleConfigId },
  );
  if (!resolved || !resolved.makeId) return null;
  const latestRun: any = await ctx.runQuery(
    internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
    { vehicleConfigId },
  );
  let applicableSlugs: string[] = ((latestRun?.quotability?.services ?? []) as any[]).map(
    (s: any) => s.slug,
  );
  if (applicableSlugs.length === 0) {
    applicableSlugs = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getPriorApplicableSlugs,
      { vehicleConfigId },
    );
  }
  if (applicableSlugs.length === 0 && assumeSlugs && assumeSlugs.length > 0) {
    applicableSlugs = [...assumeSlugs];
  }
  if (applicableSlugs.length === 0) return null;
  const configRow: any = await ctx.runQuery(
    internal.vehicleEnrichment.v3queries.getVehicleConfigById,
    { vehicleConfigId },
  );
  const naKeys = new Set<string>([
    ...(((latestRun?.field_gaps ?? []) as Array<{ field: string; reason: string }>)
      .filter((g) => g.reason === "not_applicable" && (PART_FIELD_MAP as any)[g.field])
      .map((g) => (PART_FIELD_MAP as any)[g.field].subcategory) as string[]),
    ...(((configRow?.na_role_keys ?? []) as string[]) ?? []),
  ]);
  const fitments = await ctx.runQuery(
    internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
    { vehicleConfigId },
  );
  const missing = missingCoreRoles(fitments, applicableSlugs, naKeys);
  const blockedRows: any[] = await ctx.runQuery(
    internal.vehicleEnrichment.v3queries.getBlockedOemsForConfig,
    { vehicleConfigId },
  );
  const blocked = new Set<string>(
    blockedRows.map((b: any) => String(b.oem_part_number_normalized ?? "").toUpperCase()),
  );
  const metaBySubcategory: Record<string, any> = Object.fromEntries(
    Object.values(PART_FIELD_MAP).map((m: any) => [m.subcategory, m]),
  );
  return { resolved, latestRun, applicableSlugs, naKeys, missing, blocked, blockedRows, metaBySubcategory };
}

async function writeCandidate(
  ctx: any,
  vehicleConfigId: any,
  meta: any,
  makeId: any,
  cand: { roleKey: string; oem: string; title: string | null; price: number | null; sourceUrl: string | null },
  confidence: number,
): Promise<boolean> {
  const sourceDomain = (() => {
    try {
      return cand.sourceUrl ? new URL(cand.sourceUrl).hostname.replace(/^www\./, "") : undefined;
    } catch {
      return undefined;
    }
  })();
  const res: any = await ctx.runMutation(
    internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
    {
      oem_part_number: cand.oem,
      name: meta.name,
      category: meta.category,
      subcategory: meta.subcategory,
      make_id: makeId,
      vehicle_config_id: vehicleConfigId,
      service_type: meta.serviceSlug ?? meta.subcategory,
      quantity_needed: cand.roleKey === "front_rotor" || cand.roleKey === "rear_rotor" ? 2 : 1,
      position: meta.position,
      service_role: meta.serviceRole,
      confidence,
      source_domain: sourceDomain,
      observed_title: cand.title ?? undefined,
    },
  );
  if (!res?.part_id || res?.rejected) return false;
  if (cand.price != null && cand.price > 0 && sourceDomain && cand.sourceUrl) {
    try {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
        part_id: res.part_id,
        price: cand.price,
        price_type: "sale",
        source_url: cand.sourceUrl,
        source_domain: sourceDomain,
      });
    } catch (e) {
      console.warn(`[category-harvest] price write failed for ${cand.oem} (non-fatal):`, e);
    }
  }
  return true;
}

// ─── Rung 1: vehicle-scoped category pages ──────────────────────────────────

/** Category pages fetched per vehicle — one Firecrawl call each.
 *
 *  Raised 4 → 6 on Aug 13 2026. Four was below the size of a real gap set: the
 *  2021 Nautilus came in with SIX missing core roles, every one of which had a
 *  matching category on the page, and the budget silently discarded the last
 *  two (rear rotor, spark plug) — the spark plug's category was already being
 *  fetched for another role. Six covers the observed set exactly. Whatever the
 *  budget is, what it drops is now logged rather than swallowed. */
const CATEGORY_PAGE_BUDGET = 6;

/** The powertrain-independent role/service sets the in-run harvest is allowed
 *  to assume. Declared in quotability.ts — the module that owns role semantics
 *  and, unlike this one, is not part of the v3pipeline import loop. Re-exported
 *  here because this is where callers look for them. */
export { EARLY_ROLE_KEYS, EARLY_SERVICE_SLUGS } from "./quotability";


export const harvestVehicleCategories = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    /** Restrict the harvest to these roleKeys. Unset = heal-time behaviour,
     *  all missing roles against REAL applicability. */
    roleFilter: v.optional(v.array(v.string())),
    /**
     * In-run mode: the harvest picks its own role scope from the decoded
     * POWERTRAIN and assumes the matching services.
     *
     * The pipeline passes this instead of a roleFilter deliberately. Both
     * sides could compute `earlyHarvestScope` — the pipeline has the fuel type
     * in hand at that point too — but then a disagreement between them would
     * silently produce `withinScope: false` and a harvest that no-ops while
     * still logging as if it ran. One owner, no drift.
     */
    inRunScope: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (process.env.PARTS_CATEGORY_HARVEST === "off") return { status: "disabled" as const };
    // How wide the in-run assumption may go is decided by the POWERTRAIN, which
    // Batch 1 has already decoded by the time this runs. A caller whose
    // roleFilter stays inside that scope gets the matching service assumption;
    // anything outside it gets none, and therefore no harvest until
    // applicability is real. See earlyHarvestScope for the reasoning per class.
    // In-run mode reads the POWERTRAIN and widens as far as it allows. An
    // explicit roleFilter is honoured only while it stays inside that scope;
    // outside it, no services are assumed and the harvest waits for real
    // applicability — never guess broader applicability.
    let scope: ReturnType<typeof earlyHarvestScope> | null = null;
    if (args.inRunScope || args.roleFilter) {
      let fuelType: string | null = null;
      try {
        const r: any = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
          { vehicleConfigId: args.vehicleConfigId },
        );
        fuelType = r?.fuelType ?? null;
      } catch {
        // Fail open to the narrow set — a decode miss costs coverage, never
        // correctness.
      }
      scope = earlyHarvestScope(classifyFuelClass(fuelType));
    }
    const assumeSlugs = (() => {
      if (!scope) return undefined;
      if (args.inRunScope) return scope.serviceSlugs;
      return args.roleFilter!.every((r) => scope!.roleKeys.includes(r))
        ? scope.serviceSlugs
        : undefined;
    })();
    if (scope) {
      console.log(
        `[category-harvest] in-run scope ${scope.basis} — ` +
          `${scope.roleKeys.length} roles allowed, assume=${assumeSlugs ? "yes" : "no"}`,
      );
    }
    const cx = await loadMissingContext(ctx, args.vehicleConfigId, assumeSlugs);
    if (!cx) return { status: "no_config" as const };
    // Scope the work: an explicit filter when given, else the powertrain scope
    // in in-run mode, else everything (heal-time, real applicability).
    const allowed = args.roleFilter ?? (args.inRunScope ? scope!.roleKeys : null);
    const missing = allowed
      ? cx.missing.filter((m) => allowed.includes(m.roleKey))
      : cx.missing;
    if (missing.length === 0) return { status: "nothing_missing" as const };
    const { resolved } = cx;
    const config = getSourceConfig(resolved.make);
    // Wave 3 (Aug 2026): multi-make RevolutionParts storefronts as harvest
    // fallbacks. AutoNation runs the same RP platform with identical
    // /v-{slug}/{category} pages across MANY brands (live example:
    // autonationparts.com/v-2020-mercedes-benz-glc43-amg--4matic--3-0l-v6-gas/
    // brakes--anti-lock-brakes), so it serves makes with NO registry
    // storefront and is a second catalog voice when the primary can't
    // resolve the vehicle. Tried only after the primary fails, with a
    // smaller SERP budget — lightweight by design.
    // Order = trust/coverage preference; each fallback only costs SERP
    // queries when everything before it failed to resolve the vehicle.
    // tascaparts.com: Tasca's multi-make RP store (Ford/GM/Mopar/Mazda/
    // Volvo/Kia/Hyundai…), same /search?search_str= + /v- page shapes.
    // NOT here: carid.com — aftermarket retailer; its SKUs are the exact
    // contamination class the make-format/brand-signature gates reject
    // (OEM-only doctrine). Aftermarket sources may join PRICE discovery
    // breadth someday, never part-number harvesting.
    const FALLBACK_RP_STOREFRONTS = [
      "https://www.autonationparts.com",
      "https://www.tascaparts.com",
    ];
    const bases = [
      ...(config ? [config.parts.storeBaseUrl.replace(/\/+$/, "")] : []),
      ...FALLBACK_RP_STOREFRONTS,
    ];

    // 1) Vehicle slug: cached scrape URL when it is vehicle-scoped, else a
    //    site-scoped SERP per candidate storefront (year must appear in the
    //    slug; model tokens score). First storefront that resolves wins.
    let storeBase: string | null = null;
    let slugPath: string | null = null;
    try {
      const cached: any = await ctx.runQuery(
        internal.vehicleEnrichment.scraperQueries.getCachedScrape,
        {
          vehicleMake: resolved.make,
          vehicleModel: resolved.model,
          vehicleYear: resolved.year,
          vehicleTrim: resolved.trim ?? "",
          sourceType: "parts_catalog",
        },
      );
      // The cached URL may itself have come from open-web search — run it
      // through the same exact-vehicle gate as the SERP fallback, and only
      // adopt it for the storefront it actually belongs to.
      const cachedSlug = extractVehicleSlugPath(cached?.url ?? null);
      if (cachedSlug) {
        const cachedHost = new URL(cached.url).hostname.replace(/^www\./, "");
        const owner = bases.find(
          (b) => new URL(b).hostname.replace(/^www\./, "") === cachedHost,
        );
        if (owner) {
          slugPath = pickVehicleSlug([`${owner}${cachedSlug}`], {
            year: resolved.year,
            model: resolved.model,
            displacement: resolved.displacement,
          });
          if (slugPath) storeBase = owner;
        }
      }
    } catch {
      /* cache miss is fine */
    }
    if (!slugPath) {
      // Query shapes matter: catalogs write "GLC43 AMG" where decode says
      // "AMG GLC 43", and the generic "{year} {model} parts" query ranks
      // detail pages over `/v-` vehicle pages — a part-word query is what
      // reliably surfaces the vehicle-scoped category URLs (observed live:
      // "GLC43 spark plug" ranked the 2020 ignition category page #2).
      const collapsed = String(resolved.model).replace(/([A-Za-z])\s+(\d)/g, "$1$2");
      const firstRoleWords = (missing[0]?.roleKey ?? "oil filter").replace(/_/g, " ");
      outer: for (const base of bases) {
        const host = new URL(base).hostname.replace(/^www\./, "");
        const isPrimary = bases[0] === base && config != null;
        const queries = isPrimary
          ? [
              `site:${host} ${resolved.year} ${resolved.model} parts`,
              `site:${host} ${collapsed} ${firstRoleWords}`,
              `site:${host} ${resolved.year} ${collapsed}`,
            ]
          : [
              // Fallback storefronts get a tighter budget: the two query
              // shapes that actually surfaced /v- pages in live fire.
              `site:${host} ${collapsed} ${firstRoleWords}`,
              `site:${host} ${resolved.year} ${resolved.model} parts`,
            ];
        for (const q of queries) {
          const results = await searchAndFetch(q, 4, false);
          slugPath = pickVehicleSlug(
            results.map((r) => r.url),
            { year: resolved.year, model: resolved.model, displacement: resolved.displacement },
          );
          if (slugPath) {
            storeBase = base;
            break outer;
          }
        }
      }
    }
    if (!slugPath || !storeBase) return { status: "no_vehicle_slug" as const };

    // 2) Vehicle root → the store's real category list.
    const root = await fetchUrlWithHtml(`${storeBase}${slugPath}`);
    const links = extractCategoryLinks(root.markdown ?? root.html ?? "", slugPath);
    if (links.length === 0) return { status: "no_categories", slugPath } as const;

    const missingRoleKeys = [...new Set(missing.map((m) => m.roleKey))];
    const pages = categoriesForRoles(missingRoleKeys, links, CATEGORY_PAGE_BUDGET);

    // What the rung is NOT going to look for, and why. `no_matching_categories`
    // used to be the whole story, and it conflated three different failures —
    // the role has no hints, the hints matched nothing on this store, or the
    // page budget ran out — which is why the Nautilus read as "Ford's naming
    // isn't in our table" when the table was fine and the budget was the
    // problem. Roles dropped here go on to look identical to roles the catalog
    // genuinely lacks, so this is the only place the difference exists.
    const covered = new Set(pages.flatMap((p) => p.roles));
    const uncovered = missingRoleKeys.filter((r) => !covered.has(r));
    if (uncovered.length > 0) {
      const unhinted = uncovered.filter((r) => !hasCategoryHints(r));
      const unmatched = uncovered.filter((r) => hasCategoryHints(r));
      console.warn(
        `[category-harvest] ${uncovered.length}/${missingRoleKeys.length} missing role(s) get no category page` +
          (unhinted.length ? ` — no hints defined: ${unhinted.join(",")}` : "") +
          (unmatched.length
            ? ` — hints matched nothing or budget(${CATEGORY_PAGE_BUDGET}) exhausted: ${unmatched.join(",")}`
            : "") +
          ` [${links.length} categories on ${slugPath}: ${links.slice(0, 12).map((l) => l.slug).join(", ")}${links.length > 12 ? ", …" : ""}]`,
      );
    }

    if (pages.length === 0) {
      return {
        status: "no_matching_categories",
        slugPath,
        // The store's own vocabulary, so a naming mismatch can be diagnosed
        // from the run record instead of by re-scraping the site by hand.
        sawCategories: links.slice(0, 40).map((l) => l.slug),
        wanted: missingRoleKeys,
      } as const;
    }

    // 3) Fetch each chosen category page, gather role-gated candidates.
    const candidates: CategoryCandidate[] = [];
    for (const page of pages) {
      try {
        const fetched = await fetchUrlWithHtml(page.url);
        candidates.push(
          ...candidatesFromCategoryPage({
            html: fetched.html,
            markdown: fetched.markdown,
            url: page.url,
            make: resolved.make,
            roleKeys: page.roles,
          }),
        );
      } catch (e) {
        console.warn(`[category-harvest] fetch failed for ${page.url} (non-fatal):`, e);
      }
    }
    const fresh = candidates.filter((c) => !cx.blocked.has(normalizeOemNumber(c.oem)));
    if (fresh.length === 0) {
      return { status: "no_candidates", slugPath, pages: pages.map((p) => p.slug) } as const;
    }

    // 4) One fitment-verify batch. The page is the store's own vehicle-scoped
    //    catalog, so attestation is strong: a candidate writes unless the
    //    verifier POSITIVELY refutes it (uncertain keeps the catalog's word).
    const toVerify = fresh.slice(0, 8);
    const verdicts = await verifyPartFitments(
      {
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim ?? "",
        engineCode: resolved.engineCode ?? undefined,
        displacement: resolved.displacement ?? undefined,
      },
      toVerify.map((c) => ({
        roleKey: c.roleKey,
        oem: c.oem,
        name: cx.metaBySubcategory[c.roleKey]?.name ?? c.roleKey,
        quantity: null,
        observedTitle: c.title,
      })),
    );
    const written: string[] = [];
    const outcomes: string[] = [];
    const filled = new Set<string>();
    for (const c of toVerify) {
      const vd = verdicts.find(
        (x) => x.roleKey === c.roleKey && normalizeOemNumber(x.oem) === normalizeOemNumber(c.oem),
      );
      const verdict = vd?.verdict ?? "uncertain";
      outcomes.push(`${c.roleKey}:${c.oem}:${verdict}`);
      if (verdict === "refuted" || filled.has(c.roleKey)) continue;
      const meta = cx.metaBySubcategory[c.roleKey];
      if (!meta) continue;
      const ok = await writeCandidate(ctx, args.vehicleConfigId, meta, resolved.makeId, c, 0.75);
      if (ok) {
        filled.add(c.roleKey);
        written.push(`${c.roleKey}:${c.oem}`);
      } else {
        outcomes.push(`${c.roleKey}:${c.oem}:write_rejected`);
      }
    }
    const summary = {
      status: "done" as const,
      slugPath,
      pages: pages.map((p) => p.slug),
      candidates: fresh.length,
      outcomes,
      written,
    };
    console.log("[category-harvest]", JSON.stringify(summary));
    return summary;
  },
});

// ─── Rung 3: RockAuto VEHICLE-KEYED walk ────────────────────────────────────
//
// The second operator. Every other parts rung — every one — resolves to
// RevolutionParts (makeCoverage.auditOperatorDiversity: 36/36 makes, severity
// `alarm`), so when RP's catalogue is thin for a year/model the whole
// deterministic lane fails together and the run drops to open-web search. That
// is what the domestic misses in the Aug 2026 batch looked like from outside.
//
// RockAuto is an independent catalogue and, re-probed live Aug 2026, its tree
// walks server-side end to end. See rockautoCatalog.ts for the walk, the
// position handling and — the crux — why interchange numbers reached BY THE
// VEHICLE can be ranked by brand corroboration without violating THE LAW.
//
// Ranked AFTER rung 2 because it is the most expensive rung here: 2 catalogue
// fetches per role plus one moreinfo fetch per listing inspected. It runs only
// on roles everything cheaper has already failed to fill.
//
// Kill: PARTS_ROCKAUTO_VEHICLE=off.

/** Roles attempted per invocation. Each costs ~2 + MOREINFO_BUDGET fetches. */
const ROCKAUTO_ROLE_BUDGET = 3;
/** Listings whose interchange set is read, per role. */
const MOREINFO_BUDGET = 6;
/** Candidates handed to the fitment verifier, per role, best-corroborated first. */
const ROCKAUTO_VERIFY_BUDGET = 3;

export const harvestRockAutoVehicle = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    if (process.env.PARTS_ROCKAUTO_VEHICLE === "off") return { status: "disabled" as const };
    const cx = await loadMissingContext(ctx, args.vehicleConfigId);
    if (!cx) return { status: "no_config" as const };
    if (cx.missing.length === 0) return { status: "nothing_missing" as const };
    const { resolved } = cx;

    // Only roles this adapter knows where to find. A role with no location is
    // skipped in silence otherwise, which reads downstream as "RockAuto had
    // nothing" when the truth is "we never looked".
    const targets = [...new Set(cx.missing.map((m: any) => m.roleKey))]
      .filter((r) => ROCKAUTO_ROLE_LOCATION[r] != null)
      .slice(0, ROCKAUTO_ROLE_BUDGET);
    if (targets.length === 0) {
      return {
        status: "no_locatable_roles" as const,
        missing: [...new Set(cx.missing.map((m: any) => m.roleKey))],
      };
    }

    const displacementL = (() => {
      const n = parseFloat(String(resolved.displacement ?? "").replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    if (displacementL == null) return { status: "no_displacement" as const };

    const fetchPath = async (path: string) => {
      const r = await adapterFetch(`https://www.rockauto.com${path}`, { timeoutMs: 25_000 });
      await new Promise((x) => setTimeout(x, 300));
      return r;
    };

    // ── Walk once to the ENGINE, then reuse it for every role ──────────────
    const modelPath = buildCatalogPath([resolved.make, resolved.year, resolved.model]);
    let engine: CatalogNode | null = null;
    try {
      const modelRes = await fetchPath(modelPath);
      engine = pickEngineNode(parseCatalogNodes(modelRes.body, modelPath), {
        displacementL,
        cylinders: null,
      });
    } catch (e) {
      console.warn("[rockauto-vehicle] model fetch failed (non-fatal):", e);
    }
    // A null engine is a REAL answer — RockAuto lists every engine offered that
    // year, and walking the wrong one harvests another powertrain's parts.
    if (!engine) return { status: "no_engine_match" as const, modelPath };

    // Categories are shared across roles; fetch once.
    let categories: CatalogNode[] = [];
    try {
      const catRes = await fetchPath(engine.path);
      categories = parseCatalogNodes(catRes.body, engine.path);
    } catch (e) {
      console.warn("[rockauto-vehicle] category fetch failed (non-fatal):", e);
    }
    if (categories.length === 0) return { status: "no_categories" as const, engine: engine.path };

    const outcomes: string[] = [];
    const written: string[] = [];
    const partTypeCache = new Map<string, CatalogNode[]>();

    for (const roleKey of targets) {
      const loc = ROCKAUTO_ROLE_LOCATION[roleKey];
      const category = pickNodeByPatterns(categories, loc.category);
      if (!category) {
        outcomes.push(`${roleKey}:no_category`);
        continue;
      }
      try {
        let partTypes = partTypeCache.get(category.path);
        if (!partTypes) {
          const ptRes = await fetchPath(category.path);
          partTypes = parseCatalogNodes(ptRes.body, category.path);
          partTypeCache.set(category.path, partTypes);
        }
        const partType = pickNodeByPatterns(partTypes, loc.partType);
        if (!partType) {
          outcomes.push(`${roleKey}:no_part_type`);
          continue;
        }

        const listRes = await fetchPath(partType.path);
        const all = parsePositionedListings(listRes.body);
        const wantPos = positionOfRoleKey(roleKey);
        // A position-bearing role takes ONLY listings under its own side.
        // RockAuto puts front and rear on one page, so an unpositioned listing
        // is unusable here — never "either side".
        const listings = wantPos ? all.filter((l) => l.position === wantPos) : all;
        if (listings.length === 0) {
          outcomes.push(`${roleKey}:no_listings(total=${all.length},want=${wantPos})`);
          continue;
        }

        const sets: InterchangeSet[] = [];
        for (const l of listings.slice(0, MOREINFO_BUDGET)) {
          try {
            const r = await adapterFetch(l.moreInfoUrl, { timeoutMs: 25_000 });
            sets.push({ brand: l.manufacturer, numbers: parseInterchangeNumbers(r.body) });
            await new Promise((x) => setTimeout(x, 300));
          } catch {
            /* fail open per listing */
          }
        }

        // Brand corroboration, then the SAME gates every other rung applies:
        // make format, refute blocklist, then the adversarial verifier.
        const ranked = rankInterchangeCandidates(sets)
          .filter((c) => c.brandCount >= MIN_BRAND_CORROBORATION)
          .map((c) => ({ ...c, sanitized: sanitizePartNumber(c.oem, resolved.make) }))
          .filter((c) => c.sanitized != null)
          .filter((c) => !cx.blocked.has(normalizeOemNumber(c.sanitized!)))
          .slice(0, ROCKAUTO_VERIFY_BUDGET);
        if (ranked.length === 0) {
          outcomes.push(`${roleKey}:no_corroborated_candidates(sets=${sets.length})`);
          continue;
        }

        const meta = cx.metaBySubcategory[roleKey];
        if (!meta) {
          outcomes.push(`${roleKey}:no_meta`);
          continue;
        }
        const verdicts = await verifyPartFitments(
          {
            year: resolved.year,
            make: resolved.make,
            model: resolved.model,
            trim: resolved.trim ?? "",
            engineCode: resolved.engineCode ?? undefined,
            displacement: resolved.displacement ?? undefined,
          },
          ranked.map((c) => ({
            roleKey,
            oem: c.sanitized!,
            name: meta.name ?? roleKey,
            quantity: null,
            // No listing TITLE backs an interchange number — it is a number the
            // catalogue says this part replaces, not a product we read. Passing
            // a fabricated title would feed the role-identity check something
            // no page ever said.
            observedTitle: null,
          })),
        );

        let filled = false;
        for (const c of ranked) {
          if (filled) break;
          const vd = verdicts.find(
            (x) => normalizeOemNumber(x.oem) === normalizeOemNumber(c.sanitized!),
          );
          const verdict = vd?.verdict ?? "uncertain";
          outcomes.push(`${roleKey}:${c.sanitized}:x${c.brandCount}:${verdict}`);
          // CONFIRMED ONLY. Rung 1 may write on "uncertain" because the store's
          // vehicle-scoped URL is itself the fitment statement; here the
          // evidence is an aftermarket cross-reference, which THE LAW says is
          // never fitment-equivalent. Same standard as rung 2.
          if (verdict !== "confirmed") continue;
          const ok = await writeCandidate(
            ctx,
            args.vehicleConfigId,
            meta,
            resolved.makeId,
            {
              roleKey,
              oem: c.sanitized!,
              title: null,
              price: null,
              sourceUrl: `https://www.rockauto.com${partType.path}`,
            },
            0.7,
          );
          if (ok) {
            filled = true;
            written.push(`${roleKey}:${c.sanitized}`);
          } else {
            outcomes.push(`${roleKey}:${c.sanitized}:write_rejected`);
          }
        }
      } catch (e) {
        outcomes.push(`${roleKey}:error`);
        console.warn(`[rockauto-vehicle] ${roleKey} failed (non-fatal):`, e);
      }
    }

    const summary = {
      status: "done" as const,
      engine: engine.segment,
      carcode: engine.id,
      targets,
      outcomes,
      written,
    };
    console.log("[rockauto-vehicle]", JSON.stringify(summary));
    return summary;
  },
});

// ─── Rung 2: RockAuto OEM/Interchange backtrack ─────────────────────────────

export const backtrackInterchange = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    if (process.env.PARTS_INTERCHANGE_BACKTRACK === "off") return { status: "disabled" as const };
    const cx = await loadMissingContext(ctx, args.vehicleConfigId);
    if (!cx) return { status: "no_config" as const };
    if (cx.missing.length === 0) return { status: "nothing_missing" as const };
    const { resolved } = cx;

    // Seeds: the missing roles' own refuted numbers — real parts RockAuto can
    // resolve, whose interchange sets point back toward the right OEM number.
    const missingBySlug = new Map<string, string[]>();
    for (const m of cx.missing) {
      missingBySlug.set(m.serviceSlug, [...(missingBySlug.get(m.serviceSlug) ?? []), m.roleKey]);
    }
    const fieldByRole: Record<string, string> = {};
    for (const [fieldKey, meta] of Object.entries(PART_FIELD_MAP)) {
      fieldByRole[(meta as any).subcategory] = fieldKey;
    }
    const seeds: Array<{ field_key: string; part_number: string; roleKey: string }> = [];
    for (const row of cx.blockedRows) {
      const roles = (missingBySlug.get(String(row.service_type ?? "")) ?? []).filter(
        (rk) => cx.metaBySubcategory[rk],
      );
      if (roles.length !== 1) continue;
      const roleKey = roles[0];
      const num = String(row.oem_part_number_normalized ?? "");
      if (num.length < 5) continue;
      seeds.push({ field_key: fieldByRole[roleKey] ?? roleKey, part_number: num, roleKey });
    }
    if (seeds.length === 0) return { status: "no_seeds", missing: cx.missing.map((m) => m.roleKey) } as const;

    const { attestations, errors, blocked } = await attestParts(seeds, { maxParts: 4 });
    if (attestations.length === 0) {
      return { status: "no_attestations", blocked, errors: errors.slice(0, 6) } as const;
    }

    // Interchange members → same-make candidates → the fitment verifier.
    const roleBySeedField = new Map(seeds.map((s) => [s.field_key, s.roleKey]));
    const toVerify: Array<{ roleKey: string; oem: string; name: string; quantity: number | null; observedTitle: string | null }> = [];
    for (const a of attestations) {
      const roleKey = roleBySeedField.get(a.field_key);
      if (!roleKey) continue;
      for (const oem of interchangeCandidates({
        interchange: a.interchange,
        make: resolved.make,
        exclude: cx.blocked,
        cap: 3,
      })) {
        if (toVerify.some((t) => normalizeOemNumber(t.oem) === normalizeOemNumber(oem))) continue;
        toVerify.push({
          roleKey,
          oem,
          name: cx.metaBySubcategory[roleKey]?.name ?? roleKey,
          quantity: null,
          observedTitle: a.observed_product ? `interchange of ${a.observed_product}` : null,
        });
      }
    }
    if (toVerify.length === 0) return { status: "no_candidates" } as const;

    const verdicts = await verifyPartFitments(
      {
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim ?? "",
        engineCode: resolved.engineCode ?? undefined,
        displacement: resolved.displacement ?? undefined,
      },
      toVerify,
    );
    const written: string[] = [];
    const outcomes: string[] = [];
    const filled = new Set<string>();
    for (const t of toVerify) {
      const vd = verdicts.find(
        (x) => x.roleKey === t.roleKey && normalizeOemNumber(x.oem) === normalizeOemNumber(t.oem),
      );
      const verdict = vd?.verdict ?? "uncertain";
      outcomes.push(`${t.roleKey}:${t.oem}:${verdict}`);
      // Interchange provenance is the WEAKEST rung — cross-brand catalog
      // consolidation. Only a positive confirmation writes.
      if (verdict !== "confirmed" || filled.has(t.roleKey)) continue;
      const meta = cx.metaBySubcategory[t.roleKey];
      if (!meta) continue;
      const ok = await writeCandidate(
        ctx,
        args.vehicleConfigId,
        meta,
        resolved.makeId,
        { roleKey: t.roleKey, oem: t.oem, title: null, price: null, sourceUrl: null },
        0.7,
      );
      if (ok) {
        filled.add(t.roleKey);
        written.push(`${t.roleKey}:${t.oem}`);
      } else {
        outcomes.push(`${t.roleKey}:${t.oem}:write_rejected`);
      }
    }
    const summary = { status: "done" as const, seeds: seeds.length, candidates: toVerify.length, outcomes, written };
    console.log("[interchange-backtrack]", JSON.stringify(summary));
    return summary;
  },
});
