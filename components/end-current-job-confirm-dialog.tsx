"use client";

import ConfirmationDialog from "@/components/confirmation-dialog";
import type { Id } from "@/convex/_generated/dataModel";

type ActiveJob = {
  bookingId: Id<"bookings">;
  customerName: string | null;
  vehicleLabel: string | null;
  serviceSummary: string | null;
  mechanicName: string;
};

type EndCurrentJobConfirmDialogProps = {
  open: boolean;
  activeJob: ActiveJob | null;
  /** Label for the primary action. Defaults to "Open current job".
   *  Pass "Got it" or similar when the dialog is informational only. */
  primaryLabel?: string;
  /** When false, hides the primary action — used by surfaces that only
   *  want to acknowledge the conflict (e.g. mechanic dashboard, where the
   *  in-progress card is already on screen). */
  showPrimaryAction?: boolean;
  onClose: () => void;
  onCompleteCurrent?: () => void;
};

export default function EndCurrentJobConfirmDialog({
  open,
  activeJob,
  primaryLabel = "Open current job",
  showPrimaryAction = true,
  onClose,
  onCompleteCurrent,
}: EndCurrentJobConfirmDialogProps) {
  const mechanicName = activeJob?.mechanicName ?? "this mechanic";
  const vehicleLabel = activeJob?.vehicleLabel ?? "the current vehicle";
  const customerName = activeJob?.customerName ?? "the current customer";
  const serviceSummary = activeJob?.serviceSummary;

  return (
    <ConfirmationDialog
      open={open}
      onClose={onClose}
      title={`End current job for ${mechanicName}?`}
      maxWidthClassName="max-w-md"
      primaryAction={
        showPrimaryAction
          ? {
              label: primaryLabel,
              onAction: () => onCompleteCurrent?.(),
              variant: "primary",
              disabled: !activeJob || !onCompleteCurrent,
            }
          : undefined
      }
      secondaryAction={{
        label: showPrimaryAction ? "Cancel" : "Close",
        onAction: onClose,
        variant: "outline",
      }}
    >
      <div className="space-y-2 text-sm text-foreground">
        <p>
          {mechanicName} is currently working on{" "}
          <span className="font-medium">{vehicleLabel}</span> for{" "}
          <span className="font-medium">{customerName}</span>
          {serviceSummary ? (
            <>
              {" "}
              (<span className="text-muted-foreground">{serviceSummary}</span>)
            </>
          ) : null}
          .
        </p>
        <p className="text-muted-foreground">
          Finish that booking — including the post-job report — before starting
          the new one.
        </p>
      </div>
    </ConfirmationDialog>
  );
}
