/**
 * checkin.ts — Quarterly Check-In Backend
 *
 * Queries for check-in state, mutations for creating/completing check-ins,
 * and the completion pipeline that recalculates the maintenance engine.
 */

import { query, mutation, internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { dismissRecsForReportedServices } from "./jobRecommendations";
import {
  getCheckinQuestions,
  getCheckinQuestionIds,
  getQuestionVisibility,
} from "./lib/checkin_questions";
import type { VehicleMode } from "./lib/checkin_questions";

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get check-in status for a vehicle owner.
 * Returns banner state, next due date, and last completion info.
 */
export const getCheckinStatus = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return null;

    const nextDue = owner.next_checkin_due;
    const lastCheckin = owner.last_checkin_at;

    if (!nextDue) {
      return { state: "not_due" as const, nextDue: null, lastCheckin };
    }

    const now = Date.now();
    const daysSinceDue = (now - nextDue) / (24 * 60 * 60 * 1000);

    let bannerStage: "soft" | "stale" | "estimated" | "not_due";
    if (daysSinceDue < 0) {
      bannerStage = "not_due";
    } else if (daysSinceDue < 14) {
      bannerStage = "soft";
    } else if (daysSinceDue < 30) {
      bannerStage = "stale";
    } else {
      bannerStage = "estimated";
    }

    return {
      state: bannerStage,
      nextDue,
      lastCheckin,
      daysSinceDue: Math.max(0, Math.floor(daysSinceDue)),
      isEstimated: owner.health_score_is_estimated ?? false,
      vehicleMode: owner.vehicle_mode ?? "owned_active",
    };
  },
});

/**
 * Has this vehicle finished the post-add service-history quick-read
 * (the 5-tile CarInfoStepper flow: Brakes/Tires/Oil/Battery/Warning
 * Lights)? Used by the booking gate. Backed by
 * `vehicle_owners.onboardingComplete`, which CarInfoStepper sets when
 * the user taps "Complete" or "Finish for now".
 */
export const hasCompletedCheckin = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    return owner?.onboardingComplete === true;
  },
});

/**
 * Get the questions for this vehicle's check-in.
 */
export const getCheckinQuestionSet = query({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) return null;

    const mode = (owner.vehicle_mode ?? "owned_active") as VehicleMode;
    const questions = getCheckinQuestions(mode);

    // Calculate projected mileage for Q1 prefill
    const annualRate = owner.annual_mileage_rate ?? 12_000;
    const lastMileage = owner.mileage ?? 0;
    const lastCheckin = owner.last_checkin_at ?? owner.added_at ?? Date.now();
    const monthsSinceLast = (Date.now() - lastCheckin) / (30.44 * 24 * 60 * 60 * 1000);
    const projectedMileage = Math.round(
      lastMileage + (annualRate / 12) * monthsSinceLast
    );

    const garageRole = owner.garageRole ?? "primary";

    // Include visibility per question so UI can show "Skip" for optional ones
    const questionsWithVisibility = questions.map((q) => ({
      ...q,
      visibility: getQuestionVisibility(q.id, mode),
    }));

    return {
      mode,
      questions: questionsWithVisibility,
      projectedMileage,
      garageRole,
      questionIds: getCheckinQuestionIds(mode),
    };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Start a check-in (creates an in_progress row).
 */
export const startCheckin = mutation({
  args: { vehicleOwnerId: v.id("vehicle_owners") },
  handler: async (ctx, args) => {
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner) throw new Error("Vehicle owner not found");

    const mode = (owner.vehicle_mode ?? "owned_active") as VehicleMode;
    const annualRate = owner.annual_mileage_rate ?? 12_000;
    const lastMileage = owner.mileage ?? 0;
    const lastCheckin = owner.last_checkin_at ?? owner.added_at ?? Date.now();
    const monthsSinceLast = (Date.now() - lastCheckin) / (30.44 * 24 * 60 * 60 * 1000);
    const projectedMileage = Math.round(
      lastMileage + (annualRate / 12) * monthsSinceLast
    );

    const checkinId = await ctx.db.insert("vehicle_checkins", {
      vehicle_owner_id: args.vehicleOwnerId,
      mode_at_checkin: mode,
      questions_shown: getCheckinQuestionIds(mode),
      answers: {},
      mileage_reported: 0,
      mileage_projected: projectedMileage,
      velocity_delta: 0,
      warning_lights: false,
      mode_transition_triggered: false,
      started_at: Date.now(),
      status: "in_progress",
    });

    return { checkinId, mode, projectedMileage };
  },
});

