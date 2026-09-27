/**
 * mergedMaintenance — the single, shared vehicle-item merge used by BOTH the
 * Cars-page health ring (hooks/useMaintenanceData.ts useMergedMaintenance) and
 * Oto's server-side get_vehicle_health score (convex/oto/vehicleHealth.ts).
 *
 * Extracted verbatim from useMergedMaintenance so the two consumers compute the
 * SAME MaintenanceItem[] from the same inputs — which is what lets Oto's stated
 * health score converge with the ring the user sees, with zero drift. It is a
 * pure function (takes an already-built per-type userItems map + records + the
 * per-vehicle signals); no React, no Convex, no `@/` value imports beyond the
 * pure builders it composes.
 *
 * The no-record fallbacks here are the ring's OPTIMISTIC ones (oil -> due_soon,
 * others -> on_time). Oto keeps its own conservative "unknown" fallback for the
 * items it REPORTS to the user (the F1 anti-fabrication behavior); this shared
 * merge is used only to compute the score that must match the ring.
 */

import type {
  MaintenanceItem,
  MaintenanceTriggerAxis,
} from "@/components/cars/MaintenanceTracker";
import {
  ALL_MAINTENANCE_TYPES,
  MAINTENANCE_LABELS,
  computeFromOdometerStatus,
  STATUS_SEVERITY_ORDER,
  INTERVAL_SCORE_EQUIVALENT,
  type MaintenanceType,
  type OemServiceIntervalsInput,
} from "@/utils/maintenanceStatus";
import { enrichUrgentItem } from "@/utils/maintenanceEnrichment";
import { buildWarningLightItem } from "@/lib/warningLightItems";
import { canonicalWarningLights } from "@/lib/warningLightVocab";
import {
  clampClassIntervalToBounds,
  isTrustedInterval,
  safeInterval,
} from "@/utils/serviceIntervalGuardrails";
import { CLASS_INTERVAL_SLUGS, classInterval } from "@/utils/classIntervals";
// One definition of "months since the car was new" — the Bigger Services tile
// measures the time axis from the same place, and the two must agree.
import { ageMonths } from "@/utils/quickCheckFiring";
import type { IntervalClassContext } from "@/utils/maintenanceStatus";
import { TAXONOMY } from "@/constants/serviceTaxonomy";
import { formatMileage } from "@/lib/vehicle-passport";
// Slug → its slug-specific "minor" anchor. Single source of truth (same map
// booking completion writes back to), so a from-odometer inference item closes
// out against the exact service that was done. Client already imports from
// @/convex/lib elsewhere (see cars/index.tsx → vinIdentity).
import { minorRecordTypeForServiceSlug } from "@/convex/lib/serviceRecordType";

/** Minimal shape of a driver-visible mechanic recommendation, mirrored from
 *  api.jobRecommendations.getDriverVisibleRecsForVehicle. */
export interface DriverRecommendationLike {
  _id: string;
  service_id: string | null;
  service_name: string;
  urgency: "next_visit" | "within_3_months" | "soon";
  reason: string | null;
  shop_name: string | null;
  mechanic_name: string | null;
  target_mileage?: number | null;
  scheduled_at?: number | null;
  scheduled_mechanic_name?: string | null;

  /* ── Advisories (off-catalog recommendations) ───────────────────────────
     A mechanic can flag work that ISN'T in the catalog — "that CV boot is
     starting to weep". The server already distinguishes these (`kind`), and
     has done since the feature shipped; the app just wasn't reading the
     fields, so an advisory arrived looking like an ordinary recommendation
     and was rendered with a Book CTA that has nothing behind it.

     An advisory has no service_id because no catalog service exists to
     price or book. That's the whole distinction — everything below follows
     from it. */
  kind?: "advisory" | "canonical";
  bookable?: boolean;
  /** One fixed sentence, identical on the card, the reminder and in history,
   *  so the driver reads the same framing everywhere. */
  disclaimer?: string | null;
  /** "Mike at Brooklyn Auto suggests" — on an advisory the attribution IS
   *  the headline. This is one person's professional opinion, not an Otopair
   *  position, and naming them is what makes that legible. */
  author_label?: string | null;
  /** Advisories never expire the way a scheduled service does; past a
   *  threshold they soften rather than disappearing. */
  aged?: boolean;
}

export function recUrgencyToStatus(
  urgency: DriverRecommendationLike["urgency"],
): MaintenanceItem["status"] {
  if (urgency === "soon") return "overdue";
  if (urgency === "next_visit") return "due_soon";
  return "needs_attention";
}

export function recUrgencyDetail(
  urgency: DriverRecommendationLike["urgency"],
): string {
  if (urgency === "soon") return "Service soon";
  if (urgency === "next_visit") return "Next visit";
  return "Within 3 months";
}

