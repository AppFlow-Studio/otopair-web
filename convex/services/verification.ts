import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// Schema stores overall_accuracy as a v.number() (0–1 float) so the director
// panel's AccuracyBar can render a percentage. The mechanic app submits the
// human-friendly enum below — keep it at the API boundary, map to a number
// before insert. If you add/rename an enum value, update this map.
const ACCURACY_BY_ENUM: Record<string, number> = {
  accurate: 1.0,
  mostly_accurate: 0.85,
  needs_correction: 0.5,
};

function accuracyEnumToNumber(value: string): number {
  const n = ACCURACY_BY_ENUM[value];
  // Fall back to 0 instead of NaN so the row still renders and downstream
  // logic that compares against thresholds doesn't break.
  return typeof n === "number" ? n : 0;
}

/**
 * Stores a mechanic's post-job verification submission as "pending".
 * Review and application of corrections is handled externally.
 *
 * REMOVED from this function (move to external review project):
 *
 * 1. enrichment_evidence writes
 *    - "confirmed" fields → insert evidence row with confidence 0.98
 *    - "corrected" fields → mark previous evidence is_latest=false,
 *      insert new evidence row with confidence 0.99
 *    - Uses getEntityTypeForField() to map field_name → entity_type
 *      ("engine" | "transmission" | "trim_spec" | "drivetrain_config" | "vehicle_config")
 *
 * 2. labor_times empirical update
 *    - If actual_labor_hours provided: rolling average over empirical_sample_size
 *    - Once sample_size >= 3, source switches from "mechanic_verified" → "empirical"
 *
 * 3. vehicle_configs verification status update
 *    - Increments verification_count
 *    - Sets last_verified_at
 *    - Sets enrichment_status = "verified" once verification_count >= 3
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

    const verificationId = await ctx.db.insert("mechanic_verifications", {
      mechanic_id: args.mechanic_id,
      vehicle_config_id: args.vehicle_config_id,
      job_id: args.job_id,
      service_id: args.service_id,
      verifications: args.verifications,
      actual_labor_hours: args.actual_labor_hours,
      parts_used_correct: args.parts_used_correct,
      overall_accuracy: accuracyEnumToNumber(args.overall_accuracy),
      status: "pending",
      verified_at: now,
      created_at: now,
    });

    return verificationId;
  },
});
