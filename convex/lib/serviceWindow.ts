/**
 * serviceWindow.ts — "Within recommended window" check used by the
 * Health Points bonus (+5 HP when a user completes a service before
 * it goes overdue).
 *
 * For each service on the booking, we look up the per-vehicle service
 * state's `due_at_date`. If the booking completed before that
 * timestamp for every service it touched, the user is within window
 * and earns the bonus.
 *
 * When the maintenance pipeline hasn't computed a `due_at_date` yet
 * (first-time service on a fresh vehicle, or the service has no
 * interval data), we give the benefit of the doubt and treat it as
 * within window. This matches the framework's intent: reward the
 * proactive owner.
 */

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export async function isWithinRecommendedWindow(
  ctx: QueryCtx | MutationCtx,
  booking: Doc<"bookings">,
): Promise<boolean> {
  const serviceIds: Id<"services">[] = booking.service_ids ?? [];
  if (serviceIds.length === 0) return true;

  const owner = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q) =>
      q.eq("vin", booking.vin).eq("user_id", booking.user_id),
    )
    .unique();
  if (!owner) return true;

  const now = Date.now();

  for (const serviceId of serviceIds) {
    const state = await ctx.db
      .query("vehicle_service_states")
      .withIndex("by_vehicle_service", (q) =>
        q.eq("vehicle_owner_id", owner._id).eq("service_id", serviceId),
      )
      .unique();
    // No state at all (e.g. pipeline hasn't run yet) → benefit of doubt.
    if (!state?.due_at_date) continue;
    // Overdue on this service → forfeit the bonus for the whole booking.
    if (now > state.due_at_date) return false;
  }

  return true;
}
