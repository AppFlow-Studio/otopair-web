"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { UserX, Car, ChevronDown, User as UserIcon } from "lucide-react";

function formatTime12h(hhmm: string | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function NoShowNotificationBanner() {
  const rows = useQuery((api as any).bookings.getRecentNoShows, {}) as
    | Array<{
        bookingId: string;
        customerName: string;
        vehicleLabel: string | null;
        shortHandle: string;
        scheduledTime?: string;
        scheduledDate?: string;
        markedAtMs: number;
      }>
    | undefined;
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState(true);

  const visible = (rows ?? []).filter((r) => !dismissed[r.bookingId]);
  if (visible.length === 0) return null;

  return (
    <div className="mb-3 rounded-md border border-slate-300 bg-slate-50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-slate-700"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <UserX className="h-4 w-4" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            Recent no-shows
          </span>
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-[10px] font-semibold text-white leading-none">
            {visible.length}
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      <div className={`flex flex-col gap-2 px-2 pb-2 ${expanded ? "" : "hidden"}`}>
      {visible.map((r) => {
        const time = formatTime12h(r.scheduledTime);
        return (
          <div
            key={r.bookingId}
            className="flex items-start gap-3 rounded-md border border-slate-300 bg-slate-50 px-3 py-2.5"
          >
            <UserX className="h-4 w-4 mt-0.5 text-slate-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="inline-flex items-center rounded-md bg-slate-200 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-800 border border-slate-300">
                  {r.shortHandle}
                </span>
                <span className="inline-flex items-center gap-1 text-slate-800 font-medium">
                  <UserIcon className="h-3.5 w-3.5" />
                  {r.customerName}
                </span>
                {r.vehicleLabel && (
                  <span className="inline-flex items-center gap-1 text-slate-700">
                    <Car className="h-3.5 w-3.5" />
                    {r.vehicleLabel}
                  </span>
                )}
                {time && <span className="text-slate-600">· {time}</span>}
              </div>
              <p className="mt-1 text-xs text-slate-700">No-showed.</p>
            </div>
            <button
              className="text-xs text-slate-500 hover:text-slate-800 self-center"
              onClick={() => setDismissed((p) => ({ ...p, [r.bookingId]: true }))}
            >
              Dismiss
            </button>
          </div>
        );
      })}
      </div>
    </div>
  );
}
