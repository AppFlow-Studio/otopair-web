/**
 * vehicleEnrichment/manualPageIndex.ts — WHICH PAGES OF A MANUAL ARE WORTH READING
 *
 * WHY THIS EXISTS
 * ---------------
 * Reducto bills per page and `settings.page_range` defaults to the WHOLE
 * document, so an oversize owner's manual was costing ~$16.67 to recover about
 * ten interval rows and eighteen specs. Measured Aug 18 2026: three manuals came
 * to roughly $50. At ~$0.042/page against a 395-page manual, a thousand vehicles
 * is ~$17k — the extraction was correct and the economics were not.
 *
 * The fix is not a cheaper extractor. It is not sending 380 pages we do not
 * want. A maintenance schedule and a capacities table occupy a handful of pages
 * and they are findable for free: the PDF text is already in our own storage,
 * and locating them costs a 1.5-second local scan and zero dollars.
 *
 * WHAT THE SCORING KEYS ON (derived from real manuals, not from intuition)
 * -----------------------------------------------------------------------
 * Profiling the 2021 GMC Acadia and 2022 Ford Maverick page by page:
 *
 *   p348  iv=128  "Maintenance Schedule Additional Required Services - Normal"
 *   p349  iv=4    "Footnotes — Maintenance Schedule"
 *   p350  iv=129  "…Additional Required Services - Severe"
 *   p359  sp=51   "Technical Data … Capacities and Specifications"
 *   p360  sp=61   "Application Capacities Metric English I3.6L V6 Engine…"
 *   p345  NAV     section contents — 16 dot-leader runs
 *   p388  NAV     index — cites every section we want, contains none of them
 *
 * Three lessons are baked in below:
 *
 *   1. DENSITY, NOT PRESENCE. The word "specifications" appears on thirty pages;
 *      a real capacities table carries a dozen `5.7 qt (5.4 L)`-shaped tokens.
 *      Counting beats matching.
 *   2. NAVIGATION PAGES MUST BE EXCLUDED. A table of contents and an index name
 *      exactly the sections we are hunting for, so keyword matching ranks them
 *      at the top while they contain no data at all. Dot-leader runs identify
 *      them cheaply.
 *   3. GAPS MUST BE BRIDGED, NOT TREATED AS BOUNDARIES. The Normal and Severe
 *      schedules are separated by a low-scoring footnotes page. Expanding
 *      outward from the single highest-scoring page stopped at that footnote
 *      and shipped only the Severe schedule — half the answer, and the half we
 *      do not primarily quote from.
 *
 * RECALL OVER THRIFT. The thresholds are deliberately loose enough to admit some
 * neighbouring pages. Over-including a few costs cents; missing the schedule
 * costs the extraction, and we already paid to fetch the document. Measured on
 * the two reference manuals: 15/393 pages (3.8%) and 31/533 (5.8%) — roughly a
 * 20x cost reduction while still containing every section verified by hand.
 */

/** Bump when the scoring changes, so stale indexes can be recomputed. */
export const PAGE_INDEX_VERSION = 1;

export type PageRange = { start: number; end: number };

export type PageScore = {
  /** Contents/index page — cites the sections we want, contains none of them. */
  isNav: boolean;
  interval: number;
  spec: number;
};

export type ManualPageIndex = {
  version: number;
  total_pages: number;
  intervals: PageRange[];
  specs: PageRange[];
  computed_at: number;
};

// ─── Signals ─────────────────────────────────────────────────────

/** "7,500 mi" / "120 000 km" — the spine of a maintenance grid. */
const MILEAGE = /\b\d{1,3},\d{3}\s*(?:mi|miles)\b|\b\d{1,3}\s\d{3}\s*km\b/gi;
const SERVICE =
  /\b(engine oil|oil (?:and )?filter|tire rotation|air filter|cabin (?:air )?filter|spark plug|brake fluid|coolant|transmission fluid|timing belt|differential)\b/gi;
/** "5.7 qt (5.4 L)" — a capacities table is mostly these. */
const CAPACITY = /\b\d+(?:\.\d+)?\s*(?:qt|quarts?|L|liters?|litres?)\b/gi;
const SPECWORD =
  /\b(capacit\w+|recommended fluids?|lubricants?|viscosity|SAE\s*\d|dexos|API\s+[A-Z]{2}|specifications?)\b/gi;
/** ". . . ." — the dotted leader that marks a contents or index line. */
const DOT_LEADER = /\.\s?\.\s?\.\s?\./g;

const countOf = (s: string, re: RegExp): number => (s.match(re) || []).length;

/**
 * Score every page for how likely it is to CONTAIN (not merely mention) a
 * maintenance schedule or a specifications table.
 *
 * Pure: takes already-extracted page text so the scoring is testable without a
 * PDF, and so the expensive extraction happens once in the Node action.
 */
