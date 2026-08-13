"use client";

import { Loader2 } from "lucide-react";
import { format } from "date-fns";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";

export type RescheduleConfirmationProposal = {
  eventId: string;
  originalDate: string;
  originalTime: string;
  originalMechanicId?: string;
  originalMechanicName?: string;
  newDate: string;
  newTime: string;
  newMechanicId?: string;
  newMechanicName?: string;
  dateChanged: boolean;
  timeChanged: boolean;
  mechanicChanged: boolean;
};

function formatTimeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function RescheduleConfirmationDialog({
  proposal,
  error,
  isSubmitting,
  onCancel,
  onConfirm,
  reserveOriginalSlotMessage,
  skipsCustomerApproval = false,
  zIndexClassName = "z-[60]",
}: {
  proposal: RescheduleConfirmationProposal | null;
  error?: string;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  reserveOriginalSlotMessage: string;
  /** When true, the booking is moved directly (no customer-approval step) —
   * used for manual-scheduling-review pushes, which behave like the
   * automatic delay cascade. The customer just gets a courtesy notice. */
  skipsCustomerApproval?: boolean;
  zIndexClassName?: string;
}) {
  let summary: string | null = null;

  if (proposal) {
    const approvalNote = skipsCustomerApproval
      ? "The customer will be notified of the new time, but won't need to approve it."
      : "The customer will be asked to approve the new time.";
    if (proposal.timeChanged && proposal.mechanicChanged) {
      summary = `Move from ${proposal.originalMechanicName ?? "Unassigned"} at ${formatTimeLabel(proposal.originalTime)} to ${proposal.newMechanicName ?? "Unassigned"} at ${formatTimeLabel(proposal.newTime)}?`;
    } else if (proposal.dateChanged && proposal.timeChanged) {
      summary = `Move from ${format(new Date(proposal.originalDate + "T00:00:00"), "EEE MMM d")} at ${formatTimeLabel(proposal.originalTime)} to ${format(new Date(proposal.newDate + "T00:00:00"), "EEE MMM d")} at ${formatTimeLabel(proposal.newTime)}? ${approvalNote}`;
    } else if (proposal.dateChanged) {
      summary = `Move from ${format(new Date(proposal.originalDate + "T00:00:00"), "EEE MMM d")} to ${format(new Date(proposal.newDate + "T00:00:00"), "EEE MMM d")} at ${formatTimeLabel(proposal.newTime)}? ${skipsCustomerApproval ? "The customer will be notified of the new date, but won't need to approve it." : "The customer will be asked to approve the new date."}`;
    } else if (proposal.timeChanged) {
      summary = `Move from ${formatTimeLabel(proposal.originalTime)} to ${formatTimeLabel(proposal.newTime)}? ${approvalNote}`;
    } else {
      summary = `Reassign from ${proposal.originalMechanicName ?? "Unassigned"} to ${proposal.newMechanicName ?? "Unassigned"}? ${skipsCustomerApproval ? "The customer will be notified of the change, but won't need to approve it." : "The customer will be asked to approve the change."}`;
    }
  }

  return (
    <ConfirmationDialog
      open={!!proposal}
      title="Reschedule this booking?"
      onClose={onCancel}
      zIndexClassName={zIndexClassName}
      secondaryAction={{
        label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
        onAction: onCancel,
        disabled: isSubmitting,
        shortcutKey: "c",
      }}
      primaryAction={{
        label: isSubmitting ? "Confirming..." : <ShortcutLabel text="Confirm reschedule" shortcutKey="f" />,
        onAction: onConfirm,
        disabled: isSubmitting,
        shortcutKey: "f",
        variant: "primary",
        leading: isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined,
      }}
    >
      <div className="text-sm text-muted-foreground space-y-1">
        {summary && <p>{summary}</p>}
        {!skipsCustomerApproval && (
          <p className="mt-2 text-xs text-muted-foreground">{reserveOriginalSlotMessage}</p>
        )}
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
    </ConfirmationDialog>
  );
}
