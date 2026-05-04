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
  maxWidthClassName = "max-w-lg",
  headerBadge,
}: {
  open: boolean;
  title: string;
  description?: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClassName?: string;
  headerBadge?: ReactNode;
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
    <div className="fixed inset-0 z-[75] flex items-start justify-center overscroll-contain p-3 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-[rgba(17,24,28,0.32)] backdrop-blur-[3px]"
        onClick={onClose}
      />
      <div
        className={`relative flex max-h-[min(94vh,920px)] w-full ${maxWidthClassName} flex-col overflow-hidden rounded-2xl border border-primary/10 bg-card shadow-[0_24px_60px_-12px_rgba(15,23,42,0.22)]`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-primary/10 px-5 py-3.5 sm:px-6">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold leading-tight text-foreground">
                {title}
              </h3>
              {headerBadge}
            </div>
            {description ? (
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                {description}
              </p>
            ) : null}
            {subtitle ? (
              <div className="mt-1 text-[11px] text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">
          {children}
        </div>

        {footer ? (
          <div className="border-t border-primary/10 bg-[rgba(17,24,28,0.025)] px-5 py-3 sm:px-6 sm:py-3.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
