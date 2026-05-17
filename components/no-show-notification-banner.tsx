"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { UserX } from "lucide-react";

export default function NoShowNotificationBanner() {
  const rows = useQuery((api as any).bookings.getRecentNoShows, {}) as
    | Array<{
        bookingId: string;
        customerName: string;
        scheduledTime?: string;
        scheduledDate?: string;
        markedAtMs: number;
      }>
    | undefined;
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  const visible = (rows ?? []).filter((r) => !dismissed[r.bookingId]);
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 mb-3">
      {visible.map((r) => (
        <div
          key={r.bookingId}
          className="flex items-start gap-3 rounded-md border border-slate-300 bg-slate-50 px-3 py-2"
        >
          <UserX className="h-4 w-4 mt-0.5 text-slate-600 shrink-0" />
          <div className="flex-1 text-sm text-slate-700">
            <span className="font-medium">{r.customerName}</span> no-showed
            {r.scheduledTime ? ` at ${r.scheduledTime}` : ""}.
          </div>
          <button
            className="text-xs text-slate-500 hover:text-slate-800"
            onClick={() => setDismissed((p) => ({ ...p, [r.bookingId]: true }))}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
