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
import { action, internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { computeMaxDelta, validateMileageUpdate } from "./oto/vehicleTruthGuard";
import { symptomForServiceSlug } from "./lib/serviceSymptoms";
import { recordTypeForServiceSlug } from "./lib/serviceRecordType";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Shared arg validators — one definition reused by the public mutation, the
// internal director writer, and the director action.
const serviceClaimsValidator = v.optional(
  v.array(
    v.object({
      service_slug: v.string(),
      // "due" / "light_on" FLAG the service (it needs attention); "completed"
      // RECORDS it done (clears the flag + resets the due clock).
      kind: v.union(v.literal("due"), v.literal("light_on"), v.literal("completed")),
    }),
  ),
);
const faultLightsValidator = v.optional(v.array(v.string()));

type VehicleTruthInputs = {
  mileage?: number;
  service_claims?: Array<{ service_slug: string; kind: "due" | "light_on" | "completed" }>;
  fault_lights?: string[];
  // Set true ONLY after the user explicitly reconfirms a large-but-real forward
  // mileage jump (reason "absurd_forward"). Never overrides "backward" or
  // "implausible" — those are hard-invalid, not a judgment call.
  reconfirmed?: boolean;
};

/**
 * Core write-back, shared by the auth-gated public mutation and the
 * director-session-gated internal writer. Takes the ALREADY-RESOLVED user +
 * vehicle so the two callers can resolve identity differently (Clerk auth vs
 * a director-validated userId) without duplicating the mileage guard, the
 * knownIssues mapping, or the pipeline trigger. The owner row is resolved here
 * from (vehicle.vin, user._id) — identical to the original inline resolve.
 */
async function applyVehicleTruthImpl(
  ctx: MutationCtx,
  user: Doc<"users">,
  vehicle: Doc<"vehicles">,
  args: VehicleTruthInputs,
): Promise<any> {
  const now = Date.now();

  const owner: Doc<"vehicle_owners"> | null = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) =>
      q.eq("vin", vehicle.vin).eq("user_id", user._id),
    )
    .unique();
  if (!owner) throw new Error(`vehicle_owner not found for vehicle ${vehicle._id}`);

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
    // "absurd_forward" is a big-but-possibly-real jump the user can explicitly
    // reconfirm to accept. "backward" / "implausible" are hard-invalid and can
    // NEVER be reconfirmed (an odometer can't run backward; a non-positive or
    // >1M reading isn't a real value). The rejection payload carries the stored
    // value + the one-step ceiling so the UI can explain WHY and offer reconfirm.
    const reconfirmable = verdict.ok === false && verdict.reason === "absurd_forward";
    if (!verdict.ok && !(reconfirmable && args.reconfirmed)) {
      return {
        ok: false,
        needsReconfirm: true,
        reason: verdict.reason,
        reconfirmable,
        current: owner.mileage ?? null,
        proposed: args.mileage,
        maxAllowed: (owner.mileage ?? 0) + maxDelta,
      };
    }
    await ctx.db.patch(owner._id, {
      mileage: args.mileage,
      mileage_source: "chat_self_reported",
      mileage_updated_at: now,
    } as any);
    mileageUpdated = true;
  }

  // Split service claims by KIND. "due" / "light_on" FLAG the service: add its
  // warning-light code to knownIssues (the pipeline derives quick-read overrides
  // from knownIssues; a direct quick_read_flag write would be clobbered by the
  // runPipeline below). "completed" RECORDS it done: clear that code AND write a
  // fresh maintenance_record so the pipeline marks it on-time. Routing a
  // "completed" report ("I did my brakes") through the "due" path was the
  // inversion bug — it flagged a just-finished service and DROPPED the score.
  const servicesFlagged: string[] = [];
  const servicesCompleted: string[] = [];
  const codesToAdd: string[] = [];
  const codesToClear: string[] = [];
  const completedRecordTypes = new Set<string>();
  for (const claim of args.service_claims ?? []) {
    if (claim.kind === "completed") {
      const code = symptomForServiceSlug(claim.service_slug);
      if (code) codesToClear.push(code);
      const recordType = recordTypeForServiceSlug(claim.service_slug);
      if (recordType) completedRecordTypes.add(recordType);
      servicesCompleted.push(claim.service_slug);
    } else {
      const code = symptomForServiceSlug(claim.service_slug);
      if (code) { codesToAdd.push(code); servicesFlagged.push(claim.service_slug); }
    }
  }
  const faultLights = args.fault_lights ?? [];
  let faultLightsAdded: string[] = [];
  if (codesToAdd.length || faultLights.length || codesToClear.length) {
    const current: string[] = Array.isArray(owner.knownIssues) ? owner.knownIssues : [];
    faultLightsAdded = faultLights.filter((f) => !current.includes(f));
    let next = Array.from(new Set([...current, ...codesToAdd, ...faultLights]));
    if (codesToClear.length) next = next.filter((c) => !codesToClear.includes(c));
    await ctx.db.patch(owner._id, { knownIssues: next } as any);
  }

  // Record each completed service done (mirrors maintenance.upsertRecord): fresh
  // last-service date + the stated/current mileage, and clear stale symptom
  // inputs (e.g. brakeFeel="soft_slow") so the health layer stops surfacing the
  // old problem. The runPipeline below then recomputes the status as on-time.
  const serviceMileage: number | undefined = args.mileage ?? owner.mileage ?? undefined;
  for (const recordType of completedRecordTypes) {
    const existing = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_and_type", (q: any) =>
        q.eq("vehicleOwnerId", owner._id).eq("type", recordType))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastServiceDate: now,
        lastServiceMileage: serviceMileage,
        customInputs: undefined,
        updatedAt: now,
      } as any);
    } else {
      await ctx.db.insert("maintenance_records", {
        vehicleOwnerId: owner._id,
        type: recordType,
        lastServiceDate: now,
        lastServiceMileage: serviceMileage,
        createdAt: now,
        updatedAt: now,
      } as any);
    }
  }

  // ── Re-run the maintenance pipeline (mirrors maintenance.ts:107-114) ──
  if (owner.preOnboardingComplete) {
    await ctx.scheduler.runAfter(0, internal.maintenance_pipeline.runPipeline, {
      vehicleOwnerId: owner._id,
      triggeredBy: "oto_chat",
    });
  }

  return { ok: true, mileageUpdated, servicesFlagged, servicesCompleted, faultLightsAdded };
}

