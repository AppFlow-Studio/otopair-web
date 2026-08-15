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
import { action, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { computeMaxDelta, validateMileageUpdate } from "./oto/vehicleTruthGuard";
import { symptomForServiceSlug } from "./lib/serviceSymptoms";
import { recordTypeForServiceSlug } from "./lib/serviceRecordType";
import { normalizeFaultLight, toCanonicalLight } from "../lib/warningLightVocab";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Sanity ceiling for a user-stated past service mileage (matches useUpdateMileage).
const MILEAGE_CEILING = 1_500_000;

/**
 * Resolve the odometer to anchor a COMPLETED service to. Prefers the user-stated
 * past at-mileage ("oil change at 89,000") when it's a sane value at/below the
 * current odometer; otherwise returns undefined so the caller falls back to the
 * current odometer. Deliberately does NOT use the monotonic backward guard — a
 * past service mileage is legitimately BELOW the current reading, and routing it
 * through validateMileageUpdate would reject it as "backward".
 */
function resolveServiceMileage(
  serviceMileage: number | undefined,
  currentOdometer: number | null,
): number | undefined {
  if (
    serviceMileage != null &&
    Number.isFinite(serviceMileage) &&
    serviceMileage > 0 &&
    serviceMileage <= MILEAGE_CEILING &&
    (currentOdometer == null || serviceMileage <= currentOdometer)
  ) {
    return serviceMileage;
  }
  return undefined;
}

/**
 * Resolve WHEN a COMPLETED service happened. Precedence: an absolute service_date
 * (ms, sane past timestamp) wins; else service_age_days ("a week ago" → 7)
 * resolved server-side as now − days; else undefined so the caller falls back to
 * now. Future or implausible values are ignored.
 */
function resolveServiceDate(
  serviceDate: number | undefined,
  serviceAgeDays: number | undefined,
  now: number,
): number | undefined {
  if (
    serviceDate != null &&
    Number.isFinite(serviceDate) &&
    serviceDate > 0 &&
    serviceDate <= now
  ) {
    return serviceDate;
  }
  if (
    serviceAgeDays != null &&
    Number.isFinite(serviceAgeDays) &&
    serviceAgeDays > 0 &&
    serviceAgeDays <= 36500
  ) {
    return now - serviceAgeDays * DAY_MS;
  }
  return undefined;
}

// Shared arg validators — one definition reused by the public mutation, the
// internal director writer, and the director action.
const serviceClaimsValidator = v.optional(
  v.array(
    v.object({
      service_slug: v.string(),
      // "due" / "light_on" FLAG the service (it needs attention); "completed"
      // RECORDS it done (clears the flag + resets the due clock).
      kind: v.union(v.literal("due"), v.literal("light_on"), v.literal("completed")),
      // Past-service anchor — kind:"completed" only. When the user reports a
      // service done in the PAST, these say WHEN / at what mileage so the
      // pipeline re-anchors the due clock to THEN, not to now/current.
      //   service_mileage  — odometer at which THIS service was done ("at 89,000"),
      //                      distinct from the top-level current odometer.
      //   service_age_days — how many days ago ("a week ago" → 7); resolved
      //                      server-side to now − days.
      //   service_date     — absolute ms-epoch it was done; wins over age_days.
      service_mileage: v.optional(v.number()),
      service_age_days: v.optional(v.number()),
      service_date: v.optional(v.number()),
      // W4.3 (QA K3) — how sure the user sounded about THIS claim. "hedged"
      // ("I think…", "pretty sure…", "like 6 months ago?") must not carry the
      // same weight as a plain assertion. Absent = "certain" (old payloads
      // keep their exact prior behavior).
      stated_confidence: v.optional(
        v.union(v.literal("certain"), v.literal("hedged")),
      ),
    }),
  ),
);
const faultLightsValidator = v.optional(v.array(v.string()));

type VehicleTruthInputs = {
  mileage?: number;
  service_claims?: Array<{
    service_slug: string;
    kind: "due" | "light_on" | "completed";
    service_mileage?: number;
    service_age_days?: number;
    service_date?: number;
    stated_confidence?: "certain" | "hedged";
  }>;
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
  // W4.3 (QA K3) — subset of servicesCompleted the user HEDGED ("I think…",
  // "pretty sure…"). Their records get confidence: "self_reported_hedged"
  // below, and the list is returned so the confirm card can say the log was
  // noted as unsure.
  const servicesCompletedHedged: string[] = [];
  const codesToAdd: string[] = [];
  const codesToClear: string[] = [];
  // recordType → the past anchor (mileage/date) the user reported for it. A
  // completed claim with no past values resolves to undefined → today/current.
  const completedRecordAnchors = new Map<
    string,
    { mileage?: number; date?: number; hedged?: boolean }
  >();
  for (const claim of args.service_claims ?? []) {
    if (claim.kind === "completed") {
      const hedged = claim.stated_confidence === "hedged";
      const code = symptomForServiceSlug(claim.service_slug);
      if (code) codesToClear.push(code);
      const recordType = recordTypeForServiceSlug(claim.service_slug);
      if (recordType) {
        completedRecordAnchors.set(recordType, {
          mileage: resolveServiceMileage(claim.service_mileage, owner.mileage ?? null),
          date: resolveServiceDate(claim.service_date, claim.service_age_days, now),
          hedged,
        });
      }
      servicesCompleted.push(claim.service_slug);
      if (hedged) servicesCompletedHedged.push(claim.service_slug);
    } else {
      const code = symptomForServiceSlug(claim.service_slug);
      if (code) { codesToAdd.push(code); servicesFlagged.push(claim.service_slug); }
    }
  }
  // Canonicalize fault-light ids to the reader vocabulary before writing (e.g.
  // the wrong "tire_pressure" the tool schema example used → "tpms"), so a
  // logged light matches the maintenance-tracker / health-score readers. Symptom
  // codes in codesToAdd (brake_warning/battery) are deliberately NOT normalized —
  // the pipeline QuickReadFlags + the upsertRecord/booking clear-paths depend on
  // that write vocabulary; the readers now understand both.
  const faultLights = (args.fault_lights ?? []).map(normalizeFaultLight);
  let faultLightsAdded: string[] = [];
  if (codesToAdd.length || faultLights.length || codesToClear.length) {
    const current: string[] = Array.isArray(owner.knownIssues) ? owner.knownIssues : [];
    faultLightsAdded = faultLights.filter((f) => !current.includes(f));
    // Drop a stale "no_all_clear" sentinel when we're adding a live light/flag —
    // otherwise a legacy onboarding ["no_all_clear"] array keeps the light and
    // "all clear" contradictorily co-present (the exact corruption that hid an
    // Oto-logged light from the sentinel-strict readers).
    const addingSignal = codesToAdd.length > 0 || faultLights.length > 0;
    const base = addingSignal ? current.filter((c) => c !== "no_all_clear") : current;
    let next = Array.from(new Set([...base, ...codesToAdd, ...faultLights]));
    if (codesToClear.length) {
      // Clear by CANONICAL light id too. A completed service's clear code is the
      // symptom vocab (e.g. brake_warning), but a fault light the user logged is
      // stored CANONICALLY (e.g. abs, via normalizeFaultLight). Matching only the
      // literal symptom code left the light behind — so "I did my brakes" never
      // cleared the ABS light. Fold both to canonical and remove either form.
      const clearCanon = new Set(
        codesToClear.map((c) => toCanonicalLight(c)).filter(Boolean) as string[],
      );
      next = next.filter((c) => {
        if (codesToClear.includes(c)) return false;
        const canon = toCanonicalLight(c);
        return !(canon && clearCanon.has(canon));
      });
    }
    await ctx.db.patch(owner._id, { knownIssues: next } as any);
  }

  // Record each completed service done (mirrors maintenance.upsertRecord): fresh
  // last-service date + the stated/current mileage, and clear stale symptom
  // inputs (e.g. brakeFeel="soft_slow") so the health layer stops surfacing the
  // old problem. The runPipeline below then recomputes the status as on-time.
  // Current odometer / now are the FALLBACK anchor when the user didn't state a
  // past at-mileage or time. Per-claim service_mileage / service_date (resolved
  // above) override them so a service reported done in the past re-anchors the
  // due clock to THEN — the maintenance pipeline projects forward from this.
  const currentOdometerFallback: number | undefined = args.mileage ?? owner.mileage ?? undefined;
  for (const [recordType, anchor] of completedRecordAnchors) {
    const recordMileage = anchor.mileage ?? currentOdometerFallback;
    const recordDate = anchor.date ?? now;
    // W4.3 (QA K3) — a HEDGED claim must not write with the weight of a
    // confident self-report. The record's weight mechanism is the categorical
    // `confidence` label (schema.ts maintenance_records; vehicleHealth.ts
    // derives record_provenance from it — anything ≠ "verified" reads as
    // self_reported, so "self_reported_hedged" stays in the soft bucket for
    // every existing reader while persisting the hedge). serviceSource is the
    // audit-trail companion (writer convention per maintenance.upsertRecord).
    // Certain claims stamp NOTHING — byte-identical to pre-W4.3 behavior.
    const hedgedStamp = anchor.hedged
      ? { serviceSource: "oto_chat", confidence: "self_reported_hedged" }
      : {};
    const existing = await ctx.db
      .query("maintenance_records")
      .withIndex("by_vehicle_and_type", (q: any) =>
        q.eq("vehicleOwnerId", owner._id).eq("type", recordType))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastServiceDate: recordDate,
        lastServiceMileage: recordMileage,
        customInputs: undefined,
        ...hedgedStamp,
        updatedAt: now,
      } as any);
    } else {
      await ctx.db.insert("maintenance_records", {
        vehicleOwnerId: owner._id,
        type: recordType,
        lastServiceDate: recordDate,
        lastServiceMileage: recordMileage,
        ...hedgedStamp,
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

  return {
    ok: true,
    mileageUpdated,
    servicesFlagged,
    servicesCompleted,
    // Subset of servicesCompleted whose claims were hedged — the confirm card
    // uses this to note the log was recorded as unsure.
    servicesCompletedHedged,
    faultLightsAdded,
  };
}

// ── D-13/D-15 (QA p.69): per-vehicle card supersession ───────────────────────
// "One pending vehicle-update card per thread, and none while an emergency is
// active" — Waleed's ruling 2026-08-16: newest card for a VEHICLE is the only
// active one, globally across conversations; older cards render expired in
// place; a vehicle-context switch alone expires nothing.

/** Internal writer — chat.ts stamps the newest card's message id on the owner
 *  row whenever a render_vehicle_update card persists. */
export const setActiveUpdateCard = internalMutation({
  args: {
    vin: v.string(),
    user_id: v.id("users"),
    message_id: v.id("ai_messages"),
  },
  handler: async (ctx, args) => {
    const owner = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", args.vin).eq("user_id", args.user_id),
      )
      .unique();
    if (!owner) return { ok: false as const, reason: "no_owner_row" };
    await ctx.db.patch(owner._id, {
      active_update_card_message_id: args.message_id,
    });
    return { ok: true as const };
  },
});

/** Card-side read — AIVehicleUpdate compares its own message id against this
 *  pointer; a mismatch means a newer card exists somewhere and this one
 *  renders expired. */
export const getActiveUpdateCard = query({
  args: { vehicle_id: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) return null;
    let vehicle: Doc<"vehicles"> | null = null;
    try {
      vehicle = await ctx.db.get(args.vehicle_id as Id<"vehicles">);
    } catch {
      return null;
    }
    if (!vehicle) return null;
    const owner = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", vehicle.vin).eq("user_id", user._id),
      )
      .unique();
    return (owner?.active_update_card_message_id as string | undefined) ?? null;
  },
});

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
