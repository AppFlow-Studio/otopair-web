"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";
import { AlertOctagon, Car, ChevronDown, User as UserIcon } from "lucide-react";

interface Alert {
  _id: Id<"notification_outbox">;
  bookingId: Id<"bookings"> | null;
  createdAt?: number;
  reason: string;
  source: string;
  customerName: string | null;
  scheduledTime: string | null;
  scheduledDate: string | null;
  vehicleLabel: string | null;
  shortHandle: string | null;
}

interface Props {
  onOpenBooking?: (
    bookingId: Id<"bookings">,
    info: { scheduledDate: string | null; scheduledTime: string | null },
  ) => void;
}

function formatTime12h(hhmm: string | null): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function ManualSchedulingAlertsBanner({ onOpenBooking }: Props) {
  const alerts = useQuery((api as any).bookings.getOpenManualSchedulingAlerts, {}) as
    | Alert[]
    | undefined;
  const dismiss = useMutation((api as any).bookings.dismissManualSchedulingAlert);
  const [expanded, setExpanded] = useState(true);

  if (!alerts || alerts.length === 0) return null;

  return (
    <div className="mb-3 rounded-md border border-orange-300 bg-orange-50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-orange-800"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <AlertOctagon className="h-4 w-4" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            Manual scheduling alerts
          </span>
          <span className="rounded-full bg-orange-700 px-2 py-0.5 text-[10px] font-semibold text-white leading-none">
            {alerts.length}
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      <div className={`flex flex-col gap-2 px-2 pb-2 ${expanded ? "" : "hidden"}`}>
      {alerts.map((a) => {
        const time = formatTime12h(a.scheduledTime);
        return (
          <div
            key={String(a._id)}
            className="flex items-start gap-3 rounded-md border border-orange-300 bg-orange-50 px-3 py-2.5"
          >
            <AlertOctagon className="h-5 w-5 mt-0.5 text-orange-700 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-orange-900">
                  Booking
                </span>
                {a.shortHandle && (
                  <span className="rounded border border-orange-600 bg-white px-1.5 py-0.5 font-mono text-xs font-bold text-orange-900 leading-none">
                    {a.shortHandle}
                  </span>
                )}
                {time && (
                  <span className="font-semibold text-orange-900">
                    at {time}
                  </span>
                )}
                <span className="text-orange-800">needs manual rescheduling.</span>
              </div>
              {(a.customerName || a.vehicleLabel) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mt-1 text-orange-800">
                  {a.customerName && (
                    <span className="inline-flex items-center gap-1">
                      <UserIcon className="h-3.5 w-3.5" />
                      {a.customerName}
                    </span>
                  )}
                  {a.vehicleLabel && (
                    <span className="inline-flex items-center gap-1">
                      <Car className="h-3.5 w-3.5" />
                      {a.vehicleLabel}
                    </span>
                  )}
                </div>
              )}
              {a.reason && (
                <p className="mt-1 text-xs text-orange-700/90 italic">
                  {a.reason}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0 self-center">
              {a.bookingId && onOpenBooking && (
                <button
                  className="rounded-md border border-orange-600 px-2.5 py-1 text-xs font-medium text-orange-800 hover:bg-orange-100"
                  onClick={() =>
                    a.bookingId &&
                    onOpenBooking(a.bookingId, {
                      scheduledDate: a.scheduledDate,
                      scheduledTime: a.scheduledTime,
                    })
                  }
                >
                  Open
                </button>
              )}
              <button
                className="text-xs text-orange-700 hover:text-orange-900 px-2"
                onClick={() => dismiss({ alertId: a._id })}
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
