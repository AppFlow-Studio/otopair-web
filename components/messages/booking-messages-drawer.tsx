"use client";

/**
 * BookingMessagesDrawer — the in-booking Message Shop surface.
 *
 * A right-side slide-over opened from the JobDetailPanel header. Lists this
 * booking's tickets (listShopTicketsForBooking) and opens a TicketThread on
 * select. A single ticket auto-opens so staff land straight in the reply box.
 * Rendered in a portal above the booking panel / reschedule dialogs.
 *
 * The stateful body lives in DrawerBody, mounted only while open — so per-open
 * state (which thread is active) resets naturally without a reset effect.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TicketList } from "@/components/messages/ticket-list";
import { TicketThread } from "@/components/messages/ticket-thread";

export function BookingMessagesDrawer({
  bookingId,
  open,
  onClose,
}: {
  bookingId: Id<"bookings">;
  open: boolean;
  onClose: () => void;
}) {
  // Close on Escape. Registered unconditionally; no-ops while closed.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[65] bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed right-0 top-0 z-[70] flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        <DrawerBody bookingId={bookingId} onClose={onClose} />
      </div>
    </>,
    document.body,
  );
}

function DrawerBody({
  bookingId,
  onClose,
}: {
  bookingId: Id<"bookings">;
  onClose: () => void;
}) {
  const tickets = useQuery(api.shop_tickets_web.listShopTicketsForBooking, {
    bookingId,
  });
  const [manualId, setManualId] = useState<Id<"shop_tickets"> | null>(null);
  // Once the user navigates (opens a row or backs out), stop auto-opening.
  const [touched, setTouched] = useState(false);

  // Auto-open the sole ticket by DERIVING the active id — no reset effect, so
  // Back returns to the list and stays there (touched suppresses re-open).
  const autoId =
    !touched && tickets && tickets.length === 1
      ? (tickets[0]._id as Id<"shop_tickets">)
      : null;
  const activeId = manualId ?? autoId;

  if (activeId) {
    return (
      <TicketThread
        ticketId={activeId}
        onBack={() => {
          setTouched(true);
          setManualId(null);
        }}
      />
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Messages</h3>
          <p className="text-xs text-muted-foreground">
            Customer messages for this booking
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Close messages"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <TicketList
          tickets={tickets ?? []}
          selectedId={null}
          onSelect={(t) => {
            setTouched(true);
            setManualId(t._id as Id<"shop_tickets">);
          }}
          emptyLabel="No customer messages for this booking yet."
        />
      </div>
    </>
  );
}
