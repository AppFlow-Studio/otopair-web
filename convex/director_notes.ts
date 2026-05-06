import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { entity_type: v.string(), entity_id: v.string() },
  handler: async (ctx, { entity_type, entity_id }) => {
    return ctx.db
      .query("director_notes")
      .withIndex("by_entity", (q) => q.eq("entity_type", entity_type).eq("entity_id", entity_id))
      .order("asc")
      .collect();
  },
});

export const add = mutation({
  args: { entity_type: v.string(), entity_id: v.string(), author: v.string(), actorId: v.optional(v.id("director_users")), text: v.string() },
  handler: async (ctx, { actorId, ...args }) => {
    await ctx.db.insert("director_notes", { ...args, created_at: Date.now() });
    await ctx.db.insert("audit_log", {
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      action: "note_added",
      actor: args.author,
      actor_id: actorId,
      detail: args.text.length > 80 ? args.text.slice(0, 80) + "…" : args.text,
      created_at: Date.now(),
    });
  },
});
