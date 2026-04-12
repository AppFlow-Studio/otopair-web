import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/** Maps field names to their entity type for enrichment_evidence rows. */
function getEntityTypeForField(fieldName: string): string {
  const engineFields = new Set([
    "oil_viscosity",
    "oil_spec_standard",
    "oil_capacity_qts",
    "coolant_type",
    "coolant_capacity_qts",
    "spark_plug_quantity",
    "spark_plug_gap_mm",
    "timing_system",
    "timing_idler_count",
    "water_pump_timing_driven",
    "fuel_injection",
    "configuration",
    "aspiration",
    "has_serpentine_belt",
    "engine_family",
    "displacement_l",
  ]);

  const transmissionFields = new Set([
    "fluid_type",
    "fluid_capacity_drain_fill_qts",
    "is_lifetime_fill",
    "has_serviceable_filter",
    "service_method",
    "transmission_type",
  ]);

  const trimSpecFields = new Set([
    "front_tire_size",
    "rear_tire_size",
    "tire_pressure_front",
    "tire_pressure_rear",
    "is_staggered",
    "tire_directional",
    "is_run_flat",
    "lug_nut_torque_ft_lbs",
    "alignment_type",
    "front_wiper_size_in",
    "rear_wiper_size_in",
    "battery_group",
    "battery_cca",
    "battery_type",
    "battery_location",
  ]);

  const drivetrainFields = new Set([
    "drivetrain_type",
    "has_differential",
    "diff_fluid_type",
    "diff_fluid_capacity_qts",
    "lsd_additive_required",
    "has_transfer_case",
    "tc_fluid_type",
    "tc_fluid_capacity_qts",
  ]);

  if (engineFields.has(fieldName)) return "engine";
  if (transmissionFields.has(fieldName)) return "transmission";
  if (trimSpecFields.has(fieldName)) return "trim_spec";
  if (drivetrainFields.has(fieldName)) return "drivetrain_config";
  return "vehicle_config";
}

/**
 * Processes a mechanic's post-job verification feedback.
 *
 * 1. Stores the mechanic_verifications record
 * 2. Creates enrichment_evidence rows for confirmed/corrected fields
 * 3. Updates labor_times empirical data if actual hours provided
 * 4. Updates vehicle_configs verification count and status
 */
export const processMechanicVerification = internalMutation({
  args: {
    mechanic_id: v.id("mechanics"),
    vehicle_config_id: v.id("vehicle_configs"),
    job_id: v.optional(v.id("job_actuals")),
    service_id: v.id("services"),
    verifications: v.array(
      v.object({
        field_name: v.string(),
        our_value: v.string(),
        status: v.string(), // "confirmed" | "corrected" | "unknown"
        corrected_value: v.optional(v.string()),
        notes: v.optional(v.string()),
      })
    ),
    actual_labor_hours: v.optional(v.float64()),
    parts_used_correct: v.optional(v.boolean()),
    overall_accuracy: v.string(), // "accurate" | "mostly_accurate" | "needs_correction"
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // ── Step 1: Store the verification record ──
    const verificationId = await ctx.db.insert("mechanic_verifications", {
      mechanic_id: args.mechanic_id,
      vehicle_config_id: args.vehicle_config_id,
      job_id: args.job_id,
      service_id: args.service_id,
      verifications: args.verifications,
      actual_labor_hours: args.actual_labor_hours,
      parts_used_correct: args.parts_used_correct,
      overall_accuracy: args.overall_accuracy,
      verified_at: now,
      created_at: now,
    });

    const entityId = args.vehicle_config_id as string;

    // ── Steps 2 & 3: Process each field verification ──
    for (const verification of args.verifications) {
      const entityType = getEntityTypeForField(verification.field_name);

      if (verification.status === "confirmed") {
        // Insert evidence confirming the existing value
        await ctx.db.insert("enrichment_evidence", {
          entity_type: entityType,
          entity_id: entityId,
          field_name: verification.field_name,
          observed_value: verification.our_value,
          observed_type: "string",
          source_type: "mechanic",
          confidence: 0.98,
          is_latest: true,
          observed_at: now,
          created_at: now,
        });
      } else if (
        verification.status === "corrected" &&
        verification.corrected_value !== undefined
      ) {
        // Mark all previous evidence for this entity+field as not latest
        const previousEvidence = await ctx.db
          .query("enrichment_evidence")
          .withIndex("by_entity", (q) =>
            q
              .eq("entity_type", entityType)
              .eq("entity_id", entityId)
              .eq("field_name", verification.field_name)
          )
          .collect();

        for (const prev of previousEvidence) {
          if (prev.is_latest) {
            await ctx.db.patch(prev._id, { is_latest: false });
          }
        }

        // Insert corrected value as new latest evidence
        await ctx.db.insert("enrichment_evidence", {
          entity_type: entityType,
          entity_id: entityId,
          field_name: verification.field_name,
          observed_value: verification.corrected_value,
          observed_type: "string",
          source_type: "mechanic",
          confidence: 0.99,
          is_latest: true,
          observed_at: now,
          created_at: now,
        });
      }
      // "unknown" status — no evidence action needed
    }

    // ── Step 4: Update labor_times empirical data ──
    if (args.actual_labor_hours !== undefined) {
      const existingLaborTime = await ctx.db
        .query("labor_times")
        .withIndex("by_vehicle_config", (q) =>
          q
            .eq("vehicle_config_id", args.vehicle_config_id)
            .eq("service_id", args.service_id)
        )
        .first();

      if (existingLaborTime) {
        const oldSample = existingLaborTime.empirical_sample_size;
        const oldEmpirical = existingLaborTime.empirical_hours ?? existingLaborTime.book_hours;
        const newSample = oldSample + 1;
        const newEmpirical =
          (oldEmpirical * oldSample + args.actual_labor_hours) / newSample;

        await ctx.db.patch(existingLaborTime._id, {
          empirical_hours: newEmpirical,
          empirical_sample_size: newSample,
          source: newSample >= 3 ? "empirical" : existingLaborTime.source,
        });
      } else {
        await ctx.db.insert("labor_times", {
          vehicle_config_id: args.vehicle_config_id,
          service_id: args.service_id,
          book_hours: args.actual_labor_hours,
          empirical_hours: args.actual_labor_hours,
          empirical_sample_size: 1,
          source: "mechanic_verified",
          created_at: now,
        });
      }
    }

    // ── Step 5: Update vehicle_configs verification status ──
    const vehicleConfig = await ctx.db.get(args.vehicle_config_id);
    if (vehicleConfig) {
      const newCount = vehicleConfig.verification_count + 1;
      await ctx.db.patch(args.vehicle_config_id, {
        verification_count: newCount,
        last_verified_at: now,
        enrichment_status:
          newCount >= 3 ? "verified" : vehicleConfig.enrichment_status,
      });
    }

    return verificationId;
  },
});
