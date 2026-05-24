// =============================================================================
// Oto AI — Bookings query
// =============================================================================
//
// Backs the `get_bookings` AI tool. User-scoped (no vehicle filter — Haiku
// can read the vin/service_names back if it needs to slice further). Returns
// a flat enrichment-light shape: just enough for Oto to say "your last X
// service was Y months ago at Shop Z, and you have an upcoming W on Friday."
//
// status_filter:
//   • "active"    → pending | confirmed | in_progress
//   • "completed" → completed
//   • "all"       → everything (no filter)
//
// Ordering: newest first by _creationTime. limit defaults to 5, capped at 20.
// =============================================================================

import { query } from "../_generated/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";

const ACTIVE_STATUSES = new Set(["pending", "confirmed", "in_progress"]);

export interface OtoBookingSummary {
  id: string;
  status: string;
  service_slugs: string[];
  service_names: string[];
  shop_name: string | null;
  mechanic_name: string | null;
  vehicle_vin_tail: string | null;
  scheduled_date: string | null;
  created_at: number;
}

// Convex query({...}) generic resolution previously exceeded TS depth at this
// schema size; ctx: any breaks the chain so direct suppression is no longer
// required. Runtime is unaffected.
export const getBookings = query({
  args: {
    status_filter: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("all"),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx: any, { status_filter, limit }): Promise<OtoBookingSummary[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");

    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found in Convex");

    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();

    // Filter by status_filter first to avoid enriching rows we'll drop.
    const filtered = rows.filter((b: any) => {
      if (status_filter === "all") return true;
      if (status_filter === "active") return ACTIVE_STATUSES.has(b.status);
      if (status_filter === "completed") return b.status === "completed";
      return false;
    });

    // Newest first by _creationTime — bookings.scheduled_at may be unset for
    // quote-stage rows, so _creationTime is the only universally-present
    // ordering field.
    filtered.sort((a: any, b: any) => b._creationTime - a._creationTime);

    const cap = Math.min(20, Math.max(1, limit ?? 5));
    const limited = filtered.slice(0, cap);

    return await Promise.all(
      limited.map(async (b: any) => {
        const shop = b.shop_id ? await ctx.db.get(b.shop_id) : null;
        const mechanic = b.mechanic_id ? await ctx.db.get(b.mechanic_id) : null;
        const serviceIds = b.service_ids ?? [];
        const services = await Promise.all(
          serviceIds.map((id: any) => ctx.db.get(id)),
        );
        const seen = services.filter((s): s is Doc<"services"> => s != null);
        return {
          id: b._id,
          status: b.status,
          service_slugs: seen.map((s) => s.slug).filter((x): x is string => !!x),
          service_names: seen.map((s) => s.name),
          shop_name: shop?.name ?? null,
          mechanic_name: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
            : null,
          vehicle_vin_tail: b.vin ? b.vin.slice(-6) : null,
          scheduled_date: b.scheduled_date ?? null,
          created_at: b._creationTime,
        };
      }),
    );
  },
});

// =============================================================================
// getPendingBookings — Sprint 3 Day 5 §14.3 Booking Status.
// =============================================================================
//
// Strict subset of `getBookings`: returns only `pending` rows (NOT confirmed,
// NOT in_progress). Backs the `get_pending_bookings` AI tool, which Haiku
// calls when the user specifically asks about pending / unconfirmed bookings.
// For the broader active set (pending + confirmed + in_progress) Haiku uses
// get_bookings(status_filter: "active"). Same OtoBookingSummary shape and
// same auth pattern as getBookings; differences are scoped to the arg surface
// (no status_filter arg) and the filter (b.status === "pending").
//
// Implementation is mirrored — not extracted into a shared helper — because
// the typed Convex `query` definition's handler context unlocks deep schema
// inference for ctx.db that an extracted helper (ctx: any) would lose, and
// extracting tripped TS2589 ("excessively deep instantiation") on the query
// definition. Keeping the two handlers independent preserves type safety.
// =============================================================================

// See getBookings above for the ctx: any rationale.
export const getPendingBookings = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx: any, { limit }): Promise<OtoBookingSummary[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");

    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found in Convex");

    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();

    // Pending-only filter — strict subset of getBookings's "active" set.
    const filtered = rows.filter((b: any) => b.status === "pending");

    // Newest first by _creationTime — bookings.scheduled_at may be unset for
    // quote-stage rows, so _creationTime is the only universally-present
    // ordering field.
    filtered.sort((a: any, b: any) => b._creationTime - a._creationTime);

    const cap = Math.min(20, Math.max(1, limit ?? 5));
    const limited = filtered.slice(0, cap);

    return await Promise.all(
      limited.map(async (b: any) => {
        const shop = b.shop_id ? await ctx.db.get(b.shop_id) : null;
        const mechanic = b.mechanic_id ? await ctx.db.get(b.mechanic_id) : null;
        const serviceIds = b.service_ids ?? [];
        const services = await Promise.all(
          serviceIds.map((id: any) => ctx.db.get(id)),
        );
        const seen = services.filter((s): s is Doc<"services"> => s != null);
        return {
          id: b._id,
          status: b.status,
          service_slugs: seen.map((s) => s.slug).filter((x): x is string => !!x),
          service_names: seen.map((s) => s.name),
          shop_name: shop?.name ?? null,
          mechanic_name: mechanic
            ? `${mechanic.first_name} ${mechanic.last_name}`.trim()
            : null,
          vehicle_vin_tail: b.vin ? b.vin.slice(-6) : null,
          scheduled_date: b.scheduled_date ?? null,
          created_at: b._creationTime,
        };
      }),
    );
  },
});
