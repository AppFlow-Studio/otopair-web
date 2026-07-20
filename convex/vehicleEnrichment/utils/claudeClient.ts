/**
 * vehicleEnrichment/utils/claudeClient.ts — Claude SDK wrapper
 *
 * Tier 1 rate limits (Claude Sonnet):
 *   - 30,000 input tokens/minute  ← PRIMARY constraint for this pipeline
 *   - 8,000 output tokens/minute
 *   - 50 requests/minute
 *   - 30 web searches/second      ← Not a concern (we use ~20-40 total)
 *
 * Each pipeline call uses 50K–160K input tokens (web search results are
 * large). The gate computes how long to wait for the token bucket to
 * replenish enough for the next call using the formula:
 *
 *   replenishMs = (tokensNeeded - tokensRemaining) / (inputTokensLimit / 60_000)
 *
 * This is exact and works at any tier — no hardcoded delays.
 *
 * Key findings from research:
 *   - web_search too_many_requests → HTTP 200 (not 429), not our problem
 *   - No web-search-specific rate limit headers exist
 *   - retry-after on HTTP 429 is authoritative
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-5-20250929";

// ─── Rate Limit Types ────────────────────────────────────────────

export interface RateLimitInfo {
  tokensRemaining: number;
  inputTokensRemaining: number;
  inputTokensLimit: number;       // from anthropic-ratelimit-input-tokens-limit
  outputTokensRemaining: number;
  requestsRemaining: number;
  /** Max ms until any of the three limits reset */
  msUntilReset: number;
  /** Breakdown of each limit's reset time */
  resetBreakdown: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
  };
  /** Web searches used in the call that produced this info */
  webSearchesUsed: number;
  /** retry-after from 429 (if any), in ms */
  retryAfterMs: number | null;
}

export interface ClaudeCallResult {
  data: Record<string, any>;
  rateLimitInfo: RateLimitInfo;
  usage: { tokensIn: number; tokensOut: number; webSearches: number };
}

const DEFAULT_RATE_LIMIT: RateLimitInfo = {
  tokensRemaining: 0,
  inputTokensRemaining: 0,
  inputTokensLimit: 30_000,       // Tier 1 default; overwritten from headers
  outputTokensRemaining: 0,
  requestsRemaining: 0,
  msUntilReset: 30_000,
  resetBreakdown: { requests: 0, inputTokens: 0, outputTokens: 0 },
  webSearchesUsed: 0,
  retryAfterMs: null,
};

// ─── SDK Client (lazy singleton) ─────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // maxRetries: 0 — we do our own retry at the pipeline level with proper
      // delays. Letting the SDK retry silently burns through the rate limit
      // window without giving us a chance to apply the correct delay.
      maxRetries: 0,
    });
  }
  return _client;
}

// ─── Shared Rate-Limit Gate ───────────────────────────────────────
//
// Tier 1 limits: 30K input tokens/min, 8K output tokens/min, 50 RPM.
// A single pipeline call uses 50K–160K input tokens, so each call
// exceeds the per-minute budget. The gate computes the exact wait using:
//
//   replenishMs = (tokensNeeded - tokensAvailable) / (limit / 60_000)
//
// where tokensAvailable accounts for continuous replenishment since the
// last call. This is exact at any tier — no hardcoded delays.

interface GateState {
  /** Earliest epoch-ms at which the next API call is allowed (RPM gate). */
  apiReadyAt: number;
  /** Input tokens remaining as reported by the last response headers. */
  inputTokensRemaining: number;
  /** Per-minute input token limit from headers (e.g. 30_000 on Tier 1). */
  inputTokensLimit: number;
  /** epoch-ms when the last successful response was received. */
  lastResponseMs: number;
}

const _gate: GateState = {
  apiReadyAt: 0,
  inputTokensRemaining: 999_999,
  inputTokensLimit: 30_000,       // Tier 1 default; overwritten from headers
  lastResponseMs: 0,
};

