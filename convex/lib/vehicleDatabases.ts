/**
 * lib/vehicleDatabases.ts — Vehicle Databases API client
 *
 * Primary VIN decode source. Returns structured vehicle specs including
 * engine code, tire sizes, pressures, battery CCA, brake dimensions,
 * transmission details — data NHTSA doesn't provide.
 *
 * Confidence: 0.90 (paid structured source)
 * Fallback: NHTSA (free, always available)
 */

import {
  PACKAGE_RULES,
  TRIM_INFERENCE_RULES,
  KNOWN_SERVICE_SLUGS,
  type PackageRule,
} from "./packageRules";
import { findHaloVariant } from "./haloVariantRules";

const VDB_BASE = "https://api.vehicledatabases.com";

export async function advancedVinDecode(vin: string): Promise<any | null> {
  // Check local cache first (saves credits, works when quota exhausted)
  const { VDB_CACHE } = await import("./vdbCache");
  const cached = VDB_CACHE[vin.toUpperCase()];
  if (cached) {
    console.log(`[vdb] Cache hit for ${vin}`);
    return cached;
  }

  const apiKey = process.env.VEHICLE_DATABASES_API_KEY;
  if (!apiKey) {
    console.log("[vdb] No API key, falling back to NHTSA only");
    return null;
  }

  try {
    const response = await fetch(`${VDB_BASE}/advanced-vin-decode/v2/${vin}`, {
      headers: { "x-AuthKey": apiKey },
    });

    if (!response.ok) {
      // Include the body so we can distinguish "no key" (401),
      // "wrong/expired key" (403 with auth message), and
      // "endpoint not in plan" (403 with access message). All
      // three look the same in summary form.
      let bodyHint = "";
      try {
        bodyHint = (await response.text()).slice(0, 300);
      } catch {}
      console.log(
        `[vdb] API error: ${response.status} — falling back to NHTSA. ` +
        `Body: ${bodyHint}. ` +
        `If 401/403: confirm VEHICLE_DATABASES_API_KEY is set on Convex (npx convex env set VEHICLE_DATABASES_API_KEY <key>) ` +
        `with the same value as the client's EXPO_PUBLIC_VEHICLE_DB_API_KEY.`,
      );
      return null;
    }

    const json = await response.json();
    if (json.status !== "success") {
      console.log(`[vdb] Decode failed: ${json.status}`);
      return null;
    }

    return json.data;
  } catch (err) {
    console.log(`[vdb] Failed: ${err}`);
    return null;
  }
}

/** Maps VDB raw steering type string to a normalized value. */
function mapSteeringType(raw: string | null | undefined): "electric" | "hydraulic" | "electro-hydraulic" | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("elec") && (lower.includes("hyd") || lower.includes("assist"))) return "electro-hydraulic";
  if (lower.includes("elec")) return "electric";
  if (lower.includes("pwr") || lower.includes("power") || lower.includes("hyd")) return "hydraulic";
  return null;
}

/**
 * Maps VDB raw `brakingSpec.type` to the rotor-booking radio enum. Drives the
 * "According to our records, your YYYY Make Model has: Standard brakes"
 * pre-selection on the Shop Rotors screen (spec section 2, field 1).
 * Conservative — unknown vocabulary returns undefined so the UI falls back
 * to user-pick instead of mis-stating OEM data.
 */
export function normalizeBrakeSystemType(
  raw: string | null | undefined,
): "standard" | "sport" | "carbon_ceramic" | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower.includes("carbon") || lower.includes("ceramic composite") || lower.includes("ccm")) {
    return "carbon_ceramic";
  }
  if (
    lower.includes("sport") ||
    lower.includes("performance") ||
    lower.includes("brembo") ||
    lower.includes("m performance") ||
    lower.includes("akebono performance")
  ) {
    return "sport";
  }
  if (lower.includes("standard") || lower.includes("base") || lower.includes("oem") || lower.includes("regular")) {
    return "standard";
  }
  return undefined;
}

// ─── VDB Repair Estimates API ────────────────────────────────────────────────
// Dual-source: VDB provides structured intervals (from mileage schedule), labor
// hours, and parts cost ranges. AI enrichment fills what VDB doesn't cover.

export interface VDBRepairData {
  intervals: Array<{ slug: string; interval_miles: number }>;
  labor: Map<string, number>;     // slug → hours
  // v9.7: parts costs are NOT extracted from VDB. Real-time pricing comes from
  // the oempartsonline scraper (MSRP + sale_price) and Batch 2 web-search
  // fallback. VDB cost data is stale and doesn't reflect current market.
}

/** Optional vehicle context passed to the Haiku action mapper for better accuracy. */
export interface VDBRepairContext {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
}

