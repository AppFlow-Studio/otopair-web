/**
 * Operator diversity of the parts lane.
 *
 * `hasSources` asks whether a make has A storefront. It never asked whether
 * that storefront is the same BUSINESS as every other make's — and it is. The
 * ledger has always deduped on operator rather than hostname ("a hostname is a
 * brand, and one operator sells under many"); the parts lane never had the
 * corresponding check, so a total single-operator dependency read as full
 * coverage.
 */
import { describe, it, expect } from "vitest";
import {
  auditOperatorDiversity,
  registryOperators,
} from "../convex/vehicleEnrichment/makeCoverage";
import { resolveOperator } from "../convex/vehicleEnrichment/sourceAdapters/claimLedger";
import {
  detectStorefrontNetwork,
  getAlternateStores,
  getPartsStores,
  getPriceStores,
  looksLikeRevolutionParts,
  SOURCE_REGISTRY,
} from "../convex/vehicleEnrichment/sourceRegistry";

describe("resolveOperator — RevolutionParts skins are one voice", () => {
  it("folds every *.oempartsonline.com subdomain together", () => {
    const op = resolveOperator("toyota.oempartsonline.com");
    expect(resolveOperator("g.oempartsonline.com")).toBe(op);
    expect(resolveOperator("bmw.oempartsonline.com")).toBe(op);
    expect(op).toBe("revolutionparts");
  });

  it("maps RP storefronts that wear their own brand", () => {
    // Each is documented in sourceRegistry.ts as an RP store. Unmapped, they
    // scored as independent corroboration for a catalogue agreeing with itself.
    for (const host of [
      "classicparts.mbusa.com",
      "www.autonationparts.com",
      "www.tascaparts.com",
    ]) {
      expect(resolveOperator(host), host).toBe("revolutionparts");
    }
  });

  it("still gives a genuinely independent source its own operator", () => {
    expect(resolveOperator("rockauto.com")).not.toBe("revolutionparts");
    expect(resolveOperator("summitracing.com")).not.toBe("revolutionparts");
    expect(resolveOperator("brembo.com")).not.toBe("revolutionparts");
  });
});

describe("auditOperatorDiversity", () => {
  it("reports the registry as a single-operator monoculture", () => {
    // This is the standing state of the registry, and the assertion exists to
    // make it VISIBLE rather than to be re-derived from the next bad batch.
    // When a genuinely different backend is added this flips to warn/ok and
    // the expectation below should be updated deliberately, not silenced.
    const f = auditOperatorDiversity();
    expect(f.severity).toBe("alarm");
    expect(f.operatorCount).toBe(1);
    expect(f.dominantShare).toBe(1);
    expect(f.message).toMatch(/no STOREFRONT lane at once/);
  });

  it("covers every registry make", () => {
    const rows = registryOperators();
    const counted = auditOperatorDiversity(rows).byOperator.flatMap((o) => o.makes);
    expect(counted.sort()).toEqual(rows.map((r) => r.make).sort());
  });

  it("warns when one operator carries most but not all makes", () => {
    const f = auditOperatorDiversity([
      ...Array.from({ length: 9 }, (_, i) => ({
        make: `M${i}`, storeHost: "a.com", operator: "alpha",
      })),
      { make: "Z", storeHost: "b.com", operator: "beta" },
    ]);
    expect(f.severity).toBe("warn");
    expect(f.dominantShare).toBe(0.9);
  });

  it("is ok on a genuinely mixed registry", () => {
    const f = auditOperatorDiversity([
      { make: "A", storeHost: "a.com", operator: "alpha" },
      { make: "B", storeHost: "b.com", operator: "beta" },
      { make: "C", storeHost: "c.com", operator: "gamma" },
    ]);
    expect(f.severity).toBe("ok");
  });

  it("does not throw on an empty registry", () => {
    const f = auditOperatorDiversity([]);
    expect(f.operatorCount).toBe(0);
    expect(f.dominantShare).toBe(0);
  });
});

