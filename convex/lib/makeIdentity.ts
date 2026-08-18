/**
 * lib/makeIdentity.ts — name-aware wrappers over the I1 make guard (Aug 2026).
 *
 * The makes table holds case-variant duplicate rows of the same make
 * ("Mercedes-Benz" AND "MERCEDES-BENZ"), so the strict id-equality guard in
 * partSelector.partFitsConfigMake rejects a part stamped under one row when
 * the config is keyed to the other — the C43's fitted, priced,
 * quotability-counted battery showed as "no part on file" in the gaps list,
 * and booking-time reads dropped it the same way.
 *
 * These wrappers add ONE escape: when both make NAMES are available and
 * normalize to the same make key, the two ids are one make wearing different
 * rows and the part fits. Deliberately NOT family-aware — the I1 product
 * decision (an Audi-stamped part stays off a VW config unless a mechanic
 * verified it) is untouched; this bridges duplicate rows of a single make
 * only. Kept OUT of partSelector.ts so that module's pure selector surface
 * stays as-is; callers that cannot cheaply supply names keep strict behavior
 * by using the originals.
 *
 * The durable cleanup HAS landed (Aug 2026): makesMerge.ts dedupes existing
 * rows and lib/makeKey.getOrCreateMake prevents new duplicates at insert
 * time. These wrappers stay as defense-in-depth — a deployment that hasn't
 * run the merge yet, or a row minted by code predating the guard, still
 * resolves correctly on the read path.
 */
import type { Id } from "../_generated/dataModel";
import {
  partFitsConfigMake,
  passesI1ReadGuard,
  type I1GuardInput,
} from "../partSelector";
import { makeKeyOf } from "./makeKey";
import { makesSameFamily } from "../vehicleEnrichment/contentSanitization";

/** Case/hyphen/space-insensitive make-name identity ("MERCEDES-BENZ" ≡
 *  "Mercedes-Benz") — same makeKeyOf the write-side guard and the
 *  corporate-family map use. */
export function sameMakeName(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return makeKeyOf(a) === makeKeyOf(b);
}

/**
 * CORPORATE-FAMILY READ ESCAPE (operator decision, Aug 11 2026).
 *
 * The strict same-make read guard was hiding parts we had correctly found,
 * verified and priced. Measured on third-bird-914: the Buick Enclave read
 * `complete · quotability 1.00 · 0 missing roles` while the booking-facing
 * gaps query reported 3 missing parts — its coolant, ATF and battery were
 * stamped with a SIBLING GM make because GM sells Chevrolet/GMC/Cadillac/
 * Buick out of one storefront (`g.oempartsonline.com`). Same story in five
 * more families: Mopar (Pacifica 7/26 fitments), Nissan (QX60 4/16, its
 * engine oil among them), Ford (Nautilus 3/5), Honda (RDX 2/15).
 *
 * These are not contamination. A 5Q0-prefix MQB part genuinely fits a VW and
 * an Audi; Mopar numbers genuinely span Jeep/Ram/Chrysler. The write-side
 * guards and the quarantine backfill have ALWAYS treated same-family as
 * compatible (`makesSameFamily`); only the read path disagreed, so the
 * pipeline stored parts the booking flow then refused to show.
 *
 * What does NOT change: a genuinely foreign part stays blocked. The escape
 * re-runs the full guard with the id mismatch neutralized, so the
 * foreign-brand-signature backstop still fires — a Motorcraft `BXT-94RH7-730`
 * on an Alfa Romeo is refused by family membership AND by signature.
 *
 * Reversible: PARTS_I1_FAMILY_READ=off restores strict same-make behaviour.
 */
function familyReadEnabled(): boolean {
  return process.env.PARTS_I1_FAMILY_READ !== "off";
}

/** Same make, or the same corporate part-sharing family when the family read
 *  escape is enabled. */
function makeCompatibleByName(
  partMakeName: string | null | undefined,
  configMakeName: string | null | undefined,
): boolean {
  if (sameMakeName(partMakeName, configMakeName)) return true;
  return familyReadEnabled() && makesSameFamily(partMakeName, configMakeName);
}

/** partFitsConfigMake + the duplicate-makes-row and corporate-family escapes. */
export function partFitsConfigMakeNamed(
  partMakeId: Id<"makes"> | null | undefined,
  configMakeId: Id<"makes"> | null | undefined,
  partMakeName: string | null | undefined,
  configMakeName: string | null | undefined,
): boolean {
  if (partFitsConfigMake(partMakeId, configMakeId)) return true;
  return makeCompatibleByName(partMakeName, configMakeName);
}

/** passesI1ReadGuard + the duplicate-makes-row and corporate-family escapes.
 *  The brand-signature backstop still applies on BOTH escape paths — a
 *  compatible-by-name part carrying a foreign-format number stays dropped. */
export function passesI1ReadGuardNamed(
  input: I1GuardInput & { partMakeName?: string | null },
): boolean {
  if (passesI1ReadGuard(input)) return true;
  if (input.mechanicVerified === true) return true;
  if (!makeCompatibleByName(input.partMakeName, input.configMakeName)) return false;
  // Re-apply the signature backstop that passesI1ReadGuard would have run had
  // the id check passed — the escape must not be LOOSER than the main path.
  return (
    passesI1ReadGuard({
      ...input,
      // Compatible by name (same make, or same corporate family): neutralize
      // the id mismatch and let the rest of the guard (foreign brand
      // signature) decide.
      partMakeId: input.configMakeId,
    })
  );
}
