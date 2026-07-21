/**
 * vehicleEnrichment/buildSourceResolver.ts — P2 of variant identification:
 * resolve the BUILD SOURCE (the marque that actually built the car/powertrain)
 * and normalize NHTSA's messy corporate-manufacturer strings.
 *
 * WHY: on a badge-engineered vehicle the parts/fluids follow the BUILDER, not
 * the badge (batch-8: a 2020 Toyota Yaris is a rebadged Mazda2 → Mazda ATF FZ /
 * FL22 / Mazda part numbers, not Toyota). The P0 seed just compared
 * engine_manufacturer to the make as strings, which (a) false-fired on NHTSA
 * corporate-parent forms ("FCA US LLC" on a Jeep reads as foreign even though
 * FCA IS Jeep's parent) and (b) couldn't tell an independent ENGINE supplier
 * (Cummins — not a badge) from a whole-vehicle rebadge (Mazda — a badge).
 *
 * This resolver fixes both:
 *  1. normalizeManufacturer maps corporate/parent strings ("FCA", "General
 *     Motors LLC", "Toyota Motor Manufacturing") to a canonical MARQUE token
 *     that makesSameFamily understands — and maps INDEPENDENT engine/component
 *     suppliers (Cummins, ZF, Aisin) to null, because a third-party engine is
 *     not a badge (that case is handled by the engine-maker fluid rules).
 *  2. A curated BADGE_MAP is the authoritative backstop for known,
 *     part-affecting rebadges where engine_manufacturer alone won't reveal it.
 *
 * Fail-open: returns null build source unless a source is positively
 * established. Pure module — no IO. Exported for tests.
 */

import { makesSameFamily } from "./contentSanitization";

export interface BuildSourceResolution {
  /** Canonical builder marque (e.g. "mazda") when the vehicle is badge-
   *  engineered / built by a different marque than its make; else null. */
  build_source_make: string | null;
  confidence: number;
  source: string; // "badge_map" | "engine_mfr" | "none"
  is_badge_engineered: boolean;
  reason: string;
}

/**
 * Normalize a raw NHTSA manufacturer / engine-manufacturer / parent-company
 * string to a canonical vehicle-MARQUE token (one makesSameFamily recognizes).
 * Returns null for independent engine/component suppliers (not a vehicle badge)
 * and for anything unrecognized (fail open).
 */
export function normalizeManufacturer(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();

  // Independent engine / driveline / component suppliers — a third-party engine
  // is NOT a badge. (VM Motori is FCA-owned → handled as Chrysler below, so it
  // is intentionally NOT in this list.)
  if (
    /\bcummins\b/.test(s) || s.includes("detroit diesel") || s.includes("navistar") ||
    s.includes("maxxforce") || s.includes("international harvester") || s.includes("paccar") ||
    s.includes("yanmar") || s.includes("kubota") || /\bdeere\b/.test(s) ||
    /\bzf\b/.test(s) || s.includes("aisin") || s.includes("jatco") || s.includes("getrag") ||
    s.includes("borgwarner") || s.includes("bosch") || s.includes("denso") ||
    s.includes("magna") || s.includes("valeo") || s.includes("continental")
  ) {
    return null;
  }

  // Corporate parents / marque strings → canonical family-anchor marque.
  if (s.includes("fca") || s.includes("chrysler") || s.includes("stellantis") ||
      s.includes("mopar") || s.includes("vm motori")) return "chrysler";
  if (s.includes("general motors") || /\bgm\b/.test(s) || s.includes("opel") ||
      s.includes("vauxhall")) return "chevrolet";
  if (s.includes("ford") || s.includes("lincoln") || s.includes("motorcraft")) return "ford";
  if (s.includes("toyota") || s.includes("daihatsu")) return "toyota";
  if (s.includes("lexus")) return "lexus";
  if (s.includes("scion")) return "scion";
  if (s.includes("mazda")) return "mazda";
  if (s.includes("honda") || s.includes("acura")) return "honda";
  if (s.includes("nissan") || s.includes("infiniti") || s.includes("datsun")) return "nissan";
  if (s.includes("hyundai")) return "hyundai";
  if (/\bkia\b/.test(s)) return "kia";
  if (s.includes("genesis")) return "genesis";
  if (s.includes("subaru") || s.includes("fuji heavy")) return "subaru";
  if (s.includes("mitsubishi")) return "mitsubishi";
  if (s.includes("suzuki")) return "suzuki";
  if (s.includes("volkswagen") || /\bvw\b/.test(s) || s.includes("audi") ||
      s.includes("porsche") || s.includes("seat") || s.includes("skoda")) return "volkswagen";
  if (s.includes("bmw") || s.includes("bayerische") || /\bmini\b/.test(s)) return "bmw";
  if (s.includes("mercedes") || s.includes("daimler") || /\bbenz\b/.test(s)) return "mercedes";
  if (s.includes("volvo")) return "volvo";
  if (s.includes("jaguar") || s.includes("land rover") || s.includes("landrover")) return "jaguar";
  if (/\bfiat\b/.test(s) || s.includes("alfa")) return "chrysler"; // Mopar/Stellantis family
  return null;
}

/** Curated, part-affecting badge-engineered vehicles where the BUILDER differs
 *  from the badge. Authoritative backstop for cases engine_manufacturer alone
 *  won't reveal (or reveals as the chassis make). Keyed on make+model with an
 *  optional inclusive model-year range. Keep entries high-confidence + sourced;
 *  extend the table rather than adding per-model code. */
