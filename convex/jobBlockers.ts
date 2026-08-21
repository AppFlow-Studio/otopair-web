/**
 * jobBlockers.ts — a job that can't proceed as planned (Flag Issue spec, §5).
 *
 * This is the lane the "Flag issue" button existed for and had nowhere to send.
 * Before it, `live_stage` had only forward-progress values, so a stalled job had
 * two options: sit in `service_in_progress`, or be marked complete when it
 * wasn't.
 *
 * ── TWO JOBS, NOT ONE ────────────────────────────────────────────────────────
 * 1. Tell the right people. Which people depends on the kind: a late part is a
 *    front-desk problem, a seized subframe bolt is a scope conversation, a failed
 *    brake line is a safety call.
 *
 * 2. Keep blocked time out of recorded labour. `job_actuals.started_at` runs to
 *    completion, so a mechanic eyeballing the elapsed timer after a three-hour
 *    parts wait would type five hours into the post-job survey — and that number
 *    is what feeds labor_quote_snapshots, custom_jobs.actual_minutes and the
 *    shop-shortcut variance stats we use to derive what work *should* take. A
 *    shortcut whose actuals scatter because of a late delivery would look
 *    identical to one being pressed for three different jobs.
 *
 *    The fix is at the point of reading, not the point of storing:
 *    `blockedMinutesForBooking` is exposed so worked time is derivable, and the
 *    overlay's elapsed timer PAUSES on a clock-stopping blocker so what the
 *    mechanic sees — and therefore types — is worked time.
 *
 *    Note what is deliberately NOT done: `bookings.actual_duration_minutes` keeps
 *    counting blocked time, because its only consumer is schedule.ts shrinking a
 *    lane block. A blocked car still occupies the bay, and subtracting there would
 *    hand the slot to a new booking while the car is on the lift.
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { postjobPhotoValidator } from "./lib/vehicle_passports";

const MINUTE_MS = 60_000;

export type BlockerKind =
  | "parts_delay"
  | "vehicle_condition"
  | "needs_specialist"
  | "customer_unreachable"
  | "safety_hold"
  | "damage";

/**
 * What each kind means operationally. This table IS the routing logic — adding a
 * kind without a policy entry is a compile error rather than a silent default,
 * which is deliberate: a blocker nobody is told about is worse than no blocker.
 *
 * `customerQuotable` is a guard, not a feature. Damage and safety findings must
 * never be allowed to become a customer-approval request: quoting a customer to
 * pay for damage the shop caused is the system helping a shop bill for its own
 * mistake, and a safety finding has to reach the driver whether or not they buy
 * the fix.
 */
export const KIND_POLICY: Record<
  BlockerKind,
  {
    label: string;
    stopsClock: boolean;
    notifyDriver: boolean;
    notifyOwner: boolean;
    requiresPhotos: boolean;
    customerQuotable: boolean;
  }
> = {
  parts_delay: {
    label: "Waiting on a part",
    stopsClock: true,
    notifyDriver: true,
    notifyOwner: true,
    requiresPhotos: false,
    customerQuotable: false,
  },
  vehicle_condition: {
    label: "Something on the car is in the way",
    stopsClock: true,
    notifyDriver: true,
    notifyOwner: true,
    requiresPhotos: false,
    // The only kind that legitimately leads to a re-quote — but through the
    // normal mid-job approval cycle, not from here.
    customerQuotable: true,
  },
  needs_specialist: {
    label: "Needs a tool or shop we don't have",
    stopsClock: true,
    notifyDriver: true,
    notifyOwner: true,
    requiresPhotos: false,
    customerQuotable: false,
  },
  customer_unreachable: {
    label: "Can't reach the customer",
    stopsClock: true,
    // Reaching them IS the notification.
    notifyDriver: true,
    notifyOwner: true,
    requiresPhotos: false,
    customerQuotable: false,
  },
  safety_hold: {
    label: "This car shouldn't be driven",
    // Work continues; this is an escalation, not a stoppage.
    stopsClock: false,
    notifyDriver: true,
    notifyOwner: true,
    requiresPhotos: false,
    customerQuotable: false,
  },
  damage: {
    label: "Damage to the vehicle",
    stopsClock: false,
    // Deliberately NOT the platform's message to send. Whether and how the
    // customer is told is the shop's call — we record and escalate internally.
    notifyDriver: false,
    notifyOwner: true,
    requiresPhotos: true,
    customerQuotable: false,
  },
};

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

