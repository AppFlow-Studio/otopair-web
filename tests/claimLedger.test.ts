/**
 * The deterministic reconciler at the heart of the in-house corroboration
 * engine. The law under test: family diversity decides, repetition within a
 * family does not, ties yield NO consensus (gap over guess), humans win.
 */
import { describe, expect, test } from "vitest";
import {
  reconcileClaims,
  resolveOperator,
} from "../convex/vehicleEnrichment/sourceAdapters/claimLedger";
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

/**
 * Operator collapse. Four Parts Giant storefronts are four brands on ONE
 * catalog backend; counting them as four voices would fabricate exactly the
 * fitment consensus this ledger exists to prevent.
 */
describe("resolveOperator", () => {
  test("the Parts Giant siblings all resolve to one operator", () => {
    for (const d of [
      "toyotapartsdeal.com",
      "fordpartsgiant.com",
      "nissanpartsdeal.com",
      "gmpartsgiant.com",
      "www.bmwpartsdeal.com",
      "hyundaipartsdeal.com",
      "partsgiant.com",
    ]) {
      expect(resolveOperator(d)).toBe("original_parts_giant");
    }
  });

  test("RevolutionParts hosts resolve to one operator", () => {
    for (const d of [
      "oempartsonline.com",
      "toyota.oempartsonline.com",
      "g.oempartsonline.com",
      "www.ford.oempartsonline.com",
    ]) {
      expect(resolveOperator(d)).toBe("revolutionparts");
    }
  });

  test("an unmapped host is its own operator, at its registrable domain", () => {
    expect(resolveOperator("wixfilters.com")).toBe("wixfilters.com");
    expect(resolveOperator("www.wixfilters.com")).toBe("wixfilters.com");
    expect(resolveOperator("catalog.wixfilters.com")).toBe("wixfilters.com");
    expect(resolveOperator("brembo.com")).toBe("brembo.com");
  });

  test("a lookalike suffix does not get to claim the operator", () => {
    expect(resolveOperator("bestpartsdealer.com")).toBe("bestpartsdealer.com");
    expect(resolveOperator("partsdeal.com.example.org")).toBe("example.org");
  });

  test("multi-label suffixes do not fuse unrelated sources", () => {
    expect(resolveOperator("shop.alpha.co.uk")).toBe("alpha.co.uk");
    expect(resolveOperator("beta.co.uk")).toBe("beta.co.uk");
    expect(resolveOperator("shop.alpha.co.uk")).not.toBe(
      resolveOperator("beta.co.uk"),
    );
  });

  test("total on mis-shaped input — never throws, always a stable key", () => {
    expect(resolveOperator("https://toyota.oempartsonline.com/oem-parts/x"))
      .toBe("revolutionparts");
    expect(resolveOperator("  WWW.ToyotaPartsDeal.com:443  "))
      .toBe("original_parts_giant");
    expect(resolveOperator("toyotapartsdeal.com.")).toBe("original_parts_giant");
    expect(resolveOperator("")).toBe("");
  });

  test("an unconfirmed dealer storefront stays its own voice (known limit)", () => {
    // RevolutionParts powers thousands of dealer-branded domains whose
    // hostnames carry no signature. We under-collapse rather than collapse on
    // suspicion; the ledger's tie rule bounds what that can cost.
    expect(resolveOperator("parts.somedealer.com")).toBe("somedealer.com");
  });
});

