/**
 * vehicleEnrichment/epaFuelEconomy.ts — EPA fuel-economy join (Phase 0.5).
 *
 * Free public-domain data from www.fueleconomy.gov web services (no auth).
 * Two endpoints (JSON via `Accept: application/json`):
 *   - /ws/rest/vehicle/menu/options?year=&make=&model=
 *       → trim/engine option list: { menuItem: [{ text, value }] }.
 *       Quirks verified live (Jul 2026): a SINGLE option collapses to a bare
 *       object ({ menuItem: { text, value } }), and an unknown year/make/model
 *       returns HTTP 200 with body `null`.
 *   - /ws/rest/vehicle/{id}
 *       → full record; every field is a STRING ("city08":"29", "displ":"2.5",
 *       "tCharger":"T"|"", "startStop":"Y"|"N", "co2TailpipeGpm":"472.0").
 *
 * Pipeline law: FAIL OPEN + present-but-wrong is forbidden. Every fetch has a
 * 15s abort and returns null on any error; the picker NEVER guesses — a config
 * whose engine can't be matched unambiguously to exactly one EPA option stores
 * nothing (console.warn) rather than a plausible-but-unverified row.
 *
 * Storage: config_epa_economy — one row per config, upserted. Alongside the
 * sellable MPG/cost/CO2 fields the row carries the EPA record's own
 * displacement/cylinders/turbo/fuel-type as a government-backed second opinion
 * on engine identity. When the picked EPA record DISAGREES with the stored
 * engines row (cylinders unequal, displacement > 0.1 L apart) the row's
 * `coherence_mismatch` field describes the disagreement (plus a console.warn);
 * the P0.3 identity-coherence gate consumes it later — this module never
 * touches the pipeline itself.
 *
 * Claims: epaRecordToClaims() emits Claim[] (source_family "gov", method
 * "api") corroborating displacement_l / cylinders / turbo / fuel_type plus the
 * new mpg_city / mpg_highway / mpg_combined / fuel_cost_per_year_usd / co2_gpm
 * fields. Pure helper for the claim-ledger wiring (P1) — nothing persists
 * claims yet.
 *
 * Wire-in points:
 *   - internal.vehicleEnrichment.epaFuelEconomy.refreshEpaForConfig (per-config)
 *   - internal.vehicleEnrichment.epaFuelEconomy.refreshStaleEpa     (daily cron)
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { Claim } from "./sourceAdapters/types";

const EPA_API_BASE = "https://www.fueleconomy.gov/ws/rest";
const EPA_SOURCE_DOMAIN = "fueleconomy.gov";
const FETCH_TIMEOUT_MS = 15_000;
/** EPA figures are static per model year — 90d staleness is generous. */
const EPA_STALE_AGE_DAYS = 90;
/** Stagger between scheduled per-config refreshes in the stale sweep. */
const STALE_SWEEP_STAGGER_MS = 3_000;
/** Engine-displacement agreement band (menu text rounds to 0.1 L). */
const DISPLACEMENT_TOLERANCE_L = 0.1;

// This module is new — `internal.vehicleEnrichment.epaFuelEconomy` is absent
// from _generated/api.d.ts until `npx convex dev` regenerates it. Same pattern
// as nhtsaOdi.ts's selfApi(); tighten after codegen.
const selfApi = () => (internal as any).vehicleEnrichment.epaFuelEconomy;

// ============================================================================
// Pure helpers (exported for tests — no ctx, no fetch)
// ============================================================================

export type EpaMenuOption = { text: string; value: string };

/** Engine identity parsed from a menu option's display text. */
export type EpaOptionEngine = {
  displacement_l: number | null;
  cylinders: number | null;
  turbo: boolean;
  diesel: boolean;
  /** "automatic" | "manual" | null (unparseable). EPA text starts "Auto …" or "Man …". */
  transmission: string | null;
};

export type EpaVehicleRecord = {
  epa_vehicle_id: string;
  mpg_city: number | null;
  mpg_highway: number | null;
  mpg_combined: number | null;
  fuel_cost_per_year_usd: number | null;
  co2_gpm: number | null;
  fuel_type: string | null; // verbatim fuelType1, e.g. "Regular Gasoline"
  displacement_l: number | null;
  cylinders: number | null;
  turbo: boolean | null; // tCharger "T" → true, "" → false, absent → null
  supercharger: boolean | null; // sCharger
  start_stop: boolean | null;
  atv_type: string | null; // "Hybrid" | "Plug-in Hybrid" | "EV" | … (empty → null)
  drive: string | null;
  transmission: string | null; // verbatim trany, e.g. "Automatic (S8)"
};

