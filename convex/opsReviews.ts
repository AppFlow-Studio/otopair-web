// =============================================================================
// Ops portal · Reviews moderation — /ops/reviews (Ops spec p.10).
// "Needs eyes" default = rating ≤3 newest first. Hide = ceremony (reason,
// audit, never a delete — the row stays for the trail); hidden rows render
// as grey strips with Restore. Consumer reads must filter hidden_at.
// =============================================================================
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  user: string | null;
  shop: string | null;
  mechanic: string | null;
  booking_id: string;
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
    const out: ReviewRow[] = [];
    for (const r of rows) {
      const uid = String(r.user_id);
      if (!userName.has(uid)) {
        const u = await ctx.db.get(r.user_id);
        const uo = u as { name?: string; firstName?: string; email?: string } | null;
        userName.set(uid, uo?.name ?? uo?.firstName ?? uo?.email ?? null);
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
      out.push({
        id: String(r._id),
        rating: r.rating,
        comment: r.comment ?? null,
        user: userName.get(uid) ?? null,
        shop: shopName.get(sid) ?? null,
        mechanic,
        booking_id: String(r.booking_id),
        hidden: r.hidden_at != null,
        hidden_reason: r.hidden_reason ?? null,
        hidden_by: r.hidden_by ?? null,
        at: r.created_at ?? r._creationTime,
      });
    }
    return out.sort((a, b) => b.at - a.at);
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
