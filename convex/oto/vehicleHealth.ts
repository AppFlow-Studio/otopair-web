// =============================================================================
// Oto AI — Vehicle Health queries
// =============================================================================
//
// Backs the get_vehicle_health and get_projected_health_score AI tools.
// Reads user-records-only data (Smartcar is deprecated and intentionally not
// considered in this server-side path). Reuses the same pure helpers the
// mobile My Cars page uses so AI answers stay in lockstep with the UI.
//
// The mobile UI continues to consume the camelCase MaintenanceItem shape via
// useMaintenanceData; this file emits the snake_case AI-tool shape locked in
// the Implementation Directive. They are separate consumers — never mix.
//
// Companions:
//   • utils/maintenanceEnrichment.ts — URGENT_DETAILS + buildMaintenanceItems
//   • utils/maintenanceStatus.ts     — computeMaintenanceStatus + per-type config
//   • utils/healthScore.ts           — computeVehicleHealthScore + projected variant
// =============================================================================

import { query, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { isEvalTestMake } from "./evalTestFilter";
import { resolveVehicleByIdOrVin } from "./resolveVehicle";
import {
  ALL_MAINTENANCE_TYPES,
  MAINTENANCE_LABELS,
  type MaintenanceType,
} from "../../utils/maintenanceStatus";
import {
  buildMaintenanceItems,
  enrichUrgentItem,
  type MaintenanceRecordInput,
} from "../../utils/maintenanceEnrichment";
import {
  computeVehicleHealthScore,
  computeProjectedHealthScore,
} from "../../utils/healthScore";
import { canonicalWarningLights } from "../../lib/warningLightVocab";
import {
  buildMergedMaintenanceItems,
  type DriverRecommendationLike,
} from "../../utils/mergedMaintenance";
import { resolveSlugMap } from "../service_intervals_queries";
import { loadHealthScoreWeights } from "../healthScoreWeights";
import { resolveMileageForOwner } from "../lib/mileage";
import type { MaintenanceItem, MaintenanceStatus } from "../../components/cars/MaintenanceTracker";

// -----------------------------------------------------------------------------
// Warning-light identifier → human label.
// Mirrors WARNING_LIGHT_TYPE_OPTIONS in app/quarterly-checkin.tsx (UI
// source-of-truth). The check-in flow writes `vehicle_owners.knownIssues` as
// a sentinel-prefixed array: ["no_all_clear"] | ["not_sure"] |
// ["check_engine"] | ["other", ...lights] | ["different_light", ...lights].
// Without translation, Haiku reads raw identifiers and parrots them — e.g.
// "temperature and something else under 'other'" (real iter trace, 2026-05-14).
// -----------------------------------------------------------------------------

const WARNING_LIGHT_LABELS: Record<string, string> = {
  tpms: "Tire pressure (TPMS) warning light",
  battery_charging: "Battery / charging warning light",
  temperature: "Temperature / overheating warning light",
  oil_pressure: "Oil pressure warning light",
  abs: "ABS / brake warning light",
  airbag_srs: "Airbag / SRS warning light",
  transmission: "Transmission warning light",
  check_engine: "Check engine light",
  not_sure_which: "Unspecified warning light (driver wasn't sure which)",
};

function describeKnownIssues(knownIssues?: string[]): string[] | undefined {
  // Format- and vocabulary-agnostic: canonicalWarningLights scans the whole
  // array (so the flat Oto/check-in shape works, not just the sentinel-prefixed
  // onboarding shape) and folds symptom aliases (brake_warning → abs) onto their
  // canonical light. Previously keyed off knownIssues[0], so a light Oto itself
  // logged in the flat shape was described as "didn't specify which" or dropped.
  const lights = canonicalWarningLights(knownIssues);
  if (lights.length === 0) return undefined;
  return lights.map((id) => WARNING_LIGHT_LABELS[id] ?? `Unrecognized warning light: ${id}`);
}

// -----------------------------------------------------------------------------
// AI-tool response shape (snake_case, locked by Implementation Directive 1)
// -----------------------------------------------------------------------------

/**
 * Trust signal for a maintenance item. Tells Oto how much to weight the
 * record's stated status against contradicting symptoms reported by the user.
 *
 * - "verified"      → backed by third-party evidence the service actually
 *                     happened. Sources include: a completed booking through
 *                     OtoPair, a user-uploaded service record (receipt /
 *                     work order from an outside shop), or mechanic-onboarded
 *                     vehicle data. Treat status as truth.
 * - "self_reported" → user provided via onboarding or quarterly check-in
 *                     without a backing document or booking. Soft data —
 *                     may be stale or inaccurate ("data form
 *                     hallucination"). If symptoms contradict, surface the
 *                     record to the user before acting on its status.
 * - "inferred"      → no maintenance_record exists for this type. Status
 *                     was derived from a fallback path (warning-light
 *                     mapping, vehicle-age heuristic, per-type default).
 *
 * Mapping from the underlying schema fields:
 *   maintenance_records.confidence === "verified"  → "verified"
 *     (set by the booking-completion path, the service-record-upload path,
 *      and any other writer that has third-party evidence)
 *   maintenance_records.confidence is anything else (incl. "self_reported",
 *     "unverified", undefined) AND a record exists                → "self_reported"
 *   no maintenance_record for this type (item.id starts with "unknown-") → "inferred"
 *
 * NOTE: confirmedHealthyAt does NOT promote an item to "verified" — that's
 * still the user attesting via the check-in, which is exactly the
 * data-form-hallucination-prone path we're guarding against.
 */
export type RecordProvenance = "verified" | "self_reported" | "inferred";

export interface VehicleHealthItem {
  id: string;
  type: MaintenanceType;
  label: string;
  status: MaintenanceStatus;
  description: string;
  detail: string;
  last_service?: string;
  urgency_label?: string;
  recommendation?: string;
  /**
   * Trust signal — see RecordProvenance docstring above. Always present.
   * Use this to gate the symptom-vs-record protocol: when a user-described
   * symptom contradicts an item with provenance "self_reported", the record
   * itself is suspect; when it contradicts a "verified" item, the symptom
   * is the surprise and warrants narrowing questions.
   */
  record_provenance: RecordProvenance;
}

// -----------------------------------------------------------------------------
// K5 fix (2026-08-12) — coverage scope declaration.
//
// The QA report's most consequential fabrication: a user asked about the
// hybrid traction battery, get_vehicle_health came back with no problems on
// the list, and Oto answered "the hybrid battery is in good shape — the system
// has that covered" about a $4,000+ component we have never measured.
//
// Root cause is structural, not a prompt slip. MaintenanceType is a CLOSED
// FIVE-VALUE SET (oil | brakes | tires | battery | inspection — see
// utils/maintenanceStatus.ts and the mirror in convex/vehicleDocuments.ts).
// This query returns those five and nothing else, and the payload never said
// that five was the whole universe. So "absent because we have never looked"
// and "absent because there is nothing wrong" serialized to the SAME JSON.
// The response literally could not express the difference, and Haiku resolved
// the ambiguity the flattering way.
//
// Note the second trap folded into the same defect: `battery` here is the
// ordinary 12V starter battery. It is NOT a hybrid/EV high-voltage traction
// pack. A model scanning for "battery: on_time" finds a match and answers the
// wrong question. MONITORED_SYSTEM_SCOPE says so in the payload itself.
//
// Same philosophy as the F1 strip pass in toAiShape below: don't rely on the
// prompt to stop a misread — make the misread unavailable in the data. The
// two fields are emitted FIRST in the response object so the boundary is read
// before the item list, not after.
// -----------------------------------------------------------------------------

/** One entry in the monitored set — what this type does and does NOT cover. */
export interface MonitoredSystem {
  type: MaintenanceType;
  label: string;
  /** Plain-language boundary of this type. Deliberately names the exclusions. */
  covers: string;
}

const MONITORED_SYSTEM_SCOPE: Record<MaintenanceType, string> = {
  oil: "Engine oil and filter change interval only. Says nothing about oil leaks, oil pressure, or internal engine condition.",
  brakes:
    "Brake pad / rotor service history and wear interval only. Says nothing about brake lines, master cylinder, or the ABS module.",
  tires:
    "Tire tread, tire age, and rotation/replacement history only. Says nothing about wheel alignment, TPMS sensors, or wheel condition.",
  battery:
    "The ordinary 12V starter battery ONLY. This is NOT a hybrid or electric-vehicle high-voltage traction battery — traction packs are never tracked by OtoPair and never appear in this response.",
  inspection:
    "State safety / emissions inspection due date only. Present in `items` only when the user has an inspection record on file.",
};

/**
 * The complete monitored set. Built from ALL_MAINTENANCE_TYPES plus
 * "inspection" (which ALL_MAINTENANCE_TYPES omits because it's record-gated
 * for display — but it IS a monitored type, so it belongs in the declaration
 * whether or not an item for it shows up in `items` this call).
 */
const MONITORED_SYSTEMS: MonitoredSystem[] = [...ALL_MAINTENANCE_TYPES, "inspection" as const].map(
  (type) => ({
    type,
    label: MAINTENANCE_LABELS[type] ?? type,
    covers: MONITORED_SYSTEM_SCOPE[type],
  }),
);

/**
 * The boundary statement. Deliberately NOT an exhaustive list of untracked car
 * parts — that would be unmaintainable and would still read as a checklist.
 * It states the rule (only the five above exist here) and names the handful of
 * systems users actually ask Oto about, hybrid/EV traction battery first.
 */
const NOT_MONITORED_STATEMENT =
  "OtoPair tracks ONLY the systems listed in `monitored_systems`. This response carries no data whatsoever — not good, not bad — about anything else. That includes, among many others, the hybrid/EV high-voltage traction battery, the transmission, the suspension, and the air conditioning. If a system is not in `monitored_systems`, it is absent because it has never been measured, NOT because it was checked and found healthy. Never infer that an unlisted system is fine, healthy, or 'covered' from this payload, from an absence of problems in `items`, or from the health score — the score is computed from the monitored set alone. For anything unlisted, say plainly that you have no data on it and offer an inspection.";

export interface VehicleHealthResponse {
  /**
   * K5 — what IS tracked. Emitted before `items` so the scope is read first.
   */
  monitored_systems: MonitoredSystem[];
  /** K5 — the boundary. See NOT_MONITORED_STATEMENT above. */
  not_monitored: string;
  score: number;
  score_is_estimated: boolean;
  items: VehicleHealthItem[];
  known_issues?: string[];
}

export interface ProjectedHealthResponse {
  current_score: number;
  projected_score: number;
  lift: number;
}

// -----------------------------------------------------------------------------
// Shared loader — resolves auth + vehicle + records + merged maintenance items.
// Both queries hit this; the only divergence is what they do with the items.
// -----------------------------------------------------------------------------

interface LoadedContext {
  owner: Doc<"vehicle_owners">;
  records: Doc<"maintenance_records">[];
  /** Conservative, F1-anti-fabrication items Oto REPORTS to the user (unknown
   *  fallback for services with no record). Unchanged from before. */
  enrichedItems: MaintenanceItem[];
  /** Ring-equivalent items used ONLY to compute the score Oto quotes, so it
   *  matches the Cars page (optimistic fallback + driver recs + warning item +
   *  OEM cadences). See utils/mergedMaintenance.ts. */
  scoringItems: MaintenanceItem[];
  odometerMiles: number;
  knownIssues: string[] | undefined;
  /** Open-mechanic-rec penalty (0–15) the ring subtracts — vehicle_owners.health_score_rec_penalty. */
  recPenalty: number | undefined;
  /**
   * Provenance keyed by MaintenanceType for items that DO have a record.
   * Items without a record (unknown-* fallbacks) get "inferred" downstream
   * in toAiShape based on the id prefix — they're not in this map.
   */
  provenanceByType: Map<MaintenanceType, RecordProvenance>;
}

// Auth resolver — the PUBLIC read path's identity step, factored out so the
// internal *ForUser variants can bypass it and pass a users._id directly
// (director simulation: the fabricated identity never reaches these queries).
// Behavior is byte-for-byte what the public queries did inline before: same
// null-handling, same error strings.
async function resolveActingUserId(ctx: any): Promise<Id<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");

  const user: Doc<"users"> | null = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("user not found in Convex");
  return user._id;
}