export function scoreManualPages(pages: readonly (string | null | undefined)[]): PageScore[] {
  return pages.map((raw) => {
    const t = String(raw ?? "").replace(/\s+/g, " ");
    const len = t.length || 1;
    const dots = countOf(t, DOT_LEADER);
    // Both an absolute count and a density, because an index page is long and
    // dot-heavy while a short section-contents page is only dot-dense.
    const isNav = dots >= 12 || (dots >= 6 && dots / (len / 1000) > 8);
    return {
      isNav,
      interval: isNav ? 0 : countOf(t, MILEAGE) * 3 + countOf(t, SERVICE),
      spec: isNav ? 0 : countOf(t, CAPACITY) * 3 + countOf(t, SPECWORD),
    };
  });
}

export type PickOptions = {
  /** Floor below which a page is never interesting, whatever the peak is. */
  minAbs?: number;
  /** Page must also reach this fraction of the best page's score. */
  rel?: number;
  /** Pages of low score to bridge, so a footnote cannot split a table. */
  bridge?: number;
  /** Hard cap on pages returned for this category. */
  budget?: number;
};

/**
 * The page ranges worth sending, best-scoring first, capped by budget.
 *
 * Returns 1-INDEXED, inclusive ranges — the convention Reducto's `page_range`
 * uses, so nothing has to convert at the call site and get it wrong.
 */
export function pickPageRanges(
  scores: readonly PageScore[],
  key: "interval" | "spec",
  opts: PickOptions = {},
): PageRange[] {
  const minAbs = opts.minAbs ?? 8;
  const rel = opts.rel ?? 0.15;
  const bridge = opts.bridge ?? 2;
  const budget = opts.budget ?? 20;

  const vals = scores.map((s) => s[key]);
  if (vals.length === 0) return [];
  const peak = Math.max(0, ...vals);
  if (peak < minAbs) return [];
  const threshold = Math.max(minAbs, peak * rel);

  const runs: Array<{ start: number; end: number }> = [];
  vals.forEach((v, i) => {
    if (v < threshold) return;
    const last = runs[runs.length - 1];
    // `<= bridge + 1` because a gap of N pages means an index delta of N+1.
    if (last && i - last.end <= bridge + 1) last.end = i;
    else runs.push({ start: i, end: i });
  });

  const ranked = runs
    .map((r) => ({
      ...r,
      score: vals.slice(r.start, r.end + 1).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.score - a.score);

  const out: PageRange[] = [];
  let used = 0;
  for (const r of ranked) {
    const n = r.end - r.start + 1;
    // Skip rather than truncate: half a schedule table is worse than none, and
    // the next run may fit whole.
    if (used + n > budget) continue;
    out.push({ start: r.start + 1, end: r.end + 1 });
    used += n;
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Total pages covered by a range list — the figure that is actually billed. */
export function pageCountOf(ranges: readonly PageRange[]): number {
  return ranges.reduce((n, r) => n + (r.end - r.start + 1), 0);
}

/**
 * Ranges in the shape Reducto's `settings.page_range` accepts.
 *
 * Returns null when there is nothing to narrow to — the caller must then send
 * the whole document or refuse, and `null` says that explicitly rather than an
 * empty array, which Reducto would read as "no pages".
 */
export function toReductoPageRange(
  ranges: readonly PageRange[],
): Array<{ start: number; end: number }> | null {
  if (ranges.length === 0) return null;
  return ranges.map((r) => ({ start: r.start, end: r.end }));
}

/** Is a stored index still usable for the current scoring rules? */
export function pageIndexIsFresh(idx: ManualPageIndex | null | undefined): boolean {
  return !!idx && idx.version === PAGE_INDEX_VERSION && (idx.intervals.length > 0 || idx.specs.length > 0);
}

// ─── Persistence ─────────────────────────────────────────────────
//
// Lives here rather than in the `"use node"` module because a Node file may
// only export actions, and because the index is worth computing exactly once
// per document — it is derived from bytes that never change.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { normalizeMakeKey } from "./manualLibrary";

export const _storePageIndex = internalMutation({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    page_index: v.object({
      version: v.float64(),
      total_pages: v.float64(),
      intervals: v.array(v.object({ start: v.float64(), end: v.float64() })),
      specs: v.array(v.object({ start: v.float64(), end: v.float64() })),
      computed_at: v.float64(),
    }),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("vehicle_manuals")
      .withIndex("by_ymm", (q) =>
        q
          .eq("make", normalizeMakeKey(args.make))
          .eq("model", normalizeMakeKey(args.model))
          .eq("year", args.year),
      )
      .first();
    if (!row) return false;
    await ctx.db.patch(row._id, { page_index: args.page_index } as any);
    return true;
  },
});
