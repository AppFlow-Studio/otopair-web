// Retire the "Pre-Purchase Inspection" service — the business no longer offers
// it. This deletes the catalog definition PLUS everything that makes it
// offerable and priced: shop offerings, shop fixed prices, service options,
// the parts rule, pricing baselines, CCB absolute prices, reward/promo deals,
// and any config exclusions. Keyed by SLUG (not _id) so it runs UNCHANGED
// against every deployment — dev (third-bird-914), preview (ardent-crab-641),
// and prod each hold their own service _ids.
//
// What is intentionally LEFT INTACT:
//   • Historical customer records — bookings, labor/parts quote snapshots,
//     part_snapshots, job_recommendations, follow_ups, vehicle_service_states.
//     A booking can bundle other services, so deleting it would corrupt real
//     transaction history. These become harmless dangling references to a
//     retired service and should be preserved.
//   • Enrichment/reference tables — service_vehicle_specs, service_intervals,
//     labor_times, labor_observations, spec_confirmations, spec_variances,
//     mechanic_verifications, part preferences. Pre-Purchase Inspection is
//     is_labor_only (no parts/fluids/specs/intervals), so enrichment never
//     writes rows for it — there is nothing to sweep, and those tables carry
//     no by-service index to scan safely.
//
// Idempotent (re-running after a successful pass finds nothing) + dry-run-first:
//   npx convex run migrations/dropPrePurchaseInspection:run '{"dryRun":true}'   # preview counts
//   npx convex run migrations/dropPrePurchaseInspection:run '{}'                # execute
//   npx convex run --prod migrations/dropPrePurchaseInspection:run '{"dryRun":true}'  # prod, preview
//   npx convex run --prod migrations/dropPrePurchaseInspection:run '{}'              # prod, execute
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

const SLUG = "pre_purchase_inspection";

export type DropResult = {
  dryRun: boolean;
  found: boolean;
  serviceIds: string[];
  deleted: Record<string, number>;
  note: string;
};

const LEFT_INTACT_NOTE =
  "Historical bookings/snapshots/recommendations/follow-ups and labor-only " +
  "enrichment tables are intentionally preserved (see file header).";

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }): Promise<DropResult> => {
    // The services catalog is tiny (~two dozen rows); collect + match by slug.
    const services = await ctx.db.query("services").collect();
    const targets = services.filter((s) => s.slug === SLUG);
    const serviceIds = targets.map((s) => s._id);

    if (serviceIds.length === 0) {
      return {
        dryRun,
        found: false,
        serviceIds: [],
        deleted: {},
        note: `No service with slug "${SLUG}" — nothing to do.`,
      };
    }
    const idStrings = serviceIds.map((id) => String(id));
    const idSet = new Set(idStrings);

    // --- Gather dependents (indexed reads; one per target service id) ---------
    const serviceOptions: Doc<"service_options">[] = [];
    const partsRules: Doc<"service_parts_rules">[] = [];
    const pricingBaselines: Doc<"pricing_baselines">[] = [];
    const ccbPrices: Doc<"ccb_absolute_prices">[] = [];
    for (const sid of serviceIds) {
      serviceOptions.push(
        ...(await ctx.db
          .query("service_options")
          .withIndex("by_service_id", (q) => q.eq("service_id", sid))
          .collect()),
      );
      partsRules.push(
        ...(await ctx.db
          .query("service_parts_rules")
          .withIndex("by_service", (q) => q.eq("service_id", sid))
          .collect()),
      );
      pricingBaselines.push(
        ...(await ctx.db
          .query("pricing_baselines")
          .withIndex("by_service", (q) => q.eq("service_id", sid))
          .collect()),
      );
      ccbPrices.push(
        ...(await ctx.db
          .query("ccb_absolute_prices")
          .withIndex("by_service", (q) => q.eq("service_id", sid))
          .collect()),
      );
    }

    // --- Gather dependents (small config tables without a by-service index) ---
    const shopServices = (await ctx.db.query("shop_services").collect()).filter((r) =>
      idSet.has(String(r.service_id)),
    );
    const fixedPrices = (await ctx.db.query("shop_service_fixed_prices").collect()).filter((r) =>
      idSet.has(String(r.service_id)),
    );
    const exclusions = (await ctx.db.query("config_service_exclusions").collect()).filter(
      (r) => r.service_slug === SLUG,
    );
    const rewardDeals = (await ctx.db.query("reward_deals").collect()).filter(
      (r) => r.service_id != null && idSet.has(String(r.service_id)),
    );

    const deleted: Record<string, number> = {
      service_options: serviceOptions.length,
      service_parts_rules: partsRules.length,
      pricing_baselines: pricingBaselines.length,
      ccb_absolute_prices: ccbPrices.length,
      shop_services: shopServices.length,
      shop_service_fixed_prices: fixedPrices.length,
      config_service_exclusions: exclusions.length,
      reward_deals: rewardDeals.length,
      services: targets.length,
    };

    if (dryRun) {
      return { dryRun: true, found: true, serviceIds: idStrings, deleted, note: LEFT_INTACT_NOTE };
    }

    // --- Execute: dependents first, catalog row last --------------------------
    for (const r of serviceOptions) await ctx.db.delete(r._id);
    for (const r of partsRules) await ctx.db.delete(r._id);
    for (const r of pricingBaselines) await ctx.db.delete(r._id);
    for (const r of ccbPrices) await ctx.db.delete(r._id);
    for (const r of shopServices) await ctx.db.delete(r._id);
    for (const r of fixedPrices) await ctx.db.delete(r._id);
    for (const r of exclusions) await ctx.db.delete(r._id);
    for (const r of rewardDeals) await ctx.db.delete(r._id);
    for (const s of targets) await ctx.db.delete(s._id);

    await ctx.db.insert("audit_log", {
      entity_type: "services",
      entity_id: idStrings.join(","),
      action: "drop_service",
      actor: "system:dropPrePurchaseInspection",
      detail:
        `slug=${SLUG} ` +
        Object.entries(deleted)
          .map(([k, n]) => `${k}=${n}`)
          .join(" "),
      created_at: Date.now(),
    });

    return { dryRun: false, found: true, serviceIds: idStrings, deleted, note: LEFT_INTACT_NOTE };
  },
});
