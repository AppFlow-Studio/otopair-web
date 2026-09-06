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

/** A single flag-issue admin pause longer than this is treated as a stuck sheet
 *  or a skewed client clock and clamped — a mechanic isn't writing up scope for
 *  an hour, and one runaway span shouldn't be able to zero out a job's labour. */
const MAX_ADMIN_PAUSE_MS = 60 * MINUTE_MS;

/**
 * Human car label for a booking — "2011 Acura TL", VIN-tail fallback. Mirrors
 * the resolution the staff notification feed uses (`notifications.ts`) so the
 * car reads the same on the alert and in the feed. Kept local to avoid pulling
 * the heavy VIN-based resolver (and its module graph) out of bookings.ts.
 */
async function vehicleLabelForBooking(
  ctx: any,
  booking: any,
): Promise<string | null> {
  // vehicle_id first; bookings always carry the VIN, so fall back to a by_vin
  // lookup when vehicle_id is missing/dangling (keeps the real car on the alert,
  // not a VIN tail).
  let veh: any = booking?.vehicle_id
    ? await ctx.db.get(booking.vehicle_id)
    : null;
  if (!veh && typeof booking?.vin === "string" && booking.vin) {
    veh = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first();
  }
  if (veh) {
    const meta = veh.metadata ?? {};
    const parts = [veh.year ?? meta.year, meta.make, meta.model].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
    if (veh.vin) return `VIN …${String(veh.vin).slice(-6)}`;
  }
  if (booking?.vin) return `VIN …${String(booking.vin).slice(-6)}`;
  return null;
}

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
 * Every wall-clock span during which this booking's work clock was stopped.
 *
 * Two sources, merged into one list (mergedSpanMinutes de-overlaps them, so an
 * admin pause opened during a blocker is never subtracted twice):
 *
 *  1. Clock-stopping blockers. Only those kinds count — a safety hold or a
 *     damage report doesn't pause anything (the mechanic keeps working), so
 *     counting them would under-report labour, the same error in the other
 *     direction.
 *
 *  2. Flag-issue admin pauses. Time the mechanic spent in the Flag Issue flow —
 *     writing up extra scope in the sheet and the mid-job scope dialog — rather
 *     than turning a wrench. Recorded as closed spans on `job_admin_pauses` by
 *     NowWorkingPane when the flow closes.
 *
 * NOTE — a mid-job re-quote *waiting on the customer* used to be source 2, on
 * the theory that the mechanic was idle until the customer answered (Abdul,
 * Aug 20). It was pulled (Temur, Aug 23): that wait is open-ended and outside
 * the shop's control, and a mechanic with a car on the lift rarely stands still
 * for it — they move to other work, so stopping the clock for the whole wait
 * under-billed real labour. The narrower, genuinely-idle admin window above
 * replaced it.
 */
async function clockStoppedSpans(
  ctx: any,
  bookingId: Id<"bookings">,
  now: number,
): Promise<Array<{ start: number; end: number }>> {
  const [blockers, adminPauses] = await Promise.all([
    ctx.db
      .query("job_blockers")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
    ctx.db
      .query("job_admin_pauses")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
      .collect(),
  ]);

  const blockerSpans = blockers
    .filter((r: any) => r.stops_clock)
    .map((r: any) => ({
      start: r.opened_at,
      end: Math.max(r.opened_at, r.resolved_at ?? now),
    }));

  const adminSpans = adminPauses.map((r: any) => ({
    start: r.opened_at,
    end: Math.max(r.opened_at, r.closed_at),
  }));

  return [...blockerSpans, ...adminSpans];
}

/** Merge overlapping spans and total them. Overlaps are merged rather than
 *  summed: two parts on back-order at once is one stoppage, not two — and a flag
 *  sheet opened while already blocked is not a second pause. Adding them would
 *  subtract the same wall-clock hour twice. */
function mergedSpanMinutes(spans: Array<{ start: number; end: number }>): number {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -1;
  for (const span of sorted) {
    const start = Math.max(span.start, cursor);
    if (span.end > start) {
      total += span.end - start;
      cursor = span.end;
    }
  }
  return Math.round(total / MINUTE_MS);
}

/**
 * Total minutes this booking spent with the work clock stopped — unresolved
 * clock-stopping blockers (counted up to `now`) plus recorded flag-issue admin
 * pauses.
 */
export async function blockedMinutesForBooking(
  ctx: any,
  bookingId: Id<"bookings">,
  now: number,
): Promise<number> {
  return mergedSpanMinutes(await clockStoppedSpans(ctx, bookingId, now));
}

/** Whether the work clock is stopped right now — an unresolved clock-stopping
 *  blocker. (Flag-issue admin pauses are recorded as already-closed spans, so
 *  they never read as "currently paused" here; the live pause while the flag
 *  flow is open is a client-screen concern.) Derived here so every surface reads
 *  one answer instead of recomputing the predicate. */
