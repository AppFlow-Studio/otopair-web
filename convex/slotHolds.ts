/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================================
// Slot holds — StubHub/Ticketmaster-style short-lived reservations.
//
// The problem this solves: booking availability used to be asserted only at the
// FINAL submit. During the multi-step checkout the slot stayed visibly free to
// everyone, so two customers could each start booking the same window and both
// succeed (the "me and AB booked the same 1:15 PM" incident). A hold reserves a
// SPECIFIC mechanic+window for one checkout session the moment the slot is
// chosen, so other clients see it as taken while the first customer finishes.
//
// Server-side is the source of truth: `getActiveSlotHoldsForShopDate` in
// convex/lib/timeSlotAvailability.ts joins active holds into the availability
// context as a 4th blocking source, and the booking mutations consume+delete
// the hold in the same (transactional, OCC-serializable) mutation that writes
// the booking. Holds self-expire — an expired hold stops blocking immediately
// at read time; `releaseExpiredSlotHolds` (1-min cron) only reclaims rows.
// ============================================================================
import { mutation, internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { resolveAvailableMechanicForWindow } from "./lib/timeSlotAvailability";
import { addMinutesToHHMM } from "./lib/schedule_overlap";
import {
  quoteHoldContextValidator,
  getAuthenticatedQuoteUser,
  resolveOwnedQuoteHoldExclusion,
} from "./lib/quoteHoldOwnership";

const SLOT_HOLD_DEFAULTS = { enabled: true, ttlMs: 15 * 60 * 1000 };

// Director-tuned config from the director_settings singleton (edited from the
// Director panel → Settings), falling back to the defaults above. Mirrors
// getUnconfirmedExpiryConfig in convex/bookings.ts.
export async function getSlotHoldConfig(
  ctx: any,
): Promise<{ enabled: boolean; ttlMs: number }> {
  const row = await ctx.db
    .query("director_settings")
    .withIndex("by_key", (q: any) => q.eq("key", "global"))
    .first();
  if (!row) return { ...SLOT_HOLD_DEFAULTS };
  const ttlMinutes = row.slot_hold_ttl_minutes;
  const ttlMs =
    typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes) && ttlMinutes > 0
      ? ttlMinutes * 60 * 1000
      : SLOT_HOLD_DEFAULTS.ttlMs;
  return {
    enabled:
      typeof row.slot_hold_enabled === "boolean"
        ? row.slot_hold_enabled
        : SLOT_HOLD_DEFAULTS.enabled,
    ttlMs,
  };
}

// ---------------------------------------------------------------------------
// Mutations / queries
// ---------------------------------------------------------------------------

// Acquire (or refresh) a hold for the caller's checkout session. Idempotent:
// exactly one active hold per session_id, so re-selecting the same slot or
// going back and picking a new time never leaks a stale hold.
export const holdSlot = mutation({
  args: {
    shop_id: v.id("shops"),
    // Omitted = "Any mechanic": a concrete mechanic is pinned by the resolver.
    mechanic_id: v.optional(v.id("mechanics")),
    date: v.string(),
    start_time: v.string(),
    duration_minutes: v.number(),
    session_id: v.string(),
    held_by: v.optional(v.id("users")),
    quote_context: v.optional(quoteHoldContextValidator),
  },
  handler: async (ctx, args) => {
    const cfg = await getSlotHoldConfig(ctx);
    if (!cfg.enabled) {
      // Feature flag off — caller proceeds without a hold (legacy flow).
      return { holdId: null, mechanicId: null, expiresAt: null, disabled: true };
    }

    const duration = args.duration_minutes > 0 ? args.duration_minutes : 60;
    const quoteExclusion = await resolveOwnedQuoteHoldExclusion(ctx, args.quote_context);
    const quoteOwner = args.quote_context
      ? await getAuthenticatedQuoteUser(ctx)
      : null;

    // Assert the window is free against ALL four blocking sources (bookings,
    // blocked slots, tire holds, other sessions' slot holds) and PIN a concrete
    // mechanic — so "Any mechanic" can't let two users both hold the same one.
    // excludeSessionId ignores this session's own prior hold so re-selecting
    // doesn't self-conflict.
    const mechanicId = await resolveAvailableMechanicForWindow(ctx, {
      shopId: args.shop_id,
      date: args.date,
      startTime: args.start_time,
      durationMinutes: duration,
      preferredMechanicId: args.mechanic_id,
      excludeSessionId: args.session_id,
      ...quoteExclusion,
    });

    const now = Date.now();
    const expiresAt = now + cfg.ttlMs;
    const endTime = addMinutesToHHMM(args.start_time, duration);

    // Idempotency: reuse a matching active hold, drop any other active hold for
    // this session (the user moved to a different slot).
    const existing = await ctx.db
      .query("slot_holds")
      .withIndex("by_session", (q: any) => q.eq("session_id", args.session_id))
      .collect();

    let reusedId: any = null;
    for (const h of existing) {
      if (h.status !== "active") continue;
      const sameSlot =
        String(h.shop_id) === String(args.shop_id) &&
        String(h.mechanic_id) === String(mechanicId) &&
        h.date === args.date &&
        h.start_time === args.start_time &&
        h.duration_minutes === duration;
      if (sameSlot && reusedId === null) {
        await ctx.db.patch(h._id, {
          expires_at: expiresAt,
          end_time: endTime,
          held_by: quoteOwner?._id ?? h.held_by ?? args.held_by,
        });
        reusedId = h._id;
      } else {
        await ctx.db.delete(h._id);
      }
    }

    if (reusedId) {
      return { holdId: reusedId, mechanicId, expiresAt };
    }

    const holdId = await ctx.db.insert("slot_holds", {
      shop_id: args.shop_id,
      mechanic_id: mechanicId,
      date: args.date,
      start_time: args.start_time,
      end_time: endTime,
      duration_minutes: duration,
      held_by: quoteOwner?._id ?? args.held_by,
      session_id: args.session_id,
      expires_at: expiresAt,
      status: "active",
      created_at: now,
    });
    return { holdId, mechanicId, expiresAt };
  },
});

