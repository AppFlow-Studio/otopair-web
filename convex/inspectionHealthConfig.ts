/**
 * convex/inspectionHealthConfig.ts — director CRUD for `inspection_health_config`,
 * the per-inspection-field severity/recommendation tuning table (see
 * convex/seed_inspection_health.ts for the default rows). Lower blast radius
 * than health_score_weights (this only affects the copy/urgency shown on
 * future inspection findings, not the live formula for every vehicle), so no
 * confirmation gate — same audit trail as every other director edit.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("inspection_health_config").collect();
    return rows.sort((a, b) => a.field_key.localeCompare(b.field_key));
  },
});

export const setRow = mutation({
  args: {
    fieldKey: v.string(),
    mapsTo: v.optional(v.string()),
    yellowStatus: v.optional(v.string()),
    redStatus: v.optional(v.string()),
    recServiceSlug: v.optional(v.string()),
    recUrgency: v.optional(v.string()),
    recCopy: v.optional(v.string()),
    actorName: v.optional(v.string()),
    actorId: v.optional(v.id("director_users")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const patch = {
      field_key: args.fieldKey,
      maps_to: args.mapsTo,
      yellow_status: args.yellowStatus,
      red_status: args.redStatus,
      rec_service_slug: args.recServiceSlug,
      rec_urgency: args.recUrgency,
      rec_copy: args.recCopy,
      updated_at: now,
      updated_by: args.actorId,
    };
    const existing = await ctx.db
      .query("inspection_health_config")
      .withIndex("by_field_key", (q) => q.eq("field_key", args.fieldKey))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("inspection_health_config", patch);
    }
    await ctx.db.insert("audit_log", {
      entity_type: "inspection_health_config",
      entity_id: args.fieldKey,
      action: "field_edit",
      actor: args.actorName ?? "Director",
      actor_id: args.actorId,
      detail: `${args.fieldKey}: rec_copy=${args.recCopy ?? "—"}, rec_urgency=${args.recUrgency ?? "—"}, rec_service_slug=${args.recServiceSlug ?? "—"}`,
      created_at: now,
    });
  },
});
