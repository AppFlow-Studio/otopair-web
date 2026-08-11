// =============================================================================
// sourceAdapters/tricoWipers.ts — TRICO wiper-size adapter.
//
// Family: aftermarket_catalog. Supplies front_wiper_size / rear_wiper_size
// (both in V4_FIELD_KEYS), normalized as whole-inch strings ("26") — the same
// shape the pipeline stores today (v3pipeline parseFloat()s them into
// wiper_blade_driver_size_in / wiper_blade_rear_size_in).
//
// FETCH PATH (verified live 2026-07-30 against 2020 Toyota Camry, 2020 Toyota
// RAV4, 2019 Ford F-150, 2020 Ford Escape, 1998 Honda Civic):
// tricoproducts.com is a Magento 2 store whose lookup (/trico_lookup — the
// retailer skins /lordco_lookup and /discounttire_lookup are the SAME finder,
// id 9) is the Amasty Product Finder module:
//
//   1. GET  /trico_lookup                      → Make <select> (dropdown 35)
//                                                is server-rendered in the page.
//   2. POST /amfinder/index/options/           → next dropdown's <option> HTML.
//        dropdown_id={36|37}&parent_id={selected}&use_saved_values=0
//        &parent_dropdown_id={35|36}            (35=Make, 36=Year, 37=Model —
//                                                params lifted from the site's
//                                                own amfinder.min.js)
//   3. GET  /landing-result?find={make}-{year}-{model}-{modelId}
//           &landing_page_url=trico_lookup     → full fitment result page.
//      The find slug is lowercase-hyphenated labels + the MODEL option id
//      (reproduces the server's own 302 from /amfinder/index/search/; slug
//      format verified for multiword models: toyota-2020-gr-supra-…).
//      No cookies or form_key needed for any of the three requests.
//
// SIZE EXTRACTION (present-but-wrong is forbidden — two signal classes only):
//
//   FRONT — the twin-set tooltips carry an EXPLICIT verbatim size note:
//     "Note: this is a 26'' and 20''  9 x 3 Hook Beam Wiper Blade Set"
//     Driver side is listed first (matches the driver/passenger part pair,
//     e.g. 91-260/91-200) and front_wiper_size is the DRIVER size — the same
//     convention as the stored field (→ wiper_blade_driver_size_in). A claim
//     is emitted ONLY when every set note on the page agrees on the driver
//     size; pages that mix trims/bodies with different driver sizes emit
//     nothing.
//
//   REAR — no explicit inch text exists, but every "Position: Rear" tooltip
//     carries the part number, and TRICO's rear numbering encodes length:
//       12-A / 11-G / 13-N   (Exact-Fit rear: leading digits = inches)
//       55-110 / 55-121      (TRICO Rear beam: 55-NNx, NN = inches)
//       91-150 / 24-140DTSC  (blade lines: -NN0 suffix = inches)
//     Decode rules validated live: 2020 RAV4 rear 12-A + 55-121 → 12 (both);
//     2020 Escape rear 11-G + 55-110 → 11 (both). A claim is emitted ONLY
//     when every DECODABLE rear part agrees on one length (undecodable SKUs
//     — arms, washer parts — carry no length signal and are ignored). The
//     1998 Civic multi-body page (13'' vs 15'' rear parts) correctly emits
//     nothing under this rule.
//
// Vehicles without a rear wiper (Camry, F-150) simply have no Position: Rear
// blocks → no rear claim; body-class applicability rules own the null.
// =============================================================================

import type {
  AdapterResult,
  AdapterVehicle,
  Claim,
  SourceAdapter,
} from "./types";
import { adapterFetch } from "./http";

const ADAPTER_NAME = "trico_wipers";
const HOST = "www.tricoproducts.com";
const SOURCE_DOMAIN = "tricoproducts.com";
const BASE = `https://${HOST}`;
const LOOKUP_URL = `${BASE}/trico_lookup`;
const OPTIONS_URL = `${BASE}/amfinder/index/options/`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Amasty finder 9 dropdown ids, read off the live /trico_lookup form.
const DROPDOWN_MAKE = 35;
const DROPDOWN_YEAR = 36;
const DROPDOWN_MODEL = 37;

export const TRICO_WIPER_FIELDS: readonly string[] = [
  "front_wiper_size",
  "rear_wiper_size",
];

// Plausible blade lengths in inches — a decode outside these is treated as
// not-a-size and discarded rather than emitted.
const FRONT_MIN_IN = 12;
const FRONT_MAX_IN = 32;
const REAR_MIN_IN = 6;
const REAR_MAX_IN = 22;

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers — string in, structures out, NEVER throw (fail open).
// ─────────────────────────────────────────────────────────────────────────────

export type FinderOption = { id: string; label: string };

/**
 * Parse Amasty finder <option> elements (from the /trico_lookup page's Make
 * select or an /amfinder/index/options/ response). Option ids are the 9-digit
 * catalog node ids; the {6,12} floor keeps page furniture (brand filter values
 * like "3609") out when parsing the whole lookup page. Malformed → [].
 */
