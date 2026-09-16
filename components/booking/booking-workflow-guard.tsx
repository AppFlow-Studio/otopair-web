"use client";

import type { ReactNode } from "react";
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
  const notice = open
    ? getBookingWorkflowUnavailableNotice(booking, allowedStatuses)
    : null;

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
