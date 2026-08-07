/**
 * extractJsonFromContentBlocks — multi-text-block selection.
 *
 * Regression anchor: Aug 6-7 2026 batch-2 empty-services cluster (2021 Mazda
 * CX-5 JM3KFBBM9M0123456, 2022 Kia Telluride 5XYP5DHCXNG123456, and the
 * stress-fleet c300/altima/golf re-runs). Under structured outputs a
 * web-search turn's INTERIM narration between searches is grammar-forced into
 * schema-valid JSON, degenerating to `{"fields": [], "services": []}` — and
 * the real final answer follows as a SECOND text block. Joining the blocks
 * fails JSON.parse (concatenated objects), and the old first-bracket fallback
 * returned the interim EMPTY object: the CX-5's complete final answer (33 gap
 * fields + 25 services with labor hours) was discarded, services[] starved
 * labor/quotability/role-applicability at once, and the run finalized partial
 * at quotability 0.58 with `applicable_services_structural_fallback_used`.
 *
 * The rule this file freezes: when several text blocks parse individually,
 * keep the one with the most content, preferring the later block on ties —
 * the final write-up supersedes interim emissions, and a degenerate empty
 * final must not erase a rich earlier answer either.
 *
 * tests/fixtures/batch2MultiTextBlock.json holds the REAL text blocks of both
 * failure shapes, pulled from the API batches
 * (msgbatch_01X3sxa9t2bLcHWizfJtFshe / msgbatch_01K5FBM2oXnuPKmuyj6KZhEe).
 */
import { describe, expect, it } from "vitest";
import { extractJsonFromContentBlocks } from "../convex/vehicleEnrichment/utils/claudeClient";
import fixture from "./fixtures/batch2MultiTextBlock.json";

const asContent = (texts: string[]) => texts.map((text) => ({ type: "text", text }));

describe("extractJsonFromContentBlocks — multi-block selection", () => {
  it("THE CX-5 CASE: interim empty block + rich final block → the rich final wins", () => {
    const out = extractJsonFromContentBlocks(asContent(fixture.cx5.text_blocks));
    expect(Array.isArray(out.fields)).toBe(true);
    expect(out.fields.length).toBeGreaterThan(20);
    expect(out.services.length).toBe(25);
    const applicable = out.services.filter((s: any) => s.is_applicable !== false);
    expect(applicable.length).toBeGreaterThan(15);
  });

  it("THE TELLURIDE CASE: both blocks empty → parses to the empty shape (classifier's job to flag)", () => {
    const out = extractJsonFromContentBlocks(asContent(fixture.telluride.text_blocks));
    expect(out).toEqual({ fields: [], services: [] });
  });

  it("a rich interim answer is NOT erased by a degenerate empty final", () => {
    const rich = JSON.stringify({
      fields: [{ key: "oil_viscosity", value: "0W-20", source_url: "https://x", source_type: "web_search", confidence: 0.9 }],
      services: [{ service_name: "Oil Change", is_applicable: true, labor_hours: 0.5, parts_cost_low: 30, parts_cost_high: 55, confidence: 0.9, tech_notes: "", parts_breakdown: [] }],
    });
    const out = extractJsonFromContentBlocks(asContent([rich, '{"fields": [], "services": []}']));
    expect(out.fields.length).toBe(1);
    expect(out.services.length).toBe(1);
  });

  it("equal-mass duplicates: the later block wins", () => {
    const a = '{"fields": [], "services": []}';
    const out = extractJsonFromContentBlocks(asContent([a, a]));
    expect(out).toEqual({ fields: [], services: [] });
  });

  it("single-block responses parse exactly as before", () => {
    const out = extractJsonFromContentBlocks(asContent(['{"gap_fields": {"oil_viscosity": {"value": "5W-30"}}, "services": []}']));
    expect(out.gap_fields.oil_viscosity.value).toBe("5W-30");
  });

  it("one JSON object split ACROSS blocks still parses via the join (streamed shape)", () => {
    const out = extractJsonFromContentBlocks(asContent(['{"fields": [{"key": "a", "value": 1', '}], "services": []}']));
    expect(out.fields[0].key).toBe("a");
  });

  it("fenced JSON in a block is unwrapped", () => {
    const out = extractJsonFromContentBlocks(
      asContent(['{"fields": [], "services": []}', '```json\n{"fields": [{"key": "b", "value": 2, "source_url": "https://y", "source_type": "web_search", "confidence": 0.8}], "services": []}\n```']),
    );
    expect(out.fields[0].key).toBe("b");
  });

  it("prose + JSON in a SINGLE block keeps the legacy bracket-matching path", () => {
    const out = extractJsonFromContentBlocks(
      asContent(['Here is the data you asked for:\n{"fields": [{"key": "c", "value": 3}], "services": []}']),
    );
    expect(out.fields[0].key).toBe("c");
  });

  it("non-text blocks (tool use / search results) are ignored", () => {
    const content = [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      { type: "text", text: '{"fields": [], "services": []}' },
      { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "q2" } },
      { type: "web_search_tool_result", tool_use_id: "s2", content: [] },
      { type: "text", text: '{"fields": [{"key": "d", "value": 4, "source_url": "https://z", "source_type": "web_search", "confidence": 0.7}], "services": []}' },
    ];
    const out = extractJsonFromContentBlocks(content);
    expect(out.fields[0].key).toBe("d");
  });

  it("still throws when no block contains JSON at all", () => {
    expect(() => extractJsonFromContentBlocks(asContent(["no json here", "still none"]))).toThrow();
  });
});