export function parseFinderOptions(html: string): FinderOption[] {
  try {
    if (typeof html !== "string" || html === "") return [];
    const out: FinderOption[] = [];
    const re = /<option[^>]*value="(\d{6,12})"[^>]*>\s*([^<]*?)\s*<\/option>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const label = m[2].replace(/\s+/g, " ").trim();
      if (label !== "") out.push({ id: m[1], label });
    }
    return out;
  } catch {
    return [];
  }
}

/** Decode a TRICO rear-blade part number to its length in inches, or null
 *  when the SKU carries no length signal (arms, washer SKUs, kits) or the
 *  decode is outside plausible rear-blade range (a 47-700 rear ARM would
 *  "decode" to 70 — the range gate rejects it). */
export function decodeRearPartInches(part: string): number | null {
  const p = (part ?? "").trim().toUpperCase();
  let inches: number | null = null;
  // TRICO Rear beam series: 55-NNx → NN inches (55-110 → 11, 55-121 → 12).
  let m = /^55-(\d{2})\d$/.exec(p);
  if (m) inches = Number(m[1]);
  // Exact-Fit rear: leading digits are the length (12-A, 11-G, 13-N, 14-B).
  if (inches === null) {
    m = /^(\d{1,2})-[A-Z]{1,3}$/.exec(p);
    if (m) inches = Number(m[1]);
  }
  // Blade lines used in rear position: line-NN0[suffix] → NN inches
  // (91-150 → 15, 24-140DTSC → 14). Kits like 18-2616-12K do not match.
  if (inches === null) {
    m = /^\d{2}-(\d{2})0(?:[A-Z]{1,6})?$/.exec(p);
    if (m) inches = Number(m[1]);
  }
  if (inches === null || inches < REAR_MIN_IN || inches > REAR_MAX_IN) {
    return null;
  }
  return inches;
}

/** One "this is a NN'' and MM'' …" twin-set note: [driver, passenger, raw]. */
const SET_NOTE_RE = /this is a (\d{1,2})''\s*and\s*(\d{1,2})''[^<]*/g;

/** One "Position: Rear" tooltip block up to its part number. Bounded lazy so
 *  a malformed block can never swallow a distant product's part number. The
 *  anchor is the exact <p> — "Position: Front and Rear" kits do not match. */
const REAR_BLOCK_RE =
  /<p>Position: Rear<\/p>([\s\S]{0,600}?)Part #: <b>([^<]{1,40})<\/b>/g;

/**
 * Parse a /landing-result fitment page into wiper-size Claims.
 *
 * front_wiper_size: unanimous driver-side inches across every explicit
 * twin-set size note. rear_wiper_size: unanimous decoded length across every
 * decodable "Position: Rear" part number. Any disagreement → that field is
 * skipped entirely. Malformed input → [].
 */
export function parseLandingResult(
  html: string,
  opts?: { source_url?: string; observed_at?: number },
): Claim[] {
  try {
    if (typeof html !== "string" || html === "") return [];
    const observedAt = opts?.observed_at ?? Date.now();
    const sourceUrl = opts?.source_url ?? `${BASE}/landing-result`;
    const claims: Claim[] = [];

    const stamp = {
      source_family: "aftermarket_catalog" as const,
      source_domain: SOURCE_DOMAIN,
      source_url: sourceUrl,
      method: "deterministic_parse" as const,
      observed_at: observedAt,
    };

    // ── FRONT: explicit twin-set size notes, driver side first ──
    const driverSizes = new Set<number>();
    let firstNote: { driver: string; raw: string } | null = null;
    let m: RegExpExecArray | null;
    SET_NOTE_RE.lastIndex = 0;
    while ((m = SET_NOTE_RE.exec(html)) !== null) {
      const driver = Number(m[1]);
      if (driver < FRONT_MIN_IN || driver > FRONT_MAX_IN) continue;
      driverSizes.add(driver);
      if (!firstNote) {
        firstNote = { driver: m[1], raw: m[0].replace(/\s+/g, " ").trim() };
      }
    }
    if (driverSizes.size === 1 && firstNote) {
      claims.push({
        field_key: "front_wiper_size",
        value: firstNote.driver,
        value_raw: `${firstNote.driver}''`,
        observed_label: firstNote.raw,
        ...stamp,
      });
    }

    // ── REAR: unanimous decode across Position: Rear part numbers ──
    const rearSizes = new Set<number>();
    const rearParts = new Set<string>();
    REAR_BLOCK_RE.lastIndex = 0;
    while ((m = REAR_BLOCK_RE.exec(html)) !== null) {
      const part = m[2].trim();
      const inches = decodeRearPartInches(part);
      if (inches === null) continue; // no length signal — ignore, don't veto
      rearSizes.add(inches);
      rearParts.add(part);
    }
    if (rearSizes.size === 1) {
      const [inches] = [...rearSizes];
      claims.push({
        field_key: "rear_wiper_size",
        value: String(inches),
        value_raw: [...rearParts].join(", "),
        observed_label: "Position: Rear",
        ...stamp,
      });
    }

    return claims;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch plumbing.
// ─────────────────────────────────────────────────────────────────────────────

/** Uppercase alphanumerics only — "F-150" ≡ "F150". Exact match ONLY:
 *  never guess a sibling model. */
function normName(s: string): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Lowercase-hyphen slug, matching the server's own find-URL segments
 *  ("GR Supra" → "gr-supra", "F-150" → "f-150"). */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type FetchOutcome = { status: number; body: string };

async function fetchPage(url: string): Promise<FetchOutcome> {
  const r = await adapterFetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeoutMs: 20_000,
    throwOnError: true,
  });
  return { status: r.status, body: r.body };
}

