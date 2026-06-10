/**
 * repairpalLabor — RepairPal labor helpers.
 *
 * RepairPal exposes labor DOLLARS as a [low, high] range, not hours. The range
 * is hours × a fixed national rate range whose high/low ratio is a constant
 * ~1.47 (verified across services + vehicles). So hours = midpoint$ / RATE_MID.
 * We reject ranges whose ratio is far from 1.47 — that means the page format
 * drifted and the parse is untrustworthy.
 *
 * This module's pure helpers (url/parse/recover) have NO ctx/network so they are
 * unit-tested directly. The scrape action (added later) uses firecrawl.ts.
 */

export const REPAIRPAL_RATE_RATIO = 1.47;
const RATIO_TOLERANCE = 0.15; // accept 1.32–1.62

export const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function repairpalUrl(
  make: string,
  model: string,
  serviceSlug: string,
  year?: number,
): string {
  const parts = ["https://repairpal.com/estimator", slugify(make), slugify(model)];
  if (year) parts.push(String(year));
  parts.push(`${slugify(serviceSlug)}-cost`);
  return parts.join("/");
}

/**
 * Ordered scrape candidates: the year-specific page first (generation-correct
 * labor — the yearless nameplate page mixes generations, Jun-9 review), the
 * yearless page as fallback so coverage never regresses when RepairPal has no
 * year page for this nameplate.
 */
export function repairpalUrlCandidates(
  make: string,
  model: string,
  serviceSlug: string,
  year?: number,
): string[] {
  const urls = year ? [repairpalUrl(make, model, serviceSlug, year)] : [];
  urls.push(repairpalUrl(make, model, serviceSlug));
  return urls;
}

/**
 * RepairPal keys URLs by NAMEPLATE (e.g. "550i-xdrive", "750i", "x5"), but our
 * config stores model = the model LINE ("5 Series") and trim = the variant
 * ("M550i xDrive"). The nameplate is usually trim-derived for sedans and
 * model-derived for SUVs, so we produce ordered candidate slugs (most specific
 * first) and let the safe-failing scrape pick the live one. e.g.
 *   ("7 Series", "750i xDrive") → ["750i-xdrive", "750i", "7-series"]
 *   ("X5", "xDrive40i")         → ["xdrive40i", "40i", "x5"]
 */
export function repairpalModelCandidates(model: string, trim: string): string[] {
  const cands: string[] = [];
  const add = (s: string) => {
    const v = slugify(s);
    if (v && !cands.includes(v)) cands.push(v);
  };
  if (trim) {
    add(trim);
    add(trim.replace(/xdrive/i, "").trim());
  }
  add(model);
  return cands;
}

export type LaborRange = { laborLow: number; laborHigh: number };

export function parseRepairpalLabor(markdown: string): LaborRange | null {
  if (!markdown) return null;
  // "Labor costs are estimated between $153 and $225"
  const m = markdown.match(
    /labor costs?\s+(?:are|is)\s+estimated\s+between\s+\$([\d,]+)\s+and\s+\$([\d,]+)/i,
  );
  if (!m) return null;
  const laborLow = Number(m[1].replace(/,/g, ""));
  const laborHigh = Number(m[2].replace(/,/g, ""));
  if (!(laborLow > 0 && laborHigh >= laborLow)) return null;
  return { laborLow, laborHigh };
}

export function recoverHours(range: LaborRange, rateMid: number): number | null {
  const ratio = range.laborHigh / range.laborLow;
  if (Math.abs(ratio - REPAIRPAL_RATE_RATIO) > RATIO_TOLERANCE) return null;
  const mid = (range.laborLow + range.laborHigh) / 2;
  const hours = mid / rateMid;
  return Math.round(hours * 100) / 100;
}

// ---------------------------------------------------------------------------
// Scrape action (network) — uses the existing Firecrawl module + the dev/prod
// FIRECRAWL_API_KEY. Returns recovered hours or null (no estimate / format drift
// / fetch failure). Pure helpers above stay independently unit-tested.
// ---------------------------------------------------------------------------

import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { fetchUrl } from "./firecrawl";

/** National-average labor rate used to convert RepairPal labor$ → hours. */
const RATE_MID = () => Number(process.env.REPAIRPAL_LABOR_RATE ?? 130);

export const scrapeRepairpalHours = internalAction({
  args: {
    url: v.optional(v.string()),
    // Ordered candidates (year-specific page first, yearless fallback) — first
    // page that parses wins. `url` kept for single-page callers.
    urls: v.optional(v.array(v.string())),
  },
  handler: async (_ctx, { url, urls }): Promise<{ hours: number } | null> => {
    const candidates = urls ?? (url ? [url] : []);
    for (const u of candidates) {
      const md = await fetchUrl(u);
      if (!md) continue;
      const range = parseRepairpalLabor(md);
      if (!range) continue;
      const hours = recoverHours(range, RATE_MID());
      if (hours != null) return { hours };
    }
    return null;
  },
});
