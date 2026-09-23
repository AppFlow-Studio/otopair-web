/**
 * lib/ymmTrims.ts — resolve the trim list for a year/make/model from the
 * premium Car API + MarketCheck facets. Replaces the old client-side VDB
 * `ymm-specs/options/v3/trim` lookup the mobile "add vehicle" flow used.
 *
 * Two shapes of "model" reach us:
 *   - A real Car API catalog model ("CR-V", "Camry", "F-150") → we list its
 *     /trims/v2 trims (EX, XLE, Lariat…).
 *   - A FAMILY name that Car API files by variant ("GLE-Class", "C-Class",
 *     "3 Series") → resolveModel returns null. Car API catalogs these as
 *     separate models (Mercedes GLE → GLE 350 / 450 / 53 AMG / 580 / 63 AMG S),
 *     so we expand the family into those variant names — they ARE the
 *     meaningful, differentiated choices. Without this the picker showed a
 *     single model's near-identical rows (the "4× AMG GLE 63 S" bug).
 *
 * Car API is NOT year-gated on the paid plan. Vehicle IMAGES stay on VDB (see
 * utils/vehicleImage.ts) — this module never touches VDB.
 */

import {
  carApiModelsForMakeYear,
  carApiYmmtCatalog,
  modelNamesMatch,
} from "./carApi";
import { marketCheckTrimFacets } from "./marketCheck";

/** Case/separator-insensitive key for matching + dedup. */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[\s\-_/]+/g, " ").trim();
}

/** Tight key (no separators) for model-name matching. */
function tightKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Family token for a family-style model name: drop a trailing "-Class"/
 * "Series" and take the leading letters (or a leading number for BMW-style
 * "3 Series"). "GLE-Class" → "gle", "C-Class" → "c", "3 Series" → "3".
 */
function deriveFamilyToken(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/[-\s]*class\b.*$/, "").replace(/\s*series\b.*$/, "").trim();
  const alpha = m.match(/^[a-z]+/);
  if (alpha?.[0]) return alpha[0];
  const num = m.match(/^\d+/);
  return num?.[0] ?? "";
}

/**
 * True when a Car API model name is a variant of the family: the family token
 * immediately followed by the variant number. "gle" → "GLE350", "GLE63 AMG S";
 * "3" → "330i". Excludes "GLA250" (family "gle") and "SL55" (family "s").
 */
function matchesFamily(modelName: string, familyToken: string): boolean {
  if (!familyToken) return false;
  // A leading "AMG" is a sub-brand, not part of the family name. Car API files
  // these as "AMG GLE 63 S", which flattens to `amggle63s` and fails a
  // `^gle\d` test — so every AMG variant used to drop out of the expansion.
  // That did not show while GLE wrongly resolved to E-Class and never reached
  // this path; now that it does, the AMG trims have to come with it.
  const key = tightKey(modelName).replace(/^amg/, "");
  if (new RegExp(`^${familyToken}\\d`).test(key)) return true;
  // BMW numeric families also own their M lines: family "5" → "M5",
  // "M5 Touring", "M550i xDrive"; family "3" → "M3", "M340i". Without this
  // the 5 Series expansion was 530i…550e only, so an M5 VIN could never find
  // its own trim and defaulted to "530i". Anchored on the family number, so
  // family "5" never takes "M8".
  return (
    /^\d+$/.test(familyToken) &&
    new RegExp(`^m${familyToken}(?:\\d|[a-z]|$)`).test(key)
  );
}

/** "GLE350" → "GLE 350", "GLE63 AMG S" → "GLE 63 AMG S". */
function prettifyVariant(name: string): string {
  // BMW M designations are written tight ("M5", "M340i"), never "M 5".
  if (/^M\d/.test(name.trim())) return name.trim();
  return name.replace(/^([A-Za-z]+)(\d)/, "$1 $2").trim();
}

/**
 * Strip Car API's body/door/drivetrain descriptors off a plain trim so the
 * picker shows a bare token. "EX 4dr SUV AWD" → "EX", "Sport 2dr Coupe" →
 * "Sport". Conservative — multi-word trims ("Black Label") survive.
 */
function cleanTrimToken(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // A label that is ONLY body/doors ("2dr", "4dr Sedan", "Coupe") names no
  // trim — Car API files a model's single base row that way.
  if (/^\d+\s*-?\s*(?:dr|door)s?\b/i.test(s)) return "";
  if (/^(?:sedan|coupe|hatchback|wagon|suv|convertible|roadster)\b/i.test(s)) return "";
  s = s.replace(/\s+\d+\s*-?\s*(?:dr|door)s?\b.*$/i, "");
  s = s.replace(
    /\s+\b(?:sedan|coupe|hatchback|wagon|suv|truck|van|minivan|convertible|roadster|cab|pickup|crew|awd|fwd|rwd|4wd|4x4|2wd)\b.*$/i,
    "",
  );
  return s.trim();
}