/**
 * v9.8 — Raw VDB repair data + action list, no slug mapping yet. Use this
 * when you want to send the action list to a Claude batch for slug mapping
 * and apply the result later via applyVDBMappingResult().
 */
export interface VDBRepairRaw {
  blocks: any[];                  // raw VDB block array (json.data.data)
  actions: string[];              // unique VDB action strings across all blocks
}

export async function fetchVDBRepairRaw(vin: string): Promise<VDBRepairRaw | null> {
  const apiKey = process.env.VEHICLE_DATABASES_API_KEY;
  if (!apiKey) {
    console.log("[vdb-repair-raw] No API key, skipping");
    return null;
  }
  try {
    const url = `${VDB_BASE}/repair-estimates/${vin}`;
    const response = await fetch(url, { headers: { "x-AuthKey": apiKey } });
    if (!response.ok) {
      console.log(`[vdb-repair-raw] API error: ${response.status}`);
      return null;
    }
    const json = await response.json();
    if (json.status !== "success" || !json.data) return null;
    const rawBlocks = json.data.data;
    if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) return null;

    const actionSet = new Set<string>();
    for (const block of rawBlocks) {
      const itemSets = Array.isArray(block.items) ? block.items : block.items ? [block.items] : [];
      for (const itemSet of itemSets) {
        if (Array.isArray(itemSet?.labor)) {
          for (const l of itemSet.labor) if (l?.type) actionSet.add(String(l.type));
        }
      }
    }
    return { blocks: rawBlocks, actions: [...actionSet] };
  } catch (err) {
    console.log(`[vdb-repair-raw] Failed: ${err}`);
    return null;
  }
}

/**
 * v9.8 — Apply a precomputed action→slug map (e.g. from a Claude batch result)
 * to raw VDB blocks. Returns intervals + labor in the same shape as
 * fetchVDBRepairData. No costs.
 */
export function applyVDBMappingResult(
  blocks: any[],
  actionMap: Map<string, string | null>,
): VDBRepairData {
  const serviceMileages = new Map<string, number[]>();
  const laborByType = new Map<string, number>();

  for (const block of blocks) {
    const mileage = block.mileage ? parseInt(String(block.mileage).replace(/,/g, "")) : null;
    const itemSets = Array.isArray(block.items) ? block.items : block.items ? [block.items] : [];
    for (const itemSet of itemSets) {
      if (Array.isArray(itemSet?.labor)) {
        for (const l of itemSet.labor) {
          const type = l?.type as string;
          if (!type) continue;
          if (mileage && mileage > 0) {
            if (!serviceMileages.has(type)) serviceMileages.set(type, []);
            serviceMileages.get(type)!.push(mileage);
          }
          const hrs = l.time_required_hours;
          if (hrs && hrs > 0 && !laborByType.has(type)) laborByType.set(type, hrs);
        }
      }
    }
  }

  const resolveSlug = (action: string): string | null => {
    if (actionMap.has(action)) return actionMap.get(action) ?? null;
    return VDB_TO_SERVICE_SLUG[action] ?? null;
  };

  // Derive intervals: ≥2 checkpoints, min gap ≥5000 miles
  const intervalsBySlug = new Map<string, number>();
  for (const [type, mileages] of serviceMileages) {
    const slug = resolveSlug(type);
    if (!slug) continue;
    const sorted = [...new Set(mileages)].sort((a, b) => a - b);
    if (sorted.length < 2) continue;
    let minGap = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap >= 5000 && gap < minGap) minGap = gap;
    }
    if (minGap === Infinity) continue;
    const existing = intervalsBySlug.get(slug);
    if (!existing || minGap < existing) intervalsBySlug.set(slug, minGap);
  }
  const intervals = [...intervalsBySlug.entries()].map(([slug, interval_miles]) => ({ slug, interval_miles }));

  // Bundle labor: sum hours when multiple VDB actions map to the same slug
  const labor = new Map<string, number>();
  for (const [type, hours] of laborByType) {
    const slug = resolveSlug(type);
    if (!slug) continue;
    labor.set(slug, (labor.get(slug) ?? 0) + hours);
  }

  return { intervals, labor };
}

/**
 * v9.8 — Build the Haiku-batch user prompt for VDB action mapping. Use the
 * exported HAIKU_SYSTEM constant as the system prompt, and submit with
 * model: MODEL_HAIKU + maxSearchUses: 0.
 */
