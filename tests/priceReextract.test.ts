// =============================================================================
// priceReextract unit tests — the PURE core of the domain-agnostic Tier-2
// (LLM) price fallback.
// =============================================================================
//
// These prove the three pure pieces that make the LLM fallback safe, WITHOUT
// hitting the network:
//
//   1. buildLlmPricePrompt   — the prompt that DEFEATS the original bug: it must
//      explicitly forbid the MSRP / list / struck-through / "You Save" figures
//      and ask only for the price the customer pays right now.
//   2. parseLlmPriceResponse — coerce the model's JSON into {price, msrp, oem}.
//   3. validateLlmPrice      — guardrails so a hallucinated/garbage number can't
//      re-poison the median (price>0, price<msrp, oem matches, within a band of
//      the cross-source median).
//
//   npx vitest run tests/priceReextract.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  buildLlmPricePrompt,
  parseLlmPriceResponse,
  validateLlmPrice,
} from "../convex/vehicleEnrichment/priceParser";

describe("buildLlmPricePrompt — defeats the discount bug by construction", () => {
  it("forbids MSRP / was / struck-through / You-Save and asks for the real current price", () => {
    const { system, userPrompt } = buildLlmPricePrompt({
      oem: "5Q0698451",
      partName: "Front Brake Pad Set",
      pageText: "AutoZone — Front Brake Pads UNIQUE_FIXTURE_TOKEN $34.97",
    });

    const s = system.toLowerCase();
    // The crux: every trap the original prompt failed to exclude.
    expect(s).toContain("msrp");
    expect(s).toContain("you save");
    expect(s).toMatch(/struck|strike|line.?through|list|was price/);
    // Must ask for the price actually paid / final sale price, and allow null.
    expect(s).toMatch(/actually pay|final|current|sale price/);
    expect(s).toContain("null");

    // The user prompt must carry the target OEM and the page text to read from.
    expect(userPrompt).toContain("5Q0698451");
    expect(userPrompt).toContain("UNIQUE_FIXTURE_TOKEN");
  });

  it("asks the model to also echo the MSRP and the OEM it saw (for guardrails)", () => {
    const { system } = buildLlmPricePrompt({ oem: "ABC123", pageText: "x" });
    const s = system.toLowerCase();
    expect(s).toContain("price");
    expect(s).toContain("msrp");
    expect(s).toContain("oem");
  });
});

describe("parseLlmPriceResponse — coerces the model JSON", () => {
  it("reads a bare numeric price", () => {
    expect(parseLlmPriceResponse({ price: 34.97 })).toEqual({
      price: 34.97,
      msrp: null,
      oem_seen: null,
    });
  });

  it("coerces string price/msrp (with currency noise) and keeps the raw oem", () => {
    const out = parseLlmPriceResponse({
      price: "$34.97",
      msrp: "59.99",
      oem: "5Q0 698 451 A",
    });
    expect(out.price).toBe(34.97);
    expect(out.msrp).toBe(59.99);
    expect(out.oem_seen).toBe("5Q0 698 451 A");
  });

  it("returns null price for an explicit null, non-positive, or garbage", () => {
    expect(parseLlmPriceResponse({ price: null }).price).toBeNull();
    expect(parseLlmPriceResponse({ price: 0 }).price).toBeNull();
    expect(parseLlmPriceResponse({ price: -5 }).price).toBeNull();
    expect(parseLlmPriceResponse({}).price).toBeNull();
    expect(parseLlmPriceResponse(null).price).toBeNull();
    expect(parseLlmPriceResponse("not json" as any).price).toBeNull();
  });
});

describe("validateLlmPrice — guardrails keep garbage out of the median", () => {
  it("accepts a plausible price (below MSRP, oem matches, near the median)", () => {
    const r = validateLlmPrice({
      price: 34.97,
      msrp: 59.99,
      oemSeen: "5Q0 698 451 A",
      oem: "5Q0698451A",
      crossSourceMedian: 33.0,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing or non-positive price", () => {
    expect(validateLlmPrice({ price: null, oem: "X1234" }).ok).toBe(false);
    expect(validateLlmPrice({ price: 0, oem: "X1234" }).ok).toBe(false);
  });

  it("rejects a price >= the MSRP it reported (it grabbed the list/MSRP)", () => {
    const r = validateLlmPrice({ price: 139.33, msrp: 139.33, oem: "X1234" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/msrp/i);
  });

  it("rejects when the OEM the model saw is a different part", () => {
    const r = validateLlmPrice({
      price: 20,
      oemSeen: "99999999",
      oem: "5Q0698451A",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/oem/i);
  });

  it("rejects an implausible outlier vs the cross-source median (>3x or <0.3x)", () => {
    expect(
      validateLlmPrice({ price: 400, oem: "X1234", crossSourceMedian: 35 }).ok,
    ).toBe(false);
    expect(
      validateLlmPrice({ price: 3, oem: "X1234", crossSourceMedian: 35 }).ok,
    ).toBe(false);
  });

  it("skips the optional checks when msrp / oemSeen / median are absent", () => {
    // Only a positive price known — should pass (nothing to contradict it).
    const r = validateLlmPrice({ price: 34.97, oem: "X1234" });
    expect(r.ok).toBe(true);
  });
});
