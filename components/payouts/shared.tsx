"use client";

/**
 * shared.tsx — feature-local primitives for /payouts.
 *
 * Follows the convention established by components/customers/shared.tsx rather
 * than adding half-populated files to components/ui/, which is mostly Magic-UI
 * effects rather than the shadcn primitive set.
 *
 * Money formatting is split by UNIT, not by precision, because the page reads
 * dollars from the Stripe route and cents from Convex and the two must never
 * be silently interchangeable.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PaymentDisplayStatus, RangeKey } from "./types";

/* ------------------------------------------------------------------ */
/*  Money                                                              */
/* ------------------------------------------------------------------ */

const USD_2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** CENTS in. Everything from Convex. */
export function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return USD_2.format(cents / 100);
}

/** CENTS in, whole dollars out. For headline figures. */
export function formatMoneyCentsWhole(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return USD_0.format(cents / 100);
}

/** DOLLARS in. Everything from /api/stripe/payouts/overview. */
export function formatMoneyDollars(dollars: number | null | undefined): string {
  if (dollars == null || !Number.isFinite(dollars)) return "—";
  return USD_2.format(dollars);
}

/** DOLLARS in, whole dollars out. */
export function formatMoneyDollarsWhole(
  dollars: number | null | undefined,
): string {
  if (dollars == null || !Number.isFinite(dollars)) return "—";
  return USD_0.format(dollars);
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

/* ------------------------------------------------------------------ */
/*  Dates                                                              */
/* ------------------------------------------------------------------ */

export function formatDateTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDateShort(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatRelative(ms: number | null): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return formatDateShort(ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return formatDateShort(ms);
}

/** YYYY-MM-DD (a chart bucket key) → "Jul 24". */
export function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function rangeWindow(range: RangeKey, days: number) {
  const endMs = Date.now();
  return { startMs: endMs - days * 86_400_000, endMs };
}

/* ------------------------------------------------------------------ */
/*  Chart colours                                                      */
/* ------------------------------------------------------------------ */

/**
 * recharts takes colour props as strings, so the tokens are read as
 * `var(--chart-N)` rather than Tailwind classes. Every mark colour on this
 * page comes from here — that is what lets a validated dark palette drop into
 * globals.css later without touching a component.
 */
export const CHART = {
  money: "var(--chart-1)",
  activity: "var(--chart-2)",
  attention: "var(--chart-3)",
  alternate: "var(--chart-4)",
  failure: "var(--chart-5)",
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
} as const;

export const CATEGORICAL = [
  CHART.money,
  CHART.activity,
  CHART.attention,
  CHART.alternate,
  CHART.failure,
] as const;

/* ------------------------------------------------------------------ */
/*  Status vocabulary                                                  */
/* ------------------------------------------------------------------ */

/**
 * Follows lib/booking-status.ts: semantic tokens where they exist, raw
 * Tailwind where they don't. There is no --warning or --info token and one
 * screen is not a reason to invent them.
 */
export const STATUS_STYLE: Record<
  PaymentDisplayStatus,
  { label: string; className: string }
> = {
  captured: {
    label: "Succeeded",
    className:
      "text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
  },
  authorized: {
    label: "Pending capture",
    className: "text-amber-600 bg-amber-50",
  },
  partially_refunded: {
    label: "Partially refunded",
    className: "text-indigo-600 bg-indigo-50",
  },
  refunded: {
    label: "Refunded",
    className: "text-muted-foreground bg-muted",
  },
  disputed: {
    label: "Disputed",
    className: "text-destructive bg-destructive/10",
  },
  dispute_lost: {
    label: "Dispute lost",
    className: "text-destructive bg-destructive/10",
  },
  dispute_won: {
    label: "Dispute won",
    className:
      "text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
  },
  failed: { label: "Failed", className: "text-destructive bg-destructive/10" },
  cancelled: {
    label: "Cancelled",
    className: "text-muted-foreground bg-muted",
  },
  unknown: { label: "Unknown", className: "text-muted-foreground bg-muted" },
};

/* ------------------------------------------------------------------ */
/*  Primitives                                                         */
/* ------------------------------------------------------------------ */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-muted", className)} />
  );
}

/** Section card. One shape for every card on the page. */
export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-6 shadow-sm",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Holds the last defined value while a query refetches.
 *
 * Convex useQuery returns undefined on every argument change, so switching
 * 30d → 90d would blank four cards at once. Callers render the held value at
 * reduced opacity instead of flashing skeletons.
 */
export function usePreviousDefined<T>(value: T | undefined): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  if (value !== undefined) ref.current = value;
  return value === undefined ? ref.current : value;
}

/** Debounce, matching components/customers/shared.tsx's 200ms default. */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The table twin every chart needs.
 *
 * A chart alone is unreadable to a screen reader and unusable to anyone who
 * wants the numbers. Collapsed by default so it costs nothing visually.
 */
export function ChartTableView({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  if (rows.length === 0) return null;
  return (
    <details className="mt-3 group">
      <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        View as table
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={c}
                  scope="col"
                  className={cn(
                    "border-b border-border py-1.5 font-medium text-muted-foreground",
                    i === 0 ? "text-left" : "text-right",
                  )}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "border-b border-border/50 py-1.5 text-foreground",
                      ci === 0 ? "text-left" : "text-right tabular-nums",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Legend for any chart with two or more series. Colour is never the only
 *  encoding — the label carries the meaning. */
export function ChartLegend({
  items,
}: {
  items: { color: string; label: string }[];
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((it) => (
        <li
          key={it.label}
          className="flex items-center gap-1.5 text-xs text-foreground/75"
        >
          <span
            className="size-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: it.color }}
            aria-hidden="true"
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/** Chart tooltip chrome, so every chart's tooltip looks the same. */
export function TooltipShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 shadow-md">
      {children}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
  );
}
