"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AlertTriangle, Clock, Car, User as UserIcon } from "lucide-react";

const CUSTOMER_LATE_CATEGORY = "customer_late_push_reminder";
const RESOLUTION_CATEGORY = "overrun_customer_resolution";

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function HandlePill({ handle }: { handle: string | null }) {
  if (!handle) return null;
  return (
    <span className="shrink-0 rounded border border-current/30 bg-white/80 px-1.5 py-0.5 font-mono text-xs font-bold leading-none">
      {handle}
    </span>
  );
}

function MetaLine({
  customerName,
  vehicleLabel,
  scheduledTime,
}: {
  customerName: string | null;
  vehicleLabel: string | null;
  scheduledTime: string | null;
}) {
  const time = formatTime12h(scheduledTime);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs mt-1 opacity-90">
      {customerName && (
        <span className="inline-flex items-center gap-1">
          <UserIcon className="h-3 w-3" />
          {customerName}
        </span>
      )}
      {vehicleLabel && (
        <span className="inline-flex items-center gap-1">
          <Car className="h-3 w-3" />
          {vehicleLabel}
        </span>
      )}
      {time && <span>· Booked for {time}</span>}
    </div>
  );
}

export default function CustomerSchedulingAlerts() {
  const notifications = useQuery(api.notifications.getMyNotifications, {}) as
    | Array<any>
    | undefined;
  const acknowledgeLate = useMutation((api as any).bookings.acknowledgeCustomerLate);
  const markRead = useMutation(api.notifications.markNotificationRead);

  const lateRow = useMemo(
    () => notifications?.find((n) => n.category === CUSTOMER_LATE_CATEGORY) ?? null,
    [notifications],
  );
  const resolutionRow = useMemo(
    () => notifications?.find((n) => n.category === RESOLUTION_CATEGORY) ?? null,
    [notifications],
  );

  if (!lateRow && !resolutionRow) return null;

  return (
    <div className="flex flex-col gap-2 mb-4">
      {lateRow && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <Clock className="h-5 w-5 mt-0.5 text-amber-700 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-amber-900">
                {lateRow.shopName
                  ? `${lateRow.shopName} is waiting`
                  : "Shop is waiting"}{" "}
                — booking at {formatTime12h(lateRow.scheduledTime) || "the scheduled time"} hasn't checked in yet.
              </p>
              <HandlePill handle={lateRow.shortHandle} />
            </div>
            <MetaLine
              customerName={lateRow.customerName}
              vehicleLabel={lateRow.vehicleLabel}
              scheduledTime={null}
            />
            <p className="text-sm text-amber-800 mt-1">
              Tap below to confirm en-route or reschedule.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
                onClick={async () => {
                  if (!lateRow.booking_id) return;
                  await acknowledgeLate({ bookingId: lateRow.booking_id });
                  await markRead({ notificationId: lateRow._id });
                }}
              >
                On my way
              </button>
              {lateRow.booking_id && (
                <Link
                  href={`/my-bookings?highlight=${lateRow.booking_id}&action=reschedule`}
                  className="rounded-md border border-amber-600 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
                >
                  Reschedule
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {resolutionRow && (
        <div className="flex items-start gap-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3">
          <AlertTriangle className="h-5 w-5 mt-0.5 text-blue-700 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-blue-900">
                {resolutionRow.payload?.newEndTime
                  ? `Booking now estimated to finish around ${formatTime12h(
                      resolutionRow.payload.newEndTime,
                    )}`
                  : `Booking is running ~${
                      resolutionRow.payload?.extensionMinutes ?? 15
                    } min behind`}
              </p>
              <HandlePill handle={resolutionRow.shortHandle} />
            </div>
            <MetaLine
              customerName={resolutionRow.customerName}
              vehicleLabel={resolutionRow.vehicleLabel}
              scheduledTime={resolutionRow.scheduledTime}
            />
            <p className="text-sm text-blue-800 mt-1">
              {resolutionRow.shopName
                ? `${resolutionRow.shopName} pushed the slot forward.`
                : "Shop pushed the slot forward."}{" "}
              Tap reschedule if the new time doesn't work.
            </p>
            <div className="mt-2 flex gap-2">
              {resolutionRow.booking_id && (
                <Link
                  href={`/my-bookings?highlight=${resolutionRow.booking_id}&action=reschedule`}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Reschedule
                </Link>
              )}
              <button
                className="rounded-md border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100"
                onClick={() => markRead({ notificationId: resolutionRow._id })}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
