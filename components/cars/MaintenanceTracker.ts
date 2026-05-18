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
}