/** Dedupe by normalized key, preserving first-seen casing. */
function dedupeByNorm(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const t = (raw ?? "").trim();
    if (!t) continue;
    const k = normKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Fetch + merge + normalize the trim list for a YMM. Never throws — each
 * provider is best-effort. Returns an alphabetically-sorted, deduped list of
 * clean trim/variant tokens (may be empty → UI falls back to free-text entry).
 */
/** Letter/digit-split tokens: "AMG GT63" → ["amg", "gt", "63"]. */
function variantTokens(s: string): string[] {
  return (
    String(s ?? "")
      .toLowerCase()
      .match(/[a-z]+|\d+/g) ?? []
  );
}

export async function fetchYmmTrimsFromProviders(args: {
  year: number;
  make: string;
  model: string;
  /** The VIN-decoded trim ("AMG GT63"). Pulls in sibling catalog models the
   *  trim points at — see the extension-sibling block below. */
  decodedTrim?: string;
}): Promise<string[]> {
  const year = args.year;
  const make = (args.make ?? "").trim();
  const model = (args.model ?? "").trim();
  if (!year || !make || !model) return [];

  const [mcRes, carApiModels] = await Promise.all([
    marketCheckTrimFacets({ year, make, model }).catch(() => null),
    carApiModelsForMakeYear(make, year).catch(() => [] as string[]),
  ]);

  // Facets are free text straight from dealer listings ("2dr", "EX 4dr
  // SUV AWD") — clean them the same way as Car API rows.
  const mcTrims = Array.isArray(mcRes?.trims)
    ? mcRes!.trims.map((t) => cleanTrimToken(t?.item ?? "")).filter(Boolean)
    : [];

  // Does the requested model map to a real Car API catalog model? (Same
  // exact-then-substring match as carApiResolveModel, run against the list we
  // already fetched to avoid a second /models call.)
  const target = tightKey(model);
  const resolved =
    carApiModels.find((m) => tightKey(m) === target) ??
    // Token-boundary match, not a raw substring one — see modelNamesMatch.
    // `"gleclass".includes("eclass")` was true, so a GLE resolved to E-Class
    // and the trim picker offered E 450s.
    carApiModels.find((m) => modelNamesMatch(m, model)) ??
    null;

  let carApiTrims: string[];
  if (!resolved) {
    // Family name → expand into the sibling variant models.
    const familyToken = deriveFamilyToken(model);
    carApiTrims = carApiModels
      .filter((m) => matchesFamily(m, familyToken))
      .map(prettifyVariant);
  } else {
    const cat = await carApiYmmtCatalog({ year, make, model: resolved }).catch(
      () => null,
    );
    const rows: any[] = Array.isArray(cat?.trims?.data) ? cat!.trims.data : [];
    carApiTrims = rows
      .map((r) => {
        const name = cleanTrimToken(String(r?.name ?? ""));
        if (name) return name;
        const fromDesc = cleanTrimToken(
          String(r?.description ?? r?.trim ?? r?.submodel ?? ""),
        );
        // A row that is only "2dr Coupe" is the model's base car — name it
        // by the model ("AMG GT") instead of dropping it.
        return fromDesc || resolved;
      })
      .filter((s) => s.length > 0);

    // Extension siblings: Car API files the 2021 AMG GT 4-door as separate
    // models ("AMG GT 63", "AMG GT 63 S") beside the 2-door "AMG GT", whose
    // only trim row is "2dr Coupe" — so a GT 63 VIN was offered just "2dr".
    // Add the sibling models whose extra tokens the decoded trim names.
    const resolvedTokens = new Set(variantTokens(resolved));
    const hintTokens = new Set(
      variantTokens(args.decodedTrim ?? "").filter((t) => !resolvedTokens.has(t)),
    );
    if (hintTokens.size > 0) {
      const resolvedKey = tightKey(resolved);
      for (const m of carApiModels) {
        const key = tightKey(m);
        if (key === resolvedKey || !key.startsWith(resolvedKey)) continue;
        const extra = variantTokens(m).filter((t) => !resolvedTokens.has(t));
        if (extra.some((t) => hintTokens.has(t))) carApiTrims.push(m);
      }
    }
  }

  return dedupeByNorm([...mcTrims, ...carApiTrims]).sort((a, b) =>
    a.localeCompare(b),
  );
}
