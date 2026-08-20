// =============================================================================
// sourceAdapters/rockautoCatalog.ts — RockAuto keyed BY VEHICLE.
//
// WHY THIS EXISTS
// ---------------
// rockauto.ts opens by asserting that RockAuto "cannot answer 'what pad fits a
// 2016 CR-V' through a stable server-fetchable path", which is why that adapter
// is part-keyed and can only CONFIRM numbers we already hold. Re-probed live
// Aug 2026, that assertion is false. The catalogue walks server-side, end to
// end, through plain URLs:
//
//   /en/catalog/gmc                                        → years
//   /en/catalog/gmc,2021                                   → models
//   /en/catalog/gmc,2021,acadia                            → engines + carcodes
//   /en/catalog/gmc,2021,acadia,3.6l+v6,3446618            → categories
//   …,3446618,brake+&+wheel+hub                            → part types (+ ids)
//   …,brake+&+wheel+hub,rotor,1896                         → LISTINGS + prices
//
// Every level returned HTTP 200, server-rendered, unblocked. That matters more
// than one adapter's reach: makeCoverage.auditOperatorDiversity reports that
// ALL 36 registry makes resolve to a single operator (RevolutionParts), so the
// deterministic parts lane has no second voice at all. RockAuto is a genuinely
// independent catalogue, and vehicle-keying it is what turns it from a
// corroborator into a second source.
//
// ── THE OEM-ONLY PROBLEM, AND HOW THIS SOLVES IT ───────────────────────────
//
// The listings are AFTERMARKET (PROSPEC, DURAGO, FVP, DYNAMIC FRICTION). This
// pipeline sells OEM parts only, so an aftermarket SKU is not a deliverable.
// The bridge is the same `moreinfo.php` page rockauto.ts already parses, which
// publishes each listing's "OEM / Interchange Numbers".
//
// But THE LAW in rockauto.ts still binds: that list belongs to ONE AFTERMARKET
// PART across MANY vehicles, and is never fitment-equivalent. Wagner's pad
// interchange set for a CR-V contains a SUBARU number.
//
// What is different HERE — and it is the whole reason this is sound — is that
// the listing was reached BY THE VEHICLE. RockAuto's own catalogue states that
// this DURAGO rotor fits a 2021 Acadia 3.6L V6. So the vehicle's true OEM
// number must appear in that listing's interchange set; the contamination is
// the OTHER vehicles' numbers sharing the same aftermarket casting.
//
// That turns identification into a CORROBORATION problem, which is exactly
// what `rankInterchangeCandidates` below does: an OEM number listed by SEVERAL
// INDEPENDENT BRANDS that all fit this vehicle is almost certainly this
// vehicle's number, while a number appearing under one brand only is likely a
// different vehicle that happens to share that brand's casting. Brand count is
// the evidence, exactly as source-family count is in the claim ledger.
//
// Nothing here writes. It parses and ranks; the caller applies the make format
// gate, the role-identity gate and the adversarial fitment verifier, and only a
// number that survives all three is ever stored.
// =============================================================================

import { normalizeOemNumber } from "../priceParser";

const BASE = "https://www.rockauto.com";

// ─── URL construction ───────────────────────────────────────────────────────

/**
 * Encode ONE catalogue path segment.
 *
 * RockAuto's segments are comma-separated and space-as-plus, and they carry
 * literal `&` (e.g. "brake & wheel hub"). `encodeURIComponent` would turn that
 * into %26 and the site 404s, so the encoding is deliberately narrow: lowercase,
 * spaces to `+`, everything else verbatim. Segments come from the site's own
 * HTML, not from user input, so there is nothing here to sanitize against.
 */
export function encodeSegment(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "+");
}

/** `/en/catalog/a,b,c` from ordered segments. */
export function buildCatalogPath(segments: readonly (string | number)[]): string {
  const body = segments
    .filter((s) => s !== null && s !== undefined && String(s).length > 0)
    .map((s) => (typeof s === "number" ? String(s) : encodeSegment(s)))
    .join(",");
  return `/en/catalog/${body}`;
}

export function catalogUrl(segments: readonly (string | number)[]): string {
  return `${BASE}${buildCatalogPath(segments)}`;
}

// ─── Tree parsing ───────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export type CatalogNode = {
  /** Path relative to the site root, entity-decoded. */
  path: string;
  /** The final comma segment — the node's own name, e.g. "3.6l v6". */
  segment: string;
  /** Trailing numeric id when the node carries one (carcode / part-type id). */
  id: number | null;
};

/**
 * Child nodes one level below `parentPath`.
 *
 * Keyed on the path having exactly ONE more comma segment than the parent, so
 * a page's breadcrumbs (fewer segments) and its language variants (same
 * segments, different locale prefix) are both excluded. Anything else on the
 * page — CSS, images, cross-links — has no `/en/catalog/` prefix and never
 * enters.
 */
