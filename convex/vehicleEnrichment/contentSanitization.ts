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
 */
const OEM_PART_PATTERNS: Record<string, RegExp> = {
  // BMW: 11-digit pattern (XX XX X XXX XXX)
  bmw: /^\d{2}\s?\d{2}\s?\d\s?\d{3}\s?\d{3}$/,
  // Mercedes: A + digits + dots (A XXX XXX XX XX)
  mercedes: /^A\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}$/i,
  // Toyota/Lexus: XXXXX-XXXXX pattern
  toyota: /^\d{5}-\d{5}$/,
  lexus: /^\d{5}-\d{5}$/,
  // Honda/Acura: XX-XXXXXXX or XXXXX-XXX-XXX
  honda: /^(?:\d{2}-\d{7}|\d{5}-[A-Z]{3}-[A-Z0-9]{3})$/i,
  acura: /^(?:\d{2}-\d{7}|\d{5}-[A-Z]{3}-[A-Z0-9]{3})$/i,
  // Ford/Lincoln: XX-XXXX-XX or various formats
  ford: /^[A-Z0-9]{2}-[A-Z0-9]{4,5}-[A-Z0-9]{1,2}$/i,
  // GM (Chevy/GMC/Cadillac/Buick): 8-digit ACDelco style
  chevrolet: /^(?:\d{7,8}|[A-Z]{2}\d{5,6})$/i,
  gmc: /^(?:\d{7,8}|[A-Z]{2}\d{5,6})$/i,
  cadillac: /^(?:\d{7,8}|[A-Z]{2}\d{5,6})$/i,
  // Hyundai/Kia: XXXXX-XXXXX
  hyundai: /^\d{5}-[A-Z0-9]{5}$/i,
  kia: /^\d{5}-[A-Z0-9]{5}$/i,
  // VW/Audi/Porsche: XXX XXX XXX X (with spaces or dashes)
  volkswagen: /^\d{3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?[A-Z0-9]$/i,
  audi: /^\d{3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?[A-Z0-9]$/i,
  porsche: /^\d{3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}$/i,
  // Subaru: various letter-digit combos
  subaru: /^[A-Z0-9]{5,12}$/i,
  // Nissan/Infiniti: XXXXX-XXXXX
  nissan: /^\d{5}-[A-Z0-9]{5}$/i,
  infiniti: /^\d{5}-[A-Z0-9]{5}$/i,
};

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
 * Returns the cleaned part number or null if it's hallucinated garbage.
 */
export function sanitizePartNumber(value: string, makeName?: string): string | null {
  const cleaned = normalizeWhitespace(stripHtml(stripMarkdown(unwrapValue(value))));

  if (cleaned.length === 0) return null;

  // Check make-specific pattern
  if (makeName) {
    const makeKey = makeName.toLowerCase().replace(/[-\s]/g, "");
    const pattern = OEM_PART_PATTERNS[makeKey];
    if (pattern && !pattern.test(cleaned)) {
      // Doesn't match make-specific pattern — but still might be valid
      // (aftermarket, superseded, etc.) — fall through to generic check
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
