/**
 * vehicleEnrichment/contentSanitization.ts — Task 17: Content Sanitization
 *
 * Post-processing filter for enriched text fields. Strips HTML artifacts,
 * markdown formatting, hallucinated part numbers, and other garbage from
 * Haiku responses before data reaches the database.
 *
 * Pure string processing — zero LLM cost. Applied inline to every value
 * flowing through asString() / asNumber() in the pipeline.
 *
 * Common Haiku failure modes caught:
 *   - HTML tags: <br>, <p>, &amp;, &nbsp;
 *   - Markdown: **bold**, `code`, [links](url), ### headers
 *   - Preamble text: "The oil capacity is 5.7 quarts" → "5.7"
 *   - Units in numbers: "5.7 quarts", "32 psi", "100 ft-lbs"
 *   - Hallucinated part numbers: random alphanumeric that don't match OEM patterns
 *   - Whitespace: leading/trailing, double spaces, newlines
 *   - Quotes: smart quotes, backticks wrapping values
 *   - List artifacts: "- 0W-20" or "* 0W-20"
 */

// ─── HTML / Markdown Stripping ───────────────────────────────────

/** Strip HTML tags and entities */
function stripHtml(s: string): string {
  // Remove HTML tags
  let result = s.replace(/<[^>]*>/g, "");
  // Decode common HTML entities
  result = result
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#\d+;/g, ""); // numeric entities
  return result;
}

/** Strip markdown formatting */
function stripMarkdown(s: string): string {
  let result = s;
  // Bold/italic: **text** or *text* or __text__ or _text_
  result = result.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  result = result.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, "$1");
  // Links: [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Headers: ### text → text
  result = result.replace(/^#{1,6}\s*/gm, "");
  // List markers at start: - item or * item or 1. item
  result = result.replace(/^[\s]*[-*]\s+/gm, "");
  result = result.replace(/^[\s]*\d+\.\s+/gm, "");
  return result;
}

// ─── Whitespace Normalization ────────────────────────────────────

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Quote / Wrapper Removal ─────────────────────────────────────