/**
 * Block until enough input tokens have replenished for `estimatedInputTokens`.
 *
 * Formula: replenishMs = (needed - available) / (limit / 60_000)
 * where available = remaining + (elapsed since last response) * refill rate
 */
async function waitForGate(_usesWebSearch: boolean, estimatedInputTokens = 50_000): Promise<number> {
  const now = Date.now();

  // ── RPM gate ──────────────────────────────────────────────────
  let waitUntil = _gate.apiReadyAt;

  // ── Token replenishment gate ──────────────────────────────────
  // Fresh gate (no response headers seen yet in this isolate): let the first
  // call through. The old behavior clamped the optimistic remaining to the
  // hardcoded 30k Tier-1 default and stalled every run 143s before its first
  // post-batch call (observed on all 5 runs, Jul 2026 test) — on the actual
  // deployment the real limit is orders of magnitude higher. If the account
  // truly is Tier 1, the 429 retry path below waits the authoritative
  // retry-after, which is strictly better than always paying a guessed stall.
  const refillRatePerMs = _gate.inputTokensLimit / 60_000;
  const elapsedMs = _gate.lastResponseMs > 0 ? now - _gate.lastResponseMs : 0;
  const replenishedSince = elapsedMs * refillRatePerMs;
  const tokensAvailable = _gate.lastResponseMs === 0
    ? estimatedInputTokens
    : Math.min(
        _gate.inputTokensRemaining + replenishedSince,
        _gate.inputTokensLimit,
      );

  if (tokensAvailable < estimatedInputTokens) {
    const stillNeeded = estimatedInputTokens - tokensAvailable;
    const replenishMs = stillNeeded / refillRatePerMs;
    const tokenGate = now + replenishMs + 3_000; // +3s safety buffer
    waitUntil = Math.max(waitUntil, tokenGate);
  }

  const remaining = waitUntil - now;

  if (remaining > 0) {
    console.log(
      `[RateLimit/gate] Waiting ${Math.round(remaining / 1000)}s — ` +
      `tokens: ~${Math.round(tokensAvailable).toLocaleString()} available, ` +
      `need ${estimatedInputTokens.toLocaleString()}, ` +
      `limit=${_gate.inputTokensLimit.toLocaleString()}/min`,
    );
    await new Promise<void>((r) => setTimeout(r, remaining));
    return remaining;
  }

  console.log(
    `[RateLimit/gate] Gate clear — ~${Math.round(tokensAvailable).toLocaleString()} tokens available for ${estimatedInputTokens.toLocaleString()} needed`,
  );
  return 0;
}

/**
 * Update the gate state after a completed call.
 */
function updateGate(info: RateLimitInfo, _callStartMs: number, _webSearches: number): void {
  const now = Date.now();

  _gate.inputTokensRemaining = info.inputTokensRemaining;
  if (info.inputTokensLimit > 0) _gate.inputTokensLimit = info.inputTokensLimit;
  _gate.lastResponseMs = now;

  console.log(
    `[RateLimit/gate] Updated: ${info.inputTokensRemaining.toLocaleString()} input tokens remaining, ` +
    `limit=${_gate.inputTokensLimit.toLocaleString()}/min ` +
    `(refill=${Math.round(_gate.inputTokensLimit / 60)}/s)`,
  );

  // ── RPM gate ──────────────────────────────────────────────────
  const MIN_CALL_SPACING = 5_000;
  let nextApiMs = now + MIN_CALL_SPACING;

  if (info.retryAfterMs && info.retryAfterMs > 0) {
    nextApiMs = now + info.retryAfterMs + 2_000;
    _gate.inputTokensRemaining = 0; // assume budget exhausted on 429
    console.log(`[RateLimit/gate] 429 retry-after → RPM gate +${Math.round(info.retryAfterMs / 1000)}s`);
  } else if (info.requestsRemaining <= 2 && info.resetBreakdown.requests > 0) {
    nextApiMs = now + info.resetBreakdown.requests + 3_000;
    console.log(`[RateLimit/gate] RPM critical (${info.requestsRemaining} left) → gate +${Math.round((nextApiMs - now) / 1000)}s`);
  }

  _gate.apiReadyAt = Math.max(_gate.apiReadyAt, nextApiMs);
}

