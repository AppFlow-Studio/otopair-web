/**
 * jobRecommendations.ts — Structured post-job recommendations.
 *
 * Replaces the free-text `additional_observations` capture with per-row
 * lifecycle records. Created from the post-job survey; confirmed/dismissed
 * from the next pre-job survey for the same VIN; auto-expired after 12mo.
 */

import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { jobRecommendationInputValidator } from "./lib/vehicle_passports";

function normalizeServiceName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser?.is_active) return shopUser;

  const owned = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (owned) return { user_id: userId, shop_id: shopId, role: "owner" };

  throw new Error("Not authorized for this shop");
}

/**
 * Called from within completeWithPostjob (same transaction) to persist
 * a batch of recommendations against the freshly-created job_actual.
 * Auth is already enforced by the calling mutation.
 */
export async function submitRecommendationsForBooking(
  ctx: any,
  args: {
    booking: {
      _id: Id<"bookings">;
      shop_id?: Id<"shops">;
      mechanic_id?: Id<"mechanics">;
      vin: string;
    };
    jobActualId: Id<"job_actuals">;
    mechanicId: Id<"mechanics">;
    recommendations: Array<{
      recommended_service_id?: Id<"services"> | null;
      freeform_service_name?: string | null;
      urgency: "next_visit" | "within_3_months" | "soon";
      reason?: string | null;
      visible_to_driver: boolean;
    }>;
    now: number;
  },
) {
  const { booking, jobActualId, mechanicId, recommendations, now } = args;
  if (!booking.shop_id) {
    throw new Error("Cannot record recommendations before a shop is assigned.");
  }
  if (recommendations.length === 0) return [];

  const insertedIds: Id<"job_recommendations">[] = [];
  for (const rec of recommendations) {
    const hasService = !!rec.recommended_service_id;
    const freeform = (rec.freeform_service_name ?? "").trim();
    if (!hasService && freeform.length === 0) continue;

    let pendingId: Id<"pending_service_submissions"> | undefined;
    let freeformText: string | undefined;
    if (!hasService) {
      const normalized = normalizeServiceName(freeform);
      const existing = await ctx.db
        .query("pending_service_submissions")
        .withIndex("by_normalized_name", (q: any) =>
          q.eq("normalized_name", normalized),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          appearance_count: (existing.appearance_count ?? 0) + 1,
          last_seen_at: now,
        });
        pendingId = existing._id;
      } else {
        pendingId = await ctx.db.insert("pending_service_submissions", {
          proposed_name: freeform,
          normalized_name: normalized,
          proposed_reason: rec.reason?.trim() || undefined,
          submitted_by_mechanic_id: mechanicId,
          submitted_via_booking_id: booking._id,
          vehicle_vin: booking.vin,
          appearance_count: 1,
          status: "pending",
          created_at: now,
          last_seen_at: now,
        });
      }
      freeformText = freeform;
    }

    const id = await ctx.db.insert("job_recommendations", {
      booking_id: booking._id,
      job_actual_id: jobActualId,
      shop_id: booking.shop_id,
      mechanic_id: mechanicId,
      vehicle_vin: booking.vin,
      recommended_service_id: rec.recommended_service_id ?? undefined,
      pending_service_submission_id: pendingId,
      freeform_text: freeformText,
      urgency: rec.urgency,
      reason: rec.reason?.trim() || undefined,
      visible_to_driver: rec.visible_to_driver,
      status: "open",
      created_at: now,
    });
    insertedIds.push(id);
  }
  return insertedIds;
}

/**
 * Open recommendations for a VIN — used by the pre-job survey to surface
 * "did you do this?" prompts at the start of the next visit. Shop-scoped so
 * one shop doesn't see another shop's recs for the same vehicle.
 */
export const getOpenForVehicle = query({
  args: {
    vin: v.string(),
    shopId: v.optional(v.id("shops")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("job_recommendations")
      .withIndex("by_vehicle_and_status", (q) =>
        q.eq("vehicle_vin", args.vin).eq("status", "open"),
      )
      .collect();
    const filtered = args.shopId
      ? rows.filter((r) => String(r.shop_id) === String(args.shopId))
      : rows;
    filtered.sort((a, b) => b.created_at - a.created_at);
    const limited = filtered.slice(0, args.limit ?? 10);
    return await Promise.all(
      limited.map(async (rec) => {
        const service = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        return {
          _id: rec._id,
          service_name: service?.name ?? rec.freeform_text ?? "Unspecified",
          is_freeform: !rec.recommended_service_id,
          urgency: rec.urgency,
          reason: rec.reason ?? null,
          created_at: rec.created_at,
        };
      }),
    );
  },
});

/**
 * Mark an open rec as completed or dismissed from the pre-job survey.
 * Batched on Continue, not per-tap, to avoid mid-dialog network churn.
 */
export const confirmFromPreJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    confirmations: v.array(
      v.object({
        recommendation_id: v.id("job_recommendations"),
        outcome: v.union(v.literal("completed"), v.literal("dismissed")),
        dismissed_reason: v.optional(
          v.union(
            v.literal("fixed"),
            v.literal("not_needed"),
            v.literal("mistake"),
          ),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();
    for (const c of args.confirmations) {
      const rec = await ctx.db.get(c.recommendation_id);
      if (!rec || rec.status !== "open") continue;
      // Shop-scope guard — only the same shop can close a rec.
      if (String(rec.shop_id) !== String(booking.shop_id)) continue;
      if (c.outcome === "completed") {
        await ctx.db.patch(rec._id, {
          status: "completed",
          completed_via_booking_id: booking._id,
          updated_at: now,
        });
      } else {
        await ctx.db.patch(rec._id, {
          status: "dismissed",
          dismissed_reason: c.dismissed_reason ?? "not_needed",
          updated_at: now,
        });
      }
    }
    return { ok: true };
  },
});

/**
 * Daily cron — flip any "open" recommendation older than 12 months to
 * "expired". Capped per run so a backlog doesn't blow past mutation limits.
 */
export const expireOlderThan12Months = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - 365 * 24 * 60 * 60 * 1000;
    const open = await ctx.db
      .query("job_recommendations")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(500);
    let expired = 0;
    for (const rec of open) {
      if (rec.created_at >= cutoff) continue;
      await ctx.db.patch(rec._id, { status: "expired", updated_at: now });
      expired += 1;
    }
    if (expired > 0) {
      console.log(`[Cron] Expired ${expired} stale recommendation(s)`);
    }
    return { expired };
  },
});

// Re-export validator for callers that pass recommendation arrays through
// existing mutation arg schemas (e.g., completeWithPostjob).
export { jobRecommendationInputValidator };
