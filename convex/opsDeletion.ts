// =============================================================================
// Ops · Deletion Queue backend (Ops spec §5.3). Compliance surface over
// users.by_isPendingDeletion — the index bounds every read (pending
// deletions are a handful of rows), and the per-user open-booking check
// uses bookings.by_user_id, also bounded per user.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";
import { capturedTotalForUser } from "./opsUsers";
import { resolveVehicleDisplay } from "./lib/bookingEnrichment";

/** Booking statuses that count as terminal — anything else blocks deletion
 *  processing (spec §5.3 "open bookings blocker"). Measured live set:
 *  pending, pending_quote, quotes_ready, vehicle_at_shop, completed,
 *  cancelled, no_show. */
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "no_show"]);

const DAY = 24 * 60 * 60 * 1000;
// The compliance grace window before cleanup.ts permanently deletes the account.
const GRACE_DAYS = 30;

/** Every user with isPendingDeletion = true, oldest request first, with the
 *  survey response and an open-bookings blocker count per row. */
export const listPendingDeletions = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);

    const pending = await ctx.db
      .query("users")
      .withIndex("by_isPendingDeletion", (q) => q.eq("isPendingDeletion", true))
      .collect();

    const now = Date.now();
    const rows = await Promise.all(
      pending.map(async (u) => {
        const [bookings, owners, spend] = await Promise.all([
          ctx.db
            .query("bookings")
            .withIndex("by_user_id", (q) => q.eq("user_id", u._id))
            .collect(),
          ctx.db
            .query("vehicle_owners")
            .withIndex("by_user_status", (q) => q.eq("user_id", u._id).eq("status", "active"))
            .collect(),
          capturedTotalForUser(ctx, u._id),
        ]);
        const openBookings = bookings.filter((b) => !TERMINAL_STATUSES.has(b.status)).length;
        const name =
          [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.email || "—";
        const primaryOwner = owners.find((o) => o.is_primary) ?? owners[0] ?? null;
        const primaryVehicle = primaryOwner
          ? (await resolveVehicleDisplay(ctx, primaryOwner.vin)).ymm
          : null;
        const requestedAt = u.deletionRequestedAt ?? null;
        const ageDays =
          requestedAt != null ? Math.floor((now - requestedAt) / DAY) : null;
        return {
          id: String(u._id),
          name,
          email: u.email ?? null,
          phone: u.phone ?? null,
          requested_at: requestedAt,
          survey_response: u.deletionSurveyResponse ?? null,
          survey_skipped: u.deletionSurveySkipped === true,
          open_bookings: openBookings,
          bookings_total: bookings.length,
          // Enrichment: who this is, what they're worth, when the clock runs out.
          vehicles: owners.length,
          primaryVehicle,
          spend,
          authProvider: u.auth_provider ?? null,
          createdAt: u.createdAt ?? u._creationTime,
          lastActive: u.lastUpdated ?? null,
          graceRemainingDays: ageDays != null ? Math.max(0, GRACE_DAYS - ageDays) : null,
        };
      }),
    );

    // Oldest request first; rows without a timestamp sink to the bottom.
    rows.sort((a, b) => (a.requested_at ?? Infinity) - (b.requested_at ?? Infinity));
    return rows;
  },
});

/** RESTORE — take the user out of the deletion queue. users.write; writes
 *  the audit row atomically with the patch. */
export const restoreUser = mutation({
  args: { token: v.string(), reason: v.string(), userId: v.id("users") },
  handler: async (ctx, { token, reason, userId }) => {
    const actor = await requireDirector(ctx, token, "users.write");
    if (reason.trim().length < 4) {
      throw new Error("A reason is required (at least a few words).");
    }

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found.");
    if (user.isPendingDeletion !== true) {
      throw new Error("This user is not pending deletion — nothing to restore.");
    }

    await ctx.db.patch(userId, {
      isPendingDeletion: false,
      deletionRequestedAt: undefined,
    });

    await logAudit(ctx, actor, {
      entity_type: "user",
      entity_id: String(userId),
      action: "deletion_restore",
      detail: `Restored from deletion queue — ${reason.trim()}`,
    });

    return { ok: true };
  },
});
