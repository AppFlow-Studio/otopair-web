import { internalMutation } from "../_generated/server";
import { universalConsumables } from "../lib/servicePartsReference";

/**
 * Seeds the universal-consumable lane: the make-agnostic parts the resolver
 * falls back to when a CORE role has no per-config enriched fitment (caliper
 * grease, crush washers, DOT4 brake fluid, wheel weights, fuel-system cleaner,
 * etc. — see SERVICE_PARTS_REFERENCE_DESIGN.md §5). For each entry returned by
 * `universalConsumables()` it upserts:
 *   - one oem_parts row (make_id null, category "consumable", subcategory =
 *     roleKey), keyed by a synthetic OEM number "OTOPAIR-UNIV-<ROLEKEY>";
 *   - one part_prices seed row (price_type "manual_seed", source_domain
 *     "otopair_seed") at the reference default price.
 *
 * Director can correct these prices later; the resolver's median + mechanic ±
 * nudges still apply on top. Skip-if-exists per row so re-runs are no-ops.
 *
 * Also patches the live `battery_replacement` service so requires_parts = true
 * (the corpus's stale seed had it false despite 83 fitment rows; live
 * deployments won't re-run seedServices, which is skip-if-data-present).
 *
 * Run via: npx convex run seeds/seedUniversalConsumables:seedUniversalConsumables
 */

/** Synthetic OEM number for a universal consumable: stable, collision-free,
 *  and obviously non-real (OTOPAIR-UNIV-CALIPER-GREASE). */
function universalOemNumber(roleKey: string): string {
  return "OTOPAIR-UNIV-" + roleKey.toUpperCase().replace(/_/g, "-");
}

export const seedUniversalConsumables = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let created = 0;
    let skipped = 0;

    for (const c of universalConsumables()) {
      const oemNumber = universalOemNumber(c.roleKey);

      // ── Upsert the oem_parts row (skip-if-exists by synthetic OEM number) ──
      let part = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number", (q) => q.eq("oem_part_number", oemNumber))
        .first();

      if (part) {
        skipped++;
      } else {
        const partId = await ctx.db.insert("oem_parts", {
          oem_part_number: oemNumber,
          name: c.name,
          category: "consumable",
          subcategory: c.roleKey,
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

      // ── Seed one price row if the part has none yet (skip-if-exists) ──
      const existingPrice = await ctx.db
        .query("part_prices")
        .withIndex("by_part", (q) => q.eq("part_id", part!._id))
        .first();

      if (!existingPrice) {
        await ctx.db.insert("part_prices", {
          part_id: part._id,
          price: c.defaultPriceUsd,
          price_type: "manual_seed",
          source_domain: "otopair_seed",
          refreshed_at: now,
          created_at: now,
        });
      }
    }

    // ── Live-patch stale requires_parts flags ──
    // battery_replacement: the corpus's stale seed had it false despite live
    // fitments. tire_balance: live-seeded false, but its rule declares core
    // wheel_weights — which now exist as a universal consumable, so the
    // service must be allowed to bill parts. The fluid services bill core
    // fluids (brake fluid, coolant, gear oil, PS fluid) but were seeded with
    // an explicit false — which BEATS serviceRequiresParts' slug fallback and
    // skipped the mechanic post-job parts confirmation. requires_parts does
    // NOT gate bookability (that trusts is_labor_only only).
    // transmission_service is deliberately ABSENT: not offered on prod
    // (user decision, Jul 2026) — leave its flags untouched until it launches.
    for (const slug of [
      "battery_replacement",
      "tire_balance",
      "brake_fluid_flush",
      "coolant_flush",
      "differential_service",
      "power_steering_flush",
    ]) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (svc && svc.requires_parts !== true) {
        await ctx.db.patch(svc._id, { requires_parts: true });
      }
    }

    console.log(
      `[seedUniversalConsumables] created=${created} skipped=${skipped} (of ${universalConsumables().length})`,
    );
    return { created, skipped };
  },
});
