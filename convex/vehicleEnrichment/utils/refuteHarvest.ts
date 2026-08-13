/**
 * utils/refuteHarvest.ts — pull replacement-part candidates OUT of refutation
 * evidence (Aug 2026).
 *
 * The fitment verifier's refute reasons routinely NAME the correct part while
 * killing the wrong one ("Official Mercedes-Benz USA parts catalog lists
 * 001-982-80-08 or 001-982-81-08 for the 2020 GLC43 AMG, not
 * 001-982-82-08-26") — and the pipeline used to discard that evidence, so the
 * repair rung re-searched from scratch and often found nothing
 * (repair_rung:refilled:0/4 on the GLC-43). This module harvests those named
 * numbers as CANDIDATES only; the caller must push every candidate through the
 * same fitment verification and upsertPartAndFitment gates as any other
 * source. Claims, never direct writes.
 *
 * Pure module — no Convex imports — so the extraction rules are unit-testable.
 */

import { sanitizePartNumber } from "../contentSanitization";

/** Uppercase alphanumeric skeleton — the comparison identity for numbers. */
export function normalizeCandidate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A raw token that is really a calendar-year or year-range, not a part. */
function isYearLike(raw: string, normalized: string): boolean {
  if (/^(19|20)\d{2}$/.test(normalized)) return true;
  // "2010-2016", "2012–2018", "2010 2016" → normalized 8 digits, both halves years.
  if (/^(19|20)\d{2}(19|20)\d{2}$/.test(normalized)) return true;
  return /^(19|20)\d{2}\s*[-–—\/]\s*(19|20)\d{2}$/.test(raw.trim());
}

export interface HarvestedCandidate {
  /** Sanitized (make-pattern-validated) part number, ready for the write path. */
  oem: string;
  /** normalizeCandidate(oem) — dedupe / blocklist key. */
  normalized: string;
}

/**
 * Extract candidate OEM part numbers from a refutation reason.
 *
 * Rules:
 *  - a candidate must survive sanitizePartNumber for this make — the same
 *    format gate the write path applies, so nothing format-invalid escapes;
 *  - the refuted number itself (and anything in `exclude`) never comes back;
 *  - year ranges and bare years are rejected before the format gate runs
 *    (a "2010-2016" fitment span normalizes to 8 digits and could pass a
 *    permissive make pattern);
 *  - candidates keep the verifier's hyphenation via the sanitizer's output.
 *
 * Returns at most `cap` candidates in reason order.
 */
export function extractReplacementCandidates(input: {
  reason: string | null | undefined;
  refutedOem: string | null | undefined;
  make: string;
  /** Normalized numbers that must not be proposed (config blocklist). */
  exclude?: ReadonlySet<string>;
  cap?: number;
}): HarvestedCandidate[] {
  const reason = (input.reason ?? "").trim();
  if (!reason) return [];
  const cap = input.cap ?? 4;
  const refutedNorm = normalizeCandidate(input.refutedOem ?? "");

  // OEM-shaped tokens: hyphen-joined compounds ("001-982-80-08",
  // "270-159-06-00-M220") or single dense alphanumerics ("26296SC011",
  // "9Y0698151AN", "A0009824420"). Spaces deliberately do NOT join — a
  // space-joiner greedily merges prose words with numbers and swallows the
  // real token ("Official Mercedes-Benz USA … 001-982-80" as one match).
  const tokenRe = /\b[A-Z0-9]+(?:-[A-Z0-9]+)+\b|\b[A-Z0-9]{7,18}\b/gi;

  const out: HarvestedCandidate[] = [];
  const seen = new Set<string>();
  for (const match of reason.matchAll(tokenRe)) {
    if (out.length >= cap) break;
    const raw = match[0].trim();
    const normalized = normalizeCandidate(raw);
    // Too short to be an OEM number / too long to be plausible.
    if (normalized.length < 7 || normalized.length > 18) continue;
    // A part number carries digits; prose words ("Mercedes-Benz") do not.
    if ((normalized.match(/\d/g)?.length ?? 0) < 4) continue;
    if (isYearLike(raw, normalized)) continue;
    if (normalized === refutedNorm) continue;
    if (input.exclude?.has(normalized)) continue;
    if (seen.has(normalized)) continue;

    const sanitized = sanitizePartNumber(raw, input.make);
    if (!sanitized) continue;
    // The sanitizer may canonicalize; re-key on ITS output so the dedupe and
    // blocklist comparisons match what the write path will store.
    const sanitizedNorm = normalizeCandidate(sanitized);
    if (sanitizedNorm === refutedNorm || input.exclude?.has(sanitizedNorm) || seen.has(sanitizedNorm)) {
      continue;
    }
    seen.add(normalized);
    seen.add(sanitizedNorm);
    out.push({ oem: sanitized, normalized: sanitizedNorm });
  }
  return out;
}