/** POST the Amasty options cascade endpoint; returns <option> HTML. */
async function fetchOptions(
  dropdownId: number,
  parentId: string,
  parentDropdownId: number,
): Promise<FetchOutcome> {
  const form = new URLSearchParams({
    dropdown_id: String(dropdownId),
    parent_id: parentId,
    use_saved_values: "0",
    parent_dropdown_id: String(parentDropdownId),
  });
  const res = await fetch(OPTIONS_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.text() };
}

/** Anti-bot detection — routes to the headless tier instead of failing hard. */
function looksBlocked(outcome: FetchOutcome): boolean {
  if (outcome.status === 403 || outcome.status === 429 || outcome.status === 503) {
    return true;
  }
  return /captcha|access denied|cloudflare|akamai|are you a robot/i.test(
    outcome.body.slice(0, 2000),
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

/** Successful lookup that found nothing to claim — diagnostic preserved. */
function empty(note: string): AdapterResult {
  return { adapter: ADAPTER_NAME, ok: true, claims: [], error: note };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter.
// ─────────────────────────────────────────────────────────────────────────────

async function lookupTricoWipers(
  vehicle: AdapterVehicle,
): Promise<AdapterResult> {
  try {
    // 1) Lookup page — the Make dropdown (35) is server-rendered. Anchor on
    //    the dropdown-35 select so nothing else on the page can leak in.
    const page = await fetchPage(LOOKUP_URL);
    if (looksBlocked(page)) {
      return fail(`blocked at lookup page (HTTP ${page.status})`, true);
    }
    if (page.status !== 200) {
      return fail(`lookup page HTTP ${page.status}`);
    }
    const makeAnchor = page.body.indexOf(`data-dropdown-id="${DROPDOWN_MAKE}"`);
    const makeEnd = page.body.indexOf("</select>", makeAnchor);
    if (makeAnchor < 0 || makeEnd < 0) {
      return fail("make dropdown not found on lookup page — layout changed?");
    }
    const makes = parseFinderOptions(page.body.slice(makeAnchor, makeEnd));
    const make = makes.find((o) => normName(o.label) === normName(vehicle.make));
    if (!make) {
      return empty(`make "${vehicle.make}" not in TRICO catalog`);
    }

    // 2) Years for make (dropdown 36) — labels are the plain year numbers.
    const yearsRes = await fetchOptions(DROPDOWN_YEAR, make.id, DROPDOWN_MAKE);
    if (looksBlocked(yearsRes)) {
      return fail(`blocked at year options (HTTP ${yearsRes.status})`, true);
    }
    const years = parseFinderOptions(yearsRes.body);
    const year = years.find((o) => o.label === String(vehicle.year));
    if (!year) {
      return empty(
        `year ${vehicle.year} not in TRICO catalog for ${make.label}`,
      );
    }

    // 3) Models for make+year (dropdown 37) — exact normalized match only.
    const modelsRes = await fetchOptions(DROPDOWN_MODEL, year.id, DROPDOWN_YEAR);
    if (looksBlocked(modelsRes)) {
      return fail(`blocked at model options (HTTP ${modelsRes.status})`, true);
    }
    const models = parseFinderOptions(modelsRes.body);
    const model = models.find(
      (o) => normName(o.label) === normName(vehicle.model),
    );
    if (!model) {
      return empty(
        `model "${vehicle.model}" not in TRICO catalog for ${vehicle.year} ${make.label}`,
      );
    }

    // 4) Fitment result page — the find slug reproduces the server's own
    //    redirect from /amfinder/index/search/.
    const find = `${slugify(make.label)}-${year.label}-${slugify(model.label)}-${model.id}`;
    const resultUrl = `${BASE}/landing-result?find=${find}&landing_page_url=trico_lookup`;
    const result = await fetchPage(resultUrl);
    if (looksBlocked(result)) {
      return fail(`blocked at landing-result (HTTP ${result.status})`, true);
    }
    if (result.status !== 200) {
      return fail(`landing-result HTTP ${result.status} for find=${find}`);
    }

    const claims = parseLandingResult(result.body, {
      source_url: resultUrl,
      observed_at: Date.now(),
    });
    if (claims.length === 0) {
      return empty(
        `no unambiguous wiper sizes for ${vehicle.year} ${make.label} ${model.label} (find=${find})`,
      );
    }
    return { adapter: ADAPTER_NAME, ok: true, claims };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const tricoWipersAdapter: SourceAdapter = {
  name: ADAPTER_NAME,
  family: "aftermarket_catalog",
  fields: TRICO_WIPER_FIELDS,
  lookup: lookupTricoWipers,
};
