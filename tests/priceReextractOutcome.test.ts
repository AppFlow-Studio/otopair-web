/**
 * reextractPartPrice outcome-contract tests — fixes for review items 7 & 8
 * (docs/superpowers/reviews/2026-06-09-enrichment-pipeline-review.md):
 *
 *  Item 7: a transient fetch failure (page came back with neither html nor
 *  markdown) must be reported as 'fetch_failed' — NOT 'unverified' — so the
 *  reprice caller leaves the existing row untouched instead of downgrading a
 *  previously good 'sale' row to poison.
 *
 *  Item 8: callers need to distinguish AFFIRMATIVE rejections (the page
 *  testified against the number: price>=MSRP, wrong OEM, outside the median
 *  band) from PASSIVE ones (we simply couldn't verify), so Batch-2 can stop
 *  persisting affirmatively-failed prices as trusted 'llm_estimate'.
 *
 * Uses `prefetched` pages only — no network.
 */
import { describe, expect, it } from "vitest";
import {
  reextractPartPrice,
  isAffirmativeRejection,
} from "../convex/vehicleEnrichment/priceReextract";

describe("reextractPartPrice fetch-failure contract (item 7)", () => {
  it("reports fetch_failed (not unverified) when the page has neither html nor markdown", async () => {
    const outcome = await reextractPartPrice({
      oem: "5Q0698451",
      partName: "Brake Pad Set",
      source_url: "https://www.fcpeuro.com/products/whatever",
      crossSourceMedian: null,
      prefetched: { markdown: null, html: null },
    });
    expect(outcome).toEqual({ status: "fetch_failed", reason: "no_page" });
  });

  it("still reports unverified when the page WAS read but had no structured data and no text", async () => {
    // html present (page really loaded), but no JSON-LD product and no markdown
    // to feed Tier 2 — that is a genuine verification failure, not infra.
    const outcome = await reextractPartPrice({
      oem: "5Q0698451",
      source_url: "https://www.fcpeuro.com/products/whatever",
      crossSourceMedian: null,
      prefetched: { markdown: null, html: "<html><body>hello</body></html>" },
    });
    expect(outcome).toEqual({
      status: "unverified",
      reason: "no_structured_no_text",
    });
  });
});

describe("isAffirmativeRejection (item 8)", () => {
  it("classifies page-testified failures as affirmative", () => {
    expect(isAffirmativeRejection("llm_ge_msrp")).toBe(true);
    expect(isAffirmativeRejection("llm_oem_mismatch")).toBe(true);
    expect(isAffirmativeRejection("llm_above_median")).toBe(true);
    expect(isAffirmativeRejection("llm_below_median")).toBe(true);
  });

  it("classifies could-not-verify failures as passive", () => {
    expect(isAffirmativeRejection("llm_no_price")).toBe(false);
    expect(isAffirmativeRejection("llm_error")).toBe(false);
    expect(isAffirmativeRejection("no_structured_no_text")).toBe(false);
    expect(isAffirmativeRejection("no_page")).toBe(false);
    expect(isAffirmativeRejection("")).toBe(false);
  });
});