export const applyVehicleTruth = mutation({
  args: {
    vehicle_id: v.string(),
    mileage: v.optional(v.number()),
    service_claims: serviceClaimsValidator,
    fault_lights: faultLightsValidator,
    reconfirmed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
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

    return applyVehicleTruthImpl(ctx, user, vehicle, args);
  },
});

// =============================================================================
// Director-sim path — interact with the render_vehicle_update card from the
// director panel's Oto Sim (which has no end-user Clerk identity, same gap the
// sim's simulateOtoForDirector closes). The internal writer resolves the user
// by id and the vehicle by vin (no auth); the public action gates on a live
// director session. Both reuse applyVehicleTruthImpl, so the write-back logic
// (mileage guard, knownIssues mapping, pipeline trigger) is identical to the
// production card-confirm.
// =============================================================================

export const applyVehicleTruthForDirectorMutation = internalMutation({
  args: {
    user_id: v.id("users"),
    vehicle_vin: v.string(),
    mileage: v.optional(v.number()),
    service_claims: serviceClaimsValidator,
    fault_lights: faultLightsValidator,
    reconfirmed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const user: Doc<"users"> | null = await ctx.db.get(args.user_id);
    if (!user) throw new Error(`user not found: ${args.user_id}`);
    const vehicle: Doc<"vehicles"> | null = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", args.vehicle_vin))
      .first();
    if (!vehicle) throw new Error(`vehicle not found for vin ${args.vehicle_vin}`);
    return applyVehicleTruthImpl(ctx, user, vehicle, {
      mileage: args.mileage,
      service_claims: args.service_claims,
      fault_lights: args.fault_lights,
      reconfirmed: args.reconfirmed,
    });
  },
});

export const applyVehicleTruthForDirector = action({
  args: {
    token: v.string(),
    userId: v.id("users"),
    vehicleVin: v.string(),
    mileage: v.optional(v.number()),
    service_claims: serviceClaimsValidator,
    fault_lights: faultLightsValidator,
    reconfirmed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const session = await ctx.runQuery(api.director_auth.validateSession, {
      token: args.token,
    });
    if (!session) {
      throw new Error("unauthorized: invalid or expired director session");
    }
    return ctx.runMutation(
      internal.vehicleTruth.applyVehicleTruthForDirectorMutation,
      {
        user_id: args.userId,
        vehicle_vin: args.vehicleVin,
        ...(args.mileage !== undefined ? { mileage: args.mileage } : {}),
        ...(args.service_claims !== undefined ? { service_claims: args.service_claims } : {}),
        ...(args.fault_lights !== undefined ? { fault_lights: args.fault_lights } : {}),
        ...(args.reconfirmed !== undefined ? { reconfirmed: args.reconfirmed } : {}),
      },
    );
  },
});