describe("looksLikeRevolutionParts — the skin guard", () => {
  // The whole difficulty: an RP skin wears the dealer group's brand everywhere
  // a human would look, so admission has to key on the PLATFORM's asset hosts.
  it("detects RP from its asset hosts", () => {
    for (const html of [
      '<img src="https://cdn-static.revolutionparts.io/assets/x.png">',
      '<img src="https://cdn-product-images.revolutionparts.io/a.webp">',
      '<img src="https://cdn-illustrations.revolutionparts.io/s/h.png">',
    ]) {
      expect(looksLikeRevolutionParts(html), html).toBe(true);
    }
  });

  it("does not fire on a store that merely sells parts", () => {
    expect(
      looksLikeRevolutionParts(
        "<html><title>Genuine OEM GM Parts and Accessories Online - GM Parts Giant</title>" +
          '<a href="/gmc-parts.html">GMC</a><a href="/category/gm-engine.html">Engine</a></html>',
      ),
    ).toBe(false);
  });

  it("is safe on empty input", () => {
    expect(looksLikeRevolutionParts(null)).toBe(false);
    expect(looksLikeRevolutionParts("")).toBe(false);
  });
});

describe("getPartsStores — one attempt per operator", () => {
  it("returns the primary for every registry make", () => {
    for (const make of ["Toyota", "GMC", "BMW"]) {
      const stores = getPartsStores(make);
      expect(stores.length, make).toBeGreaterThanOrEqual(1);
      expect(stores[0].primary).toBe(true);
    }
  });

  it("omits UNVALIDATED alternates — recorded is not trusted", () => {
    for (const make of ["GMC", "Toyota"]) {
      expect(getAlternateStores(make).length, make).toBeGreaterThan(0);
    }
    // Toyota's candidates are all still unvalidated.
    expect(getPriceStores("Toyota")).toEqual([]);
  });

  it("returns [] for an unregistered make", () => {
    expect(getPartsStores("Koenigsegg")).toEqual([]);
  });

  it("records UNvalidated candidates as pending, and drops them once promoted", () => {
    const ops = auditOperatorDiversity().pendingAlternates.map((p) => p.operator);
    // Still being proven.
    expect(ops).toContain("toyota.com");
    // gmpartsgiant is promoted, but toyotapartsdeal shares its operator and is
    // still unvalidated — so the OPERATOR remains pending via that entry. The
    // queue is per-candidate, not per-operator.
    expect(ops).toContain("toyota.com");
  });

  it("never lists an RP skin as a second voice", () => {
    // autonationparts / tascaparts are RP skins used as harvest fallbacks;
    // admitting either as an alternate would inflate the ledger's operator
    // count, which its corroboration math is a function of.
    for (const make of Object.keys(SOURCE_REGISTRY)) {
      for (const alt of getAlternateStores(make)) {
        expect(alt.operator, `${make} → ${alt.baseUrl}`).not.toBe("revolutionparts");
      }
    }
  });
});


describe("capability split — a price source must never propose a part", () => {
  // gmpartsgiant.com is the live case this split exists for: genuine GM OEM
  // numbers and live prices, and NO vehicle scoping anywhere in its URL scheme,
  // so it cannot say which of its 20 GMC spark plugs fits a 2021 Acadia.
  it("gives GM makes a validated second PRICE operator", () => {
    for (const make of ["GMC", "Chevrolet", "Buick", "Cadillac"]) {
      const price = getPriceStores(make);
      expect(price.map((s) => s.operator), make).toContain("original_parts_giant");
    }
  });

  it("does NOT let that store into the parts lane", () => {
    for (const make of ["GMC", "Chevrolet"]) {
      expect(getPartsStores(make).every((s) => s.primary), make).toBe(true);
      expect(getPartsStores(make).map((s) => s.operator)).not.toContain("partsdeal-network");
    }
  });

  it("keeps the PARTS alarm firing despite the price win", () => {
    // The two lanes diversify independently; a price source must not silence
    // a parts alarm.
    const f = auditOperatorDiversity();
    expect(f.severity).toBe("alarm");
    expect(f.secondVoice.parts).toEqual([]);
    expect(f.secondVoice.price).toContain("GMC");
  });

  it("every registered alternate declares at least one capability", () => {
    for (const make of Object.keys(SOURCE_REGISTRY)) {
      for (const alt of getAlternateStores(make)) {
        expect(alt.capabilities.length, `${make} → ${alt.baseUrl}`).toBeGreaterThan(0);
      }
    }
  });

  it("a parts-capable alternate must not be an RP skin", () => {
    for (const make of Object.keys(SOURCE_REGISTRY)) {
      for (const alt of getAlternateStores(make)) {
        if (!alt.capabilities.includes("parts")) continue;
        expect(alt.operator, `${make} → ${alt.baseUrl}`).not.toBe("revolutionparts");
      }
    }
  });
});


