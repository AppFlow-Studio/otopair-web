import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { isLateStartTestModeEnabled } from "./lib/late_start";

const crons = cronJobs();

// crons.daily(
//   "mark-estimated-health-scores",
//   { hourUTC: 6, minuteUTC: 0 },
//   internal.checkin.markEstimatedHealthScores
// );

// Run account cleanup every day at 7:00 AM
crons.daily(
  "cleanup-expired-accounts",
  { hourUTC: 7, minuteUTC: 0 },
  internal.cleanup.cleanupExpiredAccounts,
);

// // ─── Marketplace VIN Discovery Pipeline ─────────────────────────

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

// // Process VIN queue every 30 minutes — pick up pending VINs and trigger enrichment
// crons.interval(
//   "process-vin-queue",
//   { minutes: 30 },
//   internal.vehicleEnrichment.marketplaceScraper.processVinQueue,
// );

crons.interval(
  "revert-expired-booking-reschedules",
  { minutes: 15 },
  internal.bookings.revertExpiredReschedules,
);

if (!isLateStartTestModeEnabled()) {
  crons.interval(
    "process-customer-late-monitors",
    { minutes: 1 },
    internal.bookings.processCustomerLateMonitors,
  );
  crons.interval(
    "process-job-overrun-checkins",
    { minutes: 1 },
    internal.bookings.processJobOverrunCheckins,
  );
}

export default crons;
