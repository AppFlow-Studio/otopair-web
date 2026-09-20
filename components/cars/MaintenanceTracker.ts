// Types-only stub for the mobile MaintenanceTracker component.
//
// The full React Native component lives in the otopair mobile repo at
// components/cars/MaintenanceTracker.tsx. This file exists in otopair-web
// purely so server-side code under convex/ (notably oto/vehicleHealth.ts +
// utils/maintenanceEnrichment.ts + utils/healthScore.ts) can `import type`
// the shared shapes without dragging RN runtime imports into the Convex
// bundle.
//
// Keep these in sync with the mobile component's exports.

export type MaintenanceStatus =
  | 'on_time'
  | 'needs_attention'
  | 'due_soon'
  | 'overdue'
  | 'unknown';

export type MaintenanceTriggerAxis = 'time' | 'mileage' | 'both' | 'inference' | 'none';

export interface MaintenanceItem {
  id: string;
  serviceName: string;
  description: string;
  // e.g. "Mar 2025", "Aug 2025", "Unknown"
  detail: string;
  status: MaintenanceStatus;
  /** 0–100 percent of interval used (mileage- or time-based), preserved
   *  from computeMaintenanceStatus so Action Engine proximity uses the
   *  real v0 ramp instead of inferring from status. Optional because
   *  inferred fallback items (no record) don't have an actual ramp. */
  percentUsed?: number;
  lastService?: string;
  urgency?: string;
  impacts?: Array<{ label: string; severity: 'high' | 'medium' | 'low' }>;
  recommendation?: string;
  /* ── Advisory (off-catalog) recommendation ──────────────────────────────
     Set when the mechanic flagged work the catalog can't name. There is no
     service behind it, so it cannot be booked, cannot be priced, and cannot
     move the health score — see the delta suppression in UrgentCard. */
  advisory?: boolean;
  advisoryDisclaimer?: string | null;
  authorLabel?: string | null;
  advisoryAged?: boolean;
  /** Set when this item comes from a mechanic-submitted job recommendation.
   *  Threaded through the booking flow as bookings.source_recommendation_id
   *  so the rec auto-closes when the booking completes. */
  sourceRecommendationId?: string;
  /** Item is shown to the driver but must never enter the health score.
   *  Set by the catalog-coverage inference pass: those rows are derived from
   *  an OEM interval and an odometer alone, with no service record and no
   *  mechanic behind them. Only the five core tiles score by default; a minor
   *  item earns its weight because a mechanic graded it, never because time
   *  passed. Kept as an explicit flag rather than sniffing the `catalog-` id
   *  prefix, matching how recommendation cards are already excluded. */
  excludeFromScore?: boolean;
  /** Who flagged a CORE or MINOR item and when — drives the "Flagged by
   *  <shop>, <date>" line. Distinct from `mechanicProvenance`, which belongs
   *  to recommendation cards and reads "Suggested by …": a grade is a finding
   *  recorded against the vehicle, not a suggestion to book something.
   *  Written by the inspection into the record's customInputs. */
  mechanicFlag?: {
    shopName?: string | null;
    gradedAt?: number | null;
  };
  /** Mechanic + shop provenance for recs — drives the "Suggested by …" subtitle. */
  mechanicProvenance?: {
    shopName?: string | null;
    mechanicName?: string | null;
  };
  /** Raw urgency literal from the mechanic rec — drives the timing-vs-date
   *  branch in the Take Action detail screen. */
  recUrgency?: "next_visit" | "within_3_months" | "soon";
  /** ms-epoch slot the shop pre-picked; when set the detail screen offers
   *  Confirm Date / Dismiss instead of Book This Service. */
  scheduledAt?: number | null;
  scheduledMechanicName?: string | null;
  /** Canonical service id behind the rec — surfaced for the booking flow
   *  pre-fill from the detail screen. */
  serviceId?: string | null;
  /** Taxonomy slug of the service that fixes this item. Set on minor
   *  eye-check items, whose card is named for the inspection line rather
   *  than the remedy the catalog sells. */
  serviceSlug?: string | null;
  /** Per-axis copy for the signal-pill row. */
  signals?: {
    time?: string;
    mileage?: string;
    interval?: string;
  };
  triggeredBy?: MaintenanceTriggerAxis;
  /** Precomputed 0–1 score, bypassing the STATUS_SCORE lookup, when a status
   *  alone can't capture severity (e.g. brakes' per-corner blend from a shop
   *  inspection). Only set for brakes today; every other item leaves this
   *  undefined and scores via the normal status lookup, unchanged. */
  rawScore?: number;
  /** The four-way interval band (Quick Check v2 §7). `status` stays the
   *  three-value display tier; this separates OVERDUE from SEVERELY OVERDUE
   *  so the latter can lead the NOW tier without a fourth heading. */
  bandStatus?: "on_time" | "due_soon" | "overdue" | "severely_overdue";
  /** Where the interval came from — drives the confidence hold. */
  intervalSource?: "oem" | "class_default" | "legacy_default" | "none";
  /** The factor the score used, after the hold. */
  factorApplied?: number;
  /** "Resolved by this booking" overlay (set in utils/mergedMaintenance). When
   *  present, a completed booking (originally-booked OR added catalog service)
   *  closed this item out; the card renders the green resolved treatment that
   *  deep-links to the past-service detail. Cleared once the driver taps it. */
  resolvedByBookingId?: string;
  resolvedShopName?: string | null;
  resolvedAt?: number;
  /** The maintenance_records `type` the ack must patch. Usually derivable from
   *  the item id, but a `catalog-<slug>` inference item resolves via its
   *  slug-specific minor anchor, so it's carried explicitly. */
  resolvedRecordType?: string;
}