/**
 * Complete a check-in with all answers.
 * Triggers the engine recalculation pipeline.
 */
export const completeCheckin = mutation({
  args: {
    checkinId: v.id("vehicle_checkins"),
    vehicleOwnerId: v.id("vehicle_owners"),
    answers: v.any(),
    mileageReported: v.float64(),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (!checkin || checkin.status !== "in_progress") {
      throw new Error("Check-in not found or already completed");
    }

    const answers = args.answers as Record<string, string | string[]>;
    const now = Date.now();

    // Derive fields from answers
    const servicesReported = Array.isArray(answers.Q2)
      ? answers.Q2.filter((s: string) => s !== "none")
      : [];

    const servicesThroughOtopair =
      typeof answers.Q3 === "string" ? answers.Q3 : undefined;

    const warningLights = answers.Q4 === "yes";
    const symptomsText =
      typeof answers.Q5_text === "string" ? answers.Q5_text : undefined;

    // Q5 symptom → risk category mapping
    const symptomFlags: string[] = [];
    if (symptomsText) {
      const lower = symptomsText.toLowerCase();
      if (lower.includes("vibrat") || lower.includes("shak") || lower.includes("wobbl")) {
        symptomFlags.push("alignment_balance");
      }
      if (lower.includes("noise") || lower.includes("squeal") || lower.includes("grind") || lower.includes("click") || lower.includes("knock") || lower.includes("rattle")) {
        symptomFlags.push("diagnostic_noise");
      }
      if (lower.includes("pull") || lower.includes("drift") || lower.includes("steer")) {
        symptomFlags.push("alignment");
      }
    }

    // Mode transitions
    const q7Answer = answers.Q7 as string | undefined;
    const q10Answer = answers.Q10 as string | undefined;
    const modeTransition =
      q7Answer === "bought_out" || q10Answer === "changed";

    const velocityDelta = args.mileageReported - (checkin.mileage_projected ?? 0);

    // Complete the check-in record
    await ctx.db.patch(args.checkinId, {
      answers: args.answers,
      mileage_reported: args.mileageReported,
      velocity_delta: velocityDelta,
      services_reported: servicesReported.length > 0 ? servicesReported : undefined,
      services_through_otopair: servicesThroughOtopair,
      warning_lights: warningLights,
      symptoms_text: symptomsText,
      mode_transition_triggered: modeTransition,
      completed_at: now,
      status: "completed",
      next_checkin_due: now + 90 * 24 * 60 * 60 * 1000,
    });

    // Update mileage + Q8/Q11 answers on vehicle_owners
    const q8Answer = answers.Q8 as string | undefined;
    const q11Answer = answers.Q11 as string | undefined;
    await ctx.db.patch(args.vehicleOwnerId, {
      mileage: args.mileageReported,
      last_checkin_at: now,
      next_checkin_due: now + 90 * 24 * 60 * 60 * 1000,
      health_score_is_estimated: false,
      ...(q8Answer ? { ownership_plan: q8Answer } : {}),
      ...(q11Answer ? { lease_mileage_pace: q11Answer } : {}),
    });

    // Update known issues from warning lights + symptom flags
    {
      const WARNING_FLAGS = [
        "check_engine", "oil_pressure", "battery_charging",
        "abs", "tpms", "airbag_srs", "transmission",
      ];
      const existingIssues = (await ctx.db.get(args.vehicleOwnerId))
        ?.knownIssues as string[] | undefined ?? [];

      let updated: string[];
      if (warningLights) {
        // Add new flags on top of existing
        const newIssues = new Set(existingIssues);
        newIssues.add("check_engine");
        for (const flag of symptomFlags) newIssues.add(flag);
        updated = [...newIssues];
      } else {
        // No warning lights reported — clear all warning-light flags
        updated = existingIssues.filter(
          (i: string) => !WARNING_FLAGS.includes(i)
        );
        // Re-add symptom flags (non-light issues like alignment, noise)
        for (const flag of symptomFlags) {
          if (!updated.includes(flag)) updated.push(flag);
        }
      }

      if (
        updated.length !== existingIssues.length ||
        updated.some((v, i) => v !== existingIssues[i])
      ) {
        await ctx.db.patch(args.vehicleOwnerId, { knownIssues: updated });
      }
    }

    // Reset service clocks for reported services, with Q3 confidence
    if (servicesReported.length > 0) {
      const TYPE_MAP: Record<string, string> = {
        oil_change: "oil",
        brakes: "brakes",
        tires: "tires",
        battery: "battery",
        inspection: "inspection",
      };

      // Q3: "yes" = verified via Otopair, "no" = external (lower confidence)
      const q3Answer = servicesThroughOtopair;
      const serviceSource = q3Answer === "yes" ? "otopair" : q3Answer === "no" ? "external" : "unknown";
      const confidence = q3Answer === "yes" ? "verified" : "unverified";

      for (const svc of servicesReported) {
        const maintenanceType = TYPE_MAP[svc];
        if (!maintenanceType) continue;

        const existing = await ctx.db
          .query("maintenance_records")
          .withIndex("by_vehicle_and_type", (q) =>
            q.eq("vehicleOwnerId", args.vehicleOwnerId).eq("type", maintenanceType)
          )
          .unique();

        if (existing) {
          // Clear old symptom data — service resets the condition
          const SYMPTOM_KEYS = ["brakeFeel", "squeaking", "tireRepaired", "recency"];
          const currentInputs = (existing.customInputs ?? {}) as Record<string, unknown>;
          const cleaned: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(currentInputs)) {
            if (!SYMPTOM_KEYS.includes(k)) cleaned[k] = v;
          }
          await ctx.db.patch(existing._id, {
            lastServiceDate: now,
            lastServiceMileage: args.mileageReported,
            customInputs: cleaned,
            confirmedHealthyAt: now,
            serviceSource,
            confidence,
            updatedAt: now,
          });
        } else {
          await ctx.db.insert("maintenance_records", {
            vehicleOwnerId: args.vehicleOwnerId,
            type: maintenanceType,
            lastServiceDate: now,
            lastServiceMileage: args.mileageReported,
            serviceSource,
            confidence,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      // If the driver said they had this work done (especially Q3="no" /
      // external), close any matching open mechanic recommendations so we
      // stop reminding them and lift the VHS penalty.
      const Q2_TO_SLUGS: Record<string, string[]> = {
        oil_change: ["oil-change"],
        brakes: ["brake-pads", "brake-rotors", "brake-fluid-flush"],
        tires: [
          "tire-replacement",
          "tire-rotation",
          "tire-balance",
          "wheel-alignment",
        ],
        battery: ["battery-replacement", "battery-test"],
        inspection: ["state-inspection", "emissions-test"],
      };
      const owner = await ctx.db.get(args.vehicleOwnerId);
      if (owner?.vin) {
        const wantedSlugs = new Set<string>();
        for (const svc of servicesReported) {
          for (const slug of Q2_TO_SLUGS[svc] ?? []) {
            wantedSlugs.add(slug);
          }
        }
        const serviceIds: Id<"services">[] = [];
        for (const slug of wantedSlugs) {
          const svcRow = await ctx.db
            .query("services")
            .withIndex("by_slug", (q) => q.eq("slug", slug))
            .first();
          if (svcRow) serviceIds.push(svcRow._id);
        }
        if (serviceIds.length > 0) {
          await dismissRecsForReportedServices(ctx, {
            vin: owner.vin,
            serviceIds,
          });
        }
      }
    }

    // Q6: Battery risk escalation
    const q6Answer = answers.Q6 as string | undefined;
    if (q6Answer === "hesitates" || q6Answer === "no_start") {
      const owner = await ctx.db.get(args.vehicleOwnerId);
      const existingIssues = (owner?.knownIssues as string[] | undefined) ?? [];
      const batteryFlag = q6Answer === "no_start" ? "battery_no_start" : "battery_hesitate";
      if (!existingIssues.includes(batteryFlag)) {
        await ctx.db.patch(args.vehicleOwnerId, {
          knownIssues: [...existingIssues, batteryFlag],
        });
      }
    }

    // Q4b: Confirmed-healthy parts → stamp confirmedHealthyAt in customInputs
    const q4bAnswer = Array.isArray(answers.Q4b) ? answers.Q4b : [];
    const HEALTHY_MAP: Record<string, string> = {
      oil_good: "oil",
      brakes_good: "brakes",
      tires_good: "tires",
      battery_good: "battery",
    };
    const confirmedTypes = q4bAnswer
      .map((v: string) => HEALTHY_MAP[v])
      .filter((t): t is string => !!t);

    for (const partType of confirmedTypes) {
      // Always process — Q4b clears symptoms that Q2 doesn't fully cover
      const existing = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q) =>
          q.eq("vehicleOwnerId", args.vehicleOwnerId).eq("type", partType)
        )
        .unique();

      if (existing) {
        // Clear old symptom/issue data — user is confirming "all good"
        const SYMPTOM_KEYS = ["brakeFeel", "squeaking", "tireRepaired", "recency"];
        const currentInputs = (existing.customInputs ?? {}) as Record<string, unknown>;
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(currentInputs)) {
          if (!SYMPTOM_KEYS.includes(k)) cleaned[k] = v;
        }
        await ctx.db.patch(existing._id, {
          customInputs: cleaned,
          confirmedHealthyAt: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("maintenance_records", {
          vehicleOwnerId: args.vehicleOwnerId,
          type: partType,
          confirmedHealthyAt: now,
          serviceSource: "checkin_confirmation",
          confidence: "self_reported",
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Q4b: Also clear warning-light flags for confirmed-healthy parts
    if (confirmedTypes.length > 0) {
      const HEALTHY_TO_LIGHT: Record<string, string> = {
        oil: "oil_pressure",
        brakes: "abs",
        tires: "tpms",
        battery: "battery_charging",
      };
      const lightsToRemove = confirmedTypes
        .map((t: string) => HEALTHY_TO_LIGHT[t])
        .filter(Boolean);
      if (lightsToRemove.length > 0) {
        const owner = await ctx.db.get(args.vehicleOwnerId);
        const currentIssues = (owner?.knownIssues as string[] | undefined) ?? [];
        const cleaned = currentIssues.filter(
          (i: string) => !lightsToRemove.includes(i)
        );
        if (cleaned.length !== currentIssues.length) {
          await ctx.db.patch(args.vehicleOwnerId, { knownIssues: cleaned });
        }
      }
    }

    // Q7: Lease buyout → update ownershipType so pipeline reclassifies correctly
    if (q7Answer === "bought_out") {
      await ctx.db.patch(args.vehicleOwnerId, {
        ownershipType: "owned",
        ownedSinceNew: false,
        lease_ending_soon: false,
      });
    } else if (q7Answer === "ending_soon") {
      await ctx.db.patch(args.vehicleOwnerId, {
        lease_ending_soon: true,
      });
    }

    // Q10: Role change → update garageRole before pipeline reads it
    const q10RoleAnswer = answers.Q10_role as string | undefined;
    if (q10Answer === "changed") {
      const currentOwner = await ctx.db.get(args.vehicleOwnerId);
      const currentRole = currentOwner?.garageRole as string | undefined;
      const newRole = q10RoleAnswer
        ?? (currentRole === "weekend" || currentRole === "stored" ? "primary" : "weekend");
      await ctx.db.patch(args.vehicleOwnerId, {
        garageRole: newRole,
      });
    }

    // Q9: Driving pattern change
    // "more" / "less" = volume change → adjust mileage rate
    // "different" = pattern change → update usage_pattern
    const q9Answer = answers.Q9 as string | undefined;
    if (q9Answer === "more") {
      const currentRate = (await ctx.db.get(args.vehicleOwnerId))?.annual_mileage_rate as number | undefined;
      if (currentRate) {
        await ctx.db.patch(args.vehicleOwnerId, {
          annual_mileage_rate: currentRate * 1.2,
        });
      }
    } else if (q9Answer === "less") {
      const currentRate = (await ctx.db.get(args.vehicleOwnerId))?.annual_mileage_rate as number | undefined;
      if (currentRate) {
        await ctx.db.patch(args.vehicleOwnerId, {
          annual_mileage_rate: currentRate * 0.8,
        });
      }
    } else if (q9Answer === "different") {
      const q9Detail = answers.Q9_detail as string | undefined;
      if (q9Detail && ["city", "highway", "mixed"].includes(q9Detail)) {
        await ctx.db.patch(args.vehicleOwnerId, {
          usage_pattern: q9Detail,
          drivingConditions: q9Detail,
        });
      }
    }

    // Schedule pipeline re-run (all vehicle_owners fields are now updated)
    await ctx.scheduler.runAfter(
      0,
      internal.checkin.processCheckinCompletion,
      {
        vehicleOwnerId: args.vehicleOwnerId,
        checkinId: args.checkinId,
        modeTransition,
        q7Answer: q7Answer ?? null,
        q10Answer: q10Answer ?? null,
      }
    );

    return { success: true, modeTransition };
  },
});

// ============================================================================
// COMPLETION PIPELINE (Internal)
// ============================================================================

/**
 * Process check-in completion: handle mode transitions, then re-run
 * the full maintenance pipeline.
 */
export const processCheckinCompletion = internalAction({
  args: {
    vehicleOwnerId: v.id("vehicle_owners"),
    checkinId: v.id("vehicle_checkins"),
    modeTransition: v.boolean(),
    q7Answer: v.union(v.string(), v.null()),
    q10Answer: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    // Handle mode transitions before running pipeline
    if (args.modeTransition) {
      if (args.q7Answer === "bought_out") {
        // Lease buyout → reclassify to appropriate owned mode
        console.log(
          `[Checkin] Lease buyout for ${args.vehicleOwnerId} — triggering reclassification`
        );
      }
      if (args.q10Answer === "changed") {
        console.log(
          `[Checkin] Role change for ${args.vehicleOwnerId} — triggering reclassification`
        );
      }
    }

    // Run full maintenance pipeline
    const result = await ctx.runAction(internal.maintenance_pipeline.runPipeline, {
      vehicleOwnerId: args.vehicleOwnerId,
      triggeredBy: "checkin",
    });

    // Store classification ID, new mode, and recalc timestamp on the checkin record
    const patchData: Record<string, unknown> = {
      engine_recalc_completed_at: Date.now(),
    };
    if (result && typeof result === "object") {
      if ("classificationId" in result) {
        patchData.new_classification_id = (result as any).classificationId;
      }
      if ("newMode" in result && args.modeTransition) {
        patchData.new_mode = (result as any).newMode;
      }
    }
    await ctx.runMutation(internal.checkin.patchCheckin, {
      checkinId: args.checkinId,
      patch: patchData,
    });

    console.log(
      `[Checkin] Pipeline recalculation complete for ${args.vehicleOwnerId}`
    );
  },
});

export const patchCheckin = internalMutation({
  args: {
    checkinId: v.id("vehicle_checkins"),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.checkinId, args.patch);
  },
});

/**
 * Daily cron: mark health scores as "estimated" when check-in is 30+ days overdue.
 * Per the Quarterly Check-In spec, Stage 3 adds an "estimated" qualifier to the
 * health score display (e.g. ~82 instead of 82).
 */
export const markEstimatedHealthScores = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    const owners = await ctx.db.query("vehicle_owners").collect();
    let updated = 0;
    for (const owner of owners) {
      const nextDue = owner.next_checkin_due as number | undefined;
      if (!nextDue) continue;
      const isOverdue = now > nextDue + thirtyDaysMs;
      const currentlyEstimated = owner.health_score_is_estimated as boolean | undefined;

      if (isOverdue && !currentlyEstimated) {
        await ctx.db.patch(owner._id, { health_score_is_estimated: true });
        updated++;
      }
    }
    if (updated > 0) {
      console.log(`[Cron] Marked ${updated} vehicle(s) health score as estimated`);
    }
  },
});
