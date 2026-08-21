// =============================================================================
// sourceAdapters/rockauto.ts — RockAuto part-number attestation.
//
// Family: aftermarket_catalog. This adapter is keyed by PART NUMBER: it answers
// "is 45022-T0A-A01 a real part, and what kind" exactly and deterministically.
//
// It used to say RockAuto "cannot answer 'what pad fits a 2016 CR-V' through a
// stable server-fetchable path". RE-PROBED LIVE Aug 2026, that is no longer
// true — the catalogue walks server-side through plain URLs, all levels 200 and
// unblocked. That walk lives in rockautoCatalog.ts and is wired as rung 3 of
// categoryHarvest; this file stays part-keyed on purpose, because confirming a
// number we hold and proposing one from a vehicle are different jobs with
// different evidence standards. Both are real, and neither replaces the other.
// It therefore consumes `AdapterVehicle.known_parts` and emits nothing without
// them — it corroborates numbers the pipeline already has, and never proposes
// new ones.
//
// WHY IT MATTERS HERE: every OEM part number in this pipeline currently comes
// from dealer storefronts, and resolveOperator collapses most of those to a
// couple of operators sharing one OEM catalogue upstream. RockAuto is an
// aftermarket retailer with an independent catalogue, so it is a genuinely
// separate voice on exactly the fields where we have none.
//
// FETCH PATH (verified live 2026-07-30 against Honda 45022-T0A-A01):
//
//   GET /en/partsearch/?partnum={number}   → 200, ~330KB, plain fetch, no token
//   listing block:
//     <span class="listing-final-manufacturer">WAGNER</span>
//     <span class="listing-final-partnumber" ...>EC1521</span>
//     <a href=".../moreinfo.php?pk=18739605&cc=0&pt=1684">Info</a>
//   GET /en/moreinfo.php?pk=…&cc=0&pt=…    → 200, ~29KB
//     <title>More Information for WAGNER EC1521</title>
//     "OEM / Interchange Numbers: 26296AL03A, 45022T0AA00, 45022T0AA01, …"
//
// The `_nck` token seen in browser URLs is NOT required — the bare pk/cc/pt
// form returns the same page, including the numbers hidden behind the page's
// "Show All" toggle (they are in the HTML, merely CSS-collapsed).
//
// ── THE LAW THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
//
// The "OEM / Interchange Numbers" list belongs to ONE AFTERMARKET PART. It is
// Wagner's list of OEM numbers that Wagner's EC1521 pad replaces. It is NOT a
// set of numbers that are interchangeable ON A GIVEN VEHICLE.
//
// The live list for the CR-V's front pad contains 26296AL03A — a SUBARU number
// — alongside Honda numbers spanning Odyssey, Pilot and Passport platforms.
// One Wagner pad shape serves all of them; the OEM parts are not equivalent.
//
// So: this adapter emits a claim ONLY for a number it was ASKED about, and
// only when that number appears in a real listing's interchange set. The other
// numbers in the list are captured as `interchange` metadata for supersession-
// aware PRICE SEARCH and are never emitted as claims, because a claim on a
// fitment field is a statement that the part belongs in that slot — and a
// Subaru pad does not belong in a Honda slot. Present-but-wrong is forbidden.
// =============================================================================