// ─── Rate Limit Parsing ─────────────────────────────────────────

function getHeader(response: any, name: string): string | null {
  const h = response?.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  return h[name] ?? null;
}

function parseResetMs(response: any, headerName: string): number {
  const val = getHeader(response, headerName);
  if (!val) return 0;
  try {
    return Math.max(0, new Date(val).getTime() - Date.now());
  } catch {
    return 0;
  }
}

function parseRateLimitHeaders(response: any, webSearchesUsed: number = 0): RateLimitInfo {
  try {
    if (!response?.headers) return { ...DEFAULT_RATE_LIMIT, webSearchesUsed };

    const tokensRemaining = parseInt(getHeader(response, "anthropic-ratelimit-tokens-remaining") ?? "99999", 10);
    const inputTokensRemaining = parseInt(getHeader(response, "anthropic-ratelimit-input-tokens-remaining") ?? "99999", 10);
    const inputTokensLimit = parseInt(getHeader(response, "anthropic-ratelimit-input-tokens-limit") ?? "30000", 10);
    const outputTokensRemaining = parseInt(getHeader(response, "anthropic-ratelimit-output-tokens-remaining") ?? "99999", 10);
    const requestsRemaining = parseInt(getHeader(response, "anthropic-ratelimit-requests-remaining") ?? "99", 10);

    const requestsReset = parseResetMs(response, "anthropic-ratelimit-requests-reset");
    const inputTokensReset = parseResetMs(response, "anthropic-ratelimit-input-tokens-reset");
    const outputTokensReset = parseResetMs(response, "anthropic-ratelimit-output-tokens-reset");

    let retryAfterMs: number | null = null;
    const retryAfter = getHeader(response, "retry-after");
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
    }

    const msUntilReset = Math.max(requestsReset, inputTokensReset, outputTokensReset);

    return {
      tokensRemaining,
      inputTokensRemaining,
      inputTokensLimit,
      outputTokensRemaining,
      requestsRemaining,
      msUntilReset,
      resetBreakdown: {
        requests: requestsReset,
        inputTokens: inputTokensReset,
        outputTokens: outputTokensReset,
      },
      webSearchesUsed,
      retryAfterMs,
    };
  } catch {
    return { ...DEFAULT_RATE_LIMIT, webSearchesUsed };
  }
}

/**
 * Compute how long the pipeline should sleep between steps.
 *
 * This is now a thin wrapper over the shared gate state — it returns the
 * remaining time until the next call is safe, so the pipeline can log
 * and sleep accordingly. The gate itself is the source of truth; this
 * function just exposes "how long until the gate clears?" for logging.
 *
 * The `info` and `nextCallEstimatedTokens` params are kept for backward
 * compatibility but the gate (updated by `updateGate` inside each call
 * function) is more accurate than recomputing from stale header values.
 */
export function computeSmartDelay(
  _info: RateLimitInfo,
  _nextCallEstimatedTokens: number = 50_000,
): number {
  const MIN_DELAY = 5_000;
  const MAX_DELAY = 120_000;

  const now = Date.now();
  const gateDelay = _gate.apiReadyAt - now;
  const delay = Math.min(Math.max(gateDelay, MIN_DELAY), MAX_DELAY);

  console.log(
    `[RateLimit/computeSmartDelay] RPM gate=${Math.round(gateDelay / 1000)}s → returning ${Math.round(delay / 1000)}s`,
  );
  return delay;
}

// ─── JSON Extraction ─────────────────────────────────────────────

/**
 * Extract JSON from Claude response content blocks.
 * Handles mixed web_search responses (text + tool_use blocks).
 */
