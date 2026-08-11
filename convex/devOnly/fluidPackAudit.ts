/**
 * devOnly/fluidPackAudit — how much jug-priced-as-per-quart exposure is
 * actually in the table, and what a fix would change.
 *
 * Fluids bill per quart x capacity, so a container price stored in the
 * per-unit column over-quotes by the pack size. The absolute price bands
 * catch the absurd ($102 oil is out of engine_oil's [4,40] band and already
 * excluded from customer math) but NOT the dangerous middle: a 5-quart jug at
 * $36 sits inside the band and bills as $36/qt.
 *
 * Reports, per fluid subcategory:
 *   rows_total / rows_over_ceiling      — how many read like container prices
 *   fixable_by_title                    — pack size stated, so normalizable
 *   unfixable_no_size                   — over ceiling, no size in the title
 *   parts_with_only_bad_rows            — the parts where the median CANNOT
 *                                         save the quote (every usable row is
 *                                         container-shaped)
 *   worst                               — concrete examples with the maths
 *
 *   npx convex run devOnly/fluidPackAudit:audit '{}'
 */
import { internalQuery, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { UNVERIFIED_PRICE_TYPE } from "../lib/priceTypes";
import {
  PACKAGED_FLUID_SUBCATEGORIES,
  FLUID_UNIT_CEILING_USD,
  detectPackQuarts,
  normalizeFluidPrice,
} from "../lib/fluidPackSize";
import { isPoisonPriceType, isNonPooledPriceType } from "../lib/priceTypes";
import { isWithinPriceBand, priceBandFor } from "../lib/priceBands";

export const audit = internalQuery({
  args: { limitPerSub: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const perSub: Record<string, any> = {};
    const worst: Array<Record<string, unknown>> = [];

    for (const sub of PACKAGED_FLUID_SUBCATEGORIES) {
      const parts = await ctx.db
        .query("oem_parts")
        .withIndex("by_subcategory", (q: any) => q.eq("subcategory", sub))
        .take(args.limitPerSub ?? 400);

      let rowsTotal = 0;
      let rowsOverCeiling = 0;
      let fixableByTitle = 0;
      let unfixableNoSize = 0;
      let partsOnlyBad = 0;
      let partsWithUsableRows = 0;

      for (const part of parts as any[]) {
        if (part.category === "consumable") continue; // seeds, not scraped
        const title = part.scraped_name ?? part.name ?? null;
        const prices = await ctx.db
          .query("part_prices")
          .withIndex("by_part", (q: any) => q.eq("part_id", part._id))
          .collect();

        // Only rows that can reach customer math matter.
        const usable = (prices as any[]).filter(
          (p) =>
            !isPoisonPriceType(p.price_type) &&
            !isNonPooledPriceType(p.price_type) &&
            typeof p.price === "number" &&
            p.price > 0 &&
            isWithinPriceBand(sub, p.price),
        );
        if (usable.length === 0) continue;
        partsWithUsableRows++;

        let badInThisPart = 0;
        for (const p of usable) {
          rowsTotal++;
          // An already-normalized row keeps its "(1 Gallon)" title, so judging
          // it again would report a permanent false positive.
          if ((p as any).pack_quarts != null) continue;
          const verdict = normalizeFluidPrice({ subcategory: sub, price: p.price, title });
          if (verdict.action === "normalized") {
            rowsOverCeiling++;
            fixableByTitle++;
            badInThisPart++;
            if (worst.length < 20) {
              worst.push({
                sub,
                oem: part.oem_part_number,
                title: String(title ?? "").slice(0, 70),
                stored: p.price,
                packQuarts: verdict.packQuarts,
                perQuart: verdict.price,
                price_type: p.price_type,
              });
            }
          } else if (verdict.action === "suspect_unpriceable") {
            rowsOverCeiling++;
            unfixableNoSize++;
            badInThisPart++;
            if (worst.length < 20) {
              worst.push({
                sub,
                oem: part.oem_part_number,
                title: String(title ?? "").slice(0, 70),
                stored: p.price,
                packQuarts: null,
                perQuart: null,
                price_type: p.price_type,
              });
            }
          }
        }
        if (badInThisPart > 0 && badInThisPart === usable.length) partsOnlyBad++;
      }

      perSub[sub] = {
        ceiling: FLUID_UNIT_CEILING_USD[sub] ?? null,
        parts_with_usable_rows: partsWithUsableRows,
        rows_total: rowsTotal,
        rows_over_ceiling: rowsOverCeiling,
        fixable_by_title: fixableByTitle,
        unfixable_no_size: unfixableNoSize,
        parts_with_only_bad_rows: partsOnlyBad,
      };
    }

    return { perSub, worst };
  },
});

/**
 * Repair existing rows the write-path gate now prevents.
 *
 * Two actions, mirroring the gate exactly:
 *   - a stated pack size → divide the stored price to per-unit (the row stays
 *     usable evidence, which is why this is normalization and not deletion —
 *     several OEM fluids are ONLY sold by the jug);
 *   - over the per-unit ceiling with no stated size → re-type `unverified`,
 *     which the poison list excludes from customer-facing math while keeping
 *     the row for audit.
 *
 * dryRun defaults TRUE. Nothing is written until it is passed false.
 *   npx convex run devOnly/fluidPackAudit:repair '{}'
 *   npx convex run devOnly/fluidPackAudit:repair '{"dryRun": false}'
 */
export const repair = internalMutation({
  args: { dryRun: v.optional(v.boolean()), limitPerSub: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    let normalized = 0;
    let quarantined = 0;
    const changes: Array<Record<string, unknown>> = [];

    for (const sub of PACKAGED_FLUID_SUBCATEGORIES) {
      const parts = await ctx.db
        .query("oem_parts")
        .withIndex("by_subcategory", (q: any) => q.eq("subcategory", sub))
        .take(args.limitPerSub ?? 400);

      for (const part of parts as any[]) {
        if (part.category === "consumable") continue;
        const title = part.scraped_name ?? part.name ?? null;
        const prices = await ctx.db
          .query("part_prices")
          .withIndex("by_part", (q: any) => q.eq("part_id", part._id))
          .collect();

        for (const p of prices as any[]) {
          if (isPoisonPriceType(p.price_type) || typeof p.price !== "number" || p.price <= 0) continue;
          // IDEMPOTENCE: a normalized row keeps its container title forever
          // ("… (1 Gallon)"), so without this guard a second pass would
          // divide an already-correct $8.57/qt down to $2.14. Caught live.
          if (p.pack_quarts != null) continue;
          const verdict = normalizeFluidPrice({ subcategory: sub, price: p.price, title });
          if (verdict.action === "normalized") {
            normalized++;
            if (changes.length < 25) {
              changes.push({
                sub, oem: part.oem_part_number, from: p.price,
                to: verdict.price, packQuarts: verdict.packQuarts, action: "normalize",
              });
            }
            if (!dryRun) {
              await ctx.db.patch(p._id, {
                price: verdict.price,
                pack_quarts: verdict.packQuarts ?? undefined,
              });
            }
          } else if (verdict.action === "suspect_unpriceable") {
            quarantined++;
            if (changes.length < 25) {
              changes.push({
                sub, oem: part.oem_part_number, from: p.price,
                to: p.price, action: "quarantine_unverified",
                title: String(title ?? "").slice(0, 50),
              });
            }
            if (!dryRun) await ctx.db.patch(p._id, { price_type: UNVERIFIED_PRICE_TYPE });
          }
        }
      }
    }
    return { dryRun, normalized, quarantined, changes };
  },
});

/**
 * One-time back-fill: stamp `pack_quarts` on rows an EARLIER repair pass
 * already normalized, before the marker existed.
 *
 * Identifies them without touching prices: the title states a container size,
 * the row carries no marker, and dividing again would drop the price BELOW
 * the subcategory's price-band floor — which is only true when the stored
 * value is already per-unit. (A genuine container price divides to something
 * inside the band; that is what the repair is for.)
 */
export const markAlreadyNormalized = internalMutation({
  args: { dryRun: v.optional(v.boolean()), limitPerSub: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    let stamped = 0;
    const rows: Array<Record<string, unknown>> = [];

    for (const sub of PACKAGED_FLUID_SUBCATEGORIES) {
      const band = priceBandFor(sub);
      if (!band) continue;
      const parts = await ctx.db
        .query("oem_parts")
        .withIndex("by_subcategory", (q: any) => q.eq("subcategory", sub))
        .take(args.limitPerSub ?? 400);

      for (const part of parts as any[]) {
        if (part.category === "consumable") continue;
        const title = part.scraped_name ?? part.name ?? null;
        const pack = detectPackQuarts(title);
        if (pack == null || pack < 2) continue;

        const prices = await ctx.db
          .query("part_prices")
          .withIndex("by_part", (q: any) => q.eq("part_id", part._id))
          .collect();
        for (const p of prices as any[]) {
          if (p.pack_quarts != null) continue;
          if (typeof p.price !== "number" || p.price <= 0) continue;
          if (p.price / pack >= band[0]) continue; // a real container price — leave for repair
          stamped++;
          if (rows.length < 20) {
            rows.push({ sub, oem: part.oem_part_number, price: p.price, pack });
          }
          if (!dryRun) await ctx.db.patch(p._id, { pack_quarts: pack });
        }
      }
    }
    return { dryRun, stamped, rows };
  },
});