describe("reconcileClaims — operator collapse", () => {
  test("four Parts Giant domains are ONE voice, not four", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("PG-1", "oem_catalog", "toyotapartsdeal.com"),
      claim("PG-1", "oem_catalog", "fordpartsgiant.com"),
      claim("PG-1", "oem_catalog", "nissanpartsdeal.com"),
      claim("PG-1", "oem_catalog", "gmpartsgiant.com"),
    ]);
    expect(r.operators).toEqual(["original_parts_giant"]);
    // The hostnames are still on the record — audit keeps what scoring ignores.
    expect(r.domains).toHaveLength(4);
    expect(r.outcome).toBe("single_source");
  });

  test("four Parts Giant domains cannot out-rank one independent source", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("WRONG-1", "oem_catalog", "toyotapartsdeal.com"),
      claim("WRONG-1", "oem_catalog", "fordpartsgiant.com"),
      claim("WRONG-1", "oem_catalog", "nissanpartsdeal.com"),
      claim("WRONG-1", "oem_catalog", "gmpartsgiant.com"),
      claim("RIGHT-2", "aftermarket_catalog", "wixfilters.com"),
    ]);
    // One family and one best-weight each: no consensus, and the four
    // storefronts buy no advantage at all.
    expect(r.outcome).toBe("conflict_tie");
    expect(r.value).toBeNull();
    const pg = r.dissent.find((d) => d.value === "WRONG-1")!;
    const wix = r.dissent.find((d) => d.value === "RIGHT-2")!;
    expect(pg.operators).toEqual(["original_parts_giant"]);
    expect(pg.operators.length).toBe(wix.operators.length);
    expect(pg.domains).toHaveLength(4);
  });

  test("two genuinely independent domains in one family still count as two", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "aftermarket_catalog", "wixfilters.com"),
      claim("A-111", "aftermarket_catalog", "brembo.com"),
    ]);
    expect(r.operators).toEqual(["brembo.com", "wixfilters.com"]);
    expect(r.value).toBe("A-111");
  });

  test("sibling storefronts collapse where independents do not", () => {
    const siblings = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog", "toyotapartsdeal.com"),
      claim("A-111", "oem_catalog", "gmpartsgiant.com"),
    ]);
    const independents = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog", "parts.toyota.com"),
      claim("A-111", "oem_catalog", "parts.gm.com"),
    ]);
    expect(siblings.operators).toHaveLength(1);
    expect(independents.operators).toHaveLength(2);
    // Neither reaches the quote gate on one family — collapse changes the voice
    // count, never the family math.
    expect(siblings.confidence).toBe(independents.confidence);
  });

  test("RevolutionParts storefronts collapse across dealer subdomains", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog", "toyota.oempartsonline.com"),
      claim("A-111", "oem_catalog", "ford.oempartsonline.com"),
      claim("A-111", "oem_catalog", "g.oempartsonline.com"),
    ]);
    expect(r.operators).toEqual(["revolutionparts"]);
    expect(r.domains).toHaveLength(3);
  });

  test("operator count never settles a cross-family tie", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("A-111", "oem_catalog", "parts.toyota.com"),
      claim("A-111", "oem_catalog", "parts.gm.com"),
      claim("B-222", "aftermarket_catalog", "wixfilters.com"),
    ]);
    // Two REAL operators behind A-111, and it still does not win: one family
    // and one best-weight each is a tie, and a tie is a gap.
    expect(r.outcome).toBe("conflict_tie");
    expect(r.value).toBeNull();
  });

  test("cross-family diversity still beats a collapsed sibling block", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("WRONG-1", "oem_catalog", "toyotapartsdeal.com"),
      claim("WRONG-1", "oem_catalog", "fordpartsgiant.com"),
      claim("WRONG-1", "oem_catalog", "nissanpartsdeal.com"),
      claim("RIGHT-2", "oem_catalog", "gmpartsgiant.com"),
      claim("RIGHT-2", "aftermarket_catalog", "wixfilters.com"),
    ]);
    expect(r.value).toBe("RIGHT-2");
    expect(r.families).toEqual(["aftermarket_catalog", "oem_catalog"]);
    expect(r.operators).toEqual(["original_parts_giant", "wixfilters.com"]);
    expect(r.dissent[0].value).toBe("WRONG-1");
  });

  test("collapse is deterministic and order-independent", () => {
    const claims = [
      claim("A-111", "oem_catalog", "toyotapartsdeal.com"),
      claim("A-111", "oem_catalog", "gmpartsgiant.com"),
      claim("A-111", "aggregator", "amsoil.com"),
      claim("B-222", "aftermarket_catalog", "wixfilters.com"),
    ];
    const fwd = reconcileClaims("oil_filter_oem", claims);
    const rev = reconcileClaims("oil_filter_oem", [...claims].reverse());
    expect(fwd).toEqual(rev);
    expect(fwd.value).toBe("A-111");
    expect(fwd.operators).toEqual(["amsoil.com", "original_parts_giant"]);
  });

  test("a human claim still decides outright, operator recorded", () => {
    const r = reconcileClaims("oil_filter_oem", [
      claim("PG-1", "oem_catalog", "toyotapartsdeal.com"),
      claim("PG-1", "oem_catalog", "gmpartsgiant.com"),
      claim("HUMAN-9", "human", "director"),
    ]);
    expect(r.outcome).toBe("human");
    expect(r.value).toBe("HUMAN-9");
    expect(r.operators).toEqual(["director"]);
  });
});
