/**
 * The descriptive taxonomy for off-catalog work.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Custom jobs used to be filed against `service_categories` — the catalog's
 * merchandising taxonomy ("Routine Maintenance", "Tires & Wheels", "Compliance").
 * That taxonomy describes what a driver can BOOK. Off-catalog work is, by
 * definition, work the catalog can't name, so filing it there produced rows like
 * "Power Window Switch Replacement → Inspections": technically a category, worth
 * nothing to anyone reading it later.
 *
 * This replaces it with two short orthogonal axes:
 *
 *   system    — where on the car (multi-select, 1..CUSTOM_JOB_SYSTEM_MAX)
 *   work_type — what was actually done to it (exactly one)
 *
 * The stacking is the point. 10 + 6 chips describe 60 kinds of work, and the
 * pair carries information neither half does alone: `electrical · diagnose` and
 * `electrical · replace` have different labor curves, different parts needs and
 * different catalog implications. One flat list of twenty categories cannot say
 * that without becoming a list of two hundred.
 *
 * ─── WHAT READS IT ──────────────────────────────────────────────────────────
 *   • Catalog-gap clustering — a second, coarser axis beside `match_key`, so
 *     "walnut blast" / "carbon clean" / "intake decarbon" stop being three
 *     separate gaps and become one `engine · service` gap.
 *   • Labor priors — a population median per (system, work_type) gives a brand
 *     new custom line an estimate before it has any history of its own.
 *   • Parts prediction — see `partsLikelihood`.
 *   • Per-config reliability — custom_jobs already carries vehicle_config_id;
 *     grouping by system turns free text into "4 shops logged electrical work
 *     on this config".
 *
 * Imported by both `convex/` and the client, so it must stay dependency-free.
 */

export const CUSTOM_JOB_SYSTEMS = [
  {
    slug: "engine",
    label: "Engine",
    covers: "Internals, timing, cooling, fuel, intake, forced induction",
  },
  {
    slug: "drivetrain",
    label: "Drivetrain",
    covers: "Transmission, clutch, axles, differentials, transfer case",
  },
  {
    slug: "electrical",
    label: "Electrical",
    covers: "Battery, charging, wiring, switches, modules, lighting",
  },
  {
    slug: "climate",
    label: "Climate",
    covers: "A/C, heating, blower, cabin airflow",
  },
  {
    slug: "suspension_steering",
    label: "Suspension & Steering",
    covers: "Shocks, springs, bushings, alignment, rack, linkage",
  },
  {
    slug: "brakes",
    label: "Brakes",
    covers: "Pads, rotors, calipers, lines, ABS, parking brake",
  },
  {
    slug: "exhaust_emissions",
    label: "Exhaust & Emissions",
    covers: "Pipes, muffler, cats, DPF/EGR, emissions sensors, smog",
  },
  {
    slug: "wheels_tires",
    label: "Wheels & Tires",
    covers: "Tires, rims, TPMS, balancing, hubs, bearings",
  },
  {
    slug: "body_interior",
    label: "Body & Interior",
    covers: "Panels, doors, glass, trim, seats, locks",
  },
  {
    slug: "accessories",
    label: "Accessories & Add-ons",
    covers: "Aftermarket fitment — tow, audio, dashcam, remote start",
  },
] as const;

/**
 * `partsLikelihood` is the whole reason work_type is worth a second tap. It's
 * the cheapest available answer to "should this line prompt the parts step, and
 * should enrichment even try to find an OEM part for it" — a question the
 * survey currently can't ask because a custom line is just a string.
 */
export const CUSTOM_JOB_WORK_TYPES = [
  {
    slug: "diagnose",
    label: "Diagnose",
    covers: "Finding the fault. The repair, if any, is a separate line",
    partsLikelihood: "low",
  },
  {
    slug: "repair",
    label: "Repair",
    covers: "Fixing what's there — weld, reseal, re-pin, patch",
    partsLikelihood: "medium",
  },
  {
    slug: "replace",
    label: "Replace",
    covers: "Old part out, new part in",
    partsLikelihood: "high",
  },
  {
    slug: "service",
    label: "Service",
    covers: "Fluids, cleaning, scheduled upkeep",
    partsLikelihood: "medium",
  },
  {
    slug: "install",
    label: "Install",
    covers: "Fitting something that wasn't on the car before",
    partsLikelihood: "high",
  },
  {
    slug: "adjust",
    label: "Adjust / Calibrate",
    covers: "Aim, align, program, re-learn, torque",
    partsLikelihood: "low",
  },
] as const;

