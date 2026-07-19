// =============================================================================
// Ops portal · Reviews moderation — /ops/reviews (Ops spec p.10).
// "Needs eyes" default = rating ≤3 newest first. Hide = ceremony (reason,
// audit, never a delete — the row stays for the trail); hidden rows render
// as grey strips with Restore. Consumer reads must filter hidden_at.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";
import {
  resolveVehicleDisplay,
  resolveServiceNames,
  userDisplayName,
} from "./lib/bookingEnrichment";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  user: string | null;
  user_id: string;
  shop: string | null;
  shop_id: string;
  mechanic: string | null;
  mechanic_id: string | null;
  booking_id: string;
  // What was actually reviewed — joined through the booking so an operator
  // doesn't have to click through to see the car + job.
  vehicleYmm: string | null;
  services: string[];
  hidden: boolean;
  hidden_reason: string | null;
  hidden_by: string | null;
  at: number;
};

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ReviewRow[]> => {
    await requireDirector(ctx, token);
    // 24 rows measured — bounded window with headroom.
    const rows = await ctx.db.query("reviews").take(500);
    const userName = new Map<string, string | null>();
    const shopName = new Map<string, string | null>();
    const mechName = new Map<string, string | null>();
    // Cache the booking-derived context (vehicle + services) per booking_id.
    const bookingCtx = new Map<string, { vehicleYmm: string | null; services: string[] }>();
    const out: ReviewRow[] = [];
    for (const r of rows) {
      const uid = String(r.user_id);
      if (!userName.has(uid)) {
        // Users table uses first_name/last_name — resolve via the shared helper
        // (the old name?/firstName? guess silently returned null for everyone).
        userName.set(uid, userDisplayName(await ctx.db.get(r.user_id)));
      }
      const sid = String(r.shop_id);
      if (!shopName.has(sid)) {
        const s = await ctx.db.get(r.shop_id);
        shopName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
      }
      let mechanic: string | null = null;
      if (r.mechanic_id) {
        const mid = String(r.mechanic_id);
        if (!mechName.has(mid)) {
          const m = await ctx.db.get(r.mechanic_id);
          const mo = m as { first_name?: string; last_name?: string } | null;
          mechName.set(mid, mo ? [mo.first_name, mo.last_name].filter(Boolean).join(" ") || null : null);
        }
        mechanic = mechName.get(mid) ?? null;
      }
      const bid = String(r.booking_id);
      if (!bookingCtx.has(bid)) {
        const booking = await ctx.db.get(r.booking_id);
        if (booking) {
          const [vehicle, services] = await Promise.all([
            resolveVehicleDisplay(ctx, booking.vin),
            resolveServiceNames(ctx, booking.service_ids),
          ]);
          bookingCtx.set(bid, { vehicleYmm: vehicle.ymm, services });
        } else {
          bookingCtx.set(bid, { vehicleYmm: null, services: [] });
        }
      }
      const bctx = bookingCtx.get(bid)!;
      out.push({
        id: String(r._id),
        rating: r.rating,
        comment: r.comment ?? null,
        user: userName.get(uid) ?? null,
        user_id: uid,
        shop: shopName.get(sid) ?? null,
        shop_id: sid,
        mechanic,
        mechanic_id: r.mechanic_id ? String(r.mechanic_id) : null,
        booking_id: bid,
        vehicleYmm: bctx.vehicleYmm,
        services: bctx.services,
        hidden: r.hidden_at != null,
        hidden_reason: r.hidden_reason ?? null,
        hidden_by: r.hidden_by ?? null,
        at: r.created_at ?? r._creationTime,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  },
});

// -----------------------------------------------------------------------------
// Insights — rating distribution + per-shop / per-mechanic rollups. Computed
// over VISIBLE reviews (hidden rows are moderated out of aggregates). Turns the
// reviews page from a moderation queue into a network-quality read.
// -----------------------------------------------------------------------------
export type ReviewInsights = {
  total: number;
  avg: number | null;
  distribution: { rating: number; count: number }[]; // 1..5, always all five
  topShops: { id: string; name: string; avg: number; count: number }[];
  worstShops: { id: string; name: string; avg: number; count: number }[];
  topMechanics: { id: string; name: string; avg: number; count: number }[];
};

export const insights = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ReviewInsights> => {
    await requireDirector(ctx, token);
    const rows = (await ctx.db.query("reviews").take(1000)).filter(
      (r) => r.hidden_at == null,
    );

    const dist = new Map<number, number>([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    const byShop = new Map<string, { sum: number; count: number }>();
    const byMech = new Map<string, { sum: number; count: number }>();
    let sum = 0;
    for (const r of rows) {
      const rating = Math.max(1, Math.min(5, Math.round(r.rating)));
      dist.set(rating, (dist.get(rating) ?? 0) + 1);
      sum += r.rating;
      const sid = String(r.shop_id);
      const sAgg = byShop.get(sid) ?? { sum: 0, count: 0 };
      sAgg.sum += r.rating;
      sAgg.count += 1;
      byShop.set(sid, sAgg);
      if (r.mechanic_id) {
        const mid = String(r.mechanic_id);
        const mAgg = byMech.get(mid) ?? { sum: 0, count: 0 };
        mAgg.sum += r.rating;
        mAgg.count += 1;
        byMech.set(mid, mAgg);
      }
    }

    // Resolve names for the rollup entities (bounded by distinct shops/mechs).
    const shopRollup = await Promise.all(
      [...byShop.entries()].map(async ([id, agg]) => {
        const s = await ctx.db.get(id as import("./_generated/dataModel").Id<"shops">);
        return {
          id,
          name: (s as { name?: string } | null)?.name ?? "Unknown shop",
          avg: agg.sum / agg.count,
          count: agg.count,
        };
      }),
    );
    const mechRollup = await Promise.all(
      [...byMech.entries()].map(async ([id, agg]) => {
        const m = await ctx.db.get(id as import("./_generated/dataModel").Id<"mechanics">);
        const mo = m as { first_name?: string; last_name?: string } | null;
        return {
          id,
          name: mo ? [mo.first_name, mo.last_name].filter(Boolean).join(" ") || "Unknown" : "Unknown",
          avg: agg.sum / agg.count,
          count: agg.count,
        };
      }),
    );

    // Rank shops with a minimum sample so a single 5★ doesn't top the board.
    const ranked = shopRollup
      .filter((s) => s.count >= 2)
      .sort((a, b) => b.avg - a.avg);

    return {
      total: rows.length,
      avg: rows.length > 0 ? sum / rows.length : null,
      distribution: [1, 2, 3, 4, 5].map((rating) => ({
        rating,
        count: dist.get(rating) ?? 0,
      })),
      topShops: ranked.slice(0, 5),
      worstShops: [...ranked].reverse().slice(0, 5),
      topMechanics: mechRollup
        .filter((m) => m.count >= 2)
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 5),
    };
  },
});

