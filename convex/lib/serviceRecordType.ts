/**
 * serviceRecordType.ts — pure map from a canonical (snake_case) otopair service
 * slug → the maintenance_records `type` that booking completion writes back to
 * vehicle health.
 *
 * Fixes #90: the prior inline `SLUG_TO_TYPE` map in bookings.ts:runCompletionSideEffects
 * keyed on KEBAB-case slugs ("oil-change", "brake-pads") while production
 * `services.slug` is snake_case ("oil_change", "brake_pad_replacement"). So the
 * lookup was ALWAYS undefined → `continue` → completion silently wrote no
 * maintenance_records, and the health record / due-status never reflected the
 * completed service. Keys here are the real slugs (verified against `services.list`).
 *
 * Pairs with serviceSymptoms.symptomForRecordType to ALSO clear the matching
 * knownIssue warning code when the service is completed (so a flagged warning
 * light clears once the service is done).
 *
 * `pre_purchase_inspection` is intentionally unmapped — completing a PPI is not a
 * maintenance reset and must not reset the state-inspection due clock.
 *
 * Bug #413 / #428: the same rule holds for upkeep done ON a tracked part. The
 * "tires" record measures tread life (tire_replacement, 50,000 mi) and "battery"
 * measures battery age, so a rotation, balance or alignment used to hand the car
 * a full new set of tires, and a battery TEST a brand-new battery. Only the
 * service that replaces the part resets its life. The checks and upkeep below
 * are unmapped here and get their own per-service anchor instead
 * (`serviceAnchorRecordType`), so they are still recorded, just not as a
 * replacement.
 */
export const SERVICE_SLUG_TO_RECORD_TYPE: Record<string, string> = {
  oil_change: "oil",
  brake_pad_replacement: "brakes",
  rotor_replacement: "brakes",
  tire_replacement: "tires",
  battery_replacement: "battery",
  brake_fluid_flush: "fluids",
  coolant_flush: "fluids",
  transmission_service: "fluids",
  power_steering_flush: "fluids",
  differential_service: "fluids",
  filter_replacement: "filters",
  spark_plugs: "engine_parts",
  timing_belt: "engine_parts",
  fuel_system_cleaning: "engine_parts",
  diagnostic_scan: "diagnostics",
  check_engine_light: "diagnostics",
  state_inspection: "inspection",
  emissions_test: "inspection",
};

/** Resolve a service slug to its maintenance record type, or null when the
 *  service does not map to a health record (no write-back on completion). */
export function recordTypeForServiceSlug(slug: string): string | null {
  return SERVICE_SLUG_TO_RECORD_TYPE[slug] ?? null;
}

/**
 * Second, finer-grained map for the Consolidated Upkeep model's minor items.
 *
 * The map above deliberately collapses every fluid service into one shared
 * `"fluids"` record (and both filters into `"filters"`) — that aggregate is
 * load-bearing for the pipeline and predates this feature, so it stays.
 * But the minor-item grades written by
 * `convex/lib/inspectionHealth.ts`'s `deriveMinorGrades` live on their own
 * per-field `minor_*` rows (see `MINOR_ITEM_RECORD_TYPES` in
 * utils/mergedMaintenance.ts), which the aggregate never touches. Without
 * this second map, a completed Brake Fluid Flush bumps `"fluids"` while
 * `minor_bf_condition` keeps its red grade forever — the "until next
 * service" expiry the plan promises never fires, because
 * `isMechanicGradeStale` (utils/maintenanceStatus.ts) has no
 * `lastServiceDate` to compare its `mechanicGradedAt` against.
 *
 * Completion writes BOTH: the aggregate (unchanged behavior) and, when the
 * slug appears here, the specific `minor_*` row.
 */
export const SERVICE_SLUG_TO_MINOR_RECORD_TYPE: Record<string, string> = {
  brake_fluid_flush: "minor_bf_condition",
  coolant_flush: "minor_cool_condition",
  transmission_service: "minor_trans",
  power_steering_flush: "minor_ps",
  filter_replacement: "minor_filter",
};