async function requireShopStaffForBooking(ctx: any, bookingId: Id<"bookings">) {
  const user = await getCurrentUser(ctx);
  const booking = await ctx.db.get(bookingId);
  if (!booking) throw new Error("Booking not found");
  if (!booking.shop_id) throw new Error("Booking has no shop");

  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", user._id).eq("shop_id", booking.shop_id),
    )
    .first();
  if (!shopUser?.is_active) {
    const owned = await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
      .filter((q: any) => q.eq(q.field("_id"), booking.shop_id))
      .first();
    if (!owned) throw new Error("Not authorized for this shop");
  }
  return { user, booking };
}

/**
 * Total minutes this booking spent blocked, counting an unresolved blocker up to
 * `now`.
 *
 * Only clock-stopping kinds count. A safety hold or a damage report doesn't pause
 * anything — the mechanic keeps working — so counting them would under-report
 * labour, which is the same class of error in the other direction.
 *
 * Overlapping blockers are merged rather than summed. Two parts on back-order at
 * once is one stoppage, and adding the spans would subtract the same wall-clock
 * hour twice.
 */
export async function blockedMinutesForBooking(
  ctx: any,
  bookingId: Id<"bookings">,
  now: number,
): Promise<number> {
  const rows = await ctx.db
    .query("job_blockers")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
    .collect();

  const spans = rows
    .filter((r: any) => r.stops_clock)
    .map((r: any) => ({
      start: r.opened_at,
      end: Math.max(r.opened_at, r.resolved_at ?? now),
    }))
    .sort((a: any, b: any) => a.start - b.start);

  let total = 0;
  let cursor = -1;
  for (const span of spans) {
    const start = Math.max(span.start, cursor);
    if (span.end > start) {
      total += span.end - start;
      cursor = span.end;
    }
  }
  return Math.round(total / MINUTE_MS);
}

