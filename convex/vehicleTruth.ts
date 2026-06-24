/**
 * vehicleTruth.ts — one-tap-confirm write-back of user-stated vehicle truth from
 * Oto chat. Called by the render_vehicle_update mobile confirm component. Guards
 * mileage (monotonic + plausible), maps maintenance-reminder claims to the pipeline's
 * knownIssues warning-light vocabulary (maintenance_pipeline.ts:564 derives
 * quick-read overrides from knownIssues — writing quick_read_flag directly is
 * clobbered by runPipeline), appends fault lights to knownIssues, and re-runs the
 * maintenance pipeline.
 *
 * Auth/owner resolve mirrors recordConfirmation.ts:54-79.
 * Pipeline trigger mirrors maintenance.ts:107-114 (preOnboardingComplete gate).
 */
import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { computeMaxDelta, validateMileageUpdate } from "./oto/vehicleTruthGuard";
import { symptomForServiceSlug } from "./lib/serviceSymptoms";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const applyVehicleTruth = mutation({
  args: {
    vehicle_id: v.string(),
    mileage: v.optional(v.number()),
    service_claims: v.optional(
      v.array(
        v.object({
          service_slug: v.string(),
          kind: v.union(v.literal("due"), v.literal("light_on")),
        }),
      ),
    ),
    fault_lights: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<any> => {
    const now = Date.now();

    // ── Auth + ownership resolve (mirrors recordConfirmation.ts:54-79) ──
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");

    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found in Convex");

    const vehicle: Doc<"vehicles"> | null = await ctx.db.get(
      args.vehicle_id as Id<"vehicles">,
    );
    if (!vehicle) throw new Error(`vehicle not found: ${args.vehicle_id}`);

    const owner: Doc<"vehicle_owners"> | null = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", vehicle.vin).eq("user_id", user._id),
      )
      .unique();
    if (!owner) throw new Error(`vehicle_owner not found for vehicle ${args.vehicle_id}`);

    // ── Mileage (guarded; violation returns needsReconfirm without writing) ──
    let mileageUpdated = false;
    if (args.mileage != null) {
      // annual_mileage_rate is the real field name on vehicle_owners (schema.ts:1126).
      // null is a safe fallback → computeMaxDelta uses the 25k floor.
      const annualRate: number | null = (owner as any).annual_mileage_rate ?? null;
      const yearsElapsed: number | null = owner.mileage_updated_at
        ? (now - owner.mileage_updated_at) / YEAR_MS
        : null;
      const maxDelta = computeMaxDelta(annualRate, yearsElapsed);
      const verdict = validateMileageUpdate(owner.mileage ?? null, args.mileage, maxDelta);
      if (!verdict.ok) {
        return { ok: false, needsReconfirm: true, reason: verdict.reason };
      }
      await ctx.db.patch(owner._id, {
        mileage: args.mileage,
        mileage_source: "chat_self_reported",
        mileage_updated_at: now,
      } as any);
      mileageUpdated = true;
    }

    // Collect knownIssues additions: maintenance-reminder claims map to the
    // pipeline's warning-light code (it derives quick-read overrides from
    // knownIssues), and fault lights are codes already. A direct quick_read_flag
    // write would be clobbered by the runPipeline this mutation triggers.
    const servicesFlagged: string[] = [];
    const codesToAdd: string[] = [];
    for (const claim of args.service_claims ?? []) {
      const code = symptomForServiceSlug(claim.service_slug);
      if (code) { codesToAdd.push(code); servicesFlagged.push(claim.service_slug); }
    }
    const faultLights = args.fault_lights ?? [];
    let faultLightsAdded: string[] = [];
    if (codesToAdd.length || faultLights.length) {
      const current: string[] = Array.isArray(owner.knownIssues) ? owner.knownIssues : [];
      const incoming = [...codesToAdd, ...faultLights];
      faultLightsAdded = faultLights.filter((f) => !current.includes(f));
      const merged = Array.from(new Set([...current, ...incoming]));
      await ctx.db.patch(owner._id, { knownIssues: merged } as any);
    }

    // ── Re-run the maintenance pipeline (mirrors maintenance.ts:107-114) ──
    if (owner.preOnboardingComplete) {
      await ctx.scheduler.runAfter(0, internal.maintenance_pipeline.runPipeline, {
        vehicleOwnerId: owner._id,
        triggeredBy: "oto_chat",
      });
    }

    return { ok: true, mileageUpdated, servicesFlagged, faultLightsAdded };
  },
});
