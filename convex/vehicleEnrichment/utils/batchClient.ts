/**
 * vehicleEnrichment/utils/batchClient.ts — Anthropic Message Batches API
 *
 * Batch requests are processed asynchronously (within 24h, usually minutes)
 * and do NOT count against standard API rate limits. 50% cheaper than real-time.
 *
 * Model strategy (audit F15 — comment previously claimed Haiku ran extraction):
 *   - Sonnet → runs Batch 1A (scraped extraction), 1B (web-search specs) and
 *              Batch 2 (gap fill + pricing). Default resolved per call from
 *              ENRICHMENT_EXTRACTION_MODEL (audit F20), falling back to
 *              claude-sonnet-4-6.
 *   - Haiku  → cheap structured mapping side-requests only (Batch 1C VDB
 *              action→slug mapping, adversarial/audit lookups) via an explicit
 *              per-request `model`.
 *
 * Platform features (each independently revertible via env flags — see
 * utils/enrichmentFlags.ts):
 *   - Structured outputs (output_config.format json_schema) when the request
 *     carries an outputSchema and ENRICHMENT_STRUCTURED_OUTPUTS is on.
 *   - 1h-ephemeral prompt caching on the shared system prompt when
 *     ENRICHMENT_PROMPT_CACHE is on (batch docs recommend the 1h TTL because
 *     async processing usually outlives the default 5-minute cache).
 *   - web_search tool version from ENRICHMENT_WEB_SEARCH_TOOL_VERSION
 *     (default web_search_20260209 — dynamic filtering, Claude 4.6+).
 *
 * Flow: submit → store batchId → poll every 5min → process results when done
 */

import Anthropic from "@anthropic-ai/sdk";
import { extractJsonFromContentBlocks } from "./claudeClient";
import {
  DEFAULT_EXTRACTION_MODEL,
  isPromptCacheEnabled,
  isStructuredOutputsEnabled,
  modelAcceptsTemperature,
  resolveExtractionModel,
  resolveWebSearchToolVersion,
} from "./enrichmentFlags";

// ─── Model Constants ─────────────────────────────────────────────

/** Cheap structured mapping side-requests (Batch 1C, audits) */
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";
/**
 * Static fallback for the batch extraction default (1A/1B/2). The live default
 * is resolved per submitBatch call via ENRICHMENT_EXTRACTION_MODEL so a model
 * change never requires a redeploy (audit F20).
 */
export const MODEL_SONNET = DEFAULT_EXTRACTION_MODEL;

// ─── SDK Client ──────────────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ─── Types ───────────────────────────────────────────────────────

export interface BatchRequest {
  customId: string;
  system: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  /** 0 = no web search tool */
  maxSearchUses: number;
  /**
   * Domains to block from web_search results at the API level.
   * Only applies when maxSearchUses > 0.
   */
  blockedDomains?: string[];
  /** Defaults to the ENRICHMENT_EXTRACTION_MODEL env (claude-sonnet-4-6). */
  model?: string;
  /**
   * JSON schema for schema-enforced output (structured outputs,
   * output_config.format type "json_schema"). Applied only when
   * ENRICHMENT_STRUCTURED_OUTPUTS is on; when off (or omitted) the response is
   * plain text and getBatchResults falls back to extractJsonFromContentBlocks.
   */
  outputSchema?: Record<string, any>;
}

export interface BatchResultEntry {
  customId: string;
  data: Record<string, any>;
  /** Raw model content blocks, stringified — captured for the enrichment run
   *  trace (Deep-Dive step replay). Undefined on errored requests. */
  rawText?: string;
  usage: { tokensIn: number; tokensOut: number; webSearches: number };
  error: string | null;
}

// ─── Submit ──────────────────────────────────────────────────────

/**
 * Submit a batch of requests. Returns the batch ID.
 * Does NOT count against standard rate limits.
 */
