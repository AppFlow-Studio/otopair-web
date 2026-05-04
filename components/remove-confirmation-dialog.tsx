"use client";

import type { ReactNode } from "react";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";

type RemoveConfirmationDialogProps = {
  open: boolean;
  title: string;
  subjectName?: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  isSubmitting?: boolean;
  submittingLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
};

export default function RemoveConfirmationDialog({
  open,
  title,
  subjectName,
  description,
  confirmLabel,
  isSubmitting = false,
  submittingLabel = "Removing...",
  onClose,
  onConfirm,
}: RemoveConfirmationDialogProps) {
  const resolvedDescription =
    description ??
    (subjectName ? (
      <>
        Are you sure you want to remove{" "}
        <span className="font-medium text-foreground">{subjectName}</span> from this shop? They
        will no longer have access to its Otopair platform.
      </>
    ) : undefined);

  return (
    <ConfirmationDialog
      open={open}
      title={title}
      description={resolvedDescription}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      secondaryAction={{
        label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
        onAction: onClose,
        shortcutKey: "c",
        disabled: isSubmitting,
      }}
      primaryAction={{
        label: isSubmitting
          ? submittingLabel
          : <ShortcutLabel text={confirmLabel} shortcutKey="r" />,
        onAction: onConfirm,
        shortcutKey: "r",
        variant: "destructive",
        disabled: isSubmitting,
      }}
    />
  );
}
