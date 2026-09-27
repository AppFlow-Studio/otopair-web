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

  it("does not double-bill labor when a booked service is also added as a custom line", () => {
    // "Cabin Air Filter" is booked (0.5h) AND slipped in as an off-catalog line
    // that collapses to the same key. The booked line owns the work; the custom
    // duplicate must be dropped so labor isn't apportioned across two lines.
    const { lines, totalHours } = resolveAgreedLaborLines({
      baseServices: [{ name: "Cabin Air Filter", catalogHours: 0.5 }],
      customServices: [{ name: "Cabin air filter", durationMinutes: 30 }],
      customJobs: [
        {
          _id: "job1",
          name: "Cabin air filter",
          estimated_minutes: 30,
          status: "planned",
        },
      ],
      allocations: [{ line_key: "base", hours: 0.5 }],
      laborSubtotalDollars: 75,
    });
    // One line only — the duplicate custom line is skipped.
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("Cabin Air Filter");
    expect(lines[0].laborHours).toBe(0.5);
    // No double-count: the booked line keeps the whole labor subtotal.
    expect(totalHours).toBeCloseTo(0.5, 6);
    expect(lines[0].laborCost).toBeCloseTo(75, 6);
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

// Estimate cycles (pre/mid-job) write `svc:<serviceId>` / `job:<customJobId>`
// keys. The reader used to only know "base" + bare ids, so every estimate-cycle
// agreement was invisible: re-opening "Add unforeseen scope" snapped an Oil
// Change the customer approved at 0.2 hr back to its 0.5 hr estimate.
describe("estimate-cycle labor_allocations (svc:/job: keys)", () => {
  it("parses svc: into byServiceId and strips the job: prefix", () => {
    const { baseHours, byLineKey, byServiceId } = parseAgreedLaborAllocations([
      { line_key: "svc:oil", hours: 0.2 },
      { line_key: "svc:rotate", hours: 0.5 },
      { line_key: "job:job1", hours: 0.3 },
    ]);
    expect(byServiceId.get("oil")).toBe(0.2);
    expect(byServiceId.get("rotate")).toBe(0.5);
    expect(byLineKey.get("job1")).toBe(0.3);
    expect(byLineKey.has("svc:oil")).toBe(false);
    // No "base" row → the booked services' agreed time is their sum.
    expect(baseHours).toBeCloseTo(0.7);
  });

  it("keeps the post-job shape unchanged", () => {
    const { baseHours, byLineKey, byServiceId } = parseAgreedLaborAllocations([
      { line_key: "base", hours: 1 },
      { line_key: "job1", hours: 0.4 },
    ]);
    expect(baseHours).toBe(1);
    expect(byLineKey.get("job1")).toBe(0.4);
    expect(byServiceId.size).toBe(0);
  });

  it("bills booked + added lines at their agreed hours, not catalog", () => {
    const { lines, totalHours } = resolveAgreedLaborLines({
      baseServices: [
        { name: "Oil Change", catalogHours: 0.5, serviceId: "oil" },
      ],
      customServices: [{ name: "Diagnostic Scan", durationMinutes: 30 }],
      customJobs: [
        {
          _id: "job1",
          name: "Diagnostic Scan",
          estimated_minutes: 30,
          status: "planned",
        },
      ],
      allocations: [
        { line_key: "svc:oil", hours: 0.2 },
        { line_key: "job:job1", hours: 0.2 },
      ],
      laborSubtotalDollars: 60,
    });
    expect(totalHours).toBeCloseTo(0.4);
    expect(lines.map((l) => [l.name, l.laborHours, l.laborCost])).toEqual([
      ["Oil Change", 0.2, 30],
      ["Diagnostic Scan", 0.2, 30],
    ]);
  });

  it("a booked service without its own svc: row keeps catalog hours", () => {
    const { lines } = resolveAgreedLaborLines({
      baseServices: [
        { name: "Oil Change", catalogHours: 0.5, serviceId: "oil" },
        { name: "Tire Rotation", catalogHours: 0.4, serviceId: "rotate" },
      ],
      customServices: [],
      customJobs: [],
      allocations: [{ line_key: "svc:oil", hours: 0.2 }],
      laborSubtotalDollars: null,
    });
    expect(lines.map((l) => l.laborHours)).toEqual([0.2, 0.4]);
  });
});
