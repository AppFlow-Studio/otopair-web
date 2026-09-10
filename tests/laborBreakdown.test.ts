/**
 * laborBreakdown tests — the shared AGREED per-line labor reader.
 *
 * Pins the receipt bug it was extracted to kill: a mid-job hours edit lives on
 * booking_approvals.labor_allocations, NOT back on the custom_jobs/custom_services
 * row, so a reader that reaches for the line's original estimate prints stale
 * hours and mis-splits the labor dollars. Also covers the estimate fallback
 * (no allocation), 2dp display rounding, and declined-line exclusion.
 */
import { describe, it, expect } from "vitest";

import {
  parseAgreedLaborAllocations,
  resolveAgreedLaborLines,
} from "../convex/lib/laborBreakdown";

describe("parseAgreedLaborAllocations", () => {
  it("splits base from per-custom-job entries", () => {
    const { baseHours, byLineKey } = parseAgreedLaborAllocations([
      { line_key: "base", hours: 1 },
      { line_key: "job1", hours: 0.4 },
      { line_key: "job2", hours: 1.25 },
    ]);
    expect(baseHours).toBe(1);
    expect(byLineKey.get("job1")).toBe(0.4);
    expect(byLineKey.get("job2")).toBe(1.25);
    expect(byLineKey.has("base")).toBe(false);
  });

  it("returns nulls/empties for a missing or malformed allocation", () => {
    expect(parseAgreedLaborAllocations(null).baseHours).toBeNull();
    expect(parseAgreedLaborAllocations(undefined).byLineKey.size).toBe(0);
    const { baseHours, byLineKey } = parseAgreedLaborAllocations([
      { line_key: "base", hours: Number.NaN as unknown as number },
      { line_key: "job1" } as any,
    ]);
    // NaN is a number, so it's technically kept for base; the guard only drops
    // non-number hours. job1 has no hours → dropped.
    expect(byLineKey.has("job1")).toBe(false);
    expect(Number.isNaN(baseHours as number)).toBe(true);
  });
});

describe("resolveAgreedLaborLines", () => {
  // The reported receipt: CEL diagnosis (catalog 1h) + Oil Change added mid-job
  // and set to 0.4h. Labor subtotal $210 (= 1.4h × $150). The agreed allocation
  // must win over the oil line's stale 17-min estimate.
  const reported = {
    baseServices: [{ name: "Check Engine Light Diagnosis", catalogHours: 1 }],
    customServices: [{ name: "Oil Change", durationMinutes: 17 }],
    customJobs: [
      {
        _id: "job1",
        name: "Oil Change",
        estimated_minutes: 17,
        status: "planned",
      },
    ],
    allocations: [
      { line_key: "base", hours: 1 },
      { line_key: "job1", hours: 0.4 },
    ],
    laborSubtotalDollars: 210,
  };

  it("bills the oil line from the agreed 0.4h, not the 17-min estimate", () => {
    const { lines } = resolveAgreedLaborLines(reported);
    const oil = lines.find((l) => l.name === "Oil Change")!;
    const cel = lines.find((l) => l.name.startsWith("Check Engine"))!;
    // Display hours reflect the agreement, not the 0.2833h estimate.
    expect(oil.laborHours).toBe(0.4);
    expect(cel.laborHours).toBe(1);
    // Dollars split by the agreed ratio 1.0 : 0.4 of $210 → $150 / $60, and each
    // reconciles to hours × $150 exactly.
    expect(cel.laborCost).toBeCloseTo(150, 6);
    expect(oil.laborCost).toBeCloseTo(60, 6);
    // Lines sum to the labor subtotal.
    expect((cel.laborCost ?? 0) + (oil.laborCost ?? 0)).toBeCloseTo(210, 6);
  });

  it("falls back to the line estimate when no allocation was recorded", () => {
    const { lines } = resolveAgreedLaborLines({
      ...reported,
      allocations: null,
    });
    const oil = lines.find((l) => l.name === "Oil Change")!;
    // 17 min → 0.2833h, rounded to 2dp for display.
    expect(oil.laborHours).toBe(0.28);
  });

  it("rounds display hours to 2dp but splits dollars at full precision", () => {
    const { lines } = resolveAgreedLaborLines({
      baseServices: [{ name: "A", catalogHours: 1 }],
      customServices: [{ name: "B", durationMinutes: null }],
      customJobs: [{ _id: "b", name: "B", status: "planned" }],
      allocations: [
        { line_key: "base", hours: 1 },
        { line_key: "b", hours: 0.283333 },
      ],
      laborSubtotalDollars: 192.5,
    });
    const b = lines.find((l) => l.name === "B")!;
    expect(b.laborHours).toBe(0.28); // display rounded
    // Full-precision split: 192.5 × 0.283333 / 1.283333 ≈ 42.5
    expect(b.laborCost).toBeCloseTo(42.5, 2);
  });

  it("ignores a declined custom job's allocation and estimate", () => {
    const { lines } = resolveAgreedLaborLines({
      baseServices: [{ name: "A", catalogHours: 1 }],
      // Caller normally strips declined custom_services; if one slips through,
      // the declined job contributes no id/minutes, so the line has null hours.
      customServices: [{ name: "Declined Work", durationMinutes: null }],
      customJobs: [
        {
          _id: "d",
          name: "Declined Work",
          estimated_minutes: 30,
          status: "declined",
        },
      ],
      allocations: [
        { line_key: "base", hours: 1 },
        { line_key: "d", hours: 0.5 },
      ],
      laborSubtotalDollars: 150,
    });
    const declined = lines.find((l) => l.name === "Declined Work")!;
    expect(declined.laborHours).toBeNull();
    // All labor goes to the one line with hours.
    const a = lines.find((l) => l.name === "A")!;
    expect(a.laborCost).toBeCloseTo(150, 6);
  });

  it("distributes the base lump across multiple booked services by catalog hours", () => {
    const { lines } = resolveAgreedLaborLines({
      baseServices: [
        { name: "Big", catalogHours: 3 },
        { name: "Small", catalogHours: 1 },
      ],
      customServices: [],
      customJobs: [],
      allocations: [{ line_key: "base", hours: 2 }], // agreed base halved
      laborSubtotalDollars: 300,
    });
    const big = lines.find((l) => l.name === "Big")!;
    const small = lines.find((l) => l.name === "Small")!;
    // 2h distributed 3:1 → 1.5h / 0.5h
    expect(big.laborHours).toBe(1.5);
    expect(small.laborHours).toBe(0.5);
    expect(big.laborCost).toBeCloseTo(225, 6);
    expect(small.laborCost).toBeCloseTo(75, 6);
  });
});
