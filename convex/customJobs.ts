/**
 * customJobs.ts — the extraction spine for off-catalog work (Off-Catalog Work
 * spec, §7).
 *
 * `bookings.custom_services[]` stays as the lightweight display and scheduling
 * copy of what's on a booking. This module owns the structured record behind it:
 * one `custom_jobs` row per piece of off-catalog work, carrying the two things
 * nothing else in the schema captures — the complaint that caused the work, and
 * whether the work resolved it.
 *
 * Labor minutes, prices and parts already land in labor_quote_snapshots /
 * parts_quote_snapshots. Those tables answer "how long and how much". They
 * can't answer "why", and "why" is what turns a cluster of names into a service
 * we could actually build.
 *
 * ── INVARIANT ────────────────────────────────────────────────────────────────
 * Nothing here may influence the Vehicle Health Score. No maintenance_records
 * write, no interval reset, no rec penalty. See the CUSTOM JOB INVARIANT
 * comments in bookings.ts and jobRecommendations.ts.
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  normalizeServiceName,
  serviceMatchKey,
} from "./lib/serviceMatch";

/**
 * Bump (or open) the cross-shop dedupe ledger row for a proposed service name.
 *
 * Shared by the custom-job path and the advisory-recommendation path so both
 * feed one ledger — a name typed as work-performed and the same name typed as a
 * recommendation are the same signal about a catalog gap, and splitting them
 * across two counters would understate every cluster.
 *
 * Keyed on normalizeServiceName (NOT serviceMatchKey) because that is what
 * existing rows are keyed on. See the serviceMatch.ts header.
 */
export async function bumpPendingServiceSubmission(
  ctx: any,
  args: {
    name: string;
    reason?: string | null;
    mechanicId: Id<"mechanics">;
    bookingId: Id<"bookings">;
    vin: string;
    now: number;
  },
): Promise<Id<"pending_service_submissions"> | undefined> {
  const trimmed = args.name.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeServiceName(trimmed);

  const existing = await ctx.db
    .query("pending_service_submissions")
    .withIndex("by_normalized_name", (q: any) =>
      q.eq("normalized_name", normalized),
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      appearance_count: (existing.appearance_count ?? 0) + 1,
      last_seen_at: args.now,
    });
    return existing._id;
  }

  return await ctx.db.insert("pending_service_submissions", {
    proposed_name: trimmed,
    normalized_name: normalized,
    proposed_reason: args.reason?.trim() || undefined,
    submitted_by_mechanic_id: args.mechanicId,
    submitted_via_booking_id: args.bookingId,
    vehicle_vin: args.vin,
    appearance_count: 1,
    status: "pending",
    created_at: args.now,
    last_seen_at: args.now,
  });
}

/** Best-effort config lookup so labor/price evidence is fitment-scoped. */
async function resolveVehicleConfigId(
  ctx: any,
  vin: string,
): Promise<Id<"vehicle_configs"> | undefined> {
  if (!vin) return undefined;
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();
  return (vehicle as any)?.vehicle_config_id ?? undefined;
}

export type CustomJobInput = {
  name: string;
  category_id?: Id<"service_categories"> | null;
  complaint?: string | null;
  estimated_minutes?: number | null;
  quoted_price_cents?: number | null;
  shop_custom_service_id?: string | null;
};

/**
 * Create the structured rows for a booking's custom services. Called from
 * inside the booking-creation mutation so the rows and the booking land in one
 * transaction — a custom job that exists without its booking, or vice versa,
 * is a reporting lie.
 *
 * Idempotent per (booking, match_key): re-entry patches rather than duplicating,
 * so a booking edit that re-sends the same custom line doesn't double-count the
 * cluster.
 */
export async function recordCustomJobsForBooking(
  ctx: any,
  args: {
    booking: {
      _id: Id<"bookings">;
      shop_id?: Id<"shops">;
      vin: string;
    };
    mechanicId?: Id<"mechanics">;
    customJobs: CustomJobInput[];
    source: string;
    now: number;
  },
): Promise<Id<"custom_jobs">[]> {
  if (!args.booking.shop_id) return [];
  if (args.customJobs.length === 0) return [];

  const configId = await resolveVehicleConfigId(ctx, args.booking.vin);
  const existing = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", args.booking._id))
    .collect();

  const ids: Id<"custom_jobs">[] = [];
  for (const input of args.customJobs) {
    const name = input.name.trim();
    if (!name) continue;
    const matchKey = serviceMatchKey(name);

    const prior = existing.find((r: any) => r.match_key === matchKey);
    if (prior) {
      await ctx.db.patch(prior._id, {
        name,
        category_id: input.category_id ?? prior.category_id,
        complaint: input.complaint?.trim() || prior.complaint,
        estimated_minutes:
          input.estimated_minutes ?? prior.estimated_minutes,
        quoted_price_cents:
          input.quoted_price_cents ?? prior.quoted_price_cents,
        vehicle_config_id: configId ?? prior.vehicle_config_id,
        updated_at: args.now,
      });
      ids.push(prior._id);
      continue;
    }

    // Only bump the ledger for genuinely new rows — otherwise editing a booking
    // would inflate the cluster count that drives the roadmap read.
    const pendingId = args.mechanicId
      ? await bumpPendingServiceSubmission(ctx, {
          name,
          reason: input.complaint ?? null,
          mechanicId: args.mechanicId,
          bookingId: args.booking._id,
          vin: args.booking.vin,
          now: args.now,
        })
      : undefined;

    const id = await ctx.db.insert("custom_jobs", {
      booking_id: args.booking._id,
      shop_id: args.booking.shop_id,
      mechanic_id: args.mechanicId,
      vehicle_vin: args.booking.vin,
      vehicle_config_id: configId,
      name,
      normalized_name: normalizeServiceName(name),
      match_key: matchKey,
      category_id: input.category_id ?? undefined,
      complaint: input.complaint?.trim() || undefined,
      estimated_minutes: input.estimated_minutes ?? undefined,
      quoted_price_cents: input.quoted_price_cents ?? undefined,
      pending_service_submission_id: pendingId,
      shop_custom_service_id: input.shop_custom_service_id ?? undefined,
      source: args.source,
      status: "planned",
      created_at: args.now,
    });
    ids.push(id);
  }
  return ids;
}

