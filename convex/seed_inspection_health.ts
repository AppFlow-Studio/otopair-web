import { mutation } from "./_generated/server";

/**
 * Default config for every inspection field capable of a yellow/red
 * reading — mirrors the hardcoded mapping in convex/lib/inspectionHealth.ts
 * (core grades) and lib/inspection-template.ts's deriveSuggestedRecommendations
 * (suggestion resolution). Director-editable via the "Inspection health
 * weights" panel; this seed just gives that editor real starting rows that
 * match what already ships.
 *
 * `maps_to`: the core type ("oil" | "brakes" | "tires" | "battery" |
 * "inspection"), "minor" for a Consolidated-model weight-10 item, or
 * "freeform" for a field with no catalog match (never scores).
 */
const DEFAULT_CONFIG = [
  // Core — oil
  { field_key: "oil_condition", maps_to: "oil", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "oil_change", rec_urgency: "soon", rec_copy: "Oil condition flagged during inspection" },
  // Core — brakes
  { field_key: "brake_visual", maps_to: "brakes", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "brake_pad_replacement", rec_urgency: "soon", rec_copy: "Uneven brake wear reported" },
  { field_key: "pad_inner", maps_to: "brakes", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "brake_pad_replacement", rec_urgency: "soon", rec_copy: "Brake pad thickness critically low" },
  { field_key: "pad_outer", maps_to: "brakes", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "brake_pad_replacement", rec_urgency: "soon", rec_copy: "Brake pad thickness critically low" },
  { field_key: "rotor", maps_to: "brakes", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "rotor_replacement", rec_urgency: "soon", rec_copy: "Rotor below minimum spec" },
  { field_key: "desc", maps_to: "brakes", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "rotor_replacement", rec_urgency: "within_3_months", rec_copy: "Rotor surface scored/warped" },
  { field_key: "bf_level", maps_to: "brakes", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "brake_pad_replacement", rec_urgency: "within_3_months", rec_copy: "Brake fluid level dropped since last visit — pad wear signal" },
  { field_key: "bf_leak", maps_to: "brakes", yellow_status: "overdue", red_status: "overdue", rec_service_slug: undefined, rec_urgency: "soon", rec_copy: "Active brake fluid leak reported" },
  // Core — tires
  { field_key: "wear", maps_to: "tires", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "tire_replacement", rec_urgency: "soon", rec_copy: "Uneven tire wear reported" },
  { field_key: "tread", maps_to: "tires", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "tire_replacement", rec_urgency: "soon", rec_copy: "Tread depth critically low" },
  // Core — battery
  { field_key: "batt", maps_to: "battery", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "battery_replacement", rec_urgency: "soon", rec_copy: "Battery load test below spec" },
  { field_key: "term", maps_to: "battery", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Corroded/loose battery terminals reported" },
  // Minor — catalog-matched, Consolidated weight-10 model
  { field_key: "bf_condition", maps_to: "minor", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "brake_fluid_flush", rec_urgency: "within_3_months", rec_copy: "Brake fluid condition flagged" },
  { field_key: "cool_condition", maps_to: "minor", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "coolant_flush", rec_urgency: "within_3_months", rec_copy: "Coolant condition flagged on eye-check" },
  { field_key: "trans", maps_to: "minor", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "transmission_service", rec_urgency: "within_3_months", rec_copy: "Transmission fluid flagged on eye-check" },
  { field_key: "ps", maps_to: "minor", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "power_steering_flush", rec_urgency: "within_3_months", rec_copy: "Power steering fluid flagged on eye-check" },
  { field_key: "cf", maps_to: "minor", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "filter_replacement", rec_urgency: "within_3_months", rec_copy: "Cabin air filter flagged" },
  { field_key: "af", maps_to: "minor", yellow_status: "needs_attention", red_status: "overdue", rec_service_slug: "filter_replacement", rec_urgency: "within_3_months", rec_copy: "Engine air filter flagged" },
  // Freeform — no catalog match, never scores, "recommended — not yet offered by Otopair"
  { field_key: "oil_level", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Oil Top-Off" },
  { field_key: "cool_level", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Coolant Top-Off" },
  { field_key: "belt", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Drive belt flagged" },
  { field_key: "washer", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "next_visit", rec_copy: "Washer fluid low" },
  { field_key: "caliper", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Caliper slides/boots flagged" },
  { field_key: "ball_joint_play", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "soon", rec_copy: "Ball-joint play detected" },
  { field_key: "wheel_bearing_play", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "soon", rec_copy: "Wheel-bearing play detected" },
  { field_key: "hose", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Hose flagged" },
  { field_key: "brake_hose", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "soon", rec_copy: "Brake hose flagged" },
  { field_key: "link", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Steering play detected" },
  { field_key: "cv", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "CV boot/joint flagged" },
  { field_key: "strut", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Strut flagged" },
  { field_key: "exh", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Exhaust flagged" },
  { field_key: "lamp", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "soon", rec_copy: "Headlight/hazard/tail light flagged" },
  { field_key: "glass", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Glass/windshield flagged" },
  { field_key: "horn", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Horn flagged" },
  { field_key: "leaks", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "soon", rec_copy: "Fluid leak observed" },
  { field_key: "damage", maps_to: "freeform", yellow_status: undefined, red_status: undefined, rec_service_slug: undefined, rec_urgency: "within_3_months", rec_copy: "Damage observed" },
] as const;

/**
 * Idempotent seed: inserts or updates one row per inspection field key.
 * Safe to re-run without duplicating rows.
 *
 * Run via: npx convex run seed_inspection_health:seedInspectionHealth
 */
export const seedInspectionHealth = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const row of DEFAULT_CONFIG) {
      const existing = await ctx.db
        .query("inspection_health_config")
        .withIndex("by_field_key", (q) => q.eq("field_key", row.field_key))
        .unique();
      const patch = { ...row, updated_at: now };
      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("inspection_health_config", patch);
      }
    }
    return { seeded: DEFAULT_CONFIG.length };
  },
});
