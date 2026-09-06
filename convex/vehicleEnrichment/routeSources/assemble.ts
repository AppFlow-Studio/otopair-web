// =============================================================================
// routeSources/assemble.ts — walked pages → one document + a citation index.
//
// WHY THE INDEX EXISTS
// --------------------
// The PDF path gets page-level citations from the Files API
// (manualLibrary.collectCitationSpans), so an extracted capacity can be traced
// to the page it was read from. Route text has no such thing, and the first
// implementation of this idea shows what happens without one —
// myCarUserManual.ts stamped EVERY claim with `usable[0]`'s URL:
//
//     source_url: bySlug.get(usable[0].slug) ?? gen.url
//
// so a value read from the tyre chapter cited the oil chapter. The comment
// above that line says the claim points at the section actually read. It did
// not, and nothing downstream could tell.
//
// The fix is to keep the offsets. `assembleRouteDocument` records where each
// section's text lives in the concatenated document, and `locateQuote` maps a
// quoted span back to the section that contains it. A claim then cites the page
// its evidence is actually on.
//
// THE SECOND THING THIS BUYS
// --------------------------
// A quote that appears in NO section did not come from the source. The PDF path
// enforces "no quote, no value"; this enforces the strictly stronger "no quote
// WE CAN FIND, no value", which is the only check that catches a fabricated
// span. It costs one string search per extracted field.
// =============================================================================

import type { RouteWalkSection } from "./types";

export type RouteDocumentSection = {
  slug: string;
  url: string;
  /** Half-open [start, end) over `RouteDocument.text`. */
  start: number;
  end: number;
};

export type RouteDocument = {
  text: string;
  sections: RouteDocumentSection[];
  /** Normalized mirror of `text`, and the offset map back to it. Built once
   *  here because locateQuote is called per extracted field. */
  normalized: string;
  /** normalized[i] came from text[offsets[i]]. */
  offsets: number[];
};

/** Header a section's text is introduced by. Kept identical to the prompt the
 *  extractor sees, so offsets computed here match what the model read. */
export function sectionHeader(slug: string): string {
  return `### SECTION: ${slug}\n`;
}

const SECTION_JOIN = "\n\n";

/**
 * Concatenate walked sections into the document the extractor will read, and
 * record where each one landed.
 *
 * The text produced here is exactly what goes into the prompt body — if the two
 * ever diverge, the offsets stop meaning anything, so callers must build the
 * prompt from `RouteDocument.text` rather than re-joining the sections.
 */
export function assembleRouteDocument(
  sections: readonly RouteWalkSection[],
): RouteDocument {
  const parts: string[] = [];
  const index: RouteDocumentSection[] = [];
  let cursor = 0;

  for (const s of sections) {
    if (cursor > 0) {
      parts.push(SECTION_JOIN);
      cursor += SECTION_JOIN.length;
    }
    const header = sectionHeader(s.slug);
    parts.push(header);
    const start = cursor + header.length;
    parts.push(s.text);
    cursor = start + s.text.length;
    index.push({ slug: s.slug, url: s.url, start, end: cursor });
  }

  const text = parts.join("");
  const { normalized, offsets } = normalizeWithOffsets(text);
  return { text, sections: index, normalized, offsets };
}

/**
 * Fold away everything a model routinely changes when it quotes: case,
 * whitespace runs, and the punctuation that gets auto-substituted (curly
 * quotes, en/em dashes, non-breaking spaces).
 *
 * Offsets are kept alongside so a hit in normalized space can be mapped back to
 * a real position in the document — without that, a match tells us the quote is
 * real but not WHERE, which is the half of the problem we care about.
 */
export function normalizeWithOffsets(raw: string): { normalized: string; offsets: number[] } {
  const out: string[] = [];
  const offsets: number[] = [];
  let lastWasSpace = true; // leading whitespace is dropped

  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];

    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      out.push(" ");
      offsets.push(i);
      lastWasSpace = true;
      continue;
    }

    // Punctuation the model swaps freely.
    if (ch === "‘" || ch === "’" || ch === "ʼ") ch = "'";
    else if (ch === "“" || ch === "”") ch = '"';
    else if (ch === "–" || ch === "—" || ch === "−") ch = "-";

    out.push(ch.toLowerCase());
    offsets.push(i);
    lastWasSpace = false;
  }

  // Drop a single trailing space so a quote ending mid-run still matches.
  if (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    offsets.pop();
  }

  return { normalized: out.join(""), offsets };
}

/** Minimum normalized length a quote must have to be worth locating. Below
 *  this a span matches by accident — "5w-30" appears in every oil chapter. */
export const MIN_LOCATABLE_QUOTE = 24;

/** How much of a long quote must match. A model routinely truncates or elides
 *  the middle of a long span; the opening is the reliable part. */
const QUOTE_PREFIX_CHARS = 60;

export type QuoteLocation = {
  slug: string;
  url: string;
  /** Offset into RouteDocument.text where the quote was found. */
  at: number;
};

/**
 * Find which walked page a quoted span came from.
 *
 * Returns null when the quote cannot be found — which the caller must treat as
 * "drop this value", not "cite the document root". A span we cannot find in the
 * text we supplied is either fabricated or so mangled it is no longer evidence,
 * and both are reasons not to claim.
 *
 * Two passes: the whole normalized quote, then its opening
 * QUOTE_PREFIX_CHARS. The prefix pass is what tolerates a model that quoted a
 * paragraph and trailed off; it is still long enough not to hit by chance.
 */
export function locateQuote(doc: RouteDocument, quote: string): QuoteLocation | null {
  const { normalized: q } = normalizeWithOffsets(quote ?? "");
  if (q.length < MIN_LOCATABLE_QUOTE) return null;

  let needle = q;
  let hits = allIndexesOf(doc.normalized, needle);
  if (hits.length === 0 && q.length > QUOTE_PREFIX_CHARS) {
    needle = q.slice(0, QUOTE_PREFIX_CHARS);
    hits = allIndexesOf(doc.normalized, needle);
  }
  if (hits.length === 0) return null;

  // AMBIGUITY IS A FAILURE TO LOCATE, NOT A TIE TO BREAK.
  //
  // Caught live on the 2021 CR-V (Aug 13 2026): every chapter on the site opens
  // with the same "Share this Manual / Link copied!" chrome, so a quote drawn
  // from that block appears in all four sections. Taking the first hit cited
  // the wrong chapter with full confidence — the same defect as the `usable[0]`
  // bug this module exists to fix, one scale smaller and far harder to see.
  //
  // Repeats INSIDE one section are fine; the section is still determined. Only
  // a quote spanning two different sections is unresolvable, and an
  // unresolvable citation is treated the same as a missing one: the caller
  // drops the value.
  const sections = new Set<string>();
  let found: { section: RouteDocumentSection; at: number } | null = null;

  for (const hit of hits) {
    const at = doc.offsets[hit];
    if (at == null) continue;
    const section = doc.sections.find((s) => at >= s.start && at < s.end);
    if (!section) continue; // landed in a header/join — not inside real content
    sections.add(section.slug);
    if (sections.size > 1) return null;
    if (!found) found = { section, at };
  }

  if (!found) return null;
  return { slug: found.section.slug, url: found.section.url, at: found.at };
}

/** Every start index of `needle` in `hay`. Bounded so a one-character needle
 *  on a 50 KB document cannot turn a lookup into a scan of the whole corpus. */
function allIndexesOf(hay: string, needle: string, limit = 8): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  while (out.length < limit) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + needle.length;
  }
  return out;
}
