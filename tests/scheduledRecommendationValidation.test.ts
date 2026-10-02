import { describe, expect, test } from "vitest";
import { isSchedulableRecommendation } from "../lib/scheduled-recommendation-validation";

describe("isSchedulableRecommendation", () => {
  test("rejects a scheduled follow-up without a catalog service", () => {
    expect(
      isSchedulableRecommendation({
        recommendedServiceId: null,
        scheduledAt: new Date(2026, 8, 27, 19, 0).getTime(),
      }),
    ).toBe(false);
  });

  test("allows an unscheduled advisory", () => {
    expect(
      isSchedulableRecommendation({
        recommendedServiceId: null,
        scheduledAt: null,
      }),
    ).toBe(true);
  });

  test("allows a catalog service with a scheduled time", () => {
    expect(
      isSchedulableRecommendation({
        recommendedServiceId: "service_123",
        scheduledAt: new Date(2026, 8, 27, 19, 0).getTime(),
      }),
    ).toBe(true);
  });
});