// User-scoped core loader — identical logic to the old loadVehicleContext from
// the user-resolution point onward, but takes `userId` explicitly instead of
// deriving it from auth. The public read path resolves the user via
// resolveActingUserId() then calls this; the internal *ForUser variants pass
// actingUserId straight through.
async function loadVehicleContextForUser(
  ctx: any,
  userId: Id<"users">,
  vehicleId: string,
): Promise<LoadedContext> {
  // The chat envelope's <vehicle> id field is a Convex `vehicles._id` (see
  // chat.ts buildEnvelope), but B-P3: accept VIN-or-id since the tool
  // descriptions disagree and Haiku passes either. Then look up the per-user
  // owner row via the (vin, user_id) index. resolveVehicleByIdOrVin never
  // throws on a bad id.
  const vehicle = await resolveVehicleByIdOrVin(ctx, vehicleId);
  if (!vehicle) throw new Error(`vehicle not found: ${vehicleId}`);

  const owner: Doc<"vehicle_owners"> | null = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) =>
      q.eq("vin", vehicle.vin).eq("user_id", userId),
    )
    .unique();
  if (!owner) throw new Error(`vehicle_owner not found for vehicle ${vehicleId}`);

  const records: Doc<"maintenance_records">[] = await ctx.db
    .query("maintenance_records")
    .withIndex("by_vehicle_owner", (q: any) => q.eq("vehicleOwnerId", owner._id))
    .collect();

  // Make + year for per-make intervals. We already have the vehicle from the
  // db.get above — no second `vehicles.by_vin` query needed.

  let make: string | undefined;
  let vehicleYear: number | undefined;
  if (vehicle) {
    if (vehicle.year != null) vehicleYear = vehicle.year;
    if (vehicle.vehicle_config_id) {
      const config = await ctx.db.get(vehicle.vehicle_config_id);
      if (config?.make_id) {
        const makeRow = await ctx.db.get(config.make_id);
        if (isEvalTestMake(makeRow)) {
          throw new Error("vehicle not found");
        }
        if (makeRow?.name) make = makeRow.name;
      }
    }
    if (!make || !vehicleYear) {
      const meta = (vehicle.metadata ?? {}) as { make?: string; year?: number | string };
      if (!make && meta.make) make = String(meta.make);
      if (!vehicleYear && meta.year != null) {
        const y = typeof meta.year === "number" ? meta.year : Number.parseInt(meta.year, 10);
        if (Number.isFinite(y)) vehicleYear = y;
      }
    }
  }

  // Resolve across the two stores (shop passport vs this owner row) by recency —
  // the app card, maintenance tracker and VHS must show the same odometer the
  // shop does, not just whatever the owner row last held.
  const odometerMiles = (await resolveMileageForOwner(ctx, owner)).mileage ?? 0;
  const knownIssues = Array.isArray(owner.knownIssues) ? (owner.knownIssues as string[]) : undefined;
  const drivingConditions = owner.drivingConditions ?? undefined;
  const avgMonthlyDriving = owner.avgMonthlyDriving ?? undefined;

  // ── Convergence loads ──────────────────────────────────────────────────────
  // The SAME signals the Cars-page health ring folds into computeVehicleHealthScore,
  // so the score Oto quotes matches the ring the user sees (utils/mergedMaintenance.ts).
  //
  // Mechanic (driver) recommendations — filter mirrors
  // jobRecommendations.getDriverVisibleRecsForVehicle. Only the score-relevant
  // field (urgency → item status) is needed; display-only shop/mechanic names are
  // left null to avoid extra reads.
  const recRows = await ctx.db
    .query("job_recommendations")
    .withIndex("by_vehicle_vin", (q: any) => q.eq("vehicle_vin", vehicle.vin))
    .collect();
  const driverRecommendations: DriverRecommendationLike[] = recRows
    .filter(
      (r: any) =>
        (r.status === "open" || r.status === "acknowledged") &&
        r.visible_to_driver &&
        r.recommended_service_id,
    )
    .map((r: any) => ({
      _id: String(r._id),
      service_id: (r.recommended_service_id ?? null) as string | null,
      service_name: "",
      urgency: r.urgency,
      reason: r.reason ?? null,
      shop_name: null,
      mechanic_name: null,
      target_mileage: r.target_mileage ?? null,
      scheduled_at: r.scheduled_at ?? null,
      scheduled_mechanic_name: null,
    }));

  // OEM service intervals for the vehicle's config (same read as the ring's
  // useOemServiceIntervals) so record-based statuses use identical cadences.
  const oemIntervals = vehicle.vehicle_config_id
    ? await resolveSlugMap(
        ctx,
        await ctx.db
          .query("service_intervals")
          .withIndex("by_vehicle_config", (q: any) =>
            q.eq("vehicle_config_id", vehicle.vehicle_config_id),
          )
          .collect(),
      )
    : {};

  // Open-mechanic-rec penalty (−0–15) feeds the ring's score. Rewards (the
  // Health-Points buffer) are paused for now — see Rewards removal — so Oto
  // no longer reads vehicle_health_points here, keeping it in lockstep with
  // the ring not applying the buffer either.
  const recPenalty = (owner as any).health_score_rec_penalty as number | undefined;

  // Normalize raw records into the builder's input shape. lastServiceDate is
  // stored as union(string|number); we only feed numeric values forward.
  const recordInputs: MaintenanceRecordInput[] = records.map((rec) => ({
    type: rec.type,
    lastServiceDate:
      typeof rec.lastServiceDate === "number" ? rec.lastServiceDate : undefined,
    lastServiceMileage: rec.lastServiceMileage ?? undefined,
    customInputs: (rec.customInputs ?? undefined) as Record<string, unknown> | undefined,
    confirmedHealthyAt: rec.confirmedHealthyAt ?? undefined,
  }));

  // Provenance map — built from the SAME records, in parallel to recordInputs,
  // so we don't perturb the existing pure builder. Per the schema comment on
  // maintenance_records.confidence the canonical labels are
  // "verified" | "unverified" | "self_reported" (with undefined treated as
  // self_reported). Only "verified" promotes to verified provenance — anything
  // else is treated as soft data the user may need to confirm.
  //
  // Future enhancement: also check vehicle_service_states.last_service_booking_id
  // for an extra verified signal (booking-backed even if confidence label is
  // missing). Skipped for v1 — keeps this query pure-additive on the read path
  // without an extra DB join.
  const provenanceByType = new Map<MaintenanceType, RecordProvenance>();
  for (const rec of records) {
    const conf = rec.confidence;
    const provenance: RecordProvenance =
      conf === "verified" ? "verified" : "self_reported";
    provenanceByType.set(rec.type as MaintenanceType, provenance);
  }

  const userItems = buildMaintenanceItems(
    recordInputs,
    odometerMiles > 0 ? odometerMiles : null,
    make,
    drivingConditions,
    avgMonthlyDriving,
    knownIssues,
  );

  // Server-side merge: user record > warning-light fallback > young-battery
  // inference > per-type default. Smartcar branches from useMergedMaintenance
  // are intentionally omitted (deprecated per Implementation Directive 1).
  // Canonical lights folded once (both shapes + symptom vocab) so the paired
  // fallback below fires for a light logged via Oto in ANY vocabulary.
  const activeLights = canonicalWarningLights(knownIssues);
  const merged: MaintenanceItem[] = [];
  for (const type of ALL_MAINTENANCE_TYPES) {
    const userItem = userItems.get(type);
    const userRecord = recordInputs.find((r) => r.type === type);
    const userConfirmedHealthy =
      userRecord?.confirmedHealthyAt != null &&
      Date.now() - userRecord.confirmedHealthyAt < 90 * 24 * 60 * 60 * 1000;

    if (userItem) {
      if (userConfirmedHealthy && userItem.status !== "on_time") {
        merged.push({
          ...userItem,
          status: "on_time",
          description: "Confirmed in good shape",
          detail: "On time",
        });
      } else {
        merged.push(userItem);
      }
      continue;
    }

    const WARNING_LIGHT_FOR_TYPE: Partial<Record<MaintenanceType, { lightId: string; label: string }>> = {
      oil: { lightId: "oil_pressure", label: "Oil pressure warning light active — service urgently needed" },
      battery: { lightId: "battery_charging", label: "Battery/charging warning light active — have it tested soon" },
      brakes: { lightId: "abs", label: "ABS / brake warning light active — have brakes inspected soon" },
      tires: { lightId: "tpms", label: "Tire pressure (TPMS) warning light active — check tires soon" },
    };

    const lightInfo = WARNING_LIGHT_FOR_TYPE[type];
    if (lightInfo && (activeLights as readonly string[]).includes(lightInfo.lightId)) {
      merged.push({
        id: `unknown-${type}`,
        serviceName: MAINTENANCE_LABELS[type] || type,
        description: lightInfo.label,
        detail: "Warning light",
        status: "needs_attention",
      });
      continue;
    }

    if (type === "battery") {
      const age = vehicleYear ? new Date().getFullYear() - vehicleYear : 0;
      if (age < 3) {
        // W4.1b (2026-08-10): this branch used to read "— healthy", which is an
        // affirmative health CLAIM derived from nothing but the model year. No
        // battery was measured; no record exists. That is the same "absence
        // re-interpreted as evidence" lie the F1 fix below was written to kill,
        // and it survived here as an exception. It is also the most likely
        // origin of the QA report's K5 line ("the hybrid battery is in good
        // shape") — provenance is correctly `inferred` and toAiShape strips the
        // enrichment fields, but `description` was never stripped, so the word
        // "healthy" rode straight through the anti-fabrication pass.
        //
        // Now states the age and the absence of history, and nothing else.
        // `status: "on_time"` is deliberately unchanged — it feeds the health
        // score, and re-scoring young vehicles is a separate product decision.
        merged.push({
          id: `unknown-${type}`,
          serviceName: MAINTENANCE_LABELS[type] || type,
          description: `Battery is ~${age || "<1"} year${age !== 1 ? "s" : ""} old — no service history on file`,
          detail: "No record",
          status: "on_time",
        });
        continue;
      }
    }

    // F1 fix (2026-05-18): when no record exists, default to "unknown" for
    // ALL types. The previous defaults lied in two directions — oil claimed
    // "due_soon" (fabricated urgency), and brakes/tires/battery claimed "on
    // time" (fabricated confirmation). Both were absence-of-input being
    // re-interpreted as evidence. The new contract: absence → "unknown" →
    // prompt rule pushes the user to add the record via render_record_confirmation.
    const fallback: Record<string, { status: MaintenanceStatus; description: string; detail: string }> = {
      oil:    { status: "unknown", description: "No oil change history on file",      detail: "Not on file" },
      brakes: { status: "unknown", description: "No brake service history on file",   detail: "Not on file" },
      tires:  { status: "unknown", description: "No tire service history on file",    detail: "Not on file" },
      battery:{ status: "unknown", description: "No battery service history on file", detail: "Not on file" },
    };
    const fb = fallback[type] ?? { status: "unknown" as MaintenanceStatus, description: "No service history on file", detail: "Not on file" };
    merged.push({
      id: `unknown-${type}`,
      serviceName: MAINTENANCE_LABELS[type] || type,
      description: fb.description,
      detail: fb.detail,
      status: fb.status,
    });
  }

  const inspectionItem = userItems.get("inspection");
  if (inspectionItem) merged.push(inspectionItem);

  const enrichedItems = merged.map(enrichUrgentItem);

  // ── Scoring items ──────────────────────────────────────────────────────────
  // The SAME merge the Cars ring uses (optimistic no-record fallback + OEM
  // cadences + driver recs + consolidated warning item), so the score below
  // matches the ring exactly on vehicles with real data. The REPORTED
  // `enrichedItems` above stay conservative (unknown fallback, F1 provenance
  // stripping) — "same states as before" for what Oto narrates; this parallel
  // set exists only to compute the number.
  const scoringUserItems = buildMaintenanceItems(
    recordInputs,
    odometerMiles > 0 ? odometerMiles : null,
    make,
    drivingConditions,
    avgMonthlyDriving,
    knownIssues,
    vehicleYear,
    oemIntervals as any,
  );
  const scoringItems = buildMergedMaintenanceItems({
    userItems: scoringUserItems,
    records: records.map((r) => ({
      type: r.type,
      confirmedHealthyAt: r.confirmedHealthyAt ?? undefined,
      customInputs: (r.customInputs ?? undefined) as Record<string, unknown> | undefined,
    })),
    knownIssues,
    vehicleYear,
    driverRecommendations,
    scopeId: owner._id as unknown as string,
  });

  return {
    owner,
    records,
    enrichedItems,
    scoringItems,
    odometerMiles,
    knownIssues,
    recPenalty,
    provenanceByType,
  };
}

