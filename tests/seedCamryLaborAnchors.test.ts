// tests/seedCamryLaborAnchors.test.ts
import { describe, it, expect } from "vitest";
import { CAMRY_LABOR_HOURS } from "../convex/seeds/seedCamryBaseline";

describe("Camry labor anchors", () => {
  it("includes the 2 previously-missing anchors so the fallback exists for them", () => {
    const slugs = new Set(CAMRY_LABOR_HOURS.map((r) => r.service_slug));
    expect(slugs.has("rotor_replacement")).toBe(true);
    expect(slugs.has("power_steering_flush")).toBe(true);
  });

  it("does NOT seed timing_belt (deferred to Phase 2's timing-aware floor)", () => {
    const slugs = new Set(CAMRY_LABOR_HOURS.map((r) => r.service_slug));
    expect(slugs.has("timing_belt")).toBe(false);
  });
});
