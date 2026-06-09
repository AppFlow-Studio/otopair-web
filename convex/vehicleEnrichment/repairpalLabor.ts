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
  args: { url: v.string() },
  handler: async (_ctx, { url }): Promise<{ hours: number } | null> => {
    const md = await fetchUrl(url);
    if (!md) return null;
    const range = parseRepairpalLabor(md);
    if (!range) return null;
    const hours = recoverHours(range, RATE_MID());
    return hours == null ? null : { hours };
  },
});
