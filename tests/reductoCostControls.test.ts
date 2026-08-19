import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  reductoEnabled,
  reductoMaxPages,
  withinReductoPageBudget,
} from "../convex/vehicleEnrichment/manualReducto";

// Reducto bills PER PAGE and page_range defaults to the whole document, so an
// unbounded call on a 395-page owner's manual is a ~$16 charge to recover about
// ten interval rows. Three manuals cost ~$50 on Aug 18 2026. These are the
// bounds that stop that from being the default behaviour.

const KEYS = ["PARTS_REDUCTO", "REDUCTO_MAX_PAGES"] as const;
let snap: Record<string, string | undefined>;

beforeEach(() => {
  snap = {};
  for (const k of KEYS) { snap[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("reductoEnabled", () => {
  it("is on by default so the fallback keeps working", () => {
    expect(reductoEnabled()).toBe(true);
  });
  it("is killable without a deploy", () => {
    process.env.PARTS_REDUCTO = "off";
    expect(reductoEnabled()).toBe(false);
  });
  it("only 'off' disables — a typo must not silently kill the rung", () => {
    process.env.PARTS_REDUCTO = "false";
    expect(reductoEnabled()).toBe(true);
  });
});

describe("reductoMaxPages", () => {
  it("defaults to 250", () => {
    expect(reductoMaxPages()).toBe(250);
  });
  it("is tunable", () => {
    process.env.REDUCTO_MAX_PAGES = "40";
    expect(reductoMaxPages()).toBe(40);
  });
  it("ignores junk rather than dropping the ceiling to zero", () => {
    // A "0" or garbage value must not disable the budget by accident — that
    // would turn the guard into a no-op in exactly the situation it exists for.
    for (const bad of ["", "abc", "0", "-5"]) {
      process.env.REDUCTO_MAX_PAGES = bad;
      expect(reductoMaxPages(), bad).toBe(250);
    }
  });
});

describe("withinReductoPageBudget", () => {
  it("refuses the documents that actually cost us money", () => {
    // The 395-page GMC Acadia owner's manual — ~$16 at ~$0.042/page.
    expect(withinReductoPageBudget(395)).toBe(false);
    expect(withinReductoPageBudget(644)).toBe(false);
  });

  it("admits a booklet-sized document", () => {
    // Toyota's T-MMS maintenance guide is ~60 pages and is the shape that
    // makes this path cheap — it also fits Anthropic, so it never gets here.
    expect(withinReductoPageBudget(60)).toBe(true);
    expect(withinReductoPageBudget(250)).toBe(true);
  });

  it("passes an unknown page count rather than blocking on missing data", () => {
    // page_count is absent on older rows. The ceiling exists to stop
    // known-huge documents, not to make a missing field fatal.
    for (const v of [null, undefined, 0, NaN]) {
      expect(withinReductoPageBudget(v as any), String(v)).toBe(true);
    }
  });

  it("respects a tightened ceiling", () => {
    process.env.REDUCTO_MAX_PAGES = "50";
    expect(withinReductoPageBudget(60)).toBe(false);
    expect(withinReductoPageBudget(40)).toBe(true);
  });
});
