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
//
// Abandoned checkouts (bug #393): a customer who force-closes the app after
// tapping "Book" leaves a hold nobody will release, and the relaunched app has
// lost its session id. Three server-side answers, none needing a new client:
//   - `held_by` is the signed-in user, never the client's word for it, so the
//     portal can tell a customer checkout from a staff draft;
//   - a customer's new hold SUPERSEDES that customer's older non-quote holds on
//     other sessions, so the relaunched app can re-pick the same slot at once;
//   - an opt-in LEASE (`holdSlot({ lease: true })` + `touchSlotHold` heartbeat)
//     lets a new build's hold lapse ~90s after the app dies instead of at TTL.
// ============================================================================
import { mutation, internalMutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { bookingError } from "./lib/bookingErrors";
import { resolveAvailableMechanicForWindow } from "./lib/timeSlotAvailability";
import { addMinutesToHHMM } from "./lib/schedule_overlap";
import {
  quoteHoldContextValidator,
  getAuthenticatedQuoteUser,
  resolveOwnedQuoteHoldExclusion,
  requireQuoteShopAccess,
} from "./lib/quoteHoldOwnership";

const SLOT_HOLD_DEFAULTS = { enabled: true, ttlMs: 15 * 60 * 1000 };

// Liveness lease for holds that opt in (bug #393). The client heartbeats via
// `touchSlotHold` every ~30s while the checkout screen is in the foreground;
// a killed app stops, and its hold stops blocking within one lease. The
// Director TTL still caps the whole hold (`hard_expires_at`).
export const SLOT_HOLD_LEASE_MS = 90_000;

const SLOT_HOLD_EXPIRED_MESSAGE =
  "Your held time expired. Pick a time again to continue.";
const SLOT_UNAVAILABLE_FALLBACK_MESSAGE =
  "That time is no longer available. Pick another time.";

export type SlotHoldKind = "customer_checkout" | "quote_checkout" | "staff";

// Who is holding a slot, derived from the row alone so the portal labels every
// hold correctly — including ones written by builds already in the field:
// quote accepts carry `quote_type`; the customer app always sends `held_by`;
// the portal's create-booking drawer and shop quote dialogs never do.
export function slotHoldKind(hold: {
  quote_type?: string | null;
  held_by?: unknown;
}): SlotHoldKind {
  if (hold.quote_type) return "quote_checkout";
  if (hold.held_by) return "customer_checkout";
  return "staff";
}

// The signed-in caller's users row, or null. `.first()` rather than
// `.unique()`: this now runs on every customer hold, and a duplicated users
// row must not start failing checkouts.
async function getAuthUser(ctx: any): Promise<any | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .first();
}

