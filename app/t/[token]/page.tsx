"use client";

import { use, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Check, MessageCircle, Bell, ClipboardList, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

type PageProps = { params: Promise<{ token: string }> };

export default function TrackerPage({ params }: PageProps) {
  const { token } = use(params);

  const data = useQuery(api.walkin_claims.getTrackerData, { token });

  const [sheetDismissed, setSheetDismissed] = useState(false);

  if (data === undefined) return <TrackerShell><TrackerLoading /></TrackerShell>;
  if (data === null) return <TrackerShell><TrackerNotFound /></TrackerShell>;
  if ("expired" in data && data.expired)
    return <TrackerShell><TrackerExpired /></TrackerShell>;

  return (
    <TrackerShell>
      <TrackerBody data={data} />
      {!sheetDismissed && (
        <InstallPromptSheet
          token={token}
          onDismiss={() => setSheetDismissed(true)}
        />
      )}
    </TrackerShell>
  );
}

/* ───────────────────────── Layout shell ───────────────────────── */

function TrackerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md px-4 pt-6 pb-40">{children}</div>
    </div>
  );
}

/* ───────────────────────── Loading / error states ───────────────────────── */

function TrackerLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-gray-400">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}

function TrackerNotFound() {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-gray-900">Link not found</h1>
      <p className="mt-2 text-sm text-gray-600">
        This tracker link is invalid. If you just visited a shop, ask them to
        resend your link.
      </p>
    </div>
  );
}

function TrackerExpired() {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-gray-900">Link expired</h1>
      <p className="mt-2 text-sm text-gray-600">
        This tracker link has expired. You can still sign up in the app with the
        same phone number the shop has on file and we&apos;ll connect your
        history.
      </p>
    </div>
  );
}

/* ───────────────────────── Main body ───────────────────────── */

type TimelineEntry = {
  key: string;
  label: string;
  atMs: number | null;
  reached: boolean;
};

type TrackerData = {
  alreadyClaimed: boolean;
  shopName: string | null;
  firstName: string | null;
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    trim: string | null;
    plateLast4: string | null;
  };
  primaryService: string | null;
  estimatedReadyIso: string | null;
  mechanic:
    | { displayName: string; aseCertified: boolean; yearsAtShop: number | null }
    | null;
  displayStatus: string;
  timeline: TimelineEntry[];
};

