// =============================================================================
// priceParser unit tests — deterministic OEM price extraction
// =============================================================================
//
// Proves the parser returns the REAL sale price (JSON-LD / .price-section-price)
// and NEVER the MSRP (.price-section-retail) or the "You Save $X" figure
// (.price-section-save) — the exact bug that made the pipeline quote $11 instead
// of $104. Fixtures mirror the live RevolutionParts markup (bmwpartsdeal.com,
// toyotapartsdeal.com, *.oempartsonline.com).
//
//   npx vitest run tests/priceParser.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import { parsePartPrices, normalizeOemNumber } from "../convex/vehicleEnrichment/priceParser";

const PARTSDEAL_URL = "https://www.bmwpartsdeal.com/oem-bmw-x5-oil_filter.html";
const OEMPARTSONLINE_URL = "https://ford.oempartsonline.com/oem-ford-f-150-oil_filter.html";

/** A RevolutionParts page: JSON-LD has the real price; DOM has MSRP + You Save traps. */
function partsdealHtml(opts: { mpn: string; jsonLdPrice: string; msrp: string; save: string }): string {
  return `<!doctype html><html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"Genuine BMW Oil Filter",
     "mpn":"${opts.mpn}","offers":{"@type":"Offer","price":"${opts.jsonLdPrice}","priceCurrency":"USD",
     "availability":"https://schema.org/InStock"}}
    </script>
    </head><body>
      <div class="fpc-price-wrap">
        <span class="price-section-retail" style="text-decoration:line-through">MSRP $${opts.msrp}</span>
        <span class="price-section-price">$${opts.jsonLdPrice}</span>
        <span class="price-section-save">You Save $${opts.save}</span>
      </div>
    </body></html>`;
}

describe("parsePartPrices — JSON-LD primary", () => {
  it("returns the real sale price, not the MSRP or the You-Save figure", () => {
    const html = partsdealHtml({ mpn: "11427953129", jsonLdPrice: "104.50", msrp: "139.33", save: "34.83" });
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(104.5);
    expect(out[0].oem_part_number).toBe("11427953129");
    expect(out[0].source_domain).toBe("bmwpartsdeal.com");
    expect(out[0].price_type).toBe("sale");
    // Never the trap values.
    expect(out.map((p) => p.price)).not.toContain(34.83);
    expect(out.map((p) => p.price)).not.toContain(139.33);
  });

  it("coerces a numeric JSON-LD price (oempartsonline style)", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","sku":"FL-820-S","offers":{"price":17.67,"priceCurrency":"USD"}}
      </script>`;
    const out = parsePartPrices(html, OEMPARTSONLINE_URL);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(17.67);
    expect(out[0].oem_part_number).toBe("FL820S"); // normalized
    expect(out[0].source_domain).toBe("ford.oempartsonline.com");
  });

  it("handles @graph arrays and multiple priced products", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Product","mpn":"11427953129","offers":{"price":"104.50","priceCurrency":"USD"}},
        {"@type":"Product","mpn":"64119237555","offers":{"price":"42.10","priceCurrency":"USD"}}
      ]}</script>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out).toHaveLength(2);
    const byNum = Object.fromEntries(out.map((p) => [p.oem_part_number, p.price]));
    expect(byNum["11427953129"]).toBe(104.5);
    expect(byNum["64119237555"]).toBe(42.1);
  });

  it("skips cross-sell products that lack an OEM number (no guessing)", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[
        {"@type":"Product","mpn":"11427953129","offers":{"price":"104.50"}},
        {"@type":"Product","name":"Universal Funnel","offers":{"price":"3.99"}}
      ]}</script>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out).toHaveLength(1);
    expect(out[0].oem_part_number).toBe("11427953129");
    expect(out.map((p) => p.price)).not.toContain(3.99);
  });

  it("reads AggregateOffer.lowPrice when present", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","mpn":"AGG-1","offers":{"@type":"AggregateOffer","lowPrice":"55.00","priceCurrency":"USD"}}
      </script>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out[0].price).toBe(55);
  });

  it("an offers ARRAY returns the LOWEST (sale), never the first/list price", () => {
    // List price emitted first, sale second — must return the sale, not 139.33.
    const html = `<script type="application/ld+json">
      {"@type":"Product","mpn":"34106875284","offers":[
        {"@type":"Offer","price":"139.33","priceCurrency":"USD"},
        {"@type":"Offer","price":"104.50","priceCurrency":"USD"}
      ]}</script>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(104.5);
  });

  it("falls through a 0/empty price placeholder to lowPrice", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","mpn":"34106875284","offers":{"@type":"AggregateOffer","price":0,"lowPrice":"45.00"}}
      </script>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out[0].price).toBe(45);
  });

  it("reads offers.priceSpecification.price (Shopify/PrestaShop shape)", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","mpn":"34106875284","offers":{"priceSpecification":{"price":"50.00","priceCurrency":"USD"}}}
      </script>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out[0].price).toBe(50);
  });

  it("does not crash on a malformed JSON-LD block", () => {
    const html = `<script type="application/ld+json">{ this is not json }</script>
      <script type="application/ld+json">{"@type":"Product","mpn":"11427953129","offers":{"price":"9.99"}}</script>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(9.99);
  });
});

describe("parsePartPrices — DOM fallback (no JSON-LD)", () => {
  it("reads .price-section-price and ignores .price-section-save / -retail", () => {
    const html = `<html><body>
      <span class="part-mpn">mpn: 11427953129</span>
      <span class="price-section-retail" style="line-through">$139.33</span>
      <span class="price-section-price">$104.50</span>
      <span class="price-section-save">$34.83</span>
    </body></html>`;
    const out = parsePartPrices(html, PARTSDEAL_URL);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(104.5);
    expect(out[0].oem_part_number).toBe("11427953129");
  });

  it("returns nothing when there is neither JSON-LD nor a resolvable price", () => {
    expect(parsePartPrices("<html><body>no prices here</body></html>", PARTSDEAL_URL)).toEqual([]);
    expect(parsePartPrices("", PARTSDEAL_URL)).toEqual([]);
  });
});

describe("parsePartPrices — gather from anywhere (domain-agnostic)", () => {
  it("extracts from ANY domain via JSON-LD, keyed by that domain", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","mpn":"06E115562H","offers":{"price":"22.49","priceCurrency":"USD"}}
      </script>`;
    const out = parsePartPrices(html, "https://www.fcpeuro.com/products/oil-filter");
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(22.49);
    expect(out[0].source_domain).toBe("fcpeuro.com"); // not a registry site
  });

  it("does NOT apply registry DOM selectors to unregistered domains", () => {
    // Registry-specific class names on a random domain, no structured data:
    // the per-domain fallback must not fire, so nothing is extracted (no blind
    // selector application — RevolutionParts is not special-cased globally).
    const html = `<span class="price-section-price">$104.50</span><span class="mpn">11427953129</span>`;
    expect(parsePartPrices(html, "https://randomblog.example/post")).toEqual([]);
  });
});

describe("normalizeOemNumber", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(normalizeOemNumber("04152-yzza1")).toBe("04152YZZA1");
    expect(normalizeOemNumber("15400-PLM-A02")).toBe("15400PLMA02");
    expect(normalizeOemNumber(" 11427953129 ")).toBe("11427953129");
  });
});
