/**
 * parseSupersessions — deterministic "replaced by / supersedes" chain capture
 * from registry product-page HTML (same HTML the price parser reads).
 */
import { describe, it, expect } from "vitest";
import { parseSupersessions } from "../convex/vehicleEnrichment/priceParser";

const URL = "https://www.bmwpartsdeal.com/parts/oil-filter-11427953129.html";

describe("parseSupersessions", () => {
  it("captures an explicit OLD-replaced-by-NEW pair", () => {
    const html = `<div>Part 11427953129 has been replaced by 11428583898.</div>`;
    const out = parseSupersessions(html, URL);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      old_number: "11427953129",
      new_number: "11428583898",
      source_domain: "bmwpartsdeal.com",
    });
  });

  it("pairs a page-scoped 'replaced by' with the page's own MPN", () => {
    const html = `
      <meta itemprop="mpn" content="11427953129">
      <p>This part has been superseded by: 11428583898</p>`;
    const out = parseSupersessions(html, URL);
    expect(out).toContainEqual(
      expect.objectContaining({ old_number: "11427953129", new_number: "11428583898" }),
    );
  });

  it("pairs a page-scoped 'replaces' with the page MPN as successor", () => {
    const html = `
      <meta itemprop="mpn" content="11428583898">
      <p>Replaces: 11427953129</p>`;
    const out = parseSupersessions(html, URL);
    expect(out).toContainEqual(
      expect.objectContaining({ old_number: "11427953129", new_number: "11428583898" }),
    );
  });

  it("handles spaced BMW-style numbers and normalizes them", () => {
    const html = `<div>11 42 7 953 129 was replaced by 11 42 8 583 898</div>`;
    const out = parseSupersessions(html, URL);
    expect(out).toContainEqual(
      expect.objectContaining({ old_number: "11427953129", new_number: "11428583898" }),
    );
  });

  it("does not fabricate pairs from prose without part numbers", () => {
    const html = `<p>This bulb has been replaced by an LED unit in later models.</p>`;
    expect(parseSupersessions(html, URL)).toHaveLength(0);
  });

  it("does not let a related-part tile supersede the page's own part", () => {
    // The explicit pair claims the successor; pattern B must not re-pair it
    // with the page MPN (which would falsely mark 99999999 superseded).
    const html = `
      <meta itemprop="mpn" content="99999999">
      <div>Related: 11427953129 has been replaced by 11428583898</div>`;
    const out = parseSupersessions(html, URL);
    expect(out).toHaveLength(1);
    expect(out[0].old_number).toBe("11427953129");
  });

  it("ignores self-referential and implausible captures", () => {
    const html = `
      <meta itemprop="mpn" content="11428583898">
      <p>Replaces: 11428583898</p>
      <p>abc replaced by def</p>`;
    expect(parseSupersessions(html, URL)).toHaveLength(0);
  });
});
