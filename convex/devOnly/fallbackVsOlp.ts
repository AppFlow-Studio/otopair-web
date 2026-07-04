/**
 * devOnly/fallbackVsOlp — READ-ONLY export of the labor tier-fallback inputs
 * needed to compare the Camry-anchored tier_estimate fallback against OLP.
 *
 * For every enriched (non-fixture) vehicle_config it returns, per OLP-comparable
 * labor service:
 *   - camry_hours   : labor_times.book_hours for the 2020 Camry FWD anchor
 *   - labor_mult    : pricing_labor_multipliers[labor_category][tier].multiplier
 *                     (the ACTIVE v2 matrix the quote engine reads — read straight
 *                      from the DB, NOT the documented matrix, so it is verified)
 *   - fallback_hours: camry_hours * labor_mult   (== computeTierFloor output)
 *   - current_book_hours / current_source : this config's own labor_times row
 *
 * This mirrors computeTierFloor() in lib/quoteEngine.ts exactly (Camry book_hours
 * × labor multiplier for the config's tier). No DB writes.
 *
 *   npx convex run devOnly/fallbackVsOlp:dump --prod=false  > out.json
 */
import { internalQuery } from "../_generated/server";
import { CAMRY_FWD_CONFIG_KEY } from "../lib/laborFallback";

// The OLP-comparable labor services -> labor_category (per task GROUND TRUTH /
// seedServiceCategories). diagnostics-category services have no OLP equivalent.
const SERVICE_LABOR_CATEGORY: Record<string, string> = {
  oil_change: "routine",
  filter_replacement: "routine",
  brake_fluid_flush: "routine",
  battery_replacement: "routine",
  coolant_flush: "routine",
  transmission_service: "routine",
  differential_service: "routine",
  wheel_alignment: "routine",
  power_steering_flush: "routine",
  spark_plugs: "engine_access",
  timing_belt: "engine_access",
  brake_pad_replacement: "brakes",
  rotor_replacement: "brakes",
};

export const dump = internalQuery({
  args: {},
  handler: async (ctx) => {
    const services = (await ctx.db.query("services").collect()) as any[];
    const serviceBySlug = new Map(
      services.filter((s) => s.slug).map((s) => [s.slug, s]),
    );

    // labor category code -> _id
    const laborCats = (await ctx.db
      .query("pricing_labor_categories")
      .collect()) as any[];
    const catIdByCode = new Map(laborCats.map((c) => [c.code, c._id]));
    const catCodeById = new Map(laborCats.map((c) => [String(c._id), c.code]));

    // Full v2 labor multiplier matrix straight from DB: code+tier -> multiplier
    const multRows = (await ctx.db
      .query("pricing_labor_multipliers")
      .collect()) as any[];
    const multByCatTier = new Map<string, number>();
    const matrixDb: Record<string, Record<string, number>> = {};
    for (const r of multRows) {
      const code = catCodeById.get(String(r.labor_category_id)) ?? "?";
      multByCatTier.set(`${code}|${r.tier}`, r.multiplier);
      (matrixDb[code] ||= {})[r.tier] = r.multiplier;
    }

    // Camry FWD anchor + its labor_times book_hours per service_id.
    const camry = (await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) =>
        q.eq("config_key", CAMRY_FWD_CONFIG_KEY),
      )
      .first()) as any;
    const camryHoursBySlug = new Map<string, number | null>();
    if (camry) {
      const camryTimes = (await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", camry._id),
        )
        .collect()) as any[];
      const svcById = new Map(services.map((s) => [String(s._id), s]));
      for (const lt of camryTimes) {
        const svc = svcById.get(String(lt.service_id));
        if (svc?.slug)
          camryHoursBySlug.set(svc.slug, lt.book_hours ?? null);
      }
    }

    // pricing_vehicle_assignments cross-check: config_id -> tier code
    const assignments = (await ctx.db
      .query("pricing_vehicle_assignments")
      .collect()) as any[];
    const tiers = (await ctx.db.query("pricing_tiers").collect()) as any[];
    const tierCodeById = new Map(tiers.map((t) => [String(t._id), t.code]));
    const assignTierByConfig = new Map<string, string>();
    for (const a of assignments) {
      const code = a.tier_id ? tierCodeById.get(String(a.tier_id)) : null;
      if (a.vehicle_config_id && code)
        assignTierByConfig.set(String(a.vehicle_config_id), code);
    }

    const configs = (await ctx.db.query("vehicle_configs").collect()) as any[];
    const out: any[] = [];
    for (const cfg of configs) {
      const isEnriched = ["complete", "verified", "partial"].includes(
        cfg.enrichment_status ?? "",
      );
      const isFixture = String(cfg.config_key ?? "").includes("evaltest");
      if (!isEnriched || isFixture) continue;

      const tier: string | null = cfg.pricing_tier ?? null;
      const assignTier = assignTierByConfig.get(String(cfg._id)) ?? null;

      // this config's own labor_times
      const cfgTimes = (await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config_and_service", (q) =>
          q.eq("vehicle_config_id", cfg._id),
        )
        .collect()) as any[];
      const ownBySlug = new Map<string, any>();
      for (const lt of cfgTimes) {
        const svc = services.find((s) => String(s._id) === String(lt.service_id));
        if (svc?.slug) ownBySlug.set(svc.slug, lt);
      }

      const svcOut: any[] = [];
      for (const [slug, catCode] of Object.entries(SERVICE_LABOR_CATEGORY)) {
        const svc = serviceBySlug.get(slug);
        const svcCatId = svc?.labor_multiplier_category_id
          ? String(svc.labor_multiplier_category_id)
          : null;
        const svcCatCode = svcCatId ? catCodeById.get(svcCatId) : null;
        const camryH = camryHoursBySlug.get(slug) ?? null;
        const mult =
          tier != null ? multByCatTier.get(`${catCode}|${tier}`) ?? null : null;
        const fallback =
          camryH != null && mult != null ? camryH * mult : null;
        const own = ownBySlug.get(slug) ?? null;
        svcOut.push({
          slug,
          labor_category: catCode,
          // verify the service row actually maps to the same category in DB:
          db_labor_category: svcCatCode ?? null,
          camry_hours: camryH,
          labor_mult: mult,
          fallback_hours: fallback,
          current_book_hours: own?.book_hours ?? null,
          current_source: own?.source ?? null,
          current_confidence: own?.confidence ?? null,
        });
      }

      out.push({
        config_key: cfg.config_key,
        tier,
        assignment_tier: assignTier,
        tier_matches_assignment:
          assignTier == null ? null : assignTier === tier,
        services: svcOut,
      });
    }

    return {
      camry_present: !!camry,
      camry_hours_by_slug: Object.fromEntries(camryHoursBySlug),
      labor_matrix_db: matrixDb,
      config_count: out.length,
      configs: out,
    };
  },
});
