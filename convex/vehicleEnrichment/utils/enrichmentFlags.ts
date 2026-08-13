/**
 * vehicleEnrichment/utils/enrichmentFlags.ts — env-driven feature flags for the
 * enrichment batch pipeline.
 *
 * PIPELINE LAW: every behavior change here must be reversible via env flags
 * without a code deploy. All flags are read at CALL time (not module load —
 * audit F20), so flipping a Convex env var takes effect on the next batch
 * submission.
 *
 * Flags:
 *   ENRICHMENT_STRUCTURED_OUTPUTS   default ON  — schema-enforced JSON output
 *                                   on batch requests ("off" reverts to plain
 *                                   text + extractJsonFromContentBlocks parsing).
 *   ENRICHMENT_PROMPT_CACHE         default ON  — 1h ephemeral cache_control on
 *                                   the shared system prompts in batch requests.
 *   ENRICHMENT_EXTRACTION_MODEL     default "claude-sonnet-4-6" — batch default
 *                                   model. "claude-sonnet-5" is the intended
 *                                   upgrade (verified as a real model ID on the
 *                                   platform models page, 2026-07-29) but MUST
 *                                   NOT be flipped until the next ground-truth
 *                                   batch validates it: a model swap changes
 *                                   extraction outputs, and per the pipeline's
 *                                   validation discipline it must not ship
 *                                   silently.
 *   ENRICHMENT_WEB_SEARCH_TOOL_VERSION  default "web_search_20260209" (dynamic
 *                                   filtering; supported on Claude 4.6+ per
 *                                   docs). Set to "web_search_20250305" to
 *                                   revert to the basic tool.
 *
 * All helpers are pure (env passed in) so they are unit-testable.
 */

export type EnvLike = Record<string, string | undefined>;

// ─── Flag parsing ────────────────────────────────────────────────

const FALSY = new Set(["off", "false", "0", "no", "disabled"]);
const TRUTHY = new Set(["on", "true", "1", "yes", "enabled"]);

/** Parse a boolean-ish env value. Unset / unrecognized → defaultValue. */
export function flagEnabled(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (FALSY.has(v)) return false;
  if (TRUTHY.has(v)) return true;
  return defaultValue;
}

/** Structured outputs on batch extraction requests. Default ON. */
export function isStructuredOutputsEnabled(env: EnvLike): boolean {
  return flagEnabled(env.ENRICHMENT_STRUCTURED_OUTPUTS, true);
}

/** 1h-ephemeral prompt caching on shared batch system prompts. Default ON. */
export function isPromptCacheEnabled(env: EnvLike): boolean {
  return flagEnabled(env.ENRICHMENT_PROMPT_CACHE, true);
}

// ─── Model selection ─────────────────────────────────────────────

/** Current validated batch extraction default. */
export const DEFAULT_EXTRACTION_MODEL = "claude-sonnet-4-6";

/**
 * Intended upgrade target — flip ENRICHMENT_EXTRACTION_MODEL to this ONLY
 * after a ground-truth batch validates it (model swaps change extraction
 * outputs and must not ship silently).
 */
export const INTENDED_UPGRADE_MODEL = "claude-sonnet-5";

/** Resolve the batch default model from env. Read at CALL time (audit F20). */
export function resolveExtractionModel(env: EnvLike): string {
  const raw = env.ENRICHMENT_EXTRACTION_MODEL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_EXTRACTION_MODEL;
}

/**
 * Models that reject non-default sampling params (temperature/top_p/top_k).
 * Per the platform migration guide: removed on Opus 4.7/4.8/5 and Fable/Mythos 5;
 * non-default values rejected on Sonnet 5. The batch pipeline sends
 * temperature: 0 (non-default), so it must be omitted for these models or every
 * request 400s the moment the env flag is flipped.
 */
const NO_SAMPLING_PARAM_MODEL_PREFIXES = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-mythos",
];

/** Whether an explicit temperature may be sent to this model. */
export function modelAcceptsTemperature(model: string): boolean {
  const m = model.trim().toLowerCase();
  return !NO_SAMPLING_PARAM_MODEL_PREFIXES.some((p) => m === p || m.startsWith(p + "-") || m.startsWith(p + "@"));
}

// ─── Web search tool version ─────────────────────────────────────

/** Current web search tool (dynamic filtering; Claude 4.6+ models). */
export const DEFAULT_WEB_SEARCH_TOOL_VERSION = "web_search_20260209";
/** Basic web search — revert target for older models / rollback. */
export const LEGACY_WEB_SEARCH_TOOL_VERSION = "web_search_20250305";

/** Resolve the web_search tool `type` from env. Read at CALL time. */
export function resolveWebSearchToolVersion(env: EnvLike): string {
  const raw = env.ENRICHMENT_WEB_SEARCH_TOOL_VERSION?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_WEB_SEARCH_TOOL_VERSION;
}

// ─── Blocked domain merge (audit F18) ────────────────────────────

/**
 * Normalize a domain entry for the web_search `blocked_domains` parameter:
 * lowercase, no scheme, no leading "www.", no trailing slash. Entries must be
 * bare domains with an optional path (per web-search tool docs). Returns null
 * for unusable entries.
 */
export function normalizeBlockedDomain(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let d = raw.trim().toLowerCase();
  if (d.length === 0) return null;
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.replace(/\/+$/, "");
  if (d.length === 0 || d.includes(" ")) return null;
  // must look like a domain (at least one dot in the host portion)
  const host = d.split("/")[0];
  if (!host.includes(".")) return null;
  return d;
}

/**
 * Merge the hardcoded BLOCKED_DOMAINS list with rows from the `blocked_domains`
 * Convex table (closes audit F18 — the table previously had no effect on the
 * live batch path). Static entries first, table entries appended, normalized
 * and de-duplicated, order preserved.
 */
export function mergeBlockedDomains(
  staticList: readonly string[],
  tableDomains: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...staticList, ...tableDomains]) {
    const d = normalizeBlockedDomain(raw);
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}