/** Paired maintenance type → canonical light id that escalates it to Now tier. */
const PAIRED_LIGHT_BY_TYPE: Partial<Record<MaintenanceType, string>> = {
  oil: "oil_pressure",
  battery: "battery_charging",
  brakes: "abs",
  tires: "tpms",
};

/** Catalog slugs whose cadence is already covered by one of the five
 *  anchored `maintenance_records` types. Everything else falls into
 *  the from-odometer inference path (proposal Behavior #7). */
const CATALOG_SLUGS_TO_SKIP: ReadonlySet<string> = new Set([
  "oil_change",
  "brake_pad_replacement",
  "tire_rotation",
  "tire_balance",
  "tire_replacement",
  "wheel_alignment",
  "battery_replacement",
  "battery_test",
  "state_inspection",
  "emissions_test",
  "check_engine_light",
  "diagnostic_scan",
  "pre_purchase_inspection",
]);

/** Anchored type → the taxonomy slug whose OEM interval represents
 *  its cadence. Kept separate from `lib/maintenanceServiceMapping.
 *  MAINTENANCE_TYPE_TO_SLUG` which resolves to booking-flow variants
 *  (`brake_system_inspection`, `battery_test`, etc.) — this map is
 *  for the interval-lookup on the tracker's signal-pill row. */
const ANCHOR_TYPE_TO_SLUG: Partial<Record<MaintenanceType, string>> = {
  oil: "oil_change",
  brakes: "brake_pad_replacement",
  tires: "tire_rotation",
  battery: "battery_replacement",
  inspection: "state_inspection",
};

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

interface DerivedSignals {
  signals: { time?: string; mileage?: string; interval?: string };
  triggeredBy: MaintenanceTriggerAxis;
}

function pickAnchorAxis(hasDate: boolean, hasMileage: boolean): MaintenanceTriggerAxis {
  if (hasDate && hasMileage) return "both";
  if (hasDate) return "time";
  if (hasMileage) return "mileage";
  return "none";
}

/** Derive signal-pill copy for an anchored record. Callers should
 *  skip invocation when the record is missing — the "none" result is
 *  reserved for records that exist but carry neither anchor. */
function deriveAnchoredSignals(
  record: MergeRecordLike,
  type: MaintenanceType,
  currentOdometer: number | null | undefined,
  oemIntervals: OemServiceIntervalsInput | undefined,
  now: number,
): DerivedSignals {
  const signals: DerivedSignals["signals"] = {};
  const hasDate = record.lastServiceDate != null;
  const hasMileage = record.lastServiceMileage != null;

  if (record.lastServiceDate != null) {
    const months = Math.max(0, Math.round((now - record.lastServiceDate) / MS_PER_MONTH));
    signals.time = `${months} mo since last service`;
  }
  if (record.lastServiceMileage != null && currentOdometer != null && currentOdometer > 0) {
    const miles = Math.max(0, currentOdometer - record.lastServiceMileage);
    signals.mileage = `${formatMileage(miles)} since last service`;
  }

  const slug = ANCHOR_TYPE_TO_SLUG[type];
  const interval = slug ? oemIntervals?.[slug] : undefined;
  if (interval) {
    const parts: string[] = [];
    if (interval.interval_months) parts.push(`${interval.interval_months} mo`);
    if (interval.interval_miles) parts.push(formatMileage(interval.interval_miles));
    if (parts.length > 0) signals.interval = parts.join(" / ");
  }

  return { signals, triggeredBy: pickAnchorAxis(hasDate, hasMileage) };
}

/** Non-mutating merge — attach signals to an anchored item without
 *  spreading the same three keys at every push site. */
function withSignals(item: MaintenanceItem, derived: DerivedSignals): MaintenanceItem {
  return { ...item, signals: derived.signals, triggeredBy: derived.triggeredBy };
}

/** Minimal record shape the merge reads — type (to match a user item), the
 *  confirmed-healthy timestamp (the 90-day on_time override), and the two
 *  service anchors that drive the signal pills. */
export interface MergeRecordLike {
  type: string;
  confirmedHealthyAt?: number;
  lastServiceDate?: number;
  lastServiceMileage?: number;
  /** Read only for the minor-item types below (Consolidated model). */
  customInputs?: Record<string, unknown> | null;
  /** Set by booking completion (bookings.ts markServiced) when a service —
   *  originally-booked or an added catalog service — closed this anchor. Drives
   *  the Cars-tab "Resolved by [shop] →" overlay; lastServiceShopName is
   *  resolved server-side in maintenance.getRecordsByVehicle. The overlay shows
   *  until resolutionAckedAt catches up to lastServiceDate (tapped once). */
  lastServiceBookingId?: string;
  resolutionAckedAt?: number;
  lastServiceShopName?: string | null;
}

