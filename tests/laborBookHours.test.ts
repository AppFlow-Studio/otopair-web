import { describe, it, expect } from "vitest";
import { resolveBookHours } from "../convex/lib/labor_aggregation";

describe("resolveBookHours — repairpal_endpoint precedence", () => {
  it("uses the repairpal_endpoint value as the face value, even vs disagreeing lower sources", () => {
    const catalog = [
      { hours: 6.1, weight: 0.9, source: "repairpal_endpoint" },
      { hours: 1.0, weight: 0.7, source: "olp_labor" },
      { hours: 1.0, weight: 0.6, source: "web_labor" },
    ];
    expect(resolveBookHours(catalog)).toBe(6.1);
  });

  it("falls back to the weighted median when no endpoint observation exists", () => {
    const catalog = [
      { hours: 1.0, weight: 0.7, source: "olp_labor" },
      { hours: 1.4, weight: 0.6, source: "web_labor" },
      { hours: 3.0, weight: 0.3, source: "llm_web" },
    ];
    // total 1.6, half 0.8; sorted [1.0(0.7), 1.4(0.6), 3.0(0.3)] -> cum 0.7, 1.3>=0.8 -> 1.4
    expect(resolveBookHours(catalog)).toBe(1.4);
  });

  it("clamps the endpoint value to sane bounds", () => {
    expect(resolveBookHours([{ hours: 0.02, weight: 0.9, source: "repairpal_endpoint" }])).toBe(0.1);
    expect(resolveBookHours([{ hours: 12, weight: 0.9, source: "repairpal_endpoint" }])).toBe(8.0);
  });

  it("ignores a non-positive endpoint observation and falls to the median", () => {
    const catalog = [
      { hours: 0, weight: 0.9, source: "repairpal_endpoint" },
      { hours: 1.0, weight: 0.7, source: "olp_labor" },
    ];
    expect(resolveBookHours(catalog)).toBe(1.0);
  });
});