import type {
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";
import { normalizeOemNumber } from "../priceParser";
import { adapterFetch } from "./http";

const ADAPTER_NAME = "rockauto";
const BASE = "https://www.rockauto.com";
const SOURCE_DOMAIN = "rockauto.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20_000;
/** Politeness gap between requests. Two requests per part, so this dominates
 *  wall-clock; keep it above zero even though the host is fast. */
const REQUEST_DELAY_MS = 250;
/** Parts attested per run. Two requests each, so this bounds the whole call. */
const MAX_PARTS = 8;
/** Listings inspected per part before giving up on finding our number. */
const MAX_LISTINGS_PER_PART = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fields this adapter can attest — the OEM part-number slots. It attests
 *  whatever it is handed, so this list is the routing hint for byField(), not
 *  a hard filter. */
/** Verbatim PART_FIELD_MAP keys (v3pipeline.ts) — `rotor_front_oem`, NOT
 *  `front_rotor_oem`. A key that doesn't exist there routes to nothing and the
 *  adapter silently never runs for that slot. */
export const ROCKAUTO_FIELDS = [
  "oil_filter_oem",
  "drain_plug_gasket_oem",
  "air_filter_oem",
  "cabin_filter_oem",
  "spark_plug_oem",
  "front_brake_pad_oem",
  "rear_brake_pad_oem",
  "rotor_front_oem",
  "rotor_rear_oem",
  "serpentine_belt_oem",
  "timing_belt_oem",
  "wiper_blade_set_oem",
  "wiper_blade_rear_oem",
  "battery_oem",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers — string in, data out, NEVER throw (fail open).
// ─────────────────────────────────────────────────────────────────────────────

export type RockAutoListing = {
  manufacturer: string;
  partNumber: string;
  moreInfoUrl: string;
  /** RockAuto's part-type id from the moreinfo URL (`pt`), e.g. 1684. */
  partTypeId: number | null;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every result listing on a partsearch page.
 *
 * Anchored on the manufacturer/partnumber span pair that precedes each Info
 * link, so a page-layout change yields ZERO listings (and therefore no claims)
 * rather than mismatched pairs.
 */
export function parseSearchListings(
  html: string | null | undefined,
): RockAutoListing[] {
  try {
    if (!html) return [];
    const out: RockAutoListing[] = [];
    const seen = new Set<string>();
    const re =
      /<span class="listing-final-manufacturer\s*"[^>]*>([\s\S]*?)<\/span>[\s\S]{0,400}?<span class="listing-final-partnumber[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]{0,600}?href="([^"]*moreinfo\.php\?[^"]*)"/g;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      const manufacturer = stripTags(m[1]);
      const partNumber = stripTags(m[2]);
      const moreInfoUrl = decodeEntities(m[3]);
      if (!manufacturer || !partNumber) continue;
      if (seen.has(moreInfoUrl)) continue;
      seen.add(moreInfoUrl);
      const ptMatch = /[?&]pt=(\d+)/.exec(moreInfoUrl);
      out.push({
        manufacturer,
        partNumber,
        moreInfoUrl: moreInfoUrl.startsWith("http")
          ? moreInfoUrl
          : `${BASE}${moreInfoUrl.startsWith("/") ? "" : "/en/"}${moreInfoUrl}`,
        partTypeId: ptMatch ? Number(ptMatch[1]) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** True when the search page explicitly reported no results. Distinguishing
 *  "the site said No Parts" from "we failed to parse" is what makes this
 *  usable as an existence oracle at all — a parse failure must never be
 *  reported as absence. */
export function isNoPartsPage(html: string | null | undefined): boolean {
  if (!html) return false;
  // Live markup (2026-07-30) renders it as a nav label:
  //   <span class="navlabellink nvoffset nnormal">No Parts Found</span>
  // Matched as a whole tag-delimited phrase so the words appearing inside
  // unrelated prose cannot fabricate a negative verdict.
  return />\s*No Parts(\s+Found)?\s*</i.test(html);
}

/**
 * The "OEM / Interchange Numbers" set from a moreinfo page, NORMALIZED.
 *
 * The page renders the tail of the list inside a CSS-collapsed span behind a
 * "Show All" button; those numbers ARE in the HTML, so tags are stripped
 * before splitting and the full set is recovered.
 */
export function parseInterchangeNumbers(
  html: string | null | undefined,
): string[] {
  try {
    if (!html) return [];
    const m = /OEM\s*\/\s*Interchange\s*Numbers:\s*([\s\S]*?)<\/section>/i.exec(html);
    if (!m) return [];
    const text = stripTags(m[1])
      // Drop the toggle buttons' own label text.
      .replace(/\.\.\.\s*Show All/gi, " ")
      .replace(/Show Fewer/gi, " ");
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of text.split(/[,\s]+/)) {
      const n = normalizeOemNumber(raw);
      // A real OEM number is alphanumeric and substantial; this floor drops
      // stray words that survive tag-stripping.
      if (n.length < 5 || !/\d/.test(n)) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Interchange numbers WITH their verbatim form preserved.
 *
 * `parseInterchangeNumbers` above normalizes (uppercase, alphanumeric only),
 * which is right for CLUSTERING — "5Q0 698 451 A" and "5Q0698451A" must land
 * in one bucket. It is wrong for the FORMAT GATE, and the difference is not
 * cosmetic: several makes' patterns require the separators that normalizing
 * removes. Ford/Lincoln's is `^[A-Z0-9]{2,4}-[A-Z0-9]{1,7}(-[A-Z0-9]{1,4})?$`,
 * so a genuine `M2GZ-1125-A` arrives as `M2GZ1125A` and
 * `sanitizePartNumber(..., "Lincoln")` rejects it — every Ford-family
 * interchange number was unpassable by construction (observed live on the 2021
 * Nautilus: shape_ok=0 with a correct number in hand).
 *
 * So: cluster on `normalized`, gate on `raw`. Same discipline as the verbatim
 * string fields that survive parseField.
 */
export function parseInterchangeNumbersDetailed(
  html: string | null | undefined,
): Array<{ raw: string; normalized: string }> {
  try {
    if (!html) return [];
    const m = /OEM\s*\/\s*Interchange\s*Numbers:\s*([\s\S]*?)<\/section>/i.exec(html);
    if (!m) return [];
    const text = stripTags(m[1])
      .replace(/\.\.\.\s*Show All/gi, " ")
      .replace(/Show Fewer/gi, " ");
    const out: Array<{ raw: string; normalized: string }> = [];
    const seen = new Set<string>();
    // Split on whitespace/commas ONLY — hyphens and spaces inside a number are
    // part of it, which is the whole point of keeping the raw form.
    for (const rawTok of text.split(/[,\s]{1,}/)) {
      const raw = rawTok.trim().replace(/[.;:]+$/, "");
      if (!raw) continue;
      const normalized = normalizeOemNumber(raw);
      if (normalized.length < 5 || !/\d/.test(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push({ raw, normalized });
    }
    return out;
  } catch {
    return [];
  }
}

/** "More Information for WAGNER EC1521" → the verbatim product identity. */
export function parseMoreInfoTitle(html: string | null | undefined): string | null {
  try {
    if (!html) return null;
    const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
    if (!m) return null;
    const t = stripTags(m[1]).replace(/^More Information for\s*/i, "").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * RockAuto part-type id → our role key, for the component-identity check.
 *
 * DELIBERATELY SPARSE. Only ids confirmed against a live page belong here; an
 * unmapped id yields NO role signal, never a mismatch. A wrong entry would turn
 * a correct part into a refute, which is strictly worse than no check at all.
 */
export const ROCKAUTO_PART_TYPE_ROLES: Readonly<Record<number, string>> = {
  1684: "brake_pad", // verified live: Honda 45022-T0A-A01 → Wagner EC1521
};

export type RockAutoAttestation = {
  field_key: string;
  /** The number we asked about, normalized. */
  part_number: string;
  /** Product the number was found under, e.g. "WAGNER EC1521". */
  observed_product: string | null;
  /** RockAuto's part-type id for that listing. */
  part_type_id: number | null;
  /** Role implied by the part type, when confidently mapped. */
  implied_role: string | null;
  source_url: string;
  /**
   * The rest of the interchange set, normalized, EXCLUDING our own number.
   *
   * Supersession candidates for PRICE SEARCH only. These are numbers a single
   * aftermarket part replaces across many vehicles — including, in the live
   * CR-V case, a Subaru number — so they are never fitment-equivalent and must
   * never be written into a role slot.
   */
  interchange: string[];
};

/**
 * Turn one confirmed attestation into a Claim on the field the number fills.
 *
 * The claim's VALUE is our own number: this is corroboration of what the
 * pipeline already believes, from an independent operator. It is never a
 * proposal of a different number.
 */
export function attestationToClaim(
  a: RockAutoAttestation,
  observedAt: number,
): Claim {
  return {
    field_key: a.field_key,
    value: a.part_number,
    value_raw: a.part_number,
    source_family: "aftermarket_catalog",
    source_domain: SOURCE_DOMAIN,
    source_url: a.source_url,
    method: "deterministic_parse",
    observed_label: a.observed_product
      ? `OEM / Interchange Numbers on ${a.observed_product}`
      : "OEM / Interchange Numbers",
    observed_at: observedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch plumbing.
// ─────────────────────────────────────────────────────────────────────────────

type FetchOutcome = { status: number; body: string };

async function get(url: string): Promise<FetchOutcome> {
  const r = await adapterFetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    // No try/catch here originally — keep letting a dead host unwind to the
    // adapter's own entry-point handler.
    throwOnError: true,
  });
  return { status: r.status, body: r.body };
}

function looksBlocked(o: FetchOutcome): boolean {
  if (o.status === 403 || o.status === 429) return true;
  return /captcha|access denied|are you a robot|unusual traffic/i.test(
    o.body.slice(0, 3000),
  );
}

function fail(error: string, needsHeadless = false): AdapterResult {
  return {
    adapter: ADAPTER_NAME,
    ok: false,
    claims: [],
    ...(needsHeadless ? { needs_headless: true } : {}),
    error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attest as many of `known_parts` as the budget allows.
 *
 * Returns the raw attestations alongside the claims so a caller can use the
 * role and interchange data (component-identity check, supersession pricing)
 * without re-fetching.
 */
export async function attestParts(
  parts: readonly { field_key: string; part_number: string; role_key?: string | null }[],
  opts?: { maxParts?: number },
): Promise<{ attestations: RockAutoAttestation[]; errors: string[]; blocked: boolean }> {
  const attestations: RockAutoAttestation[] = [];
  const errors: string[] = [];
  const budget = Math.max(0, opts?.maxParts ?? MAX_PARTS);

  for (const part of parts.slice(0, budget)) {
    const wanted = normalizeOemNumber(part.part_number);
    if (wanted.length < 4) continue;

    try {
      await sleep(REQUEST_DELAY_MS);
      const search = await get(
        `${BASE}/en/partsearch/?partnum=${encodeURIComponent(part.part_number)}`,
      );
      if (looksBlocked(search)) {
        return { attestations, errors: [...errors, "blocked_at_search"], blocked: true };
      }
      if (search.status !== 200) {
        errors.push(`${part.field_key}:search_http_${search.status}`);
        continue;
      }
      if (isNoPartsPage(search.body)) {
        // The site positively reported no results. Recorded as a diagnostic,
        // NOT as a claim: a claim asserts a value, and "this number does not
        // resolve" is the absence of one. The existence gate is a separate
        // consumer that may read this.
        errors.push(`${part.field_key}:no_parts`);
        continue;
      }

      const listings = parseSearchListings(search.body);
      if (listings.length === 0) {
        errors.push(`${part.field_key}:no_listings_parsed`);
        continue;
      }

      let matched = false;
      for (const listing of listings.slice(0, MAX_LISTINGS_PER_PART)) {
        await sleep(REQUEST_DELAY_MS);
        const info = await get(listing.moreInfoUrl);
        if (looksBlocked(info)) {
          return {
            attestations,
            errors: [...errors, "blocked_at_moreinfo"],
            blocked: true,
          };
        }
        if (info.status !== 200) continue;

        const interchange = parseInterchangeNumbers(info.body);
        if (!interchange.includes(wanted)) continue;

        const ptId = listing.partTypeId;
        attestations.push({
          field_key: part.field_key,
          part_number: wanted,
          observed_product:
            parseMoreInfoTitle(info.body) ??
            `${listing.manufacturer} ${listing.partNumber}`.trim(),
          part_type_id: ptId,
          implied_role: ptId != null ? (ROCKAUTO_PART_TYPE_ROLES[ptId] ?? null) : null,
          source_url: listing.moreInfoUrl,
          interchange: interchange.filter((n) => n !== wanted),
        });
        matched = true;
        break;
      }
      if (!matched) errors.push(`${part.field_key}:not_in_interchange_sets`);
    } catch (e) {
      errors.push(
        `${part.field_key}:${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`,
      );
    }
  }

  return { attestations, errors, blocked: false };
}

async function lookupRockAuto(vehicle: AdapterVehicle): Promise<AdapterResult> {
  try {
    const known = vehicle.known_parts ?? [];
    if (known.length === 0) {
      // Not a failure: this adapter is part-keyed and simply had nothing to
      // attest. Emitting a vehicle-keyed guess instead is precisely what it
      // must never do.
      return {
        adapter: ADAPTER_NAME,
        ok: true,
        claims: [],
        error: "no known_parts supplied — part-number-keyed adapter is inert",
      };
    }

    const { attestations, errors, blocked } = await attestParts(known);
    if (blocked && attestations.length === 0) {
      return fail(`blocked: ${errors.join(", ").slice(0, 200)}`);
    }

    const observedAt = Date.now();
    const claims = attestations.map((a) => attestationToClaim(a, observedAt));
    return {
      adapter: ADAPTER_NAME,
      ok: true,
      claims,
      ...(errors.length > 0 ? { error: errors.slice(0, 12).join("; ").slice(0, 300) } : {}),
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const rockautoAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aftermarket_catalog",
  fields: ROCKAUTO_FIELDS,
  lookup: lookupRockAuto,
};
