/**
 * notificationOutbox.ts — the single enqueue path into `notification_outbox`.
 *
 * Lives in lib/ (rather than convex/bookings.ts, which re-exports it) so
 * convex/inspectionHealthDeferred.ts can enqueue the deferred health-score push
 * without a circular import back into bookings.ts. Same reasoning as
 * hydrateTieredInspectionState — see the note at convex/bookings.ts.
 */

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * buildCustomerPushPayload — the one shape a customer push must have.
 *
 * The Expo dispatcher (push_dispatcher.dispatchPendingPush) only ever forwards
 * `payload.title`, `payload.body`, and `payload.data` to the device: a missing
 * title shows a blank "Otopair" banner, and ONLY `payload.data` reaches the
 * phone, so a deep link and any field the app wants to route/render on must live
 * under `data`. This helper produces `{ title, body, ...extra, data: { deepLink,
 * bookingId, vehicleLabel, vin, ...extra } }`.
 *
 * `extra` (schedule fields, ids, etc.) is spread BOTH at the top level and under
 * `data` — additive, never a move. The web portal + in-app feed read some of
 * these fields at the payload top level (e.g. customer-scheduling-alerts.tsx
 * reads payload.newEndTime; notifications.getMyNotifications reads
 * payload.year/make/model), so we keep the top-level copies and mirror them into
 * `data` for the device. `payload` is an untyped column, so the duplication is
 * free. When `deepLink` is omitted it defaults to the confirmed base route
 * `otopair://booking/{bookingId}`.
 */
export function buildCustomerPushPayload({
  title,
  body,
  bookingId,
  deepLink,
  vehicleLabel,
  vin,
  extra,
}: {
  title: string;
  body: string;
  bookingId?: string | Id<"bookings">;
  /** Override the deep link; defaults to otopair://booking/{bookingId}. */
  deepLink?: string;
  /** e.g. "2021 Toyota Camry" from resolveVehicleDisplay().ymm. */
  vehicleLabel?: string | null;
  vin?: string | null;
  /** Context fields — mirrored top-level (feed/SMS) and under data (device). */
  extra?: Record<string, unknown>;
}) {
  const link =
    deepLink ?? (bookingId ? `otopair://booking/${String(bookingId)}` : undefined);
  return {
    title,
    body,
    ...(extra ?? {}),
    data: {
      ...(extra ?? {}),
      ...(link ? { deepLink: link } : {}),
      ...(bookingId ? { bookingId: String(bookingId) } : {}),
      ...(vehicleLabel ? { vehicleLabel } : {}),
      ...(vin ? { vin } : {}),
    },
  };
}

/**
 * Channel → its dispatcher action. Enqueue kicks the matching dispatcher via
 * `scheduler.runAfter` so delivery no longer waits up to a minute for the
 * polling cron. The 1-min `dispatch-pending-*` crons remain as a backstop.
 *
 * `front_desk` rows are read reactively by the shop UI (no dispatcher). `slack`
 * rows are written through a separate path and drained by their own cron — ops
 * alerts don't need instant delivery. `in_app` rows are the customer analogue:
 * they surface in the customer feed (getMyNotifications reads by user_id,
 * channel-agnostic) but have no dispatcher, so they never push — used for
 * acknowledgements of the customer's own actions (e.g. booking submitted).
 */
const CHANNEL_DISPATCHER: Record<string, any> = {
  push: internal.lib.push_dispatcher.dispatchPendingPush,
  sms: (internal as any).sms_dispatcher.dispatchPendingSms,
  email: (internal as any).email_dispatcher.dispatchPendingEmails,
};

