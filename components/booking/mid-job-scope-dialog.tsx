"use client";

/**
 * MidJobScopeDialog — the ONE place a running job can be re-quoted
 * (Flag Issue spec, §3).
 *
 * "Add unforeseen scope" used to live only in the booking detail panel, with its
 * props assembled inline there. Wiring the mechanic overlay's Flag Issue sheet to
 * it meant either duplicating that assembly — and the seeding logic has real
 * traps in it — or lifting it somewhere both can mount. This is that somewhere.
 *
 * WHY THE SEEDING MATTERS ENOUGH TO EXTRACT:
 * The dialog must open showing the latest customer-APPROVED quote, not the
 * catalog prefill. Seed it from the wrong source and every part resets to $0 and
 * parts the mechanic already dropped come back as live lines. `not_used` has to
 * survive too, or re-opening the dialog revives a dropped part as a $0 row. Two
 * copies of that logic would drift, and the drift would be silent and expensive.
 *
 * Everything is queried internally from `bookingId`, so a caller needs nothing
 * but an id — which is exactly what the overlay has.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { JobActualPartPayload } from "@/lib/vehicle-passport";
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

export default function MidJobScopeDialog({
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
  /**
   * Gated on `bookingId`, NOT on `open`.
   *
   * The panel used to query these unconditionally, so tapping "Add unforeseen
   * scope" opened on warm data. Gating on `open` would make every entry — panel
   * and Flag Issue sheet alike — wait a round-trip on a mechanic who is standing
   * at the car. Three subscriptions on a booking the user is already looking at
   * is the cheaper trade.
   */
  const args = bookingId ? { bookingId } : "skip";

  const job = useQuery(api.bookings.getJobDetail, args);
  const actualsPrefill = useQuery(api.job_actuals.getPrefillData, args);
  const vehiclePassport = useQuery(
    api.bookings.getVehiclePassportForBooking,
    args,
  );
  const effectiveQuote = useQuery(
    (api as any).booking_approvals.getEffectiveQuoteForBooking,
    args,
  ) as
    | {
        partsSnapshot: Array<{
          part_name: string;
          brand?: string | null;
          oem_number: string;
          cost: number;
          quantity: number;
          supplied_by?: string;
          part_tier?: string | null;
          service_id?: string | null;
          source?: string;
          not_used?: boolean;
          is_tire?: boolean;
          tire_size?: string | null;
          tire_brand?: string | null;
          tire_model?: string | null;
          tire_position?: string | null;
        }>;
      }
    | null
    | undefined;

  /**
   * Seed from the latest APPROVED quote — the mechanic's entered prices with
   * removed / not-used rows already excluded — falling back to the priced
   * snapshot. NOT the catalog prefill: that resets every price to $0 and brings
   * back parts the mechanic dropped.
   */
  const lockedQuoteParts = useMemo<JobActualPartPayload[] | null>(() => {
    if (effectiveQuote && effectiveQuote.partsSnapshot.length > 0) {
      return effectiveQuote.partsSnapshot.map((p) => ({
        part_name: p.part_name,
        brand: p.brand ?? null,
        oem_number: p.oem_number,
        cost: p.cost,
        quantity: p.quantity,
        supplied_by: p.supplied_by === "customer" ? "customer" : "shop",
        part_tier: p.part_tier ?? "oem",
        service_id: (p.service_id ?? null) as JobActualPartPayload["service_id"],
        source: (p.source ?? "catalog") as JobActualPartPayload["source"],
        // Preserve the prior "Not used" flag, or re-opening revives a dropped
        // part as an active $0 line.
        not_used: p.not_used === true ? true : undefined,
        // Round-trip mechanic-entered tire identity so re-opening the dialog
        // keeps the size/brand/model instead of the `TIRE-{size}` sentinel.
        is_tire: p.is_tire ?? undefined,
        tire_size: p.tire_size ?? undefined,
        tire_brand: p.tire_brand ?? undefined,
        tire_model: p.tire_model ?? undefined,
        tire_position: p.tire_position ?? undefined,
      }));
    }
    const snapshot = (job as any)?.pricedPartsSnapshot;
    if (!snapshot || snapshot.length === 0) return null;
    return snapshot.map((p: any) => ({
      part_name: p.part_name,
      brand: p.brand ?? null,
      oem_number: p.oem_number,
      cost: p.unit_price_cents / 100,
      quantity: p.quantity,
      supplied_by: "shop" as const,
      part_tier: p.part_tier ?? "oem",
      service_id: p.service_id ?? null,
      source: "catalog" as const,
      not_used: p.not_used === true ? true : undefined,
      is_tire: p.is_tire ?? undefined,
      tire_size: p.tire_size ?? undefined,
      tire_brand: p.tire_brand ?? undefined,
      tire_model: p.tire_model ?? undefined,
      tire_position: p.tire_position ?? undefined,
    }));
  }, [effectiveQuote, job]);

  // Unmounts when closed, so each re-quote starts from a clean dialog rather
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
      // (a pre-existing mismatch the other call sites carry implicitly). Cast
      // narrowly here rather than adding another silent error to the pile.
      passportData={(vehiclePassport ?? null) as never}
      estimatedLaborMinutes={j.estimatedLaborMinutes ?? null}
      prefillData={actualsPrefill ?? null}
      isSubmitting={false}
      onClose={onClose}
      onSubmit={async () => {
        /* cycle path handles submit internally */
      }}
      cycle="mid_job"
      onApprovalSubmitted={() =>
        onSubmitted?.("Added scope sent for confirmation")
      }
      laborRateCents={j.shopLaborRateCents ?? null}
      laborCostDollars={j.laborCost ?? null}
      shopState={j.shopState ?? null}
      shopZip={j.shopZip ?? null}
      quotedParts={lockedQuoteParts}
      isFixedPrice={j.isFixedPrice}
    />
  );
}
