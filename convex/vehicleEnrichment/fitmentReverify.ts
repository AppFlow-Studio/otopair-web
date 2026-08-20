/**
 * vehicleEnrichment/fitmentReverify.ts — fleet re-adjudication of stored
 * fitments with the current verifier.
 *
 * WHY. The Aug 20 2026 rung validation ground-truthed one session's confirmed
 * writes against dealer fitment tables and 3 of 8 were wrong — a 2.4L I4 plug
 * on a 3.5L V6, a rotor with zero catalog existence, a "without Sport" pad set
 * on a Sport. Every PRE-EXISTING fitment in the fleet was approved by that
 * same (weaker) verifier configuration, so the stock must be re-adjudicated
 * with the hardened one, not just the flow. This module is also the standing
 * audit mechanism: re-runnable, budgeted, cursor-paged, so a cron can later
 * sweep the fleet on a cadence (plan P3).
 *
 * THE DELETE STANDARD IS STRICTER THAN THE IN-RUN GATE. In-run, one refute
 * deletes (the part was just written and re-sourcing is cheap). A fleet sweep
 * is destructive at scale and verdicts carry single-sample variance (observed
 * live: the same rotor flipped confirmed→refuted across runs on a genuine
 * build-date split). So a part is removed only when it is refuted TWICE — the
 * refuted subset from pass 1 is re-adjudicated in a second, independent call,
 * and only a double refute acts. "uncertain" never deletes. Parts a mechanic
 * verified are never even sampled.
 *
 * After removals the config's heal ladder is scheduled (staggered) so the
 * reopened holes re-source through the normal path.
 *
 *   npx convex run vehicleEnrichment/fitmentReverify:sweep '{"limit":8,"dryRun":true}'
 *   npx convex run vehicleEnrichment/fitmentReverify:sweep '{"limit":12,"cursor":"<from prior run>"}'
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  verifyPartFitments,
  VERIFY_MAX_PARTS,
  VERIFY_PRIORITY_ROLE_KEYS,
  type FitmentToVerify,
} from "./utils/partFitmentVerifier";

/** One page of configs, in table order. Plain paginate so the sweep can stop
 *  and resume across invocations without holding anything open. */
export const _configPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), limit: v.float64() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("vehicle_configs")
      .paginate({ cursor: args.cursor, numItems: Math.max(1, Math.trunc(args.limit)) });
    return {
      ids: page.page.map((c) => c._id),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Vehicle context + verifiable candidates for one config, assembled the way
 *  the in-run gate assembles them (dedupe by OEM, skip universal fallbacks,
 *  priority roles first under the cap) — with one addition: fitments a
 *  mechanic verified are excluded entirely, because no automated verdict
 *  outranks a person who had the car on a lift. */
export const _candidatesForConfig = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    const cfg: any = await ctx.db.get(args.vehicleConfigId);
    if (!cfg) return null;
    const [mk, md, eng, trans] = await Promise.all([
      cfg.make_id ? ctx.db.get(cfg.make_id) : null,
      cfg.model_id ? ctx.db.get(cfg.model_id) : null,
      cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
      cfg.transmission_id ? ctx.db.get(cfg.transmission_id) : null,
    ]);
    const vehicle = {
      year: Number(cfg.year),
      make: String((mk as any)?.name ?? ""),
      model: String((md as any)?.name ?? ""),
      trim: String(cfg.trim_name ?? ""),
      engineCode: ((eng as any)?.engine_code as string | undefined) ?? null,
      displacement:
        (eng as any)?.displacement_l != null
          ? String((eng as any).displacement_l)
          : ((eng as any)?.displacement_liters != null
              ? String((eng as any).displacement_liters)
              : null),
      aspiration: ((eng as any)?.aspiration as string | undefined) ?? null,
      transmissionType:
        ((trans as any)?.type as string | undefined) ??
        ((trans as any)?.transmission_type as string | undefined) ??
        null,
      engineManufacturer: ((eng as any)?.engine_manufacturer as string | undefined) ?? null,
      cylinders: ((eng as any)?.cylinders as number | undefined) ?? null,
      oilViscosity: ((eng as any)?.oil_viscosity as string | undefined) ?? null,
    };

    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", args.vehicleConfigId))
      .collect();

    const candidates: Array<FitmentToVerify & { priority: boolean }> = [];
    const seenOem = new Set<string>();
    for (const f of fitments) {
      if ((f as any).mechanic_verified === true) continue;
      const part: any = await ctx.db.get(f.part_id);
      const oem: string = part?.oem_part_number ?? "";
      if (!oem || oem.startsWith("OTOPAIR-UNIV") || seenOem.has(oem)) continue;
      seenOem.add(oem);
      const roleKey: string = part?.subcategory ?? "";
      candidates.push({
        roleKey,
        oem,
        name: part?.name ?? roleKey,
        quantity: ((f as any).quantity_needed as number | undefined) ?? null,
        observedTitle: (part?.scraped_name as string | undefined) ?? null,
        priority: VERIFY_PRIORITY_ROLE_KEYS.has(roleKey),
      });
    }
    candidates.sort((a, b) => Number(b.priority) - Number(a.priority));
    return {
      configKey: String(cfg.config_key ?? ""),
      label: `${cfg.year} ${(mk as any)?.name ?? "?"} ${(md as any)?.name ?? "?"}`,
      vehicle,
      candidates: candidates
        .slice(0, VERIFY_MAX_PARTS)
        .map(({ priority: _p, ...c }) => c),
    };
  },
});

