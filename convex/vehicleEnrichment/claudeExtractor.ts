/**
 * vehicleEnrichment/claudeExtractor.ts — Claude API wrapper using official SDK
 *
 * Uses @anthropic-ai/sdk for:
 *   - Automatic retry on 429 with exponential backoff (maxRetries: 4)
 *   - Rate limit header access for smart inter-call spacing
 *
 * Two call modes:
 *   - callClaudeWithWebSearch(): Claude + web_search tool for live searching
 *   - callClaudeExtractOnly(): No tools, pure extraction from provided sources
 *
 * Returns { data, rateLimitInfo } so pipeline can compute exact delays.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-5-20250929";

// ─── Rate Limit Types ────────────────────────────────────────────

export interface RateLimitInfo {
  tokensRemaining: number;
  tokensResetAt: string | null;
  inputTokensRemaining: number;
  requestsRemaining: number;
  msUntilReset: number;
}

export interface ClaudeCallResult {
  data: Record<string, any>;
  rateLimitInfo: RateLimitInfo;
}

const DEFAULT_RATE_LIMIT: RateLimitInfo = {
  tokensRemaining: 0,
  tokensResetAt: null,
  inputTokensRemaining: 0,
  requestsRemaining: 0,
  msUntilReset: 15_000,
};

// ─── SDK Client (lazy singleton) ─────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 4, // Auto-retry 429s with exponential backoff
    });
  }
  return _client;
}

// ─── Rate Limit Helpers ──────────────────────────────────────────

/** Parse rate limit headers from SDK response. */
function parseRateLimitHeaders(response: any): RateLimitInfo {
  try {
    const h = response?.headers;
    if (!h) return DEFAULT_RATE_LIMIT;

    // Support both Headers.get() and plain object access
    const get = (name: string): string | null => {
      if (typeof h.get === "function") return h.get(name);
      return h[name] ?? null;
    };

    const tokensRemaining = parseInt(
      get("anthropic-ratelimit-tokens-remaining") ?? "99999",
      10,
    );
    const inputTokensRemaining = parseInt(
      get("anthropic-ratelimit-input-tokens-remaining") ?? "99999",
      10,
    );
    const requestsRemaining = parseInt(
      get("anthropic-ratelimit-requests-remaining") ?? "99",
      10,
    );
    const tokensResetAt = get("anthropic-ratelimit-tokens-reset");

    let msUntilReset = 0;
    if (tokensResetAt) {
      msUntilReset = Math.max(
        0,
        new Date(tokensResetAt).getTime() - Date.now(),
      );
    }

    return {
      tokensRemaining,
      tokensResetAt,
      inputTokensRemaining,
      requestsRemaining,
      msUntilReset,
    };
  } catch (e) {
    console.warn("[Claude] Failed to parse rate limit headers:", e);
    return DEFAULT_RATE_LIMIT;
  }
}

/**
 * Compute how long to wait before the next Claude call.
 * Reads actual token budget from rate limit headers instead of guessing.
 *
 * Always enforces a minimum 10s delay — web_search responses are large
 * and per-minute rate limits need time to refill even when headers look OK.
 * If headers indicate low budget, waits until the reset time.
 */
export function computeSmartDelay(
  info: RateLimitInfo,
  nextCallEstimatedTokens: number = 30_000,
): number {
  const MIN_DELAY = 10_000; // Always wait at least 10s between Claude calls

  console.log(
    `[RateLimit] Budget: ${info.tokensRemaining} tokens remaining, ${info.inputTokensRemaining} input tokens, ${info.requestsRemaining} requests. Reset in: ${Math.round(info.msUntilReset / 1000)}s`,
  );

  // Plenty of budget — use minimum delay
  if (info.tokensRemaining > nextCallEstimatedTokens * 1.5) {
    console.log(
      `[RateLimit] Budget OK (${info.tokensRemaining} > ${Math.round(nextCallEstimatedTokens * 1.5)}) — using minimum ${MIN_DELAY / 1000}s delay`,
    );
    return MIN_DELAY;
  }

  // Low budget — wait until the reset time + 2s buffer, but at least MIN_DELAY
  if (info.msUntilReset > 0) {
    const delay = Math.max(MIN_DELAY, Math.min(info.msUntilReset + 2_000, 65_000));
    console.log(
      `[RateLimit] Budget LOW (${info.tokensRemaining} tokens) — waiting ${Math.round(delay / 1000)}s until reset`,
    );
    return delay;
  }

  // No header info available — conservative fallback
  console.log("[RateLimit] No reset info — default 15s delay");
  return 15_000;
}

// ─── JSON Extraction ─────────────────────────────────────────────

