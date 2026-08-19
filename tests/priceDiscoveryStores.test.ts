/**
 * Price discovery's deterministic store leg.
 *
 * The open-web leg was the whole of discovery, and every storefront it reaches
 * deterministically belongs to one operator — so a part absent from that
 * catalogue stayed unpriced however often we searched. This covers the leg that
 * asks a validated INDEPENDENT price store first, and the failure semantics,
 * which are the subtle part: a store returning nothing is a real answer, while
 * a dead search channel is no answer at all.
 */
import { describe, it, expect } from "vitest";
import {
  buildStoreScopedQuery,
  discoverPriceUrls,
} from "../convex/vehicleEnrichment/priceDiscovery";

const ok = (...urls: string[]) => urls.map((url) => ({ url }));

describe("buildStoreScopedQuery", () => {
  it("quotes the OEM number so the hit is the part's own page", () => {
    expect(buildStoreScopedQuery("gmpartsgiant.com", "12680072")).toBe(
      'site:gmpartsgiant.com "12680072"',
    );
  });
});

describe("discoverPriceUrls — store leg", () => {
  it("asks a validated store for the make BEFORE the open web", async () => {
    const queries: string[] = [];
    const urls = await discoverPriceUrls({ oem: "12680072", make: "GMC" }, async (q) => {
      queries.push(q);
      return q.startsWith("site:gmpartsgiant.com")
        ? ok("https://www.gmpartsgiant.com/parts/gm-spark-plug-12680072.html")
        : ok("https://gmc.oempartsonline.com/oem-parts/gm-plug-12680072");
    });
    expect(queries[0]).toContain("site:gmpartsgiant.com");
    expect(urls![0]).toContain("gmpartsgiant.com");
    // Both operators present — that is the entire point of the leg.
    expect(urls).toHaveLength(2);
  });

  it("does not run a store leg for a make with no validated store", async () => {
    const queries: string[] = [];
    await discoverPriceUrls({ oem: "90915YZZD1", make: "Toyota" }, async (q) => {
      queries.push(q);
      return ok("https://toyota.oempartsonline.com/oem-parts/x");
    });
    expect(queries.every((q) => !q.startsWith("site:"))).toBe(true);
  });

  it("falls through to the open web when the store has nothing", async () => {
    const urls = await discoverPriceUrls({ oem: "99999999", make: "GMC" }, async (q) =>
      q.startsWith("site:") ? [] : ok("https://gmc.oempartsonline.com/oem-parts/x"),
    );
    expect(urls).toEqual(["https://gmc.oempartsonline.com/oem-parts/x"]);
  });

  it("a store-leg THROW is not a dead channel — open web still runs", async () => {
    const urls = await discoverPriceUrls({ oem: "12680072", make: "GMC" }, async (q) => {
      if (q.startsWith("site:")) throw new Error("store leg boom");
      return ok("https://gmc.oempartsonline.com/oem-parts/x");
    });
    expect(urls).toEqual(["https://gmc.oempartsonline.com/oem-parts/x"]);
  });

  it("returns store hits rather than null when the OPEN WEB is down", async () => {
    // null means "no answer" and stamps a durable no_listing verdict. Having
    // real store URLs in hand, that would be a lie.
    const urls = await discoverPriceUrls({ oem: "12680072", make: "GMC" }, async (q) => {
      if (q.startsWith("site:")) return ok("https://www.gmpartsgiant.com/parts/x.html");
      throw new Error("firecrawl 402");
    });
    expect(urls).toEqual(["https://www.gmpartsgiant.com/parts/x.html"]);
  });

  it("still reports null when EVERY channel is down", async () => {
    const urls = await discoverPriceUrls({ oem: "12680072", make: "GMC" }, async () => {
      throw new Error("firecrawl 402");
    });
    expect(urls).toBeNull();
  });

  it("dedupes by domain and caps at 3", async () => {
    const urls = await discoverPriceUrls({ oem: "12680072", make: "GMC" }, async (q) =>
      q.startsWith("site:")
        ? ok("https://www.gmpartsgiant.com/a.html", "https://www.gmpartsgiant.com/b.html")
        : ok("https://a.test/1", "https://a.test/2", "https://b.test/1", "https://c.test/1"),
    );
    expect(urls).toHaveLength(3);
    expect(urls!.filter((u) => u.includes("gmpartsgiant")).length).toBe(1);
  });

  it("never returns a marketplace, whichever leg found it", async () => {
    const urls = await discoverPriceUrls({ oem: "12680072", make: "GMC" }, async () =>
      ok("https://www.ebay.com/itm/1", "https://a.test/1"),
    );
    expect(urls).toEqual(["https://a.test/1"]);
  });
});
