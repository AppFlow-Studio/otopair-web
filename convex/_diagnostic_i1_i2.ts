/**
 * convex/_diagnostic_i1_i2.ts
 *
 * ⚠️  TEMPORARY DIAGNOSTIC — READ-ONLY — REMOVE AFTER RUNNING.  ⚠️
 *
 * One internalQuery that measures, SERVER-SIDE over the FULL tables (the MCP
 * 100-row/no-cursor cap blocks doing this from the client), two things:
 *   - I1 deploy-safety: does the make-predicate guard strip any (config, role)
 *     group down to ZERO candidates (a coverage hole)?  Split into
 *     consumable (seed-covered) vs non-consumable (real hole).
 *   - I2 blast radius: how many cross-make fitments / parts / configs exist,
 *     plus the clone-contaminated config set and override make-blindness.
 *
 * HARD INVARIANT: this file contains NO mutations and NO writes — no
 * patch/insert/delete/replace anywhere. It only reads and returns counts plus
 * small capped sample arrays. It is NOT part of the product. DELETE this file
 * once you have the numbers.
 *
 * The make-guard predicate below is a copy of `partFitsConfigMake`
 * (convex/partSelector.ts) so this diagnostic does not import the (unshipped)
 * I1 change and can run against a deployment that doesn't have it yet.
 */
import { internalQuery } from "./_generated/server";
import {
  normalizeServiceSlug,
  roleForSubcategory,
} from "./lib/servicePartsReference";

// Mirror of partSelector.partFitsConfigMake — kept local on purpose.
function fitsMake(
  partMakeId: unknown,
  configMakeId: unknown,
): boolean {
  if (partMakeId == null) return true; // universal consumable — no make to clash
  if (configMakeId == null) return true; // config make unknown — don't filter
  return String(partMakeId) === String(configMakeId);
}

