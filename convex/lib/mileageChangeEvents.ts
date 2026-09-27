/**
 * convex/lib/mileageChangeEvents.ts — audit logging for odometer CHANGES made
 * through the shop job flow (inspection → pre-job → post-job) and director
 * edits. Mirrors the logKnownIssueEvents pattern: every mileage write site
 * already knows the before/after value, so calling logMileageChange alongside
 * the passport patch records "who changed it, from what to what, at which
 * phase, and whether a flagged value was acknowledged" without touching any
 * read path.
 *
 * Two durable records per change (deliberate, like knownIssueEvents):
 *   1. mileage_change_events — structured + queryable (mileageChangeEvents.listForVin)
 *   2. audit_log — a mirrored free-text row so the change also shows in the
 *      director AuditDrawer (scoped to entity_type "vehicle_vin" / VIN).
 *
 * VIN must already be canonical (callers compute toCanonicalVin) — this module
 * does not re-normalize.
 */

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { classifyMileageChange } from "../../lib/mileage-audit";

export type MileageChangeSource =
  | "inspection"
  | "prejob"
  | "postjob"
  | "director_edit"
  | "checkin";

export async function logMileageChange(
  ctx: MutationCtx,
  args: {
    /** Canonical VIN (already normalized by the caller). */
    vin: string;
    bookingId?: Id<"bookings">;
    source: MileageChangeSource;
    before: number | null | undefined;
    after: number;
    actorUserId?: Id<"users">;
    /** Mechanic/user display name for the audit row. */
    actorName?: string;
    now: number;
  },
): Promise<void> {
  const { vin, bookingId, source, before, after, actorUserId, actorName, now } =
    args;
  // Nothing to record without a real new value, or when it didn't move.
  if (typeof after !== "number" || !Number.isFinite(after)) return;
  if (typeof before === "number" && before === after) return;

  const reason = classifyMileageChange(before, after);

  await ctx.db.insert("mileage_change_events", {
    vin,
    booking_id: bookingId,
    source,
    before_mileage: typeof before === "number" ? before : undefined,
    after_mileage: after,
    reason,
    confirmed: reason !== "normal",
    actor_user_id: actorUserId,
    actor_name: actorName,
    created_at: now,
  });

  // Mirror to audit_log so the change surfaces in the existing director
  // AuditDrawer. actor_id is a director_users id, which we don't have here, so
  // it's left undefined (optional) — the mechanic/user name lives in `actor`.
  const beforeLabel =
    typeof before === "number" ? Math.round(before).toLocaleString() : "—";
  const flag = reason !== "normal" ? ` ⚠ ${reason}` : "";
  await ctx.db.insert("audit_log", {
    entity_type: "vehicle_vin",
    entity_id: vin,
    action: "mileage_change",
    actor: actorName ?? "shop",
    detail: `${beforeLabel} → ${Math.round(after).toLocaleString()} mi (${source})${flag}`,
    created_at: now,
  });
}
