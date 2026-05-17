"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Clock } from "lucide-react";

/**
 * Inline binary check-in card for the mechanic.
 * "On track" resolves the check-in with no extension.
 * "Need more time" applies the default +15 (server default).
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
  const answerExtension = useMutation((api as any).bookings.answerOverrunExtension);

  if (!checkin) return null;
  if (checkin.status !== "mechanic_prompted" && checkin.status !== "awaiting_extension") {
    return null;
  }

  const defaultExt = checkin.default_extension_minutes ?? 15;

  return (
    <div className="flex items-start gap-3 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 my-2">
      <Clock className="h-4 w-4 mt-0.5 text-orange-700 shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-orange-900">On track to finish?</p>
        <div className="mt-2 flex gap-2">
          <button
            className="rounded-md bg-orange-600 px-3 py-1 text-sm font-medium text-white hover:bg-orange-700"
            onClick={() => answer({ bookingId, isComplete: true })}
          >
            On track
          </button>
          <button
            className="rounded-md border border-orange-600 px-3 py-1 text-sm font-medium text-orange-800 hover:bg-orange-100"
            onClick={() =>
              answerExtension({ bookingId, extensionMinutes: defaultExt })
            }
          >
            Need ~{defaultExt} min more
          </button>
        </div>
      </div>
    </div>
  );
}