/** Remove wrapping quotes, backticks, or parentheses around the entire value */
function unwrapValue(s: string): string {
  const trimmed = s.trim();
  // Backtick wrapping: `value`
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length > 2) {
    return trimmed.slice(1, -1).trim();
  }
  // Double-quote wrapping: "value"
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    return trimmed.slice(1, -1).trim();
  }
  // Smart quotes
  if ((trimmed.startsWith("\u201C") && trimmed.endsWith("\u201D")) ||
      (trimmed.startsWith("\u2018") && trimmed.endsWith("\u2019"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// ─── Numeric Extraction ──────────────────────────────────────────

/**
 * Common Haiku failure: returning "5.7 quarts" instead of 5.7.
 * Extract the leading number from a string that has units appended.
 */
const UNIT_SUFFIXES = /\s*(quarts?|qts?|liters?|L|ml|gallons?|gal|psi|ft[- ]?lbs?|mm|inches?|in|oz|CCA|amps?|volts?|V|miles?|months?|mo)\b.*$/i;

function extractNumericValue(s: string): string {
  const trimmed = s.trim();
  // If already a clean number, return as-is
  if (/^-?\d+\.?\d*$/.test(trimmed)) return trimmed;
  // Strip unit suffixes: "5.7 quarts" → "5.7"
  const withoutUnits = trimmed.replace(UNIT_SUFFIXES, "").trim();
  if (/^-?\d+\.?\d*$/.test(withoutUnits)) return withoutUnits;
  // Handle "approximately 5.7" or "about 5.7" or "~5.7"
  const approxMatch = withoutUnits.match(/(?:approximately|approx\.?|about|~|≈)\s*(-?\d+\.?\d*)/i);
  if (approxMatch) return approxMatch[1];
  return trimmed;
}

/**
 * For preamble removal: "The oil capacity is 5.7 quarts" → "5.7"
 * Only used when asNumber is called — strips English preamble before a number.
 */
function stripNumericPreamble(s: string): string {
  // Match: "The X is Y" or "X: Y" patterns where Y is a number
  const preambleMatch = s.match(/(?:^.*?(?:is|are|=|:)\s*)(-?\d+\.?\d*)/i);
  if (preambleMatch) return preambleMatch[1];
  // Match: just a number with possible surrounding text
  const numberMatch = s.match(/(-?\d+\.?\d*)/);
  if (numberMatch) return numberMatch[1];
  return s;
}

// ─── Part Number Validation ──────────────────────────────────────

/**
 * Known OEM part number patterns by manufacturer.
 * Rejects hallucinated random strings that don't match real formats.
 *
 * These are ENFORCING (see sanitizePartNumber): a value that fails its own
 * make's pattern is rejected. Patterns therefore lean permissive — they must
 * accept every legitimate format for the make (parts, fluids, chemicals),
 * because a false rejection silently loses a real part.
 */
const OEM_PART_PATTERNS: Record<string, RegExp> = {
  // BMW/Mini: 11-char (XX XX X XXX XXX) — newer numbers are ALPHANUMERIC after
  // the 4-digit group prefix (e.g. 64115A1BDB6), the old digits-only pattern
  // rejected them.
  bmw: /^\d{2}[\s-]?\d{2}[\s-]?[0-9A-Z][\s-]?[0-9A-Z]{3}[\s-]?[0-9A-Z]{3}$/i,
  mini: /^\d{2}[\s-]?\d{2}[\s-]?[0-9A-Z][\s-]?[0-9A-Z]{3}[\s-]?[0-9A-Z]{3}$/i,
  // Mercedes: (A) XXX XXX XX XX, optional variant/color suffix block. The A
  // prefix is sometimes dropped in listings.
  mercedes: /^A?[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:[\s-]?[0-9A-Z]{2,6})?$/i,
  mercedesbenz: /^A?[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:[\s-]?[0-9A-Z]{2,6})?$/i,
  // Toyota/Lexus: XXXXX-XXXXX — second block is alphanumeric (90915-YZZF2,
  // 00272-SLLC2); digits-only rejected most filters and chemicals.
  toyota: /^\d{5}-[A-Z0-9]{4,6}$/i,
  lexus: /^\d{5}-[A-Z0-9]{4,6}$/i,
  // Honda/Acura: XXXXX-XXX-XXX parts, XXXXX-XXXX fluids/chemicals (08798-9080),
  // OL999-style accessories.
  honda: /^(?:\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3,4}|\d{5}-\d{4}|[A-Z]{2}\d{3}-\d{4})$/i,
  acura: /^(?:\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3,4}|\d{5}-\d{4}|[A-Z]{2}\d{3}-\d{4})$/i,
  // Ford/Lincoln: OE service numbers (BC3Z-6731-B / F1TZ-...) and Motorcraft
  // lines (BXT-94RH7-730, FL-820-S, SP-515).
  ford: /^[A-Z0-9]{2,4}-[A-Z0-9]{2,7}(?:-[A-Z0-9]{1,4})?$/i,
  lincoln: /^[A-Z0-9]{2,4}-[A-Z0-9]{2,7}(?:-[A-Z0-9]{1,4})?$/i,
  // GM (Chevy/GMC/Cadillac/Buick): 7-9 digit part numbers + ACDelco codes
  // (PF64, TS10083, 12345678).
  chevrolet: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?)$/i,
  gmc: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?)$/i,
  cadillac: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?)$/i,
  buick: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?)$/i,
  // Hyundai/Kia/Genesis: XXXXX-XXXXX
  hyundai: /^\d{5}-?[A-Z0-9]{5}$/i,
  kia: /^\d{5}-?[A-Z0-9]{5}$/i,
  genesis: /^\d{5}-?[A-Z0-9]{5}$/i,
  // VW/Audi/Porsche (VAG): AAA BBB CCC (+ up to 2-char suffix), first block
  // alphanumeric (06L115562B); old pattern required a digits-only first block.
  volkswagen: /^[0-9A-Z]{3}[\s-]?\d{3}[\s-]?\d{3}(?:[\s-]?[A-Z0-9]{1,2})?$/i,
  audi: /^[0-9A-Z]{3}[\s-]?\d{3}[\s-]?\d{3}(?:[\s-]?[A-Z0-9]{1,2})?$/i,
  porsche: /^[0-9A-Z]{3}[\s-]?\d{3}[\s-]?\d{3}(?:[\s-]?[A-Z0-9]{1,2})?$/i,
  // Subaru: various letter-digit combos (deliberately broad)
  subaru: /^[A-Z0-9]{5,12}$/i,
  // Nissan/Infiniti: XXXXX-XXXXX
  nissan: /^\d{5}-?[A-Z0-9]{5}$/i,
  infiniti: /^\d{5}-?[A-Z0-9]{5}$/i,
  // Mopar family (Chrysler/Dodge/Jeep/Ram/Fiat/Alfa Romeo): 8 digits + 2-letter
  // revision (68400577AA), legacy 0-prefixed (04884899AC), and alphanumeric
  // bodies with revision suffix (BB0H8800AC).
  chrysler: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  dodge: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  jeep: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  ram: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  fiat: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  alfaromeo: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  // Mazda: XXXX-XX-XXX(+suffix), e.g. PE01-14-302A
  mazda: /^[A-Z0-9]{4,5}-?\d{2}-?\d{3}[A-Z0-9]{0,2}$/i,
  // Volvo: 8-digit
  volvo: /^\d{7,8}$/,
  // Land Rover: LR-prefixed 6-digit
  landrover: /^LR\d{6}$/i,
};

