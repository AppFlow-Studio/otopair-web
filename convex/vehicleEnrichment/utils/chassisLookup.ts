/**
 * vehicleEnrichment/utils/chassisLookup.ts — Haiku chassis code lookup
 *
 * After Tier 1 VIN decode, we ask Haiku (with one web search) to identify
 * the OEM chassis/generation code for a vehicle (e.g. "G30", "W206", "A90").
 *
 * This is cheap (~$0.002) and fast (~2-5s). If a completed vehicle_config
 * with the same chassis_code already exists in the DB, we can skip full
 * Tier 2 enrichment and clone service data from the existing config.
 *
 * Haiku is used instead of Sonnet because:
 *   - This is a simple factual lookup, not reasoning
 *   - One web search is sufficient
 *   - Cost: ~10x cheaper than Sonnet
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./batchClient";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const CHASSIS_SYSTEM = `You are a vehicle identification expert. Your job is to identify the OEM chassis/generation code for a vehicle.

Rules:
- Return ONLY the chassis code, nothing else. No explanation, no quotes.
- Examples: "G30", "W206", "A90", "FK8", "GR86", "T235", "KL1", "CD6"
- For BMW: use the G/F/E series code (e.g. G20, F30, E90)
- For Mercedes: use the W/C/X code (e.g. W206, C118, X167)
- For Toyota: use the platform code (e.g. A90, J300, TNGA-K)
- For Honda: use the chassis code (e.g. FK8, FL5, RW1)
- For all other brands: use whatever the industry-standard generation/chassis code is
- MODEL-YEAR DISCIPLINE: the code must be the generation actually IN PRODUCTION for the stated model year. Redesigns launch mid-calendar-year, so search results for a launch-overlap year mix two generations — a "2021 Hyundai Tucson" is the OLD 2016-2021 generation (TL), NOT the redesigned model sold from MY2022 (NX4). When the stated model year is the last year of an outgoing generation, return the OUTGOING generation's code.
- If you truly cannot determine the chassis code, respond with exactly: UNKNOWN
- Never guess. If unsure, respond UNKNOWN.`;

/**
 * Ask Haiku to identify the chassis/generation code for a vehicle.
 *
 * @returns The chassis code string (e.g. "G30") or null if lookup failed/unknown.
 */
export async function lookupChassisCode(
  year: number,
  make: string,
  model: string,
  trim?: string,
): Promise<{ chassisCode: string | null; tokensIn: number; tokensOut: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("[chassis] No API key, skipping chassis lookup");
    return { chassisCode: null, tokensIn: 0, tokensOut: 0 };
  }

  const client = getClient();
  const trimPart = trim ? ` ${trim}` : "";
  const query = `${year} ${make} ${model}${trimPart}`;

  try {
    console.log(`[chassis] Looking up chassis code for: ${query}`);

    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 4096,
      temperature: 0,
      system: CHASSIS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `What is the chassis/generation code for a ${query}? Search the web to confirm.`,
        },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 1,
        } as any,
      ],
    });

    const tokensIn = (message as any).usage?.input_tokens ?? 0;
    const tokensOut = (message as any).usage?.output_tokens ?? 0;

    // Log all content block types for debugging
    const blockTypes = (message.content ?? []).map((b: any) => b.type);
    console.log(`[chassis] Response blocks: [${blockTypes.join(", ")}]`);

    // Extract text from response — check both "text" and any other block types
    let rawText = "";
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        rawText += block.text;
      }
    }

    const raw = rawText.trim();
    console.log(`[chassis] Raw response for ${query}: "${raw.substring(0, 100)}"`);

    // Try to extract a chassis code from the response.
    // Haiku sometimes returns extra text like "The chassis code is W167" or "W167\n\nThis is the..."
    // Strategy: look for known chassis code patterns, then fall back to first alphanumeric token.
    let chassisCode: string | null = null;

    // Pattern 1: Known OEM chassis code formats
    // BMW: G/F/E + 2 digits (G30, F30, E90)
    // Mercedes: W/C/X/R/V + 3 digits (W167, C118, R232, V167, X167)
    // Toyota/Lexus: letter(s) + 2-3 digits or alphanumeric (A90, J300, XA50)
    // Honda: 2-3 letters + 1-2 digits (FK8, FL5, RW1, DE4)
    // General: 2-6 alphanumeric chars
    const patterns = [
      /\b([GFEU]\d{2})\b/i,                    // BMW G30, F30, E90, U11
      /\b([WCXRV]\d{3})\b/i,                   // Mercedes W167, C118, R232
      /\b([A-Z]{1,3}\d{2,3})\b/i,              // Toyota A90, J300, Honda FK8
      /\b([A-Z]{2}\d{1,2})\b/i,                // Honda RW1, DE4
      /\b([A-Z0-9]{2,6})\b/,                   // General fallback
    ];

    const upper = raw.toUpperCase();

    // Skip if response is clearly unknown
    if (upper.includes("UNKNOWN") || upper.includes("I CANNOT") || upper.includes("I'M NOT SURE")) {
      console.log(`[chassis] Lookup returned unknown/uncertain — skipping`);
      return { chassisCode: null, tokensIn, tokensOut };
    }

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match) {
        const candidate = match[1].toUpperCase();
        // Filter out common false positives (numbers only, single chars, common words)
        const NOISE = new Set(["THE", "FOR", "AND", "OEM", "AMG", "BMW", "VIN", "ALL", "NOT", "YES"]);
        if (candidate.length >= 2 && candidate.length <= 6 && !NOISE.has(candidate) && /[A-Z]/.test(candidate)) {
          chassisCode = candidate;
          break;
        }
      }
    }

    if (!chassisCode) {
      // Last resort: take the first line, first token
      const firstToken = raw.split(/[\s\n,.:;]+/)[0]?.toUpperCase() ?? "";
      if (firstToken.length >= 2 && firstToken.length <= 6 && /[A-Z]/.test(firstToken)) {
        chassisCode = firstToken;
      }
    }

    if (!chassisCode) {
      console.log(`[chassis] Could not extract chassis code from: "${raw.substring(0, 100)}"`);
      return { chassisCode: null, tokensIn, tokensOut };
    }

    console.log(`[chassis] Found chassis code: ${chassisCode} for ${query}`);
    return { chassisCode, tokensIn, tokensOut };
  } catch (err) {
    console.error(`[chassis] Lookup failed:`, err);
    return { chassisCode: null, tokensIn: 0, tokensOut: 0 };
  }
}
