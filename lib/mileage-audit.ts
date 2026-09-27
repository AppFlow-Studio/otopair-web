// Shared mileage-audit thresholds + classifier. Pure module (no Convex / React
// deps, same as lib/vehicle-passport.ts) so the client dialogs and the Convex
// functions share ONE source of truth for when an odometer reading is anomalous
// enough to prompt a confirm. Paired with the `mileage_change_events` audit
// table + convex/lib/mileageChangeEvents.ts (logMileageChange).
//
// Policy (confirmed with product): a new reading NEVER hard-blocks. It prompts a
// confirm when it is lower than the last-recorded ("intake") value, or more than
// MILEAGE_FAR_JUMP_MI above it. Otherwise it saves silently.

/** Upward jump (mi) vs. the last-recorded reading beyond which a new reading is
 *  treated as suspicious and prompts a confirm. Any decrease always prompts. */
export const MILEAGE_FAR_JUMP_MI = 5000;

export type MileageChangeReason = "normal" | "decrease" | "far_jump";

/** Classify a new reading against the last-recorded (intake) value. Returns
 *  "normal" when there is no prior value to compare against, or when either
 *  number isn't finite (nothing to warn about). */
export function classifyMileageChange(
  before: number | null | undefined,
  after: number,
): MileageChangeReason {
  if (typeof before !== "number" || !Number.isFinite(before)) return "normal";
  if (!Number.isFinite(after)) return "normal";
  if (after < before) return "decrease";
  if (after - before > MILEAGE_FAR_JUMP_MI) return "far_jump";
  return "normal";
}

/** True when a new reading is anomalous enough to warrant a confirm — never a
 *  hard block. */
export function isMileageConfirmRequired(
  before: number | null | undefined,
  after: number,
): boolean {
  return classifyMileageChange(before, after) !== "normal";
}

/** Human copy for the soft-confirm dialog. Returns null for "normal" (no
 *  confirm needed) so callers can `const copy = mileageConfirmCopy(...); if
 *  (!copy) proceed()`. */
export function mileageConfirmCopy(
  before: number,
  after: number,
  reason: MileageChangeReason = classifyMileageChange(before, after),
): { title: string; body: string } | null {
  const b = Math.round(before).toLocaleString("en-US");
  const a = Math.round(after).toLocaleString("en-US");
  if (reason === "decrease") {
    return {
      title: "Odometer is lower than before",
      body: `${a} mi is below the last recorded ${b} mi. Odometers don't normally run backward — double-check the reading. Save it anyway if it's correct.`,
    };
  }
  if (reason === "far_jump") {
    return {
      title: "That's a big jump",
      body: `${a} mi is more than ${MILEAGE_FAR_JUMP_MI.toLocaleString(
        "en-US",
      )} mi above the last recorded ${b} mi. Double-check the reading, then save it if it's correct.`,
    };
  }
  return null;
}