const asTrimmed = (x: unknown): string | null =>
  typeof x === "string" && x.trim().length > 0 ? x.trim() : null;

/** EPA numerics arrive as strings; parse leniently, fail open to null. */
const asEpaNumber = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string" || x.trim().length === 0) return null;
  const n = Number(x.trim());
  return Number.isFinite(n) ? n : null;
};

/** "T"/"S"/"Y"/true → true; ""/"N"/false → false; anything else → null. */
const asEpaFlag = (x: unknown): boolean | null => {
  if (x === true) return true;
  if (x === false) return false;
  if (typeof x !== "string") return null;
  const s = x.trim().toUpperCase();
  if (s === "T" || s === "S" || s === "Y") return true;
  if (s === "" || s === "N") return false;
  return null;
};

/**
 * Parse the menu/options response into a normalized option list.
 * Handles all three live shapes: array menuItem, single-object menuItem
 * (the XML→JSON collapse), and the bare-`null` body meaning "no such
 * year/make/model" (a genuine zero-result, NOT a failure). Anything else
 * fails open to [].
 */
export function parseEpaMenuOptions(json: unknown): EpaMenuOption[] {
  if (json === null || json === undefined) return [];
  const menuItem = (json as { menuItem?: unknown }).menuItem;
  const rawItems = Array.isArray(menuItem)
    ? menuItem
    : typeof menuItem === "object" && menuItem !== null
      ? [menuItem]
      : [];
  const out: EpaMenuOption[] = [];
  for (const item of rawItems) {
    if (typeof item !== "object" || item === null) continue;
    const text = asTrimmed((item as Record<string, unknown>).text);
    const value = asTrimmed((item as Record<string, unknown>).value);
    if (text && value) out.push({ text, value });
  }
  return out;
}

/**
 * Parse an option's display text ("Auto (S10), 6 cyl, 3.5 L, Turbo") into an
 * engine identity. EVs carry no cyl/displacement segments → nulls. Never throws.
 */
export function parseEpaOptionEngine(text: string): EpaOptionEngine {
  const raw = typeof text === "string" ? text : "";
  const cylMatch = raw.match(/(\d+)\s*cyl/i);
  const displMatch = raw.match(/(\d+(?:\.\d+)?)\s*L\b/i);
  const transMatch = raw.match(/^\s*(auto|man)/i);
  return {
    displacement_l: displMatch ? Number(displMatch[1]) : null,
    cylinders: cylMatch ? Number(cylMatch[1]) : null,
    turbo: /\bturbo\b/i.test(raw),
    diesel: /\bdiesel\b/i.test(raw),
    transmission: transMatch
      ? transMatch[1].toLowerCase() === "man"
        ? "manual"
        : "automatic"
      : null,
  };
}

/** Normalize a config's transmission_type to the menu vocabulary. */
function normalizeTransmissionType(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s.includes("man")) return "manual";
  if (s.includes("auto") || s.includes("cvt") || s.includes("dct") || s.includes("dsg"))
    return "automatic";
  return null;
}

export type ConfigEngineAttrs = {
  displacement_l: number | null;
  cylinders: number | null;
  transmission_type: string | null;
};

/**
 * Choose the ONE menu option matching the config's engine, or null.
 * Law: present-but-wrong is forbidden — this never guesses.
 *   - displacement filter: |option − config| ≤ 0.1 L (menu text rounds to
 *     0.1 L). An option WITHOUT a parseable displacement (EV rows) is excluded
 *     whenever the config has one.
 *   - cylinders filter: equal, applied only when both sides are known.
 *   - transmission tiebreak: applied only if >1 candidate remains and the
 *     config's transmission_type maps to automatic/manual.
 *   - exactly one candidate after filtering → that option; zero or several →
 *     null (several identical-engine variants have DIFFERENT MPG, so picking
 *     any of them would be a guess).
 *   - a config with NO known engine attrs matches only a single-option menu
 *     (nothing to contradict, nothing to choose between).
 */
