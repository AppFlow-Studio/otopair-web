import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Revert expired pending_customer_acceptance reschedules every 15 minutes
crons.interval(
  "revert expired reschedules",
  { minutes: 15 },
  internal.bookings.revertExpiredReschedules,
);

export default crons;
