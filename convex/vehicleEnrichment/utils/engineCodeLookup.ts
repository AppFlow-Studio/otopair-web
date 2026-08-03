/**
 * vehicleEnrichment/utils/engineCodeLookup.ts
 *
 * Resolves the real OEM engine code when NHTSA returns a descriptor string
 * instead of an actual code (e.g. "Nu MPI" → "G4NH", "EcoBoost" → "Fox").
 *
 * Priority:
 *   1. DB lookup — engines table by trim_id (free, instant)
 *   2. Haiku inference — one Claude call with web search (~$0.002)
 *
 * Returns the original engineCode unchanged if it already looks like a real
 * OEM code (no spaces, short alphanumeric string).
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./batchClient";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Returns true if the string is a placeholder rather than a real OEM engine code.
 *
 * Real OEM codes are compact alphanumeric strings with optional dashes
 * ("G4NH", "B58B30M1", "L83", "EJ257"). Anything else is a placeholder we
 * need Haiku to resolve.
 *
 * Catches:
 *   - empty / "unknown" / "n/a"
 *   - NHTSA descriptors with spaces ("Nu MPI", "EcoBoost 2.3L") or > 14 chars
 *   - VDB placeholders ("STDEN")
 *   - synthetic fallback codes from processVin ("3.6l_3.6cyl", "2.0l_4cyl")
 *   - any code containing underscores (real OEM codes never use _)
 *   - codes that are purely numeric or start with a digit followed by "l"
 *     (those are displacement-derived synthetics, not real codes)
 */
export function isNhtsaDescriptor(engineCode: string): boolean {
  if (!engineCode) return true;
  const trimmed = engineCode.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();

  // Generic placeholders
  if (lower === "unknown" || lower === "n/a" || lower === "none" || lower === "null") return true;

  // Round 10 (batch-11 Crosstrek): "NA" — an aspiration descriptor read as a
  // code by the decode fallback — keyed a config as `..._limited_na`. Reject
  // aspiration/architecture tokens outright; none is ever an OEM code.
  if (
    lower === "na" || lower === "turbo" || lower === "turbocharged" ||
    lower === "supercharged" || lower === "dohc" || lower === "sohc" ||
    lower === "ohv" || lower === "gdi" || lower === "mpi" ||
    lower === "hybrid" || lower === "diesel" ||
    lower === "i4" || lower === "v6" || lower === "v8" || lower === "h4" ||
    lower === "boxer"
  ) return true;

  // Known VDB placeholder values
  if (lower === "stden") return true;

  // NHTSA descriptors with spaces or absurd length
  if (/\s/.test(trimmed) || trimmed.length > 14) return true;

  // Synthetic codes from processVin fallback ("3.6l_3.6cyl", "2.0l_4cyl")
  if (/^\d+(?:\.\d+)?l[_-]\d+(?:\.\d+)?cyl$/i.test(trimmed)) return true;

  // Real OEM codes never have underscores. Anything with _ is a synthetic.
  if (trimmed.includes("_")) return true;

  // Pattern that starts with displacement-and-l (like "3.6L" or "20l")
  // — those are descriptors, not codes.
  if (/^\d+(?:\.\d+)?l$/i.test(trimmed)) return true;

  return false;
}

const SYSTEM = `You are an automotive engineering expert. Given a vehicle description, find the OEM engine code.

Rules:
- Search the web for the engine code — do NOT answer from memory alone. Prefer manufacturer catalogs, parts catalogs (AMSOIL lookup, RockAuto, OEM parts sites), or the maker's own engine-family documentation.
- The code must match the given displacement and cylinder count. A code for a different engine in the same lineup is WRONG (e.g. the 1.6T code on a 2.0 MPI car).
- **The code must also match the vehicle's MODEL YEAR / GENERATION.** A maker often uses a NEW engine code for the same displacement when a model is redesigned. The previous-generation engine shares the litres and the nameplate but is a DIFFERENT engine and a DIFFERENT code — do NOT return it for a later model year. Example: the 2013+ Nissan Sentra (B17) 1.8L is the **MRA8DE**; the earlier **MR18DE** 1.8L is the prior generation and is WRONG for a 2013. Confirm the code's production years INCLUDE this vehicle's model year.
- Respond with ONLY a JSON object on one line: {"code": "<OEM code>", "evidence_url": "<url that ties this code to this exact vehicle+displacement+year>"}
- If you cannot find a code tied to this exact vehicle, displacement, AND model year by a source, respond exactly: {"code": "unknown"}`;

const VERIFY_SYSTEM = `You are an automotive fact-checker. You will be given a vehicle and a claimed OEM engine code. Search the web and try to REFUTE the claim.

The claim is WRONG if the code belongs to:
- a different displacement, different engine family, or a different model — even from the same manufacturer;
- **a different GENERATION / model-year range of the SAME model.** This is the sneakiest case: the code shares the displacement AND the nameplate but belongs to the previous (or next) generation — its production years do NOT include this vehicle's model year. Example: MR18DE on a 2013 Sentra (that generation uses the MRA8DE; MR18DE is the older B16 engine).
Codes fabricated to look plausible (right format, wrong engine) — or right-displacement-but-wrong-generation — are the failure mode you are hunting. Always check the code's production YEAR RANGE against this vehicle's model year.

Respond with ONLY a JSON object on one line:
{"verdict": "confirmed" | "refuted" | "uncertain", "reason": "<one short sentence>"}
Default to "uncertain" when the evidence is thin — do not confirm without a source tying the code to this exact vehicle, displacement, AND model year.`;