/**
 * Extract JSON from Claude API response content blocks.
 *
 * When Claude uses web_search, the response contains mixed block types:
 *   - "text" blocks (conversational preamble + actual JSON)
 *   - "server_tool_use" blocks (search queries)
 *   - "web_search_tool_result" blocks (search results)
 *
 * This function:
 *   1. Filters for "text" blocks only
 *   2. Concatenates their text
 *   3. Strips markdown fences
 *   4. Finds the outermost JSON object ({…}) or array ([…])
 *   5. Parses and returns it
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

  // Try direct parse first (ideal case — response is pure JSON)
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to bracket-matching extraction
  }

  // Find the outermost JSON structure (object or array)
  const startObj = stripped.indexOf("{");
  const startArr = stripped.indexOf("[");

  let startIdx: number;
  let openChar: string;
  let closeChar: string;

  if (startObj === -1 && startArr === -1) {
    throw new Error("No JSON object or array found in Claude response");
  } else if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    startIdx = startObj;
    openChar = "{";
    closeChar = "}";
  } else {
    startIdx = startArr;
    openChar = "[";
    closeChar = "]";
  }

  // Walk forward counting braces/brackets, respecting strings
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = startIdx; i < stripped.length; i++) {
    const ch = stripped[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;

    if (depth === 0) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    throw new Error("Unbalanced JSON structure in Claude response");
  }

  return JSON.parse(stripped.slice(startIdx, endIdx + 1));
}

// ─── API Call Functions ──────────────────────────────────────────

/**
 * Call Claude with web_search tool enabled.
 * SDK auto-retries 429s (4 attempts with exponential backoff).
 * Returns parsed JSON data + rate limit info for smart inter-call spacing.
 */
export async function callClaudeWithWebSearch(
  systemPrompt: string,
  userPrompt: string,
  maxSearchUses: number,
  maxTokens: number = 8000,
): Promise<ClaudeCallResult> {
  const client = getClient();

  try {
    const { data: message, response } = await client.messages
      .create({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: maxSearchUses,
          } as any,
        ],
      })
      .withResponse();

    const rateLimitInfo = parseRateLimitHeaders(response);
    console.log(
      `[Claude] web_search response OK. Tokens remaining: ${rateLimitInfo.tokensRemaining}, reset in: ${Math.round(rateLimitInfo.msUntilReset / 1000)}s`,
    );

    const content = message.content ?? [];

    try {
      const data = extractJsonFromContentBlocks(
        Array.isArray(content) ? content : [content],
      );
      return { data, rateLimitInfo };
    } catch (error) {
      console.error(
        "[Claude] JSON extraction failed from web_search response:",
        error,
      );
      return { data: {}, rateLimitInfo };
    }
  } catch (error: any) {
    // SDK throws RateLimitError if all 4 retries are exhausted
    if (error instanceof Anthropic.RateLimitError) {
      console.error(
        "[Claude] Rate limit exhausted after 4 retries:",
        error.message,
      );
      return {
        data: {},
        rateLimitInfo: { ...DEFAULT_RATE_LIMIT, msUntilReset: 60_000 },
      };
    }
    // SDK throws APIError for other HTTP errors
    if (error instanceof Anthropic.APIError) {
      console.error(
        `[Claude] API error ${error.status}: ${error.message}`,
      );
      return { data: {}, rateLimitInfo: DEFAULT_RATE_LIMIT };
    }
    throw error;
  }
}

/**
 * Call Claude without tools — pure extraction from provided source material.
 * Used as a fallback or for simple extraction tasks.
 */
export async function callClaudeExtractOnly(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 4096,
): Promise<ClaudeCallResult> {
  const client = getClient();

  try {
    const { data: message, response } = await client.messages
      .create({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      })
      .withResponse();

    const rateLimitInfo = parseRateLimitHeaders(response);

    // Simple text extraction (no web_search blocks to handle)
    let rawText = "";
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        rawText += block.text;
      }
    }

    rawText = rawText
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();

    try {
      return { data: JSON.parse(rawText), rateLimitInfo };
    } catch {
      console.error("[Claude] JSON parse failure. Raw:", rawText.slice(0, 1000));
      return { data: {}, rateLimitInfo };
    }
  } catch (error: any) {
    if (error instanceof Anthropic.RateLimitError) {
      console.error("[Claude] Rate limit exhausted:", error.message);
      return {
        data: {},
        rateLimitInfo: { ...DEFAULT_RATE_LIMIT, msUntilReset: 60_000 },
      };
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`[Claude] API error ${error.status}: ${error.message}`);
      return { data: {}, rateLimitInfo: DEFAULT_RATE_LIMIT };
    }
    throw error;
  }
}
