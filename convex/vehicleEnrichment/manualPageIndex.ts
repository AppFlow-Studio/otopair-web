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
  /** Documents this manual defers its schedule to. See detectScheduleDeferral. */
  defers_to?: DeferralTarget[];
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

// ─── Deferral detection ──────────────────────────────────────────
//
// Some owner's manuals do not CONTAIN the maintenance schedule — they name the
// document that does. The 2021 Subaru Legacy is explicit about it on page 489:
//
//   "U.S. models — The scheduled maintenance items required to be serviced at
//    regular intervals are shown in the 'Warranty and Maintenance Booklet.'"
//
// Without this, that vehicle produced `schedule_found=false` and looked
// identical to a failed extraction. It was not a failure: the extractor read
// the document correctly and the document says the answer is elsewhere. The
// difference matters because one of those states is actionable — we know the
// exact title of the document to go and find.
//
// Detection is free: it runs over page text the index pass has already
// extracted, so a deferral is discovered on the same scan that picks pages.
//
// Measured across the four reference manuals: Subaru reports 4 targets, and the
// GMC Acadia, Ford Maverick and Kia Sportage report ZERO — they carry their
// schedules inline. The signal fires only where the schedule really is absent.

export type DeferralRegion = "us" | "ca" | null;

export type DeferralTarget = {
  /** Document title as the manual writes it, de-hyphenated and normalized. */
  title: string;
  /** 1-indexed pages that named it. */
  pages: number[];
  /** Which market this instruction applied to, when the manual splits them. */
  region: DeferralRegion;
  /** Surrounding text, so a human can check the finding without the PDF. */
  evidence: string;
};

/**
 * Phrases that name another document as the home of the schedule.
 *
 * Anchored on "separate"/"shown in" plus a Title-Case document name, because a
 * bare mention of a booklet is not a deferral — manuals cross-reference their
 * own chapters constantly and every one of those would be a false positive.
 */
const DEFERRAL_PATTERNS: RegExp[] = [
  /(?:shown|described|listed|contained|found)\s+in\s+the\s+[“"']?([A-Z][^”"'.]{6,60}?Booklet)[”"']?/g,
  /refer\s+to\s+the\s+separate\s+[“"']?([A-Z][^”"'.]{6,60})[”"']?/g,
  /see\s+the\s+separate\s+[“"']?([A-Z][^”"'.]{6,60})[”"']?/g,
];

/** PDFs break words across lines: "Mainte- nance Booklet". Rejoin before
 *  matching, or the same document is discovered under two titles. */
function dehyphenate(t: string): string {
  return t.replace(/([A-Za-z])-\s+([a-z])/g, "$1$2");
}

/** Which market the surrounding text was addressing, when it says. */
function regionNear(text: string, at: number): DeferralRegion {
  const before = text.slice(Math.max(0, at - 220), at);
  const us = before.lastIndexOf("U.S. models");
  const ca = before.lastIndexOf("Canada models");
  if (us < 0 && ca < 0) return null;
  return us > ca ? "us" : "ca";
}

/**
 * Documents this manual says hold the maintenance schedule.
 *
 * Ordered most-cited first, with US-market instructions preferred — the Subaru
 * page names the "Warranty and Maintenance Booklet" for the US and the
 * "Warranty and Service Booklet" for Canada in adjacent columns, and fetching
 * the Canadian one would be a quietly wrong answer.
 */
export function detectScheduleDeferral(
  pages: readonly (string | null | undefined)[],
): DeferralTarget[] {
  const found = new Map<string, DeferralTarget>();
  pages.forEach((raw, i) => {
    const t = dehyphenate(String(raw ?? "").replace(/\s+/g, " "));
    for (const re of DEFERRAL_PATTERNS) {
      re.lastIndex = 0;
      for (const m of t.matchAll(re)) {
        const title = (m[1] ?? "").trim().replace(/\s+/g, " ");
        // A deferral target is a DOCUMENT, so require a document-ish noun.
        if (!/booklet|guide|supplement|manual/i.test(title)) continue;
        const key = title.toLowerCase();
        const existing = found.get(key);
        if (existing) {
          existing.pages.push(i + 1);
          if (existing.region === null) existing.region = regionNear(t, m.index ?? 0);
          continue;
        }
        found.set(key, {
          title,
          pages: [i + 1],
          region: regionNear(t, m.index ?? 0),
          evidence: t.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 180).trim(),
        });
      }
    }
  });

  return [...found.values()].sort((a, b) => {
    // US instructions first — a Canadian booklet is the wrong answer, not a
    // partial one.
    const r = (x: DeferralTarget) => (x.region === "us" ? 0 : x.region === null ? 1 : 2);
    if (r(a) !== r(b)) return r(a) - r(b);
    // Then a title that actually mentions maintenance.
    const m = (x: DeferralTarget) => (/maintenance/i.test(x.title) ? 0 : 1);
    if (m(a) !== m(b)) return m(a) - m(b);
    return b.pages.length - a.pages.length;
  });
}

/**
 * Search queries for the companion document.
 *
 * Deliberately returns QUERIES rather than fetching: discovery already has a
 * ranking, probing, download and identity-guard path in manualLibrary, and the
 * companion document is not a different KIND of document — it is the same hunt
 * with a different title. Handing over queries reuses all of it.
 */
export function companionSearchQueries(
  vehicle: { year: number; make: string; model: string },
  target: DeferralTarget,
): string[] {
  const { year, make, model } = vehicle;
  const title = target.title;
  return [
    `${year} ${make} "${title}" pdf`,
    `${make} ${title} ${year} scheduled maintenance intervals pdf`,
    `${year} ${make} ${model} ${title}`,
  ];
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
      defers_to: v.optional(
        v.array(
          v.object({
            title: v.string(),
            pages: v.array(v.float64()),
            region: v.optional(v.union(v.literal("us"), v.literal("ca"))),
            evidence: v.string(),
          }),
        ),
      ),
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
