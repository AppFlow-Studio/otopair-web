/**
 * vehicleEnrichment/utils/engineLookup.ts — Haiku engine code + family lookup
 *
 * Called during enrichment (after VIN decode) to resolve:
 *   - engine_code: the full OEM variant code (e.g. "B48B20M1", "M276DE35AL", "2GR-FE")
 *   - engine_family: the base engine family (e.g. "B48", "M276", "2GR")
 *
 * When to call:
 *   1. engine_code is synthetic (e.g. "2.0l_4cyl") — VIN decode couldn't find it
 *   2. engine_family is null — never populated, even if code is known
 *
 * Cost: ~$0.002 per call (Haiku + one web search). Always cheaper than re-enriching.
 *
 * Pattern mirrors chassisLookup.ts.
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

/** Returns true if the engine code is a synthetic fallback, not a real OEM code. */
/**
 * Marketing terms and brand names that are NOT real OEM engine codes.
 * Shared classifier — vehicle_pipeline.ts, capacityResolver.ts, and
 * fleetEval.ts all import isSyntheticEngineCode from here.
 */
const MARKETING_TERMS = new Set([
  "tsi", "tfsi", "tdi", "fsi", "ecoboost", "coyote", "powerboost",
  "vtec", "ivtec", "earth dreams", "skyactiv-g", "skyactiv-d",
  "ecotec", "duramax", "vortec", "hemi", "pentastar", "hurricane",
  "boxer", "fa", "fb", "gdi", "mpi", "t-gdi", "nu mpi", "nu",
  "smartstream", "theta", "theta ii", "lambda", "lambda ii", "sigma",
  "kappa", "gamma", "delta", "epsilon", "zeta",
  "hr", "mr", "vr", "sr", "qr", "hybrid", "phev", "bev", "ev",
]);

/**
 * Engine-tech descriptor vocabulary that is never an OEM engine code on its
 * own. Fresh-VIN test (Aug 2026): NHTSA's EngineModel "PY Cylinder
 * Decativation" (sic — NHTSA's own typo) led with a plausible code fragment,
 * so the marketing-term prefix check missed it and the string was stored
 * verbatim, keying a config as ..._py_cylinder_decativation. The real code
 * (PY-VPS) is a compact single token — like every real OEM code.
 */
const DESCRIPTOR_WORDS = new Set([
  "cylinder", "cylinders", "deactivation", "decativation", "displacement",
  "turbo", "turbocharged", "biturbo", "supercharged", "aspirated", "na",
  "dohc", "sohc", "ohv", "ohc", "valve", "valves", "vvt", "cvvt",
  "injection", "injected", "diesel", "gasoline", "flex", "electric",
  "engine", "motor", "liter", "litre", "skyactiv",
  "i3", "i4", "i5", "i6", "v6", "v8", "v10", "v12", "h4", "h6",
]);

export function isSyntheticEngineCode(code: string): boolean {
  if (!code) return true;
  const lower = code.trim().toLowerCase();
  // Synthetic numeric format: "2.0l_4cyl", "unknown_unknowncyl", "3.5l_6cyl"
  if (/^[\d.]+l_\d+cyl$/i.test(code) || /^unknown/i.test(code)) return true;
  // Marketing terms (not real OEM codes)
  if (MARKETING_TERMS.has(lower)) return true;
  // Starts with a known marketing term (e.g. "Nu MPI 2.0" → starts with "nu mpi")
  if ([...MARKETING_TERMS].some((term) => lower.startsWith(term + " ") || lower.startsWith(term + "_"))) return true;
  // Real OEM codes are compact single tokens ("B48B20M1", "2GR-FE", "PY-VPS")
  // — whitespace means a descriptor phrase, whatever word it leads with.
  if (/\s/.test(lower)) return true;
  // Real OEM codes never use underscores; "_" is the synthetic-key separator.
  // Also covers decimal-cylinder synthetics ("3.6l_3.6cyl") that slip the
  // \d+cyl pattern above.
  if (lower.includes("_")) return true;
  // ...and never run long. Longest real designations ("M256E30DEHLG",
  // "OM651DE22LA") stay ≤ 13 chars; the 14 ceiling matches isNhtsaDescriptor
  // (utils/engineCodeLookup.ts) so the two classifiers agree.
  if (lower.length > 14) return true;
  // Single-token descriptor words ("Turbo", "DOHC", "Decativation")
  if (DESCRIPTOR_WORDS.has(lower)) return true;
  return false;
}

