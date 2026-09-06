"use client";

/**
 * BookingContextBar — the booking header shown at the top of a ticket thread so
 * whoever's answering has the full picture without leaving the inbox: customer,
 * vehicle + VIN, tracking status, scheduled time + mechanic, services, and the
 * booking id. Plus two actions: open the booking (deep-link) and view the car
 * info sheet (vehicle passport).
 *
 * Reads api.bookings.getJobDetail — the same rich query the booking detail
 * panel uses, so field resolution (customer/vehicle/mechanic name, services)
 * can't drift. Convex dedupes the subscription, so mounting this inside the
 * in-booking drawer (where the panel already subscribes) costs no round trip.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Car,
  ExternalLink,
  Fingerprint,
  Hash,
  Loader2,
  User,
  Wrench,
  X,
} from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusPill } from "@/components/status-pill";
import VehiclePassportSection from "@/components/vehicle-passport-section";
import type { VehiclePassportData } from "@/lib/vehicle-passport";
import { formatJobDate } from "@/app/(portal)/bookings/booking-list-shared";

type JobDetail = {
  status: string;
  customerName?: string | null;
  customerEmail?: string | null;
  vehicle?: string | null;
  vin?: string | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  serviceNames?: string[] | null;
  mechanicName?: string | null;
};

export function BookingContextBar({
  bookingId,
}: {
  bookingId: Id<"bookings">;
}) {
  const job = useQuery(api.bookings.getJobDetail, { bookingId }) as
    | JobDetail
    | null
    | undefined;
  const [showCarInfo, setShowCarInfo] = useState(false);

  if (job === undefined) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading booking…
      </div>
    );
  }
  if (job === null) {
    return (
      <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        Booking details unavailable.
      </div>
    );
  }

  const when =
    job.scheduledDate && job.scheduledTime
      ? formatJobDate(job.scheduledDate, job.scheduledTime)
      : null;
  const services = (job.serviceNames ?? []).filter(Boolean);
  const shortId = String(bookingId).slice(-6);

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
      {/* Vehicle + status + actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Car className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate text-sm font-semibold text-foreground">
            {job.vehicle || "Vehicle"}
          </span>
          <StatusPill status={job.status} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowCarInfo(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Car className="h-3 w-3" /> Car info
          </button>
          <Link
            href={`/bookings?highlight=${bookingId}`}
            className="inline-flex items-center gap-1 rounded-md border border-primary/30 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/5"
          >
            <ExternalLink className="h-3 w-3" /> Open booking
          </Link>
        </div>
      </div>

      {/* Facts grid */}
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <ContextRow icon={User} label="Customer">
          <span className="text-foreground">{job.customerName || "—"}</span>
          {job.customerEmail ? (
            <span className="text-muted-foreground"> · {job.customerEmail}</span>
          ) : null}
        </ContextRow>
        <ContextRow icon={Fingerprint} label="VIN">
          <span className="font-mono text-foreground">{job.vin || "—"}</span>
        </ContextRow>
        <ContextRow icon={Wrench} label="Services">
          <span className="text-foreground">
            {services.length ? services.join(", ") : "—"}
          </span>
        </ContextRow>
        <ContextRow icon={Hash} label="When">
          <span className="text-foreground">{when || "Not scheduled"}</span>
          {job.mechanicName ? (
            <span className="text-muted-foreground"> · {job.mechanicName}</span>
          ) : (
            <span className="text-muted-foreground"> · Unassigned</span>
          )}
        </ContextRow>
      </dl>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Booking <span className="font-mono">#{shortId}</span>
      </p>

      {showCarInfo ? (
        <CarInfoSheet
          bookingId={bookingId}
          bookingServices={services}
          onClose={() => setShowCarInfo(false)}
        />
      ) : null}
    </div>
  );
}

function ContextRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <span className="text-muted-foreground">{label}: </span>
        {children}
      </div>
    </div>
  );
}

/** The "car info sheet" — the vehicle passport in a scrollable modal. */
function CarInfoSheet({
  bookingId,
  bookingServices,
  onClose,
}: {
  bookingId: Id<"bookings">;
  bookingServices: string[];
  onClose: () => void;
}) {
  const passport = useQuery(api.bookings.getVehiclePassportForBooking, {
    bookingId,
  });

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[90] bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed left-1/2 top-1/2 z-[95] flex max-h-[85vh] w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Car className="h-4 w-4 text-primary" /> Car info
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close car info"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {passport === undefined ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <VehiclePassportSection
              data={(passport ?? null) as unknown as VehiclePassportData | null}
              bookingServices={bookingServices}
              hasPriorVisits={passport ? !passport.is_first_shop_visit : false}
              inline
            />
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