export async function submitBatch(requests: BatchRequest[]): Promise<string> {
  const client = getClient();

  // Env flags are read at CALL time so a flip takes effect on the next
  // submission with no redeploy (audit F20 + pipeline reversibility law).
  const env = process.env;
  const defaultModel = resolveExtractionModel(env);
  const structuredOutputs = isStructuredOutputsEnabled(env);
  const promptCache = isPromptCacheEnabled(env);
  const webSearchToolVersion = resolveWebSearchToolVersion(env);

  const batch = await client.messages.batches.create({
    requests: requests.map((req) => {
      const model = req.model ?? defaultModel;
      return {
        custom_id: req.customId,
        params: {
          model,
          max_tokens: req.maxTokens,
          // Sonnet 5 / Opus 4.7+ reject non-default sampling params — omit
          // temperature there so an ENRICHMENT_EXTRACTION_MODEL flip cannot
          // 400 every request.
          ...(modelAcceptsTemperature(model) ? { temperature: req.temperature } : {}),
          // 1h-ephemeral cache on the shared system prompt: it is byte-identical
          // across vehicles for the same request type, while the per-vehicle
          // user prompt (after the breakpoint) is not. Best-effort in batches;
          // prompts under the model's minimum cacheable prefix silently skip.
          system: promptCache
            ? [{
                type: "text",
                text: req.system,
                cache_control: { type: "ephemeral", ttl: "1h" },
              }]
            : req.system,
          messages: [{ role: "user", content: req.userPrompt }],
          ...(req.maxSearchUses > 0 ? {
            tools: [{
              type: webSearchToolVersion,
              name: "web_search",
              ...(req.blockedDomains && req.blockedDomains.length > 0
                ? { blocked_domains: req.blockedDomains }
                : {}),
            }],
          } : {}),
          ...(structuredOutputs && req.outputSchema ? {
            output_config: {
              format: { type: "json_schema", schema: req.outputSchema },
            },
          } : {}),
        } as any,
      };
    }),
  });

  console.log(
    `[batch] Submitted ${requests.length} requests → batchId=${batch.id} ` +
    `(model=${defaultModel}, structured_outputs=${structuredOutputs ? "on" : "off"}, ` +
    `prompt_cache=${promptCache ? "on" : "off"}, web_search=${webSearchToolVersion})`,
  );
  return batch.id;
}

// ─── Status ──────────────────────────────────────────────────────

/** Returns "in_progress" or "ended". */
export async function getBatchStatus(batchId: string): Promise<"in_progress" | "ended"> {
  const client = getClient();
  const batch = await client.messages.batches.retrieve(batchId);
  console.log(
    `[batch] ${batchId} status=${batch.processing_status} ` +
    `(succeeded=${batch.request_counts.succeeded}, ` +
    `processing=${batch.request_counts.processing}, ` +
    `errored=${batch.request_counts.errored})`,
  );
  // Anthropic SDK adds "canceling" — treat as still in progress for our consumers.
  return batch.processing_status === "ended" ? "ended" : "in_progress";
}

// ─── Results ─────────────────────────────────────────────────────

/**
 * Serialized-content length above which an empty parse result is treated as a
 * failure rather than a legitimately empty payload. `JSON.stringify(content)`
 * of a real extraction response runs to thousands of characters; an genuinely
 * empty/near-empty block array serializes to well under this.
 */
export const EMPTY_PARSE_RAWTEXT_FLOOR = 200;

/**
 * Decide whether a SUCCEEDED batch request whose body we parsed should still
 * be reported as an error. Pure, so the contract is unit-testable.
 *
 * Returns the error string, or null when the result is genuinely fine.
 *
 * `parseThrew` — extractJsonFromContentBlocks threw.
 * `parsedKeyCount` — keys recovered; 0 means nothing usable came back.
 * `rawTextLength` — length of the serialized content blocks.
 *
 * The empty-object case is the subtle one. `{}` is a legitimate result for a
 * trivially empty response, so it is only an error when there was substantial
 * text that we failed to turn into anything — which is precisely the shape of
 * a model that answered in prose instead of JSON.
 */
