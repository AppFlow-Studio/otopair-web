/**
 * priceDiscovery — fallback product-URL search for parts that ended Batch-2
 * with no price source (Jul 2026: 14/36 Sierra fitments had zero prices
 * because pricing depended entirely on the LLM citing a URL per part).
 */
import { describe, it, expect } from "vitest";
import {
  buildPriceSearchQuery,
  discoverPriceUrls,
  type UrlSearcher,
} from "../convex/vehicleEnrichment/priceDiscovery";

describe("buildPriceSearchQuery", () => {
  it("quotes the OEM and appends make/name when present", () => {
    expect(buildPriceSearchQuery({ oem: "19432331", make: "GMC", name: "Engine Oil" }))
      .toBe('"19432331" GMC Engine Oil OEM part price');
  });

  it("omits missing make/name", () => {
    expect(buildPriceSearchQuery({ oem: "84320501" })).toBe('"84320501" OEM part price');
  });
});

describe("discoverPriceUrls", () => {
  const stub = (urls: string[]): UrlSearcher => async () => urls.map((url) => ({ url }));

  it("filters marketplaces and blocked domains, keeps OEM stores", async () => {
    const search = stub([
      "https://www.amazon.com/dp/B0DJ93X4GR",
      "https://www.ebay.com/itm/123",
      "https://www.kbb.com/whatever",
      "https://g.oempartsonline.com/oem-parts/gm-oil-19432331",
      "https://www.gmpartsdirect.com/oem-parts/gm-oil-19432331",
    ]);
    const urls = await discoverPriceUrls({ oem: "19432331", make: "GMC" }, search);
    expect(urls).toEqual([
      "https://g.oempartsonline.com/oem-parts/gm-oil-19432331",
      "https://www.gmpartsdirect.com/oem-parts/gm-oil-19432331",
    ]);
  });

  it("dedupes by domain so survivors are distinct sources", async () => {
    const search = stub([
      "https://gmpartsdirect.com/a",
      "https://gmpartsdirect.com/b",
      "https://gmpartsgiant.com/c",
    ]);
    const urls = await discoverPriceUrls({ oem: "1" }, search);
    expect(urls).toEqual(["https://gmpartsdirect.com/a", "https://gmpartsgiant.com/c"]);
  });

  it("caps at 3 URLs", async () => {
    const search = stub(["https://a.com/1", "https://b.com/2", "https://c.com/3", "https://d.com/4"]);
    const urls = await discoverPriceUrls({ oem: "1" }, search);
    expect(urls).toHaveLength(3);
  });

  it("returns null (channel unavailable, NOT empty) when the search throws", async () => {
    // [] means "search ran, nothing sells this" and earns a durable no_listing
    // verdict; a thrown search must never be mistaken for that (Aug 6 2026
    // Firecrawl outage stamped no_listing across every part swept during it).
    const search: UrlSearcher = async () => {
      throw new Error("firecrawl down");
    };
    expect(await discoverPriceUrls({ oem: "1" }, search)).toBeNull();
  });

  it("returns [] when the search runs but yields nothing usable", async () => {
    const search = stub([]);
    expect(await discoverPriceUrls({ oem: "1" }, search)).toEqual([]);
  });
});
