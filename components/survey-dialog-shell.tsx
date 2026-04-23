"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function SurveyDialogShell({
  open,
  title,
  description,
  subtitle,
  onClose,
  children,
  footer,
  maxWidthClassName = "max-w-3xl",
}: {
  open: boolean;
  title: string;
  description?: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClassName?: string;
}) {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative flex max-h-[min(90vh,920px)] w-full ${maxWidthClassName} flex-col overflow-hidden rounded-[24px] border border-border bg-card shadow-[0_24px_80px_rgba(15,23,42,0.24)]`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
            {subtitle ? (
              <div className="mt-2 text-xs font-medium uppercase tracking-[0.18em] text-primary/80">
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer ? (
          <div className="border-t border-border px-6 py-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