export async function isClockPausedForBooking(
  ctx: any,
  bookingId: Id<"bookings">,
  now: number,
): Promise<boolean> {
  return (await clockStoppedSpans(ctx, bookingId, now)).some(
    (span) => span.end >= now,
  );
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
    // Car + mechanic so every alert can say which vehicle, whose bay, and why —
    // staff reads all four; the customer copy below uses car + shop + reason.
    const vehicleLabel = await vehicleLabelForBooking(ctx, booking);
    let mechanicName: string | null = null;
    if (booking.mechanic_id) {
      const mech: any = await ctx.db.get(booking.mechanic_id);
      const mn = [mech?.first_name, mech?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      mechanicName = mn.length > 0 ? mn : null;
    }

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
    // Customer-facing: car + shop + reason (softened — no mechanic name).
    const carPhrase = vehicleLabel ?? "your vehicle";
    const shopPhrase = shopName ?? "your shop";
    const PUSH_COPY: Record<string, { title: string; body: string }> = {
      parts_delay: {
        title: "Your service is paused",
        body: `Your ${carPhrase} at ${shopPhrase} is paused — waiting on a part. They'll pick it back up as soon as it arrives.`,
      },
      vehicle_condition: {
        title: "Your mechanic found something",
        body: `${shopPhrase} hit something on your ${carPhrase} that needs sorting before they can finish.`,
      },
      needs_specialist: {
        title: "Your service is paused",
        body: `Your ${carPhrase} at ${shopPhrase} is paused — they need a tool or specialist they don't have on site.`,
      },
      customer_unreachable: {
        title: "Your shop is trying to reach you",
        body: `${shopPhrase} can't continue on your ${carPhrase} until they speak to you. Tap to see the details.`,
      },
      safety_hold: {
        title: "Don't drive your vehicle",
        body: `${shopPhrase} advises against driving your ${carPhrase}. Speak to them before collecting.`,
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
          // Car (year/make/model) + mechanic so the alert states which vehicle,
          // whose bay, and why. Driver templates print car + shop; staff feed
          // reads mechanicName too. Without vehicleLabel every message had to
          // fall back to "your vehicle".
          vehicleLabel: vehicleLabel ?? null,
          mechanicName: mechanicName ?? null,
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

/**
 * Record a completed flag-issue admin pause — a span the mechanic spent in the
 * Flag Issue flow (the sheet + the mid-job scope dialog) instead of working.
 *
 * Called by NowWorkingPane when the flow closes, so only ever a finished span.
 * The client's opened_at/closed_at are treated as hints and clamped: the end
 * can't be in the future, the span is bounded (MAX_ADMIN_PAUSE_MS), and a span
 * under a second is dropped as a mis-fire. This is what makes the on-screen
 * pause durable — folded into clockStoppedSpans, it reaches blocked_minutes and
 * the auto-derived labour, not just the one screen it happened on.
 */
export const recordFlagAdminPause = mutation({
  args: {
    bookingId: v.id("bookings"),
    openedAt: v.number(),
    closedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const { user, booking } = await requireShopStaffForBooking(
      ctx,
      args.bookingId,
    );
    const now = Date.now();

    // Clamp to a sane, non-future, bounded span before trusting it.
    const closedAt = Math.min(args.closedAt, now);
    const openedAt = Math.min(
      Math.max(args.openedAt, closedAt - MAX_ADMIN_PAUSE_MS),
      closedAt,
    );
    if (closedAt - openedAt < 1_000) {
      return { ok: true, recorded: false as const };
    }

    const id = await ctx.db.insert("job_admin_pauses", {
      booking_id: args.bookingId,
      shop_id: booking.shop_id ?? undefined,
      mechanic_id: booking.mechanic_id ?? undefined,
      recorded_by_user_id: user._id,
      opened_at: openedAt,
      closed_at: closedAt,
      created_at: now,
    });
    return { ok: true, recorded: true as const, id };
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
      // Derived server-side so the four surfaces that show a running clock
      // (overlay, overlay's multi-job picker, header pill, now-working banner)
      // can't disagree — and so a new pause source is added in one place
      // instead of four.
      clockPaused: await isClockPausedForBooking(ctx, args.bookingId, now),
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
        const vehicleLabel = await vehicleLabelForBooking(ctx, booking);
        // Whose bay is it now — current assignment, falling back to the
        // blocker's snapshot if the booking was since unassigned.
        const mechId = (booking as any)?.mechanic_id ?? r.mechanic_id ?? null;
        let mechanicName: string | null = null;
        if (mechId) {
          const mech: any = await ctx.db.get(mechId);
          const mn = [mech?.first_name, mech?.last_name]
            .filter(Boolean)
            .join(" ")
            .trim();
          mechanicName = mn.length > 0 ? mn : null;
        }
        return {
          _id: r._id,
          booking_id: r.booking_id,
          vin: (booking as any)?.vin ?? null,
          vehicleLabel,
          mechanicName,
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
