/**
 * vehicleEnrichment/ymmtIdentity.ts — resolve a vehicle identity from
 * year/make/model[/trim] when no VIN was provided.
 *
 * THE PROBLEM THIS SOLVES, AND THE ONE IT REFUSES TO
 * ---------------------------------------------------
 * `processVin` gets its identity from a decoder: a VIN pins exactly one
 * powertrain, and everything downstream (config_key, part fitments, fluid
 * capacities, labor times) hangs off that. A manually-entered YMMT does not.
 *
 *   2020 Honda CR-V        → one engine (L15BE 1.5T). Resolvable.
 *   2020 Toyota Camry LE   → one engine (A25A-FKS); the V6 is XSE/XLE only.
 *                            Resolvable BECAUSE the trim narrows it.
 *   2020 Ford F-150        → 3.3 V6, 2.7 EcoBoost, 3.5 EcoBoost, 5.0 V8,
 *                            3.0 diesel, 3.5 hybrid. NOT resolvable.
 *
 * Guessing on the F-150 is the worst possible outcome: it mints a confident-
 * looking vehicle_config keyed to the wrong engine, and every part number,
 * oil capacity and labor time we quote off it is wrong in a way no downstream
 * check can catch — the config looks complete. So this module produces a
 * CANDIDATE SET and only commits when exactly one candidate survives. When
 * more than one does, it reports `ambiguous` and the caller records that
 * honestly instead of enriching. This is the same null-over-guess doctrine the
 * capacity and cylinder resolvers already follow.
 *
 * The pure helpers here (`normalizeModelName`, `pickPowertrainCandidate`) carry
 * the decision logic and are unit-tested; the LLM call is the dumb part.
 */

import Anthropic from "@anthropic-ai/sdk";
import { isSyntheticEngineCode } from "./utils/engineLookup";
import { sanitizeCylinders } from "./cylindersRepair";
import { carApiResolveModel, carApiYmmtCatalog } from "../lib/carApi";

/** One powertrain a given year/make/model was actually sold with. */
export type PowertrainCandidate = {
  /**
   * Manufacturer engine code (L15BE, A25A-FKS, B58B30M1). Never a marketing term.
   *
   * EMPTY IS LEGITIMATE. Several high-volume American makes simply do not
   * publish internal codes — every public source for a 2020 F-150 says
   * "3.5L EcoBoost", not a code — and forcing one produces a fabrication.
   * `processVin` has always handled this with a synthetic `{disp}l_{cyl}cyl`
   * code as its last resort; the caller does the same here, so a codeless row
   * is still a usable identity as long as displacement and cylinders are known.
   */
  engine_code: string;
  /** Marketing name ("3.5L EcoBoost V6") — audit trail, never an engine_code. */
  marketing_name: string | null;
  displacement_l: number | null;
  cylinders: number | null;
  /** Gasoline | Diesel | Hybrid | Electric | Plug-in Hybrid */
  fuel_type: string;
  aspiration: string | null;
  /** Trim names this powertrain was offered on, lowercased. Empty = all trims. */
  trims_offered: string[];
  drivetrain: string | null;
  transmission_type: string | null;
  confidence: number;
};

export type YmmtResolution =
  | {
      ok: true;
      chosen: PowertrainCandidate;
      disambiguated_by: "sole_option" | "trim" | "powertrain_named" | "conventional_default";
    }
  | { ok: false; reason: string; candidates: PowertrainCandidate[] };

/* ────────────────────────── model normalization ────────────────────────── */

