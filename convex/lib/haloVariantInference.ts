/**
 * lib/haloVariantInference.ts — Haiku-based long-tail fallback for halo variants.
 *
 * When findHaloVariant() in haloVariantRules.ts returns null AND a downstream
 * catalog (e.g. wheel-size.com) returns zero results, ask Haiku what model
 * name the catalog actually uses for this trim, and whether the trim ships
 * performance hardware as standard.
 *
 * Two-signal output mirrors HaloVariantMatch:
 *   - promotedModel    — model name to retry the catalog lookup with
 *   - hardwareStandard — whether to skip redundant_when_halo PackageRules
 *
 * Cache: in-memory module-level Map keyed by (make|model|trim). Survives
 * within a Convex action worker but not across deploys / cold starts —
 * acceptable since wheel-size only triggers the call on zero-result misses,
 * and the curated table catches the bulk of decodes.
 *
 * Cost guard: returns null (and caches null) if ANTHROPIC_API_KEY is missing
 * or if the Haiku response is malformed — callers fall back to the un-promoted
 * model and no halo skip.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { HaloVariantMatch } from "./haloVariantRules";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

const cache = new Map<string, HaloVariantMatch | null>();
function cacheKey(make: string, model: string, trim: string): string {
  return `${make}|${model}|${trim}`.toLowerCase();
}

const SYSTEM = `You classify automotive halo variants for an auto-service quoting system.

A "halo variant" is a performance trim that catalogs (wheel-size.com, RealOEM, FCP Euro, Bilstein, Tirerack) file as its OWN model line, separate from the base series. Examples:
  - BMW M3 (filed separately from "3 Series")
  - Mercedes-AMG C 63 (filed under "C-Class AMG" or similar)
  - Honda Civic Type R (filed as "Civic Type R")
  - Cadillac CT5-V Blackwing
  - Dodge Charger Hellcat

Given a (year, make, model, trim) tuple, return JSON with two fields:

{
  "promoted_model": "<the model name a catalog actually uses, OR null if the base model already matches the catalog naming>",
  "hardware_standard": <true if this trim ships performance brakes/rotors/suspension as STANDARD equipment (not as an optional package); false otherwise>
}

Rules:
- If the trim is just a normal sport-line option (M Sport package on a 330i, S line on an A4, AMG Line on a C300), return promoted_model=null AND hardware_standard=false. These are NOT halo variants.
- If the trim IS a halo (M3, RS4, Type R, Blackwing, Trackhawk, Shelby, STI, GR Corolla, etc.), set hardware_standard=true. Set promoted_model only if you're confident catalogs use a different model name (e.g. "Civic Type R" for a Civic; "M3" for what VIN decode reports as "3 Series").
- Output VALID JSON only. No markdown fences, no extra prose.`;

/**
 * Infer halo-variant classification via Haiku. Returns a HaloVariantMatch with
 *   ruleId = "haiku-inferred"
 * or null if no halo / inference unavailable / response malformed.
 *
 * Results are cached in-memory per (make, model, trim) tuple including negative
 * results, so the same VIN decoded twice within the worker's lifetime only
 * pays the Haiku cost once.
 */
export async function inferHaloVariantWithHaiku(
  make: string,
  model: string,
  trim: string,
  year?: number,
): Promise<HaloVariantMatch | null> {
  const key = cacheKey(make, model, trim);
  if (cache.has(key)) return cache.get(key) ?? null;

  const client = getClient();
  if (!client) {
    cache.set(key, null);
    return null;
  }

  const userPrompt = `Vehicle: ${year ?? "?"} ${make} ${model} ${trim}

Return JSON: { "promoted_model": "<string or null>", "hardware_standard": <true or false> }`;

  let result: HaloVariantMatch | null = null;
  try {
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 200,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });

    let raw = "";
    for (const block of res.content) {
      if (block.type === "text") raw += block.text;
    }
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);

    const hardwareStandard = parsed?.hardware_standard === true;
    const promotedRaw =
      typeof parsed?.promoted_model === "string" && parsed.promoted_model.trim()
        ? parsed.promoted_model.trim()
        : null;

    // Only return a match when there's something actionable: either a model
    // promotion suggestion OR the hardware_standard signal. Both null means
    // Haiku confirmed it's not a halo — cache the null and move on.
    if (!hardwareStandard && !promotedRaw) {
      result = null;
    } else {
      result = {
        ruleId: "haiku-inferred",
        promotedModel: promotedRaw ?? model,
        hardwareStandard,
      };
    }
    console.log(
      `[halo-haiku] ${make} ${model} ${trim} → ` +
      `promoted="${result?.promotedModel ?? "<none>"}" hardware_standard=${result?.hardwareStandard ?? false}`
    );
  } catch (e) {
    console.warn(`[halo-haiku] inference failed for ${make} ${model} ${trim}: ${e}`);
    result = null;
  }

  cache.set(key, result);
  return result;
}
