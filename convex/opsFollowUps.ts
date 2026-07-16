// =============================================================================
// Ops portal · Follow-ups — /ops/follow-ups (Ops spec p.10).
// Queue (pending, next-to-fire first) · Sent · Dismissed + metrics strip
// (pending, sent 7d, sent→booking conversion). Cancel = ceremony (dismiss
// with reason). Create-wizard and send-now are DESCOPED — the sending engine
// is consumer-side (follow_ups.ts) and firing it from ops needs its own
// design pass; stated in the UI.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type FollowUpRow = {
  id: string;
  user: string | null;
  user_id: string;
  booking_id: string | null;
  vin: string;
  service: string | null;
  type: string;
  scheduled_for: number;
  status: string;
  message: string | null;
  sent_at: number | null;
  dismissed_reason: string | null;
  from_recommendation: boolean;
  led_to_booking: boolean;
};
export type FollowUpsResult = {
  queue: FollowUpRow[];
  sent: FollowUpRow[];
  dismissed: FollowUpRow[];
  metrics: { pending: number; sent_7d: number; conversion_pct: number | null };
};

export const board = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<FollowUpsResult> => {
    await requireDirector(ctx, token);
    const userName = new Map<string, string | null>();
    const serviceName = new Map<string, string | null>();
    const hydrate = async (r: {
      _id: unknown;
      user_id: import("./_generated/dataModel").Id<"users">;
      vin: string;
      service_id?: import("./_generated/dataModel").Id<"services">;
      follow_up_type: string;
      scheduled_for: number;
      status: string;
      message?: string;
      sent_at?: number;
      dismissed_reason?: string;
      recommendation_id?: unknown;
      booking_id?: unknown;
    }): Promise<FollowUpRow> => {
      const uid = String(r.user_id);
      if (!userName.has(uid)) {
        const u = await ctx.db.get(r.user_id);
        const uo = u as { name?: string; firstName?: string; email?: string } | null;
        userName.set(uid, uo?.name ?? uo?.firstName ?? uo?.email ?? null);
      }
      let service: string | null = null;
      if (r.service_id) {
        const sid = String(r.service_id);
        if (!serviceName.has(sid)) {
          const s = await ctx.db.get(r.service_id);
          serviceName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
        }
        service = serviceName.get(sid) ?? null;
      }
      return {
        id: String(r._id),
        user: userName.get(uid) ?? null,
        user_id: uid,
        booking_id: r.booking_id != null ? String(r.booking_id) : null,
        vin: r.vin,
        service,
        type: r.follow_up_type,
        scheduled_for: r.scheduled_for,
        status: r.status,
        message: r.message ?? null,
        sent_at: r.sent_at ?? null,
        dismissed_reason: r.dismissed_reason ?? null,
        from_recommendation: r.recommendation_id != null,
        led_to_booking: r.booking_id != null,
      };
    };

    // Each status window rides by_status_and_scheduled; volumes are small.
    const pendingRows = await ctx.db
      .query("follow_ups")
      .withIndex("by_status_and_scheduled", (q) => q.eq("status", "pending"))
      .take(200);
    const sentRows = await ctx.db
      .query("follow_ups")
      .withIndex("by_status_and_scheduled", (q) => q.eq("status", "sent"))
      .order("desc")
      .take(200);
    const dismissedRows = await ctx.db
      .query("follow_ups")
      .withIndex("by_status_and_scheduled", (q) => q.eq("status", "dismissed"))
      .order("desc")
      .take(100);

    const queue: FollowUpRow[] = [];
    for (const r of pendingRows) queue.push(await hydrate(r));
    queue.sort((a, b) => a.scheduled_for - b.scheduled_for); // next-to-fire on top
    const sent: FollowUpRow[] = [];
    for (const r of sentRows) sent.push(await hydrate(r));
    const dismissed: FollowUpRow[] = [];
    for (const r of dismissedRows) dismissed.push(await hydrate(r));

    const since7d = Date.now() - 7 * DAY;
    const sent7d = sent.filter((s) => (s.sent_at ?? 0) >= since7d);
    return {
      queue,
      sent,
      dismissed,
      metrics: {
        pending: queue.length,
        sent_7d: sent7d.length,
        conversion_pct:
          sent.length > 0 ? sent.filter((s) => s.led_to_booking).length / sent.length : null,
      },
    };
  },
});

export const cancel = mutation({
  args: { token: v.string(), reason: v.string(), id: v.id("follow_ups") },
  handler: async (ctx, { token, reason, id }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "users.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That follow-up no longer exists.");
    if (row.status !== "pending") throw new Error("Only pending follow-ups can be cancelled.");
    await ctx.db.patch(id, { status: "dismissed", dismissed_reason: `ops: ${reason.trim()}` });
    await logAudit(ctx, actor, {
      entity_type: "follow_up",
      entity_id: String(id),
      action: "follow_up_cancelled",
      detail: `${row.follow_up_type} for ${row.vin} — ${reason.trim()}`,
    });
    return { ok: true };
  },
});
