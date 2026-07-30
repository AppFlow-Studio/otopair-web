/**
 * The deterministic reconciler at the heart of the in-house corroboration
 * engine. The law under test: family diversity decides, repetition within a
 * family does not, ties yield NO consensus (gap over guess), humans win.
 */
import { describe, expect, test } from "vitest";
import { reconcileClaims } from "../convex/vehicleEnrichment/sourceAdapters/claimLedger";
import type { Claim, SourceFamily } from "../convex/vehicleEnrichment/sourceAdapters/types";

let n = 0;
function claim(
  value: string,
  family: SourceFamily,
  domain?: string,
  over: Partial<Claim> = {},
): Claim {
  n++;
  return {
    field_key: "oil_filter_oem",
    value,
    source_family: family,
    source_domain: domain ?? `${family}-${n}.example`,
    source_url: `https://${domain ?? `${family}-${n}.example`}/p/${n}`,
    method: "deterministic_parse",
    observed_at: 1_000_000 + n,
    ...over,
  };
}

describe("reconcileClaims", () => {
  test("two independent families agreeing → consensus at 0.85", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("90915-YZZF2", "oem_catalog", "toyota.oempartsonline.com"),
      claim("90915-YZZF2", "aftermarket_catalog", "wixfilters.com"),
    ]);
    expect(r.outcome).toBe("consensus");
    expect(r.value).toBe("90915-YZZF2");
    expect(r.confidence).toBe(0.85);
    expect(r.families.sort()).toEqual(["aftermarket_catalog", "oem_catalog"]);
  });

  test("three families → 0.95", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("90915-YZZF2", "oem_catalog"),
      claim("90915-YZZF2", "aftermarket_catalog"),
      claim("90915-YZZF2", "aggregator", "amsoil.com"),
    ]);
    expect(r.confidence).toBe(0.95);
  });

  test("repetition within ONE family does not beat diversity", () => {
    // Three dealer storefronts (one family, shared upstream) vs one storefront
    // + one aftermarket catalog: diversity wins.
    const r = reconcileClaims("oil_filter_oem", [
      claim("WRONG-1", "oem_catalog", "a.oempartsonline.com"),
      claim("WRONG-1", "oem_catalog", "b.oempartsonline.com"),
      claim("WRONG-1", "oem_catalog", "c.oempartsonline.com"),
      claim("RIGHT-2", "oem_catalog", "d.oempartsonline.com"),
      claim("RIGHT-2", "aftermarket_catalog", "wixfilters.com"),
    ]);
    expect(r.value).toBe("RIGHT-2");
    expect(r.dissent[0].value).toBe("WRONG-1");
  });

  test("cross-family tie → NO consensus (gap over guess)", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog"),
      claim("B-222", "aftermarket_catalog"),
    ]);
    expect(r.outcome).toBe("conflict_tie");
    expect(r.value).toBeNull();
    expect(r.dissent).toHaveLength(2);
  });

  test("domain count never settles a cross-family tie", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog", "a.example"),
      claim("A-111", "oem_catalog", "b.example"),
      claim("B-222", "aftermarket_catalog", "c.example"),
    ]);
    // 1 family each, same best weight (2) — tie despite A's two domains.
    expect(r.outcome).toBe("conflict_tie");
  });

  test("single weak family (web_search) stays below the 0.75 quote gate", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "web_search"),
      claim("A-111", "web_search", "other.example"),
    ]);
    expect(r.outcome).toBe("single_source");
    expect(r.confidence).toBe(0.4);
  });

  test("single strong family also stays below the quote gate", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "aftermarket_catalog"),
    ]);
    expect(r.confidence).toBe(0.6);
  });

  test("dissent knocks confidence down", () => {
    const agree = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog"),
      claim("A-111", "aftermarket_catalog"),
    ]);
    const contested = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog"),
      claim("A-111", "aftermarket_catalog"),
      claim("B-222", "web_search"),
    ]);
    expect(contested.confidence!).toBeLessThan(agree.confidence!);
    expect(contested.value).toBe("A-111"); // still wins: 2 families vs 1
  });

  test("a human claim decides outright at 1.0", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog"),
      claim("A-111", "aftermarket_catalog"),
      claim("HUMAN-9", "human", "director"),
    ]);
    expect(r.outcome).toBe("human");
    expect(r.value).toBe("HUMAN-9");
    expect(r.confidence).toBe(1.0);
  });

  test("deterministic for identical evidence regardless of claim order", () => {
    const claims = [
      claim("A-111", "oem_catalog", "x.example"),
      claim("B-222", "aftermarket_catalog", "y.example"),
      claim("A-111", "aggregator", "z.example"),
    ];
    const fwd = reconcileClaims("oil_filter_oem", claims);
    const rev = reconcileClaims("oil_filter_oem", [...claims].reverse());
    expect(fwd).toEqual(rev);
    expect(fwd.value).toBe("A-111");
  });

  test("empty and foreign-field claims → no_claims", () => {
    const r = reconcileClaims("oil_filter_oem", [
      { ...claim("X", "gov"), field_key: "coolant_capacity_qts" },
    ]);
    expect(r.outcome).toBe("no_claims");
    expect(r.value).toBeNull();
  });
});