export function pickBestEpaVehicle(
  options: EpaMenuOption[],
  engine: ConfigEngineAttrs,
): EpaMenuOption | null {
  const list = Array.isArray(options) ? options : [];
  // Duplicate display texts are the same powertrain listing; keep the first.
  const seen = new Set<string>();
  const unique = list.filter((o) => {
    if (typeof o?.text !== "string" || typeof o?.value !== "string") return false;
    if (seen.has(o.text)) return false;
    seen.add(o.text);
    return true;
  });
  if (unique.length === 0) return null;

  const cfgDispl =
    typeof engine?.displacement_l === "number" && Number.isFinite(engine.displacement_l)
      ? engine.displacement_l
      : null;
  const cfgCyl =
    typeof engine?.cylinders === "number" && Number.isFinite(engine.cylinders)
      ? engine.cylinders
      : null;
  const cfgTrans = normalizeTransmissionType(engine?.transmission_type);

  if (cfgDispl === null && cfgCyl === null) {
    // No engine identity to match on — only an unambiguous single listing is safe.
    return unique.length === 1 ? unique[0] : null;
  }

  let candidates = unique.filter((o) => {
    const parsed = parseEpaOptionEngine(o.text);
    if (cfgDispl !== null) {
      if (parsed.displacement_l === null) return false;
      // ε guards float artifacts at the exact 0.1 boundary (e.g. 3.5 vs 3.6).
      if (Math.abs(parsed.displacement_l - cfgDispl) > DISPLACEMENT_TOLERANCE_L + 1e-9)
        return false;
    }
    if (cfgCyl !== null && parsed.cylinders !== null && parsed.cylinders !== cfgCyl) return false;
    return true;
  });

  if (candidates.length > 1 && cfgTrans !== null) {
    const byTrans = candidates.filter(
      (o) => parseEpaOptionEngine(o.text).transmission === cfgTrans,
    );
    if (byTrans.length > 0) candidates = byTrans;
  }

  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Parse the /vehicle/{id} response body into a typed record. Every source
 * field is a string; missing/blank fields become null. Returns null only when
 * the body has no usable id (the record is unkeyable). Never throws.
 */
export function parseEpaVehicleRecord(json: unknown): EpaVehicleRecord | null {
  if (typeof json !== "object" || json === null) return null;
  const e = json as Record<string, unknown>;
  const id = asTrimmed(e.id);
  if (!id) return null;

  // MPG 0 means "not applicable" in EPA data (e.g. an EV's gasoline MPG) —
  // treat non-positive as absent so we never store a zero as a real figure.
  const positive = (x: unknown): number | null => {
    const n = asEpaNumber(x);
    return n !== null && n > 0 ? n : null;
  };

  return {
    epa_vehicle_id: id,
    mpg_city: positive(e.city08),
    mpg_highway: positive(e.highway08),
    mpg_combined: positive(e.comb08),
    fuel_cost_per_year_usd: positive(e.fuelCost08),
    co2_gpm: positive(e.co2TailpipeGpm),
    fuel_type: asTrimmed(e.fuelType1),
    displacement_l: positive(e.displ),
    cylinders: positive(e.cylinders),
    turbo: asEpaFlag(e.tCharger),
    supercharger: asEpaFlag(e.sCharger),
    start_stop: asEpaFlag(e.startStop),
    atv_type: asTrimmed(e.atvType),
    drive: asTrimmed(e.drive),
    transmission: asTrimmed(e.trany),
  };
}

/**
 * Map EPA's fuelType1 vocabulary onto the engines-table vocabulary for the
 * claim's comparable value. Conservative: only well-understood buckets are
 * renamed; anything unrecognized passes through lowercased (verbatim survives
 * in value_raw either way).
 */
export function normalizeEpaFuelType(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.includes("diesel")) return "diesel";
  if (s.includes("e85")) return "flex-fuel";
  if (s.includes("gasoline") && !s.includes("electricity")) return "gasoline";
  if (s === "electricity") return "electric";
  return s;
}

/**
 * Emit the claim set for one EPA vehicle record: corroboration claims for
 * displacement_l / cylinders / turbo / fuel_type plus the new sellable
 * mpg_city / mpg_highway / mpg_combined / fuel_cost_per_year_usd / co2_gpm
 * fields. Null record fields emit no claim (never a guess). Pure — observedAt
 * is injectable for deterministic tests.
 */
