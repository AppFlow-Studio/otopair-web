/**
 * convex/lib/warningLightsMerge.ts — the single, shared rule for turning a
 * mechanic's inspection warning-light picker (plus any post-job "still on?"
 * clears) into the next `vehicle_owners.knownIssues` array.
 *
 * Extracted so TWO callers can never drift apart:
 *   • convex/inspectionHealthDeferred.ts — the real write, 2 hours after the
 *     booking closes.
 *   • convex/job_actuals.ts getPrefillData — the *projection* shown in the
 *     post-job survey's "still on?" list. The pre-job picker's selections
 *     don't reach knownIssues until the deferred job runs, so without
 *     projecting them here a light this very inspection just flagged would
 *     be missing from the list and therefore impossible for the mechanic to
 *     clear — exactly the TPMS-topped-up-mid-visit case this feature exists
 *     to handle.
 *
 * Pure: no ctx, no db. See "Dashboard warning lights."
 */

import {
  toCanonicalLight,
  type CanonicalWarningLight,
} from "../../lib/warningLightVocab";
import {
  WARNING_LIGHT_CLEAR_SET,
  type WarningLightEntry,
} from "../../lib/inspection-template";

/** Apply the pre-job picker's answer to an existing knownIssues array.
 *  "None" as the sole entry clears every canonical light (the full 9, not
 *  check-in's narrower 7 — a mechanic's deliberate visual check is
 *  authoritative); any real selection merges on top, never removing a light
 *  the mechanic didn't ask about. An unanswered picker is a no-op. */
export function applyInspectionLightPicker(
  knownIssues: readonly string[],
  entries: readonly WarningLightEntry[] | undefined,
): string[] {
  const answered = (entries ?? []).filter((e) => !!e.light);
  if (answered.length === 0) return [...knownIssues];

  const isNoneOnly = answered.length === 1 && answered[0].light === "none";
  if (isNoneOnly) {
    return knownIssues.filter(
      (code) =>
        !WARNING_LIGHT_CLEAR_SET.includes(
          toCanonicalLight(code) as CanonicalWarningLight,
        ),
    );
  }

  const merged = new Set(knownIssues);
  for (const entry of answered) {
    if (entry.light === "none") continue;
    // "Other" carries the mechanic's own free text on the inspection record;
    // for scoring it folds to the existing unidentified-light bucket.
    merged.add(entry.light === "other" ? "not_sure_which" : entry.light);
  }
  return [...merged];
}

/** Remove the lights a mechanic confirmed are no longer lit at post-job.
 *  Compared canonically so a light stored in any vocabulary/alias still
 *  clears. */
export function applyPostjobLightClears(
  knownIssues: readonly string[],
  clearedLights: readonly string[] | undefined,
): string[] {
  if (!clearedLights?.length) return [...knownIssues];
  const cleared = new Set(
    clearedLights
      .map((code) => toCanonicalLight(code))
      .filter((code): code is CanonicalWarningLight => !!code),
  );
  return knownIssues.filter(
    (code) => !cleared.has(toCanonicalLight(code) as CanonicalWarningLight),
  );
}

/** Full resolution: pre-job picker first, then post-job clears on top, so a
 *  light added and resolved in the same visit nets out to nothing. */
export function resolveKnownIssues(input: {
  knownIssues: readonly string[];
  pickerEntries?: readonly WarningLightEntry[];
  clearedLights?: readonly string[];
}): string[] {
  return applyPostjobLightClears(
    applyInspectionLightPicker(input.knownIssues, input.pickerEntries),
    input.clearedLights,
  );
}

/** True when the two arrays differ (order-insensitive), so callers only
 *  write when something actually changed. */
export function knownIssuesChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  if (before.length !== after.length) return true;
  const beforeSet = new Set(before);
  return after.some((code) => !beforeSet.has(code));
}