export function buildVDBMappingPrompt(
  actions: string[],
  context: VDBRepairContext,
): { system: string; userPrompt: string } {
  const vehicleLabel = context
    ? `${context.year ?? "?"} ${context.make ?? "?"} ${context.model ?? "?"} ${context.trim ?? ""}`.trim()
    : "(unknown vehicle)";
  const userPrompt = `Vehicle: ${vehicleLabel}

Otopair service slugs (pick one per action, or null):
${OTOPAIR_SERVICE_SLUGS.map((s) => `  - ${s}`).join("\n")}

VDB actions to classify:
${actions.map((a, i) => `  ${i + 1}. ${JSON.stringify(a)}`).join("\n")}

Return JSON: { "actions": [{"action": "<verbatim>", "slug": "<one of the slugs above or null>"}, ...] }`;
  return { system: HAIKU_SYSTEM, userPrompt };
}

/** v9.8 — Parse the JSON response from a Haiku VDB-mapping batch result. */
export function parseVDBMappingResponse(data: any, fallbackActions: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const items: any[] = Array.isArray(data?.actions) ? data.actions : [];
  const slugSet = new Set<string>(OTOPAIR_SERVICE_SLUGS);
  for (const it of items) {
    if (!it || typeof it.action !== "string") continue;
    const slug = typeof it.slug === "string" && slugSet.has(it.slug) ? it.slug : null;
    out.set(it.action, slug);
  }
  // Fill any unmapped actions via static fallback
  for (const a of fallbackActions) {
    if (!out.has(a)) out.set(a, VDB_TO_SERVICE_SLUG[a] ?? null);
  }
  return out;
}

export async function fetchVDBRepairData(
  vin: string,
  context?: VDBRepairContext,
): Promise<VDBRepairData | null> {
  const apiKey = process.env.VEHICLE_DATABASES_API_KEY;
  if (!apiKey) {
    console.log("[vdb-repair] No API key, skipping repair estimates");
    return null;
  }

  try {
    const url = `${VDB_BASE}/repair-estimates/${vin}`;
    console.log(`[vdb-repair] Fetching: ${url}`);

    const response = await fetch(url, { headers: { "x-AuthKey": apiKey } });

    if (!response.ok) {
      console.log(`[vdb-repair] API error: ${response.status}`);
      return null;
    }

    const json = await response.json();

    if (json.status !== "success" || !json.data) {
      console.log(`[vdb-repair] status=${json.status}, no data for ${vin}`);
      return null;
    }

    const rawBlocks = json.data.data;
    if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
      console.log(`[vdb-repair] No data blocks for ${vin}`);
      return null;
    }

    // Collect mileages where each VDB service type appears (for interval derivation).
    const serviceMileages = new Map<string, number[]>();
    // First-seen labor hours per VDB type.
    const laborByType = new Map<string, number>();

    for (const block of rawBlocks) {
      const mileage = block.mileage
        ? parseInt(String(block.mileage).replace(/,/g, ""))
        : null;
      const itemSets = Array.isArray(block.items)
        ? block.items
        : block.items
          ? [block.items]
          : [];

      for (const itemSet of itemSets) {
        if (Array.isArray(itemSet?.labor)) {
          for (const l of itemSet.labor) {
            const type = l.type as string;
            if (!type) continue;
            if (mileage && mileage > 0) {
              if (!serviceMileages.has(type)) serviceMileages.set(type, []);
              serviceMileages.get(type)!.push(mileage);
            }
            const hrs = l.time_required_hours;
            if (hrs && hrs > 0 && !laborByType.has(type)) laborByType.set(type, hrs);
          }
        }
        // v9.7: parts costs intentionally not collected — see VDBRepairData docs.
      }
    }

    // v9.7: action strings vary per make/year (Volvo says "Lubricate - Door
    // hinges", VW says "Inspect - Lights & accessories"). A static map can't
    // catch them all. Use Haiku to map the union of action strings we saw in
    // this VIN's response → our 23-service slugs in one call. Fallback to the
    // static map when Haiku is unavailable.
    const allActions = new Set<string>([
      ...serviceMileages.keys(),
      ...laborByType.keys(),
    ]);
    const dynamicMap = await mapVDBActionsToSlugsWithHaiku(
      [...allActions],
      context ?? {},
    );

    const resolveSlug = (action: string): string | null => {
      if (dynamicMap.has(action)) return dynamicMap.get(action) ?? null;
      // Fallback to static map
      return VDB_TO_SERVICE_SLUG[action] ?? null;
    };

    // Derive intervals: need ≥2 mileage checkpoints, min gap ≥5000 miles.
    const intervalsBySlug = new Map<string, number>();
    for (const [type, mileages] of serviceMileages) {
      const slug = resolveSlug(type);
      if (!slug) continue;
      const sorted = [...new Set(mileages)].sort((a, b) => a - b);
      if (sorted.length < 2) continue;
      let minGap = Infinity;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1];
        if (gap >= 5000 && gap < minGap) minGap = gap;
      }
      if (minGap === Infinity) continue;
      const existing = intervalsBySlug.get(slug);
      if (!existing || minGap < existing) intervalsBySlug.set(slug, minGap);
    }
    const intervals = [...intervalsBySlug.entries()].map(([slug, interval_miles]) => ({
      slug,
      interval_miles,
    }));

    // Bundle paired actions into single labor hours per slug (sum hours when
    // multiple VDB actions share the same slug, e.g. "Change - Engine oil"
    // 0.25 hr + "Replace - Oil filter" 0.10 hr → oil_change 0.35 hr).
    const labor = new Map<string, number>();
    for (const [type, hours] of laborByType) {
      const slug = resolveSlug(type);
      if (!slug) continue;
      labor.set(slug, (labor.get(slug) ?? 0) + hours);
    }

    console.log(
      `[vdb-repair] ${vin}: ${intervals.length} intervals, ${labor.size} labor ` +
      `(mapped ${dynamicMap.size}/${allActions.size} actions via Haiku)`,
    );
    return { intervals, labor };
  } catch (err) {
    console.log(`[vdb-repair] Failed: ${err}`);
    return null;
  }
}