export const sweep = internalAction({
  args: {
    /** Configs examined this invocation (verify calls are the cost driver;
     *  actions also have a wall clock, so keep this modest and chain runs). */
    limit: v.optional(v.float64()),
    /** continueCursor from the previous invocation's result. */
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Full adjudication (both passes) but no deletions and no heals. */
    dryRun: v.optional(v.boolean()),
    /** Schedule healAfterRun for configs that lost parts (default true). */
    heal: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const limit = Math.max(1, Math.trunc(args.limit ?? 10));
    const page: any = await ctx.runQuery(
      internal.vehicleEnrichment.fitmentReverify._configPage,
      { cursor: args.cursor ?? null, limit },
    );

    const rows: any[] = [];
    let healsScheduled = 0;
    for (const configId of page.ids) {
      try {
        const bundle: any = await ctx.runQuery(
          internal.vehicleEnrichment.fitmentReverify._candidatesForConfig,
          { vehicleConfigId: configId },
        );
        if (!bundle || bundle.candidates.length === 0) continue;

        const verdicts1 = await verifyPartFitments(bundle.vehicle, bundle.candidates);
        // Channel-death guard: verifyPartFitments never throws — a dead API
        // key comes back as every part "uncertain" with a channel reason, and
        // "uncertain deletes nothing" quietly turns the whole remaining fleet
        // into zero-refute rows that read as CLEAN (Aug 20 2026: the key ran
        // out of credits at row ~31 and the next 228 configs "passed"). A
        // channel failure aborts the invocation with the SAME cursor.
        const CHANNEL_REASONS = new Set(["verifier_error", "no_api_key"]);
        if (
          verdicts1.length > 0 &&
          verdicts1.every((x) => x.verdict === "uncertain" && CHANNEL_REASONS.has(x.reason))
        ) {
          console.error(
            `[fitment-reverify] verifier channel down (${verdicts1[0].reason}) at ${bundle.configKey} — aborting invocation`,
          );
          return {
            aborted: `verifier_channel_down:${verdicts1[0].reason}`,
            examined: rows.length,
            flagged: rows.filter((r) => (r.refuted ?? 0) > 0).length,
            removedTotal: rows.reduce((n, r) => n + (r.removed ?? 0), 0),
            healsScheduled,
            dryRun: args.dryRun === true,
            rows,
            continueCursor: args.cursor ?? null,
            isDone: false,
          };
        }
        const refuted1 = verdicts1.filter((x) => x.verdict === "refuted");
        if (refuted1.length === 0) {
          rows.push({
            configKey: bundle.configKey,
            label: bundle.label,
            checked: bundle.candidates.length,
            refuted: 0,
          });
          continue;
        }

        // Second, independent adjudication of only the refuted subset. A part
        // must lose twice before a fleet sweep deletes it.
        const recheckSet = new Set(refuted1.map((x) => `${x.roleKey}|${x.oem}`));
        const recheckCandidates = bundle.candidates.filter((c: any) =>
          recheckSet.has(`${c.roleKey}|${c.oem}`),
        );
        const verdicts2 = await verifyPartFitments(bundle.vehicle, recheckCandidates);
        const refutedTwice = refuted1.filter((r1) =>
          verdicts2.some(
            (r2) => r2.roleKey === r1.roleKey && r2.oem === r1.oem && r2.verdict === "refuted",
          ),
        );
        const savedOnRecheck = refuted1.length - refutedTwice.length;

        let removed = 0;
        if (refutedTwice.length > 0 && args.dryRun !== true) {
          const res: any = await ctx.runMutation(
            internal.vehicleEnrichment.v3mutations.removeRefutedFitments,
            {
              vehicle_config_id: configId,
              refuted: refutedTwice.map((r) => {
                const r2 = verdicts2.find(
                  (x) => x.roleKey === r.roleKey && x.oem === r.oem,
                );
                return {
                  oem: r.oem,
                  reason:
                    `fleet reverify: ${r.reason.slice(0, 200)}` +
                    (r2?.reason ? ` // recheck: ${r2.reason.slice(0, 200)}` : ""),
                };
              }),
            },
          );
          removed = res?.removed ?? 0;
          if (removed > 0 && args.heal !== false) {
            // Stagger so a batch of removals doesn't stampede the heal ladder.
            await ctx.scheduler.runAfter(
              healsScheduled * 90_000,
              internal.vehicleEnrichment.resourceRoles.healAfterRun,
              { vehicleConfigId: configId },
            );
            healsScheduled++;
          }
        }

        rows.push({
          configKey: bundle.configKey,
          label: bundle.label,
          checked: bundle.candidates.length,
          refuted: refuted1.length,
          savedOnRecheck,
          refutedTwice: refutedTwice.map((r) => `${r.roleKey}:${r.oem}:${r.reason.slice(0, 140)}`),
          removed,
        });
      } catch (e) {
        rows.push({ configId: String(configId), error: String((e as any)?.message ?? e) });
      }
    }

    const summary = {
      examined: page.ids.length,
      flagged: rows.filter((r) => (r.refuted ?? 0) > 0).length,
      removedTotal: rows.reduce((n, r) => n + (r.removed ?? 0), 0),
      healsScheduled,
      dryRun: args.dryRun === true,
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
    console.log(
      `[fitment-reverify] ${summary.examined} config(s): ${summary.flagged} flagged, ` +
        `${summary.removedTotal} removed${summary.dryRun ? " [dry-run]" : ""}`,
    );
    return summary;
  },
});
