// =============================================================================
// audit_log reads — director-token-gated (Jun-10 IDOR sweep review fix).
//
// Rows carry director names/actor ids for every review action, and the
// failed-login rows embed raw director email addresses in the detail text.
// As public queries these handed the full review trail to anyone with the
// deployment URL.
// =============================================================================
import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireDirector } from "./directorGate";

export const listByEntity = query({
  args: { entity_type: v.string(), entity_id: v.string(), token: v.string() },
  handler: async (ctx, { entity_type, entity_id, token }) => {
    await requireDirector(ctx, token);
    return ctx.db
      .query("audit_log")
      .withIndex("by_entity", (q) => q.eq("entity_type", entity_type).eq("entity_id", entity_id))
      .order("asc")
      .collect();
  },
});

export const listRecent = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    return ctx.db
      .query("audit_log")
      .withIndex("by_created_at")
      .order("desc")
      .take(200);
  },
});
