/**
 * Marketplace blocklist helpers (sourceRegistry). Jul 2026: amazon/ebay rows
 * reached part_prices because the marketplace list lived only in the source-
 * discovery path — these helpers are now enforced at every price choke point.
 */
import { describe, it, expect } from "vitest";
import {
  MARKETPLACE_DOMAINS,
  domainOfUrl,
  isMarketplaceDomain,
  isMarketplaceUrl,
} from "../convex/vehicleEnrichment/sourceRegistry";

describe("domainOfUrl", () => {
  it("strips www and returns the hostname", () => {
    expect(domainOfUrl("https://www.amazon.com/dp/B0DJ93X4GR")).toBe("amazon.com");
    expect(domainOfUrl("https://g.oempartsonline.com/oem-parts/gm-oil-19432331")).toBe("g.oempartsonline.com");
  });

  it("returns null for garbage and empty input", () => {
    expect(domainOfUrl("not a url")).toBeNull();
    expect(domainOfUrl(null)).toBeNull();
    expect(domainOfUrl(undefined)).toBeNull();
  });
});

describe("isMarketplaceDomain", () => {
  it("matches exact domains", () => {
    for (const d of MARKETPLACE_DOMAINS) {
      expect(isMarketplaceDomain(d)).toBe(true);
    }
  });

  it("matches subdomains and www-prefixed", () => {
    expect(isMarketplaceDomain("smile.amazon.com")).toBe(true);
    expect(isMarketplaceDomain("www.ebay.com")).toBe(true);
  });

  it("does not match OEM stores or lookalike suffixes", () => {
    expect(isMarketplaceDomain("gmpartsdirect.com")).toBe(false);
    expect(isMarketplaceDomain("g.oempartsonline.com")).toBe(false);
    // "notamazon.com" must not match via endsWith on the bare name
    expect(isMarketplaceDomain("notamazon.com")).toBe(false);
    expect(isMarketplaceDomain(null)).toBe(false);
  });
});

describe("isMarketplaceUrl", () => {
  it("flags marketplace product URLs", () => {
    expect(isMarketplaceUrl("https://www.amazon.com/Genuine-Front-Brake/dp/B0DJ93X4GR")).toBe(true);
    expect(isMarketplaceUrl("https://www.ebay.com/itm/388750345994")).toBe(true);
    expect(isMarketplaceUrl("https://www.walmart.com/ip/12345")).toBe(true);
  });

  it("passes OEM store URLs and rejects unparseable ones safely", () => {
    expect(isMarketplaceUrl("https://www.gmpartsdirect.com/oem-parts/gm-cabin-air-filter-13508023")).toBe(false);
    expect(isMarketplaceUrl("not a url")).toBe(false);
    expect(isMarketplaceUrl(null)).toBe(false);
  });
});

describe("isMarketplaceDomain — country-TLD variants (A4 ebay.ca leak, Jul 2026)", () => {
  it("matches country TLDs of listed marketplaces", () => {
    expect(isMarketplaceDomain("ebay.ca")).toBe(true);
    expect(isMarketplaceDomain("www.ebay.co.uk")).toBe(true);
    expect(isMarketplaceDomain("amazon.de")).toBe(true);
    expect(isMarketplaceDomain("amazon.co.jp")).toBe(true);
  });

  it("does not match unrelated retailers or subdomain look-alikes", () => {
    expect(isMarketplaceDomain("parts.audiusa.com")).toBe(false);
    expect(isMarketplaceDomain("blauparts.com")).toBe(false);
    expect(isMarketplaceDomain("ebayparts-store.com")).toBe(false);
    expect(isMarketplaceDomain("amazonia-parts.com")).toBe(false);
  });
});
