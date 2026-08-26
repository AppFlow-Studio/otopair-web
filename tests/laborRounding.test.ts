/**
 * ceilHoursTo15 — the single round-to-15 rule shared by the quote engine
 * (labor COST, via resolveQuoteSeries) and laborTimes.ts (displayed DURATION).
 *
 * Regression guard for LABOR_COST_TIER_MISMATCH: the mobile Review & Pay screen
 * used to show a RAW labor cost while the booking validator recomputed the
 * rounded-up cost. Any vehicle whose labor landed just above a 15-min boundary
 * was rejected at checkout. Both sides now bill on this same helper, so the
 * preview cost, the displayed duration, and the validator's expectation agree.
 */
import { describe, it, expect } from "vitest";
import { ceilHoursTo15 } from "../convex/lib/quoteEngine";

describe("ceilHoursTo15", () => {
  it("reproduces the reported mismatch: 1.1h (66m) → 1.25h (75m)", () => {
    // Screenshot: raw 1.1h × $150/hr = $165 (client) vs ceil-to-15 1.25h ×
    // $150/hr = $187.50 (server). After the fix both bill the same 1.25h.
    const raw = 1.1;
    expect(ceilHoursTo15(raw)).toBeCloseTo(1.25, 5);
    const rate = 150;
    expect(ceilHoursTo15(raw) * rate).toBeCloseTo(187.5, 2);
  });

  it("ceils partial slots up to the next 15 min", () => {
    expect(ceilHoursTo15(0.6)).toBeCloseTo(0.75, 5); // 36m → 45m
    expect(ceilHoursTo15(0.1)).toBeCloseTo(0.25, 5); // 6m  → 15m
    expect(ceilHoursTo15(1.01)).toBeCloseTo(1.25, 5); // 60.6m → 75m
  });

  it("leaves values already on a 15-min boundary untouched (idempotent)", () => {
    for (const h of [0.25, 0.5, 0.75, 1.0, 1.25, 2.5]) {
      expect(ceilHoursTo15(h)).toBeCloseTo(h, 5);
      // Applying it twice must not climb another slot — this is why the
      // validator can safely reuse an already-billed series total.
      expect(ceilHoursTo15(ceilHoursTo15(h))).toBeCloseTo(h, 5);
    }
  });

  it("passes non-positive / non-finite inputs through (fixed-price = 0 labor)", () => {
    expect(ceilHoursTo15(0)).toBe(0);
    expect(ceilHoursTo15(-1)).toBe(-1);
    expect(ceilHoursTo15(NaN)).toBeNaN();
  });
});
