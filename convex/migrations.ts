import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const backfillModelMakeId = mutation({
  args: { makeId: v.id("makes") },
  handler: async (ctx, args) => {
    const models = await ctx.db.query("models").collect();
    let updated = 0;

    for (const model of models) {
      if (model.make_id === undefined || model.make_id === null) {
        await ctx.db.patch(model._id, { make_id: args.makeId });
        updated += 1;
      }
    }

    return { updated };
  },
});
