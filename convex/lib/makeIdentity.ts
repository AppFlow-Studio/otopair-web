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

/** partFitsConfigMake + the duplicate-makes-row escape. */
export function partFitsConfigMakeNamed(
  partMakeId: Id<"makes"> | null | undefined,
  configMakeId: Id<"makes"> | null | undefined,
  partMakeName: string | null | undefined,
  configMakeName: string | null | undefined,
): boolean {
  if (partFitsConfigMake(partMakeId, configMakeId)) return true;
  return sameMakeName(partMakeName, configMakeName);
}

/** passesI1ReadGuard + the duplicate-makes-row escape. The brand-signature
 *  backstop still applies on the escape path — a same-make-named part with a
 *  foreign-format number stays dropped. */
export function passesI1ReadGuardNamed(
  input: I1GuardInput & { partMakeName?: string | null },
): boolean {
  if (passesI1ReadGuard(input)) return true;
  if (input.mechanicVerified === true) return true;
  if (!sameMakeName(input.partMakeName, input.configMakeName)) return false;
  // Re-apply the signature backstop that passesI1ReadGuard would have run had
  // the id check passed — the escape must not be LOOSER than the main path.
  return (
    passesI1ReadGuard({
      ...input,
      // Same-make by name: neutralize the id mismatch and let the rest of the
      // guard (foreign brand signature) decide.
      partMakeId: input.configMakeId,
    })
  );
}