/** Resolve a service slug to the Consolidated-model minor record type it
 *  services, or null when the service doesn't correspond to one. */
export function minorRecordTypeForServiceSlug(slug: string): string | null {
  return SERVICE_SLUG_TO_MINOR_RECORD_TYPE[slug] ?? null;
}

/** The record types that ARE a single service's own anchor, so a slug that
 *  maps to one needs no second, per-service row. */
const CORE_RECORD_TYPES: ReadonlySet<string> = new Set([
  "oil",
  "brakes",
  "tires",
  "battery",
  "inspection",
]);

/**
 * The per-service anchor: the one maintenance_records row that says "THIS
 * service was last done here", for services whose aggregate is shared or absent.
 *
 * Bug #206 / #428: the tracker's catalog rows (spark plugs, differential
 * service, timing belt…) only read a per-service anchor, and only five services
 * had one (the `minor_*` rows above). Everything else wrote just its shared
 * aggregate ("engine_parts", "fluids"), which the tracker deliberately ignores
 * because it would retire every sibling service. So a shop could replace the
 * spark plugs and the car would still read "spark plugs — overdue" the moment
 * the job closed. Every catalog service now gets an anchor of its own: the
 * existing `minor_*` row where there is one, `service_<slug>` otherwise.
 *
 * Returns null for services whose aggregate already is their anchor (oil
 * change → "oil"), so completion does not write a redundant second row.
 */
export function serviceAnchorRecordType(slug: string): string | null {
  if (!slug) return null;
  const minor = minorRecordTypeForServiceSlug(slug);
  if (minor) return minor;
  const aggregate = recordTypeForServiceSlug(slug);
  if (aggregate && CORE_RECORD_TYPES.has(aggregate)) return null;
  return `service_${slug}`;
}

/** Every maintenance_records type a completed service stamps: its own anchor
 *  first, then the shared aggregate (unchanged behaviour). Shared by booking
 *  completion, the backfill and Oto's "I had it done" path so all three write
 *  the same rows. */
export function recordTypesForCompletedService(slug: string): string[] {
  const out: string[] = [];
  for (const type of [serviceAnchorRecordType(slug), recordTypeForServiceSlug(slug)]) {
    if (type && !out.includes(type)) out.push(type);
  }
  return out;
}

/** The pipeline's last-service anchor for one service: the shared aggregate
 *  where one exists (unchanged), otherwise the service's own anchor — which is
 *  what keeps a tire rotation spec anchored now that it no longer stamps
 *  "tires". */
export function anchorRecordTypeForServiceSlug(slug: string): string | null {
  return recordTypeForServiceSlug(slug) ?? serviceAnchorRecordType(slug);
}

/**
 * Upkeep the shop does ON a tracked part without replacing it. Completing one
 * stamps its own anchor (above) and never the part's life record. Read by the
 * tracker so the part's card can say "Tire rotation logged by …" instead of
 * pretending the part is new.
 */
export const UPKEEP_SLUGS_BY_RECORD_TYPE: Readonly<Record<string, readonly string[]>> = {
  tires: ["tire_rotation", "tire_balance", "wheel_alignment"],
  battery: ["battery_test"],
};

/**
 * Driver-reported condition answers that a completed service of this type
 * supersedes. A brake job answers "my brakes squeak"; a tire replacement
 * answers "losing air" and replaces a patched tire. Without clearing them, the
 * card a shop just serviced stays in "needs attention" on the strength of a
 * report from BEFORE the work — "you had brakes done 0 months and 0 mi ago,
 * you're getting close to due" (bug #428). The mechanic's own grade needs no
 * entry here: it is retired by timestamp in utils/maintenanceStatus.ts.
 */
export const SUPERSEDED_INPUTS_BY_RECORD_TYPE: Readonly<Record<string, readonly string[]>> = {
  brakes: ["brakeFeel", "squeaking"],
  tires: ["symptom", "tireRepaired", "tirePressure"],
};