export function parseCatalogNodes(
  html: string | null | undefined,
  parentPath: string,
): CatalogNode[] {
  if (!html) return [];
  const parentDepth = parentPath.split(",").length;
  const out: CatalogNode[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/href=["'](\/en\/catalog\/[^"'#?]+)["']/gi)) {
    const path = decodeEntities(m[1]);
    const segs0 = path.split(",");
    // A child adds ONE segment, or TWO when the level carries an id: engines
    // append `{engine},{carcode}` and part types append `{type},{id}`. Checking
    // only +1 silently returned zero engines — the level this whole walk turns
    // on — while every other level worked, which is the kind of half-failure
    // that reads as "RockAuto doesn't have this vehicle".
    const depth = segs0.length;
    const endsWithId = /^\d+$/.test(segs0[segs0.length - 1]);
    const ok = depth === parentDepth + 1 || (depth === parentDepth + 2 && endsWithId);
    if (!ok) continue;
    // Must actually extend THIS parent, not a sibling branch.
    if (!path.toLowerCase().startsWith(parentPath.toLowerCase() + ",")) continue;
    if (seen.has(path)) continue;
    seen.add(path);

    const segs = path.split(",");
    const last = segs[segs.length - 1];
    // A trailing all-digits segment is an id (carcode or part-type), and the
    // NAME is then the segment before it.
    const isId = /^\d+$/.test(last);
    out.push({
      path,
      segment: (isId ? segs[segs.length - 2] : last).replace(/\+/g, " "),
      id: isId ? Number(last) : null,
    });
  }
  return out;
}

// ─── Engine selection ───────────────────────────────────────────────────────

/**
 * Pick the engine node matching this vehicle, or null.
 *
 * Null is a real answer and the caller must treat it as one. RockAuto lists
 * every engine offered in that model year ("2.0L L4 Turbocharged", "2.5L L4",
 * "3.6L V6" for the 2021 Acadia), and choosing the wrong one walks a whole
 * subtree of parts for a different powertrain — the same class of error as the
 * GLC63-for-GLC43 slug mis-resolution, which is why displacement must MATCH
 * rather than merely score.
 */