// holdSlot's availability failures reach two kinds of client: the portal
// (errorMessage) and the customer app (toast "That time was just taken", or a
// route to the quotes tab on QUOTE_UNAVAILABLE). A typed error is already
// what they read, so it passes through untouched; a plain Error from the
// availability helpers becomes SLOT_UNAVAILABLE carrying the same sentence.
function asSlotUnavailable(
  err: unknown,
  details: Record<string, string | undefined>,
): unknown {
  if (err instanceof ConvexError) return err;
  const message =
    err instanceof Error && err.message.trim()
      ? err.message.trim()
      : SLOT_UNAVAILABLE_FALLBACK_MESSAGE;
  return bookingError("SLOT_UNAVAILABLE", message, details);
}

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
    // The customer app's "this is my checkout" signal. The VALUE is ignored
    // for a signed-in caller — the hold is recorded against the auth user.
    held_by: v.optional(v.id("users")),
    quote_context: v.optional(quoteHoldContextValidator),
    // Shop-side requote: the quote being revised already holds its current
    // window, so ignore it here (shop staff only) — otherwise moving a quote
    // to an overlapping time would self-conflict.
    requote_of: v.optional(quoteHoldContextValidator),
    // Opt into the liveness lease (bug #393): the hold lives SLOT_HOLD_LEASE_MS
    // and the client keeps it alive with `touchSlotHold`. Quote-accept holds
    // ignore it — the expired-quote grace in acceptTire/RotorQuote and the
    // quote lifecycle both key off this hold's full TTL.
    lease: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const cfg = await getSlotHoldConfig(ctx);
    if (!cfg.enabled) {
      // Feature flag off — caller proceeds without a hold (legacy flow).
      return {
        holdId: null,
        mechanicId: null,
        expiresAt: null,
        hardExpiresAt: null,
        leaseMs: null,
        disabled: true,
      };
    }

    const duration = args.duration_minutes > 0 ? args.duration_minutes : 60;
    const quoteExclusion = await resolveOwnedQuoteHoldExclusion(ctx, args.quote_context);
    if (args.requote_of) {
      const own: any = await ctx.db.get(args.requote_of.response_id);
      if (own && String(own.shop_id) === String(args.shop_id)) {
        await requireQuoteShopAccess(ctx, own.shop_id);
        if (args.requote_of.quote_type === "tire") {
          quoteExclusion.excludeTireQuoteResponseId = String(own._id);
        } else {
          quoteExclusion.excludeRotorQuoteResponseId = String(own._id);
        }
      }
    }
    const quoteOwner = args.quote_context
      ? await getAuthenticatedQuoteUser(ctx)
      : null;

    // Who owns this hold (bug #393). Only callers that ask for customer
    // ownership — the app sends `held_by`, quote accepts send quote_context —
    // get one, and for a signed-in caller it is the auth user whatever the
    // client sent (a mismatch is ignored, never thrown: old builds keep
    // working). Portal drawer / shop quote-dialog holds stay unowned, which is
    // what labels them "staff" on the schedule and keeps them out of the
    // per-customer supersede below. An unauthenticated caller keeps today's
    // client-supplied value.
    const customerCaller =
      args.held_by !== undefined && !args.quote_context
        ? await getAuthUser(ctx)
        : null;
    const heldBy = quoteOwner?._id ?? customerCaller?._id ?? args.held_by;

    // Per-customer supersede (bug #393): a relaunched app has a new session id
    // and its killed session's hold would otherwise block this very customer
    // from re-picking the same slot for the full TTL. One live checkout hold
    // per signed-in customer: drop their other non-quote holds BEFORE the
    // availability check so the ghost can't self-conflict. Never touches
    // staff holds (unowned) or quote-accept holds (quote_type set). If the
    // check below fails the whole mutation rolls back and the old hold stays.
    if (customerCaller) {
      const mine = await ctx.db
        .query("slot_holds")
        .withIndex("by_held_by", (q: any) => q.eq("held_by", customerCaller._id))
        .collect();
      for (const h of mine) {
        if (h.status !== "active") continue;
        if (h.quote_type != null) continue;
        if (h.session_id === args.session_id) continue;
        await ctx.db.delete(h._id);
      }
    }

    // Assert the window is free against ALL four blocking sources (bookings,
    // blocked slots, tire holds, other sessions' slot holds) and PIN a concrete
    // mechanic — so "Any mechanic" can't let two users both hold the same one.
    // excludeSessionId ignores this session's own prior hold so re-selecting
    // doesn't self-conflict.
    let mechanicId: any;
    try {
      mechanicId = await resolveAvailableMechanicForWindow(ctx, {
        shopId: args.shop_id,
        date: args.date,
        startTime: args.start_time,
        durationMinutes: duration,
        preferredMechanicId: args.mechanic_id,
        excludeSessionId: args.session_id,
        ...quoteExclusion,
      });
    } catch (err) {
      throw asSlotUnavailable(err, {
        shopId: String(args.shop_id),
        date: args.date,
        startTime: args.start_time,
        mechanicId: args.mechanic_id ? String(args.mechanic_id) : undefined,
      });
    }

    const now = Date.now();
    const endTime = addMinutesToHHMM(args.start_time, duration);

    // Idempotency: reuse a matching active hold, drop any other active hold for
    // this session (the user moved to a different slot).
    const existing = await ctx.db
      .query("slot_holds")
      .withIndex("by_session", (q: any) => q.eq("session_id", args.session_id))
      .collect();

    // Lease vs legacy TTL. A re-hold on a leased session stays leased even if
    // the call omits the flag; `lease: false` opts back out. `expires_at` stays
    // the ONE effective expiry every reader already filters on.
    const sessionIsLeased = existing.some(
      (h: any) => h.status === "active" && typeof h.lease_ms === "number",
    );
    const leased =
      !args.quote_context &&
      (args.lease === true || (args.lease === undefined && sessionIsLeased));
    const hardExpiresAt = now + cfg.ttlMs;
    const leaseMs = leased ? Math.min(SLOT_HOLD_LEASE_MS, cfg.ttlMs) : null;
    const expiresAt = leaseMs != null ? now + leaseMs : hardExpiresAt;

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
          // Patching `undefined` unsets the field, so a hold that leaves lease
          // mode doesn't keep a stale cap.
          lease_ms: leaseMs ?? undefined,
          hard_expires_at: leaseMs != null ? hardExpiresAt : undefined,
          last_seen_at: leaseMs != null ? now : undefined,
          end_time: endTime,
          held_by: heldBy ?? h.held_by,
          quote_type: args.quote_context?.quote_type,
          quote_revision: args.quote_context?.revision ?? (args.quote_context ? 1 : undefined),
          tire_quote_response_id:
            args.quote_context?.quote_type === "tire"
              ? args.quote_context.response_id
              : undefined,
          rotor_quote_response_id:
            args.quote_context?.quote_type === "rotor"
              ? args.quote_context.response_id
              : undefined,
        });
        reusedId = h._id;
      } else {
        await ctx.db.delete(h._id);
      }
    }

    if (reusedId) {
      return { holdId: reusedId, mechanicId, expiresAt, hardExpiresAt, leaseMs };
    }

    const holdId = await ctx.db.insert("slot_holds", {
      shop_id: args.shop_id,
      mechanic_id: mechanicId,
      date: args.date,
      start_time: args.start_time,
      end_time: endTime,
      duration_minutes: duration,
      held_by: heldBy,
      session_id: args.session_id,
      expires_at: expiresAt,
      lease_ms: leaseMs ?? undefined,
      hard_expires_at: leaseMs != null ? hardExpiresAt : undefined,
      last_seen_at: leaseMs != null ? now : undefined,
      status: "active",
      created_at: now,
      quote_type: args.quote_context?.quote_type,
      quote_revision: args.quote_context?.revision ?? (args.quote_context ? 1 : undefined),
      tire_quote_response_id:
        args.quote_context?.quote_type === "tire"
          ? args.quote_context.response_id
          : undefined,
      rotor_quote_response_id:
        args.quote_context?.quote_type === "rotor"
          ? args.quote_context.response_id
          : undefined,
    });
    return { holdId, mechanicId, expiresAt, hardExpiresAt, leaseMs };
  },
});