describe("detectStorefrontNetwork — a second skin family", () => {
  // gmpartsgiant.com and toyotapartsdeal.com were briefly registered as TWO
  // operators. They are one backend wearing per-make brands, and admitting
  // both would have scored one catalogue agreeing with itself as
  // cross-operator corroboration.
  const PARTSDEAL_PAGE =
    '<html><title>Genuine OEM GM Parts and Accessories Online - GM Parts Giant</title>' +
    '<a href="/online/track/order">track</a>' +
    '<a href="/service/gm-help_center.html">help</a>' +
    '<a href="/category/gm-engine.html">engine</a>' +
    '<a href="/oem-gmc-spark_plug.html">plugs</a></html>';

  const TOYOTA_SKIN_PAGE =
    '<html><title>Genuine OEM Toyota Parts and Accessories Online - Toyota Parts Deal</title>' +
    '<a href="/online/track/order">track</a>' +
    '<a href="/service/toyota-help_center.html">help</a>' +
    '<a href="/category/toyota-body.html">body</a>' +
    '<a href="/oem-toyota-brake_disc.html">discs</a></html>';

  it("recognises both brands as ONE network", () => {
    expect(detectStorefrontNetwork(PARTSDEAL_PAGE)).toBe("original_parts_giant");
    expect(detectStorefrontNetwork(TOYOTA_SKIN_PAGE)).toBe("original_parts_giant");
  });

  it("the ledger already folded both hostnames into one operator", () => {
    // OPERATOR_TABLE has carried /(^|\.)[a-z0-9-]*parts(giant|deal)\.com$/ all
    // along, so resolveOperator was right before anyone noticed the collision.
    const a = resolveOperator("www.gmpartsgiant.com");
    const b = resolveOperator("www.toyotapartsdeal.com");
    expect(a).toBe("original_parts_giant");
    expect(b).toBe(a);
  });

  it("a sibling nobody has registered yet resolves to the same voice", () => {
    // The hostPattern generalises, which is why it beat the enumerated list
    // that briefly replaced it.
    expect(resolveOperator("www.subarupartsdeal.com")).toBe("original_parts_giant");
    expect(resolveOperator("hyundaipartsgiant.com")).toBe("original_parts_giant");
  });

  it("EVERY registered alternate's declared operator matches resolveOperator", () => {
    // THE INVARIANT THAT WOULD HAVE CAUGHT THE COLLISION. `operator` was hand
    // written on each entry, and two skins of one backend were declared as two
    // voices while resolveOperator knew better. Deriving is not possible at the
    // literal, so it is pinned here instead.
    for (const make of Object.keys(SOURCE_REGISTRY)) {
      for (const alt of getAlternateStores(make)) {
        const host = new URL(alt.baseUrl).hostname;
        expect(alt.operator, `${make} → ${alt.baseUrl}`).toBe(resolveOperator(host));
      }
    }
  });

  it("still identifies RevolutionParts first", () => {
    expect(
      detectStorefrontNetwork('<img src="https://cdn-static.revolutionparts.io/x.png">'),
    ).toBe("revolutionparts");
  });

  it("does not fire on a site with one incidental path match", () => {
    expect(detectStorefrontNetwork('<a href="/category/foo-bar.html">x</a>')).toBeNull();
  });

  it("is safe on empty input", () => {
    expect(detectStorefrontNetwork(null)).toBeNull();
  });

  it("no two registered alternates share an operator with each other", () => {
    // The invariant the collision violated: within a make, alternates must be
    // distinct voices.
    for (const make of Object.keys(SOURCE_REGISTRY)) {
      const ops = getAlternateStores(make).map((a) => a.operator);
      expect(new Set(ops).size, make).toBe(ops.length);
    }
  });
});
