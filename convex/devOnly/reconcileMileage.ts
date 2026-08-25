/**
 * One-time reconciliation for the mileage-sync fix.
 *
 * The code fix (recency resolver on every read + timestamp discipline on every
 * write) keeps NEW writes coherent, but vehicles whose two stores already drifted
 * stay drifted until their next write. This walks every VIN that has both a
 * `vehicle_passports` row and an active `vehicle_owners` row, resolves the pair by
 * recency (the same `resolveVehicleMileage` every surface now uses), and writes the
 * winning value + a coherent timestamp back to BOTH stores so they agree going
 * forward. When an owner's effective current mileage actually changes, it schedules
 * `maintenance_pipeline.runPipeline` so intervals / alert engine / VHS recompute.
 *
 * Recency, not max(): we never fabricate a higher number, we just make the two
 * stores agree on the value the resolver already believes.
 *
 * Dry-run first, review the counts + samples, then run live. Run per deployment
 * (the real diverged backlog lives on ardent-crab-641, not third-bird-914). Use
 * `limit` to reconcile in batches if the pipeline fan-out is large.
 *
 *   npx convex run devOnly/reconcileMileage:reconcileMileage '{"dry_run":true}'
 *   npx convex run devOnly/reconcileMileage:reconcileMileage '{"limit":200}'
 *   npx convex run devOnly/reconcileMileage:reconcileMileage
 */
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { pickPreferredOwner, resolveVehicleMileage } from "../lib/mileage";

export const reconcileMileage = internalMutation({
  args: {
    dry_run: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dry_run ?? false;
    const now = Date.now();

    const passports = (await ctx.db.query("vehicle_passports").collect()) as any[];

    let scanned = 0;
    let reconciled = 0;
    let pipelinesScheduled = 0;
    const samples: Array<Record<string, unknown>> = [];

    for (const passport of passports) {
      if (args.limit && reconciled >= args.limit) break;

      const vin = passport.vin;
      if (typeof vin !== "string" || !vin) continue;

      const owners = (await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin", (q: any) => q.eq("vin", vin))
        .collect()) as any[];
      const activeOwners = owners.filter((o) => o.status === "active");
      if (activeOwners.length === 0) continue;

      scanned++;

      const preferred = pickPreferredOwner(activeOwners);
      const resolved = resolveVehicleMileage(passport, preferred);
      const winner = resolved.mileage;
      if (typeof winner !== "number" || !Number.isFinite(winner)) continue;

      // Keep the WINNING side's own write time — don't fabricate freshness by
      // stamping `now`. Fall back to `now` only when that side never recorded one.
      const winningTs =
        resolved.from === "owner"
          ? typeof preferred?.mileage_updated_at === "number"
            ? preferred.mileage_updated_at
            : now
          : typeof passport.last_reported_at === "number"
            ? passport.last_reported_at
            : now;

      // Only touch vehicles whose stores show DIFFERENT numbers — that's the
      // user-visible drift. When both sides already agree on the value, recency
      // is moot (either store returns the same number), so stamping timestamps
      // would be cosmetic churn; skip it.
      const num = (x: unknown) =>
        typeof x === "number" && Number.isFinite(x) ? x : null;
      const passportValue = num(passport.mileage);
      const passportDiverges = passportValue !== null && passportValue !== winner;
      const anyOwnerDiverges = activeOwners.some((o) => {
        const ov = num(o.mileage);
        return ov !== null && ov !== winner;
      });
      if (!passportDiverges && !anyOwnerDiverges) continue;

      reconciled++;
      if (samples.length < 25) {
        samples.push({
          vin,
          from: resolved.from,
          winner,
          passportWas: passport.mileage ?? null,
          // ALL active owners, so a reviewer can see which row diverged — a
          // single row's value can match `winner` while a sibling row disagrees.
          ownersWere: activeOwners.map((o) => o.mileage ?? null),
        });
      }

      if (!dryRun) {
        await ctx.db.patch(passport._id, {
          mileage: winner,
          last_reported_at: winningTs,
          updated_at: now,
        });

        for (const o of activeOwners) {
          const ownerMileageChanged = o.mileage !== winner;
          await ctx.db.patch(o._id, {
            mileage: winner,
            mileage_updated_at: winningTs,
            mileage_source: "reconcile",
          });
          if (ownerMileageChanged && o.preOnboardingComplete) {
            await ctx.scheduler.runAfter(
              0,
              internal.maintenance_pipeline.runPipeline,
              { vehicleOwnerId: o._id, triggeredBy: "mileage_update" },
            );
            pipelinesScheduled++;
          }
        }

        await ctx.db.insert("audit_log", {
          entity_type: "vehicle_passport",
          entity_id: String(passport._id),
          action: "data_fix",
          actor: "CLI data fix",
          detail: `mileage reconcile: winner=${winner} from=${resolved.from} (passport was ${passport.mileage ?? "∅"}, owner was ${preferred?.mileage ?? "∅"})`,
          created_at: now,
        });
      }
    }

    return {
      ok: true as const,
      dry_run: dryRun,
      scanned,
      reconciled,
      pipelinesScheduled,
      samples,
    };
  },
});