/** Thin wrapper for callers that only need labor hours. */
export async function fetchVDBLaborHours(
  vin: string,
  context?: VDBRepairContext,
): Promise<Map<string, number> | null> {
  const data = await fetchVDBRepairData(vin, context);
  return data?.labor ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// v9.7 — Haiku-based dynamic VDB action mapper.
//
// VDB action strings vary across makes (Volvo: "Lubricate - Door hinges",
// VW: "Inspect - Lights & accessories", Toyota: "Inspect - Engine air filter").
// A static map misses most of them. We send the union of action strings we
// saw in one VIN's response to Haiku and ask it to map each to one of our
// 23-service slugs (or null if no match). Static map below is the fallback.
// ────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
let _haikuClient: Anthropic | null = null;
function getHaikuClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!_haikuClient) _haikuClient = new Anthropic({ apiKey: key });
  return _haikuClient;
}

/**
 * The 23-service slug vocabulary the mapper picks from. Keep in sync with
 * SERVICE_LIST in batch2Prompt.ts and INTERVAL_TO_SERVICE in v3pipeline.ts.
 * Order matters only for Haiku's prompt readability.
 */
export const OTOPAIR_SERVICE_SLUGS = [
  "oil_change",
  "spark_plugs",
  "filter_replacement",          // engine air + cabin air both map here
  "brake_pad_replacement",
  "rotor_replacement",
  "brake_fluid_flush",
  "coolant_flush",
  "transmission_service",
  "serpentine_belt_replacement",
  "timing_belt",
  "battery_replacement",
  "battery_test",                // inspect-only
  "wiper_blade_replacement",
  "power_steering_flush",
  "differential_service",
  "transfer_case_service",
  "tire_rotation",
  "tire_balance",
  "wheel_alignment",
  "ac_recharge",
  "fuel_system_cleaning",
  "engine_intake_cleaning",
  "multi_point_inspection",
] as const;

export const HAIKU_SYSTEM = `You are a vehicle service classifier. You will receive a list of VDB action strings from a maintenance schedule, plus the target vehicle context. For each action, return the Otopair service slug it represents, or null if the action is not a serviceable maintenance item we track (cosmetic checks, road tests, headlight checks, generic inspections that aren't a paid service).

Rules:
- Return ONE slug per action from the fixed list provided.
- Bundle related actions to the same slug ("Change - Engine oil" + "Replace - Oil filter" → both map to oil_change).
- Inspect-only actions (e.g. "Inspect - Brake pads", "Inspect - Battery") are NOT serviceable maintenance — return null UNLESS the slug list explicitly includes the inspection (e.g. battery_test).
- Generic inspections (sunroof, lights, road test, headlamp washing, tire pressure check) → null.
- "Change/Replace - Cabin air filter" or "Change/Replace - Engine air filter" or "Replace - Air filter" → filter_replacement.
- Output VALID JSON ONLY — no markdown fences. Format: { "actions": [{"action": "<verbatim string>", "slug": "<slug or null>"}, ...] }`;

/**
 * Map a list of VDB action strings to Otopair service slugs via Haiku.
 * Returns a Map keyed by the original action string. Falls back to the static
 * VDB_TO_SERVICE_SLUG table when Haiku is unavailable / fails.
 */
