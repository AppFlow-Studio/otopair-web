"use client";

/**
 * PreJobScopeDialog — send the customer a pre-job estimate for scope discovered
 * BEFORE the job starts (booking_approvals.submitPreJobEstimate).
 *
 * The sibling of MidJobScopeDialog. Both wrap the very same PostJobSurveyDialog
 * (price it · why this adjustment · add parts · send for confirmation); they
 * differ only in the approval CYCLE and where the parts list is seeded from:
 *
 *   - mid-job  → the latest customer-APPROVED quote (work is already underway,
 *                the agreed prices are the floor).
 *   - pre-job  → the booked catalog quote, axle-scoped (`scopedQuotedParts` from
 *                useLockedQuote) — there's no approved adjustment yet.
 *
 * Everything is queried internally from `bookingId`, so a caller needs nothing
 * but an id — which is exactly what the inspection dialog has. This is what lets
 * a mechanic take a finding straight from the inspection into a pre-job estimate,
 * instead of waiting until the job is running to add it as a mid-job change.
 */

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLockedQuote } from "@/lib/use-locked-quote";
import PostJobSurveyDialog from "@/components/post-job-survey-dialog";

function formatWhen(date?: string | null, time?: string | null) {
  if (!date) return "";
  const d = new Date(`${date}T${time ?? "00:00"}`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function PreJobScopeDialog({
  open,
  bookingId,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  bookingId: Id<"bookings"> | null;
  onClose: () => void;
  onSubmitted?: (message: string) => void;
}) {
  // Gated on `bookingId`, NOT `open` — mirrors MidJobScopeDialog so the dialog
  // opens on warm data instead of making a mechanic standing at the car wait a
  // round-trip. Convex dedupes these subscriptions against the ones the parent
  // inspection dialog already holds.
  const args = bookingId ? { bookingId } : "skip";

  const job = useQuery(api.bookings.getJobDetail, args);
  const actualsPrefill = useQuery(api.job_actuals.getPrefillData, args);
  const vehiclePassport = useQuery(
    api.bookings.getVehiclePassportForBooking,
    args,
  );

  // Same seeding the booking-detail-panel feeds its pre-job estimate dialog:
  // the booked catalog quote, axle-scoped. Kept in the shared hook so this and
  // that surface can't drift.
  const { scopedQuotedParts } = useLockedQuote(job);

  // Unmounts when closed, so each estimate starts from a clean dialog rather
  // than whatever the last aborted one left behind. The data above stays warm.
  if (!open || !bookingId || !job) return null;

  const j = job as any;

  return (
    <PostJobSurveyDialog
      open={open}
      bookingId={String(bookingId)}
      bookingLabel={j.vehicle ?? "Vehicle"}
      bookingSubLabel={[
        j.customerName,
        (j.serviceNames ?? []).join(", "),
        formatWhen(j.scheduledDate, j.scheduledTime),
      ]
        .filter(Boolean)
        .join(" · ")}
      // getVehiclePassportForBooking's return has drifted from VehiclePassportData
      // (a pre-existing mismatch the other call sites carry). Cast narrowly here
      // rather than adding another silent error to the pile — same as
      // MidJobScopeDialog.
      passportData={(vehiclePassport ?? null) as never}
      estimatedLaborMinutes={j.estimatedLaborMinutes ?? null}
      prefillData={actualsPrefill ?? null}
      isSubmitting={false}
      onClose={onClose}
      onSubmit={async () => {
        /* cycle path handles submit internally */
      }}
      cycle="pre_job"
      onApprovalSubmitted={() =>
        onSubmitted?.("Estimate sent for confirmation")
      }
      laborRateCents={j.shopLaborRateCents ?? null}
      laborCostDollars={j.laborCost ?? null}
      shopState={j.shopState ?? null}
      shopZip={j.shopZip ?? null}
      quotedParts={scopedQuotedParts}
      isFixedPrice={j.isFixedPrice}
    />
  );
}