/** Consolidated Upkeep scoring model: catalog-matched minor inspection
 *  fields that score automatically at the flat weight-10 "other" bucket
 *  when flagged yellow/red — never when green (green produces no entry at
 *  all, so a fully-green inspection doesn't dilute the weighted average).
 *  `maintenance_records.type` for these is prefixed "minor_" so they never
 *  collide with the real MaintenanceType rows, and so categoryWeightForItem
 *  (utils/healthScore.ts) can't accidentally match one to a real category.
 *  Written by convex/lib/inspectionHealth.ts's deriveCoreGrades via
 *  convex/maintenance.ts's mergeMechanicGradeIntoRecord. */
/**
 * The five minor eye-check items, each with the catalog service that FIXES it.
 *
 * The card is named for the inspection line a mechanic grades ("coolant
 * condition — how does the fluid look?"); the catalog sells the remedy
 * ("coolant flush"). Nothing connected the two, which caused both bugs here:
 *
 *  - Book Service fell through to matching the mechanic's free-text reason
 *    against service names. That worked for 2 of the 5 by luck and dropped
 *    the other 3 on an empty service picker.
 *  - When the same eye-check ALSO produced a job recommendation, the driver
 *    got two cards for one physical finding — "Coolant Flush · Suggested by
 *    James Bond" directly above "Coolant Condition · Flagged by Chelala".
 *
 * `remedySlug` is the taxonomy slug, which is the project's binding key for
 * services (REFERENCES.md decision log, v9). Names are display text and drift:
 * transmission_service reads "Transmission fluid change" in the taxonomy and
 * "Transmission Service" in the catalog, so matching on names would have
 * reproduced the same class of bug this replaces.
 */
/** maintenance_records.type for a driver's answer about a catalog service.
 *  Prefixed so it can never collide with the five core types or the minor_*
 *  eye-check rows, and so the answers are trivially greppable later. */
export function catalogRecordType(slug: string): string {
  return `catalog_${slug}`;
}

export const MINOR_ITEM_RECORD_TYPES: ReadonlyArray<{
  type: string;
  label: string;
  remedySlug: string;
}> = [
  { type: "minor_cool_condition", label: "Coolant Condition", remedySlug: "coolant_flush" },
  { type: "minor_trans", label: "Transmission Fluid", remedySlug: "transmission_service" },
  { type: "minor_ps", label: "Power Steering Fluid", remedySlug: "power_steering_flush" },
  { type: "minor_filter", label: "Air / Cabin Filter", remedySlug: "filter_replacement" },
  { type: "minor_bf_condition", label: "Brake Fluid Condition", remedySlug: "brake_fluid_flush" },
];

/** Build the extra weight-10 minor-item cards from raw records — one per
 *  flagged (yellow/red) catalog-matched minor field, none for green
 *  (absent) or unmatched (freeform, never written here at all) findings. */
function buildMinorItems(
  records: readonly MergeRecordLike[] | undefined,
  /** Remedy slugs already represented by a mechanic recommendation. A minor
   *  item whose fix is in here is suppressed: one physical finding, one card.
   *  Empty when the caller cannot resolve slugs (Oto's server-side merge),
   *  which degrades to today's behaviour rather than to a wrong answer. */
  coveredRemedySlugs: ReadonlySet<string>,
): MaintenanceItem[] {
  if (!records?.length) return [];
  const out: MaintenanceItem[] = [];
  for (const { type, label, remedySlug } of MINOR_ITEM_RECORD_TYPES) {
    const record = records.find((r) => r.type === type);
    const grade = record?.customInputs?.mechanicGrade as "g" | "y" | "r" | undefined;
    if (!grade || grade === "g") continue;
    // The recommendation card wins: it carries the mechanic's own framing, a
    // service id that books reliably, and the dismiss / follow-up lifecycle.
    // Scoring is unaffected — recs are excluded from Upkeep precisely because
    // the matching tile scores them (see isScorableMaintenanceItem), so the
    // finding still costs exactly what it did.
    if (coveredRemedySlugs.has(remedySlug)) continue;
    const reason = (record?.customInputs?.mechanicGradeReason as string | undefined)
      ?? `${label} flagged on eye-check`;
    const shopName = (record?.customInputs?.mechanicGradeSource as string | undefined) ?? null;
    const gradedAt = (record?.customInputs?.mechanicGradedAt as number | undefined) ?? null;
    out.push({
      id: `user-${type}`,
      serviceName: label,
      description: reason,
      detail: grade === "r" ? "Overdue" : "Needs attention",
      status: grade === "r" ? "overdue" : "needs_attention",
      // A minor item only exists because a mechanic graded it yellow or red,
      // so it always has a source worth showing.
      mechanicFlag: shopName || gradedAt ? { shopName, gradedAt } : undefined,
      // The fix, so Book Service lands on Choose Mechanic with the right
      // service attached instead of an empty picker.
      serviceSlug: remedySlug,
    });
  }
  return out;
}