// ─── Cross-make brand signatures ─────────────────────────────────
//
// Formats distinctive enough that a match strongly implies WHICH manufacturer
// family the number belongs to. Used to reject a part number extracted for the
// wrong marque — e.g. Motorcraft batteries (BXT-94RH7-730) extracted for a
// 2024 Alfa Romeo Stelvio because retailer "fits your car" pages entered the
// scrape corpus. These parts may physically fit, but Otopair is OEM-only and
// the pipeline would stamp them with the VEHICLE's make_id, blinding the
// read-time make guard.

const FORD_FAMILY = new Set(["ford", "lincoln", "mercury", "motorcraft"]);
const MOPAR_FAMILY = new Set(["chrysler", "dodge", "jeep", "ram", "fiat", "alfaromeo", "mopar"]);
const VAG_FAMILY = new Set(["volkswagen", "audi", "porsche", "vw", "seat", "skoda", "bentley", "lamborghini"]);
const BMW_FAMILY = new Set(["bmw", "mini", "rollsroyce"]);
// Makes whose numbering can produce XXXXX-XXXX(X) — includes Honda/Acura,
// whose fluid/chemical SKUs (08200-9008, 08798-9080) share the shape even
// though their hard-part format is 5-3-3. Without them here, a genuine Honda
// fluid reads as a foreign signature on a Honda config (observed in the
// Jul 2026 quarantine dry-run: 2 false positives on Acura).
const ASIAN_5_5_FAMILY = new Set([
  "toyota", "lexus", "scion",
  "hyundai", "kia", "genesis",
  "nissan", "infiniti",
  "mitsubishi", "suzuki",
  "honda", "acura",
]);
const HONDA_FAMILY = new Set(["honda", "acura"]);
const MERCEDES_FAMILY = new Set(["mercedes", "mercedesbenz", "maybach", "smart"]);

// Corporate part-sharing families: brands whose OEM catalogs genuinely share
// part numbers across marques (a 5Q0-prefix MQB part fits VW Golf and Audi A3
// alike; Mopar numbers span Jeep/Alfa/Fiat). A part stamped with a sibling
// brand's make_id is NOT cross-make contamination — the stamp merely records
// which vehicle was enriched first. Write-time guards and the quarantine
// backfill treat same-family as compatible; the strict read-time I1 guard is
// intentionally left as-is (product decision).
const CORPORATE_FAMILIES: Array<Set<string>> = [
  FORD_FAMILY,
  MOPAR_FAMILY,
  VAG_FAMILY,
  BMW_FAMILY,
  HONDA_FAMILY,
  MERCEDES_FAMILY,
  new Set(["toyota", "lexus", "scion"]),
  new Set(["nissan", "infiniti"]),
  new Set(["hyundai", "kia", "genesis"]),
  new Set(["chevrolet", "gmc", "cadillac", "buick", "pontiac", "saturn", "hummer"]),
  new Set(["jaguar", "landrover", "rangerover"]),
];

const makeKeyOf = (name: string) => name.toLowerCase().replace(/[-\s]/g, "");

/** True when two make NAMES belong to the same corporate part-sharing family
 *  (or are the same make). */
export function makesSameFamily(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const ka = makeKeyOf(a);
  const kb = makeKeyOf(b);
  if (ka === kb) return true;
  return CORPORATE_FAMILIES.some((fam) => fam.has(ka) && fam.has(kb));
}