export function classifyParseOutcome(input: {
  parseThrew: boolean;
  parseErrorMessage?: string;
  parsedKeyCount: number;
  rawTextLength: number;
}): string | null {
  if (input.parseThrew) {
    return `json_extraction_failed: ${input.parseErrorMessage ?? "unknown"}`.slice(0, 300);
  }
  if (input.parsedKeyCount === 0 && input.rawTextLength > EMPTY_PARSE_RAWTEXT_FLOOR) {
    return `json_extraction_empty: no JSON object recovered from ${input.rawTextLength} chars of content`;
  }
  return null;
}

/**
 * Retrieve and parse all results from a completed batch.
 * Returns a map of customId → { data, usage, error }.
 */
export async function getBatchResults(batchId: string): Promise<Record<string, BatchResultEntry>> {
  const client = getClient();
  const results: Record<string, BatchResultEntry> = {};

  for await (const item of await client.messages.batches.results(batchId)) {
    if (item.result.type === "succeeded") {
      const message = item.result.message;
      const content = message.content ?? [];
      const webSearches = (message as any).usage?.server_tool_use?.web_search_requests ?? 0;

      let data: Record<string, any> = {};
      let parseThrew = false;
      let parseErrorMessage: string | undefined;
      try {
        data = extractJsonFromContentBlocks(Array.isArray(content) ? content : [content]);
      } catch (e) {
        parseThrew = true;
        parseErrorMessage = e instanceof Error ? e.message : String(e);
        console.error(`[batch] JSON extraction failed for ${item.custom_id}:`, e);
      }

      let rawText: string | undefined;
      try {
        rawText = JSON.stringify(content);
      } catch {
        rawText = undefined;
      }

      // A request the API SUCCEEDED on whose body we could not read is a
      // failure of this pipeline, and it must be reported as one. Before this,
      // `error` was hardcoded null: an unparseable batch-2 body produced
      // `data = {}` with `error: null`, so v3pipeline's `if (r2?.error)` branch
      // never fired, the step trace recorded status "ok", and every consumer of
      // the parsed payload silently received nothing. That is exactly how the
      // 2020 Yaris canary reached "complete / fill 83" while its batch-2
      // `services[]` was empty — which starved labor (100% default_fallback),
      // quotability (`{pct: 1, services: []}`) and role applicability
      // (`applicable_services_unknown`) all at once, with no error anywhere.
      const parseError = classifyParseOutcome({
        parseThrew,
        parseErrorMessage,
        parsedKeyCount: Object.keys(data).length,
        rawTextLength: rawText?.length ?? 0,
      });
      if (parseError != null && !parseThrew) {
        console.error(
          `[batch] JSON extraction yielded {} for ${item.custom_id} from ` +
            `${rawText?.length ?? 0} chars — treating as an error`,
        );
      }

      results[item.custom_id] = {
        customId: item.custom_id,
        data,
        rawText,
        usage: {
          tokensIn: (message as any).usage?.input_tokens ?? 0,
          tokensOut: (message as any).usage?.output_tokens ?? 0,
          webSearches,
        },
        error: parseError,
      };
    } else {
      console.error(`[batch] Request ${item.custom_id} ${item.result.type}`);
      console.error(`[batch] ERROR detail: ${JSON.stringify(item.result)}`);
      // Carry the API's own message into the returned entry, not just the
      // bare type. The type alone ("errored") is what the run row and the
      // step trace persist, so a schema/shape rejection was only findable by
      // tailing deploy logs — which is how a batch-wide failure (structured
      // outputs exceeding the 16-union-parameter limit, Jul 30 2026) stayed
      // opaque until someone went looking in the console.
      const detail =
        (item.result as any)?.error?.error?.message ??
        (item.result as any)?.error?.message ??
        null;
      results[item.custom_id] = {
        customId: item.custom_id,
        data: {},
        usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 },
        error: detail
          ? `${item.result.type}: ${String(detail).slice(0, 400)}`
          : item.result.type,
      };
    }
  }

  console.log(`[batch] Parsed ${Object.keys(results).length} results from ${batchId}`);
  return results;
}