export function epaRecordToClaims(record: EpaVehicleRecord, observedAt: number = Date.now()): Claim[] {
  const sourceUrl = `${EPA_API_BASE}/vehicle/${encodeURIComponent(record.epa_vehicle_id)}`;
  const base = {
    source_family: "gov" as const,
    source_domain: EPA_SOURCE_DOMAIN,
    source_url: sourceUrl,
    method: "api" as const,
    observed_at: observedAt,
  };
  const claims: Claim[] = [];
  const numeric: Array<[string, number | null]> = [
    ["displacement_l", record.displacement_l],
    ["cylinders", record.cylinders],
    ["mpg_city", record.mpg_city],
    ["mpg_highway", record.mpg_highway],
    ["mpg_combined", record.mpg_combined],
    ["fuel_cost_per_year_usd", record.fuel_cost_per_year_usd],
    ["co2_gpm", record.co2_gpm],
  ];
  for (const [field_key, value] of numeric) {
    if (value === null) continue;
    claims.push({ field_key, value: String(value), value_raw: String(value), ...base });
  }
  if (record.turbo !== null) {
    claims.push({
      field_key: "turbo",
      value: record.turbo ? "true" : "false",
      value_raw: record.turbo ? "T" : "",
      ...base,
    });
  }
  if (record.fuel_type !== null) {
    claims.push({
      field_key: "fuel_type",
      value: normalizeEpaFuelType(record.fuel_type),
      value_raw: record.fuel_type,
      ...base,
    });
  }
  return claims;
}

/**
 * Describe a disagreement between the stored engines row and the picked EPA
 * record on cylinders / displacement (> 0.1 L), or null when coherent. Only
 * fields KNOWN on both sides can disagree. Consumed by the P0.3 gate later.
 */
