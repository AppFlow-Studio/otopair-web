import { internalMutation } from "../_generated/server";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("blocked_domains")
      .withIndex("by_domain", (q) => q.eq("domain", "ebay.com"))
      .first();
    if (existing) {
      console.log("ebay.com already blocked");
      return;
    }
    await ctx.db.insert("blocked_domains", {
      domain: "ebay.com",
      reason: "Marketplace listings — extracts seller SKUs and listing IDs, not OEM part numbers",
      blocked_by: "manual",
      blocked_at: Date.now(),
      created_at: Date.now(),
    });
    console.log("Blocked ebay.com");
  },
});
