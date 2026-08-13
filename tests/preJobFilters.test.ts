import { describe, expect, test } from "vitest";

import {
  FILTER_STATUSES,
  filterStatusLabel,
  isFilterStatus,
} from "../lib/vehicle-passport";

describe("pre-job filter status contract", () => {
  test("exposes the statuses used by engine and cabin air filter checks", () => {
    expect(FILTER_STATUSES).toEqual([
      "not_checked",
      "looks_clean",
      "fair",
      "recommend_replace",
    ]);
  });

  test("labels filter statuses for mechanic-facing selects", () => {
    expect(filterStatusLabel("not_checked")).toBe("Not checked");
    expect(filterStatusLabel("looks_clean")).toBe("Looks clean");
    expect(filterStatusLabel("fair")).toBe("Fair");
    expect(filterStatusLabel("recommend_replace")).toBe("Recommend replacement");
    expect(filterStatusLabel("")).toBe("Select...");
  });

  test("guards unknown filter statuses", () => {
    expect(isFilterStatus("fair")).toBe(true);
    expect(isFilterStatus("dirty_serviceable")).toBe(false);
    expect(isFilterStatus("replaced")).toBe(false);
    expect(isFilterStatus("not_accessible")).toBe(false);
    expect(isFilterStatus("fuel_filter")).toBe(false);
  });
});
