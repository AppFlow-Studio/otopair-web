"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Clock } from "lucide-react";

/**
 * Booking-detail-panel overrun indicator for shop owners / front desk.
 *
 * Only "On track" is offered here — extensions require the mechanic to use
 * their dashboard where the bay-free toggle is captured. Without that signal
 * we can't know whether to cascade downstream customers, so the extension
 * button was intentionally removed. If the mechanic is unreachable, the
 * system auto-applies the default extension after auto_apply_at_ms.
 */
export default function OverrunCheckInCard({
  bookingId,
}: {
  bookingId: Id<"bookings">;
}) {
  const checkin = useQuery((api as any).bookings.getActiveOverrunCheckinForBooking, {
    bookingId,
  });
  const answer = useMutation((api as any).bookings.answerOverrunCheckIn);

  if (!checkin) return null;
  if (checkin.status !== "mechanic_prompted" && checkin.status !== "awaiting_extension") {
    return null;
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 my-2">
      <Clock className="h-4 w-4 mt-0.5 text-orange-700 shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-orange-900">Overrun check-in pending</p>
        <p className="mt-0.5 text-xs text-orange-700">
          The mechanic has been prompted. If they need more time, they&apos;ll extend
          from their dashboard — or the system will auto-apply at{" "}
          {new Date(checkin.auto_apply_at_ms).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })}
          .
        </p>
        <div className="mt-2">
          <button
            className="rounded-md bg-orange-600 px-3 py-1 text-sm font-medium text-white hover:bg-orange-700"
            onClick={() => answer({ bookingId, isComplete: true })}
          >
            Mark on track
          </button>
        </div>
      </div>
    </div>
  );
}