function TrackerBody({ data }: { data: TrackerData }) {
  const vehicleTitle = useMemo(() => {
    const first = data.firstName ? `${data.firstName}'s ` : "";
    const y = data.vehicle.year ?? "";
    const mk = data.vehicle.make ?? "";
    const md = data.vehicle.model ?? "";
    const label = [y, mk, md].filter(Boolean).join(" ");
    return `${first}${label || "Vehicle"}`.trim();
  }, [data.firstName, data.vehicle]);

  const subtitle = useMemo(() => {
    const parts: string[] = [];
    if (data.vehicle.plateLast4) parts.push(`Plate ··· ${data.vehicle.plateLast4}`);
    if (data.primaryService) parts.push(data.primaryService);
    return parts.join(" · ");
  }, [data.vehicle.plateLast4, data.primaryService]);

  const eta = useMemo(() => formatEta(data.estimatedReadyIso), [data.estimatedReadyIso]);

  return (
    <div className="space-y-4">
      {/* Shop + status card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              {data.shopName ?? "Your shop"}
            </div>
            <h1 className="mt-1 text-xl font-bold text-gray-900">
              {vehicleTitle}
            </h1>
            {subtitle && (
              <div className="mt-1 text-sm text-gray-600">{subtitle}</div>
            )}
          </div>
          <StatusPill status={data.displayStatus} />
        </div>

        {eta && (
          <div className="mt-4 rounded-xl bg-blue-50 px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">
              Estimated ready
            </div>
            <div className="mt-0.5 text-lg font-bold text-blue-700">{eta}</div>
          </div>
        )}
      </div>

      {/* Progress timeline card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Progress
        </div>
        <ol className="mt-4 space-y-4">
          {data.timeline.map((step, idx) => {
            const isLast = idx === data.timeline.length - 1;
            const nextReached = data.timeline[idx + 1]?.reached;
            const isCurrent = step.reached && !nextReached && !isLast;
            return (
              <li key={step.key} className="relative flex gap-3">
                {!isLast && (
                  <div
                    className={cn(
                      "absolute left-[10px] top-6 h-full w-0.5",
                      step.reached && data.timeline[idx + 1]?.reached
                        ? "bg-emerald-500"
                        : "bg-gray-200",
                    )}
                  />
                )}
                <div
                  className={cn(
                    "relative z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-4 ring-white",
                    step.reached
                      ? isCurrent
                        ? "bg-primary text-white"
                        : "bg-emerald-500 text-white"
                      : "border-2 border-gray-200 bg-white",
                  )}
                >
                  {step.reached &&
                    (isCurrent ? (
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    ) : (
                      <Check className="h-3 w-3" strokeWidth={3} />
                    ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "text-sm font-semibold",
                      step.reached ? "text-gray-900" : "text-gray-400",
                    )}
                  >
                    {step.label}
                  </div>
                  <div
                    className={cn(
                      "text-xs",
                      step.atMs
                        ? "text-gray-500"
                        : step.reached
                          ? "text-gray-400"
                          : "text-gray-300",
                    )}
                  >
                    {step.atMs ? formatTime(step.atMs) : "—"}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Mechanic card */}
      {data.mechanic && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-bold text-blue-700">
              {data.mechanic.displayName
                .split(" ")
                .map((s) => s[0])
                .join("")
                .slice(0, 2)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-gray-900">
                {data.mechanic.displayName} is working on it
              </div>
              <div className="text-xs text-gray-500">
                {[
                  data.mechanic.aseCertified ? "ASE-certified" : null,
                  data.mechanic.yearsAtShop
                    ? `${data.mechanic.yearsAtShop} years at this shop`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Locked disclaimer */}
      <div className="flex items-start gap-2.5 rounded-xl bg-blue-50/60 px-4 py-3">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-700" />
        <div className="text-[12px] leading-relaxed text-gray-700">
          Messages, invoices and service records unlock once you verify
          it&apos;s you.
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    SCHEDULED: "bg-gray-100 text-gray-700",
    "CHECKED IN": "bg-blue-100 text-blue-700",
    "IN SERVICE": "bg-primary/15 text-primary",
    READY: "bg-emerald-100 text-emerald-700",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider",
        map[status] ?? "bg-gray-100 text-gray-700",
      )}
    >
      {status}
    </span>
  );
}

/* ───────────────────────── B2: Get the full experience sheet ───────────────────────── */

function InstallPromptSheet({
  token,
  onDismiss,
}: {
  token: string;
  onDismiss: () => void;
}) {
  const deepLink = `otopair://claim/${token}`;
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStart = useRef<{ y: number } | null>(null);

  // Swipe threshold — how many px of drag before a state change fires.
  const SWIPE_THRESHOLD = 40;

  function handlePointerDown(e: React.PointerEvent) {
    dragStart.current = { y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const dy = e.clientY - dragStart.current.y;
    // Damp upward drag when already expanded so it feels resistant, not glued.
    if (expanded) {
      setDragOffset(dy > 0 ? dy : dy * 0.2);
    } else {
      // Peek: allow downward (dismiss) freely; damp upward (already collapsed).
      setDragOffset(dy < 0 ? dy * 0.2 : dy);
    }
  }
  function handlePointerUp() {
    const dy = dragOffset;
    dragStart.current = null;
    setDragOffset(0);
    if (expanded) {
      if (dy > SWIPE_THRESHOLD) setExpanded(false);
    } else {
      if (dy < -SWIPE_THRESHOLD) setExpanded(true);
      else if (dy > SWIPE_THRESHOLD * 2) onDismiss();
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 pointer-events-none">
      <div className="mx-auto max-w-md pointer-events-auto">
        <div
          style={{
            transform: `translateY(${dragOffset}px)`,
            transition: dragStart.current ? "none" : "transform 200ms ease-out",
          }}
          className="rounded-t-3xl border-t border-x border-gray-200 bg-white px-6 pb-5 pt-2 shadow-[0_-8px_24px_-4px_rgba(0,0,0,0.08)]"
        >
          {/* Grab handle — tap to toggle, drag to swipe */}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="flex w-full cursor-grab touch-none flex-col items-center py-2 active:cursor-grabbing"
          >
            <div className="h-1 w-10 rounded-full bg-gray-300" />
          </button>

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-gray-900">
                Get the full experience
              </h2>
              {expanded && (
                <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
                  Keep tracking right here, or open the app for the rest.
                </p>
              )}
            </div>
          </div>

          {/* Bullets — expanded state only */}
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-200 ease-out",
              expanded ? "mt-3 grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <ul className="min-h-0 space-y-3 overflow-hidden">
              <SheetBullet
                icon={<MessageCircle className="h-4 w-4" />}
                label="Message the shop directly"
              />
              <SheetBullet
                icon={<Bell className="h-4 w-4" />}
                label="Get pinged the second it's ready"
              />
              <SheetBullet
                icon={<ClipboardList className="h-4 w-4" />}
                label="Every service record, kept for this car"
              />
            </ul>
          </div>

          <a
            href={deepLink}
            className="mt-3 flex w-full items-center justify-center rounded-2xl bg-primary py-3 text-sm font-bold text-white shadow-[0_2px_6px_-1px_rgba(82,153,254,0.35)] hover:opacity-95 transition-opacity"
          >
            Open the Otopair app
          </a>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-1 w-full py-1.5 text-center text-[13px] font-medium text-primary hover:opacity-80"
          >
            Keep tracking in the browser
          </button>
        </div>
      </div>
    </div>
  );
}

function SheetBullet({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
        {icon}
      </span>
      <span className="text-sm font-medium text-gray-900">{label}</span>
    </li>
  );
}

/* ───────────────────────── formatters ───────────────────────── */

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatEta(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (sameDay) return `Today by ~${time}`;
  const dateLabel = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${dateLabel} by ~${time}`;
}