export const diagnose = internalQuery({
  args: {},
  handler: async (ctx) => {
    // ── Load the small reference tables once. part_prices is deliberately NOT
    //    read: B4/contamination is derivable from fitments + config makes, and
    //    skipping ~3k rows keeps us well under the per-query read ceiling. ────
    const [parts, configs, fitments, rules, stickies, makes] = await Promise.all([
      ctx.db.query("oem_parts").collect(),
      ctx.db.query("vehicle_configs").collect(),
      ctx.db.query("part_fitments").collect(),
      ctx.db.query("service_parts_rules").collect(),
      ctx.db.query("vehicle_part_preferences").collect(),
      ctx.db.query("makes").collect(),
    ]);

    const makeName = new Map<string, string>(
      makes.map((m) => [String(m._id), (m as any).name ?? String(m._id)]),
    );
    const nm = (mid: unknown): string =>
      mid == null ? "(none)" : makeName.get(String(mid)) ?? String(mid);
    const partById = new Map(parts.map((p) => [String(p._id), p]));
    const configById = new Map(configs.map((c) => [String(c._id), c]));

    // ── A) I1 OVER-STRIP / COVERAGE ─────────────────────────────────────────
    // Group fitments by (config, normalized service_type, roleKey) mirroring
    // resolveWinningPartForService's role grouping (serviceParts.ts:811-821).
    // The billable-subcategory allowlist and position filter are intentionally
    // NOT applied — the make guard is orthogonal to both — see `assumptions`.
    type Grp = {
      configId: string;
      configMakeId: unknown;
      slug: string;
      roleKey: string;
      hasUniversalFallback: boolean;
      before: Array<{ part: any }>;
      after: Array<{ part: any }>;
    };
    const groups = new Map<string, Grp>();
    for (const f of fitments) {
      if (!f.service_type) continue; // not a selection candidate (resolver queries by_config_service)
      const part = partById.get(String(f.part_id));
      if (!part) continue;
      const config = configById.get(String(f.vehicle_config_id));
      if (!config) continue;
      const slug = normalizeServiceSlug(f.service_type);
      const role = roleForSubcategory(slug, part.subcategory, part.category);
      const roleKey =
        role?.roleKey ??
        (part.subcategory ?? part.category ?? "unknown").toLowerCase();
      const key = `${String(f.vehicle_config_id)}|${slug}|${roleKey}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          configId: String(f.vehicle_config_id),
          configMakeId: (config as any).make_id,
          slug,
          roleKey,
          hasUniversalFallback: role?.universalFallback != null,
          before: [],
          after: [],
        };
        groups.set(key, g);
      }
      g.before.push({ part });
      if (fitsMake(part.make_id, (config as any).make_id)) g.after.push({ part });
    }

    let safeGroups = 0;
    let zeroConsumable = 0;
    let zeroNonConsumable = 0;
    const nonConsumableHoleSample: any[] = [];
    for (const g of groups.values()) {
      if (g.before.length === 0) continue;
      if (g.after.length >= 1) {
        safeGroups++;
        continue;
      }
      // Zero survivors: classify consumable (seed-covered → safe) vs not.
      const allConsumable = g.before.every(
        (c) => (c.part.category ?? "").toLowerCase() === "consumable",
      );
      if (g.hasUniversalFallback || allConsumable) {
        zeroConsumable++;
      } else {
        zeroNonConsumable++;
        if (nonConsumableHoleSample.length < 40) {
          const dropped = g.before[0].part;
          nonConsumableHoleSample.push({
            config_id: g.configId,
            config_make: nm(g.configMakeId),
            service: g.slug,
            role: g.roleKey,
            dropped_candidate_count: g.before.length,
            dropped_part_number: dropped.oem_part_number,
            dropped_part_make: nm(dropped.make_id),
          });
        }
      }
    }

    // ── B/C) cross-make fitments + per-part make spread ─────────────────────
    let crossMakeFitments = 0;
    const crossPartIds = new Set<string>();
    const crossConfigIds = new Set<string>();
    // For each part: which distinct config-makes is it fitted to, and on which
    // configs. Used for "spans >1 make" (B4) and clone contamination (C).
    const configMakesByPart = new Map<string, Set<string>>();
    const configIdsByPart = new Map<string, Set<string>>();
    for (const f of fitments) {
      const part = partById.get(String(f.part_id));
      if (!part) continue;
      const config = configById.get(String(f.vehicle_config_id));
      if (!config) continue;
      const pid = String(f.part_id);
      const cMake = String((config as any).make_id);
      (configMakesByPart.get(pid) ?? configMakesByPart.set(pid, new Set()).get(pid)!).add(cMake);
      (configIdsByPart.get(pid) ?? configIdsByPart.set(pid, new Set()).get(pid)!).add(
        String(f.vehicle_config_id),
      );
      if (part.make_id != null && String(part.make_id) !== cMake) {
        crossMakeFitments++;
        crossPartIds.add(pid);
        crossConfigIds.add(String(f.vehicle_config_id));
      }
    }

    // B4 / C restricted to MAKE-STAMPED parts (a make-null universal consumable
    // fitted across makes is by-design, not contamination — reported separately).
    let makeStampedPartsSpanningMultiMake = 0;
    let consumableNullMakePartsSpanningMultiMake = 0;
    const contaminatedConfigs = new Set<string>();
    const multiMakePartSample: any[] = [];
    for (const [pid, makeSet] of configMakesByPart) {
      if (makeSet.size <= 1) continue;
      const part = partById.get(pid);
      if (part?.make_id != null) {
        makeStampedPartsSpanningMultiMake++;
        for (const cid of configIdsByPart.get(pid) ?? []) contaminatedConfigs.add(cid);
        if (multiMakePartSample.length < 20) {
          multiMakePartSample.push({
            part_id: pid,
            oem_part_number: part.oem_part_number,
            part_make: nm(part.make_id),
            fitted_to_makes: [...makeSet].map(nm),
            fitted_config_count: (configIdsByPart.get(pid) ?? new Set()).size,
          });
        }
      } else {
        consumableNullMakePartsSpanningMultiMake++;
      }
    }

    // ── D) OVERRIDE MAKE-BLINDNESS ──────────────────────────────────────────
    // D1: director-pinned parts. A pin is service-scoped (applies to EVERY make
    // booking that service), so a pinned part carrying a non-null make_id is
    // wrong for every other make by construction.
    let pinnedTotal = 0;
    let pinnedMakeSpecific = 0;
    const pinnedSample: any[] = [];
    for (const r of rules) {
      for (const p of ((r as any).pinned_parts ?? []) as Array<{
        subcategory: string;
        part_id: string;
      }>) {
        pinnedTotal++;
        const part = partById.get(String(p.part_id));
        if (part?.make_id != null) {
          pinnedMakeSpecific++;
          if (pinnedSample.length < 20) {
            pinnedSample.push({
              service_id: String((r as any).service_id),
              subcategory: p.subcategory,
              pinned_part_number: part.oem_part_number,
              pinned_part_make: nm(part.make_id),
            });
          }
        }
      }
    }

    // D2: VIN-sticky prefs whose part make != the vin's config make.
    let stickyTotal = 0;
    let stickyResolved = 0;
    let stickyWrongMake = 0;
    const stickySample: any[] = [];
    for (const s of stickies) {
      stickyTotal++;
      const part = partById.get(String(s.part_id));
      if (part?.make_id == null) continue; // universal — can't be wrong-make
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", s.vin))
        .first();
      const cfg = vehicle?.vehicle_config_id
        ? configById.get(String(vehicle.vehicle_config_id))
        : null;
      if (!cfg) continue;
      stickyResolved++;
      if (String(part.make_id) !== String((cfg as any).make_id)) {
        stickyWrongMake++;
        if (stickySample.length < 20) {
          stickySample.push({
            vin: s.vin,
            sticky_part_number: part.oem_part_number,
            sticky_part_make: nm(part.make_id),
            config_make: nm((cfg as any).make_id),
          });
        }
      }
    }

    return {
      _warning:
        "TEMPORARY READ-ONLY DIAGNOSTIC — delete convex/_diagnostic_i1_i2.ts after reading.",
      denominators: {
        oem_parts: parts.length,
        vehicle_configs: configs.length,
        part_fitments: fitments.length,
        makes: makes.length,
        service_parts_rules: rules.length,
        vehicle_part_preferences: stickies.length,
      },
      assumptions:
        "A) Groups RAW fitments (with a non-null service_type) by (config, normalizeServiceSlug(service_type), roleForSubcategory roleKey). Billable-subcategory allowlist and front/rear position filter are NOT applied — the make guard is orthogonal to both, so 'real holes' is a conservative upper bound. Consumable/seed-covered = the matched reference role has a universalFallback OR every dropped candidate has category=='consumable'. B/C contamination is restricted to MAKE-STAMPED parts (make_id != null); make-null universal consumables spanning makes are counted separately as by-design.",
      A_i1_coverage: {
        total_config_role_groups: groups.size,
        safe_groups_retain_ge_1_after_guard: safeGroups,
        zero_survivor_consumable_seed_covered: zeroConsumable,
        zero_survivor_NON_consumable_REAL_HOLES: zeroNonConsumable,
        non_consumable_hole_sample: nonConsumableHoleSample,
      },
      B_i2_blast_radius: {
        cross_make_fitments: crossMakeFitments,
        distinct_oem_parts_involved: crossPartIds.size,
        distinct_vehicle_configs_involved: crossConfigIds.size,
        distinct_make_stamped_parts_spanning_multiple_makes:
          makeStampedPartsSpanningMultiMake,
        consumable_null_make_parts_spanning_multiple_makes_BY_DESIGN:
          consumableNullMakePartsSpanningMultiMake,
      },
      C_clone_contamination: {
        contaminated_config_count: contaminatedConfigs.size,
        note: "Configs sharing >=1 MAKE-STAMPED part_id with a config of a different make (source + target of a cross-make clone).",
        multi_make_part_sample: multiMakePartSample,
      },
      D_override_make_blindness: {
        pinned_parts_total: pinnedTotal,
        pinned_parts_make_specific: pinnedMakeSpecific,
        pinned_make_specific_gt_0: pinnedMakeSpecific > 0,
        pinned_sample: pinnedSample,
        vin_sticky_total: stickyTotal,
        vin_sticky_resolved_to_config: stickyResolved,
        vin_sticky_wrong_make: stickyWrongMake,
        vin_sticky_wrong_make_gt_0: stickyWrongMake > 0,
        vin_sticky_sample: stickySample,
      },
    };
  },
});