function parseJsonLine(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function callWithSearch(system: string, user: string): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL_HAIKU,
    max_tokens: 512,
    temperature: 0,
    system,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 } as any],
    messages: [{ role: "user", content: user }],
  });
  return response.content
    .filter(b => b.type === "text")
    .map(b => (b as any).text)
    .join("")
    .trim();
}

/**
 * Adversarial second opinion: an independent web-search call tries to refute
 * the resolved code. Added Jul 2026 after the 5-VIN test caught three
 * hallucinated codes (CZDA on an Atlas VR6, nonexistent "ERG" on a Durango,
 * G4FJ on a 2.0 MPI Soul) flowing into config keys and extraction prompts.
 */
export async function verifyEngineCode(
  code: string,
  year: number,
  make: string,
  model: string,
  trim: string,
  displacement: string,
  cylinders: number,
): Promise<"confirmed" | "refuted" | "uncertain"> {
  try {
    const text = await callWithSearch(
      VERIFY_SYSTEM,
      `Vehicle: ${year} ${make} ${model} ${trim}, ${displacement}L ${cylinders}-cylinder\nClaimed OEM engine code: "${code}"`,
    );
    const parsed = parseJsonLine(text);
    const verdict = parsed?.verdict;
    if (verdict === "confirmed" || verdict === "refuted") {
      console.log(`[engine-lookup] Verification of "${code}": ${verdict}${parsed?.reason ? ` — ${parsed.reason}` : ""}`);
      return verdict;
    }
    console.log(`[engine-lookup] Verification of "${code}": uncertain${parsed?.reason ? ` — ${parsed.reason}` : ""}`);
    return "uncertain";
  } catch (e) {
    console.warn("[engine-lookup] Verification call failed:", e);
    return "uncertain";
  }
}

/**
 * Resolve the real OEM engine code for a vehicle.
 *
 * source semantics for callers:
 *   "passthrough" — input already a real code, unchanged
 *   "verified"    — web-search-resolved AND independently confirmed; safe to
 *                   persist to engines.engine_code and bake into config_key
 *   "unverified"  — resolved but the adversarial check did not confirm it;
 *                   callers MUST NOT persist it or key configs on it
 *   "unknown"     — could not resolve; original placeholder returned
 */
export async function resolveEngineCode(
  year: number,
  make: string,
  model: string,
  trim: string,
  displacement: string,
  cylinders: number,
  fuelType: string,
  rawEngineCode: string,
  opts?: {
    /** Round 10: resolve even when the raw code looks like a real OEM code —
     *  used after an adversarial verification REFUTED the decoder's code
     *  (batch-11 Equinox: vPIC returned the 2025 RPO "LSD" on a 2024 VIN). */
    forceResolve?: boolean;
  },
): Promise<{ engineCode: string; source: "passthrough" | "verified" | "unverified" | "unknown" }> {

  // Already a clean OEM code — pass through
  if (!isNhtsaDescriptor(rawEngineCode) && !opts?.forceResolve) {
    return { engineCode: rawEngineCode, source: "passthrough" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[engine-lookup] No API key — cannot infer engine code");
    return { engineCode: rawEngineCode, source: "unknown" };
  }

  console.log(`[engine-lookup] "${rawEngineCode}" looks like a NHTSA descriptor — inferring real OEM code for ${year} ${make} ${model} ${trim}`);

  try {
    const text = await callWithSearch(
      SYSTEM,
      `${year} ${make} ${model} ${trim}\nDisplacement: ${displacement}L, ${cylinders} cylinders, ${fuelType}\nNHTSA description: "${rawEngineCode}"`,
    );

    const parsed = parseJsonLine(text);
    const code = typeof parsed?.code === "string" ? parsed.code.trim() : "";

    if (!code || code.toLowerCase() === "unknown" || isNhtsaDescriptor(code)) {
      console.warn(`[engine-lookup] Could not resolve engine code for ${year} ${make} ${model}`);
      return { engineCode: rawEngineCode, source: "unknown" };
    }

    console.log(`[engine-lookup] Resolved: "${rawEngineCode}" → "${code}" (evidence: ${parsed?.evidence_url ?? "none"}) for ${year} ${make} ${model} ${trim}`);

    const verdict = await verifyEngineCode(code, year, make, model, trim, displacement, cylinders);
    if (verdict === "confirmed") {
      return { engineCode: code, source: "verified" };
    }

    // Refuted or uncertain: surface the candidate but do not let callers
    // persist it — a wrong code poisons the config key, sibling matching,
    // and every extraction prompt downstream.
    console.warn(`[engine-lookup] Code "${code}" NOT confirmed (${verdict}) — callers must keep the placeholder`);
    return { engineCode: code, source: "unverified" };

  } catch (e) {
    console.error("[engine-lookup] Inference failed:", e);
    return { engineCode: rawEngineCode, source: "unknown" };
  }
}
