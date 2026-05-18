"use client";

import { useQuery } from "convex/react";
import { Maximize2, Wrench } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ElapsedTimer from "./elapsed-timer";

function shortBookingCode(id: string) {
  return `BKG-${id.slice(-4).toUpperCase()}`;
}

export default function NowWorkingBanner({
  bookingId,
  onExpand,
}: {
  bookingId: Id<"bookings">;
  onExpand: () => void;
}) {
  const job = useQuery(api.bookings.getJobDetail, { bookingId });
  const startedAt = job?.jobActuals?.startedAt ?? null;

  return (
    <section
      className="overflow-hidden rounded-2xl border border-emerald-400/30 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_60%),linear-gradient(180deg,_#0f172a,_#0b1220)] p-5 text-slate-50 shadow-[0_10px_30px_rgba(15,23,42,0.18)]"
      aria-label="Currently active job"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300">
            <Wrench className="h-4 w-4" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-300/80">
                Now working
              </p>
              <span className="text-xs text-slate-400">
                {shortBookingCode(String(bookingId))}
              </span>
            </div>
            <p className="mt-1 text-base font-semibold text-slate-100">
              {job?.vehicle ?? "Loading vehicle..."}
            </p>
            {job?.serviceNames && job.serviceNames.length > 0 ? (
              <p className="text-sm text-slate-400">
                {job.serviceNames.join(" · ")}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">
              Elapsed
            </p>
            <ElapsedTimer
              startedAtMs={startedAt}
              className="font-mono text-2xl font-semibold tabular-nums text-white"
            />
          </div>
          <button
            type="button"
            onClick={onExpand}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
          >
            <Maximize2 className="h-4 w-4" />
            Expand
          </button>
        </div>
      </div>
    </section>
  );
}
