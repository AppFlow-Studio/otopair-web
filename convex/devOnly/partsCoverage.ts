/**
 * devOnly/partsCoverage — READ-ONLY coverage report of a config's parts
 * against the Service Parts Reference PDF (the canonical "parts we're
 * supposed to get & price" — repo root, encoded in lib/servicePartsReference).
 *
 * Runs the REAL production resolver (resolveWinningPartForService) per
 * parts-bearing service and grades every declared PDF role:
 *
 *   priced      — role resolved to a part with >=1 trustworthy price row
 *   unpriced    — role resolved to a part but its price summary is EMPTY
 *                 (every row poison/unverified, or no rows) → bills $0
 *                 (price_unknown in the locked quote)
 *   missing     — no fitment resolved for the role at all (enrichment gap,
 *                 not-equipped conditional, or not-applicable to this car —
 *                 see `condition` to interpret)
 *   discovery   — if_found_bad roles: never auto-priced by design (reported
 *                 for completeness, not counted against coverage)
 *
 *   npx convex run devOnly/partsCoverage:coverage '{"configKey":"2022_volkswagen_jetta_s_ea211"}'
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import {
  SERVICE_PARTS_REFERENCE,
  normalizeServiceSlug,
} from "../lib/servicePartsReference";
import { resolveWinningPartForService } from "../serviceParts";
import { quoteUnitPrice } from "../part_prices";
import { isServiceApplicable } from "../services/applicability";

export const coverage = internalQuery({
  args: { configKey: v.string() },
  handler: async (ctx, { configKey }) => {
    const cfg = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q: any) => q.eq("config_key", configKey))
      .first();
    if (!cfg) return { error: "config not found" };

    // services table rows keyed by normalized slug (table stores underscore
    // and/or dash forms — normalize both sides).
    const allServices = await ctx.db.query("services").collect();
    const serviceBySlug = new Map<string, any>();
    for (const s of allServices as any[]) {
      if (s.slug) serviceBySlug.set(normalizeServiceSlug(s.slug), s);
    }

    const services: any[] = [];
    let coreTotal = 0;
    let corePriced = 0;
    let coreUnpriced = 0;
    let coreMissing = 0;

    // Applicability context: timing_belt service is N/A on chain engines —
    // grade its roles "not_applicable" instead of counting them as misses
    // (the chain cars' "missing timing belt" rows were noise in the Jun-10
    // reports; only belt engines should be held to those roles).
    const engine = (cfg as any).engine_id ? await ctx.db.get((cfg as any).engine_id) : null;
    const timingSystem = String((engine as any)?.timing_system ?? "").toLowerCase();
    const isChainEngine = timingSystem.includes("chain");

    // Full structural applicability — same gate the booking/quote surfaces
    // use (services/applicability.ts). Before Jul 2026 this tool only
    // special-cased timing_belt, so it graded PS flush on EPS cars and diff
    // service on FWD transaxles as real coverage (5-VIN test).
    const [chassisSpecs, drivetrainConfig, trimSpecs] = await Promise.all([
      (cfg as any).chassis_code
        ? ctx.db
            .query("chassis_specs")
            .withIndex("by_chassis_code", (q: any) => q.eq("chassis_code", (cfg as any).chassis_code))
            .first()
        : null,
      ctx.db
        .query("drivetrain_configs")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", (cfg as any)._id))
        .first(),
      ctx.db
        .query("trim_specs")
        .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", (cfg as any)._id))
        .first(),
    ]);

    for (const spec of Object.values(SERVICE_PARTS_REFERENCE)) {
      if (spec.laborOnly || spec.handledByDedicatedFlow) continue;

      const svc = serviceBySlug.get(spec.slug);
      if (!svc) {
        services.push({ slug: spec.slug, error: "no services row for slug" });
        continue;
      }

      const serviceNotApplicable =
        (spec.slug === "timing_belt" && isChainEngine) ||
        (engine != null &&
          !isServiceApplicable(svc, engine as any, chassisSpecs as any, drivetrainConfig as any, trimSpecs as any, cfg as any));

      const res = await resolveWinningPartForService(ctx, {
        vin: "", // no VIN-sticky preference in a config-level report
        serviceId: svc._id,
        serviceSlug: spec.slug,
        vehicleConfigId: (cfg as any)._id,
        confirmedPackages: new Set<string>(),
        // COVERAGE must grade BOTH axles. Without this, the resolver's
        // deliberate front-default for dual-primary services (serviceParts.ts
        // "Axle default" — a billing safety against silently charging both
        // axles) filters out every rear_* role, which made all rear roles
        // read "missing" in the Jun-10 reports even though the fitments
        // existed with correct positions (the retracted "axle lossiness").
        positionFilter: "both",
      });

      const winnerByRole = new Map(res.roleWinners.map((rw) => [rw.roleKey, rw]));
      const roles: any[] = [];
      for (const role of spec.roles) {
        const rw = winnerByRole.get(role.roleKey);
        const isDiscovery = role.condition === "if_found_bad";
        let status: string;
        let detail: any = undefined;
        if (serviceNotApplicable) {
          // Roles still resolving here are leftover pollution worth seeing,
          // but none of them count toward the locked totals.
          status = rw ? "not_applicable_but_present" : "not_applicable";
          roles.push({ roleKey: role.roleKey, serviceRole: role.serviceRole, status });
          continue;
        }
        if (rw) {
          const summary = rw.candidate.priceSummary;
          status = summary.sample_size > 0 ? "priced" : "unpriced";
          detail = {
            part: rw.candidate.part.name ?? rw.candidate.part.oem_part_number,
            oem: rw.candidate.part.oem_part_number,
            unit_price: quoteUnitPrice(summary),
            sample_size: summary.sample_size,
            quantity: rw.quantity,
            source: rw.source,
            virtual: rw.virtual === true ? true : undefined,
          };
        } else {
          status = isDiscovery ? "discovery" : "missing";
        }
        if (!isDiscovery) {
          const locked =
            role.serviceRole === "core" ||
            (role.serviceRole === "kit" && role.includeByDefault === true);
          if (locked) {
            coreTotal++;
            if (status === "priced") corePriced++;
            else if (status === "unpriced") coreUnpriced++;
            else coreMissing++;
          }
        }
        roles.push({
          roleKey: role.roleKey,
          serviceRole: role.serviceRole,
          condition: role.condition,
          status,
          ...(detail ? { detail } : {}),
        });
      }

      // Winners outside the declared reference (ad-hoc role groups).
      const declared = new Set(spec.roles.map((r) => r.roleKey));
      const adHoc = res.roleWinners
        .filter((rw) => !declared.has(rw.roleKey))
        .map((rw) => ({
          roleKey: rw.roleKey,
          part: rw.candidate.part.name ?? rw.candidate.part.oem_part_number,
          priced: rw.candidate.priceSummary.sample_size > 0,
        }));

      services.push({ slug: spec.slug, roles, ...(adHoc.length ? { adHoc } : {}) });
    }

    return {
      configKey,
      configId: String((cfg as any)._id),
      // Applicability basis for the timing_belt grading — surface it so a
      // wrong engine classification is visible in every report.
      timing_system: timingSystem || null,
      // Locked-quote coverage: core + default-kit roles (what the PDF says
      // must be on essentially every invoice).
      lockedRoles: { total: coreTotal, priced: corePriced, unpriced: coreUnpriced, missing: coreMissing },
      services,
    };
  },
});
