"use client";

import { useRef, type ReactNode } from "react";
import ConfirmationDialog from "@/components/confirmation-dialog";
import {
  getBookingWorkflowUnavailableNotice,
  type BookingWorkflowBooking,
} from "@/lib/booking-workflow-state";

export default function BookingWorkflowGuard({
  open,
  booking,
  allowedStatuses,
  onAcknowledge,
  children,
}: {
  open: boolean;
  booking: BookingWorkflowBooking | null | undefined;
  allowedStatuses: readonly string[];
  onAcknowledge: () => void;
  children: ReactNode;
}) {
  const currentNotice = open
    ? getBookingWorkflowUnavailableNotice(booking, allowedStatuses)
    : null;
  const latchedNotice = useRef<string | null>(null);

  // Once an active workflow becomes unavailable, it must stay replaced by its
  // acknowledgement until the user closes it. A reschedule can otherwise be
  // confirmed and moved to an allowed status while that acknowledgement is up.
  if (!open) latchedNotice.current = null;
  else if (currentNotice) latchedNotice.current ??= currentNotice;

  const notice = open ? latchedNotice.current ?? currentNotice : null;

  if (!notice) return <>{children}</>;

  return (
    <ConfirmationDialog
      open
      title="Booking unavailable"
      description={notice}
      onClose={() => {}}
      enableShortcuts={false}
      zIndexClassName="z-[80]"
      primaryAction={{
        label: "Acknowledge",
        onAction: onAcknowledge,
        variant: "primary",
      }}
    />
  );
}
