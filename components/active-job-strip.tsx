"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { ChevronDown, Maximize2, Wrench } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ElapsedTimer from "./mechanic/elapsed-timer";
import NowWorkingOverlay from "./mechanic/now-working-overlay";
import OverrunExtendCard from "./mechanic/overrun-extend-card";

function shortBookingCode(id: string) {
  return `BKG-${id.slice(-4).toUpperCase()}`;
}

/**
 * Compact active-job indicator that lives in the portal header (just right of
 * the notification bell). Renders nothing when there's no active work. The
 * owner/front-desk view is a single click-through pill; the mechanic view is a
 * pill that opens a popover holding the live timer, the full-screen overlay
 * launcher, and the overrun-extension card.
 */
export default function ActiveJobStrip() {
  const header = useQuery(api.bookings.getActiveJobsForHeader);
  const router = useRouter();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Owner full-screen overlay: panes the viewer has dismissed this session.
  const [dismissedPanes, setDismissedPanes] = useState<string[]>([]);

  // Mechanic view only: surface an overrun check-in awaiting a response so the
  // pill can flag it even before the popover is opened.
  const mechanicBookingId =
    header && header.kind === "mechanic" && header.job
      ? (header.job.bookingId as Id<"bookings">)
      : null;
  const overrunCheckin = useQuery(
    api.bookings.getActiveOverrunCheckinForBooking,
    mechanicBookingId ? { bookingId: mechanicBookingId } : "skip",
  );
  const needsOverrunAttention =
    !!overrunCheckin &&
    (overrunCheckin.status === "mechanic_prompted" ||
      overrunCheckin.status === "awaiting_extension" ||
      overrunCheckin.status === "front_desk_escalated");

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!header) return null;

  /* ---------------------------------------------------------------- */
  /*  Mechanic — pill + popover                                        */
  /* ---------------------------------------------------------------- */
  if (header.kind === "mechanic") {
    if (!header.job) return null;
    const job = header.job;
    const bookingId = job.bookingId as Id<"bookings">;

    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setPopoverOpen((o) => !o)}
          className={`group inline-flex h-9 items-center gap-2.5 rounded-full border bg-[linear-gradient(135deg,_#0f172a,_#0b1220)] pl-2.5 pr-3 text-slate-50 shadow-sm transition-all hover:shadow ${
            needsOverrunAttention
              ? "border-amber-400/60 ring-1 ring-amber-400/40"
              : "border-emerald-400/30 hover:border-emerald-400/60"
          }`}
        >
          <span
            className={`inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full ${
              needsOverrunAttention ? "bg-amber-400" : "bg-emerald-400"
            }`}
          />
          <span className="hidden text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/80 sm:inline">
            Now working
          </span>
          <ElapsedTimer
            startedAtMs={job.startedAtMs}
            className="font-mono text-sm font-semibold tabular-nums text-white"
          />
          {needsOverrunAttention ? (
            <span className="rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
              Action
            </span>
          ) : null}
          <ChevronDown
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
              popoverOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {popoverOpen ? (
          <>
            {/* Click-away backdrop */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setPopoverOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div className="absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-emerald-400/30 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_60%),linear-gradient(180deg,_#0f172a,_#0b1220)] p-4 text-slate-50 shadow-xl">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                    <Wrench className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
                      Now working
                    </p>
                    <p className="truncate text-sm font-medium text-slate-100">
                      {job.vehicleLabel}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-slate-400">
                  {shortBookingCode(String(bookingId))}
                </span>
              </div>

              {job.serviceSummary ? (
                <p className="mt-2 truncate text-xs text-slate-400">
                  {job.serviceSummary}
                </p>
              ) : null}

              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2">
                <ElapsedTimer
                  startedAtMs={job.startedAtMs}
                  className="font-mono text-lg font-semibold tabular-nums text-white"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPopoverOpen(false);
                    setOverlayOpen(true);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-400"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  Open
                </button>
              </div>

              {/* Overrun extension — only renders when a check-in is active */}
              <div className="mt-3 [&:empty]:mt-0">
                <OverrunExtendCard
                  bookingId={bookingId}
                  onFinishEarly={() =>
                    router.push(`/dashboard?postjob=${String(bookingId)}`)
                  }
                  onToast={setToast}
                  variant="dark"
                />
              </div>

              {toast ? (
                <p className="mt-2 text-xs text-emerald-300">{toast}</p>
              ) : null}
            </div>
          </>
        ) : null}

        <NowWorkingOverlay
          bookingIds={overlayOpen ? [bookingId] : []}
          onClose={() => setOverlayOpen(false)}
          onClosePane={() => setOverlayOpen(false)}
          onMarkComplete={(id) => {
            setOverlayOpen(false);
            router.push(`/dashboard?postjob=${String(id)}`);
          }}
        />
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Owner / front-desk — pill expands every active job full-screen   */
  /* ---------------------------------------------------------------- */
  if (header.count === 0) return null;

  const activeBookingIds = (header.activeBookingIds ?? []) as Id<"bookings">[];
  const visibleOverlayIds = activeBookingIds.filter(
    (id) => !dismissedPanes.includes(String(id)),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDismissedPanes([]);
          setOverlayOpen(true);
        }}
        title="One or more mechanics are mid-job — open full screen"
        className="group inline-flex h-9 items-center gap-2.5 rounded-full border border-emerald-400/30 bg-[linear-gradient(135deg,_#0f172a,_#0b1220)] pl-2 pr-2.5 text-slate-50 shadow-sm transition-all hover:border-emerald-400/60 hover:shadow"
      >
        <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
          <Wrench className="h-3.5 w-3.5" />
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400 ring-2 ring-[#0b1220]" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-200/90">
          Active job{header.count > 1 ? "s" : ""}
        </span>
        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-bold tabular-nums text-emerald-950">
          {header.count}
        </span>
        <span className="hidden items-center gap-1 text-[11px] font-medium text-slate-300 sm:inline-flex">
          <span className="mx-0.5 h-3 w-px bg-white/15" />
          View
          <Maximize2 className="h-3 w-3 text-emerald-300/80 transition-transform group-hover:translate-x-0.5" />
        </span>
      </button>

      <NowWorkingOverlay
        bookingIds={overlayOpen ? visibleOverlayIds : []}
        onClose={() => setOverlayOpen(false)}
        onClosePane={(id) => {
          const remaining = visibleOverlayIds.filter(
            (v) => String(v) !== String(id),
          );
          if (remaining.length === 0) {
            setOverlayOpen(false);
          } else {
            setDismissedPanes((prev) => [...prev, String(id)]);
          }
        }}
        onMarkComplete={(id) => {
          setOverlayOpen(false);
          router.push(`/dashboard?postjob=${String(id)}`);
        }}
      />
    </>
  );
}
