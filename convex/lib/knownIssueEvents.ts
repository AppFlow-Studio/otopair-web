/**
 * convex/lib/knownIssueEvents.ts — provenance logging for
 * `vehicle_owners.knownIssues`.
 *
 * `knownIssues` itself stays a flat `string[]` — every reader across both
 * repos (scoring, the pipeline, Oto, the mechanic merge) keeps working
 * unchanged. This is purely additive: every existing write site already
 * computes a "before" and "after" array before patching; calling
 * `logKnownIssueEvents` alongside that patch diffs the two and inserts one
 * `known_issue_events` row per code added or cleared, so "who and when" is
 * recoverable without touching a single read call site.
 *
 * Call this from every mutation that patches `knownIssues` — checkin.ts,
 * vehicleTruth.ts, bookings.ts's runCompletionSideEffects, and the mechanic
 * deferred job — so the log covers all four sources uniformly, not just the
 * ones that happen to have another durable record lying around (the
 * mechanic path also writes to `vehicle_inspections.zones`, which this
 * duplicates for that one source — deliberate, so "show this vehicle's
 * warning-light history" is one consistent query regardless of source,
 * rather than a different lookup per source).
 */

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export type KnownIssueSource =
  | "check_in"
  | "oto"
  | "mechanic_inspection"
  | "service_completion";

export async function logKnownIssueEvents(
  ctx: MutationCtx,
  args: {
    vehicleOwnerId: Id<"vehicle_owners">;
    before: readonly string[];
    after: readonly string[];
    source: KnownIssueSource;
    /** Free-form pointer: a checkin id, a shop name, a booking id. */
    sourceDetail?: string;
    now: number;
  },
): Promise<void> {
  const beforeSet = new Set(args.before);
  const afterSet = new Set(args.after);
  const added = args.after.filter((code) => !beforeSet.has(code));
  const cleared = args.before.filter((code) => !afterSet.has(code));

  for (const code of added) {
    await ctx.db.insert("known_issue_events", {
      vehicle_owner_id: args.vehicleOwnerId,
      code,
      action: "added",
      source: args.source,
      source_detail: args.sourceDetail,
      created_at: args.now,
    });
  }
  for (const code of cleared) {
    await ctx.db.insert("known_issue_events", {
      vehicle_owner_id: args.vehicleOwnerId,
      code,
      action: "cleared",
      source: args.source,
      source_detail: args.sourceDetail,
      created_at: args.now,
    });
  }
}
