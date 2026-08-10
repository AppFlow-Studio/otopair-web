"use client";

/**
 * Settings design primitives — mirror the flat shop-onboarding language
 * (`app/(portal)/shop/setup/page.tsx`) so the two surfaces read as one system.
 *
 * The rules that make it "flat":
 *   - one card per section, never a card inside a card (no box-on-box)
 *   - semantic color tokens (`text-foreground`, `border-border`, `text-primary`),
 *     never hardcoded gray/blue
 *   - a section = eyebrow-free title + muted description, then content
 *   - inputs/labels/buttons share the exact onboarding classes below
 */

import type { ReactNode } from "react";

/** Matches the onboarding `inputClass` — use for inputs AND selects. */
export const FIELD_INPUT =
  "w-full rounded-lg border border-input bg-white px-3.5 py-2.5 text-sm text-foreground placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

/** Matches the onboarding `labelClass`. */
export const FIELD_LABEL = "mb-1.5 block text-sm font-medium text-foreground";

export const BTN_PRIMARY =
  "inline-flex items-center gap-2 rounded-lg border border-primary bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50";

export const BTN_SECONDARY =
  "inline-flex items-center gap-2 rounded-lg border border-input bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

/** One flat section card. Header = title + optional description, then content. */
export function SettingsCard({
  title,
  description,
  icon,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            {icon}
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** A flat sub-group inside a card — a small eyebrow, then content. No border,
 *  no background: that's what keeps it from becoming a box inside a box. */
export function SubSection({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {title}
      </p>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function AlertBanner({
  tone = "error",
  children,
}: {
  tone?: "error" | "success" | "warning";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    error: "border-destructive/20 bg-destructive/10 text-destructive",
    success: "border-success/20 bg-success/10 text-success",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}