type BrandSignature = { label: string; pattern: RegExp; makes: Set<string> };

const BRAND_SIGNATURES: BrandSignature[] = [
  // Motorcraft product lines: batteries (BXT/BAGM), filters (FL/FA/FP/EFL),
  // plugs/electrical (SP/DG/DY/SW). Unambiguously Ford-family.
  {
    label: "motorcraft",
    pattern: /^(?:BXT|BAGM|BHAGM|FL|FA|FP|EFL|SP|DG|DY|SW|KC|GG)-[A-Z0-9-]{2,}$/i,
    makes: FORD_FAMILY,
  },
  // Ford OE service numbers: 4-char engineering prefix ending in Z
  // (BC3Z-6731-B, F1TZ-...).
  {
    label: "ford_oe",
    pattern: /^[A-Z][A-Z0-9]{2}Z-[A-Z0-9]{4,7}(?:-[A-Z0-9]{1,4})?$/i,
    makes: FORD_FAMILY,
  },
  // Mercedes A-prefix: A XXX XXX XX XX
  {
    label: "mercedes_a",
    pattern: /^A[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:[\s-]?[0-9A-Z]{2,6})?$/i,
    makes: MERCEDES_FAMILY,
  },
  // Asian 5-5: XXXXX-XXXXX (shared by Toyota/Lexus, Hyundai/Kia, Nissan/Infiniti)
  {
    label: "asian_5_5",
    pattern: /^\d{5}-[A-Z0-9]{4,6}$/i,
    makes: ASIAN_5_5_FAMILY,
  },
  // Honda 5-3-3: XXXXX-XXX-XXX
  {
    label: "honda_5_3_3",
    pattern: /^\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3,4}$/i,
    makes: HONDA_FAMILY,
  },
  // VAG separated triple: AAA-BBB-CCC(-S)
  {
    label: "vag",
    pattern: /^[0-9A-Z]{3}[\s-]\d{3}[\s-]\d{3}(?:[\s-][A-Z0-9]{1,2})?$/i,
    makes: VAG_FAMILY,
  },
  // Mopar: 8 digits + 2-letter revision (68400577AA)
  {
    label: "mopar",
    pattern: /^\d{8}[A-Z]{2}$/i,
    makes: MOPAR_FAMILY,
  },
];

/**
 * Does this part number match a brand signature belonging to a DIFFERENT
 * manufacturer family than `makeName`? Returns the offending signature label,
 * or null when the number carries no foreign signature.
 *
 * Exported so booking-time selection can apply the same check as a read-time
 * backstop against already-written contamination.
 */
export function matchesForeignBrandSignature(
  partNumber: string,
  makeName: string | null | undefined,
): string | null {
  if (!makeName) return null;
  const makeKey = makeName.toLowerCase().replace(/[-\s]/g, "");
  for (const sig of BRAND_SIGNATURES) {
    if (!sig.makes.has(makeKey) && sig.pattern.test(partNumber.trim())) {
      // Foreign signature — but if the number ALSO satisfies the target
      // make's own format, formats overlap and we can't conclude anything.
      const own = OEM_PART_PATTERNS[makeKey];
      if (own && own.test(partNumber.trim())) continue;
      return sig.label;
    }
  }
  return null;
}

/**
 * Generic part number validation (when make-specific pattern isn't available).
 * Rejects values that are clearly not part numbers.
 */
function isPlausiblePartNumber(value: string): boolean {
  const trimmed = value.trim();

  // Too short or too long
  if (trimmed.length < 4 || trimmed.length > 30) return false;

  // Pure English words (no digits) → not a part number
  if (/^[a-zA-Z\s]+$/.test(trimmed)) return false;

  // Sentences or descriptions → not a part number
  if (trimmed.includes(".") && /[a-zA-Z]{4,}/.test(trimmed)) return false;
  if (trimmed.split(" ").length > 4) return false;

  // URLs → definitely not
  if (trimmed.startsWith("http") || trimmed.includes("www.")) return false;

  // Must have at least some alphanumeric characters
  if (!/[A-Z0-9]/i.test(trimmed)) return false;

  return true;
}

/**
 * Validate a part number against known OEM patterns.
 * Returns the cleaned part number or null if it's hallucinated garbage,
 * carries another manufacturer's brand signature, or fails its own make's
 * format. Rejections are logged so they can be triaged (a rejection means the
 * field is simply not written — enrichment continues).
 */