export function extractJsonFromContentBlocks(content: any[]): any {
  const textParts = content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");

  const stripped = textParts
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to bracket-matching
  }

  const startObj = stripped.indexOf("{");
  const startArr = stripped.indexOf("[");

  let startIdx: number;
  let openChar: string;
  let closeChar: string;

  if (startObj === -1 && startArr === -1) {
    throw new Error("No JSON found in Claude response");
  } else if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    startIdx = startObj;
    openChar = "{";
    closeChar = "}";
  } else {
    startIdx = startArr;
    openChar = "[";
    closeChar = "]";
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = startIdx; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;
    if (depth === 0) { endIdx = i; break; }
  }

  if (endIdx === -1) throw new Error("Unbalanced JSON in Claude response");
  return JSON.parse(stripped.slice(startIdx, endIdx + 1));
}

// ─── Web Search Usage Extraction ─────────────────────────────────

function getWebSearchCount(message: any): number {
  return message?.usage?.server_tool_use?.web_search_requests ?? 0;
}

// ─── API Call Functions ──────────────────────────────────────────

/**
 * Single raw attempt at a web-search Claude call.
 * Does NOT retry — the caller is responsible for retries.
 * Updates the shared gate on success or 429.
 */
async function attemptClaudeWithWebSearch(
  client: Anthropic,
  params: {
    system: string;
    userPrompt: string;
    maxSearchUses: number;
    maxTokens: number;
    temperature: number;
  },
  callStartMs: number,
): Promise<ClaudeCallResult> {
  const { system, userPrompt, maxSearchUses, maxTokens, temperature } = params;

  const { data: message, response } = await client.messages
    .create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: maxSearchUses,
      } as any],
    })
    .withResponse();

  const webSearches = getWebSearchCount(message);
  const rateLimitInfo = parseRateLimitHeaders(response, webSearches);
  updateGate(rateLimitInfo, callStartMs, webSearches);

  const usage = {
    tokensIn: (message as any).usage?.input_tokens ?? 0,
    tokensOut: (message as any).usage?.output_tokens ?? 0,
    webSearches,
  };

  const content = message.content ?? [];
  try {
    const data = extractJsonFromContentBlocks(Array.isArray(content) ? content : [content]);
    return { data, rateLimitInfo, usage };
  } catch (error) {
    console.error("[Claude] JSON extraction failed:", error);
    return { data: {}, rateLimitInfo, usage };
  }
}

/**
 * Call Claude with web_search tool enabled.
 *
 * Guarantees non-empty data by:
 * 1. Waiting for the shared gate before attempting the call.
 * 2. On 429, updating the gate with the retry-after value and retrying once
 *    (the gate's pre-call wait handles the actual sleep on the next attempt).
 * 3. On a second 429 (extremely rare), returning empty data so the pipeline
 *    can decide what to do.
 */
export async function callClaudeWithWebSearch(params: {
  system: string;
  userPrompt: string;
  maxSearchUses: number;
  maxTokens?: number;
  temperature?: number;
  /** Estimated input tokens this call will consume. Used to check token budget. */
  estimatedInputTokens?: number;
}): Promise<ClaudeCallResult> {
  const { system, userPrompt, maxSearchUses, maxTokens = 8000, temperature = 0, estimatedInputTokens = 100_000 } = params;
  const client = getClient();
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Pre-call gate: sleep until token budget + time windows clear
    await waitForGate(true, estimatedInputTokens);
    const callStartMs = Date.now();

    try {
      const result = await attemptClaudeWithWebSearch(
        client,
        { system, userPrompt, maxSearchUses, maxTokens, temperature },
        callStartMs,
      );
      return result;
    } catch (error: any) {
      if (error instanceof Anthropic.RateLimitError) {
        // Extract retry-after and push it into the gate
        let retryAfterMs: number | null = null;
        const retryAfter = (error.headers as any)?.["retry-after"] ?? (error.headers as any)?.get?.("retry-after");
        if (retryAfter) {
          const seconds = parseFloat(retryAfter);
          if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
        }
        const waitMs = retryAfterMs ?? 60_000;
        console.error(
          `[Claude] 429 on attempt ${attempt}/${MAX_ATTEMPTS} — pushing gate +${Math.round(waitMs / 1000)}s`,
        );
        // Push the gate forward so the next waitForGate() will sleep appropriately
        _gate.apiReadyAt = Math.max(_gate.apiReadyAt, Date.now() + waitMs + 2_000);
        _gate.inputTokensRemaining = 0; // assume budget exhausted on 429

        if (attempt === MAX_ATTEMPTS) {
          return {
            data: {},
            rateLimitInfo: {
              ...DEFAULT_RATE_LIMIT,
              retryAfterMs,
              msUntilReset: waitMs,
            },
            usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 },
          };
        }
        // Loop — waitForGate() on the next iteration will sleep until the gate clears
        continue;
      }

      if (error instanceof Anthropic.APIError) {
        console.error(`[Claude] API error ${error.status}: ${error.message}`);
        return {
          data: {},
          rateLimitInfo: DEFAULT_RATE_LIMIT,
          usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 },
        };
      }

      throw error;
    }
  }

  // Should not be reached
  return { data: {}, rateLimitInfo: DEFAULT_RATE_LIMIT, usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 } };
}