export function describeCoherenceMismatch(
  engine: { cylinders: number | null; displacement_l: number | null },
  record: EpaVehicleRecord,
): string | null {
  const parts: string[] = [];
  if (
    engine.cylinders !== null &&
    record.cylinders !== null &&
    engine.cylinders !== record.cylinders
  ) {
    parts.push(`cylinders: engines row ${engine.cylinders} vs EPA ${record.cylinders}`);
  }
  if (
    engine.displacement_l !== null &&
    record.displacement_l !== null &&
    Math.abs(engine.displacement_l - record.displacement_l) > DISPLACEMENT_TOLERANCE_L + 1e-9
  ) {
    parts.push(
      `displacement_l: engines row ${engine.displacement_l} vs EPA ${record.displacement_l}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** EPA drive-suffix vocabulary for a config drivetrain. EPA lists FWD/RWD
 *  trucks under "2WD", so those map to two suffixes tried in order. */
function drivetrainSuffixes(drivetrain: string | null | undefined): string[] {
  if (typeof drivetrain !== "string") return [];
  let s = drivetrain.trim().toUpperCase();
  if (s === "4X4") s = "4WD";
  if (s === "4X2") s = "2WD";
  switch (s) {
    case "AWD":
      return ["AWD"];
    case "4WD":
      return ["4WD"];
    case "FWD":
      return ["FWD", "2WD"];
    case "RWD":
      return ["RWD", "2WD"];
    case "2WD":
      return ["2WD"];
    default:
      return [];
  }
}

/**
 * Manufacturer AWD words EPA bakes into the MODEL NAME instead of using a
 * generic "AWD" suffix. Verified live against /vehicle/menu/model, 2026-08-01:
 * EPA lists "GLC300 4matic", "Atlas 4motion", never "GLC300 AWD".
 *
 * Porsche's AWD token is deliberately ABSENT. Porsche encodes drive in the
 * model itself ("Carrera 4", "Carrera 4S"), so a bare "4" suffix does not
 * merely miss — appended to a truncated base it SYNTHESISES A DIFFERENT REAL
 * CAR ("911 Carrera" + "4" = "911 Carrera 4", 379 hp, when the vehicle is a
 * Carrera 4S, 443 hp). An exact-match lookup cannot protect us from a
 * candidate that is itself a valid other model; only not generating it can.
 */
const BRAND_AWD_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "mercedes-benz": ["4matic"],
  volkswagen: ["4motion"],
  audi: ["quattro"],
  bmw: ["xDrive"],
};

/**
 * EPA model names diverge from ours in four ways, all verified live:
 *   1. punctuation ("F-150" vs "F150");
 *   2. a baked-in drive suffix ("Crosstrek AWD", "Escape FWD");
 *   3. a baked-in TRIM — the big one. EPA lists "X5 xDrive40i" and
 *      "X5 xDrive50i" but NOTHING under "X5", so a bare-model query returns
 *      null for most of the premium fleet. Measured 2026-08-01: bare-model
 *      lookups resolved 0 of 6 audited vehicles;
 *   4. a family-name mismatch, where our model is the family ("GLC-Class")
 *      and EPA's model is what we store as the TRIM ("GLC300 4matic").
 *
 * ORDERING IS LOAD-BEARING, and there are two competing rules:
 *
 *   (a) Within one base, drive-suffixed names come FIRST: when EPA lists both
 *       "RX 350" and "RX 350 AWD", the bare name is the OTHER drivetrain's
 *       ratings, and taking it for an AWD config is present-but-wrong.
 *   (b) Across bases, the FULL trim is exhausted before anything is
 *       truncated. Truncating first and then appending a drive token is how
 *       "911 Carrera 4S" became "911 Carrera 4" in the design probe.
 *
 * So: bases run outer (most specific first), suffixes inner.
 *
 * Still NO fuzzy prefix matching against the model menu — every candidate is
 * an exact name, so a wrong one returns empty. The one class an exact lookup
 * cannot defend against is a candidate that happens to name a different real
 * model, which is what BRAND_AWD_TOKENS' Porsche omission exists to prevent.
 */
export function epaModelNameCandidates(
  model: string,
  drivetrain?: string | null,
  trim?: string | null,
  make?: string | null,
): string[] {
  const exact = typeof model === "string" ? model.trim() : "";
  if (exact.length === 0) return [];
  const trimStr = typeof trim === "string" ? trim.trim() : "";
  // A family model name ("GLC-Class", "3 Series") is a container, not a car —
  // for those EPA's model is what we call the trim.
  const isFamily = /-class$/i.test(exact) || /\bclass$/i.test(exact);
  // First token of the trim, split on space AND hyphen: "GLC300-4M" → "GLC300",
  // "350 Standard" → "350".
  const trimHead = trimStr ? trimStr.replace(/-/g, " ").trim().split(/\s+/)[0] : "";

  // A "base" is one semantic name, carrying its SPELLING variants together
  // (hyphenated / dehyphenated) — those are the same candidate written two
  // ways, so they share a rung and rule (a) applies across them as a group.
  const spellings = (s: string): string[] => {
    const d = s.replace(/-/g, "");
    return d !== s ? [s, d] : [s];
  };
  const bases: string[][] = [];
  const push = (b: string) => {
    const v = b.trim();
    if (!v) return;
    const group = spellings(v);
    if (!bases.some((g) => g[0] === group[0])) bases.push(group);
  };

  // Most specific first — see rule (b).
  if (trimStr) push(`${exact} ${trimStr}`);
  if (isFamily && trimStr) push(trimStr);
  if (trimHead && trimHead !== trimStr) push(`${exact} ${trimHead}`);
  if (isFamily && trimHead && trimHead !== trimStr) push(trimHead);
  push(exact);

  const brandTokens = make ? (BRAND_AWD_TOKENS[make.trim().toLowerCase()] ?? []) : [];
  const generic = drivetrainSuffixes(drivetrain);
  const isAwd = generic.includes("AWD") || generic.includes("4WD");
  // EPA writes the same all-wheel layout as "4WD" on trucks and "AWD" on
  // crossovers, while our decode stores whichever vPIC reported: a 2019 Lexus
  // RX decodes "4WD" but EPA lists "RX 350 AWD", so a 4WD-only candidate set
  // fell through to the bare "RX 350" — the FRONT-wheel-drive ratings.
  // Scoped to the trim-aware path so the long-standing no-trim expectations
  // (e.g. F-150 4WD) keep their exact candidate list.
  const alias = trimStr
    ? generic.includes("4WD")
      ? ["AWD"]
      : generic.includes("AWD")
        ? ["4WD"]
        : []
    : [];
  const suffixes = [...(isAwd ? brandTokens : []), ...generic, ...alias];

  const out: string[] = [];
  for (const group of bases) {
    for (const suffix of suffixes) {
      for (const spelling of group) out.push(`${spelling} ${suffix}`); // rule (a)
    }
    for (const spelling of group) out.push(spelling);
  }
  return [...new Set(out)];
}

// ============================================================================
// Fetch layer — 15s abort, fail open to null on ANY error
// ============================================================================

/**
 * Shared GET → parsed-JSON with the fail-open discipline. Returns
 * { data } on any HTTP 200 with parseable JSON (data may legitimately be
 * null — EPA's "no such vehicle menu" response), and null on any transport /
 * HTTP / parse error so callers can distinguish "EPA said none" from
 * "we don't know" and store nothing in the latter case.
 */
async function fetchEpaJson(url: string, label: string): Promise<{ data: unknown } | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[epa-economy] ${label} HTTP ${response.status} for ${url}`);
      return null;
    }
    return { data: (await response.json()) as unknown };
  } catch (e) {
    // Covers abort/timeout, DNS, TLS, and JSON parse errors alike.
    console.warn(`[epa-economy] ${label} fetch failed for ${url}:`, e);
    return null;
  }
}