/** Strip everything but alphanumerics so "CR-V", "CRV" and "cr v" collapse. */
function squash(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match a user-typed model against the NHTSA catalog for that make/year.
 *
 * The YMMT picker's combobox accepts arbitrary typed text ("No matches — type
 * to add"), so live data contains things like "CRV" where the catalog and every
 * enriched sibling say "CR-V". An unnormalized model poisons the config_key,
 * which means the manual car can never dedup against the VIN-decoded one.
 *
 * PRECEDENCE MATTERS. Exact-squashed wins outright, before any substring pass.
 * The decode path learned this the hard way (batch-11 Grand Highlander): vPIC's
 * "Highlander" collapsed VDB's "Grand Highlander", both share the A25A-FXS, and
 * every model-divergent field then resolved to the wrong sibling at high
 * confidence with nothing to contradict it. Here the same trap runs the other
 * way — a typed "Highlander" must NOT substring-match into "Grand Highlander".
 * So substring is a last resort AND only fires when exactly one catalog entry
 * matches; two or more is an ambiguity we refuse rather than break arbitrarily.
 *
 * Returns null when the catalog is empty or nothing matches, and the caller
 * keeps the user's text — a model NHTSA has never heard of is still a car.
 */
export function normalizeModelName(
  typed: string,
  catalog: string[],
): string | null {
  const t = squash(typed);
  if (!t || catalog.length === 0) return null;

  // 1. Exact match on the squashed form. "CRV" → "CR-V".
  const exact = catalog.filter((c) => squash(c) === t);
  if (exact.length > 0) return exact[0];

  // 2. Substring, either direction ("f150 xl" ⊃ "f150", "sportage" ⊂ "sportage hybrid").
  //    Only trustworthy when it lands on exactly one catalog entry.
  const partial = catalog.filter((c) => {
    const s = squash(c);
    return s.length >= 3 && t.length >= 3 && (s.includes(t) || t.includes(s));
  });
  if (partial.length !== 1) return null;

  // Normalization must never DELETE information. vPIC lists the CR-V Hybrid
  // under the bare nameplate "CR-V", so a typed "CR-V Hybrid" substring-matched
  // it and came back as "CR-V" — silently discarding the one word that says
  // which engine the car has. Downstream then read no powertrain qualifier,
  // applied the conventional default, and resolved a hybrid to the gas engine.
  //
  // When the catalog entry drops a powertrain word the owner supplied, keep
  // what they typed. A slightly non-canonical model name costs us a dedup
  // opportunity; a discarded "Hybrid" costs us the right engine.
  const matched = partial[0];
  const typedPowertrain = powertrainTokensOf(trimTokens(typed));
  if (typedPowertrain.size > 0) {
    const matchedPowertrain = powertrainTokensOf(trimTokens(matched));
    for (const tok of typedPowertrain) {
      if (!matchedPowertrain.has(tok)) return null;
    }
  }

  return matched;
}

/* ──────────────────────── candidate disambiguation ─────────────────────── */

/** Normalize a trim into comparable tokens: lowercase, separators → boundaries. */
function trimTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Trim tokens that DEFINE a powertrain rather than describe a package.
 *
 * These can never be treated as optional detail. A CR-V "EX" and a CR-V
 * "Hybrid EX" are different cars with different engines, different oil
 * capacities and different part numbers — but "EX" is a token-subset of
 * "Hybrid EX", so plain subset matching happily equates them.
 */
const POWERTRAIN_TOKENS = new Set([
  "hybrid", "phev", "plugin", "mhev", "diesel", "tdi", "electric", "ev", "bev",
]);

function powertrainTokensOf(tokens: string[]): Set<string> {
  return new Set(tokens.filter((t) => POWERTRAIN_TOKENS.has(t)));
}

/**
 * Do a user-typed trim and an offered trim refer to the same thing?
 *
 * Two rules, both learned from live probes:
 *
 * 1. TOKENS, NOT SUBSTRINGS. `"xle".includes("le")` is true, so substring
 *    matching made a Camry **LE** match the XLE-only V6 and the model year read
 *    as ambiguous. Token subset fixes that while still letting a typed "Lariat"
 *    match an offered "Lariat SuperCrew" (a body style, not a different trim).
 *
 * 2. POWERTRAIN TOKENS MUST AGREE EXACTLY. Subset alone made a 2020 CR-V "EX"
 *    match the hybrid-only "Hybrid EX", leaving both engines viable and
 *    triggering a needless refusal — or worse, the wrong pick. A qualifier that
 *    names the powertrain is the one thing we're disambiguating on, so it can
 *    never be dropped as surplus detail in either direction.
 *
 * Subset is checked in both directions because neither side is reliably more
 * specific: the owner may type more than the catalog records, or less.
 */
function trimsMatch(typed: string, offered: string): boolean {
  const a = trimTokens(typed);
  const b = trimTokens(offered);
  if (a.length === 0 || b.length === 0) return false;

  // Rule 2 — powertrain qualifiers must be identical on both sides.
  const pa = powertrainTokensOf(a);
  const pb = powertrainTokensOf(b);
  if (pa.size !== pb.size || [...pa].some((t) => !pb.has(t))) return false;

  // Rule 1 — token subset, either direction.
  const setA = new Set(a);
  const setB = new Set(b);
  return a.every((t) => setB.has(t)) || b.every((t) => setA.has(t));
}

/**
 * Fuel classes a trim's powertrain tokens imply, for screening candidates whose
 * `trims_offered` is empty ("all trims").
 *
 * Without this, a typed "Hybrid EX" matches an all-trims gasoline engine (empty
 * list = available everywhere) AND the hybrid engine, so the CR-V refuses a case
 * the owner actually specified precisely enough. A powertrain token in the trim
 * is direct evidence about fuel type and should be used as such.
 */
function fuelClassFromTrim(tokens: string[]): "hybrid" | "diesel" | "electric" | null {
  if (tokens.some((t) => t === "hybrid" || t === "phev" || t === "plugin" || t === "mhev")) {
    return "hybrid";
  }
  if (tokens.some((t) => t === "diesel" || t === "tdi")) return "diesel";
  if (tokens.some((t) => t === "electric" || t === "ev" || t === "bev")) return "electric";
  return null;
}

function fuelMatches(candidateFuel: string, want: "hybrid" | "diesel" | "electric"): boolean {
  const f = candidateFuel.toLowerCase();
  if (want === "hybrid") return f.includes("hybrid");
  if (want === "diesel") return f.includes("diesel");
  return f.includes("electric") && !f.includes("hybrid");
}

/** Plain gasoline/petrol — the powertrain a nameplate carries when unqualified. */
function isConventionalFuel(candidateFuel: string): boolean {
  const f = candidateFuel.toLowerCase();
  return (
    !f.includes("hybrid") &&
    !f.includes("electric") &&
    !f.includes("diesel") &&
    !f.includes("phev")
  );
}

/**
 * Reduce a candidate set to the single powertrain this vehicle actually has,
 * or explain why we can't.
 *
 * The ONLY two ways to commit:
 *   - `sole_option`: the model year offered exactly one powertrain.
 *   - `trim`: the user gave a trim, and exactly one candidate lists it.
 *
 * Everything else refuses. Note the deliberate asymmetry: a candidate with an
 * empty `trims_offered` is treated as available on ALL trims, so it can never
 * be eliminated by a trim filter — that's the safe reading, because "we didn't
 * record which trims" must not masquerade as "not offered on yours".
 */
export function pickPowertrainCandidate(
  candidates: PowertrainCandidate[],
  trim?: string | null,
  /** Model name, read ONLY for powertrain words ("CR-V Hybrid", "F-150 Lightning"). */
  modelName?: string | null,
): YmmtResolution {
  // A candidate is usable when it names a powertrain: either a real engine code
  // or a displacement+cylinders pair the caller can synthesize a code from.
  const usable = candidates.filter(
    (c) =>
      (c.engine_code && !isSyntheticEngineCode(c.engine_code)) ||
      (c.displacement_l != null && c.cylinders != null),
  );

  if (usable.length === 0) {
    return {
      ok: false,
      reason:
        candidates.length === 0
          ? "no_powertrain_found"
          : "no_identifiable_powertrain", // rows carried neither a code nor disp+cyl
      candidates,
    };
  }

  if (usable.length === 1) {
    return { ok: true, chosen: usable[0], disambiguated_by: "sole_option" };
  }

  const t = trim?.trim() ?? "";

  // ── Pass 1: fuel class ──────────────────────────────────────────────────
  // Manufacturers name an electrified or diesel variant as its own thing —
  // "CR-V Hybrid", "Camry Hybrid", "F-150 Lightning", "3.0 TDI". So the
  // presence or ABSENCE of such a word in what the owner typed is real
  // evidence, not a coin flip:
  //
  //   said "Hybrid"   → it's the hybrid. Drop the conventional engines.
  //   said nothing    → it's the conventional car. Drop the electrified ones.
  //
  // The second half is what makes this feature useful rather than perpetually
  // undecided: nearly every modern nameplate has a hybrid option, and a bare
  // "EX" would otherwise stay ambiguous forever. It is applied only when a
  // conventional candidate actually exists, so a hybrid-only model (Prius) is
  // never emptied out by it.
  const namedFuel = fuelClassFromTrim([...trimTokens(t), ...trimTokens(modelName ?? "")]);
  let pool = usable;
  let fuelNarrowed: "powertrain_named" | "conventional_default" | null = null;

  if (namedFuel) {
    const matched = usable.filter((c) => fuelMatches(c.fuel_type, namedFuel));
    if (matched.length > 0) {
      pool = matched;
      fuelNarrowed = "powertrain_named";
    }
  } else {
    const conventional = usable.filter((c) => isConventionalFuel(c.fuel_type));
    if (conventional.length > 0 && conventional.length < usable.length) {
      pool = conventional;
      fuelNarrowed = "conventional_default";
    }
  }

  if (pool.length === 1) {
    return { ok: true, chosen: pool[0], disambiguated_by: fuelNarrowed ?? "sole_option" };
  }

  // ── Pass 2: trim ────────────────────────────────────────────────────────
  if (!t) {
    return {
      ok: false,
      reason: `ambiguous_needs_trim: ${pool.length} powertrains offered`,
      candidates: pool,
    };
  }

  // A candidate matches when it lists the trim, or lists no trims at all
  // (unknown coverage → assume available, never assume excluded).
  const matching = pool.filter((c) => {
    if (c.trims_offered.length === 0) return true;
    return c.trims_offered.some((o) => trimsMatch(t, o));
  });

  if (matching.length === 1) {
    return { ok: true, chosen: matching[0], disambiguated_by: "trim" };
  }

  return {
    ok: false,
    reason:
      matching.length === 0
        ? `trim_not_offered: "${trim}" matches none of ${pool.length} powertrains`
        : `ambiguous_after_trim: "${trim}" still matches ${matching.length} powertrains`,
    candidates: pool,
  };
}

/* ─────────────────────────── powertrain research ───────────────────────── */

/** Aspiration/architecture words the model may return instead of a real code. */
const DESCRIPTOR_ANSWERS = new Set([
  "na", "n-a", "turbo", "turbocharged", "supercharged", "dohc", "sohc", "ohv",
  "vtec", "gdi", "mpi", "diesel", "hybrid", "ev", "i4", "v6", "v8", "h4", "boxer",
]);

/**
 * Coerce one raw JSON row from the model into a validated candidate, or drop it.
 *
 * A row survives with an EMPTY engine_code when the make doesn't publish one —
 * the displacement/cylinders/fuel triple is still a real identity, and the
 * caller synthesizes a code from it exactly as processVin does. A row is only
 * dropped when it identifies no powertrain at all.
 */
function toCandidate(raw: any): PowertrainCandidate | null {
  const rawCode = String(raw?.engine_code ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9\-_.]/g, "");

  // Screen the code. Anything that fails becomes "" (no code) rather than
  // killing the row — the same marketing terms the decode path rejects
  // ("EcoBoost", "TFSI") still must never be stored AS an engine_code.
  let code = rawCode;
  if (
    !code ||
    code.toLowerCase() === "null" ||
    code.toLowerCase() === "unknown" ||
    DESCRIPTOR_ANSWERS.has(code.toLowerCase()) ||
    code.length < 2 ||
    code.length > 20 ||
    isSyntheticEngineCode(code)
  ) {
    code = "";
  }

  const dispRaw = Number(raw?.displacement_l);
  const displacement_l = Number.isFinite(dispRaw) && dispRaw > 0 && dispRaw < 12 ? dispRaw : null;

  // Reuse the decode path's corruption screen: cylinders must be an integer
  // 2-16, and a value that merely mirrors the displacement is rejected (no
  // 2-cyl 2.0L exists in this fleet).
  const cylRaw = Number(raw?.cylinders);
  let cylinders = sanitizeCylinders(Number.isFinite(cylRaw) ? cylRaw : null) ?? null;
  if (
    cylinders != null &&
    displacement_l != null &&
    displacement_l >= 2 &&
    Math.abs(cylinders - displacement_l) < 0.05
  ) {
    cylinders = null;
  }

  // Without a code, displacement AND cylinders are the identity — a row with
  // neither names no powertrain and can't be keyed on.
  if (!code && (displacement_l == null || cylinders == null)) return null;

  const trims = Array.isArray(raw?.trims_offered)
    ? raw.trims_offered.map((s: any) => String(s).trim()).filter(Boolean)
    : [];

  const conf = Number(raw?.confidence);
  const marketing = raw?.marketing_name ? String(raw.marketing_name).trim() : null;

  return {
    engine_code: code,
    marketing_name: marketing || (code !== rawCode && rawCode ? rawCode : null),
    displacement_l,
    cylinders,
    fuel_type: String(raw?.fuel_type ?? "Gasoline").trim() || "Gasoline",
    aspiration: raw?.aspiration ? String(raw.aspiration).trim() : null,
    trims_offered: trims,
    drivetrain: raw?.drivetrain ? String(raw.drivetrain).trim() : null,
    transmission_type: raw?.transmission_type ? String(raw.transmission_type).trim() : null,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
  };
}

