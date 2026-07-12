// import { cronJobs } from "convex/server";
// import { internal } from "./_generated/api";
// import { isLateStartTestModeEnabled } from "./lib/late_start";

// const crons = cronJobs();

// // crons.daily(
// //   "mark-estimated-health-scores",
// //   { hourUTC: 6, minuteUTC: 0 },
// //   internal.checkin.markEstimatedHealthScores
// // );

// // Run account cleanup every day at 7:00 AM
// crons.daily(
//   "cleanup-expired-accounts",
//   { hourUTC: 7, minuteUTC: 0 },
//   internal.cleanup.cleanupExpiredAccounts,
// );

// // ─── Marketplace VIN Discovery Pipeline ─────────────────────────

// Health Points decay — 2 pts per 30-day window per vehicle. The
// mutation is idempotent within a window so a daily run is fine
// (decay only fires when a full 30-day chunk has elapsed for a row).
// crons.daily(
//   "health-points-decay",
//   { hourUTC: 8, minuteUTC: 0 },
//   internal.healthPoints.applyDecay,
// );

// // Scrape CarGurus for VINs — runs twice daily (8 AM and 6 PM UTC)
// crons.daily(
//   "marketplace-scrape-cargurus-morning",
//   { hourUTC: 8, minuteUTC: 0 },
//   internal.vehicleEnrichment.marketplaceScraper.runScheduledScrape,
//   { source: "cargurus" }
// );

// crons.daily(
//   "marketplace-scrape-cargurus-evening",
//   { hourUTC: 18, minuteUTC: 0 },
//   internal.vehicleEnrichment.marketplaceScraper.runScheduledScrape,
//   { source: "carscom" }
// );

// // Process VIN queue every 10 minutes — pick up pending VINs and trigger enrichment.
// // Gated by env var ENRICHMENT_PAUSED — set to "true" in Convex env to pause without redeploying.
// crons.interval(
//   "process-vin-queue",
//   { minutes: 10 },
//   internal.vehicleEnrichment.marketplaceScraper.processVinQueue,
// );

// crons.interval(
//   "revert-expired-booking-reschedules",
//   { minutes: 15 },
//   internal.bookings.revertExpiredReschedules,
// );

// crons.interval(
//   "process-customer-late-monitors",
//   { minutes: 1 },
//   internal.bookings.processCustomerLateMonitors,
// );

// crons.interval(
//   "process-overrun-checkins",
//   { minutes: 1 },
//   internal.bookings.processOverrunCheckins,
// );


// export default crons;

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "expire-stale-recommendations",
  { hourUTC: 6, minuteUTC: 0 },
  internal.jobRecommendations.expireOlderThan12Months,
);

// Penalty depends on rec age (30-day ramp), so refresh nightly even when
// no rec lifecycle event fires. Runs 30 min after expiry so newly-expired
// recs are out of the open set first.
crons.daily(
  "recompute-rec-penalties",
  { hourUTC: 6, minuteUTC: 30 },
  internal.jobRecommendations.recomputeAllRecPenalties,
);

// Health Points decay — 2 pts per 30-day window per vehicle. The
// mutation is idempotent within a window so a daily run is fine
// (decay only fires when a full 30-day chunk has elapsed for a row).
crons.daily(
  "health-points-decay",
  { hourUTC: 8, minuteUTC: 0 },
  internal.healthPoints.applyDecay,
);

crons.interval(
  "revert-expired-booking-reschedules",
  { minutes: 15 },
  internal.bookings.revertExpiredReschedules,
);

crons.interval(
  "auto-drop-unconfirmed-bookings",
  { minutes: 10 },
  internal.bookings.autoDropUnconfirmedBookings,
);

crons.interval(
  "process-customer-late-monitors",
  { minutes: 1 },
  internal.bookings.processCustomerLateMonitors,
);

crons.interval(
  "process-appointment-reminder-monitors",
  { minutes: 1 },
  internal.bookings.processAppointmentReminderMonitors,
);

crons.interval(
  "process-overrun-checkins",
  { minutes: 1 },
  internal.bookings.processOverrunCheckins,
);

crons.interval(
  "dispatch-pending-sms",
  { minutes: 1 },
  (internal as any).sms_dispatcher.dispatchPendingSms,
);

crons.interval(
  "dispatch-pending-emails",
  { minutes: 1 },
  (internal as any).email_dispatcher.dispatchPendingEmails,
);

// Pre-Job Approval: expire 24h-stale customer approval cycles. Pre-job
// expiry captures the $20 deposit forfeit; mid-job expiry just freezes the
// ceiling at the prior approved set price.
crons.interval(
  "expire-approvals",
  { minutes: 10 },
  internal.booking_approvals.expireApprovals,
);

// Pre-Job Approval: drain notification_outbox rows with channel="push" via
// the Expo Push API. Existing SMS/email dispatchers handle their own
// channels; this is the push sibling.
crons.interval(
  "dispatch-pending-push",
  { minutes: 1 },
  (internal as any).lib.push_dispatcher.dispatchPendingPush,
);

// Part prices: nightly re-verification of parts whose newest price row is
// stale (default > 30 days). Spends Firecrawl credits, so the action no-ops
// unless PARTS_PRICE_REFRESH_BUDGET (parts per night) is set > 0 in env.
crons.daily(
  "refresh-stale-part-prices",
  { hourUTC: 9, minuteUTC: 0 },
  internal.vehicleEnrichment.priceRefresh.refreshStalePrices,
  {},
);

// Cross-make fitment quarantine: nightly sweep marking contaminated fitments
// (wrong-make part on a config, or a foreign brand-signature number stamped
// with the config's own make) as data_quality: cross_make_quarantined, plus
// normalized-number dedupe. DB-only — no Firecrawl/LLM spend. The write-time
// guards should make this a no-op; it exists because contamination was
// observed REGENERATING on re-enrich (Jul 2026) and a durable net beats
// chasing every vector.
crons.daily(
  "quarantine-cross-make-fitments",
  { hourUTC: 9, minuteUTC: 30 },
  internal.vehicleEnrichment.fitmentQuarantine.runQuarantineScan,
  { dryRun: false },
);

// Labor times: fold freshly-recorded shop data into the labor median every 6h.
// Job finalize already recomputes inline; this catches (config, service) pairs
// touched by labor_quote_snapshots so empirical accrues continuously without a
// re-enrich. No-op until real shop data exists.
crons.interval(
  "recompute-recent-labor",
  { hours: 6 },
  internal.vehicleEnrichment.v3mutations.recomputeRecentLabor,
  {},
);

export default crons;