export const hide = mutation({
  args: { token: v.string(), reason: v.string(), id: v.id("reviews") },
  handler: async (ctx, { token, reason, id }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "users.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That review no longer exists.");
    if (row.hidden_at != null) throw new Error("Already hidden.");
    await ctx.db.patch(id, {
      hidden_at: Date.now(),
      hidden_reason: reason.trim(),
      hidden_by: actor.name,
    });
    await logAudit(ctx, actor, {
      entity_type: "review",
      entity_id: String(id),
      action: "review_hidden",
      detail: `${row.rating}★ review hidden — ${reason.trim()}`,
    });
    return { ok: true };
  },
});

export const restore = mutation({
  args: { token: v.string(), reason: v.string(), id: v.id("reviews") },
  handler: async (ctx, { token, reason, id }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "users.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That review no longer exists.");
    if (row.hidden_at == null) throw new Error("Not hidden.");
    await ctx.db.patch(id, {
      hidden_at: undefined,
      hidden_reason: undefined,
      hidden_by: undefined,
    });
    await logAudit(ctx, actor, {
      entity_type: "review",
      entity_id: String(id),
      action: "review_restored",
      detail: `${row.rating}★ review restored (was: ${row.hidden_reason ?? "?"}) — ${reason.trim()}`,
    });
    return { ok: true };
  },
});