interface BadgeRule {
  make: string;
  model: string;
  years?: [number, number]; // inclusive
  source: string;           // canonical builder marque (lowercase, for family checks)
  /** Builder make + model as they appear in the BUILDER's parts catalog — used
   *  by resolveScrapeRedirect (P2.5) to point the parts scrape at the right car
   *  (a "Yaris" doesn't exist in Mazda's catalog; the "Mazda2" does). */
  source_make?: string;
  source_model?: string;
  note: string;
}
const BADGE_MAP: readonly BadgeRule[] = [
  // 2016-2020 Yaris sedan (iA) + 2019-2020 hatch are the Mazda2 (Mazda-built,
  // Mexico). The 2006-2018 Toyota-built Yaris hatch is NOT this — year-gated.
  { make: "toyota", model: "yaris", years: [2016, 2020], source: "mazda", source_make: "Mazda", source_model: "Mazda2", note: "Mazda2-based Yaris iA/hatch" },
  // Toyota 86 / GR 86 / Scion FR-S — Subaru-built (BRZ twin).
  { make: "toyota", model: "86", source: "subaru", source_make: "Subaru", source_model: "BRZ", note: "Subaru-built 86" },
  { make: "toyota", model: "gr86", source: "subaru", source_make: "Subaru", source_model: "BRZ", note: "Subaru-built GR86" },
  { make: "scion", model: "fr-s", source: "subaru", source_make: "Subaru", source_model: "BRZ", note: "Subaru-built FR-S" },
  // 2020+ GR Supra — BMW Z4-based, built by Magna Steyr on BMW architecture.
  { make: "toyota", model: "supra", years: [2020, 2099], source: "bmw", source_make: "BMW", source_model: "Z4", note: "BMW Z4-based Supra" },
  // Pontiac Vibe — Toyota-built (Matrix twin, NUMMI).
  { make: "pontiac", model: "vibe", source: "toyota", source_make: "Toyota", source_model: "Matrix", note: "Toyota-built Vibe" },
  // Chevrolet City Express — Nissan NV200 rebadge.
  { make: "chevrolet", model: "city express", source: "nissan", source_make: "Nissan", source_model: "NV200", note: "Nissan NV200 rebadge" },
];

function normModel(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface BuildSourceInputs {
  make: string | null;
  model: string | null;
  model_year: number | null;
  engine_manufacturer: string | null;
}

/**
 * Resolve the build source. Priority:
 *  1. Curated BADGE_MAP hit (authoritative for known part-affecting rebadges).
 *  2. engine_manufacturer normalizes to a vehicle marque of a DIFFERENT
 *     corporate family than the make → that marque (third-party-built powertrain).
 *  3. Otherwise null (the make builds its own, or the signal is an independent
 *     supplier / unrecognized → fail open).
 */
export function resolveBuildSource(input: BuildSourceInputs): BuildSourceResolution {
  const none: BuildSourceResolution = {
    build_source_make: null, confidence: 0, source: "none",
    is_badge_engineered: false, reason: "no build-source signal",
  };
  const mk = input.make?.trim();
  if (!mk) return none;

  // 1. Curated badge map (authoritative).
  const model = normModel(input.model);
  const mkl = mk.toLowerCase();
  for (const rule of BADGE_MAP) {
    if (rule.make !== mkl) continue;
    if (normModel(rule.model) !== model) continue;
    if (rule.years && input.model_year != null &&
        (input.model_year < rule.years[0] || input.model_year > rule.years[1])) continue;
    // Only a badge if the source is a different family than the make.
    if (makesSameFamily(rule.source, mk)) continue;
    return {
      build_source_make: rule.source, confidence: 0.95, source: "badge_map",
      is_badge_engineered: true, reason: rule.note,
    };
  }

  // 2. engine_manufacturer → marque, different family than make.
  const emfrMarque = normalizeManufacturer(input.engine_manufacturer);
  if (emfrMarque && !makesSameFamily(emfrMarque, mk)) {
    return {
      build_source_make: emfrMarque, confidence: 0.75, source: "engine_mfr",
      is_badge_engineered: true,
      reason: `engine built by ${emfrMarque} (make is ${mkl}) — third-party powertrain`,
    };
  }

  return none;
}

export interface ScrapeRedirect {
  /** Builder make + model to scrape parts against instead of the badge. */
  make: string;
  model: string;
  note: string;
}

/**
 * P2.5: for a known badge-engineered vehicle, return the BUILDER's make+model
 * so the PARTS scrape reads the builder's catalog (the Mazda2), not the badge's
 * (the Yaris). Only the curated BADGE_MAP entries with a source_make/source_model
 * redirect — a bare engine-supplier difference does NOT (a Cummins RAM is still
 * a RAM in the parts catalog). Returns null when there's nothing to redirect.
 */
export function resolveScrapeRedirect(input: {
  make: string | null;
  model: string | null;
  model_year: number | null;
}): ScrapeRedirect | null {
  const mk = input.make?.trim().toLowerCase();
  if (!mk) return null;
  const model = normModel(input.model);
  for (const rule of BADGE_MAP) {
    if (rule.make !== mk) continue;
    if (normModel(rule.model) !== model) continue;
    if (rule.years && input.model_year != null &&
        (input.model_year < rule.years[0] || input.model_year > rule.years[1])) continue;
    if (!rule.source_make || !rule.source_model) continue;
    return { make: rule.source_make, model: rule.source_model, note: rule.note };
  }
  return null;
}
