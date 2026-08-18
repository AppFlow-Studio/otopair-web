import { describe, it, expect } from "vitest";
import {
  PAGE_INDEX_VERSION,
  pageCountOf,
  pageIndexIsFresh,
  pickPageRanges,
  scoreManualPages,
  toReductoPageRange,
} from "../convex/vehicleEnrichment/manualPageIndex";

// Fixtures are shortened but structurally faithful to the real pages profiled
// from the 2021 GMC Acadia owner's manual (393 pages).
const SCHEDULE_NORMAL =
  "Service and Maintenance 347 Maintenance Schedule Additional Required Services - Normal " +
  "12 000 km/7,500 mi 24 000 km/15,000 mi 36 000 km/22,500 mi 48 000 km/30,000 mi " +
  "60 000 km/37,500 mi 72 000 km/45,000 mi engine oil and filter tire rotation";
const FOOTNOTES = "348 Service and Maintenance Footnotes — Maintenance Schedule Additional";
const SCHEDULE_SEVERE =
  "Service and Maintenance 349 Maintenance Schedule Additional Required Services - Severe " +
  "12 000 km/7,500 mi 24 000 km/15,000 mi 36 000 km/22,500 mi 48 000 km/30,000 mi " +
  "60 000 km/37,500 mi 72 000 km/45,000 mi engine air filter spark plug";
const CAPACITIES =
  "358 Technical Data Vehicle Data Capacities and Specifications Application Capacities " +
  "Metric English Engine Oil 5.7 qt 5.4 L Cooling System 9.5 qt 9.0 L viscosity SAE 5W-30 dexos";
const SECTION_TOC =
  "344 Service and Maintenance General Information . . . . . . . . . 344 Maintenance Schedule " +
  ". . . . . . . . . 345 Special Application Services . . . . . . . . . 350 Recommended Fluids " +
  ". . . . . . . . . 353 Additional Maintenance . . . . . . . . 350";
const INDEX_PAGE =
  "Index 387 M Maintenance Records . . . . . . . . . . 356 Maintenance Schedule . . . . . . . . 345 " +
  "Recommended Fluids and Lubricants . . . . . . . . 353 Malfunction Indicator Lamp . . . . . . 107 " +
  "Manual Mode . . . . . . 220 Mirrors . . . . . . 33 Engine Oil . . . . . 340 Coolant . . . . . 341";
const PROSE = "Vehicle Care 343 Button Retainer Some vehicles have floor mats with a retainer.";

describe("scoreManualPages", () => {
  it("scores a real schedule page far above surrounding prose", () => {
    const [prose, sched] = scoreManualPages([PROSE, SCHEDULE_NORMAL]);
    expect(sched.interval).toBeGreaterThan(prose.interval);
    expect(sched.interval).toBeGreaterThan(10);
  });

  it("scores a capacities table on the spec axis, not the interval axis", () => {
    const [cap] = scoreManualPages([CAPACITIES]);
    expect(cap.spec).toBeGreaterThan(10);
    expect(cap.spec).toBeGreaterThan(cap.interval);
  });

  it("EXCLUDES the index and the section contents", () => {
    // These name every section we are hunting for and contain none of them.
    // Before the nav check they outranked the real pages on keyword matching.
    const [toc, idx] = scoreManualPages([SECTION_TOC, INDEX_PAGE]);
    expect(toc.isNav).toBe(true);
    expect(idx.isNav).toBe(true);
    expect(toc.interval).toBe(0);
    expect(idx.interval).toBe(0);
    expect(idx.spec).toBe(0);
  });

  it("does not mistake ordinary prose for content", () => {
    const [p] = scoreManualPages([PROSE]);
    expect(p.interval).toBeLessThan(8);
  });

  it("tolerates empty and null pages", () => {
    const s = scoreManualPages([null, undefined, ""]);
    expect(s.every((x) => x.interval === 0 && x.spec === 0)).toBe(true);
  });
});

describe("pickPageRanges", () => {
  // Page order mirrors the real Acadia: prose, contents, schedule, footnotes,
  // schedule, prose, capacities.
  const pages = [PROSE, SECTION_TOC, SCHEDULE_NORMAL, FOOTNOTES, SCHEDULE_SEVERE, PROSE, CAPACITIES];
  const scores = scoreManualPages(pages);

  it("BRIDGES the footnote page so both schedules are captured", () => {
    // The regression that motivated this: expanding from the single best page
    // stopped at the low-scoring footnotes and shipped only the Severe
    // schedule — half the answer, and not the half we usually quote from.
    const r = pickPageRanges(scores, "interval");
    expect(r).toHaveLength(1);
    expect(r[0].start).toBeLessThanOrEqual(3);
    expect(r[0].end).toBeGreaterThanOrEqual(5);
  });

  it("returns 1-indexed inclusive ranges (Reducto's convention)", () => {
    const r = pickPageRanges(scores, "spec");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].start).toBeGreaterThanOrEqual(1);
    // The capacities page is the 7th page → index 7, not 6.
    expect(r.some((x) => x.start <= 7 && x.end >= 7)).toBe(true);
  });

  it("returns nothing when no page clears the floor", () => {
    expect(pickPageRanges(scoreManualPages([PROSE, PROSE]), "interval")).toEqual([]);
    expect(pickPageRanges([], "interval")).toEqual([]);
  });

  it("never exceeds the page budget", () => {
    const many = Array.from({ length: 60 }, () => SCHEDULE_NORMAL);
    const r = pickPageRanges(scoreManualPages(many), "interval", { budget: 12 });
    expect(pageCountOf(r)).toBeLessThanOrEqual(12);
  });

  it("skips a run that does not fit rather than truncating it", () => {
    // Half a schedule table is worse than none — a partial range would extract
    // confidently from an incomplete grid.
    const many = Array.from({ length: 30 }, () => SCHEDULE_NORMAL);
    const r = pickPageRanges(scoreManualPages(many), "interval", { budget: 5 });
    expect(r).toEqual([]);
  });
});

describe("toReductoPageRange", () => {
  it("maps to the API shape", () => {
    expect(toReductoPageRange([{ start: 346, end: 350 }])).toEqual([{ start: 346, end: 350 }]);
  });

  it("returns NULL for no ranges, never an empty array", () => {
    // An empty array reads to Reducto as "extract zero pages". Null means
    // "we have no narrowing", which the caller turns into whole-document.
    expect(toReductoPageRange([])).toBeNull();
  });
});

describe("pageIndexIsFresh", () => {
  const idx = {
    version: PAGE_INDEX_VERSION,
    total_pages: 393,
    intervals: [{ start: 346, end: 350 }],
    specs: [{ start: 359, end: 361 }],
    computed_at: 1,
  };
  it("accepts a current index", () => expect(pageIndexIsFresh(idx)).toBe(true));
  it("rejects a stale scoring version", () =>
    expect(pageIndexIsFresh({ ...idx, version: PAGE_INDEX_VERSION - 1 })).toBe(false));
  it("rejects an index that selected nothing", () =>
    expect(pageIndexIsFresh({ ...idx, intervals: [], specs: [] })).toBe(false));
  it("rejects absent", () => {
    expect(pageIndexIsFresh(null)).toBe(false);
    expect(pageIndexIsFresh(undefined)).toBe(false);
  });
});

describe("pageCountOf", () => {
  it("counts inclusive ranges", () => {
    expect(pageCountOf([{ start: 346, end: 350 }])).toBe(5);
    expect(pageCountOf([{ start: 1, end: 1 }, { start: 10, end: 12 }])).toBe(4);
    expect(pageCountOf([])).toBe(0);
  });
});