export async function mapVDBActionsToSlugsWithHaiku(
  actions: string[],
  context: VDBRepairContext,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (actions.length === 0) return out;

  const client = getHaikuClient();
  if (!client) {
    console.log("[vdb-mapper] No ANTHROPIC_API_KEY — using static fallback only");
    for (const a of actions) out.set(a, VDB_TO_SERVICE_SLUG[a] ?? null);
    return out;
  }

  const vehicleLabel = context
    ? `${context.year ?? "?"} ${context.make ?? "?"} ${context.model ?? "?"} ${context.trim ?? ""}`.trim()
    : "(unknown vehicle)";

  const userPrompt = `Vehicle: ${vehicleLabel}

Otopair service slugs (pick one per action, or null):
${OTOPAIR_SERVICE_SLUGS.map((s) => `  - ${s}`).join("\n")}

VDB actions to classify:
${actions.map((a, i) => `  ${i + 1}. ${JSON.stringify(a)}`).join("\n")}

Return JSON: { "actions": [{"action": "<verbatim>", "slug": "<one of the slugs above or null>"}, ...] }`;

  try {
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 4096,
      temperature: 0,
      system: HAIKU_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });

    let raw = "";
    for (const block of res.content) {
      if (block.type === "text") raw += block.text;
    }
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    const items: any[] = Array.isArray(parsed?.actions) ? parsed.actions : [];

    const slugSet = new Set<string>(OTOPAIR_SERVICE_SLUGS);
    for (const it of items) {
      if (!it || typeof it.action !== "string") continue;
      const slug = typeof it.slug === "string" && slugSet.has(it.slug) ? it.slug : null;
      out.set(it.action, slug);
    }

    // Fill any actions Haiku didn't answer for via static map.
    for (const a of actions) {
      if (!out.has(a)) out.set(a, VDB_TO_SERVICE_SLUG[a] ?? null);
    }
    const mapped = [...out.values()].filter((v) => v != null).length;
    console.log(`[vdb-mapper] Haiku mapped ${mapped}/${actions.length} actions`);
    return out;
  } catch (e) {
    console.warn(`[vdb-mapper] Haiku call failed (${e}) — falling back to static map`);
    for (const a of actions) out.set(a, VDB_TO_SERVICE_SLUG[a] ?? null);
    return out;
  }
}

/**
 * Maps VDB labor type strings to Otopair service slugs.
 * VDB types use "Action - Component" format (e.g. "Change - Engine oil").
 * Returns null for services we don't track or inspections we don't charge for.
 *
 * v9.7: this static table is a FALLBACK for when Haiku is unavailable.
 * The primary path is mapVDBActionsToSlugsWithHaiku() above.
 */
const VDB_TO_SERVICE_SLUG: Record<string, string> = {
  // Oil & filters
  "Change - Engine oil": "oil_change",
  "Replace - Oil filter": "oil_change", // bundled with oil change
  "Replace - Cabin air filter": "filter_replacement",
  "Replace - Engine air filter": "filter_replacement",
  // Brakes
  "Flush/replace - Brake fluid": "brake_fluid_flush",
  "Replace - Front brake pads": "brake_pad_replacement",
  "Replace - Rear brake pads": "brake_pad_replacement",
  "Replace - Front brake rotors": "rotor_replacement",
  "Replace - Rear brake rotors": "rotor_replacement",
  // Cooling
  "Flush/replace - Coolant": "coolant_flush",
  "Replace - Coolant": "coolant_flush",
  // Transmission
  "Change - Transmission fluid": "transmission_service",
  "Flush/replace - Transmission fluid": "transmission_service",
  // Tires & wheels
  "Rotate/adjust air pressure - Wheels & tires": "tire_rotation",
  "Balance - Tires": "tire_balance",
  // Spark plugs
  "Replace - Spark plugs": "spark_plugs",
  // Battery
  "Inspect - Battery": "battery_test",
  "Replace - Battery": "battery_replacement",
  // Power steering
  "Flush/replace - Power steering fluid": "power_steering_flush",
  "Check level - Power steering fluid": "power_steering_flush",
  // Differential
  "Change - Rear differential fluid": "differential_service",
  "Check level - Rear differential fluid": "differential_service",
  "Change - Front differential fluid": "differential_service",
  // Timing belt
  "Replace - Timing belt": "timing_belt",
  // Fuel
  "Clean - Fuel injection system": "fuel_system_cleaning",
};

/**
 * Maps raw VDB labor type strings to Otopair service slugs.
 * Returns a Map<serviceSlug, hours>.
 */
export function mapVDBLaborToSlugs(
  laborByType: Map<string, number>,
): Map<string, number> {
  const laborBySlug = new Map<string, number>();

  for (const [type, hours] of laborByType) {
    const slug = VDB_TO_SERVICE_SLUG[type];
    if (!slug) continue;
    if (laborBySlug.has(slug)) continue; // first match wins
    laborBySlug.set(slug, hours);
  }

  return laborBySlug;
}

