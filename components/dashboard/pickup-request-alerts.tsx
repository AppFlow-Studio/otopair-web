"use client";

/**
 * Pickup-request alerts — dashboard card that surfaces customers who tapped
 * "request pickup" in the app while their car is at the shop. Mirrors the
 * front-desk alert treatment on the /bookings page; kept as its own component
 * so the dashboard page's JSX stays lean.
 *
 * Backed by `bookings.getPendingPickupRequests` (reactive). Row actions call
 * `bookings.respondToPickupRequest` and the row updates in place via the
 * query subscription — no local state.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Car, Check, Loader2, Truck, X } from "lucide-react";
import { cn } from "@/lib/utils";

type PickupResponse = "acknowledged" | "bringing_out" | "declined";

type PickupRow = {
  _id: Id<"bookings">;
  bookingId: Id<"bookings">;
  customerName: string | null;
  vehicle: string | null;
  mechanicName: string | null;
  requestedAtMs: number;
  requestReason: string | null;
  pickupResponse: PickupResponse | null;
  pickupRespondedAtMs: number | null;
};

export default function PickupRequestAlerts({
  onOpenBooking,
}: {
  onOpenBooking?: (bookingId: Id<"bookings">) => void;
}) {
  const rows = useQuery(api.bookings.getPendingPickupRequests, {}) as
    | PickupRow[]
    | undefined;
  const respond = useMutation(api.bookings.respondToPickupRequest);
  const [pending, setPending] = useState<Record<string, PickupResponse | null>>(
    {},
  );
  const [errorByRow, setErrorByRow] = useState<Record<string, string | null>>(
    {},
  );

  if (!rows || rows.length === 0) return null;

  async function handleRespond(row: PickupRow, response: PickupResponse) {
    const key = String(row.bookingId);
    setPending((p) => ({ ...p, [key]: response }));
    setErrorByRow((e) => ({ ...e, [key]: null }));
    try {
      await respond({ bookingId: row.bookingId, response });
    } catch (e: unknown) {
      setErrorByRow((prev) => ({
        ...prev,
        [key]: e instanceof Error ? e.message : "Couldn't send the response",
      }));
    } finally {
      setPending((p) => ({ ...p, [key]: null }));
    }
  }

  return (
    <section
      aria-label="Pickup requests"
      className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
    >
      <div className="flex items-center gap-2 text-amber-800">
        <Car className="h-4 w-4" />
        <span className="text-xs font-semibold uppercase tracking-[0.2em]">
          {rows.length === 1
            ? "Pickup request"
            : `${rows.length} pickup requests`}
        </span>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {rows.map((row) => {
          const key = String(row.bookingId);
          const minutesWaiting = Math.max(
            0,
            Math.round((Date.now() - row.requestedAtMs) / 60_000),
          );
          const pendingResponse = pending[key];
          const rowError = errorByRow[key];
          const answered = row.pickupResponse != null && !pendingResponse;

          return (
            <div
              key={key}
              className="rounded-2xl border border-amber-200 bg-white/90 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    {row.customerName ?? "Customer"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[row.vehicle, row.mechanicName ? `w/ ${row.mechanicName}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="mt-1 text-xs font-medium text-amber-800">
                    Requested pickup {minutesWaiting}m ago
                  </p>
                  {row.requestReason && (
                    <p className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">
                      &ldquo;{row.requestReason}&rdquo;
                    </p>
                  )}
                  {answered && row.pickupResponse && (
                    <p className="mt-1 text-xs font-medium text-emerald-700">
                      You said: {responseLabel(row.pickupResponse)}
                    </p>
                  )}
                </div>
                {onOpenBooking && (
                  <button
                    type="button"
                    onClick={() => onOpenBooking(row.bookingId)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    Open
                  </button>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <ResponseButton
                  active={row.pickupResponse === "acknowledged"}
                  pending={pendingResponse === "acknowledged"}
                  disabled={!!pendingResponse}
                  onClick={() => handleRespond(row, "acknowledged")}
                  icon={<Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
                  label="Acknowledge"
                  tone="neutral"
                />
                <ResponseButton
                  active={row.pickupResponse === "bringing_out"}
                  pending={pendingResponse === "bringing_out"}
                  disabled={!!pendingResponse}
                  onClick={() => handleRespond(row, "bringing_out")}
                  icon={<Truck className="h-3.5 w-3.5" strokeWidth={2.5} />}
                  label="Bringing out"
                  tone="primary"
                />
                <ResponseButton
                  active={row.pickupResponse === "declined"}
                  pending={pendingResponse === "declined"}
                  disabled={!!pendingResponse}
                  onClick={() => handleRespond(row, "declined")}
                  icon={<X className="h-3.5 w-3.5" strokeWidth={2.5} />}
                  label="Decline"
                  tone="danger"
                />
              </div>

              {rowError && (
                <p className="mt-2 text-xs text-red-700">{rowError}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function responseLabel(r: PickupResponse): string {
  return r === "acknowledged"
    ? "Acknowledged"
    : r === "bringing_out"
      ? "Bringing out"
      : "Declined";
}

function ResponseButton({
  active,
  pending,
  disabled,
  onClick,
  icon,
  label,
  tone,
}: {
  active: boolean;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone: "primary" | "neutral" | "danger";
}) {
  const activeStyles: Record<typeof tone, string> = {
    primary: "bg-primary text-primary-foreground border-primary",
    neutral: "bg-emerald-600 text-white border-emerald-600",
    danger: "bg-red-600 text-white border-red-600",
  };
  const idleStyles: Record<typeof tone, string> = {
    primary: "border-primary/30 bg-white text-primary hover:bg-primary/10",
    neutral: "border-border bg-white text-foreground hover:bg-muted",
    danger: "border-red-200 bg-white text-red-700 hover:bg-red-50",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60",
        active ? activeStyles[tone] : idleStyles[tone],
      )}
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        icon
      )}
      {label}
    </button>
  );
}
