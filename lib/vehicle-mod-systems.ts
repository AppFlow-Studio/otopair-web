// The "brain": coarse affected-system tags the shop picks, mapped to the exact
// service slugs they should flag. Powers the live preview at entry time and
// (Phase B) the future-job flag. Pure module — no React, no Convex.

export const AFFECTED_SYSTEMS = [
  { value: "suspension_ride_height", label: "Suspension / ride height" },
  { value: "wheels_tires", label: "Wheels & tires" },
  { value: "brakes", label: "Brakes" },
  { value: "exhaust_emissions", label: "Exhaust / emissions" },
  { value: "engine_drivetrain", label: "Engine / drivetrain" },
  { value: "electrical_lighting", label: "Electrical / lighting" },
  { value: "cosmetic_only", label: "Cosmetic only" },
] as const;

export type AffectedSystem = (typeof AFFECTED_SYSTEMS)[number]["value"];

export function affectedSystemLabel(value: AffectedSystem): string {
  return AFFECTED_SYSTEMS.find((s) => s.value === value)?.label ?? value;
}

export type ModServiceRef = { slug: string; name: string };

// Locked product taxonomy (slug -> display name). Slugs need not all exist in a
// given deployment's services table for the preview; Phase B matches booked
// service slugs against the union.
export const SYSTEM_SERVICE_MAP: Record<AffectedSystem, ModServiceRef[]> = {
  suspension_ride_height: [
    { slug: "wheel_alignment", name: "Wheel Alignment" },
    { slug: "tire_balance", name: "Tire Balance" },
    { slug: "tire_rotation", name: "Tire Rotation" },
    { slug: "tire_replacement", name: "Tire Replacement" },
  ],
  wheels_tires: [
    { slug: "tire_balance", name: "Tire Balance" },
    { slug: "wheel_alignment", name: "Wheel Alignment" },
    { slug: "tire_rotation", name: "Tire Rotation" },
    { slug: "tire_replacement", name: "Tire Replacement" },
    { slug: "brake_pad_replacement", name: "Brake Pad Replacement" },
    { slug: "rotor_replacement", name: "Rotor Replacement" },
  ],
  brakes: [
    { slug: "brake_pad_replacement", name: "Brake Pad Replacement" },
    { slug: "rotor_replacement", name: "Rotor Replacement" },
    { slug: "brake_fluid_flush", name: "Brake Fluid Flush" },
  ],
  exhaust_emissions: [
    { slug: "emissions_test", name: "Emissions Test" },
    { slug: "state_inspection", name: "State Inspection" },
    { slug: "check_engine_light", name: "Check Engine Light Diagnosis" },
    { slug: "diagnostic_scan", name: "Diagnostic Scan" },
  ],
  engine_drivetrain: [
    { slug: "oil_change", name: "Oil Change" },
    { slug: "spark_plugs", name: "Spark Plugs" },
    { slug: "fuel_system_cleaning", name: "Fuel System Cleaning" },
    { slug: "filter_replacement", name: "Filter Replacement" },
    { slug: "check_engine_light", name: "Check Engine Light Diagnosis" },
    { slug: "diagnostic_scan", name: "Diagnostic Scan" },
    { slug: "emissions_test", name: "Emissions Test" },
    { slug: "transmission_service", name: "Transmission Service" },
    { slug: "differential_service", name: "Differential Service" },
  ],
  electrical_lighting: [
    { slug: "battery_test", name: "Battery Test" },
    { slug: "battery_replacement", name: "Battery Replacement" },
    { slug: "check_engine_light", name: "Check Engine Light Diagnosis" },
  ],
  cosmetic_only: [],
};

// Distinct union of services for the selected systems, in first-seen order.
// cosmetic_only contributes nothing.
export function servicesForSystems(systems: AffectedSystem[]): ModServiceRef[] {
  const seen = new Set<string>();
  const out: ModServiceRef[] = [];
  for (const sys of systems) {
    for (const svc of SYSTEM_SERVICE_MAP[sys] ?? []) {
      if (!seen.has(svc.slug)) {
        seen.add(svc.slug);
        out.push(svc);
      }
    }
  }
  return out;
}

// Normalize a service slug so hyphen/underscore variants match (the deployment
// has both "oil-change" and "oil_change"). Lowercase, collapse separators to "-".
export function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[\s_-]+/g, "-");
}

// Slugs of every service the selected systems flag (deduped union).
export function affectedServiceSlugs(systems: AffectedSystem[]): Set<string> {
  return new Set(servicesForSystems(systems).map((s) => normalizeSlug(s.slug)));
}

// True if any of the booking's service slugs is flagged by the systems.
export function anyServiceAffected(
  serviceSlugs: string[],
  systems: AffectedSystem[]
): boolean {
  const affected = affectedServiceSlugs(systems);
  return serviceSlugs.some((slug) => affected.has(normalizeSlug(slug)));
}