/** Pull the first JSON object out of a text response, tolerating prose/fences. */
function extractJsonObject(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start === -1) return null;
  // Walk to the matching brace so trailing prose doesn't break the parse.
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Ask the model to enumerate EVERY powertrain the given year/make/model was
 * sold with in North America.
 *
 * Enumeration, not selection, is the point. If we asked "what engine does a
 * 2020 F-150 have" the model would confidently name one of six and we'd have no
 * signal that it was a coin flip. Asking for the full list turns the ambiguity
 * into data `pickPowertrainCandidate` can act on.
 */
export async function researchYmmtPowertrain(
  anthropicKey: string,
  vehicle: { year: number; make: string; model: string; trim?: string | null },
): Promise<{ candidates: PowertrainCandidate[]; raw: string; diagnostics: string }> {
  const label = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  const prompt = `List EVERY engine offered on the ${label} in the North American market.

${vehicle.trim ? `The owner reports the trim as "${vehicle.trim}", but list ALL engines for the model year anyway — trim filtering happens downstream.\n` : ""}
Rules:
1. "engine_code" MUST be the manufacturer's internal engine code (L15BE, A25A-FKS, B58B30M1, EA888, G4FJ). NEVER a marketing name — not "EcoBoost", "TFSI", "Smartstream", "VTEC", "Hemi", and never an architecture like "V6" or "turbo". Many American makes do not publish internal codes at all; when you cannot find a genuine one, set "engine_code": null and put the marketing name in "marketing_name". STILL LIST THE ENGINE — a missing code is expected and handled, but a missing engine is a wrong answer. Never invent a code to fill the field.
2. Engine codes are generation-specific. The same nameplate at the same displacement often changes code across generations (a 2019+ Nissan Altima 2.5 is PR25DD, NOT the 2007-2018 QR25DE). Return the code used in ${vehicle.year} specifically.
3. "trims_offered" lists the trim names that engine was available on for ${vehicle.year}. If an engine was standard across the whole line, use an empty array.
4. Be exhaustive. Missing an engine causes a wrong part to be quoted; listing an extra one only makes us ask the owner. Include diesel, hybrid and PHEV variants.
5. "confidence" is your confidence in that specific row, 0-1.

Respond with ONLY this JSON, no prose. Emit it even if some fields are null:
{"engines":[{"engine_code":null,"marketing_name":"","displacement_l":0,"cylinders":0,"fuel_type":"Gasoline|Diesel|Hybrid|Plug-in Hybrid|Electric","aspiration":"naturally aspirated|turbo|supercharged","trims_offered":[],"drivetrain":"FWD|RWD|AWD|4WD","transmission_type":"automatic|manual|CVT|DCT","confidence":0.0}]}`;

  const client = new Anthropic({ apiKey: anthropicKey });
  // 8000 tokens, matching the enrichment calls in vehicle_pipeline. At 4000 a
  // six-engine truck (F-150) exhausted the budget on web-search results and the
  // model never emitted a final text block at all — the "quits before write-out"
  // failure, which is indistinguishable from "found nothing" unless stop_reason
  // is captured. Hence the diagnostics string below.
  const resp = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8000,
    temperature: 0,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 } as any],
    messages: [{ role: "user", content: prompt }],
  });

  const textBlocks = resp.content.filter((b) => b.type === "text");
  const text = textBlocks
    .map((b) => (b as any).text)
    .join("\n")
    .trim();
  const searches = resp.content.filter(
    (b: any) => b.type === "server_tool_use" || b.type === "web_search_tool_result",
  ).length;
  const diagnostics =
    `stop=${resp.stop_reason} textBlocks=${textBlocks.length} chars=${text.length} ` +
    `searchBlocks=${searches} out=${resp.usage?.output_tokens ?? "?"}`;

  const parsed = extractJsonObject(text);
  const rows: any[] = Array.isArray(parsed?.engines) ? parsed.engines : [];
  const candidates = rows
    .map(toCandidate)
    .filter((c): c is PowertrainCandidate => c !== null);

  // Collapse duplicate codes the model may have listed per-trim, merging their
  // trim coverage so the trim filter sees the full picture for each engine.
  const byCode = new Map<string, PowertrainCandidate>();
  for (const c of candidates) {
    // Codeless rows can't all collide on "" — fall back to the identity triple
    // that stands in for the code (displacement, cylinders, fuel).
    const key = c.engine_code
      ? c.engine_code.toUpperCase()
      : `~${c.displacement_l ?? "?"}|${c.cylinders ?? "?"}|${c.fuel_type.toLowerCase()}`;
    const prev = byCode.get(key);
    if (!prev) {
      byCode.set(key, c);
      continue;
    }
    // An empty trims list means "all trims" — it must stay empty, not absorb
    // the other row's partial list and become falsely narrow.
    prev.trims_offered =
      prev.trims_offered.length === 0 || c.trims_offered.length === 0
        ? []
        : [...new Set([...prev.trims_offered, ...c.trims_offered])];
    prev.confidence = Math.max(prev.confidence, c.confidence);
  }

  return { candidates: [...byCode.values()], raw: text.slice(0, 2000), diagnostics };
}

