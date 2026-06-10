/**
 * devOnly/verifyParts — READ-ONLY parts+prices inspector for a config.
 *   npx convex run devOnly/verifyParts:parts '{"configKey":"2022_volkswagen_jetta_s_ea211"}'
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const parts = internalQuery({
  args: { configKey: v.string() },
  handler: async (ctx, { configKey }) => {
    const cfg = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q: any) => q.eq("config_key", configKey))
      .first();
    if (!cfg) return { error: "config not found" };

    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", (cfg as any)._id))
      .collect();
    const seen = new Set<string>();
    const out: any[] = [];
    for (const f of fitments as any[]) {
      if (seen.has(String(f.part_id))) continue;
      seen.add(String(f.part_id));
      const part = (await ctx.db.get(f.part_id)) as any;
      const prices = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q: any) => q.eq("part_id", f.part_id))
        .collect();
      out.push({
        oem: part?.oem_part_number,
        name: part?.part_name ?? part?.name ?? part?.subcategory,
        prices: (prices as any[]).map((p) => ({
          price: p.price,
          type: p.price_type,
          domain: p.source_domain,
        })),
      });
    }
    const allPrices = out.flatMap((p) => p.prices);
    const countOf = (t: string) => allPrices.filter((p) => p.type === t).length;
    return {
      parts: out.length,
      priceRows: allPrices.length,
      // Trustworthy (counts toward the customer median):
      sale: countOf("sale"),
      llm_estimate: countOf("llm_estimate"),
      manual_seed: countOf("manual_seed"),
      // Poison (excluded from the median):
      online_discount: countOf("online_discount"),
      you_save: countOf("you_save"),
      unverified: countOf("unverified"),
      detail: out,
    };
  },
});