/**
 * Close out a booking's custom jobs at completion: actual minutes, what was
 * charged, what was done, and whether it fixed the complaint.
 *
 * Matched by match_key rather than array index — the mechanic may have added or
 * removed lines between booking and completion, and index-matching would silently
 * write one job's outcome onto another.
 */
export async function completeCustomJobsForBooking(
  ctx: any,
  args: {
    bookingId: Id<"bookings">;
    jobActualId?: Id<"job_actuals">;
    outcomes: Array<{
      name: string;
      actual_minutes?: number | null;
      charged_price_cents?: number | null;
      resolution?: string | null;
      resolved_complaint?: boolean | null;
    }>;
    now: number;
  },
): Promise<number> {
  const rows = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
    .collect();
  if (rows.length === 0) return 0;

  const byKey = new Map<string, any>();
  for (const row of rows) byKey.set(row.match_key, row);

  let touched = 0;
  for (const outcome of args.outcomes) {
    const row = byKey.get(serviceMatchKey(outcome.name));
    if (!row) continue;
    await ctx.db.patch(row._id, {
      status: "completed",
      job_actual_id: args.jobActualId ?? row.job_actual_id,
      actual_minutes: outcome.actual_minutes ?? row.actual_minutes,
      charged_price_cents:
        outcome.charged_price_cents ?? row.charged_price_cents,
      resolution: outcome.resolution?.trim() || row.resolution,
      resolved_complaint:
        outcome.resolved_complaint ?? row.resolved_complaint,
      updated_at: args.now,
    });
    touched += 1;
  }

  // Any custom job still "planned" after completion was on the booking but
  // never reported on. Mark it completed with no outcome rather than leaving it
  // planned forever, so the director view can tell "no outcome recorded" apart
  // from "still open".
  for (const row of rows) {
    if (row.status !== "planned") continue;
    if (row.updated_at === args.now) continue;
    await ctx.db.patch(row._id, {
      status: "completed",
      job_actual_id: args.jobActualId ?? row.job_actual_id,
      updated_at: args.now,
    });
  }

  return touched;
}

/**
 * Mechanic-facing: the custom jobs on a booking, so the post-job survey can ask
 * for an outcome per line without re-deriving them from the booking array.
 */
export const listForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("custom_jobs")
      .withIndex("by_booking", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    rows.sort((a, b) => a.created_at - b.created_at);
    return rows.map((r) => ({
      _id: r._id,
      name: r.name,
      category_id: r.category_id ?? null,
      complaint: r.complaint ?? null,
      resolution: r.resolution ?? null,
      resolved_complaint: r.resolved_complaint ?? null,
      estimated_minutes: r.estimated_minutes ?? null,
      actual_minutes: r.actual_minutes ?? null,
      status: r.status,
    }));
  },
});

/**
 * Record outcomes from the post-job survey. Separate from the big
 * completeWithPostjob mutation so a mechanic can correct an outcome afterwards
 * without re-running completion.
 */
export const recordOutcomes = mutation({
  args: {
    bookingId: v.id("bookings"),
    outcomes: v.array(
      v.object({
        name: v.string(),
        actual_minutes: v.optional(v.number()),
        charged_price_cents: v.optional(v.number()),
        resolution: v.optional(v.string()),
        resolved_complaint: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!user) throw new Error("User not found");

    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    if (!booking.shop_id) throw new Error("Booking has no shop");

    // Same shop-staff gate the rest of the post-job path uses.
    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", booking.shop_id),
      )
      .first();
    if (!shopUser?.is_active) {
      const owned = await ctx.db
        .query("shops")
        .withIndex("by_owner_user_id", (q: any) =>
          q.eq("owner_user_id", user._id),
        )
        .filter((q: any) => q.eq(q.field("_id"), booking.shop_id))
        .first();
      if (!owned) throw new Error("Not authorized for this shop");
    }

    const touched = await completeCustomJobsForBooking(ctx, {
      bookingId: args.bookingId,
      outcomes: args.outcomes,
      now: Date.now(),
    });
    return { ok: true, touched };
  },
});