/**
 * Menu options for one YMM, trying each model-name candidate until one
 * returns a non-empty list. null = fetch failed (store nothing);
 * [] = EPA genuinely lists nothing under any candidate name.
 */
export async function fetchEpaMenuOptions(
  year: number,
  make: string,
  model: string,
  drivetrain?: string | null,
  trim?: string | null,
): Promise<EpaMenuOption[] | null> {
  let sawFailure = false;
  for (const candidate of epaModelNameCandidates(model, drivetrain, trim, make)) {
    const url =
      `${EPA_API_BASE}/vehicle/menu/options` +
      `?year=${encodeURIComponent(String(year))}&make=${encodeURIComponent(make)}` +
      `&model=${encodeURIComponent(candidate)}`;
    const result = await fetchEpaJson(url, "menu-options");
    if (result === null) {
      sawFailure = true;
      continue;
    }
    const options = parseEpaMenuOptions(result.data);
    if (options.length > 0) return options;
  }
  // Every candidate came back empty: only trust "genuinely none" when no
  // candidate's fetch FAILED (a transient outage must not read as zero).
  return sawFailure ? null : [];
}

/** Full record for one EPA vehicle id. null = fetch failed or unkeyable body. */
export async function fetchEpaVehicleRecord(
  epaVehicleId: string,
): Promise<EpaVehicleRecord | null> {
  const url = `${EPA_API_BASE}/vehicle/${encodeURIComponent(epaVehicleId)}`;
  const result = await fetchEpaJson(url, "vehicle-record");
  if (result === null) return null;
  const record = parseEpaVehicleRecord(result.data);
  if (record === null) {
    console.warn(`[epa-economy] vehicle-record malformed body for ${url}`);
  }
  return record;
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Engine + transmission attributes for the picker and the coherence check.
 * getVehicleLabels already surfaces displacement; this adds cylinders and
 * transmission_type (defined here rather than editing v3queries — this phase
 * touches no existing pipeline file).
 */
export const getEngineAttrsForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.vehicleConfigId);
    if (!config) return null;
    const cfg = config as any;
    const [engine, transmission] = await Promise.all([
      cfg.engine_id ? ctx.db.get(cfg.engine_id as any) : null,
      cfg.transmission_id ? ctx.db.get(cfg.transmission_id as any) : null,
    ]);
    const eng = engine as any;
    const trans = transmission as any;
    const rawDispl = eng?.displacement_l ?? eng?.displacement_liters ?? null;
    const displacement_l =
      typeof rawDispl === "number"
        ? rawDispl
        : typeof rawDispl === "string" && Number.isFinite(Number(rawDispl))
          ? Number(rawDispl)
          : null;
    return {
      displacement_l,
      cylinders: typeof eng?.cylinders === "number" ? eng.cylinders : null,
      fuel_type: (eng?.fuel_type as string | undefined) ?? null,
      aspiration: (eng?.aspiration as string | undefined) ?? null,
      transmission_type:
        (trans?.transmission_type as string | undefined) ?? (trans?.type as string | undefined) ?? null,
      drivetrain: (cfg.drivetrain as string | undefined) ?? null,
    };
  },
});

