/**
 * lib/transmissionTypeInference.ts — Haiku-based transmission type canonicalizer.
 *
 * Replaces the hardcoded keyword whitelist that was paying maintenance every
 * time a new marketing term appeared (PDK / DSG / S tronic / SpeedShift MCT /
 * PowerShift / EDC / Tiptronic / SMG / Dual Dry Clutch / ...).
 *
 * Contract:
 *   canonicalizeTransmissionType("Porsche PDK")          → "DCT"
 *   canonicalizeTransmissionType("Tiptronic")            → "automatic"
 *   canonicalizeTransmissionType("Direct shift gearbox") → "DCT"
 *   canonicalizeTransmissionType("Automatic")            → "automatic" (fast path)
 *   canonicalizeTransmissionType("Single-Speed Gear")    → "automatic" (EVs)
 *   canonicalizeTransmissionType("")                     → null
 *
 * Returns null when input is empty, the value is "unknown", Haiku is
 * unavailable, or Haiku's response doesn't match the canonical set.
 *
 * Cache: in-memory module-level Map keyed by `raw.toLowerCase()`. Survives
 * within a Convex worker but not across deploys — fine because the universe of
 * unique transmission style strings from NHTSA + Claude is bounded (~50 ever)
 * and cache hits dominate after the first day of warm-up.
 *
 * Cost guard: returns null when ANTHROPIC_API_KEY is missing. Callers fall
 * back to whatever they had before (usually the literal raw string or null).
 */

import Anthropic from "@anthropic-ai/sdk";

export type TransmissionTypeCanonical = "automatic" | "manual" | "CVT" | "DCT";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

const cache = new Map<string, TransmissionTypeCanonical | null>();

/**
 * Already-canonical fast path. Avoids a Haiku call when the input matches the
 * canonical vocabulary (case-insensitive). This is the *only* hardcoded thing
 * in this module — it's the canonical vocabulary we publish, not pattern
 * matching against the long tail of marketing names.
 */
function fastPath(raw: string): TransmissionTypeCanonical | null {
  const u = raw.trim().toUpperCase();
  const l = raw.trim().toLowerCase();
  if (l === "automatic") return "automatic";
  if (l === "manual")    return "manual";
  if (u === "CVT")       return "CVT";
  if (u === "DCT")       return "DCT";
  return null;
}

const SYSTEM = `Classify an automotive transmission description into ONE of these four canonical types:
  automatic, manual, CVT, DCT

Reply with the canonical token ONLY (one word). No explanation, no punctuation, no extra text. If genuinely unclassifiable, reply with the single token: unknown.

Conventions:
- Any dual-clutch / automated-manual variant (Porsche PDK, VAG DSG, Audi S tronic, BMW M DCT, Ford PowerShift, Renault EDC, Mercedes-AMG SpeedShift MCT, Hyundai/Kia DCT, BMW SMG, Direct Shift Gearbox) → DCT
- Conventional torque-converter slushbox, Tiptronic, Steptronic, Geartronic → automatic
- EV single-speed reduction gear → automatic
- Continuously Variable Transmission, IVT, e-CVT, Direct Shift-CVT → CVT
- True three-pedal stick shift, gated manual → manual
- Hybrid/EV with no transmission concept → automatic`;

/**
 * Canonicalize any transmission style/marketing string into one of the four
 * canonical types, or null when undetermined.
 */
export async function canonicalizeTransmissionType(
  raw: string | null | undefined,
): Promise<TransmissionTypeCanonical | null> {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "unknown") return null;

  // Fast path — input is already canonical.
  const fast = fastPath(trimmed);
  if (fast) return fast;

  const cacheKey = trimmed.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const client = getClient();
  if (!client) {
    cache.set(cacheKey, null);
    return null;
  }

  try {
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 20,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: trimmed }],
    });
    let text = "";
    for (const block of res.content) if (block.type === "text") text += block.text;
    text = text.trim();
    // Strip a trailing period or quote if Haiku wraps it.
    text = text.replace(/[."'`]+$/g, "").trim();

    let normalized: TransmissionTypeCanonical | null = null;
    if (text === "automatic" || text === "manual" || text === "CVT" || text === "DCT") {
      normalized = text;
    }
    cache.set(cacheKey, normalized);
    if (normalized) {
      console.log(`[trans-canonicalize] "${trimmed}" → ${normalized}`);
    } else {
      console.log(`[trans-canonicalize] "${trimmed}" → unclassifiable (Haiku=${JSON.stringify(text)})`);
    }
    return normalized;
  } catch (e) {
    console.warn(`[trans-canonicalize] Haiku failed for "${trimmed}": ${e}`);
    // Don't cache failures — next call for the same input gets a fresh attempt.
    return null;
  }
}