// -----------------------------------------------------------------------------
// Shape translator: camelCase MaintenanceItem → snake_case AI-tool shape.
// -----------------------------------------------------------------------------

function toAiShape(
  item: MaintenanceItem,
  provenanceByType: Map<MaintenanceType, RecordProvenance>,
): VehicleHealthItem {
  const rawType = item.id.replace(/^(unknown-|user-|smartcar-)/, "") as MaintenanceType;

  // Provenance derivation:
  //   - id starts with "user-"     → backed by a maintenance_record. Look up
  //                                  in provenanceByType (verified | self_reported).
  //                                  Default to "self_reported" if the type
  //                                  isn't in the map for any reason — it's
  //                                  safer to under-trust than over-trust.
  //   - id starts with "unknown-"  → fallback path (warning light, age, default).
  //                                  No record exists → "inferred".
  //   - id starts with "smartcar-" → deprecated path; treat as "inferred".
  const isUserBacked = item.id.startsWith("user-");
  const record_provenance: RecordProvenance = isUserBacked
    ? (provenanceByType.get(rawType) ?? "self_reported")
    : "inferred";

  // F1 fix (2026-05-18) — defense-in-depth against fabrication.
  // When an item has no real anchor (status === "unknown" OR provenance ===
  // "inferred"), strip the fields that the URGENT_DETAILS enrichment fills
  // with canned strings ("~5 months ago", "Service within 2 weeks", canned
  // recommendation). Even if an upstream path slipped fabricated copy
  // through, Haiku can't misread fields that aren't there.
  const isUnsourced = record_provenance === "inferred" || item.status === "unknown";

  return {
    id: item.id,
    type: rawType,
    label: item.serviceName,
    status: item.status,
    description: item.description,
    detail: item.detail,
    last_service: isUnsourced ? undefined : item.lastService,
    urgency_label: isUnsourced ? undefined : item.urgency,
    recommendation: isUnsourced ? undefined : item.recommendation,
    record_provenance,
  };
}

