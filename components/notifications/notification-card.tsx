"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type NotificationItem = {
  kind: "booking" | "tire_quote" | "rotor_quote";
  bookingId: Id<"bookings">;
  createdAt: number;
  isUnread: boolean;
  customer: { full: string; short: string };
  vehicle: { full: string; short: string };
  services?: string[];
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  scheduledLabel?: string | null;
  price?: number | null;
  note?: string | null;
  tireSpecs?: { size: string; type: string; tier: string; quantity: number } | null;
  rotorSpecs?: {
    brake_system_type: "standard" | "sport" | "carbon_ceramic";
    axle: "front" | "rear" | "both";
    include_pads: boolean;
    pad_type?: "ceramic" | "semi_metallic" | "oem_recommended";
  } | null;
  urgency?: "urgent" | null;
  modFlag?: { affected: boolean; notes?: string | null } | null;
  simulated?: boolean;
};

function formatBrakeSystemLabel(t: NonNullable<NotificationItem["rotorSpecs"]>["brake_system_type"]): string {
  if (t === "sport") return "Sport";
  if (t === "carbon_ceramic") return "Carbon ceramic";
  return "Standard";
}

function formatPadTypeLabel(t: NonNullable<NotificationItem["rotorSpecs"]>["pad_type"]): string {
  if (t === "ceramic") return "Ceramic";
  if (t === "semi_metallic") return "Semi-metallic";
  if (t === "oem_recommended") return "OEM recommended";
  return "";
}