/* ───────────────────────────── NHTSA catalog ───────────────────────────── */

const NHTSA_BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";

/**
 * Fetch the model list NHTSA publishes for a make/year. Free, deterministic,
 * and the same endpoint ymmtCatalog already uses to populate the picker.
 *
 * Fails open to an empty list: a vPIC outage should downgrade us to the user's
 * raw text, not block enrichment entirely.
 */
export async function fetchNhtsaModels(make: string, year: number): Promise<string[]> {
  try {
    const url = `${NHTSA_BASE}/GetModelsForMakeYear/make/${encodeURIComponent(
      make,
    )}/modelyear/${year}?format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const rows: Array<{ Model_Name?: string }> = data?.Results ?? [];
    return rows.map((r) => (r?.Model_Name ?? "").trim()).filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

/* ─────────────────────────── CarAPI YMMT catalog ───────────────────────── */

/** "V6" | "I-4" | "6" → 6. */
function parseCarApiCylinders(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Map CarAPI's fuel/engine strings to our enum. */
function mapCarApiFuel(fuelType: any, engineType: any): string {
  const s = `${fuelType ?? ""} ${engineType ?? ""}`.toLowerCase();
  if (s.includes("diesel")) return "Diesel";
  if (s.includes("plug-in") || s.includes("plug in")) return "Plug-in Hybrid";
  if (s.includes("hybrid") || (s.includes("electric") && s.includes("gas"))) return "Hybrid";
  if (s.includes("electric") || s.includes("ev")) return "Electric";
  return "Gasoline"; // flex-fuel / unleaded / premium / gas
}

/**
 * Deterministic powertrain enumeration for a YMM from CarAPI's OEM catalog
 * (`/trims/v2` + `/engines/v2`), an alternative to the Claude web-search path in
 * `researchYmmtPowertrain`. Groups per-trim engine rows into unique powertrains
 * with the trims each was offered on (so `pickPowertrainCandidate` can still
 * disambiguate by trim). CarAPI publishes no OEM engine code → `engine_code`
 * stays empty and the caller applies its synthetic `{disp}l_{cyl}cyl` fallback,
 * identical to the F-150 case in the Claude path. Returns [] on miss so the
 * caller falls back to Claude.
 */
export async function carApiPowertrainCandidates(args: {
  year: number;
  make: string;
  model: string;
}): Promise<PowertrainCandidate[]> {
  const resolvedModel = (await carApiResolveModel(args.make, args.year, args.model)) ?? args.model;
  const cat = await carApiYmmtCatalog({ year: args.year, make: args.make, model: resolvedModel });
  const engines: any[] = Array.isArray(cat.engines?.data) ? cat.engines.data : [];
  if (!engines.length) return [];

  const byKey = new Map<string, PowertrainCandidate>();
  for (const e of engines) {
    const disp = parseFloat(String(e.size));
    const displacement_l = Number.isNaN(disp) ? null : disp;
    const cylinders = parseCarApiCylinders(e.cylinders);
    const fuel_type = mapCarApiFuel(e.fuel_type, e.engine_type);
    const trimName = String(e.trim ?? e.submodel ?? "").trim().toLowerCase();
    const key = `${displacement_l ?? "?"}|${cylinders ?? "?"}|${fuel_type}`;

    const existing = byKey.get(key);
    if (existing) {
      if (trimName && !existing.trims_offered.includes(trimName)) existing.trims_offered.push(trimName);
      continue;
    }
    const aspText = `${e.engine_type ?? ""} ${e.trim_description ?? ""}`.toLowerCase();
    const aspiration = /turbo/.test(aspText)
      ? "turbo"
      : /supercharg/.test(aspText)
        ? "supercharged"
        : null;
    byKey.set(key, {
      engine_code: "", // CarAPI has no OEM code → synthetic fallback in caller
      marketing_name: displacement_l ? `${displacement_l}L ${e.engine_type ?? ""}`.trim() : null,
      displacement_l,
      cylinders,
      fuel_type,
      aspiration,
      trims_offered: trimName ? [trimName] : [],
      drivetrain: e.drive_type ? String(e.drive_type) : null,
      transmission_type: e.transmission ? String(e.transmission) : null,
      confidence: 0.8, // deterministic OEM catalog — high, below a VIN decode
    });
  }
  return [...byKey.values()];
}
