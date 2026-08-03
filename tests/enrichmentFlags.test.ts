/**
 * Env-flag + blocked-domain-merge contract tests for the enrichment batch
 * pipeline platform migration (structured outputs / prompt cache / model
 * selection / web_search version). The pipeline law requires every change to
 * be revertible via env flags — these tests pin the flag semantics.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTRACTION_MODEL,
  DEFAULT_WEB_SEARCH_TOOL_VERSION,
  INTENDED_UPGRADE_MODEL,
  LEGACY_WEB_SEARCH_TOOL_VERSION,
  flagEnabled,
  isPromptCacheEnabled,
  isStructuredOutputsEnabled,
  mergeBlockedDomains,
  modelAcceptsTemperature,
  normalizeBlockedDomain,
  resolveExtractionModel,
  resolveWebSearchToolVersion,
} from "../convex/vehicleEnrichment/utils/enrichmentFlags";

describe("flagEnabled", () => {
  it("returns the default when unset or unrecognized", () => {
    expect(flagEnabled(undefined, true)).toBe(true);
    expect(flagEnabled(undefined, false)).toBe(false);
    expect(flagEnabled("banana", true)).toBe(true);
    expect(flagEnabled("banana", false)).toBe(false);
  });

  it("parses falsy spellings case-insensitively", () => {
    for (const v of ["off", "OFF", "false", "0", "no", "disabled", " Off "]) {
      expect(flagEnabled(v, true)).toBe(false);
    }
  });

  it("parses truthy spellings", () => {
    for (const v of ["on", "true", "1", "yes", "enabled", "ON"]) {
      expect(flagEnabled(v, false)).toBe(true);
    }
  });
});

describe("structured outputs / prompt cache kill-switches", () => {
  it("default ON with an empty env", () => {
    expect(isStructuredOutputsEnabled({})).toBe(true);
    expect(isPromptCacheEnabled({})).toBe(true);
  });

  it("ENRICHMENT_STRUCTURED_OUTPUTS=off reverts to text parsing", () => {
    expect(isStructuredOutputsEnabled({ ENRICHMENT_STRUCTURED_OUTPUTS: "off" })).toBe(false);
  });

  it("ENRICHMENT_PROMPT_CACHE=off disables caching", () => {
    expect(isPromptCacheEnabled({ ENRICHMENT_PROMPT_CACHE: "off" })).toBe(false);
  });
});

describe("resolveExtractionModel (audit F20 — call-time model selection)", () => {
  it("defaults to the validated claude-sonnet-4-6", () => {
    expect(resolveExtractionModel({})).toBe("claude-sonnet-4-6");
    expect(DEFAULT_EXTRACTION_MODEL).toBe("claude-sonnet-4-6");
  });

  it("honors ENRICHMENT_EXTRACTION_MODEL", () => {
    expect(resolveExtractionModel({ ENRICHMENT_EXTRACTION_MODEL: "claude-sonnet-5" }))
      .toBe("claude-sonnet-5");
  });

  it("treats empty / whitespace values as unset", () => {
    expect(resolveExtractionModel({ ENRICHMENT_EXTRACTION_MODEL: "  " }))
      .toBe(DEFAULT_EXTRACTION_MODEL);
  });

  it("documents claude-sonnet-5 as the intended (not yet validated) upgrade", () => {
    expect(INTENDED_UPGRADE_MODEL).toBe("claude-sonnet-5");
  });
});

describe("modelAcceptsTemperature — sampling-param guard for model flips", () => {
  it("current default still takes explicit temperature", () => {
    expect(modelAcceptsTemperature("claude-sonnet-4-6")).toBe(true);
    expect(modelAcceptsTemperature("claude-haiku-4-5-20251001")).toBe(true);
    expect(modelAcceptsTemperature("claude-sonnet-4-5-20250929")).toBe(true);
  });

  it("models that reject non-default sampling params are excluded", () => {
    expect(modelAcceptsTemperature("claude-sonnet-5")).toBe(false);
    expect(modelAcceptsTemperature("claude-opus-5")).toBe(false);
    expect(modelAcceptsTemperature("claude-opus-4-7")).toBe(false);
    expect(modelAcceptsTemperature("claude-opus-4-8")).toBe(false);
  });

  it("does not misclassify 4.6-family IDs via prefix collision", () => {
    // "claude-opus-4-6" must NOT match the "claude-opus-4" style prefixes.
    expect(modelAcceptsTemperature("claude-opus-4-6")).toBe(true);
  });
});

describe("resolveWebSearchToolVersion", () => {
  it("defaults to web_search_20260209 (dynamic filtering)", () => {
    expect(resolveWebSearchToolVersion({})).toBe(DEFAULT_WEB_SEARCH_TOOL_VERSION);
    expect(DEFAULT_WEB_SEARCH_TOOL_VERSION).toBe("web_search_20260209");
  });

  it("env override reverts to the basic tool", () => {
    expect(
      resolveWebSearchToolVersion({
        ENRICHMENT_WEB_SEARCH_TOOL_VERSION: LEGACY_WEB_SEARCH_TOOL_VERSION,
      }),
    ).toBe("web_search_20250305");
  });
});

describe("normalizeBlockedDomain", () => {
  it("lowercases and strips scheme / www / trailing slash", () => {
    expect(normalizeBlockedDomain("https://www.KBB.com/")).toBe("kbb.com");
    expect(normalizeBlockedDomain("http://Example.com/blog/")).toBe("example.com/blog");
  });

  it("rejects empties and non-domains", () => {
    expect(normalizeBlockedDomain(null)).toBeNull();
    expect(normalizeBlockedDomain("  ")).toBeNull();
    expect(normalizeBlockedDomain("not a domain")).toBeNull();
    expect(normalizeBlockedDomain("localhost")).toBeNull();
  });
});

describe("mergeBlockedDomains (audit F18 — table now reaches the batch path)", () => {
  const STATIC = ["kbb.com", "justanswer.com"];

  it("appends table domains after the static list, deduped", () => {
    const merged = mergeBlockedDomains(STATIC, ["badsource.com", "kbb.com", "badsource.com"]);
    expect(merged).toEqual(["kbb.com", "justanswer.com", "badsource.com"]);
  });

  it("dedupes across www/scheme/case variants", () => {
    const merged = mergeBlockedDomains(STATIC, ["https://WWW.JustAnswer.com/", "new-bad.io"]);
    expect(merged).toEqual(["kbb.com", "justanswer.com", "new-bad.io"]);
  });

  it("drops null/empty/garbage table rows without failing", () => {
    const merged = mergeBlockedDomains(STATIC, [null, undefined, "", "   ", "nodots"]);
    expect(merged).toEqual(["kbb.com", "justanswer.com"]);
  });

  it("empty table leaves the static list intact (fail-open path)", () => {
    expect(mergeBlockedDomains(STATIC, [])).toEqual(STATIC);
  });
});
