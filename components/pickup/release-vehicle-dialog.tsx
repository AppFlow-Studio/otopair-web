"use client";

/**
 * Terminal-stage dialogs for the pickup-request flow.
 *
 * ReleaseVehicleDialog — the shop hands the car back, which closes the booking
 * out as a cancellation. Reads `getPickupReleasePreview` for the live fee and
 * calls `releaseVehicleForPickup` (charge the fee, or waive → void the hold).
 *
 * DeclinePickupDialog — the shop can't release yet. Requires a reason (surfaced
 * to the customer) and parks the request via `respondToPickupRequest`.
 *
 * Both are self-contained (portal via ConfirmationDialog) so any surface can
 * drop them in with just open/bookingId/onClose. Pass `zIndexClassName` when
 * opening from a surface that itself sits above the default z-[70] (e.g. the
 * mechanic full-screen takeover at z-[80]).
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";

function formatFee(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function ReleaseVehicleDialog({
  bookingId,
  open,
  onClose,
  onReleased,
  zIndexClassName,
}: {
  bookingId: Id<"bookings"> | null;
  open: boolean;
  onClose: () => void;
  onReleased?: () => void;
  zIndexClassName?: string;
}) {
  const preview = useQuery(
    api.bookings.getPickupReleasePreview,
    open && bookingId ? { bookingId } : "skip",
  );
  const release = useMutation(api.bookings.releaseVehicleForPickup);
  const [waive, setWaive] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feeCents = preview?.feeCents ?? 0;
  const hasFee = feeCents > 0;
  const willCharge = hasFee && !waive;

  function reset() {
    setWaive(false);
    setNote("");
    setSubmitting(false);
    setError(null);
  }

  function handleClose() {
    if (submitting) return;
    reset();
    onClose();
  }

  async function handleRelease() {
    if (!bookingId) return;
    setSubmitting(true);
    setError(null);
    try {
      await release({
        bookingId,
        // No-fee bookings always void; otherwise honor the waive toggle.
        waiveFee: hasFee ? waive : true,
        feeAcknowledgedCents: feeCents,
        note: note.trim() || undefined,
      });
      onReleased?.();
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't release — try again.");
      setSubmitting(false);
    }
  }

  return (
    <ConfirmationDialog
      open={open}
      onClose={handleClose}
      zIndexClassName={zIndexClassName}
      maxWidthClassName="max-w-md"
      title="Release car & close booking"
      description={
        preview
          ? `${preview.customerName ?? "The customer"}${preview.vehicle ? ` · ${preview.vehicle}` : ""}`
          : "Handing the car back cancels this booking."
      }
      secondaryAction={{
        label: "Never mind",
        variant: "outline",
        onAction: handleClose,
        disabled: submitting,
      }}
      primaryAction={{
        label: submitting
          ? "Releasing…"
          : willCharge
            ? `Release & charge ${formatFee(feeCents)}`
            : "Release — no fee",
        variant: "destructive",
        onAction: handleRelease,
        disabled: submitting || preview === undefined || preview === null,
        leading: submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : undefined,
      }}
    >
      {preview === undefined ? (
        <p className="text-sm text-muted-foreground">Loading cancellation fee…</p>
      ) : preview === null ? (
        <p className="text-sm text-red-600">
          This booking can&apos;t be released right now.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Cancellation fee</span>
              <span className="font-semibold text-foreground">
                {hasFee ? formatFee(feeCents) : "None"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Releasing the car cancels this booking.{" "}
              {hasFee
                ? "The fee is captured from the customer's card hold; the remainder is released."
                : "No fee applies — the card hold is voided."}
            </p>
          </div>

          {hasFee ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={waive}
                onChange={(e) => setWaive(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-foreground">Waive the fee</span>
                <span className="block text-xs text-muted-foreground">
                  Void the hold instead of charging {formatFee(feeCents)}.
                </span>
              </span>
            </label>
          ) : null}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={
              waive ? "Reason for waiving (recommended)…" : "Add a note (optional)…"
            }
            className="w-full resize-none rounded-lg border border-input bg-white px-3 py-2 text-sm text-foreground placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring"
          />

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      )}
    </ConfirmationDialog>
  );
}

export function DeclinePickupDialog({
  bookingId,
  open,
  onClose,
  onDeclined,
  zIndexClassName,
}: {
  bookingId: Id<"bookings"> | null;
  open: boolean;
  onClose: () => void;
  onDeclined?: () => void;
  zIndexClassName?: string;
}) {
  const respond = useMutation(api.bookings.respondToPickupRequest);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    if (submitting) return;
    setReason("");
    setError(null);
    onClose();
  }

  async function handleDecline() {
    if (!bookingId) return;
    const note = reason.trim();
    if (!note) {
      setError("Add a short reason so the customer knows why.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await respond({ bookingId, response: "declined", note });
      onDeclined?.();
      setReason("");
      setSubmitting(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send — try again.");
      setSubmitting(false);
    }
  }

  return (
    <ConfirmationDialog
      open={open}
      onClose={handleClose}
      zIndexClassName={zIndexClassName}
      title="Can't release yet"
      description="Let the customer know why their car isn't ready to go."
      secondaryAction={{
        label: "Cancel",
        variant: "outline",
        onAction: handleClose,
        disabled: submitting,
      }}
      primaryAction={{
        label: submitting ? "Sending…" : "Send to customer",
        variant: "primary",
        onAction: handleDecline,
        disabled: submitting || reason.trim().length === 0,
        leading: submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : undefined,
      }}
    >
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        autoFocus
        placeholder="e.g. Still mid-repair — brakes are apart right now."
        className="w-full resize-none rounded-lg border border-input bg-white px-3 py-2 text-sm text-foreground placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </ConfirmationDialog>
  );
}
