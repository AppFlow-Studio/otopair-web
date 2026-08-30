import { expect, test } from "vitest";

import { shouldShowShopQuoteRequest } from "../lib/quoteRequestVisibility";

test("shop quote lists hide expired rows but keep cancelled rows", () => {
  expect(shouldShowShopQuoteRequest("expired")).toBe(false);
  expect(shouldShowShopQuoteRequest("cancelled")).toBe(true);
  expect(shouldShowShopQuoteRequest("pending")).toBe(true);
  expect(shouldShowShopQuoteRequest("open")).toBe(true);
});