// ─── Package Detection ──────────────────────────────────────────────────────
// Detects packages available for this trim that affect 1+ of the 23 services.
// This is detection, NOT confirmation — we don't try to figure out whether THIS
// specific VIN has the package. The result lands on vehicle_configs.packages_available
// and the booking flow asks the user to confirm/deny when a relevant service is requested.
// See docs/PACKAGE_AWARE_PARTS.md.

export interface DetectedPackage {
  code: string;
  label: string;
  services_affected: string[];
  detected_from:
    | "vdb_optional_options"
    | "vdb_standard_options"
    | "vdb_installed_equipment"
    | "claude_inference"
    | "rules_table";
  confidence: number;
}

/**
 * Walk the entire VDB raw response (full recursive traversal) and pull every
 * string value we can match package rules against.
 *
 * Rationale: VDB's payload shape varies by year, model, and API tier. The 2020
 * M2 CS "M Carbon Ceramic Brakes" entry lives at `mechanical[i].description.package_name`;
 * other vehicles surface options under `optional_options[]`, `equipment[]`,
 * `packages[]`, `trim_packages[]`, or whole new top-level keys we haven't
 * catalogued. Rather than chase each shape, we recursively traverse the entire
 * response and collect every string. The regex patterns in PACKAGE_RULES are
 * specific enough that running them over random strings (dealer names, VINs,
 * URLs) produces effectively zero false positives.
 *
 * Source-tag: everything gets `vdb_optional_options` since we no longer
 * distinguish source location by top-level key. This is fine for detection;
 * confidence weights live on the matching rule, not the source.
 *
 * Safety guards:
 *   - WeakSet cycle protection (in case VDB ever returns a circular ref)
 *   - max depth 20 (sane stop; real responses are ~5 deep)
 *   - skip strings shorter than 2 chars (single chars never match) and longer
 *     than 500 chars (URLs, multi-paragraph descriptions — won't match any
 *     short package-name pattern and waste regex time)
 */
