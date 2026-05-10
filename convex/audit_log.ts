import { query } from "./_generated/server";
import { v } from "convex/values";

export const listByEntity = query({
  args: { entity_type: v.string(), entity_id: v.string() },
  handler: async (ctx, { entity_type, entity_id }) => {
    return ctx.db
      .query("audit_log")
      .withIndex("by_entity", (q) => q.eq("entity_type", entity_type).eq("entity_id", entity_id))
      .order("asc")
      .collect();
  },
});

export const listRecent = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("audit_log")
      .withIndex("by_created_at")
      .order("desc")
      .take(200);
  },
});