/**
 * NOTE ON REQUIREDNESS — the four fields below are deliberately NOT optional.
 *
 * They used to be `?`, which meant a new signal could be wired into the Cars
 * ring and silently skipped by Oto's server-side merge: nothing failed to
 * compile, no test broke, and Oto quietly reported a narrower item set than the
 * Cars page. That is exactly how the catalog-coverage drift happened.
 *
 * Required (value may still be `undefined`) turns that into a compile error at
 * every call site, forcing an explicit "pass it, or explicitly opt out" per
 * caller. If you add a new merge input, add it here as REQUIRED too.
 */
export interface BuildMergedMaintenanceInput {
  /** Per-type items already computed from the user's maintenance_records
   *  (buildMaintenanceItems output). */
  userItems: Map<MaintenanceType, MaintenanceItem>;
  /** Raw records — only `type` + `confirmedHealthyAt` are read. */
  records: readonly MergeRecordLike[] | undefined;
  knownIssues?: string[];
  vehicleYear?: number;
  driverRecommendations?: readonly DriverRecommendationLike[];
  /** Id appended to the consolidated warning item so multiple vehicles produce
   *  distinct items. Pass the vehicle_owner id (or VIN). When undefined, the
   *  consolidated card is skipped (matches useMergedMaintenance's guard). */
  scopeId?: string;
  /** Injectable clock for the confirmed-healthy TTL; defaults to Date.now(). */
  now?: number;
  /** Current odometer in miles. Enables the anchored mileage signal pill and,
   *  together with `oemIntervals`, the from-odometer catalog coverage pass.
   *  Omit (as Oto's server-side score does) to keep the anchored-only merge. */
  currentOdometer: number | null | undefined;
  /** Slug-keyed OEM intervals from the v3 enrichment pipeline. Drives the
   *  interval signal pill and the catalog coverage pass (Behaviors #6/#7). */
  oemIntervals: OemServiceIntervalsInput | undefined;
  /** Resolve a catalog service id to its taxonomy slug. Supplied by the app
   *  (which has the services catalog in the booking store) and omitted by
   *  Oto's server-side merge. Used only to suppress a minor eye-check card
   *  when a recommendation already covers the same remedy — without it, both
   *  cards render, which is the pre-existing behaviour. */
  serviceSlugById: ((serviceId: string) => string | undefined) | undefined;
  /** Vehicle class + turbo/drivetrain, so the catalog pass can fall back to
   *  the class default table when enrichment has not produced an interval.
   *  Omit (as Oto's server-side merge does) to keep the enrichment-only set. */
  classCtx: IntervalClassContext | undefined;
}

/**
 * Build the full merged MaintenanceItem[] the Cars ring renders / scores from:
 * per-type items (record > warning-light fallback > young-battery inference >
 * optimistic default), then appended inspection + mechanic driver recs, the
 * paired-light overdue escalation, enrichment, and the consolidated
 * unpaired-light card.
 */
