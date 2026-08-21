import { internalMutation } from "../_generated/server";
import { OE_OIL_CATALOG } from "../vehicleEnrichment/oilCatalog";

/**
 * Seeds ONE universal-consumable row per SAE oil grade.
 *
 * WHY: the universal-consumable lane holds a single generic
 * `OTOPAIR-UNIV-ENGINE-OIL` ("Engine oil (per quart)", $11) which
 * synthesizeUniversalCandidate hands to EVERY vehicle whose oil-change role
 * has no enriched fitment. Four of the last ten enriched vehicles (RDX,
 * CX-30, XC90, Palisade) took it — so their invoices billed a nameless
 * "engine oil" at one flat price regardless of whether the sump needs 0W-8,
 * 0W-20 or 15W-40. The grade is the one safety-critical fact about oil, and
 * it was the one fact the line did not carry.
 *
 * These rows are make-agnostic (make_id null) exactly like the generic one,
 * which is what keeps them clear of the cross-make read guard: a graded oil
 * row serves a Buick and an Acura alike without ever being "another make's
 * part". Prices are the catalog's market-typical per-quart defaults and are
 * superseded the moment real observed pricing lands.
 *
 * Skip-if-exists per row, so re-runs are no-ops and director price edits
 * are never clobbered.
 *
 * Run: npx convex run seeds/seedOilGrades:seedOilGrades
 */
export const seedOilGrades = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let created = 0;
    let skipped = 0;
    let pricesSeeded = 0;
    let pricesRepriced = 0;

    for (const row of Object.values(OE_OIL_CATALOG)) {
      let part = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q) => q.eq("oem_part_number", row.identifier))
        .first();

      if (part) {
        skipped++;
      } else {
        const partId = await ctx.db.insert("oem_parts", {
          oem_part_number: row.identifier,
          name: row.name,
          category: "consumable",
          // Same roleKey the resolver groups on — these compete in the
          // engine_oil role like the generic row does.
          subcategory: "engine_oil",
          part_tier: "aftermarket",
          is_current: true,
          data_quality: "manual_seed",
          first_seen_at: now,
          created_at: now,
        });
        created++;
        part = await ctx.db.get(partId);
      }
      if (!part) continue;

      const existingPrice = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", part!._id))
        .first();
      if (!existingPrice) {
        await ctx.db.insert("part_prices", {
          part_id: part._id,
          price: row.pricePerQuartUsd,
          price_type: "manual_seed",
          source_domain: "otopair_seed",
          refreshed_at: now,
          created_at: now,
        });
        pricesSeeded++;
      } else if (
        // Re-derived catalog prices must reach rows seeded by an EARLIER run
        // (the Aug 9 estimates were replaced by observed medians). Strictly
        // limited to OUR OWN untouched seed row: a director correction or a
        // real scraped price is never overwritten.
        existingPrice.price_type === "manual_seed" &&
        existingPrice.source_domain === "otopair_seed" &&
        Number(existingPrice.price) !== row.pricePerQuartUsd
      ) {
        await ctx.db.patch(existingPrice._id, {
          price: row.pricePerQuartUsd,
          refreshed_at: now,
        });
        pricesRepriced++;
      }
    }

    return {
      grades: Object.keys(OE_OIL_CATALOG).length,
      created,
      skipped,
      pricesSeeded,
      pricesRepriced,
    };
  },
});
