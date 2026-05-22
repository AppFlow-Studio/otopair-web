"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { LiveAlert } from "./use-live-alerts";

const ACCENT_TEXT: Record<LiveAlert["accent"], string> = {
  emerald: "text-emerald-600",
  yellow: "text-yellow-700",
  orange: "text-orange-600",
  cyan: "text-cyan-700",
  red: "text-red-600",
  amber: "text-amber-700",
};

function formatTime12h(time: string | null | undefined): string {
  if (!time) return "";
  const [hStr, mStr] = time.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface LiveAlertCardProps {
  alert: LiveAlert;
  onAfterAction?: () => void;
}

export function LiveAlertCard({ alert, onAfterAction }: LiveAlertCardProps) {
  const router = useRouter();
  const markVehicleAtShop = useMutation(api.bookings.markVehicleAtShop);
  const markNoShow = useMutation(api.bookings.markPostThresholdNoShow);
  const answerOverrunExtension = useMutation(api.bookings.answerOverrunExtension);
  const dismissManualSchedulingAlert = useMutation(
    api.bookings.dismissManualSchedulingAlert,
  );

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run<T>(fn: () => Promise<T>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await fn();
      onAfterAction?.();
    } catch (e: any) {
      setError(e?.message ?? "Could not complete that action.");
      setPending(false);
    }
  }

  function navigate(href: string) {
    onAfterAction?.();
    router.push(href);
  }

  const time = formatTime12h(alert.scheduledTime);
  const metaLine =
    [alert.vehicleLabel, alert.serviceSummary, alert.mechanicName, time]
      .filter(Boolean)
      .join(" · ") || null;

  return (
    <li className="relative px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold uppercase tracking-wide ${ACCENT_TEXT[alert.accent]}`}>
            {alert.headerLabel}
          </span>
          {alert.shortHandle && (
            <span className="rounded border border-gray-300 bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-gray-800">
              {alert.shortHandle}
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-gray-400">
          {relativeTime(alert.timestamp)}
        </span>
      </div>

      {alert.customerName && (
        <p className="mt-1 text-sm font-medium text-gray-900">
          {alert.customerName}
          {alert.kind === "on_my_way" && alert.minutesLate != null && (
            <span className="ml-2 text-xs font-normal text-emerald-700">
              · {alert.minutesLate}m late · said &quot;on my way&quot;
            </span>
          )}
          {alert.kind === "no_show_decision" && alert.minutesLate != null && (
            <span className="ml-2 text-xs font-normal text-orange-600">
              · {alert.minutesLate}m late
            </span>
          )}
          {alert.kind === "late_notification_sent" && alert.notifiedVia && (
            <span className="ml-2 text-xs font-normal text-yellow-700">
              · notified via {alert.notifiedVia}
            </span>
          )}
        </p>
      )}

      {metaLine && (
        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{metaLine}</p>
      )}

      {alert.reason && alert.kind === "manual_scheduling" && (
        <p className="mt-1 text-xs italic text-gray-500 line-clamp-2">
          {alert.reason}
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {alert.kind === "on_my_way" && alert.bookingId && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(() =>
                markVehicleAtShop({ bookingId: alert.bookingId as Id<"bookings"> }),
              )
            }
            className="inline-flex items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Vehicle here
          </button>
        )}

        {alert.kind === "late_notification_sent" && alert.bookingId && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run(() =>
                markVehicleAtShop({ bookingId: alert.bookingId as Id<"bookings"> }),
              )
            }
            className="inline-flex items-center rounded-md bg-yellow-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-yellow-700 disabled:opacity-50"
          >
            Vehicle here
          </button>
        )}

        {alert.kind === "no_show_decision" && alert.bookingId && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() =>
                  markVehicleAtShop({
                    bookingId: alert.bookingId as Id<"bookings">,
                  }),
                )
              }
              className="inline-flex items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Vehicle here
            </button>
            <button
              type="button"
              onClick={() =>
                navigate(
                  `/schedule?action=reschedule-no-show&bookingId=${alert.bookingId}${
                    alert.scheduledDate ? `&date=${alert.scheduledDate}` : ""
                  }${alert.scheduledTime ? `&time=${alert.scheduledTime}` : ""}${
                    alert.mechanicId ? `&mechanicId=${alert.mechanicId}` : ""
                  }`,
                )
              }
              className="inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Reschedule
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() =>
                  markNoShow({ bookingId: alert.bookingId as Id<"bookings"> }),
                )
              }
              className="inline-flex items-center rounded-md border border-orange-300 bg-white px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-50"
            >
              Mark no-show
            </button>
          </>
        )}

        {alert.kind === "overrun" && alert.bookingId && (
          <>
            {[15, 30, 45, 60].map((mins) => (
              <button
                key={mins}
                type="button"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    answerOverrunExtension({
                      bookingId: alert.bookingId as Id<"bookings">,
                      extensionMinutes: mins,
                    }),
                  )
                }
                className="inline-flex items-center rounded-md border border-cyan-300 bg-white px-2.5 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-50 disabled:opacity-50"
              >
                +{mins}m
              </button>
            ))}
          </>
        )}

        {alert.kind === "manual_scheduling" && (
          <>
            {alert.bookingId && (
              <button
                type="button"
                onClick={() =>
                  navigate(
                    `/schedule?action=focus-booking&bookingId=${alert.bookingId}${
                      alert.scheduledDate ? `&date=${alert.scheduledDate}` : ""
                    }`,
                  )
                }
                className="inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
              >
                Reschedule
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() =>
                  dismissManualSchedulingAlert({
                    alertId: alert.id as Id<"notification_outbox">,
                  }),
                )
              }
              className="inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Dismiss
            </button>
          </>
        )}

        {alert.kind === "late_start" && alert.reviewId && (
          <button
            type="button"
            onClick={() =>
              navigate(
                `/schedule?action=review-late-start&reviewId=${alert.reviewId}`,
              )
            }
            className="inline-flex items-center rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
          >
            Review
          </button>
        )}
      </div>
    </li>
  );
}