export async function enqueueNotificationOutbox(
  ctx: any,
  {
    shopId,
    bookingId,
    userId,
    mechanicId,
    channel,
    category,
    dedupeKey,
    payload,
    scheduledForMs,
  }: {
    shopId?: any;
    bookingId?: any;
    userId?: any;
    mechanicId?: any;
    channel: "push" | "sms" | "front_desk" | "email" | "in_app";
    category: string;
    dedupeKey: string;
    payload: any;
    scheduledForMs?: number;
  },
) {
  // Dedupe against any still-OPEN row for this key — one that hasn't been
  // resolved yet (resolved_at == null), regardless of delivery status. This
  // stops a repeat event from stacking a second in-app card (or re-pushing)
  // while the first is still live. Dedupe keys are event-specific (booking +
  // category + timestamp/date), so the only collisions are idempotent
  // re-fires. `failed` rows are excluded so a genuine retry can produce a new
  // row. Once a row is resolved, a fresh event with the same key opens a new
  // one.
  const priorRows = await ctx.db
    .query("notification_outbox")
    .withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", dedupeKey))
    .collect();
  const openExisting = priorRows.find(
    (r: any) => r.resolved_at == null && r.status !== "failed",
  );
  if (openExisting) {
    // Deduped to a row that's already pending/claimable — no new kick needed.
    return openExisting._id;
  }

  const now = Date.now();
  const insertedId = await ctx.db.insert("notification_outbox", {
    shop_id: shopId,
    booking_id: bookingId,
    user_id: userId,
    mechanic_id: mechanicId,
    channel,
    category,
    status: "pending",
    dedupe_key: dedupeKey,
    payload,
    scheduled_for_ms: scheduledForMs,
    created_at: now,
    updated_at: now,
  });

  // Instant dispatch: kick the matching channel's dispatcher so this row goes
  // out now instead of on the next 1-min cron tick. A future-dated
  // scheduled_for_ms schedules the kick for that time (and the claim mutations
  // skip rows not yet due). We dedupe kicks per (channel[, time]) within a
  // single mutation via a ctx-scoped Set, so a bulk enqueue (e.g. a cron
  // cancelling many bookings at once) fires one kick per channel, not N — the
  // first dispatcher run drains every pending row anyway.
  const ref = CHANNEL_DISPATCHER[channel];
  if (ref && ctx.scheduler?.runAfter) {
    const delay =
      scheduledForMs && scheduledForMs > now ? scheduledForMs - now : 0;
    const kickKey = delay === 0 ? channel : `${channel}:${scheduledForMs}`;
    ctx._kickedChannels ??= new Set<string>();
    if (!ctx._kickedChannels.has(kickKey)) {
      ctx._kickedChannels.add(kickKey);
      await ctx.scheduler.runAfter(delay, ref, {});
    }
  }

  return insertedId;
}

/**
 * Categories whose notification is an ASK: it exists only so the customer can
 * act on it, and it is meaningless once the underlying decision is made.
 */
export const APPROVAL_ASK_CATEGORIES = [
  "booking_pre_job_pending",
  "booking_mid_job_pending",
  "booking_post_job_pending",
] as const;

/**
 * Close out a booking's outstanding approval asks.
 *
 * The outbox already has the right machinery — `resolved_at` is the RESOLVE
 * axis and the customer feed shows rows where it is null. Nothing on the
 * approval side ever set it, so an "Update from your mechanic" card outlived
 * the decision it was asking for: still listed, still carrying its call to
 * action, and opening onto "No estimate is waiting for your review" because
 * the open row it points at is gone. Bug #343.
 *
 * Deliberately NOT tied to the push. The push has already been delivered and
 * cannot be recalled; what we control is the in-app feed, which is where the
 * customer went back to and tapped again.
 *
 * `reason` drives copy elsewhere: "user_action" when they decided,
 * "superseded" when the shop withdrew, "expired" when the SLA ran out.
 */
export async function resolveApprovalAsks(
  ctx: any,
  args: {
    bookingId: unknown;
    reason: "user_action" | "superseded" | "expired";
    now?: number;
  },
): Promise<number> {
  const now = args.now ?? Date.now();
  const rows = await ctx.db
    .query("notification_outbox")
    .withIndex("by_booking_id", (q: any) => q.eq("booking_id", args.bookingId))
    .collect();
  const open = rows.filter(
    (r: any) =>
      r.resolved_at == null &&
      (APPROVAL_ASK_CATEGORIES as readonly string[]).includes(r.category),
  );
  for (const r of open) {
    await ctx.db.patch(r._id, {
      status: "resolved",
      // Resolving implies seen: the row is leaving the feed, so leaving it
      // unread would keep it in the bell's unread COUNT with nothing behind it.
      read_at: r.read_at ?? now,
      resolved_at: now,
      resolved_reason: args.reason,
      processed_at: r.processed_at ?? now,
      updated_at: now,
    });
  }
  return open.length;
}