/** Open a blocker. */
export const openBlocker = mutation({
  args: {
    bookingId: v.id("bookings"),
    kind: v.union(
      v.literal("parts_delay"),
      v.literal("vehicle_condition"),
      v.literal("needs_specialist"),
      v.literal("customer_unreachable"),
      v.literal("safety_hold"),
      v.literal("damage"),
    ),
    note: v.string(),
    photos: v.optional(v.array(postjobPhotoValidator)),
    etaMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user, booking } = await requireShopStaffForBooking(
      ctx,
      args.bookingId,
    );
    const policy = KIND_POLICY[args.kind as BlockerKind];

    const note = args.note.trim();
    if (!note) throw new Error("Say what's wrong — the note is what routes this.");

    // Photos are the record. A damage report without them is an assertion.
    if (policy.requiresPhotos && (args.photos ?? []).length === 0) {
      throw new Error("A photo is required when reporting damage.");
    }

    const now = Date.now();

    // One open blocker per kind per booking. Re-flagging the same kind updates
    // the existing row instead of stacking duplicates that would each claim
    // their own clock span.
    const existing = await ctx.db
      .query("job_blockers")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .collect();
    const openSameKind = existing.find(
      (r: any) => r.kind === args.kind && r.resolved_at == null,
    );
    if (openSameKind) {
      await ctx.db.patch(openSameKind._id, {
        note,
        photos: args.photos ?? openSameKind.photos,
        eta_ms: args.etaMs ?? openSameKind.eta_ms,
      });
      return { ok: true, blockerId: openSameKind._id, created: false, policy };
    }

    // Resolved once, ahead of the insert, because both the blocker row's
    // notifications need it and a second lookup inside the loop would repeat
    // per target.
    const shopName = booking.shop_id
      ? ((await ctx.db.get(booking.shop_id)) as any)?.name ?? null
      : null;

    const blockerId = await ctx.db.insert("job_blockers", {
      booking_id: args.bookingId,
      shop_id: booking.shop_id,
      raised_by_user_id: user._id,
      mechanic_id: booking.mechanic_id ?? undefined,
      kind: args.kind,
      note,
      photos: args.photos,
      eta_ms: args.etaMs,
      // Snapshot the policy so a later change can't rewrite what a past job billed.
      stops_clock: policy.stopsClock,
      opened_at: now,
    });

    // Notification routing. Deduped per (booking, kind) so re-flagging can't page
    // twice, and routed through the same notification_outbox path everything else
    // uses rather than a bespoke channel.
    const targets: Array<{ category: string; audience: "owner" | "driver" }> = [];
    if (policy.notifyOwner) {
      targets.push({ category: `job_blocked_${args.kind}`, audience: "owner" });
    }
    if (policy.notifyDriver) {
      targets.push({ category: `job_blocked_${args.kind}_driver`, audience: "driver" });
    }
    /* Push copy, written at insert time because the dispatcher reads
       payload.title / payload.body and falls back to a bare "Otopair" — a
       notification that buzzes a phone and says nothing. One line per kind so
       the driver knows whether this needs them before they open the app. */
    const PUSH_COPY: Record<string, { title: string; body: string }> = {
      parts_delay: {
        title: "Your service is paused",
        body: `${shopName ?? "Your shop"} is waiting on a part. They'll pick it back up as soon as it arrives.`,
      },
      vehicle_condition: {
        title: "Your mechanic found something",
        body: `${shopName ?? "Your shop"} hit something that needs sorting before they can finish.`,
      },
      needs_specialist: {
        title: "Your service is paused",
        body: `${shopName ?? "Your shop"} needs a tool or specialist they don't have on site.`,
      },
      customer_unreachable: {
        title: "Your shop is trying to reach you",
        body: `${shopName ?? "Your shop"} can't continue until they speak to you. Tap to see the details.`,
      },
      safety_hold: {
        title: "Don't drive your vehicle",
        body: `${shopName ?? "Your shop"} advises against driving it. Speak to them before collecting.`,
      },
    };

    // Push when we can reach the device, SMS when we can't. Push deep-links
    // straight to the booking; SMS can't, which is why it's the fallback and
    // not the default.
    const driver: any = booking.user_id
      ? await ctx.db.get(booking.user_id)
      : null;
    const driverHasPush = typeof driver?.push_token === "string";

    for (const t of targets) {
      const dedupe_key = `blocker:${String(args.bookingId)}:${args.kind}:${t.audience}`;
      const dup = await ctx.db
        .query("notification_outbox")
        .withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", dedupe_key))
        .first();
      if (dup) continue;
      await ctx.db.insert("notification_outbox", {
        shop_id: booking.shop_id,
        booking_id: args.bookingId,
        user_id: t.audience === "driver" ? booking.user_id : undefined,
        // "in_app", not "slack": no Slack dispatcher exists, and labelling the
        // row for a transport nobody drains is how these sat pending forever.
        // The shop's own notification feed reads notification_outbox directly,
        // so this row is delivered by being written. None of the sms/email/push
        // crons claim it.
        channel:
          t.audience === "driver"
            ? driverHasPush
              ? "push"
              : "sms"
            : "in_app",
        category: t.category,
        status: "pending",
        dedupe_key,
        payload: {
          kind: args.kind,
          label: policy.label,
          note,
          eta_ms: args.etaMs ?? null,
          vin: booking.vin,
          // Needed by the driver SMS templates — without it every message had
          // to say "your shop".
          shopName: shopName ?? null,
          // Read by push_dispatcher. Owner rows get none: they render from the
          // shop's in-app feed, which builds its own copy.
          ...(t.audience === "driver" && PUSH_COPY[args.kind]
            ? PUSH_COPY[args.kind]
            : {}),
        },
        created_at: now,
      });
    }

    return { ok: true, blockerId, created: true, policy };
  },
});

/** Close a blocker. Explicit — an unresolved blocker should age visibly. */
export const resolveBlocker = mutation({
  args: {
    blockerId: v.id("job_blockers"),
    resolutionNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.blockerId);
    if (!row) throw new Error("Blocker not found");
    const { user } = await requireShopStaffForBooking(ctx, row.booking_id);
    if (row.resolved_at != null) {
      return { ok: true, alreadyResolved: true };
    }
    await ctx.db.patch(args.blockerId, {
      resolved_at: Date.now(),
      resolved_by_user_id: user._id,
      resolution_note: args.resolutionNote?.trim() || undefined,
    });
    return { ok: true, alreadyResolved: false };
  },
});