// -----------------------------------------------------------------------------
// QUERY: getVehicleHealth
// -----------------------------------------------------------------------------

// User-scoped core — takes an explicit users._id. Shared by the public query
// (after it resolves the user from auth) and the internal *ForUser variant.
async function _getVehicleHealthCore(
  ctx: any,
  userId: Id<"users">,
  args: { vehicle_id: string },
): Promise<VehicleHealthResponse> {
  const {
    owner,
    enrichedItems,
    scoringItems,
    odometerMiles,
    knownIssues,
    recPenalty,
    provenanceByType,
  } = await loadVehicleContextForUser(ctx, userId, args.vehicle_id);

  // Score from the ring-equivalent items + the same penalty so the number
  // Oto states matches the Cars page. Items REPORTED to Oto stay the conservative
  // enrichedItems (unchanged).
  const score = computeVehicleHealthScore(
    {
      maintenanceItems: scoringItems,
      odometerMiles,
      knownIssues,
      recPenalty,
    },
    await loadHealthScoreWeights(ctx),
  );

  // K5: scope declaration first, item list second. Static per response — it
  // describes what this query is capable of knowing, not what this vehicle's
  // data happens to say.
  return {
    monitored_systems: MONITORED_SYSTEMS,
    not_monitored: NOT_MONITORED_STATEMENT,
    score,
    score_is_estimated: owner.health_score_is_estimated ?? false,
    items: enrichedItems.map((item) => toAiShape(item, provenanceByType)),
    known_issues: describeKnownIssues(knownIssues),
  };
}

