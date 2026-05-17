"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AlertTriangle, Clock } from "lucide-react";

const CUSTOMER_LATE_CATEGORY = "customer_late_push_reminder";
const RESOLUTION_CATEGORY = "overrun_customer_resolution";

export default function CustomerSchedulingAlerts() {
  const notifications = useQuery(api.notifications.getMyNotifications, {});
  const acknowledgeLate = useMutation((api as any).bookings.acknowledgeCustomerLate);
  const markRead = useMutation(api.notifications.markNotificationRead);

  const lateRow = useMemo(() => {
    if (!Array.isArray(notifications)) return null;
    return notifications.find((n: any) => n.category === CUSTOMER_LATE_CATEGORY) ?? null;
  }, [notifications]);

  const resolutionRow = useMemo(() => {
    if (!Array.isArray(notifications)) return null;
    return notifications.find((n: any) => n.category === RESOLUTION_CATEGORY) ?? null;
  }, [notifications]);

  if (!lateRow && !resolutionRow) return null;

  return (
    <div className="flex flex-col gap-2 mb-4">
      {lateRow && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <Clock className="h-5 w-5 mt-0.5 text-amber-700 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-900">Running late?</p>
            <p className="text-sm text-amber-800">
              Your appointment at {lateRow.payload?.scheduledTime ?? "the scheduled time"} is starting.
              Let the shop know if you're on your way or need to reschedule.
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
          <div className="flex-1">
            <p className="text-sm font-medium text-blue-900">Your appointment is running ~{resolutionRow.payload?.extensionMinutes ?? 15} min late</p>
            <p className="text-sm text-blue-800">
              {resolutionRow.payload?.message ??
                "Heads up — the shop pushed your booking forward. Tap reschedule if the new time doesn't work."}
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