/** Blockers on one booking, with the derived clock impact. */
export const listForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("job_blockers")
      .withIndex("by_booking", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    rows.sort((a, b) => b.opened_at - a.opened_at);
    const now = Date.now();
    return {
      blockers: rows.map((r) => ({
        _id: r._id,
        kind: r.kind,
        label: KIND_POLICY[r.kind as BlockerKind]?.label ?? r.kind,
        note: r.note,
        eta_ms: r.eta_ms ?? null,
        stops_clock: r.stops_clock,
        opened_at: r.opened_at,
        resolved_at: r.resolved_at ?? null,
        resolution_note: r.resolution_note ?? null,
        photo_count: (r.photos ?? []).length,
      })),
      openCount: rows.filter((r) => r.resolved_at == null).length,
      blockedMinutes: await blockedMinutesForBooking(ctx, args.bookingId, now),
    };
  },
});

/**
 * Open blockers across a shop, for the schedule board. An unresolved blocker has
 * to be visible somewhere that isn't the job it's on, or it ages silently — which
 * is the failure this whole lane exists to prevent.
 */
export const openForShop = query({
  args: { shopId: v.id("shops") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("job_blockers")
      .withIndex("by_shop_open", (q) =>
        q.eq("shop_id", args.shopId).eq("resolved_at", undefined),
      )
      .collect();
    rows.sort((a, b) => a.opened_at - b.opened_at);
    const now = Date.now();
    return await Promise.all(
      rows.map(async (r) => {
        const booking = await ctx.db.get(r.booking_id);
        return {
          _id: r._id,
          booking_id: r.booking_id,
          vin: (booking as any)?.vin ?? null,
          kind: r.kind,
          label: KIND_POLICY[r.kind as BlockerKind]?.label ?? r.kind,
          note: r.note,
          eta_ms: r.eta_ms ?? null,
          opened_at: r.opened_at,
          // How long it's been sitting. This is the number that should make
          // somebody act.
          age_minutes: Math.round((now - r.opened_at) / MINUTE_MS),
        };
      }),
    );
  },
});

/**
 * The holds on this booking that the driver is meant to know about.
 *
 * ─── WHY THIS READS STATE, NOT THE OUTBOX ───────────────────────────────────
 * The obvious implementation is to filter notification_outbox by category, the
 * way CustomerLateBanner does. It would be wrong here. That table is a delivery
 * QUEUE: the dispatch crons flip rows to "dispatching"/"sent" within a minute,
 * and every driver-facing feed filters on status === "pending". A banner built
 * on it would therefore appear for up to sixty seconds and then vanish while
 * the car was still stuck.
 *
 * A blocker has its own lifecycle — `resolved_at` — which is the thing the
 * banner actually wants to track. Reading it directly means the banner is true
 * for exactly as long as the hold is.
 *
 * `notifyDriver` is read from KIND_POLICY rather than re-listed here. Damage is
 * the one that must never reach the driver, and a second copy of that judgement
 * is a second place to get it wrong.
 */
export const activeForMyBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!user) return [];

    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return [];
    if (booking.user_id !== user._id) return [];

    const rows = await ctx.db
      .query("job_blockers")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .collect();

    const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;

    return rows
      .filter((r: any) => {
        if (r.resolved_at != null) return false;
        const policy = (KIND_POLICY as any)[r.kind];
        return policy?.notifyDriver === true;
      })
      .sort((a: any, b: any) => a.opened_at - b.opened_at)
      .map((r: any) => {
        const policy = (KIND_POLICY as any)[r.kind];
        return {
          _id: r._id,
          kind: r.kind as string,
          label: policy?.label ?? "On hold",
          // The mechanic's note. Shown verbatim — it's the only part of this
          // that says anything specific about THIS car.
          note: r.note ?? null,
          opened_at: r.opened_at as number,
          eta_ms: r.eta_ms ?? null,
          shop_name: (shop as any)?.name ?? null,
          /* The one hold a driver can personally clear. Everything else is the
             shop's to resolve, and a banner that implies otherwise invites a
             pointless phone call. */
          driver_can_act: r.kind === "customer_unreachable",
          // Work continues on a safety hold — the car is unsafe to DRIVE, not
          // unsafe to work on — so the banner shouldn't imply the job stopped.
          work_paused: policy?.stopsClock === true,
        };
      });
  },
});
