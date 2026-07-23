"use client";

// Enrichment Console — shared primitives (mirrors control-room's local helpers
// + the Data-portal ChartKit barrel). Palette doctrine: emerald healthy/money,
// blue activity, amber attention, red failure, slate neutral.

import { Component, type ReactNode } from "react";

export { CARD, CARD_STATIC } from "@/components/portal/ChartKit";

// Client mirror of convex/portalStats.ts SLO_THRESHOLDS (that const is not
// exported to the client bundle). Keep in sync.
export const SLO_BANDS: Record<string, { target: number; alert: number; direction: "above" | "below" }> = {
  "slo.enrichment_success_rate_7d": { target: 0.8, alert: 0.7, direction: "above" },
  "slo.avg_confidence": { target: 0.75, alert: 0.65, direction: "above" },
  "slo.review_queue_depth": { target: 50, alert: 100, direction: "below" },
};

// ─── formatting ──────────────────────────────────────────────────────────────

export function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Tolerates both 0–1 and 0–100 encodings. */
export function fmtPct(rate: number | null | undefined, digits = 0): string {
  if (rate == null) return "—";
  const pct = rate <= 1 ? rate * 100 : rate;
  return `${pct.toFixed(digits)}%`;
}

export function fmtCost(usd: number | null | undefined, digits = 2): string {
  if (usd == null) return "—";
  return `$${usd.toFixed(digits)}`;
}

// ─── run-status pill ─────────────────────────────────────────────────────────

const LIVE = new Set(["started", "scraping", "batch1", "batch2"]);

export function StatusPill({ status }: { status: string }) {
  const base = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
  let cls = "bg-sky-50 text-sky-700";
  if (status === "complete") cls = "bg-emerald-50 text-emerald-700";
  else if (status === "failed") cls = "bg-red-50 text-red-700";
  else if (status === "timeout") cls = "bg-amber-50 text-amber-700";
  else if (LIVE.has(status)) cls = "bg-blue-50 text-blue-700";
  return <span className={`${base} ${cls}`}>{status}</span>;
}

// ─── layout primitives ───────────────────────────────────────────────────────

export function Panel({
  title,
  sub,
  right,
  children,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {title}
          {sub && <span className="ml-1.5 font-normal text-slate-400">· {sub}</span>}
        </h2>
        {right}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
      ))}
    </div>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`pb-2 pr-4 ${className}`}>{children}</th>;
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {children}
      </tr>
    </thead>
  );
}

/** Per-zone error boundary — one bad data shape can't blank the whole page. */
export class Zone extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          The {this.props.label} panel failed to render. Reload; if it persists, the underlying data
          shape changed.
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── triggers (owned by the page, opened by the tabs) ────────────────────────

export type TriggerRequest =
  | { kind: "reenrich"; vin: string }
  | { kind: "purge"; vin: string }
  | { kind: "unstick"; runId: string; label: string };

export type OpenTrigger = (req: TriggerRequest) => void;