/**
 * Oldest-first page of stale EPA rows (fetched_at < cutoff). Index-ordered
 * (by_fetched_at ascends) + .take(limit) — no unbounded .collect(). Configs
 * with NO row yet are invisible here by design: their first pull comes from
 * an explicit refreshEpaForConfig call, not the stale sweep.
 */
export const staleEpaPage = internalQuery({
  args: { cutoff: v.float64(), limit: v.float64() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("config_epa_economy")
      .withIndex("by_fetched_at", (q) => q.lt("fetched_at", args.cutoff))
      .take(Math.max(1, Math.min(500, Math.floor(args.limit))));
    return rows.map((r) => ({
      vehicle_config_id: r.vehicle_config_id,
      fetched_at: r.fetched_at,
    }));
  },
});

// ============================================================================
// Mutations (idempotent upserts)
// ============================================================================

/** Upsert the single EPA-economy row for a config. */
export const upsertEpaEconomy = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    epa_vehicle_id: v.string(),
    mpg_city: v.optional(v.float64()),
    mpg_highway: v.optional(v.float64()),
    mpg_combined: v.optional(v.float64()),
    fuel_cost_per_year_usd: v.optional(v.float64()),
    co2_gpm: v.optional(v.float64()),
    epa_fuel_type: v.optional(v.string()),
    epa_displacement_l: v.optional(v.float64()),
    epa_cylinders: v.optional(v.float64()),
    epa_turbo: v.optional(v.boolean()),
    coherence_mismatch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const { vehicle_config_id, ...fields } = args;
    const existing = await ctx.db
      .query("config_epa_economy")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", vehicle_config_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...fields,
        // A re-pick that is now coherent must CLEAR a stale mismatch.
        coherence_mismatch: args.coherence_mismatch,
        fetched_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("config_epa_economy", {
      vehicle_config_id,
      ...fields,
      source: "epa_fueleconomy" as const,
      fetched_at: now,
    });
  },
});

// ============================================================================
// Actions
// ============================================================================

type RefreshEpaResult = {
  ok: boolean;
  epaVehicleId: string | null;
  mpgCombined: number | null;
  coherenceMismatch: string | null;
  skippedReason?: string;
};

/**
 * Fetch + match + store the EPA economy row for one config. Idempotent (pure
 * upsert). Fail open end to end: an unresolvable config, a dead API, or an
 * ambiguous/no-match menu logs a warn and stores NOTHING — this action never
 * throws, so it is safe to await from inside an enrichment run.
 */
