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
  onClose: () => void;
  onCompleteCurrent: () => void;
};

export default function EndCurrentJobConfirmDialog({
  open,
  activeJob,
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
      primaryAction={{
        label: "Complete current & continue",
        onAction: onCompleteCurrent,
        variant: "primary",
        disabled: !activeJob,
      }}
      secondaryAction={{
        label: "Cancel",
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
          Please be prepared to fill out the post-job report before starting the new job.
        </p>
      </div>
    </ConfirmationDialog>
  );
}
