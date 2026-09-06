import { expect, test } from "vitest";

import {
  OTHER_QUOTE_BRAND,
  customQuoteBrandInputValue,
  isCustomQuoteBrand,
  isQuoteBrandReady,
  nextQuoteBrandValue,
} from "../lib/quote-brand-selection";

test("Other selection opens a blank custom brand input that must be filled before submission", () => {
  const selected = nextQuoteBrandValue(OTHER_QUOTE_BRAND);

  expect(selected).toBe(OTHER_QUOTE_BRAND);
  expect(isCustomQuoteBrand(selected, ["michelin", "brembo", "bosch"])).toBe(true);
  expect(customQuoteBrandInputValue(selected)).toBe("");
  expect(isQuoteBrandReady(selected)).toBe(false);
  expect(isQuoteBrandReady("RoadX")).toBe(true);
});
