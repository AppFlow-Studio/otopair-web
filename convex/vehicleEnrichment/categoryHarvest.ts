// =============================================================================
// vehicleEnrichment/categoryHarvest.ts — two heal rungs that close core-role
// gaps from CATALOG STRUCTURE instead of open-web research (Aug 2026).
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
// and die per-rung without breaking the heal. Kill: PARTS_CATEGORY_HARVEST=off
// / PARTS_INTERCHANGE_BACKTRACK=off.
// =============================================================================

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { attestParts } from "./sourceAdapters/rockauto";
import { getSourceConfig } from "./sourceRegistry";
import { fetchUrlWithHtml, searchAndFetch } from "./firecrawl";
import { parsePartPrices, normalizeOemNumber } from "./priceParser";
import { checkRoleIdentity } from "./roleIdentity";
import { sanitizePartNumber } from "./contentSanitization";
import { verifyPartFitments } from "./utils/partFitmentVerifier";
import { missingCoreRoles } from "./quotability";
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
  oil_filter: [/filter/, /maintenance/],
  air_filter: [/air-filter/, /filter/, /air-intake/, /maintenance/],
  cabin_filter: [/cabin/, /filter/, /hvac/, /maintenance/],
  spark_plug: [/spark-plug/, /spark/, /ignition--ignition-coil/, /^ignition--/],
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

/** Categories a role must NEVER take, however well a hint matched. */
const ROLE_CATEGORY_BLOCKS: Record<string, RegExp> = {
  spark_plug: /lock|switch|key|starter/,
  battery: /cable|lock|switch|starter|alternator/,
  coolant: /belt|hose|pump|fan/,
  atf_fluid: /mount|cooler-line/,
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

const CATEGORY_PAGE_BUDGET = 4;

/** Universal brake services — assumable on a first run before quotability
 *  exists (every car has brakes; drum-rear vehicles are handled by
 *  na_role_keys, which loadMissingContext already applies on top). */
const BRAKE_SERVICE_SLUGS = ["brake_pad_replacement", "rotor_replacement"] as const;
export const BRAKE_ROLE_KEYS = [
  "front_brake_pad",
  "rear_brake_pad",
  "front_rotor",
  "rear_rotor",
] as const;

export const harvestVehicleCategories = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    /** Wave 3 in-run mode: restrict the harvest to these roleKeys (the
     *  pipeline passes the brake roles between Batch 1 and Batch 2, so
     *  rotors/pads are born catalog-attested instead of
     *  extract-then-refute). Unset = heal-time behavior, all missing roles. */
    roleFilter: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    if (process.env.PARTS_CATEGORY_HARVEST === "off") return { status: "disabled" as const };
    const cx = await loadMissingContext(
      ctx,
      args.vehicleConfigId,
      // Only the brake-scoped in-run call may assume slugs, and only the
      // universal brake services — never guess broader applicability.
      args.roleFilter?.every((r) => (BRAKE_ROLE_KEYS as readonly string[]).includes(r))
        ? BRAKE_SERVICE_SLUGS
        : undefined,
    );
    if (!cx) return { status: "no_config" as const };
    const missing = args.roleFilter
      ? cx.missing.filter((m) => args.roleFilter!.includes(m.roleKey))
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
    if (pages.length === 0) return { status: "no_matching_categories", slugPath } as const;

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