export const refreshEpaForConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<RefreshEpaResult> => {
    const result: RefreshEpaResult = {
      ok: false,
      epaVehicleId: null,
      mpgCombined: null,
      coherenceMismatch: null,
    };
    try {
      // Same YMM resolution the pipeline uses.
      const labels: { year: number; make: string; model: string } | null = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleLabels,
        { vehicleConfigId: args.vehicleConfigId },
      );
      if (!labels || !labels.make || !labels.model || !labels.year) {
        console.warn(
          `[epa-economy] config ${args.vehicleConfigId} unresolvable (labels=${JSON.stringify(labels)}) — skipping`,
        );
        result.skippedReason = "unresolvable_config";
        return result;
      }
      const { year, make, model } = labels;

      const attrs: {
        displacement_l: number | null;
        cylinders: number | null;
        transmission_type: string | null;
        drivetrain: string | null;
      } | null = await ctx.runQuery(selfApi().getEngineAttrsForConfig, {
        vehicleConfigId: args.vehicleConfigId,
      });
      const engineAttrs: ConfigEngineAttrs = {
        displacement_l: attrs?.displacement_l ?? null,
        cylinders: attrs?.cylinders ?? null,
        transmission_type: attrs?.transmission_type ?? null,
      };

      // ── Menu → unambiguous pick ──────────────────────────────────────
      // Trim is passed because EPA bakes it into the model name for most of
      // the premium fleet ("X5 xDrive40i", "911 GT3 RS"); without it the
      // bare-model query returns null and the join silently stores nothing.
      const options = await fetchEpaMenuOptions(
        year,
        make,
        model,
        attrs?.drivetrain ?? null,
        (labels as any)?.trim ?? null,
      );
      if (options === null) {
        result.skippedReason = "menu_fetch_failed";
        return result; // fetch failed — existing row (if any) keeps its age
      }
      if (options.length === 0) {
        console.warn(`[epa-economy] no EPA listings for ${year} ${make} ${model} — storing nothing`);
        result.skippedReason = "no_epa_model_match";
        return result;
      }
      const picked = pickBestEpaVehicle(options, engineAttrs);
      if (picked === null) {
        console.warn(
          `[epa-economy] ambiguous/no engine match for ${year} ${make} ${model} ` +
            `(engine=${JSON.stringify(engineAttrs)}, ${options.length} option(s)) — storing nothing`,
        );
        result.skippedReason = "ambiguous_engine_match";
        return result;
      }

      // ── Full record ──────────────────────────────────────────────────
      const record = await fetchEpaVehicleRecord(picked.value);
      if (record === null) {
        result.skippedReason = "record_fetch_failed";
        return result;
      }

      // ── Coherence signal (P0.3 feeder — flag, never overwrite) ───────
      const mismatch = describeCoherenceMismatch(
        { cylinders: engineAttrs.cylinders, displacement_l: engineAttrs.displacement_l },
        record,
      );
      if (mismatch !== null) {
        console.warn(
          `[epa-economy] COHERENCE MISMATCH for config ${args.vehicleConfigId} ` +
            `(${year} ${make} ${model}, EPA id ${record.epa_vehicle_id}): ${mismatch}`,
        );
      }

      await ctx.runMutation(selfApi().upsertEpaEconomy, {
        vehicle_config_id: args.vehicleConfigId,
        epa_vehicle_id: record.epa_vehicle_id,
        mpg_city: record.mpg_city ?? undefined,
        mpg_highway: record.mpg_highway ?? undefined,
        mpg_combined: record.mpg_combined ?? undefined,
        fuel_cost_per_year_usd: record.fuel_cost_per_year_usd ?? undefined,
        co2_gpm: record.co2_gpm ?? undefined,
        epa_fuel_type: record.fuel_type ?? undefined,
        epa_displacement_l: record.displacement_l ?? undefined,
        epa_cylinders: record.cylinders ?? undefined,
        epa_turbo: record.turbo ?? undefined,
        coherence_mismatch: mismatch ?? undefined,
      });

      result.ok = true;
      result.epaVehicleId = record.epa_vehicle_id;
      result.mpgCombined = record.mpg_combined;
      result.coherenceMismatch = mismatch;
      console.log(
        `[epa-economy] ${year} ${make} ${model}: EPA id ${record.epa_vehicle_id}, ` +
          `mpg ${record.mpg_city ?? "?"}/${record.mpg_highway ?? "?"}/${record.mpg_combined ?? "?"}` +
          (mismatch ? " (coherence mismatch flagged)" : ""),
      );
      return result;
    } catch (e) {
      // Belt-and-braces: nothing above should throw, but the pipeline law says
      // this action never does.
      console.warn(`[epa-economy] refreshEpaForConfig failed for ${args.vehicleConfigId}:`, e);
      return result;
    }
  },
});

/**
 * Daily sweep: re-pull configs whose EPA row is older than 90 days, oldest
 * first. Each config runs as its own scheduled refreshEpaForConfig
 * (staggered) so one slow/failing config can't eat the sweep's action budget
 * and fueleconomy.gov sees a gentle request rate.
 */
export const refreshStaleEpa = internalAction({
  args: { limit: v.optional(v.float64()) },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    try {
      const limit = args.limit ?? 50;
      const cutoff = Date.now() - EPA_STALE_AGE_DAYS * 24 * 60 * 60 * 1000;
      const stale: Array<{ vehicle_config_id: Id<"vehicle_configs">; fetched_at: number }> =
        await ctx.runQuery(selfApi().staleEpaPage, { cutoff, limit });

      for (let i = 0; i < stale.length; i++) {
        await ctx.scheduler.runAfter(i * STALE_SWEEP_STAGGER_MS, selfApi().refreshEpaForConfig, {
          vehicleConfigId: stale[i].vehicle_config_id,
        });
      }
      console.log(
        `[epa-economy] stale sweep: ${stale.length} config(s) scheduled (limit ${limit}, age > ${EPA_STALE_AGE_DAYS}d)`,
      );
      return { scheduled: stale.length };
    } catch (e) {
      console.warn("[epa-economy] refreshStaleEpa failed:", e);
      return { scheduled: 0 };
    }
  },
});
