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

// Expire unanswered booking REQUESTS: a shop-pending request (pending /
// pending_shop_acceptance) auto-cancels at the earlier of a 48h response SLA
// or 2h past the requested appointment time, after nudging the shop. Distinct
// from auto-drop above, which no-shows already-CONFIRMED bookings.
crons.interval(
  "auto-cancel-unconfirmed-requests",
  { minutes: 10 },
  internal.bookings.autoCancelUnconfirmedRequests,
);

crons.interval(
  "process-customer-late-monitors",
  { minutes: 1 },
  internal.bookings.processCustomerLateMonitors,
);

// Reap expired StubHub-style slot holds. Only a janitor — availability reads
// already drop `expires_at <= now` holds in real time, so a slot frees the
// instant its hold expires; this reclaims the rows. 1-min (not 10) because a
// 15-min TTL can't tolerate a slot staying falsely blocked for a third of its
// life waiting on a slower sweep.
crons.interval(
  "release-expired-slot-holds",
  { minutes: 1 },
  internal.slotHolds.releaseExpiredSlotHolds,
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

// Safety net for the completion-capture path: retry capture on completed jobs
// still flagged `awaiting_settlement` (belated customer re-auth, transient
// Stripe failure), and escalate the aged ones. Without this a shortfall sits
// uncaptured forever — the completion transition fires capture only once and
// the webhooks never initiate one.
crons.interval(
  "reconcile-unsettled-bookings",
  { minutes: 30 },
  internal.payments_reconcile.reconcileUnsettledBookings,
  {},
);

// Warn ops ~1 day before a card authorization hits Stripe's ~7-day expiry on a
// still-active (pre-service) booking, so the hold can be re-confirmed or the
// booking rescheduled before it lapses and capture becomes impossible.
crons.daily(
  "flag-expiring-holds",
  { hourUTC: 9, minuteUTC: 0 },
  internal.payments_reconcile.flagExpiringHolds,
  {},
);

// Pre-Job Approval: drain notification_outbox rows with channel="push" via
// the Expo Push API. Existing SMS/email dispatchers handle their own
// channels; this is the push sibling.
crons.interval(
  "dispatch-pending-push",
  { minutes: 1 },
  (internal as any).lib.push_dispatcher.dispatchPendingPush,
);

// Determinism sentinel (Wave 4): weekly probe of ONE operator-supplied VIN
// (DETERMINISM_SENTINEL_VINS="label:VIN,…" — unset = free no-op). Sunday
// 03:00 UTC so the ~1h probe chain finishes well before the repair/price
// crons. Variance routes to the review queue; the same VIN enriched twice
// must produce the same core signature, or that's a tracked defect.
crons.weekly(
  "determinism-sentinel-probe",
  { dayOfWeek: "sunday", hourUTC: 3, minuteUTC: 0 },
  internal.vehicleEnrichment.determinismProbe.runScheduledProbe,
  {},
);

// Standing fitment audit (plan P3, Aug 2026): re-adjudicate the configs
// whose stored fitments have gone longest unexamined — Sonnet verify,
// double-refute to delete, heal scheduled per removal. The one-time fleet
// sweep this loop grew out of removed ~69 plausible-but-wrong parts the
// finalize-time verifier had approved. Freshness-ordered (no cursor state);
// dark unless PARTS_FITMENT_AUDIT_BUDGET (configs/night) is set > 0. Runs
// before role repair so reopened holes are re-sourced the same night.
crons.daily(
  "fitment-audit-sweep",
  { hourUTC: 7, minuteUTC: 30 },
  internal.vehicleEnrichment.fitmentReverify.nightly,
  {},
);

// Fleet role repair (Wave 2): nightly census of configs whose latest run
// shows missing binding core roles, scheduling the batch repair over the
// worst under PARTS_ROLE_REPAIR_FLEET_BUDGET (0 = census-only, no spend).
// Runs 45 min before the price refresh so healed parts get priced same
// night. The logged fleetResidual is the metric that decides when the
// core-role/axle completion gates can flip from "log" to "enforce".
crons.daily(
  "repair-fleet-missing-roles",
  { hourUTC: 8, minuteUTC: 15 },
  internal.vehicleEnrichment.resourceRoles.repairFleetSweep,
  {},
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

// Portal KPI materialization (decision #3, R2 class). Cheap windowed stats
// every 15 min; the self-chaining enrichment_evidence sweep (28k+ rows)
// daily — each chain link paginates 4k docs, so no single mutation
// approaches the read limit. SLO breaches land in notification_outbox
// (deduped per key per day) for the Slack dispatcher.
crons.interval("portal-stats-cheap", { minutes: 15 }, internal.portalStats.recomputeCheapStats, {});
// review_queue materialization sweep (decision #4) — idempotent per-stream
// backfills keyed on source doc id, so repeat runs insert zero duplicates.
crons.interval("review-queue-sweep", { minutes: 30 }, internal.reviewQueue.sweepAllStreams, {});
crons.daily(
  "portal-stats-evidence-sweep",
  { hourUTC: 6, minuteUTC: 30 },
  internal.portalStats.recomputeEvidenceStats,
  {},
);
// Daily cost snapshots for /data/costs — recomputes the last 3 UTC days so
// late-arriving run stamps self-heal (each day one bounded window read).
crons.daily(
  "portal-stats-cost-day",
  { hourUTC: 6, minuteUTC: 45 },
  internal.portalStats.recomputeCostDays,
  {},
);

// Zombie enrichment-run reaper: any in-progress run whose chain has been
// silent past 30 min (2x the 15-min liveness window; healthy chains heartbeat
// every 60s fast / 10 min slow) is marked failed and its config restored to
// pending/partial. STEP 0's stuck valve only fires when a NEW enrichment hits
// the same config_key, so without this sweep an unpopular config stays
// soft-locked forever (the Jul-21 batch2 zombie). DB-only; never spends.
crons.interval(
  "reap-stale-enrichment-runs",
  { minutes: 15 },
  internal.vehicleEnrichment.v3mutations.reapStaleRuns,
  {},
);

// NHTSA ODI (Phase 0.1): re-pull recalls + complaint signals for configs whose
// ODI data is > 30 days old. Free public API (no auth); the sweep schedules
// each config as its own staggered action, so a modest limit keeps the daily
// request volume trivial. Fail-open — an NHTSA outage stores nothing.
crons.interval(
  "refresh-nhtsa-odi",
  { hours: 24 },
  (internal as any).vehicleEnrichment.nhtsaOdi.refreshStaleOdi,
  { limit: 50 },
);

// EPA fuel economy (Phase 0.5): re-pull configs whose fueleconomy.gov row is
// > 90 days old (EPA figures are static per model year — this is generous).
// Free public API (no auth); the sweep schedules each config as its own
// staggered action. Fail-open — an outage or ambiguous engine match stores
// nothing rather than a guess.
crons.interval(
  "refresh-epa-economy",
  { hours: 24 },
  (internal as any).vehicleEnrichment.epaFuelEconomy.refreshStaleEpa,
  { limit: 50 },
);

// OEM manual library (P2.2): nightly micro-batch of configs missing
// `interval_months` on a core service. Each config costs a multi-MB PDF
// download + a Files-API upload + a large-context extraction call, so the
// batch is deliberately tiny (3/night by default) and the sweep schedules
// each config as its own staggered action. Set MANUAL_LIBRARY_DAILY_LIMIT in
// Convex env to resize it — 0 turns the cron into a no-op without redeploying.
// Fail-open: a failed resolve writes a failure_reason (14-day negative cache)
// and the extraction no-ops rather than storing a guess.
crons.interval(
  "backfill-manual-intervals",
  { hours: 24 },
  (internal as any).vehicleEnrichment.manualLibrary.backfillManualIntervals,
  { dryRun: false },
);

// Part-number existence oracle: weekly re-crawl of every (make, source) catalog
// sitemap already present in part_index_status. Weekly because the oracle may
// only fail closed on an index younger than 30 days — this keeps that
// entitlement alive without ever granting it to a make nobody deliberately
// ingested. Free (no API, no LLM spend); the ingest self-continues one child
// sitemap per tick at the robots.txt crawl delay, and a crawl that cannot read
// every child ends "failed" so a partial index can never answer "absent".
crons.interval(
  "refresh-part-index",
  { hours: 168 },
  (internal as any).vehicleEnrichment.partIndex.refreshIndexedMakes,
  { limit: 10 },
);

// Otofacts Car Data API billing: settle reserved enrich credits against run
// outcome — complete → commit (report meter for overage), failed/timed-out →
// refund. So a failed enrich is never charged. Spec: CARDATA_BILLING_SPEC.md.
crons.interval(
  "otofacts-reconcile-enrich-ledger",
  { minutes: 5 },
  internal.dataApiBilling.reconcileEnrichLedger,
  {},
);

export default crons;
