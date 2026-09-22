"use client";

/**
 * BookingPickupPanel — in-drawer pickup-request controls for a SINGLE booking.
 *
 * The schedule board and the dashboard "Pickup requests" card both stop showing
 * a request once it's been answered (acknowledged / brought out) or aged out, so
 * after the first tap the mechanic had no way back to it. This panel lives in the
 * booking drawer and stays put until the car actually leaves the shop, so the
 * request is always reachable from the booking itself — acknowledge, bring the
 * car out, decline (with a reason), or release + close.
 *
 * Self-gating: renders nothing unless the booking has an open pickup request
 * (`cancelRequestedAtMs` set) AND the car is still `vehicle_at_shop`. A release
 * routes through the cancel transition, so the booking leaves that status and
 * this panel disappears on its own.
 *
 * Reuses the shared terminal dialogs (ReleaseVehicleDialog / DeclinePickupDialog)
 * and the same `respondToPickupRequest` mutation the dashboard card uses.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { Car, Check, KeyRound, Loader2, Truck, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import {
  DeclinePickupDialog,
  ReleaseVehicleDialog,
} from "@/components/pickup/release-vehicle-dialog";

type PickupResponse = "acknowledged" | "bringing_out" | "declined";
type CommsResponse = "acknowledged" | "bringing_out";

export default function BookingPickupPanel({
  bookingId,
  status,
  cancelRequestedAtMs,
  cancelRequestReason,
  pickupResponse,
  pickupRespondedAtMs,
}: {
  bookingId: Id<"bookings">;
  status: string;
  cancelRequestedAtMs?: number | null;
  cancelRequestReason?: string | null;
  pickupResponse?: PickupResponse | null;
  pickupRespondedAtMs?: number | null;
}) {
  const respond = useMutation(api.bookings.respondToPickupRequest);
  const [pending, setPending] = useState<PickupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRelease, setShowRelease] = useState(false);
  const [showDecline, setShowDecline] = useState(false);

  // Only surface while the car is here AND the customer asked to pick it up.
  // A release flips the booking to `cancelled` (leaves vehicle_at_shop), so the
  // panel self-hides once the car is handed back.
  if (cancelRequestedAtMs == null || status !== "vehicle_at_shop") return null;

  const minutesWaiting = Math.max(
    0,
    Math.round((Date.now() - cancelRequestedAtMs) / 60_000),
  );

  async function handleRespond(response: CommsResponse) {
    setPending(response);
    setError(null);
    try {
      await respond({ bookingId, response });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the response");
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-label="Pickup request"
      className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-amber-800">
          <Car className="h-4 w-4" />
          <span className="text-xs font-semibold uppercase tracking-[0.2em]">
            Pickup requested
          </span>
        </div>
        <span className="text-[11px] font-medium text-amber-800">
          {minutesWaiting}m ago
        </span>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        The customer asked to cancel and pick up their car.
      </p>
      {cancelRequestReason ? (
        <p className="mt-1 line-clamp-3 text-xs italic text-muted-foreground">
          &ldquo;{cancelRequestReason}&rdquo;
        </p>
      ) : null}
      {pickupResponse && pending == null ? (
        <p className="mt-2 text-xs font-medium text-emerald-700">
          You said: {responseLabel(pickupResponse)}
          {pickupRespondedAtMs ? ` · ${minutesAgo(pickupRespondedAtMs)}` : ""}
        </p>
      ) : null}

      {/* Stage 1 — comms pings (no status change) */}
      <div className="mt-3 flex flex-wrap gap-2">
        <ResponseButton
          active={pickupResponse === "acknowledged"}
          pending={pending === "acknowledged"}
          disabled={pending != null}
          onClick={() => handleRespond("acknowledged")}
          icon={<Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
          label="Acknowledge"
          tone="neutral"
        />
        <ResponseButton
          active={pickupResponse === "bringing_out"}
          pending={pending === "bringing_out"}
          disabled={pending != null}
          onClick={() => handleRespond("bringing_out")}
          icon={<Truck className="h-3.5 w-3.5" strokeWidth={2.5} />}
          label="Bringing out"
          tone="primary"
        />
        <ResponseButton
          active={false}
          pending={false}
          disabled={pending != null}
          onClick={() => setShowDecline(true)}
          icon={<X className="h-3.5 w-3.5" strokeWidth={2.5} />}
          label="Decline"
          tone="danger"
        />
      </div>

      {/* Stage 2 — terminal handoff: cancel + settle */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShowRelease(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-600 bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700"
        >
          <KeyRound className="h-3.5 w-3.5" strokeWidth={2.5} />
          Release car
        </button>
        <span className="text-[11px] text-muted-foreground">
          Hands the car back &amp; closes the booking
        </span>
      </div>

      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}

      <ReleaseVehicleDialog
        bookingId={bookingId}
        open={showRelease}
        onClose={() => setShowRelease(false)}
      />
      <DeclinePickupDialog
        bookingId={bookingId}
        open={showDecline}
        onClose={() => setShowDecline(false)}
      />
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

function minutesAgo(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m === 0 ? "just now" : `${m}m ago`;
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
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );
}
