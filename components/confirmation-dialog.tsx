"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

type DialogAction = {
  label: ReactNode;
  onAction: () => void;
  disabled?: boolean;
  shortcutKey?: string;
  variant?: "primary" | "success" | "destructive" | "outline";
  leading?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

type ConfirmationDialogProps = {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  secondaryAction?: DialogAction;
  primaryAction?: DialogAction;
  enableShortcuts?: boolean;
  zIndexClassName?: string;
  maxWidthClassName?: string;
};

function actionClassName(variant: DialogAction["variant"]) {
  if (variant === "destructive") {
    return "bg-destructive text-destructive-foreground hover:opacity-90";
  }
  if (variant === "primary") {
    return "bg-primary text-primary-foreground hover:opacity-90";
  }
  if (variant === "success") {
    return "bg-[var(--success)] text-[var(--success-foreground)] hover:opacity-90";
  }
  return "border border-border hover:bg-muted";
}

export function ShortcutLabel({
  text,
  shortcutKey,
}: {
  text: string;
  shortcutKey: string;
}) {
  const lowerText = text.toLowerCase();
  const lowerShortcut = shortcutKey.toLowerCase();
  const shortcutIndex = lowerText.indexOf(lowerShortcut);

  if (shortcutIndex === -1) {
    return <>{text}</>;
  }

  const before = text.slice(0, shortcutIndex);
  const shortcut = text.slice(shortcutIndex, shortcutIndex + 1);
  const after = text.slice(shortcutIndex + 1);

  return (
    <span>
      {before}
      <span style={{ textDecorationLine: "underline" }}>{shortcut}</span>
      {after}
    </span>
  );
}

export default function ConfirmationDialog({
  open,
  title,
  description,
  children,
  onClose,
  secondaryAction,
  primaryAction,
  enableShortcuts = true,
  zIndexClassName = "z-[70]",
  maxWidthClassName = "max-w-sm",
}: ConfirmationDialogProps) {
  useEffect(() => {
    if (!open || !enableShortcuts) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      if (key === "escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (
        secondaryAction?.shortcutKey &&
        key === secondaryAction.shortcutKey.toLowerCase()
      ) {
        e.preventDefault();
        if (!secondaryAction.disabled) secondaryAction.onAction();
        return;
      }

      if (
        primaryAction?.shortcutKey &&
        key === primaryAction.shortcutKey.toLowerCase()
      ) {
        e.preventDefault();
        if (!primaryAction.disabled) primaryAction.onAction();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, enableShortcuts, onClose, secondaryAction, primaryAction]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center p-4`}>
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className={`relative w-full ${maxWidthClassName} rounded-xl border border-border bg-card p-5 shadow-xl`}>
        <h3 className="mb-2 text-base font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="mb-5 text-sm text-muted-foreground">{description}</p>
        )}
        {children}
        {(secondaryAction || primaryAction) && (
          <div className="mt-4 flex gap-2 justify-end">
            {secondaryAction && (
              <button
                onClick={secondaryAction.onAction}
                disabled={secondaryAction.disabled}
                className={`inline-flex items-center px-3 py-2 text-sm rounded-lg transition-colors disabled:opacity-50 ${actionClassName(secondaryAction.variant ?? "outline")} ${secondaryAction.className ?? ""}`}
                style={secondaryAction.style}
              >
                {secondaryAction.leading}
                <span>{secondaryAction.label}</span>
              </button>
            )}
            {primaryAction && (
              <button
                onClick={primaryAction.onAction}
                disabled={primaryAction.disabled}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg transition-opacity disabled:opacity-50 ${actionClassName(primaryAction.variant ?? "primary")} ${primaryAction.className ?? ""}`}
                style={primaryAction.style}
              >
                {primaryAction.leading}
                <span>{primaryAction.label}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