const ENGINE_SYSTEM = `You are a vehicle engineering expert. Identify the OEM engine code and engine family for a vehicle.

Definitions:
- engine_code: the full manufacturer-specific variant code. Include the complete suffix — displacement, cam/valve variants, market designation.
  Examples: "B48B20M1" (BMW 2.0L mild hybrid), "N63B44O2" (BMW 4.4L V8), "M276DE35AL" (Mercedes AMG 3.5L V6), "2GR-FE" (Toyota 3.5L V6 NA), "K24Z7" (Honda 2.4L), "EJ257" (Subaru 2.5L turbo), "LS3" (GM 6.2L V8)
- engine_family: the base family name shared across variants. Strip displacement digits, market suffixes, and variant letters.
  Examples: "B48" (from B48B20M1), "N63" (from N63B44O2), "M276" (from M276DE35AL), "2GR" (from 2GR-FE), "K24" (from K24Z7), "EJ25" (from EJ257), "LS" (from LS3)

Rules:
- Return ONLY valid JSON: {"engine_code": "...", "engine_family": "..."}
- No explanation, no markdown, no extra text.
- engine_code must be the full variant code, not just the family.
- engine_family must be the base name, shorter than or equal to engine_code.
- If you cannot determine engine_code with confidence, use null. Same for engine_family.
- Never guess. Only return values you can confirm from search results.
- {"engine_code": null, "engine_family": null} is a valid response if unknown.`;

export type EngineLookupResult = {
  engineCode: string | null;
  engineFamily: string | null;
  tokensIn: number;
  tokensOut: number;
};

/**
 * Ask Haiku to resolve engine_code and engine_family for a vehicle.
 *
 * @param existingCode - Pass the current engine_code from DB (may be synthetic or real).
 *                       If real, Haiku only needs to derive the family.
 *                       If synthetic/null, Haiku looks up both.
 */
export async function lookupEngineCodeAndFamily(
  year: number,
  make: string,
  model: string,
  trim: string,
  existingCode: string | null,
): Promise<EngineLookupResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("[engine-lookup] No API key, skipping");
    return { engineCode: null, engineFamily: null, tokensIn: 0, tokensOut: 0 };
  }

  const client = getClient();
  const vehicleStr = `${year} ${make} ${model} ${trim}`.trim();

  // If we already have a real engine code, only ask Haiku to derive the family.
  // This avoids overwriting a correct code with a hallucination.
  const codeIsKnown = existingCode && !isSyntheticEngineCode(existingCode);

  const userMessage = codeIsKnown
    ? `What is the engine family for a ${vehicleStr} with engine code "${existingCode}"? Search the web to confirm. Return JSON only: {"engine_code": "${existingCode}", "engine_family": "..."}`
    : `What is the full OEM engine code and engine family for a ${vehicleStr}? Search the web to confirm. Return JSON only: {"engine_code": "...", "engine_family": "..."}`;

  try {
    console.log(
      `[engine-lookup] ${vehicleStr}${codeIsKnown ? ` (code known: ${existingCode}, looking up family)` : " (looking up code + family)"}`,
    );

    const message = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 100,
      temperature: 0,
      system: ENGINE_SYSTEM,
      messages: [{ role: "user", content: userMessage }],
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

    // Extract text from response
    let rawText = "";
    for (const block of message.content ?? []) {
      if (block.type === "text") rawText += block.text;
    }

    const raw = rawText.trim();
    console.log(`[engine-lookup] Raw response: "${raw.substring(0, 200)}"`);

    // Parse JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`[engine-lookup] No JSON found in response`);
      return { engineCode: null, engineFamily: null, tokensIn, tokensOut };
    }

    let parsed: { engine_code?: string | null; engine_family?: string | null };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.log(`[engine-lookup] JSON parse failed: ${jsonMatch[0]}`);
      return { engineCode: null, engineFamily: null, tokensIn, tokensOut };
    }

    const engineCode = validateEngineCode(parsed.engine_code ?? null);
    const engineFamily = validateEngineFamily(parsed.engine_family ?? null);

    // If code was already known, don't replace it with what Haiku returned —
    // we passed it in, so it just echoed it back. Trust the existing code.
    const finalCode = codeIsKnown ? existingCode : engineCode;

    console.log(
      `[engine-lookup] Result for ${vehicleStr}: code="${finalCode}" family="${engineFamily}"`,
    );

    return { engineCode: finalCode, engineFamily, tokensIn, tokensOut };
  } catch (err) {
    console.error(`[engine-lookup] Failed:`, err);
    return { engineCode: null, engineFamily: null, tokensIn: 0, tokensOut: 0 };
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate a returned engine code string.
 * Rejects nulls, empty strings, obvious non-codes, and overly long values.
 */
function validateEngineCode(raw: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const code = raw.trim();
  if (code.length < 2 || code.length > 24) return null;
  if (code.toLowerCase() === "null" || code.toLowerCase() === "unknown") return null;
  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(code)) return null;
  return code;
}

/**
 * Validate a returned engine family string.
 * Family should be shorter than or equal to the code, and free of long phrases.
 */
function validateEngineFamily(raw: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const fam = raw.trim();
  if (fam.length < 1 || fam.length > 12) return null;
  if (fam.toLowerCase() === "null" || fam.toLowerCase() === "unknown") return null;
  if (!/[a-zA-Z]/.test(fam)) return null;
  return fam;
}