function rotorQtyForAxle(axle: NonNullable<NotificationItem["rotorSpecs"]>["axle"]): number {
  if (axle === "both") return 4;
  return 2;
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

interface NotificationCardProps {
  item: NotificationItem;
  onSkip: (bookingId: string) => void;
  onAfterAction?: () => void;
  preview?: boolean;
}

export function NotificationCard({
  item,
  onSkip,
  onAfterAction,
  preview = false,
}: NotificationCardProps) {
  const router = useRouter();
  const acceptBooking = useMutation(api.bookings.accept);
  const cancelBooking = useMutation(api.bookings.cancel);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDecline, setConfirmingDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [modExpanded, setModExpanded] = useState(false);

  const isBooking = item.kind === "booking";
  const isRotorQuote = item.kind === "rotor_quote";
  const isTireQuote = item.kind === "tire_quote";
  const headerLabel = isBooking
    ? "New booking"
    : isRotorQuote
      ? "Rotor quote request"
      : "Tire quote request";
  const headerColor = isBooking
    ? "text-blue-600"
    : isRotorQuote
      ? "text-orange-600"
      : "text-amber-600";

  async function handleAccept() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await acceptBooking({ bookingId: item.bookingId });
      onAfterAction?.();
    } catch (e: any) {
      setError(e?.message ?? "Couldn't accept this booking.");
      setPending(false);
    }
  }

  async function handleDeclineConfirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await cancelBooking({
        bookingId: item.bookingId,
        reason: declineReason.trim() || "declined_by_shop",
      });
      onAfterAction?.();
    } catch (e: any) {
      setError(e?.message ?? "Couldn't decline this booking.");
      setPending(false);
    }
  }

  function handleDetails() {
    onAfterAction?.();
    const params = new URLSearchParams();
    params.set("action", "focus-booking");
    params.set("bookingId", String(item.bookingId));
    if (item.scheduledDate) {
      params.set("date", item.scheduledDate);
    }
    router.push(`/schedule?${params.toString()}`);
  }

  function handleSubmitQuote() {
    onAfterAction?.();
    const type = isRotorQuote ? "rotor" : "tire";
    router.push(`/bookings/quote-requests?type=${type}&booking=${item.bookingId}`);
  }

  return (
    <li className="relative px-4 py-3">
      {item.isUnread && (
        <span
          aria-hidden
          className="absolute left-1.5 top-5 h-1.5 w-1.5 rounded-full bg-blue-500"
        />
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold ${headerColor}`}>
            {headerLabel}
          </span>
          {item.urgency === "urgent" && (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600">
              Urgent
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-gray-400">
          {relativeTime(item.createdAt)}
        </span>
      </div>

      <p className="mt-1 text-sm font-medium text-gray-900">
        {item.customer.short}
      </p>
      <p className="text-xs text-gray-500">
        {item.vehicle.full}
        {isBooking && item.services && item.services.length > 0 && (
          <>
            <span className="mx-1">&#183;</span>
            {item.services.slice(0, 2).join(", ")}
            {item.services.length > 2 ? ` +${item.services.length - 2}` : ""}
          </>
        )}
      </p>

      {isBooking && item.scheduledLabel && (
        <p className="mt-1 text-xs text-gray-600">
          {item.scheduledLabel}
          {item.price != null && (
            <>
              <span className="mx-1">&#183;</span>
              <span className="font-medium text-gray-900">
                ${item.price.toFixed(2)}
              </span>
            </>
          )}
        </p>
      )}

      {isTireQuote && item.tireSpecs && (
        <p className="mt-1 text-xs text-gray-600">
          <span className="font-medium text-gray-900">
            {item.tireSpecs.size}
          </span>
          <span className="mx-1">&#183;</span>
          {item.tireSpecs.type}
          <span className="mx-1">&#183;</span>
          {item.tireSpecs.tier}
          <span className="mx-1">&#183;</span>
          {item.tireSpecs.quantity} tires
        </p>
      )}

      {isRotorQuote && item.rotorSpecs && (
        <p className="mt-1 text-xs text-gray-600">
          <span className="font-medium text-gray-900">
            {item.rotorSpecs.axle === "front"
              ? "Front pair"
              : item.rotorSpecs.axle === "rear"
                ? "Rear pair"
                : "All four"}
          </span>
          <span className="mx-1">&#183;</span>
          {formatBrakeSystemLabel(item.rotorSpecs.brake_system_type)}
          <span className="mx-1">&#183;</span>
          {rotorQtyForAxle(item.rotorSpecs.axle)} rotors
          {item.rotorSpecs.include_pads && (
            <>
              <span className="mx-1">&#183;</span>
              <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                + Pads
                {item.rotorSpecs.pad_type
                  ? ` (${formatPadTypeLabel(item.rotorSpecs.pad_type)})`
                  : ""}
              </span>
            </>
          )}
        </p>
      )}

      {item.note && (
        <p className="mt-1 text-xs italic text-gray-500 line-clamp-2">
          &ldquo;{item.note}&rdquo;
        </p>
      )}

      {isBooking && item.modFlag?.affected && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            <span aria-hidden>&#9888;</span> This vehicle is modified
          </p>
          {(() => {
            const notes = item.modFlag!.notes?.trim();
            if (!notes) {
              return (
                <p className="mt-1 text-xs text-amber-900/90">
                  Aftermarket modifications affect this service.
                </p>
              );
            }
            const long = notes.length > 80;
            return (
              <>
                <p
                  className={`mt-1 text-xs text-amber-900/90 ${
                    long && !modExpanded ? "line-clamp-2" : ""
                  }`}
                >
                  {notes}
                </p>
                {long && (
                  <button
                    type="button"
                    onClick={() => setModExpanded((v) => !v)}
                    className="mt-0.5 text-[11px] font-semibold text-amber-800 hover:text-amber-900"
                  >
                    {modExpanded ? "Less" : "More"}
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}

      {!preview && error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}

      {/* Actions */}
      {!confirmingDecline && !preview && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isBooking ? (
            <>
              <button
                type="button"
                onClick={handleAccept}
                disabled={pending}
                className="inline-flex items-center rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDecline(true)}
                disabled={pending}
                className="inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={handleDetails}
                className="ml-auto inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900"
              >
                Details
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleSubmitQuote}
                className="inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                Submit quote
              </button>
              <button
                type="button"
                onClick={() => onSkip(String(item.bookingId))}
                className="inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Skip
              </button>
            </>
          )}
        </div>
      )}

      {confirmingDecline && (
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-2">
          <label className="block text-xs font-medium text-gray-700">
            Reason (optional)
          </label>
          <input
            type="text"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="e.g. Fully booked"
            className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 outline-none focus:border-gray-400"
          />
          <p className="mt-1 text-[11px] text-gray-500">
            The customer will be notified.
          </p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmingDecline(false);
                setDeclineReason("");
              }}
              disabled={pending}
              className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDeclineConfirm}
              disabled={pending}
              className="inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              Confirm decline
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export type { NotificationItem };
