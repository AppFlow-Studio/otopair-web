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
    <div className="fixed inset-0 z-[75] flex items-start justify-center p-3 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-[rgba(17,24,28,0.26)] backdrop-blur-[5px]" onClick={onClose} />
      <div
        className={`relative flex max-h-[min(94vh,940px)] w-full ${maxWidthClassName} flex-col overflow-hidden rounded-[28px] border border-primary/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.985),rgba(247,244,238,0.985))] shadow-[0_32px_80px_rgba(15,23,42,0.22)]`}
      >
        <div className="border-b border-primary/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(250,247,241,0.92))] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
              <h3 className="text-[1.05rem] font-semibold text-foreground sm:text-[1.12rem]">
                {title}
              </h3>
            {description ? (
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
            {subtitle ? (
                <div className="mt-2 text-xs font-medium text-muted-foreground">
                  {subtitle}
                </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
              className="rounded-full border border-primary/10 bg-white/80 p-2 text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {children}
        </div>

        {footer ? (
          <div className="border-t border-primary/10 bg-[rgba(255,255,255,0.84)] px-4 py-4 sm:px-6">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