export function pickEngineNode(
  nodes: readonly CatalogNode[],
  vehicle: { displacementL?: number | null; cylinders?: number | null },
): CatalogNode | null {
  const disp = vehicle.displacementL;
  if (typeof disp !== "number" || !Number.isFinite(disp) || disp <= 0) return null;
  const want = disp.toFixed(1); // "3.6"

  const candidates = nodes.filter((n) => {
    const m = /(\d\.\d)\s*l\b/i.exec(n.segment);
    return m != null && m[1] === want;
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Same displacement, several configurations (e.g. 2.0L L4 vs 2.0L L4
  // Turbocharged). Cylinders disambiguate when we have them; otherwise a
  // guess between real alternatives is exactly what must not happen.
  const cyl = vehicle.cylinders;
  if (typeof cyl === "number" && cyl > 0) {
    const byCyl = candidates.filter((n) =>
      new RegExp(`\\b[vl|i]?${cyl}\\b`, "i").test(n.segment.replace(/\s+/g, "")),
    );
    if (byCyl.length === 1) return byCyl[0];
  }
  return null;
}

// ─── Role → catalogue location ──────────────────────────────────────────────

/**
 * Which category and part-type a role lives under, as RockAuto names them.
 *
 * Matched against the node's own segment text, most-specific first, exactly
 * like categoryHarvest's ROLE_CATEGORY_HINTS — and for the same reason: a
 * loose hint is worse than none. `partType` patterns are anchored tightly
 * because RockAuto publishes many near-miss types per category ("brake pad"
 * vs "brake pad retaining clip / spring" vs "rotor & brake pad kit").
 */
export const ROCKAUTO_ROLE_LOCATION: Readonly<
  Record<string, { category: RegExp[]; partType: RegExp[] }>
> = {
  front_brake_pad: { category: [/^brake & wheel hub$/], partType: [/^brake pad$/] },
  rear_brake_pad: { category: [/^brake & wheel hub$/], partType: [/^brake pad$/] },
  front_rotor: { category: [/^brake & wheel hub$/], partType: [/^rotor$/] },
  rear_rotor: { category: [/^brake & wheel hub$/], partType: [/^rotor$/] },
  oil_filter: { category: [/^engine$/], partType: [/^oil filter$/] },
  air_filter: {
    // RockAuto's canonical home for engine air filters is the "Fuel & Air"
    // top-level category — the 2021 Nautilus's "engine" category carries 40
    // part types and no air filter (live `air_filter:no_part_type`, Aug 2026).
    // "engine" stays as the fallback for older trees that file it there.
    category: [/^fuel & air$/, /^engine$/],
    partType: [/^air filter$/],
  },
  cabin_filter: {
    category: [/^heat & air conditioning$/, /^interior$/],
    partType: [/^cabin air filter$/],
  },
  spark_plug: { category: [/^ignition$/], partType: [/^spark plug$/] },
  battery: { category: [/^electrical$/], partType: [/^battery$/] },
  serpentine_belt: { category: [/^belt drive$/], partType: [/^serpentine belt$/, /^drive belt$/] },
};

/** First node whose segment matches any pattern, in pattern order. */
export function pickNodeByPatterns(
  nodes: readonly CatalogNode[],
  patterns: readonly RegExp[],
): CatalogNode | null {
  for (const re of patterns) {
    const hit = nodes.find((n) => re.test(n.segment.trim().toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

// ─── Positioned listings ────────────────────────────────────────────────────

export type PositionedListing = {
  manufacturer: string;
  partNumber: string;
  moreInfoUrl: string;
  /** front / rear when the page said so, else null. */
  position: "front" | "rear" | null;
  /** Verbatim qualifier the position came from, for audit. */
  positionText: string | null;
};

/** Position qualifiers RockAuto prints above listing groups, e.g. "Front",
 *  "Rear Left", "Front; FRONT & REAR Disc Brakes w/ ABS(J61)". */
const POSITION_MARKER = />\s*((?:Front|Rear)\b[^<]{0,70})</gi;
const LISTING_RE =
  /<span class="listing-final-manufacturer\s*"[^>]*>([\s\S]*?)<\/span>[\s\S]{0,400}?<span class="listing-final-partnumber[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]{0,600}?href="([^"]*moreinfo\.php\?[^"]*)"/g;

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** "Front; Cast Iron" → "front". Anything not starting with a side → null. */
export function classifyPositionText(text: string | null | undefined): "front" | "rear" | null {
  const t = String(text ?? "").trim().toLowerCase();
  if (/^front\b/.test(t)) return "front";
  if (/^rear\b/.test(t)) return "rear";
  return null;
}

/**
 * Listings on a part-type page, each tagged with the position group it sits under.
 *
 * WHY POSITION IS NOT OPTIONAL. RockAuto does not split front and rear into
 * separate part types — one "rotor" page carries both, grouped under text
 * qualifiers. Taking listings without that context would hand a REAR rotor to
 * the front role half the time, which is the present-but-wrong write the
 * pipeline forbids. So the association is positional: each listing inherits the
 * nearest position marker ABOVE it in document order, and a listing with no
 * marker above it gets `null` — which the caller must treat as "unusable for a
 * position-bearing role", never as "either side".
 */
export function parsePositionedListings(
  html: string | null | undefined,
): PositionedListing[] {
  if (!html) return [];
  try {
    // Marker offsets first, so each listing can find the nearest one above it.
    const markers: Array<{ at: number; text: string }> = [];
    POSITION_MARKER.lastIndex = 0;
    for (const m of html.matchAll(POSITION_MARKER)) {
      markers.push({ at: m.index ?? 0, text: stripTags(m[1]) });
    }

    const out: PositionedListing[] = [];
    const seen = new Set<string>();
    LISTING_RE.lastIndex = 0;
    for (const m of html.matchAll(LISTING_RE)) {
      const manufacturer = stripTags(m[1]);
      const partNumber = stripTags(m[2]);
      const moreInfoUrl = decodeEntities(m[3]);
      if (!manufacturer || !partNumber) continue;
      const key = `${manufacturer}|${partNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const at = m.index ?? 0;
      let marker: { at: number; text: string } | null = null;
      for (const k of markers) {
        if (k.at < at && (!marker || k.at > marker.at)) marker = k;
      }
      out.push({
        manufacturer,
        partNumber,
        moreInfoUrl: moreInfoUrl.startsWith("http") ? moreInfoUrl : `${BASE}${moreInfoUrl.replace(/^\/?/, "/")}`,
        position: classifyPositionText(marker?.text),
        positionText: marker?.text ?? null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** front_rotor → "front". Position-less roles → null. */
export function positionOfRoleKey(roleKey: string): "front" | "rear" | null {
  if (/^front[_-]|_front\b/.test(roleKey)) return "front";
  if (/^rear[_-]|_rear\b/.test(roleKey)) return "rear";
  return null;
}

// ─── Interchange corroboration ──────────────────────────────────────────────

export type InterchangeSet = {
  /** Brand of the aftermarket listing this set came from. */
  brand: string;
  /** Normalized OEM numbers that listing claims to replace. */
  numbers: readonly string[];
  /**
   * Verbatim forms, keyed by normalized. Clustering needs the normalized key;
   * the make FORMAT GATE needs the separators normalizing removes (Ford's
   * `M2GZ-1125-A` fails its own pattern as `M2GZ1125A`). Optional so existing
   * callers still type.
   */
  rawByNormalized?: Readonly<Record<string, string>>;
};

export type InterchangeCandidate = {
  oem: string;
  /** Verbatim form as some listing printed it, when any set supplied one.
   *  This is what the make format gate must see. Falls back to `oem`. */
  raw: string;
  /** Distinct BRANDS that listed this number. The evidence. */
  brandCount: number;
  brands: string[];
};

/**
 * Rank OEM numbers by how many INDEPENDENT BRANDS list them.
 *
 * This is the mechanism that makes a vehicle-keyed RockAuto walk safe under
 * THE LAW. Every listing here was reached by the vehicle, so each interchange
 * set is "OEM numbers this part replaces" for a part that fits this vehicle.
 * The vehicle's own number is therefore in EVERY such set; other vehicles'
 * numbers ride along only in the sets of brands whose casting happens to span
 * them.
 *
 * So brand count separates signal from contamination — and it is brand count,
 * not occurrence count, for the same reason the claim ledger counts families
 * rather than domains: one brand listing a number three times across three
 * SKUs is one voice, not three.
 *
 * Sorted most-corroborated first; ties broken lexicographically so the result
 * is deterministic and a caller taking the top N gets a stable answer.
 */
export function rankInterchangeCandidates(
  sets: readonly InterchangeSet[],
): InterchangeCandidate[] {
  const brandsByOem = new Map<string, Set<string>>();
  const rawByOem = new Map<string, string>();
  for (const s of sets) {
    const brand = String(s.brand ?? "").trim().toUpperCase();
    if (!brand) continue;
    for (const num of s.numbers) {
      const oem = normalizeOemNumber(String(num ?? ""));
      if (oem.length < 5 || !/\d/.test(oem)) continue;
      const set = brandsByOem.get(oem) ?? new Set<string>();
      set.add(brand);
      brandsByOem.set(oem, set);
      // Prefer a verbatim form that carries separators — that is the one the
      // make format gate can actually accept.
      const supplied = s.rawByNormalized?.[oem];
      if (supplied && (!rawByOem.has(oem) || /[^A-Z0-9]/i.test(supplied))) {
        rawByOem.set(oem, supplied);
      }
    }
  }
  return [...brandsByOem.entries()]
    .map(([oem, brands]) => ({
      oem,
      raw: rawByOem.get(oem) ?? oem,
      brandCount: brands.size,
      brands: [...brands].sort(),
    }))
    .sort((a, b) => b.brandCount - a.brandCount || a.oem.localeCompare(b.oem));
}

/**
 * Minimum brands that must agree before a number is worth verifying.
 *
 * Two, not one. A single brand's interchange set is precisely the unfiltered
 * list THE LAW warns about, and feeding those to the fitment verifier one at a
 * time would spend the whole budget on other vehicles' numbers. Two independent
 * castings agreeing is cheap to require here because the walk yields a dozen
 * listings per part type.
 */
export const MIN_BRAND_CORROBORATION = 2;

/**
 * Is this OEM number from a family THIS manufacturer has been observed selling?
 *
 * The gate brand corroboration cannot provide. An interchange set is one
 * aftermarket part's list of the OEM numbers it replaces, and one filter
 * casting fits a Subaru AND a Kia — so every brand that makes that casting
 * lists BOTH makes' numbers, and all of them are equally corroborated. Live
 * Aug 2026: a Kia Sportage oil-filter walk ranked Subaru's 15208AA030 at
 * three-brand agreement.
 *
 * Shape does not separate them either. Subaru and Kia/Hyundai both number 5+5,
 * so `sanitizePartNumber("15208AA030", "Kia")` returns the number unchanged —
 * only GM's 8-digit format happens to reject it.
 *
 * What separates them is whether the manufacturer has ever been seen selling
 * something in that family, which `v3queries.getOemPrefixesForMake` reads off
 * parts already on file.
 *
 * An EMPTY vocabulary means "cannot judge" and returns false for everything —
 * the caller must decline rather than write. Failing open on a cold-start make
 * would reinstate exactly the hole this closes.
 */
export function isMakeAttestedNumber(
  oem: string,
  makePrefixes: readonly string[],
): boolean {
  if (makePrefixes.length === 0) return false;
  const n = makePrefixes[0].length;
  const key = String(oem ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, n);
  if (key.length < n) return false;
  return makePrefixes.some((p) => p.slice(0, n) === key);
}

// The hyphenation salvage lives with the gate it defers to — the write-path
// choke point (v3mutations.upsertPartAndFitment) needs it too, and a source
// adapter is the wrong module for mutations to depend on. Re-exported here so
// the rung callers and tests keep their import path.
export { hyphenationCandidates, salvageForMakeFormat } from "../contentSanitization";