// Heartbeat for a leased hold (bug #393). The checkout screen calls this every
// ~30s while it is in the foreground (and once on resume). Ownership is the
// session id plus, for an owned hold, the signed-in customer. A hold that is
// gone, expired or not the caller's → SLOT_HOLD_EXPIRED; the client re-holds
// the same slot, and only if THAT fails shows "session expired".
//
// Writes only when less than half the lease remains: every patch invalidates
// the availability subscriptions reading this shop/date, so a 30s heartbeat
// on a 90s lease writes about once a minute, not on every beat. A legacy
// (non-lease) hold is accepted and returned untouched.
export const touchSlotHold = mutation({
  args: { holdId: v.id("slot_holds"), session_id: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const hold = await ctx.db.get(args.holdId);
    const expired = () =>
      bookingError("SLOT_HOLD_EXPIRED", SLOT_HOLD_EXPIRED_MESSAGE, {
        holdId: String(args.holdId),
      });
    if (
      !hold ||
      hold.status !== "active" ||
      hold.expires_at <= now ||
      hold.session_id !== args.session_id
    ) {
      throw expired();
    }
    if (hold.held_by) {
      const me = await getAuthUser(ctx);
      if (!me || String(me._id) !== String(hold.held_by)) throw expired();
    }

    const hardExpiresAt = hold.hard_expires_at ?? hold.expires_at;
    const leaseMs =
      typeof hold.lease_ms === "number" && hold.lease_ms > 0 ? hold.lease_ms : null;
    if (leaseMs == null) {
      return { expiresAt: hold.expires_at, hardExpiresAt, leaseMs };
    }
    const extendTo = Math.min(now + leaseMs, hardExpiresAt);
    if (hold.expires_at - now < leaseMs / 2 && extendTo > hold.expires_at) {
      await ctx.db.patch(hold._id, { expires_at: extendTo, last_seen_at: now });
      return { expiresAt: extendTo, hardExpiresAt, leaseMs };
    }
    return { expiresAt: hold.expires_at, hardExpiresAt, leaseMs };
  },
});

// Release a hold on abandonment (drawer close / mobile back / slot change).
// Ownership is enforced via session_id so one session can't drop another's —
// or, for a customer-owned hold, via the signed-in owner: a relaunched app
// that kept the hold id but lost its session id can still free it (#393).
export const releaseSlotHold = mutation({
  args: { holdId: v.id("slot_holds"), session_id: v.string() },
  handler: async (ctx, args) => {
    const hold = await ctx.db.get(args.holdId);
    if (!hold) return { released: false };
    if (hold.session_id !== args.session_id) {
      if (!hold.held_by) return { released: false };
      const me = await getAuthUser(ctx);
      if (!me || String(me._id) !== String(hold.held_by)) return { released: false };
    }
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
      // The Director-TTL cap. Equal to expiresAt for a non-lease hold; for a
      // leased one, the latest it can live while the app keeps touching it.
      hardExpiresAt: hold.hard_expires_at ?? hold.expires_at,
      leaseMs: hold.lease_ms ?? null,
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
      hardExpiresAt: active.hard_expires_at ?? active.expires_at,
      leaseMs: active.lease_ms ?? null,
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
    quoteType?: "tire" | "rotor";
    quoteResponseId?: any;
    quoteRevision?: number;
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
  const quoteMatches =
    !args.quoteType ||
    (hold.quote_type === args.quoteType &&
      hold.quote_revision === (args.quoteRevision ?? 1) &&
      String(
        args.quoteType === "tire"
          ? hold.tire_quote_response_id
          : hold.rotor_quote_response_id,
      ) === String(args.quoteResponseId));
  if (!valid || !owned || !quoteMatches) {
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
