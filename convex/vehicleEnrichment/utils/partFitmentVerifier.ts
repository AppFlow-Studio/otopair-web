/**
 * vehicleEnrichment/utils/partFitmentVerifier.ts — adversarial fitment check
 * for core-role OEM parts, run once at finalize.
 *
 * Why: the Jul 2026 5-VIN test showed the extraction's dominant failure mode
 * is PLAUSIBLE-but-wrong parts from a sibling model or engine variant — a
 * 5.7L HEMI oil filter on a 3.6L Durango, Golf pads on an Atlas, a Duratec
 * filter on a Vulcan Taurus, Seltos/Niro parts on a Soul. These pass format
 * sanitization (they are real part numbers) and ship into quotes. One cheap
 * web-search call per run cross-examines the highest-consequence parts; a
 * refuted part's fitment is deleted so the role either falls to its universal
 * fallback or reads as an honest gap.
 *
 * Verdict semantics mirror engineCodeLookup's verifier: only an explicit
 * "refuted" acts — "uncertain" never deletes data.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./batchClient";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/** Highest-consequence roles, checked first when the per-run cap bites —
 *  the parts that drive the most common services and caused the 5-VIN P0s. */
export const VERIFY_PRIORITY_ROLE_KEYS = new Set([
  "oil_filter",
  "air_filter",
  "cabin_filter",
  "front_brake_pad",
  "rear_brake_pad",
  "spark_plug",
  "coolant",
  "atf_fluid",
  "engine_oil",
]);

/** Batch-2 audit: a wrong-model o-ring (Genesis V6 part on a Soul) shipped
 *  because only the priority roles were sampled. Every priced non-universal
 *  part is now eligible, priority roles first, up to this cap. */
export const VERIFY_MAX_PARTS = 14;

/** Back-compat alias (v3pipeline imported this name in round 1). */
export const VERIFY_ROLE_KEYS = VERIFY_PRIORITY_ROLE_KEYS;

export interface FitmentToVerify {
  roleKey: string;
  oem: string;
  name: string;
}

export interface FitmentVerdict {
  roleKey: string;
  oem: string;
  verdict: "confirmed" | "refuted" | "uncertain";
  reason: string;
}

const SYSTEM = `You are an automotive parts fact-checker. You will be given a vehicle and a list of OEM part numbers a pipeline claims fit it. Search the web and try to REFUTE each claim.

A claim is REFUTED when the part number belongs to:
- a different engine variant of the same model (e.g. the V8 oil filter on the V6, a spin-on filter on a cartridge-filter engine),
- a different model or platform from the same manufacturer (e.g. Golf pads listed for an Atlas, a Seltos air filter listed for a Soul),
- **a different GENERATION or year range of the SAME nameplate** — this is the sneakiest failure: the part number looks right because the model name matches, but its catalog fitment range ends before (or starts after) this model year. Example: pad kit 26296SC011 fits Subaru "WRX" only through 2014; on a 2015 WRX (new VA chassis) it is WRONG even though every listing says "WRX". ALWAYS check the exact fitment YEAR RANGE against this vehicle's model year — "same model name" is not confirmation.
- the wrong axle or position (a front-axle pad set claimed as rear pads),
- a fluid spec the vehicle must not use (e.g. an older-generation coolant on a car requiring the newer chemistry).

Rules:
- Budget your searches: check the parts most likely to be wrong first; mark anything you could not check as "uncertain".
- Only mark "refuted" when a source ties the part to a DIFFERENT vehicle/variant/year-range and nothing credible ties it to this one.
- Only mark "confirmed" when a source ties the part to this exact vehicle — model AND year within the part's fitment range (or its exact platform+engine). A listing that names the model but whose year range excludes this vehicle's year is grounds for refuted, not confirmed.
- Respond with ONLY a JSON array, one object per input part, same order:
[{"idx": 1, "verdict": "confirmed" | "refuted" | "uncertain", "reason": "<one short sentence>"}]`;

/**
 * Verify up to ~8 core-role parts in ONE web-search call. Never throws —
 * on any failure every part comes back "uncertain" (verification must not
 * be able to break an enrichment run).
 */
export async function verifyPartFitments(
  vehicle: {
    year: number;
    make: string;
    model: string;
    trim: string;
    engineCode?: string | null;
    displacement?: string | null;
  },
  parts: FitmentToVerify[],
): Promise<FitmentVerdict[]> {
  const uncertainAll = (reason: string): FitmentVerdict[] =>
    parts.map((p) => ({ roleKey: p.roleKey, oem: p.oem, verdict: "uncertain" as const, reason }));

  if (parts.length === 0) return [];
  if (!process.env.ANTHROPIC_API_KEY) return uncertainAll("no_api_key");

  const engineDesc = [
    vehicle.displacement ? `${vehicle.displacement}L` : null,
    vehicle.engineCode ? `engine code ${vehicle.engineCode}` : null,
  ].filter(Boolean).join(", ");

  const partLines = parts
    .map((p, i) => `${i + 1}. ${p.roleKey}: ${p.oem} (${p.name})`)
    .join("\n");

  try {
    const response = await getClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 3000,
      temperature: 0,
      system: SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 } as any],
      messages: [{
        role: "user",
        content: `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}${engineDesc ? ` (${engineDesc})` : ""}\n\nClaimed parts:\n${partLines}`,
      }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return uncertainAll("unparseable_response");

    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return uncertainAll("unparseable_response");

    return parts.map((p, i) => {
      const row = arr.find((r: any) => r?.idx === i + 1) ?? arr[i];
      const verdict =
        row?.verdict === "confirmed" || row?.verdict === "refuted" ? row.verdict : "uncertain";
      return {
        roleKey: p.roleKey,
        oem: p.oem,
        verdict,
        reason: typeof row?.reason === "string" ? row.reason.slice(0, 300) : "",
      };
    });
  } catch (e) {
    console.warn("[fitment-verify] call failed (non-fatal):", e);
    return uncertainAll("verifier_error");
  }
}