export function buildMergedMaintenanceItems(
  input: BuildMergedMaintenanceInput,
): MaintenanceItem[] {
  const { userItems, records, knownIssues, vehicleYear, driverRecommendations, scopeId } = input;
  const { serviceSlugById } = input;
  const { currentOdometer, oemIntervals, classCtx } = input;
  const now = input.now ?? Date.now();
  // With no record on file a time-based interval has been running since the
  // car was built, so its age is the anchor.
  const vehicleAgeMonths = ageMonths(vehicleYear ?? null, now);
  const result: MaintenanceItem[] = [];

  // Canonical dashboard lights present, folding both knownIssues shapes + the
  // symptom-code vocabulary so a light logged in ANY vocabulary escalates.
  const activeLights = canonicalWarningLights(knownIssues) as readonly string[];

  for (const type of ALL_MAINTENANCE_TYPES) {
    const userItem = userItems.get(type);

    // Recently confirmed-healthy → force on_time so a stale calculated status
    // doesn't override the user's direct input.
    const userRecord = records?.find((r) => r.type === type);
    const userConfirmedHealthy =
      userRecord?.confirmedHealthyAt &&
      now - userRecord.confirmedHealthyAt < 90 * 24 * 60 * 60 * 1000;

    if (userItem && userRecord) {
      const derived = deriveAnchoredSignals(
        userRecord,
        type,
        currentOdometer,
        oemIntervals,
        now,
      );
      const base: MaintenanceItem =
        userConfirmedHealthy && userItem.status !== "on_time"
          ? {
              ...userItem,
              status: "on_time",
              description: "Confirmed in good shape",
              detail: "On time",
            }
          : userItem;
      result.push(withSignals(base, derived));
      continue;
    }

    // Fallback: no record but the anchored slot expects an entry.
    if (userItem) {
      result.push(userItem);
      continue;
    }

    // No record — a paired warning light escalates the tile to the Now tier.
    const WARNING_LIGHT_FOR_TYPE: Partial<Record<MaintenanceType, { lightId: string; label: string }>> = {
      oil: { lightId: "oil_pressure", label: "Oil pressure warning light active — service urgently needed" },
      battery: { lightId: "battery_charging", label: "Battery/charging warning light active — have it tested soon" },
      brakes: { lightId: "abs", label: "ABS / brake warning light active — have brakes inspected soon" },
      tires: { lightId: "tpms", label: "Tire pressure (TPMS) warning light active — check tires soon" },
    };
    const lightInfo = WARNING_LIGHT_FOR_TYPE[type];
    if (lightInfo && activeLights.includes(lightInfo.lightId)) {
      result.push({
        id: `unknown-${type}`,
        serviceName: MAINTENANCE_LABELS[type] || type,
        description: lightInfo.label,
        detail: "Warning light",
        status: "overdue",
        percentUsed: 100,
      });
      continue;
    }

    // Battery: infer healthy for young vehicles.
    if (type === "battery") {
      const vehicleAge = vehicleYear ? new Date().getFullYear() - vehicleYear : 0;
      if (vehicleAge < 3) {
        result.push({
          id: `unknown-${type}`,
          serviceName: MAINTENANCE_LABELS[type] || type,
          description: `Battery is ~${vehicleAge || "<1"} year${vehicleAge !== 1 ? "s" : ""} old — healthy`,
          detail: "On time",
          status: "on_time",
        });
        continue;
      }
    }

    // Nothing on file for this type. That is the absence of a finding, not a
    // finding of "fine" — these previously claimed `on_time` with "No brake
    // concerns reported" (and oil `due_soon`) for a vehicle we hold no record
    // of at all, which meant a 300,000-mile car was told its brakes, tires and
    // battery were in good order. Those asserted statuses also scored: they
    // averaged to a fixed 93 for EVERY record-less vehicle, and §08 could not
    // exclude them because they never arrived as "unknown" in the first place.
    //
    // Reporting them honestly is also consistent with the rest of the model —
    // when a record EXISTS but carries no date, maintenanceStatus.ts already
    // returns "unknown" with this same "not on file" vocabulary. Having no
    // record at all should not read as better news than a blank one.
    const fallback: Record<string, { description: string }> = {
      oil:    { description: "No oil change history on file" },
      brakes: { description: "No brake service history on file" },
      tires:  { description: "No tire service history on file" },
      battery:{ description: "No battery service history on file" },
    };
    const fb = {
      status: "unknown" as const,
      description: fallback[type]?.description ?? "No service history on file",
      detail: "Not on file",
    };
    result.push({
      id: `unknown-${type}`,
      serviceName: MAINTENANCE_LABELS[type] || type,
      description: fb.description,
      detail: fb.detail,
      status: fb.status,
    });
  }

  // Inspection record (excluded from the default loop).
  const inspectionItem = userItems.get("inspection");
  if (inspectionItem) result.push(inspectionItem);

  // Consolidated Upkeep scoring model — catalog-matched minor fields
  // flagged yellow/red (see buildMinorItems above).
  // Remedies a mechanic has already recommended — those recommendations own
  // the card, so the matching eye-check tile stays silent.
  const coveredRemedySlugs = new Set<string>();
  if (serviceSlugById && driverRecommendations) {
    for (const rec of driverRecommendations) {
      if (!rec.service_id) continue;
      const slug = serviceSlugById(rec.service_id);
      if (slug) coveredRemedySlugs.add(slug);
    }
  }
  result.push(...buildMinorItems(records, coveredRemedySlugs));

  // ── Catalog coverage via from-odometer inference (Behavior #7) ──
  // Only runs for callers that supply both an odometer and OEM intervals;
  // Oto's server-side score passes neither and keeps the anchored-only set.
  if ((oemIntervals || classCtx) && currentOdometer != null && currentOdometer > 0) {
    // The union, not just enrichment. This pass used to iterate `oemIntervals`
    // alone, so a car whose enrichment had not finished showed NO bigger
    // services at all — no air/cabin filter, no brake fluid flush — even
    // though the class default table has both. That undercut the whole reason
    // the class table is the default rather than a fallback: a car is supposed
    // to get its intervals at add-car time with zero enrichment.
    const slugs = new Set<string>(Object.keys(oemIntervals ?? {}));
    if (classCtx?.vehicleClass) for (const slug of CLASS_INTERVAL_SLUGS) slugs.add(slug);

    for (const slug of slugs) {
      const interval = oemIntervals?.[slug];
      if (CATALOG_SLUGS_TO_SKIP.has(slug)) continue;
      const entry = TAXONOMY[slug];
      if (!entry) continue;

      // Runtime data from `useOemServiceIntervals` carries the guardrail
      // fields (`confidence`, `mechanic_verified`) beyond what the narrow
      // `OemServiceIntervalsInput` type surfaces; cast for the guardrail
      // call rather than leaking those fields into the general type.
      const enrichedInterval = interval as (OemServiceIntervalsInput[string] & {
        confidence?: number | null;
        mechanic_verified?: boolean;
      }) | undefined;

      // OEM first, class default second — the same two tiers `getInterval` and
      // the Bigger Services tile use, so all three agree about one service on
      // one car.
      //
      // The class value does NOT go through `safeInterval`. That helper treats
      // a value carrying no confidence score as untrusted and snaps it to the
      // bounds FLOOR, which would turn Class A spark plugs from 90,000 miles
      // into 20,000. The confidence machinery defends against bad scraped
      // data, not against our own engineering constants; the bounds still
      // apply, the trust gate does not.
      // ...and only when it is trustworthy. The pipeline writes
      // `default_fallback` rows at confidence 0.5; `safeInterval` snaps those
      // to the bounds floor, and a floored guess is worse information than the
      // class table. Same rule as the Bigger Services tile so the two agree.
      const classIv = classCtx?.vehicleClass
        ? classInterval(slug, classCtx.vehicleClass, classCtx)
        : null;
      const classMiles = classIv?.miles ?? null;
      // The time side of the class interval. Enrichment only ever supplies a
      // mileage number, so unlike `classMiles` this has no OEM tier above it.
      const classMonths = classIv?.months ?? null;
      // Prefer the class table over an UNTRUSTED enrichment value — but only
      // when there is a class value to prefer. With nothing to fall back to,
      // a floored guess still beats no row at all: the point of the gate is
      // to rank two numbers, not to discard the only one we have.
      const useOem =
        !!enrichedInterval?.interval_miles &&
        (isTrustedInterval(enrichedInterval) || classMiles == null);
      const bounded = useOem
        ? safeInterval({
            slug,
            interval_miles: enrichedInterval!.interval_miles,
            confidence: enrichedInterval!.confidence,
            mechanic_verified: enrichedInterval!.mechanic_verified,
          })
        : clampClassIntervalToBounds(slug, classMiles);

      // Anchorless — no stored interval AND no conservative default, on
      // EITHER axis. The months check matters: Class B and C brake fluid is
      // `{miles: null, months: 24}`, so a mileage-only test sent brake fluid
      // down this path on every Euro car in the app and left it stuck on
      // "not enough info to say" forever.
      // Row surfaces soft with the diagnostic-scan CTA (Behavior #6).
      if (bounded == null && classMonths == null) {
        result.push({
          id: `catalog-${slug}`,
          serviceName: entry.label,
          description:
            "Not enough info to say — book a diagnostic scan to firm this up.",
          detail: "No data",
          // UNKNOWN, not HEALTHY. The row's own copy admits we cannot say, and
          // filing that under "healthy" told the driver the opposite of what
          // it said. `unknown` is the tier for everything we have no answer
          // to, whoever left it unanswered.
          status: "unknown",
          triggeredBy: "none",
          // Informational only — see MaintenanceItem.excludeFromScore.
          excludeFromScore: true,
          // Carries the slug so the row gets an "Add info" control like every
          // other unknown: the driver may simply know the answer.
          serviceSlug: slug,
        });
        continue;
      }

      // Two ways a catalog row can pick up a real anchor, and both count.
      //
      //   - the driver answered "when was this last done?" on the card
      //     (`catalog_<slug>`), which is a fact they gave us; and
      //   - a booking completion stamped the slug-specific `minor_<slug>` row,
      //     which is a shop actually doing the work.
      //
      // Temur added the second; the first came from Quick Check v2. Without
      // either, the row measures from new — an assumption, which is why it
      // scores nothing. Only the slug-specific minor anchor is safe: the
      // shared aggregates ("fluids" / "engine_parts") would falsely retire
      // every sibling service.
      const answered = records?.find((r) => r.type === catalogRecordType(slug));
      const minorType = minorRecordTypeForServiceSlug(slug);
      const minorAnchor = minorType
        ? records?.find((r) => r.type === minorType)
        : undefined;

      const answeredMileage =
        typeof answered?.lastServiceMileage === "number"
          ? answered.lastServiceMileage
          : undefined;
      const minorMileage =
        typeof minorAnchor?.lastServiceMileage === "number"
          ? minorAnchor.lastServiceMileage
          : undefined;

      // The LATER of the two wins rather than one source outranking the other.
      // A shop record is better evidence than a recollection, but a driver
      // answering after that visit is newer information — and "most recent
      // service" is the question the interval is actually asking.
      const anchorLastServiceMileage =
        answeredMileage != null && minorMileage != null
          ? Math.max(answeredMileage, minorMileage)
          : answeredMileage ?? minorMileage;

      // Same rule on the time axis. Both writers stamp a date beside the
      // mileage — `quickCheckAnchor` for a driver answer, booking close-out
      // for a shop visit — so the two anchors move together.
      const answeredDate =
        typeof answered?.lastServiceDate === "number" ? answered.lastServiceDate : undefined;
      const minorDate =
        typeof minorAnchor?.lastServiceDate === "number" ? minorAnchor.lastServiceDate : undefined;
      const anchorLastServiceDate =
        answeredDate != null && minorDate != null
          ? Math.max(answeredDate, minorDate)
          : answeredDate ?? minorDate;

      // A definite answer, not merely a record. "Not sure" writes a row so we
      // stop asking as insistently; it is still an absence of information and
      // must not score.
      const answeredType = (answered?.customInputs as { answerType?: string } | undefined)?.answerType;
      const driverAnswered = answeredType === "when" || answeredType === "never";

      const status = computeFromOdometerStatus({
        interval_miles: bounded,
        currentOdometer,
        lastServiceMileage: anchorLastServiceMileage,
        // The time side. Without it a service whose interval is mostly about
        // age — coolant, brake fluid — reads healthy on a low-mileage car that
        // the Bigger Services tile has already flagged.
        interval_months: classMonths,
        lastServiceDate: anchorLastServiceDate,
        ageMonths: vehicleAgeMonths,
        now,
        serviceName: entry.label,
        intervalSource: useOem ? "oem" : "class_default",
        // A driver answer releases the confidence hold, the same way a
        // mechanic's grade does. Yassin asked for this on 2026-09-02 after a
        // car sat at 99 with five services the driver had said were never
        // done; Ahmad confirmed it on 2026-09-04.
        confirmed: driverAnswered,
      });

      result.push({
        id: `catalog-${slug}`,
        serviceName: entry.label,
        description: status.description,
        detail: status.detail,
        status: status.status,
        percentUsed: status.percentUsed,
        // Either anchor makes this a real measurement rather than an
        // inference from new.
        triggeredBy: anchorLastServiceMileage != null ? "mileage" : "inference",
        // Scores ONLY once the driver has actually answered — Yassin,
        // 2026-09-02: a driver's answer on a bigger service should move the
        // number the way a mechanic's grade does.
        //
        // This reverses an earlier blanket exclusion, and the distinction
        // matters: that gate went in because these rows were costing people
        // points for the PASSAGE OF TIME, on a car nobody had said anything
        // about. An answer is not the passage of time. Unanswered and "not
        // sure" rows still leave the weighted average entirely, so the old
        // failure cannot come back — and a driver who says nothing is never
        // penalised for saying nothing.
        excludeFromScore: !driverAnswered,
        // Lets the row's "when was this done?" button write back to the right
        // record, and lets Book Service resolve the service.
        serviceSlug: slug,
        // The spec's four-way band and the factor the score should use. These
        // were being computed and then dropped, so every catalog row scored
        // off `STATUS_SCORE[status]` — which meant no confidence hold at all,
        // and an overdue row scored at the severely-overdue 0.10.
        bandStatus: status.bandStatus,
        factorApplied: status.factorApplied,
        rawScore: status.rawScore,
        signals: {
          mileage: `${formatMileage(currentOdometer)} (current)`,
          // Says which tier the number came from. "Typical" rather than "OEM"
          // when it is our class default, because claiming a manufacturer
          // schedule we do not have is the kind of false precision the
          // confidence hold exists to avoid.
          interval: `${formatMileage(bounded)} (${useOem ? "OEM" : "typical"})`,
        },
      });
    }
  }

  // ── One physical finding, one card ────────────────────────────────────────
  //
  // Ahmad, 2026-09-04: a coolant flush showed twice — once as the interval row
  // ("50,001 mi past interval") and once as the mechanic's eye-check
  // recommendation ("flagged on eye-check (monitor)"). Both are true; two
  // cards for one job is not.
  //
  // The INTERVAL ROW WINS here, which is the opposite of how the same
  // collision is resolved for minor eye-check items above — and the asymmetry
  // is the point. A minor item is a bare grade with no interval behind it, so
  // the recommendation is strictly richer and takes the card. An interval row
  // carries the mileage maths AND the driver's own answer, and unlike a
  // recommendation it SCORES: dropping it in favour of the rec would silently
  // raise the health score the moment a mechanic mentioned the service.
  //
  // So the row stays and absorbs the mechanic's attribution — the "Suggested
  // by …" line renders off `mechanicProvenance` alone, independent of the
  // recommendation lifecycle, so nothing else has to come with it.
  const intervalItemBySlug = new Map<string, MaintenanceItem>();
  for (const item of result) {
    const slug =
      item.serviceSlug ??
      ANCHOR_TYPE_TO_SLUG[item.id.replace(/^(unknown-|user-|smartcar-)/, "") as MaintenanceType];
    // First writer wins: a catalog row and a core tile never share a slug, but
    // if they ever did the core tile is the one the driver was asked about.
    if (slug && !intervalItemBySlug.has(slug)) intervalItemBySlug.set(slug, item);
  }

  // Mechanic-submitted job recommendations as urgent cards.
  if (driverRecommendations && driverRecommendations.length > 0) {
    for (const rec of driverRecommendations) {
      const recSlug = rec.service_id ? serviceSlugById?.(rec.service_id) : undefined;
      const covered = recSlug ? intervalItemBySlug.get(recSlug) : undefined;
      if (covered) {
        covered.mechanicProvenance = {
          shopName: rec.shop_name,
          mechanicName: rec.mechanic_name,
        };
        // A mechanic's finding may make the card louder, never quieter — the
        // same one-way rule `applyMechanicGrade` uses. Without this, a
        // mechanic flagging something the interval calls healthy would be
        // folded into a HEALTHY row and effectively buried.
        const recStatus = recUrgencyToStatus(rec.urgency);
        if (
          STATUS_SEVERITY_ORDER.indexOf(recStatus) >
          STATUS_SEVERITY_ORDER.indexOf(covered.status)
        ) {
          // Display only. `rawScore` is pinned to whatever the INTERVAL said,
          // so the merge cannot start deducting for a recommendation —
          // recommendations are excluded from Upkeep today
          // (`isScorableMaintenanceItem`) and this is not the change that
          // reverses that.
          covered.rawScore = covered.rawScore ?? INTERVAL_SCORE_EQUIVALENT[covered.status];
          covered.status = recStatus;
        }
        continue;
      }
      result.push({
        id: `rec-${rec._id}`,
        serviceName: rec.service_name,
        description: rec.reason ?? "Recommended by your mechanic",
        detail: recUrgencyDetail(rec.urgency),
        status: recUrgencyToStatus(rec.urgency),
        sourceRecommendationId: rec._id,
        mechanicProvenance: {
          shopName: rec.shop_name,
          mechanicName: rec.mechanic_name,
        },
        recUrgency: rec.urgency,
        scheduledAt: rec.scheduled_at ?? null,
        scheduledMechanicName: rec.scheduled_mechanic_name ?? null,
        serviceId: rec.service_id ?? null,
        // Fall back to the structural test rather than trusting `kind` alone,
        // so a row from an older client that predates the field still renders
        // correctly: no service id means nothing to book, full stop.
        advisory: rec.kind === "advisory" || !rec.service_id,
        advisoryDisclaimer: rec.disclaimer ?? null,
        authorLabel: rec.author_label ?? null,
        advisoryAged: rec.aged === true,
      });
    }
  }

  // Force any paired item up to overdue when its light is on (record-based or not).
  const escalated = result.map((item) => {
    const itemType = item.id.replace(/^(unknown-|user-|smartcar-)/, "");
    const lightId = PAIRED_LIGHT_BY_TYPE[itemType as MaintenanceType];
    if (!lightId || !activeLights.includes(lightId)) return item;
    if (item.status === "overdue") return item;
    return { ...item, status: "overdue" as const, percentUsed: 100 };
  });

  const enriched = escalated.map(enrichUrgentItem).map((item) => {
    // "Resolved by this booking" overlay — booking completion stamped this
    // anchor's record with the booking that closed it (an originally-booked OR
    // an added catalog service). Surface the resolved card until the driver taps
    // it once (resolutionAckedAt catches up to lastServiceDate), then it folds
    // back into Healthy. `resolvedRecordType` is the row the ack must patch:
    // anchored/minor items embed it in the id, but a `catalog-<slug>` inference
    // item resolves via its slug-specific minor anchor instead.
    const recordType = item.id.startsWith("catalog-")
      ? minorRecordTypeForServiceSlug(item.id.slice("catalog-".length))
      : item.id.replace(/^(unknown-|user-|smartcar-)/, "");
    if (!recordType) return item;
    const rec = records?.find((r) => r.type === recordType);
    if (!rec?.lastServiceBookingId) return item;
    const serviced =
      typeof rec.lastServiceDate === "number" ? rec.lastServiceDate : 0;
    if (!serviced || (rec.resolutionAckedAt ?? 0) >= serviced) return item;
    return {
      ...item,
      resolvedByBookingId: String(rec.lastServiceBookingId),
      resolvedShopName: rec.lastServiceShopName ?? null,
      resolvedAt: serviced,
      resolvedRecordType: recordType,
    };
  });

  // Consolidated unpaired-light item — appended AFTER enrichment so its
  // hand-tuned copy isn't clobbered by the generic URGENT_DETAILS fallback.
  if (scopeId) {
    const warningItem = buildWarningLightItem({ knownIssues, scopeId });
    if (warningItem) enriched.push(warningItem);
  }

  return enriched;
}