/**
 * Call Claude without tools — pure extraction.
 * Same gate-based approach as callClaudeWithWebSearch.
 */
export async function callClaudeExtractOnly(params: {
  system: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Estimated input tokens this call will consume. Used to check token budget. */
  estimatedInputTokens?: number;
}): Promise<ClaudeCallResult> {
  const { system, userPrompt, maxTokens = 4096, temperature = 0, estimatedInputTokens = 20_000 } = params;
  const client = getClient();
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Pre-call gate: token budget + API time gate (no search gate needed)
    await waitForGate(false, estimatedInputTokens);
    const callStartMs = Date.now();

    try {
      const { data: message, response } = await client.messages
        .create({
          model: MODEL,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: [{ role: "user", content: userPrompt }],
        })
        .withResponse();

      const rateLimitInfo = parseRateLimitHeaders(response);
      updateGate(rateLimitInfo, callStartMs, 0);

      const usage = {
        tokensIn: (message as any).usage?.input_tokens ?? 0,
        tokensOut: (message as any).usage?.output_tokens ?? 0,
        webSearches: 0,
      };

      let rawText = "";
      for (const block of message.content ?? []) {
        if (block.type === "text") rawText += block.text;
      }
      rawText = rawText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

      try {
        return { data: JSON.parse(rawText), rateLimitInfo, usage };
      } catch {
        console.error("[Claude] JSON parse failure. Raw:", rawText.slice(0, 500));
        return { data: {}, rateLimitInfo, usage };
      }
    } catch (error: any) {
      if (error instanceof Anthropic.RateLimitError) {
        let retryAfterMs: number | null = null;
        const retryAfter = (error.headers as any)?.["retry-after"] ?? (error.headers as any)?.get?.("retry-after");
        if (retryAfter) {
          const seconds = parseFloat(retryAfter);
          if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
        }
        const waitMs = retryAfterMs ?? 60_000;
        console.error(
          `[Claude] 429 (extract-only) on attempt ${attempt}/${MAX_ATTEMPTS} — pushing gate +${Math.round(waitMs / 1000)}s`,
        );
        _gate.apiReadyAt = Math.max(_gate.apiReadyAt, Date.now() + waitMs + 2_000);

        if (attempt === MAX_ATTEMPTS) {
          return {
            data: {},
            rateLimitInfo: {
              ...DEFAULT_RATE_LIMIT,
              retryAfterMs,
              msUntilReset: waitMs,
            },
            usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 },
          };
        }
        continue;
      }

      if (error instanceof Anthropic.APIError) {
        console.error(`[Claude] API error ${error.status}: ${error.message}`);
        return {
          data: {},
          rateLimitInfo: DEFAULT_RATE_LIMIT,
          usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 },
        };
      }

      throw error;
    }
  }

  return { data: {}, rateLimitInfo: DEFAULT_RATE_LIMIT, usage: { tokensIn: 0, tokensOut: 0, webSearches: 0 } };
}