export function sanitizePartNumber(value: string, makeName?: string): string | null {
  const cleaned = normalizeWhitespace(stripHtml(stripMarkdown(unwrapValue(value))));

  if (cleaned.length === 0) return null;

  if (makeName) {
    // Cross-make signature check FIRST — works even for makes we have no
    // pattern for (the Stelvio case: Motorcraft BXT-94RH7-730 extracted for
    // Alfa Romeo from a retailer "fits your car" page).
    const foreign = matchesForeignBrandSignature(cleaned, makeName);
    if (foreign) {
      console.log(
        `[sanitize] REJECTED cross-make part number "${cleaned}" for make=${makeName}: matches ${foreign} format`,
      );
      return null;
    }

    // Enforce the make's own format when we have one. Previously this branch
    // deliberately fell through (the BMW pattern was too strict), which let
    // wrong-make and hallucinated numbers into oem_parts; the patterns above
    // have been widened to cover real formats, so a miss now rejects.
    const makeKey = makeName.toLowerCase().replace(/[-\s]/g, "");
    const pattern = OEM_PART_PATTERNS[makeKey];
    if (pattern && !pattern.test(cleaned)) {
      console.log(
        `[sanitize] REJECTED part number "${cleaned}" for make=${makeName}: fails ${makeKey} format`,
      );
      return null;
    }
  }

  // Generic plausibility check
  if (!isPlausiblePartNumber(cleaned)) return null;

  return cleaned;
}

// ─── Main Sanitizers (exported) ──────────────────────────────────

/**
 * Sanitize a string value from Haiku enrichment response.
 * Strips HTML, markdown, normalizes whitespace, unwraps quotes.
 * Returns undefined if the result is empty or garbage.
 */
export function sanitizeString(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;

  let s: string;
  if (typeof val === "string") {
    s = val;
  } else if (typeof val === "number" && val !== 0) {
    return String(val);
  } else {
    return undefined;
  }

  if (s.length === 0) return undefined;

  // Pipeline: HTML → Markdown → Unwrap → Whitespace
  s = stripHtml(s);
  s = stripMarkdown(s);
  s = unwrapValue(s);
  s = normalizeWhitespace(s);

  // Reject if empty after cleaning
  if (s.length === 0) return undefined;

  // Reject common Haiku non-answers
  const lower = s.toLowerCase();
  if (
    lower === "n/a" ||
    lower === "na" ||
    lower === "none" ||
    lower === "not available" ||
    lower === "not applicable" ||
    lower === "unknown" ||
    lower === "varies" ||
    lower === "see manual" ||
    lower === "check manual" ||
    lower === "consult dealer" ||
    lower === "null" ||
    lower === "undefined"
  ) {
    return undefined;
  }

  return s;
}

/**
 * Sanitize a numeric value from Haiku enrichment response.
 * Handles "5.7 quarts", "The oil capacity is 5.7", markdown/HTML wrapping.
 * Returns undefined if no valid number can be extracted.
 */
export function sanitizeNumber(val: unknown): number | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "number") {
    if (val === 0 || !isFinite(val)) return undefined;
    return val;
  }
  if (typeof val !== "string") return undefined;

  let s = val;
  // Clean formatting
  s = stripHtml(s);
  s = stripMarkdown(s);
  s = unwrapValue(s);
  s = normalizeWhitespace(s);

  if (s.length === 0) return undefined;

  // Try extracting a number from preamble/unit-laden text
  s = extractNumericValue(s);
  s = stripNumericPreamble(s);

  const n = parseFloat(s);
  if (isNaN(n) || n === 0 || !isFinite(n)) return undefined;
  return n;
}

/**
 * Sanitize a source URL. Strips markdown link syntax, validates URL format.
 */
export function sanitizeUrl(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val !== "string") return undefined;

  let s = val.trim();

  // Extract URL from markdown link: [text](url)
  const mdLink = s.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
  if (mdLink) s = mdLink[1];

  // Extract URL from angle brackets: <url>
  const angleBracket = s.match(/<(https?:\/\/[^>]+)>/);
  if (angleBracket) s = angleBracket[1];

  // Validate it looks like a URL
  try {
    const url = new URL(s);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return s;
    }
  } catch {
    // Not a valid URL
  }

  return undefined;
}
