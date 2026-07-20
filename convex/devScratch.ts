import { mutation } from "./_generated/server";
import { v } from "convex/values";

// TEMP — set a fitment's confidence (returns old value). Delete after testing.
export const setFitmentConfidence = mutation({
  args: { fitmentId: v.id("part_fitments"), confidence: v.number() },
  handler: async (ctx, args) => {
    const f = await ctx.db.get(args.fitmentId);
    if (!f) return { error: "no fitment" };
    const old = f.confidence ?? null;
    await ctx.db.patch(args.fitmentId, { confidence: args.confidence });
    return { old, set: args.confidence };
  },
});
