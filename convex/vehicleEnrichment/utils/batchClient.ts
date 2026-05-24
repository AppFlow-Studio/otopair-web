/**
 * vehicleEnrichment/utils/batchClient.ts — Anthropic Message Batches API
 *
 * Batch requests are processed asynchronously (within 24h, usually minutes)
 * and do NOT count against standard API rate limits. 50% cheaper than real-time.
 *
 * Model strategy:
 *   - Haiku  → structured data extraction (1A fluids/intervals, 1B parts/trim, gap fill)
 *   - Sonnet → not used in batch pipeline (Haiku handles all extraction fine)
 *
 * Flow: submit → store batchId → poll every 5min → process results when done
 */

import Anthropic from "@anthropic-ai/sdk";
import { extractJsonFromContentBlocks } from "./claudeClient";

// ─── Model Constants ─────────────────────────────────────────────

/** Structured extraction: fluids, parts, intervals, specs */
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";
/** Reasoning-heavy tasks (not currently used in batch pipeline) */
export const MODEL_SONNET = "claude-sonnet-4-6";

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
  /** Defaults to MODEL_SONNET */
  model?: string;
}

export interface BatchResultEntry {
  customId: string;
  data: Record<string, any>;
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

  const batch = await client.messages.batches.create({
    requests: requests.map((req) => ({
      custom_id: req.customId,
      params: {
        model: req.model ?? MODEL_SONNET,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: req.system,
        messages: [{ role: "user", content: req.userPrompt }],
        ...(req.maxSearchUses > 0 ? {
          tools: [{
            type: "web_search_20250305",
            name: "web_search",
            ...(req.blockedDomains && req.blockedDomains.length > 0
              ? { blocked_domains: req.blockedDomains }
              : {}),
          }],
        } : {}),
      } as any,
    })),
  });

  console.log(`[batch] Submitted ${requests.length} requests → batchId=${batch.id}`);
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
      try {
        data = extractJsonFromContentBlocks(Array.isArray(content) ? content : [content]);
      } catch (e) {
        console.error(`[batch] JSON extraction failed for ${item.custom_id}:`, e);
      }

      results[item.custom_id] = {
        customId: item.custom_id,
        data,
        usage: {
          tokensIn: (message as any).usage?.input_tokens ?? 0,
          tokensOut: (message as any).usage?.output_tokens ?? 0,
          webSearches,
        },
        error: null,
      };
    } else {
      console.error(`[batch] Request ${item.custom_id} ${item.result.type}`);
      console.error(`[batch] ERROR detail: ${JSON.stringify(item.result)}`);
      results[item.custom_id] = {
        customId: item.custom_id,
        data: {},
        usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 },
        error: item.result.type,
      };
    }
  }

  console.log(`[batch] Parsed ${Object.keys(results).length} results from ${batchId}`);
  return results;
}