// Release a hold on abandonment (drawer close / mobile back / slot change).
// Ownership is enforced via session_id so one session can't drop another's.
export const releaseSlotHold = mutation({
  args: { holdId: v.id("slot_holds"), session_id: v.string() },
  handler: async (ctx, args) => {
    const hold = await ctx.db.get(args.holdId);
    if (!hold) return { released: false };
    if (hold.session_id !== args.session_id) return { released: false };
    await ctx.db.delete(args.holdId);
    return { released: true };
  },
});

// Poll target for the client to detect expiry on resume ("session expired").
export const getSlotHold = query({
  args: { holdId: v.id("slot_holds") },
  handler: async (ctx, args) => {
    const hold = await ctx.db.get(args.holdId);
    if (!hold) return null;
    const now = Date.now();
    return {
      status: hold.status,
      expiresAt: hold.expires_at,
      isExpired: hold.status !== "active" || hold.expires_at <= now,
      mechanicId: hold.mechanic_id,
      date: hold.date,
      startTime: hold.start_time,
      durationMinutes: hold.duration_minutes,
    };
  },
});

// Restore the countdown after a reload — the session's current active hold.
export const getMyActiveHold = query({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("slot_holds")
      .withIndex("by_session", (q: any) => q.eq("session_id", args.session_id))
      .collect();
    const active = rows.find(
      (h: any) => h.status === "active" && h.expires_at > now,
    );
    if (!active) return null;
    return {
      holdId: active._id,
      expiresAt: active.expires_at,
      mechanicId: active.mechanic_id,
      shopId: active.shop_id,
      date: active.date,
      startTime: active.start_time,
      durationMinutes: active.duration_minutes,
    };
  },
});

// Janitor: reclaim expired rows. NOT the gate — availability reads already
// filter `expires_at > now`, so an expired hold frees the slot immediately.
// Runs every minute (see convex/crons.ts) because a 15-min TTL can't tolerate a
// 10-min sweep leaving the slot falsely blocked for a third of its life.
export const releaseExpiredSlotHolds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("slot_holds")
      .withIndex("by_expiry", (q: any) => q.lt("expires_at", now))
      .collect();
    let deleted = 0;
    for (const h of expired) {
      await ctx.db.delete(h._id);
      deleted += 1;
    }
    return { deleted };
  },
});

// ---------------------------------------------------------------------------
// Consume helpers — used by the booking mutations (convex/bookings.ts) so the
// hold is verified, its mechanic reused, and the row deleted in the SAME
// mutation that inserts the booking (atomic under Convex OCC).
// ---------------------------------------------------------------------------

// Never throws: an invalid/expired hold must not block a still-legitimate
// booking — the caller falls through to normal resolution, which re-runs the
// full availability assertion as the backstop.
export async function resolveSlotHoldForConsume(
  ctx: any,
  args: {
    holdId?: any;
    sessionId?: string;
    shopId: any;
    date: string;
    startTime: string;
    heldBy?: any;
  },
): Promise<{
  pinnedMechanicId: any | null;
  consumeHoldId: any | null;
  // Session whose holds must be excluded from the consume's availability check
  // so the caller's own hold doesn't block their own booking.
  excludeSessionId: string | undefined;
}> {
  if (!args.holdId) {
    return { pinnedMechanicId: null, consumeHoldId: null, excludeSessionId: undefined };
  }
  const hold = await ctx.db.get(args.holdId);
  if (!hold) {
    return { pinnedMechanicId: null, consumeHoldId: null, excludeSessionId: undefined };
  }
  const now = Date.now();
  const valid =
    hold.status === "active" &&
    hold.expires_at > now &&
    (!args.sessionId || hold.session_id === args.sessionId) &&
    String(hold.shop_id) === String(args.shopId) &&
    hold.date === args.date &&
    hold.start_time === args.startTime;
  const owned = !args.heldBy || String(hold.held_by) === String(args.heldBy);
  if (!valid || !owned) {
    return { pinnedMechanicId: null, consumeHoldId: null, excludeSessionId: undefined };
  }
  return {
    pinnedMechanicId: hold.mechanic_id,
    consumeHoldId: hold._id,
    excludeSessionId: hold.session_id,
  };
}

export async function deleteConsumedSlotHold(ctx: any, holdId: any | null) {
  if (!holdId) return;
  const hold = await ctx.db.get(holdId);
  if (!hold) return;
  await ctx.db.delete(holdId);
}
