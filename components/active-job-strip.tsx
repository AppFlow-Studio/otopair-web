"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { Maximize2, Wrench } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ElapsedTimer from "./mechanic/elapsed-timer";
import NowWorkingOverlay from "./mechanic/now-working-overlay";

function shortBookingCode(id: string) {
  return `BKG-${id.slice(-4).toUpperCase()}`;
}

export default function ActiveJobStrip() {
  const header = useQuery(api.bookings.getActiveJobsForHeader);
  const router = useRouter();
  const [overlayOpen, setOverlayOpen] = useState(false);

  if (!header) return null;

  if (header.kind === "mechanic") {
    if (!header.job) return null;
    const bookingId = header.job.bookingId as Id<"bookings">;
    return (
      <>
        <div className="mb-3 overflow-hidden rounded-xl border border-emerald-400/30 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_60%),linear-gradient(180deg,_#0f172a,_#0b1220)] px-4 py-2.5 text-slate-50 shadow-[0_4px_14px_rgba(15,23,42,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                <Wrench className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
                  Now working
                </p>
                <span className="text-xs text-slate-400">
                  {shortBookingCode(String(bookingId))}
                </span>
                <span className="truncate text-sm font-medium text-slate-100">
                  {header.job.vehicleLabel}
                </span>
                {header.job.serviceSummary ? (
                  <span className="hidden truncate text-xs text-slate-400 md:inline">
                    · {header.job.serviceSummary}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ElapsedTimer
                startedAtMs={header.job.startedAtMs}
                className="font-mono text-base font-semibold tabular-nums text-white"
              />
              <button
                type="button"
                onClick={() => setOverlayOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
              >
                <Maximize2 className="h-3.5 w-3.5" />
                Open
              </button>
            </div>
          </div>
        </div>

        <NowWorkingOverlay
          bookingIds={overlayOpen ? [bookingId] : []}
          onClose={() => setOverlayOpen(false)}
          onClosePane={() => setOverlayOpen(false)}
          onMarkComplete={(id) => {
            setOverlayOpen(false);
            router.push(`/dashboard?postjob=${String(id)}`);
          }}
        />
      </>
    );
  }

  // Owner / front-desk view
  if (header.count === 0) return null;

  return (
    <button
      type="button"
      onClick={() => router.push("/dashboard#active-jobs")}
      className="mb-3 flex w-full items-center justify-between gap-3 overflow-hidden rounded-xl border border-emerald-400/30 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_60%),linear-gradient(180deg,_#0f172a,_#0b1220)] px-4 py-2.5 text-left text-slate-50 shadow-[0_4px_14px_rgba(15,23,42,0.12)] transition-colors hover:border-emerald-400/50"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
          <Wrench className="h-4 w-4" />
        </span>
        <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
          Active jobs · {header.count}
        </p>
        <span className="hidden text-xs text-slate-400 md:inline">
          One or more mechanics are mid-job
        </span>
      </div>
      <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950">
        View
        <Maximize2 className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}