export type CustomJobSystem = (typeof CUSTOM_JOB_SYSTEMS)[number]["slug"];
export type CustomJobWorkType = (typeof CUSTOM_JOB_WORK_TYPES)[number]["slug"];

/**
 * Ticking six systems says no more than ticking none — the row stops describing
 * a job and starts describing a car. Three is enough for genuinely cross-system
 * work (a leaking heater core is climate + engine) without letting the field
 * decay into a checklist.
 */
export const CUSTOM_JOB_SYSTEM_MAX = 3;

const SYSTEM_SLUGS = new Set<string>(CUSTOM_JOB_SYSTEMS.map((s) => s.slug));
const WORK_TYPE_SLUGS = new Set<string>(
  CUSTOM_JOB_WORK_TYPES.map((w) => w.slug),
);

export function isCustomJobSystem(value: unknown): value is CustomJobSystem {
  return typeof value === "string" && SYSTEM_SLUGS.has(value);
}

export function isCustomJobWorkType(
  value: unknown,
): value is CustomJobWorkType {
  return typeof value === "string" && WORK_TYPE_SLUGS.has(value);
}

export function customJobSystemLabel(slug: string): string {
  return CUSTOM_JOB_SYSTEMS.find((s) => s.slug === slug)?.label ?? slug;
}

export function customJobWorkTypeLabel(slug: string): string {
  return CUSTOM_JOB_WORK_TYPES.find((w) => w.slug === slug)?.label ?? slug;
}

/**
 * Drop unknown slugs, de-duplicate, preserve the mechanic's ordering (the first
 * pick is the primary system), and cap the list. Order matters downstream: the
 * gap-clustering read groups on the primary, not the set.
 */
export function normalizeCustomJobSystems(input: unknown): CustomJobSystem[] {
  if (!Array.isArray(input)) return [];
  const out: CustomJobSystem[] = [];
  for (const raw of input) {
    if (!isCustomJobSystem(raw)) continue;
    if (out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= CUSTOM_JOB_SYSTEM_MAX) break;
  }
  return out;
}

export type CustomJobTaxonomy = {
  system_tags: CustomJobSystem[];
  work_type: CustomJobWorkType;
};

/**
 * The single enforcement point. Every write path funnels through here rather
 * than validating in its own arg validator, because the guarantee we want is
 * "no custom_jobs row exists without a taxonomy", and per-entry-point checks
 * are exactly how a fourth entry point later ships without one.
 *
 * Throws with mechanic-readable copy — these messages surface as toasts.
 */
export function requireCustomJobTaxonomy(input: {
  system_tags?: unknown;
  work_type?: unknown;
  /** Used in the error so a multi-line submit names the offending line. */
  jobName?: string;
}): CustomJobTaxonomy {
  const where = input.jobName ? ` for "${input.jobName}"` : "";
  const systems = normalizeCustomJobSystems(input.system_tags);
  if (systems.length === 0) {
    throw new Error(`Pick at least one system${where}.`);
  }
  if (!isCustomJobWorkType(input.work_type)) {
    throw new Error(`Pick what kind of work this was${where}.`);
  }
  return { system_tags: systems, work_type: input.work_type };
}

/** "Electrical · Replace", or "Electrical +1 · Replace" when stacked. */
export function describeCustomJobTaxonomy(
  systemTags: readonly string[] | null | undefined,
  workType: string | null | undefined,
): string {
  const systems = (systemTags ?? []).filter(isCustomJobSystem);
  if (systems.length === 0 && !workType) return "Uncategorised";
  const head = systems.length
    ? customJobSystemLabel(systems[0]) +
      (systems.length > 1 ? ` +${systems.length - 1}` : "")
    : "Uncategorised";
  return workType ? `${head} · ${customJobWorkTypeLabel(workType)}` : head;
}

/**
 * The clustering key for the coarse gap read — deliberately the PRIMARY system
 * only, not the full set, so two shops that tagged the same job with different
 * secondary systems still land in one cluster.
 */
export function customJobTaxonomyKey(
  systemTags: readonly string[] | null | undefined,
  workType: string | null | undefined,
): string | null {
  const primary = (systemTags ?? []).find(isCustomJobSystem);
  if (!primary || !isCustomJobWorkType(workType)) return null;
  return `${primary}:${workType}`;
}

export function customJobPartsLikelihood(
  workType: string | null | undefined,
): "high" | "medium" | "low" | null {
  const row = CUSTOM_JOB_WORK_TYPES.find((w) => w.slug === workType);
  return row ? row.partsLikelihood : null;
}
