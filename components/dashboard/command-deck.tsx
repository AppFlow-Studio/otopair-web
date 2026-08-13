"use client";

/**
 * Command-deck primitives — the shared building blocks for the reworked
 * shop-owner and mechanic dashboards.
 *
 * The design goal is a calm, glanceable "command deck": a warm greeting, a
 * single row of at-a-glance metrics, then keyboard-navigable lists where the
 * eye lands on exactly what needs a decision. Every heavy flow (detail panel,
 * dialogs, overlays) stays wired underneath — these are presentation only.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";

/* ------------------------------------------------------------------ */
/*  Tokens                                                             */
/* ------------------------------------------------------------------ */

export type Tone = "primary" | "success" | "warning" | "danger" | "muted";

const DOT_TONE: Record<Tone, string> = {
  primary: "bg-primary",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  muted: "bg-muted-foreground/40",
};

const VALUE_TONE: Record<Tone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-amber-600",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

/* ------------------------------------------------------------------ */
/*  Greeting                                                           */
/* ------------------------------------------------------------------ */

export function GreetingHeader({
  greeting,
  name,
  dateLabel,
  subtitle,
  right,
}: {
  greeting: string;
  name?: string | null;
  dateLabel: string;
  subtitle?: string | null;
  right?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {subtitle ? (
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {subtitle}
          </p>
        ) : null}
        <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {greeting}
          {name ? `, ${name}` : ""}
        </h1>
      </div>
      <div className="flex items-center gap-4">
        <p className="text-sm text-muted-foreground">{dateLabel}</p>
        {right}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  Metrics                                                            */
/* ------------------------------------------------------------------ */

export function MetricRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6 border-b border-border pb-6 md:flex md:items-start md:justify-between md:gap-8">
      {children}
    </div>
  );
}

export function Metric({
  label,
  value,
  sublabel,
  icon: Icon,
  tone = "muted",
  active = false,
  href,
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon?: ComponentType<{ className?: string }>;
  /** Colors the value. Defaults to neutral foreground unless a tone is set. */
  tone?: Tone;
  /** Draws a small accent underline — use to flag the most urgent metric. */
  active?: boolean;
  href?: string;
}) {
  const valueColor = tone === "muted" ? "text-foreground" : VALUE_TONE[tone];
  const body = (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {label}
      </div>
      <p className={`mt-2 text-2xl font-semibold tracking-tight ${valueColor}`}>
        {value}
      </p>
      {sublabel ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{sublabel}</p>
      ) : null}
      {active ? <div className="mt-2 h-0.5 w-8 rounded-full bg-primary" /> : null}
    </div>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="group rounded-lg transition-opacity hover:opacity-80"
      >
        {body}
      </Link>
    );
  }
  return body;
}

/* ------------------------------------------------------------------ */
/*  Section label                                                      */
/* ------------------------------------------------------------------ */

export function SectionLabel({
  children,
  count,
  hint,
}: {
  children: ReactNode;
  count?: number;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">{children}</h2>
        {typeof count === "number" && count > 0 ? (
          <span className="inline-flex min-w-5 justify-center rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Command list                                                       */
/* ------------------------------------------------------------------ */

export function CommandList({
  children,
  footerHint,
  empty,
}: {
  children: ReactNode;
  footerHint?: ReactNode;
  empty?: ReactNode;
}) {
  return (
    <div className="mt-3">
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </ul>
      {empty}
      {footerHint ? (
        <p className="mt-2 pl-1 text-[11px] text-muted-foreground">{footerHint}</p>
      ) : null}
    </div>
  );
}

export type CommandAction = {
  label: string;
  run: () => void;
  tone?: Tone;
  disabled?: boolean;
};

export function CommandRow({
  dot = "muted",
  code,
  primary,
  secondary,
  meta,
  action,
  selected = false,
  onOpen,
  onFocus,
}: {
  dot?: Tone;
  code?: string;
  primary: ReactNode;
  secondary?: ReactNode;
  meta?: ReactNode;
  action?: CommandAction;
  selected?: boolean;
  onOpen?: () => void;
  onFocus?: () => void;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onMouseEnter={onFocus}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen?.();
          }
        }}
        className={`group flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors ${
          selected ? "bg-neutral-900 text-white" : "hover:bg-muted/60"
        }`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[dot]} ${
            selected ? "ring-2 ring-white/20" : ""
          }`}
        />
        {code ? (
          <span
            className={`hidden shrink-0 font-mono text-xs sm:inline ${
              selected ? "text-white/60" : "text-muted-foreground"
            }`}
          >
            {code}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p
            className={`truncate text-sm font-medium ${
              selected ? "text-white" : "text-foreground"
            }`}
          >
            {primary}
          </p>
          {secondary ? (
            <p
              className={`truncate text-xs ${
                selected ? "text-white/70" : "text-muted-foreground"
              }`}
            >
              {secondary}
            </p>
          ) : null}
        </div>
        {meta ? (
          <span
            className={`hidden shrink-0 text-xs sm:block ${
              selected ? "text-white/70" : "text-muted-foreground"
            }`}
          >
            {meta}
          </span>
        ) : null}
        {action ? (
          <button
            type="button"
            disabled={action.disabled}
            onClick={(e) => {
              e.stopPropagation();
              action.run();
            }}
            className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
              selected
                ? "border-white/30 text-white hover:bg-white/10"
                : `${ACTION_TONE[action.tone ?? "primary"]}`
            }`}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </li>
  );
}

const ACTION_TONE: Record<Tone, string> = {
  primary: "border-primary/30 text-primary hover:bg-primary/5",
  success: "border-emerald-300 text-emerald-700 hover:bg-emerald-50",
  warning: "border-amber-300 text-amber-800 hover:bg-amber-50",
  danger: "border-destructive/30 text-destructive hover:bg-destructive/5",
  muted: "border-border text-muted-foreground hover:bg-muted",
};

export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <li className="px-3 py-6 text-center text-sm text-muted-foreground">
      {children}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Keyboard navigation                                                */
/* ------------------------------------------------------------------ */

/**
 * Drives J/K (or ↑/↓) movement over a list, Enter to open the focused row, and
 * A to run its accept action. Attaches a single document-level listener that
 * no-ops while typing in a field, over an assign dropdown, or when disabled —
 * so it composes cleanly with the detail panel's own key handling (the two are
 * mutually exclusive via `enabled`).
 */
export function useListKeyboard({
  count,
  enabled,
  onOpen,
  onAccept,
  canAccept,
}: {
  count: number;
  enabled: boolean;
  onOpen: (index: number) => void;
  onAccept?: (index: number) => void;
  canAccept?: (index: number) => boolean;
}) {
  const [focused, setFocused] = useState(0);

  // Clamp on read rather than in an effect — the list can grow or shrink
  // underneath us, and deriving the safe cursor avoids a cascading setState.
  const safeFocused = count > 0 ? Math.min(focused, count - 1) : 0;

  useEffect(() => {
    if (!enabled || count === 0) return;

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable ||
        target.closest("[data-assign-dropdown]")
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocused(Math.min(safeFocused + 1, count - 1));
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocused(Math.max(safeFocused - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        onOpen(safeFocused);
      } else if (
        key === "a" &&
        onAccept &&
        (!canAccept || canAccept(safeFocused))
      ) {
        e.preventDefault();
        onAccept(safeFocused);
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, count, safeFocused, onOpen, onAccept, canAccept]);

  return { focused: safeFocused, setFocused };
}
