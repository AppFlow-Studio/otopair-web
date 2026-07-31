/**
 * vehicleEnrichment/fluidBrandConsistency.ts — flag a fluid whose SPEC names a
 * different vehicle marque than the vehicle's make (badge-engineering / a
 * third-party powertrain), so the orderable OEM fluid PART can be brand-checked.
 *
 * Batch-8 (Jul 21 2026): a 2020 Toyota Yaris is a rebadged Mazda2. Its fluid
 * TYPE fields were right (trans_fluid_type = "Mazda ATF FZ", coolant_type =
 * "Mazda FL22") but the corresponding OEM PART rows carried Toyota part numbers
 * (00289-ATFWS = Toyota ATF WS; 00272-SLLC2 = Toyota SLLC). The type field and
 * the part are two independent LLM extractions with no cross-check, and the
 * existing brand guard validates a part against the CHASSIS make (Toyota) — a
 * genuine Toyota-format number passes even though the fluid should follow the
 * Mazda powertrain.
 *
 * The precise, low-noise signal: the fluid TYPE string literally NAMES a vehicle
 * marque ("Mazda ...") that is a different corporate family from this vehicle's
 * make ("Toyota"). Component-maker names (ZF, Aisin, Jatco) and same-family
 * marques (Lexus on a Toyota, Mopar on a Jeep) are NOT flagged. This never
 * rewrites anything (batch-8 doctrine: no autonomous fluid overwrites) — it only
 * routes the part to review.
 *
 * Pure module — no IO. Exported for tests.
 */

import { makesSameFamily } from "./contentSanitization";

/** Vehicle MARQUE names distinctive enough to key on when they appear in a
 *  fluid-spec string. Deliberately excludes short/ambiguous tokens (ram, fiat,
 *  mini), generic corporate abbreviations (gm), and component/parts-arm brands
 *  that aren't vehicle marques (zf, aisin, jatco, acdelco) — precision over
 *  recall, because the output is a review flag. Parts-arm names that ARE inside
 *  a corporate family (mopar→Chrysler, motorcraft→Ford) are kept because
 *  makesSameFamily suppresses them on their own family's vehicles. */
const CHASSIS_MARQUES: readonly string[] = [
  "toyota", "lexus", "honda", "acura", "nissan", "infiniti", "mazda", "subaru",
  "hyundai", "kia", "genesis", "mitsubishi", "suzuki",
  "ford", "lincoln", "motorcraft", "chevrolet", "cadillac", "buick",
  "chrysler", "dodge", "jeep", "mopar",
  "bmw", "mercedes", "audi", "volkswagen", "porsche", "volvo", "jaguar",
];

/**
 * If `fluidSpec` names a vehicle marque that is a DIFFERENT corporate family
 * than `makeName`, return that marque (lower-case); else null. Word-boundary
 * matched so "mini"/"ram"-style substrings never trip it (those aren't in the
 * list anyway). Same-family marques (Lexus↔Toyota, Mopar↔Jeep) return null.
 */
export function fluidNamesForeignChassisBrand(
  fluidSpec: string | null | undefined,
  makeName: string | null | undefined,
): string | null {
  if (!fluidSpec || !makeName) return null;
  const s = fluidSpec.toLowerCase();
  for (const marque of CHASSIS_MARQUES) {
    const re = new RegExp(`\\b${marque}\\b`, "i");
    if (re.test(s) && !makesSameFamily(marque, makeName)) return marque;
  }
  return null;
}

/** The fluid TYPE field → its orderable OEM PART field. A brand conflict on the
 *  type string routes the PART to review. */
export const FLUID_TYPE_TO_PART_FIELD: ReadonlyArray<readonly [string, string]> = [
  ["trans_fluid_type", "atf_fluid_oem"],
  ["coolant_type", "coolant_oem"],
  ["ps_fluid_type", "ps_fluid_oem"],
  ["diff_fluid_type", "gear_oil_oem"],
  ["brake_fluid_type", "brake_fluid_oem"],
];