function collectPackageStrings(vdbRaw: any): { source: DetectedPackage["detected_from"]; text: string }[] {
  const out: { source: DetectedPackage["detected_from"]; text: string }[] = [];
  if (!vdbRaw || typeof vdbRaw !== "object") return out;

  const seen = new WeakSet<object>();
  const MAX_DEPTH = 20;

  const walk = (node: any, depth: number) => {
    if (node == null || depth > MAX_DEPTH) return;
    if (typeof node === "string") {
      if (node.length >= 2 && node.length <= 500) {
        out.push({ source: "vdb_optional_options", text: node });
      }
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else {
      for (const val of Object.values(node)) walk(val, depth + 1);
    }
  };

  walk(vdbRaw, 0);
  return out;
}

/**
 * Filter rules that affect at least one of the 23 services.
 * Defensive: if a rule references a slug we don't ship, drop it.
 */
function ruleAffectsKnownService(rule: PackageRule): boolean {
  const known = new Set<string>(KNOWN_SERVICE_SLUGS);
  return rule.services_affected.some((s) => known.has(s));
}

/**
 * Assess packages available for this trim that affect 1+ of the 23 services.
 *
 * Returns a deduped list. Rules with no service impact are filtered out before matching,
 * so the caller can safely write the result to vehicle_configs.packages_available.
 */
export function assessAvailablePackages(args: {
  vdbRaw: any;
  make: string;
  model: string;
  trim: string;
  year: number;
}): DetectedPackage[] {
  const { vdbRaw, make, model, trim } = args;
  const detected = new Map<string, DetectedPackage>();

  // Halo variants (BMW M, AMG, RS, Type R, Blackwing, Hellcat, Trackhawk,
  // Shelby, STI, GR, Lexus F, etc.) ship performance hardware as STANDARD.
  // When a halo rule matches with hardwareStandard=true, package rules tagged
  // redundant_when_halo are skipped — they'd otherwise double-count baseline
  // equipment and surface wrong brake/rotor specs in quoting.
  //
  // Both model and trim are checked because catalogs (VDB, NHTSA) often file
  // halo variants under their base series (model="3 Series", trim="M3
  // Competition") — legacy vehicle_config rows enriched before halo promotion
  // still carry the stale model.
  const halo = findHaloVariant(make, model, trim);
  const haloHardwareStandard = halo?.hardwareStandard ?? false;

  const upsert = (pkg: DetectedPackage) => {
    const existing = detected.get(pkg.code);
    if (!existing || pkg.confidence > existing.confidence) {
      detected.set(pkg.code, pkg);
    }
  };

  const explicitRules = PACKAGE_RULES.filter(ruleAffectsKnownService);
  const inferenceRules = TRIM_INFERENCE_RULES.filter(ruleAffectsKnownService);

  // 1. Explicit matches against VDB option/equipment strings (highest signal).
  const strings = collectPackageStrings(vdbRaw);
  for (const { source, text } of strings) {
    for (const rule of explicitRules) {
      if (rule.make !== "*" && rule.make.toLowerCase() !== make.toLowerCase()) continue;
      if (haloHardwareStandard && rule.redundant_when_halo) continue;
      if (!rule.pattern.test(text)) continue;
      upsert({
        code: rule.code,
        label: rule.label,
        services_affected: rule.services_affected,
        detected_from: source,
        confidence: rule.base_confidence,
      });
    }
  }

  // 2. Trim-name inference (lower confidence). Only if we don't already have
  // an explicit hit — trim-name inference was previously removed due to false
  // positives; the curated TRIM_INFERENCE_RULES table re-introduces it with
  // tightly-scoped patterns to avoid that pitfall.
  for (const rule of inferenceRules) {
    if (rule.make !== "*" && rule.make.toLowerCase() !== make.toLowerCase()) continue;
    if (haloHardwareStandard && rule.redundant_when_halo) continue;
    if (!rule.pattern.test(trim ?? "")) continue;
    if (detected.has(rule.code)) continue; // explicit hit wins
    upsert({
      code: rule.code,
      label: rule.label,
      services_affected: rule.services_affected,
      detected_from: "rules_table",
      confidence: rule.base_confidence,
    });
  }

  return [...detected.values()];
}

export function extractVDBFields(data: any) {
  const specs = data.specifications || [];

  const findSpec = (title: string) => {
    const found = specs.find((s: any) => Object.keys(s)[0] === title);
    return found ? found[title] : {};
  };

  const dims = data.dimensions || [];

  const engineSpec = findSpec("engine");
  const tireSpec = findSpec("tires");
  const brakingSpec = findSpec("braking");
  const electricalSpec = findSpec("electrical");
  const steeringSpec = findSpec("steering");
  const fuelSpec = findSpec("fuel");

  const wheelDims = dims.find((d: any) => d.wheels)?.wheels || [];
  const brakingDims = dims.find((d: any) => d.braking)?.braking || [];

  const getWheelVal = (key: string) => {
    const entry = wheelDims.find((w: any) => w[key]);
    return entry?.[key]?.[0]?.value || null;
  };

  const getBrakeVal = (key: string) => {
    const entry = brakingDims.find((b: any) => b[key]);
    return entry?.[key]?.[0]?.value || null;
  };

  // Engine description from standard options
  const engineDescription =
    data.standard_options?.find((o: any) => o.name === "Engine")?.description || null;

  // Engine dimensions block — used downstream for displacement + horsepower.
  // Historical bug: this block previously read `engine_size` and labeled it
  // as `cylinders`. `engine_size` is the DISPLACEMENT in liters (see
  // engineDisplacementLiters below — same field). For every car >=3.0L the
  // resulting "cylinder count" was the displacement integer (3.0L → 3 cyl,
  // 4.0L → 4 cyl) and got written into the engines table, then propagated
  // through every downstream consumer. NHTSA's EngineCylinders is the
  // authoritative source — read it at the merge step in vehicle_pipeline.ts.
  // Here we extract a clean cylinder count from the structured config string
  // ("I-6", "V-8", "H-6", "W-12") and fall back to the engine description.
  const engineDims = dims.find((d: any) => d.engine)?.engine || [];

  // Defensive numeric parse — VDB returns some values as strings with
  // commas (e.g. ymm-specs/v3 → "2,000"); JS coerces those to NaN
  // when divided. Strip commas before parseFloat.
  const parseNumLoose = (v: any): number | null => {
    if (v == null || v === "") return null;
    const cleaned = String(v).replace(/,/g, "").trim();
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  };

  // Horsepower lives in dimensions.engine[].horsepower as a list of
  // {value, unit}. The "hp" unit is the actual peak HP; the "rpm" unit
  // is the rpm where peak is reached.
  const hpEntries = engineDims.find((e: any) => "horsepower" in e)?.horsepower ?? [];
  const horsepower = parseNumLoose(
    hpEntries.find((x: any) => x?.unit === "hp")?.value,
  );

  // Liters from dimensions.engine[].engine_size[unit="l"]. Cleaner
  // than dividing specifications.engine.displacement (cc) by 1000 —
  // ymm-specs/v3 returns that as "2,000" which divides to NaN.
  const engineDisplacementLiters = parseNumLoose(
    engineDims.find((e: any) => "engine_size" in e)?.engine_size
      ?.find((x: any) => x?.unit === "l")?.value,
  );

  // MPG block from specifications.mpg (city/hwy/combined).
  const mpgSpec = findSpec("mpg");
  const mpgCity = parseNumLoose(mpgSpec?.epa_city_economy);
  const mpgHighway = parseNumLoose(mpgSpec?.epa_hwy_economy);
  const mpgCombined = parseNumLoose(mpgSpec?.epa_combined_economy);

  // Cylinders configuration — display string like "I-4", "V-6", "H-6".
  // Distinct from block_type which is just the letter ("I", "V").
  const cylindersConfiguration = engineSpec.cylinders_configuration || null;

  // Cylinder count — derived from cylinders_configuration first, then the
  // engine description string. The "Cylinder"-anchored regex runs first so
  // strings like "3.0L Inline 6-Cylinder M TwinPower Turbo" return 6, not 3.
  const parseCylinderCount = (s: string | null | undefined): number | null => {
    if (!s) return null;
    // Cylinder-anchored: "6-Cylinder", "8 Cylinder", "12-cyl"
    const cylMatch = s.match(/(\d+)[\s-]?(?:Cylinder|cyl)\b/i);
    if (cylMatch) return parseInt(cylMatch[1], 10);
    // Config-shape: "I-6", "V-8", "W-12", "H-6", "L4", "B6"
    const configMatch = s.match(/\b[BHILVRW]-?(\d+)\b/i);
    if (configMatch) return parseInt(configMatch[1], 10);
    return null;
  };
  const cylindersCount =
    parseCylinderCount(cylindersConfiguration) ??
    parseCylinderCount(engineDescription);

  return {
    // Identity
    year: data.year ? parseInt(data.year) : null,
    make: data.make || null,
    model: data.model || null,
    trim: data.trim || null,
    // Raw VDB style + trim_and_style — used downstream to construct
    // the canonical `vehicle-images` YMMT URL. The catalog uses a
    // different (model, trim) shape than the decode endpoint:
    //   decode:  model="530i", trim_and_style="xDrive Sedan ..."
    //   catalog: model="530",  trim="i-xDrive Sedan ..."
    style: data.style || null,
    trimAndStyle: data.trim_and_style || null,
    bodyType: data.vehicle?.body_type || null,
    doors: data.vehicle?.doors ? parseInt(data.vehicle.doors) : null,

    // Engine
    engineCode: engineSpec.code || null,
    engineDescription,
    cylinders: cylindersCount,
    displacement: engineSpec.displacement ? engineSpec.displacement / 1000 : null,
    camType: engineSpec.cam_type || null,
    blockType: engineSpec.block_type || null,
    drivetrain: engineSpec.drivetype || null,
    fuelType: fuelSpec?.type || null,
    // New: review-screen Specs card fields. Clean numeric values
    // extracted from dimensions[].engine + specifications[].mpg.
    horsepower,
    engineDisplacementLiters,
    cylindersConfiguration,
    mpgCity,
    mpgHighway,
    mpgCombined,

    // Transmission
    transType: data.transmission?.type || null,
    transSpeeds: data.transmission?.number_of_speeds
      ? parseInt(data.transmission.number_of_speeds)
      : null,
    transDescription: data.transmission?.description || null,

    // Tires
    frontTireSize: tireSpec.front_tire_size || null,
    rearTireSize: tireSpec.rear_tire_size || null,
    frontTirePressure: tireSpec.front_tire_pressure_psi
      ? parseInt(tireSpec.front_tire_pressure_psi)
      : null,
    rearTirePressure: tireSpec.rear_tire_pressure_psi
      ? parseInt(tireSpec.rear_tire_pressure_psi)
      : null,

    // Wheels
    wheelTorque: getWheelVal("wheel_torque")
      ? parseFloat(getWheelVal("wheel_torque"))
      : null,

    // Battery
    cca: electricalSpec.cold_cranking_capacity_amps
      ? parseInt(electricalSpec.cold_cranking_capacity_amps)
      : null,

    // Brakes
    frontRotorDia: getBrakeVal("front_brake_rotor_dia")
      ? parseFloat(getBrakeVal("front_brake_rotor_dia"))
      : null,
    rearRotorDia: getBrakeVal("rear_brake_rotor_dia")
      ? parseFloat(getBrakeVal("rear_brake_rotor_dia"))
      : null,
    brakeType: brakingSpec.type || null,
    brakeSystemType: normalizeBrakeSystemType(brakingSpec.type),

    // Steering (normalized: "electric" | "hydraulic" | "electro-hydraulic" | null)
    steeringType: mapSteeringType(steeringSpec?.type),
  };
}
