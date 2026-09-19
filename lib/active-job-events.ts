import type { Id } from "@/convex/_generated/dataModel";

/**
 * Dispatched on `window` to jump into the active job from anywhere in the app —
 * the booking drawer's "Open active job" button fires it once the inspection is
 * in. `ActiveJobStrip` (the on-screen pill) listens and opens the full-screen
 * focused pane for `detail.bookingId`.
 *
 * Kept in this leaf module (rather than on `active-job-strip`) so the booking
 * drawer can reference it without importing the pill — that back-edge closes a
 * module cycle (drawer → pill → overlay → … → drawer) and breaks evaluation.
 */
export const OPEN_ACTIVE_JOB_EVENT = "otopair:open-active-job";

export type OpenActiveJobDetail = { bookingId?: Id<"bookings"> };
