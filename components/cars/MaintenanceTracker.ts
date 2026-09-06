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
  /** Set when this item comes from a mechanic-submitted job recommendation.
   *  Threaded through the booking flow as bookings.source_recommendation_id
   *  so the rec auto-closes when the booking completes. */
  sourceRecommendationId?: string;
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
  /** Precomputed 0–1 score, bypassing the STATUS_SCORE lookup, when a status
   *  alone can't capture severity (e.g. brakes' per-corner blend). Only set
   *  for brakes today; every other item leaves this undefined and scores via
   *  the normal status lookup, unchanged. Mirror in the mobile repo's
   *  MaintenanceTracker.tsx to keep this stub in sync. */
  rawScore?: number;
  /** Set on rows derived purely from an OEM interval and an odometer with no
   *  underlying record — a catalog inference. Excluded from the health-score
   *  computation via isScorableMaintenanceItem so pure inferences don't
   *  drift the score (only real records + the five core tiles should).
   *  No-op on web today (no catalog-inference path exists here yet), tracked
   *  for parity with mobile so the shape can't silently drift. */
  excludeFromScore?: boolean;
  /** The four-way interval band (Quick Check v2 §7). `status` stays the
   *  three-value display tier; this separates OVERDUE from SEVERELY OVERDUE
   *  so the latter can lead the NOW tier without a fourth heading. */
  bandStatus?: "on_time" | "due_soon" | "overdue" | "severely_overdue";
  /** Where the interval came from — drives the confidence hold. */
  intervalSource?: "oem" | "class_default" | "legacy_default" | "none";
  /** The factor the score used, after the hold. */
  factorApplied?: number;
}
