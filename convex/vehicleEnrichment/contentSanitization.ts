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
import { makeKeyOf } from "../lib/makeKey";

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
  // Q-prefix accessory/chemical SKUs (Q 103 0004 wiper set) are real M-B
  // numbers the A-prefix pattern rejected (audit Jul 11 2026).
  mercedes: /^(?:A?[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:[\s-]?[0-9A-Z]{2,6})?|Q[\s-]?\d{3}[\s-]?\d{4})$/i,
  mercedesbenz: /^(?:A?[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?:[\s-]?[0-9A-Z]{2,6})?|Q[\s-]?\d{3}[\s-]?\d{4})$/i,
  // Toyota/Lexus: XXXXX-XXXXX — second block is alphanumeric (90915-YZZF2,
  // 00272-SLLC2); digits-only rejected most filters and chemicals.
  // Audit findings (Jul 11 2026): compact dashless 10-char form (9091602570)
  // — restricted to EXACTLY 5+5 so foreign 11-digit numbers can't slip in —
  // and chemical/kit SKUs with a dashed third block (00544-21171-325,
  // 00279-0WQTE-01, 00544-H8AGM-TS).
  toyota: /^\d{5}(?:-[A-Z0-9]{4,6}(?:-[A-Z0-9]{1,4})?|[A-Z0-9]{5})$/i,
  lexus: /^\d{5}(?:-[A-Z0-9]{4,6}(?:-[A-Z0-9]{1,4})?|[A-Z0-9]{5})$/i,
  // Honda/Acura: XXXXX-XXX-XXX parts, XXXXX-XXXX fluids/chemicals (08798-9080),
  // OL999-style accessories, NGK-sourced plug SKUs (9807B-5517W; audit Jul 11).
  // Audit findings (Aug 9 2026, CX-30 round-2 ledger replay): hardware 5-5
  // digits (94109-14000 drain washer), letter-tail chemical SKUs (08200-HCF2
  // CVT fluid, 08208-HST02, 08200-9008A), digit-led alnum first block with
  // 3-5 char tail (08CLA-P99-0F0A8 coolant, 08285-P99-0CZA3 PS fluid), and
  // OL999 tails with revision letters (OL999-9011A) were all real ledgered
  // SKUs the old digit-only tails rejected.
  // Round-3 (Aug 9 2026, RDX): AGM battery SKUs carry a 7-char third block
  // (31500-TZ7-AGM100M) — {3,5} rejected the RDX's real battery.
  honda: /^(?:\d[A-Z0-9]{4}-[A-Z0-9]{3}-[A-Z0-9]{3,7}|\d{5}-[A-Z0-9]{4,6}|[A-Z]{2}\d{3}-[A-Z0-9]{4,5}|\d{4}[A-Z]-\d{4}[A-Z]?)$/i,
  acura: /^(?:\d[A-Z0-9]{4}-[A-Z0-9]{3}-[A-Z0-9]{3,7}|\d{5}-[A-Z0-9]{4,6}|[A-Z]{2}\d{3}-[A-Z0-9]{4,5}|\d{4}[A-Z]-\d{4}[A-Z]?)$/i,
  // Ford/Lincoln: OE service numbers (BC3Z-6731-B / F1TZ-...) and Motorcraft
  // lines (BXT-94RH7-730, FL-820-S, SP-515).
  // Second block min 1 char — the XL-3 friction modifier is a real Motorcraft
  // SKU that the {2,7} minimum rejected (audit Jul 11 2026).
  ford: /^[A-Z0-9]{2,4}-[A-Z0-9]{1,7}(?:-[A-Z0-9]{1,4})?$/i,
  lincoln: /^[A-Z0-9]{2,4}-[A-Z0-9]{1,7}(?:-[A-Z0-9]{1,4})?$/i,
  // GM (Chevy/GMC/Cadillac/Buick): 7-9 digit part numbers + ACDelco codes
  // (PF64, TS10083, 12345678) + ACDelco fluid/chemical dash codes
  // (10-9243 Dex-Cool, 10-4133 ATF).
  // Audit findings (Jul 11 2026): digit-first ACDelco battery codes (94RAGM,
  // 48AGM) and 5-digit dash bodies (15-11125 cabin filter).
  // Audit findings (Aug 9 2026, Sierra round-2 ledger replay): ACDelco dash
  // codes with 3-digit first blocks and letter tails — 78-7YR battery,
  // 131-160 thermostat — were real ledgered SKUs the 2-digit-dash-3+ shape
  // rejected.
  chevrolet: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?|\d{2,3}[A-Z]{2,5}|\d{2,3}-\d{1,5}[A-Z]{0,2})$/i,
  gmc: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?|\d{2,3}[A-Z]{2,5}|\d{2,3}-\d{1,5}[A-Z]{0,2})$/i,
  cadillac: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?|\d{2,3}[A-Z]{2,5}|\d{2,3}-\d{1,5}[A-Z]{0,2})$/i,
  buick: /^(?:\d{7,9}|[A-Z]{1,3}\d{2,6}[A-Z]?|\d{2,3}[A-Z]{2,5}|\d{2,3}-\d{1,5}[A-Z]{0,2})$/i,
  // Hyundai/Kia/Genesis: XXXXX-XXXXX parts, plus chemical/accessory SKUs with
  // a third block or revision suffix (00232-FSYN5-30WAR engine oil,
  // 08950-00020-B gear oil) — the plain 5-5 pattern rejected every fluid SKU
  // (2015 Veloster Turbo, Jul 2026 — same failure class as the VAG G-numbers).
  // Suffix block requires its literal dash — with it optional, any bare
  // 11-digit string (a BMW number) parsed as 5+5+1 and slipped through.
  // First block is digit-led alphanumeric, not digits-only: Mobis accessory
  // SKUs like 2SF79-AQ000 cabin filter (2015 Veloster re-run, Jul 11 2026).
  // Audit findings (Aug 9 2026 ledger replay): LETTER-led Mobis accessory
  // blocks (S9C79-AC100 / S2C79-AC100 cabin filters) and UM-prefix genuine
  // fluid SKUs (UM020-CH263 coolant, UM022-CH080 oil, UM018-CH130 ATF —
  // dashless form UM020CH263 also seen). Letter-led branches REQUIRE either
  // the dash or a letter-letter prefix so a bare digit-led foreign number
  // can't slip through the widened shape.
  hyundai: /^(?:\d[A-Z0-9]{4}-?[A-Z0-9]{5}(?:-[A-Z0-9]{1,5})?|[A-Z]\d[A-Z0-9]{3}-[A-Z0-9]{5}(?:-[A-Z0-9]{1,5})?|[A-Z]{2}\d{3}-?[A-Z0-9]{5})$/i,
  kia: /^(?:\d[A-Z0-9]{4}-?[A-Z0-9]{5}(?:-[A-Z0-9]{1,5})?|[A-Z]\d[A-Z0-9]{3}-[A-Z0-9]{5}(?:-[A-Z0-9]{1,5})?|[A-Z]{2}\d{3}-?[A-Z0-9]{5})$/i,
  genesis: /^(?:\d[A-Z0-9]{4}-?[A-Z0-9]{5}(?:-[A-Z0-9]{1,5})?|[A-Z]\d[A-Z0-9]{3}-[A-Z0-9]{5}(?:-[A-Z0-9]{1,5})?|[A-Z]{2}\d{3}-?[A-Z0-9]{5})$/i,
  // VW/Audi/Porsche (VAG): AAA BBB CCC (+ up to 2-char suffix), first block
  // alphanumeric (06L115562B); old pattern required a digits-only first block.
  // Second alternation: VAG fluid/chemical G- and B-numbers — G + 3 digits +
  // 3 ALPHANUMERIC (G 012 A8G M1 coolant has letters in the third block) +
  // up to two 1-3 char suffix blocks (G 052 167 A2 oil, G 060 162 A2 ATF,
  // B 000 750 M3 brake fluid). This branch previously didn't exist, so EVERY
  // fluid SKU failed the 3-char first block and no fluid fitment was ever
  // written for VAG configs. TL-numbers (TL 774x) are spec designations, not
  // orderable SKUs — deliberately still rejected.
  // Third alternation: VAG standard-hardware N-numbers — N + 7-9 digits
  // (N0138157 drain plug gasket, N 908 132 02). Rejected live 2026-07-10.
  // First alternation's suffix widened to two 1-3 char groups: wiper SKUs
  // like 17B 955 425 A 03C carry index letter + revision (audit Jul 11 2026).
  volkswagen: /^(?:[0-9A-Z]{3}[\s-]?\d{3}[\s-]?\d{3}(?:[\s-]?[A-Z0-9]{1,3}){0,2}|[GB][\s-]?\d{3}[\s-]?[A-Z0-9]{3}(?:[\s-]?[A-Z0-9]{1,3}){0,2}|N[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{1,3})$/i,
  audi: /^(?:[0-9A-Z]{3}[\s-]?\d{3}[\s-]?\d{3}(?:[\s-]?[A-Z0-9]{1,3}){0,2}|[GB][\s-]?\d{3}[\s-]?[A-Z0-9]{3}(?:[\s-]?[A-Z0-9]{1,3}){0,2}|N[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{1,3})$/i,
  porsche: /^(?:[0-9A-Z]{3}[\s-]?\d{3}[\s-]?\d{3}(?:[\s-]?[A-Z0-9]{1,3}){0,2}|[GB][\s-]?\d{3}[\s-]?[A-Z0-9]{3}(?:[\s-]?[A-Z0-9]{1,3}){0,2}|N[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{1,3})$/i,
  // Subaru: various letter-digit combos (deliberately broad). The optional
  // dashed tail matters — Subaru's catalog prints 26296-AL03A and 15208-AA160,
  // and without it this pattern could not rescue its own make's numbers when
  // the signature matcher flagged them.
  subaru: /^[A-Z0-9]{5,12}(?:-[A-Z0-9]{3,6})?$/i,
  // Nissan/Infiniti: XXXXX-XXXXX + chemical/fluid SKUs whose first block mixes
  // letters and digits (999MP-A9001 ATF, KE908-99931 oil).
  // Audit findings (Jul 11 2026): brake-part first blocks letter+4digits
  // (D1060-9HE0B pads, D4060-9HU0A rotors), mixed blocks like 110D2-6CA0B,
  // 999M1-NBH5A, and 7-char chemical tails (999MP-L25500P, 999PK-000W20N).
  nissan: /^(?:\d{5}|[A-Z]\d{4}|\d{3}[A-Z]{2}|[A-Z]{2}\d{3}|\d{3}[A-Z]\d)-?[A-Z0-9]{5,7}$/i,
  infiniti: /^(?:\d{5}|[A-Z]\d{4}|\d{3}[A-Z]{2}|[A-Z]{2}\d{3}|\d{3}[A-Z]\d)-?[A-Z0-9]{5,7}$/i,
  // Mopar family (Chrysler/Dodge/Jeep/Ram/Fiat/Alfa Romeo): 8 digits + 2-letter
  // revision (68400577AA), legacy 0-prefixed (04884899AC), and alphanumeric
  // bodies with revision suffix (BB0H8800AC).
  chrysler: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  dodge: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  jeep: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  ram: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  fiat: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  alfaromeo: /^(?:0?\d{7,8}(?:[A-Z]{1,2})?|[A-Z0-9]{6,9}[A-Z]{2})$/i,
  // Mazda: XXXX-XX-XXX(+suffix), e.g. PE01-14-302A.
  // REWRITTEN Aug 9 2026 (CX-30/CX-5 round-2 post-mortem): the old
  // digits-only middle + 3-digit-led tail rejected SIX of the CX-30's real
  // core parts — DGY9-33-28Z / DGY6-26-43ZA pads, PAJ8-13-3A0A air filter,
  // BDGF-61-J6X cabin filter — and every Mazda chemical SKU, which carries an
  // alnum middle and a FOURTH block (0000-77-508F-20 FL22 coolant,
  // 0000-FZ-113E-01 ATF FZ). 46 ledgered rejections, 0 passing, worst make in
  // the fleet. Branch 1: fully-dashed 4/5-2-(2..5) with optional -suffix
  // block. Branch 2: dash-optional compact form, middle required DIGITS so a
  // bare foreign alnum string can't ride the loosened shape (KD4561J6X9U
  // cabin filter dashless).
  mazda: /^(?:[A-Z0-9]{4,5}-[A-Z0-9]{2}-[A-Z0-9]{2,5}(?:-[A-Z0-9]{1,3})?|[A-Z0-9]{4,5}-?\d{2}-?[A-Z0-9]{2,5})$/i,
  // Volvo: 7-8 digit modern, 6-digit legacy hardware (977751 drain plug
  // gasket — real ledgered SKU on the 2021 XC90, Aug 9 2026).
  volvo: /^\d{6,8}$/,
  // Jaguar Land Rover (shared family formats). The old /^LR\d{6}$/ rejected 13
  // of the 2012 Range Rover's real parts (batch-9): JLR uses far more than the
  // modern "LR######" number. Covered here:
  //   - LR + 6 digits, with an optional revision/kit suffix: LR011279, LR011593K
  //   - 3-letter + 5-6 digit prefixed numbers: TYK500050 (ZF ATF), IYK500010
  //     (transfer case), YLE500110, JDE37128 (Jaguar), and old Rover codes
  //     STC3843 / ERR6299 / ANR1234 / FTC5106
  //   - Jaguar letter-digit-letter numbers: C2Z30906, T2H7856, C2C8355
  //     (matched by the [A-Z]\d[A-Z]... branch)
  // 2-letter prefix minimum keeps it from matching a bare Asian 5-5 number; the
  // foreign-brand-signature check still runs first, and isPlausiblePartNumber
  // backstops. Jaguar previously had NO pattern (fell through to the generic
  // check) — giving it the family pattern adds hallucination filtering without
  // rejecting its real numbers.
  landrover: /^(?:[A-Z]{2,4}\d{3,6}[A-Z]{0,2}|[A-Z]\d[A-Z]\d{3,6}[A-Z]?)$/i,
  jaguar: /^(?:[A-Z]{2,4}\d{3,6}[A-Z]{0,2}|[A-Z]\d[A-Z]\d{3,6}[A-Z]?)$/i,
  // Scion parts are Toyota-cataloged (same 5-5 / chemical formats). Was on the
  // generic fallback; give it Toyota's pattern for parity.
  scion: /^\d{5}(?:-[A-Z0-9]{4,6}(?:-[A-Z0-9]{1,4})?|[A-Z0-9]{5})$/i,
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
// Makes whose catalogs print the 5-digit-dash-5 shape. Membership decides
// whether a number matching that signature is OUR make's or another's — a
// non-member whose number matches is treated as cross-make contamination and
// DROPPED.
//
// `subaru` was missing, and Subaru prints exactly this shape (26296-AL03A,
// 15208-AA160). Its numbers matched the asian_5_5 signature, failed the
// membership test, and were deleted as contamination — destroying correct,
// present values rather than merely failing to find them, which the pipeline
// law ranks as the worse error. The escape hatch below could not save them
// either: subaru's own pattern admitted no dash.
//
// NOT mazda, deliberately: its numbers are 4-char alphanumeric blocks
// (L3K9-14-302, PE01-14-302) and do not match this signature at all, so adding
// it would widen the set for no benefit.
const ASIAN_5_5_FAMILY = new Set([
  "toyota", "lexus", "scion",
  "hyundai", "kia", "genesis",
  "nissan", "infiniti",
  "mitsubishi", "suzuki",
  "honda", "acura",
  "subaru",
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

// Single-source identity key — see lib/makeKey.ts (imported at top).

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
  // VAG fluid/chemical G-numbers (G 052 167 A2 / G012A8GM1): the G prefix is
  // distinctively VAG, so one extracted for another marque is contamination.
  // (B-numbers are excluded — too short/ambiguous to be a reliable signature.)
  {
    label: "vag_fluid",
    pattern: /^G[\s-]?\d{3}[\s-]?[A-Z0-9]{3}(?:[\s-]?[A-Z0-9]{1,3}){0,2}$/i,
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
  const makeKey = makeKeyOf(makeName);
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
 * Makes whose digit-only part numbers have a FIXED canonical length, so a
 * value that lost leading zeros (JSON-number extraction, upstream numeric
 * coercion) fails the make pattern and can be safely restored by left-padding.
 * Only fixed-length formats qualify: for GM/Mopar/Volvo a zero-stripped
 * number still matches a shorter valid format, so padding there would corrupt
 * legitimate short SKUs. Found live on the 2001 BMW 740iA (Jul 11 2026):
 * 07119963130 arrived as 7119963130 and three real parts were rejected.
 */
const SALVAGE_DIGIT_LENGTHS: Record<string, number> = {
  bmw: 11,
  mini: 11,
  mercedes: 10,
  mercedesbenz: 10,
};

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
    const makeKey = makeKeyOf(makeName);
    const pattern = OEM_PART_PATTERNS[makeKey];
    if (pattern && !pattern.test(cleaned)) {
      // Leading-zero salvage: digit-only value 1-2 chars short of the make's
      // fixed canonical length — restore the zeros iff the padded form passes.
      const canonicalLen = SALVAGE_DIGIT_LENGTHS[makeKey];
      if (
        process.env.PARTS_SALVAGE_LEADING_ZERO !== "off" &&
        canonicalLen &&
        /^\d+$/.test(cleaned) &&
        cleaned.length < canonicalLen &&
        canonicalLen - cleaned.length <= 2
      ) {
        const padded = cleaned.padStart(canonicalLen, "0");
        if (pattern.test(padded)) {
          console.log(
            `[sanitize] SALVAGED leading zero: "${cleaned}" → "${padded}" for make=${makeName}`,
          );
          return padded;
        }
      }
      console.log(
        `[sanitize] REJECTED part number "${cleaned}" for make=${makeName}: fails ${makeKey} format`,
      );
      return null;
    }
    // The make's own format matched — that is the FINAL verdict. The generic
    // plausibility check below exists (per its own doc) for makes WITHOUT a
    // pattern; applying it on top of a pattern match rejected real numbers:
    // Mercedes display format with a variant suffix ("000 989 79 02 11") is
    // FIVE space groups, and the generic gate caps at four (found Aug 2026 —
    // the oil-product rung's text-mined genuine 0W-40 SKU died here).
    if (pattern) return cleaned;
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

// ─── Capacity Sanitization (unit-aware) ──────────────────────────

const QUARTS_PER_LITER = 1.05669;
const QUARTS_PER_GALLON = 4;

/**
 * Sanitize a fluid-capacity value that MUST end up in US quarts.
 *
 * Unlike sanitizeNumber (which strips the unit token WITHOUT converting — so
 * "13.1 L" would become 13.1 and be stored as if it were quarts), this inspects
 * the trailing unit and CONVERTS liters/ml/gallons to quarts. This closes a
 * latent liters-as-quarts bug on every `_qts` capacity field.
 *
 * When the value is already numeric (unit context lost upstream) or carries a
 * quart unit / no unit, it is returned as-is in quarts.
 */
export function sanitizeCapacityQuarts(val: unknown): number | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "number") {
    if (val === 0 || !isFinite(val)) return undefined;
    return val;
  }
  if (typeof val !== "string") return undefined;

  let s = stripHtml(val);
  s = stripMarkdown(s);
  s = unwrapValue(s);
  s = normalizeWhitespace(s).trim();
  if (s.length === 0) return undefined;

  // Leading numeric token + optional immediately-following unit word.
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (isNaN(n) || n === 0 || !isFinite(n)) return undefined;

  const unit = (m[2] ?? "").toLowerCase();
  const round2 = (x: number) => Math.round(x * 100) / 100;

  if (unit === "l" || unit === "liter" || unit === "liters" || unit === "litre" || unit === "litres") {
    return round2(n * QUARTS_PER_LITER);
  }
  if (unit === "ml") {
    return round2((n / 1000) * QUARTS_PER_LITER);
  }
  if (unit === "gal" || unit === "gallon" || unit === "gallons") {
    return round2(n * QUARTS_PER_GALLON);
  }
  // "qt" / "quart(s)" / no unit → already US quarts.
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