export const getVehicleHealth = query({
  args: { vehicle_id: v.string() },
  handler: async (ctx, args): Promise<VehicleHealthResponse> => {
    const userId = await resolveActingUserId(ctx);
    return _getVehicleHealthCore(ctx, userId, args);
  },
});

// INTERNAL variant — same logic, but the acting user id is passed explicitly
// instead of resolved from auth. Lets the director simulation drive this read
// on behalf of a user whose fabricated identity never reaches sub-queries.
// NEVER expose actingUserId on the public query (IDOR).
export const getVehicleHealthForUser = internalQuery({
  args: { actingUserId: v.id("users"), vehicle_id: v.string() },
  handler: async (ctx, args): Promise<VehicleHealthResponse> => {
    return _getVehicleHealthCore(ctx, args.actingUserId, {
      vehicle_id: args.vehicle_id,
    });
  },
});

// -----------------------------------------------------------------------------
// QUERY: getProjectedHealthScore
// -----------------------------------------------------------------------------

// User-scoped core — takes an explicit users._id. Shared by the public query
// (after it resolves the user from auth) and the internal *ForUser variant.
async function _getProjectedHealthScoreCore(
  ctx: any,
  userId: Id<"users">,
  args: { vehicle_id: string; item_id: string },
): Promise<ProjectedHealthResponse> {
  const { scoringItems, odometerMiles, knownIssues, recPenalty } =
    await loadVehicleContextForUser(ctx, userId, args.vehicle_id);

  // Project from the SAME base as the quoted score (scoringItems + penalty)
  // so the "fixing this adds N pts" delta reconciles with the number Oto states.
  const input = {
    maintenanceItems: scoringItems,
    odometerMiles,
    knownIssues,
    recPenalty,
  };
  const weights = await loadHealthScoreWeights(ctx);

  const current = computeVehicleHealthScore(input, weights);
  const projected = computeProjectedHealthScore(input, args.item_id, weights);
  const lift = Math.max(0, projected - current);

  return {
    current_score: current,
    projected_score: projected,
    lift,
  };
}

export const getProjectedHealthScore = query({
  args: { vehicle_id: v.string(), item_id: v.string() },
  handler: async (ctx, args): Promise<ProjectedHealthResponse> => {
    const userId = await resolveActingUserId(ctx);
    return _getProjectedHealthScoreCore(ctx, userId, args);
  },
});

// INTERNAL variant — same logic, acting user id passed explicitly. Used by the
// director simulation so the projected-score read resolves the right user's
// vehicle even when the fabricated identity doesn't reach sub-queries.
// NEVER expose actingUserId on the public query (IDOR).
export const getProjectedHealthScoreForUser = internalQuery({
  args: {
    actingUserId: v.id("users"),
    vehicle_id: v.string(),
    item_id: v.string(),
  },
  handler: async (ctx, args): Promise<ProjectedHealthResponse> => {
    return _getProjectedHealthScoreCore(ctx, args.actingUserId, {
      vehicle_id: args.vehicle_id,
      item_id: args.item_id,
    });
  },
});

