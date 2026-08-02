"use client";

// Zone 6 — the old Data Health page, condensed to one strip. SLO threshold
// model carried over verbatim; every stat links to its deep page.

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { CARD, fmtNum, Skeleton } from "./shared";

type Stats = FunctionReturnType<typeof api.portalStats.getStats> | undefined;
type StatRow = { value: number; meta?: unknown; computed_at: number } | null;

type SloState = "green" | "amber" | "red" | "neutral";

type SloDef = {
  key: string;
  label: string;
  target: number;
  alert: number;
  direction: "above" | "below";
  format: (v: number) => string;
  href: string;
};

// Same thresholds the old Data Health overview used (Data spec §4B).
export const SLO_DEFS: SloDef[] = [
  {
    key: "slo.enrichment_success_rate_7d",
    label: "Enrichment 7d",
    target: 0.8,
    alert: 0.7,
    direction: "above",
    format: (v) => `${Math.round(v * 100)}%`,
    href: "/director/data/insights",
  },
  {
    key: "slo.avg_confidence",
    label: "Avg confidence",
    target: 0.75,
    alert: 0.65,
    direction: "above",
    format: (v) => v.toFixed(2),
    href: "/director/data/insights",
  },
  {
    key: "slo.review_queue_depth",
    label: "Review queue",
    target: 50,
    alert: 100,
    direction: "below",
    format: (v) => String(Math.round(v)),
    href: "/director/data/review-queue",
  },
  {
    key: "slo.spec_variance_rate_7d",
    label: "Spec variance 7d",
    target: 0.05,
    alert: 0.1,
    direction: "below",
    format: (v) => `${(v * 100).toFixed(1)}%`,
    href: "/director/data/verification",
  },
  {
    key: "slo.job_confirmation_rate_7d",
    label: "Job confirmation 7d",
    target: 0.9,
    alert: 0.8,
    direction: "above",
    format: (v) => `${Math.round(v * 100)}%`,
    href: "/director/data/insights",
  },
];

function sloState(def: SloDef, value: number): SloState {
  if (def.direction === "above") {
    if (value >= def.target) return "green";
    if (value < def.alert) return "red";
    return "amber";
  }
  if (value <= def.target) return "green";
  if (value > def.alert) return "red";
  return "amber";
}

const DOT: Record<SloState, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  neutral: "bg-slate-300",
};

function metaNumber(meta: unknown, key: string): number | null {
  if (meta && typeof meta === "object" && key in (meta as Record<string, unknown>)) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return null;
}

function MiniStat({
  href,
  value,
  label,
  dot,
  amberWhenPositive,
}: {
  href: string;
  value: string;
  label: string;
  dot?: SloState;
  amberWhenPositive?: boolean;
}) {
  const amber = amberWhenPositive && value !== "0" && value !== "—";
  return (
    <Link href={href} className="group flex items-center gap-2">
      {dot && <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[dot]}`} />}
      <span
        className={`text-[15px] font-bold ${amber ? "text-amber-600" : "text-slate-900"} group-hover:text-blue-700`}
      >
        {value}
      </span>
      <span className="text-[11px] text-slate-500">{label}</span>
    </Link>
  );
}

export function DataHealthStrip({ stats }: { stats: Stats }) {
  const stat = (key: string): StatRow | undefined =>
    stats === undefined ? undefined : ((stats[key] as StatRow) ?? null);

  const runsStat = stat("data.runs_7d");
  const cost7d = runsStat ? metaNumber(runsStat.meta, "cost_7d_usd") : null;

  return (
    <section className={CARD}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Data platform</h2>
        <Link
          href="/director/data/insights"
          className="text-[12px] font-semibold text-blue-600 hover:underline"
        >
          Deep dive →
        </Link>
      </div>

      {stats === undefined ? (
        <Skeleton className="mt-4 h-8 w-full" />
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3">
          {SLO_DEFS.map((def) => {
            const s = stat(def.key);
            const samples = s ? metaNumber(s.meta, "samples") : null;
            const noData = s == null || samples === 0;
            return (
              <MiniStat
                key={def.key}
                href={def.href}
                dot={noData ? "neutral" : sloState(def, s!.value)}
                value={noData ? "—" : def.format(s!.value)}
                label={def.label}
              />
            );
          })}

          <span className="hidden h-8 w-px bg-slate-100 sm:block" />

          <MiniStat
            href="/director/data/control-room"
            value={stat("data.vin_queue_pending") ? fmtNum(stat("data.vin_queue_pending")!.value) : "—"}
            label="VINs pending"
          />
          <MiniStat
            href="/director/data/costs"
            value={
              runsStat
                ? `${fmtNum(runsStat.value)}${cost7d != null ? ` · $${cost7d.toFixed(0)}` : ""}`
                : "—"
            }
            label="pipeline runs 7d"
          />
          <MiniStat
            href="/director/data/provenance"
            value={stat("data.incidents_open") ? fmtNum(stat("data.incidents_open")!.value) : "—"}
            label="open incidents"
            amberWhenPositive
          />
          <MiniStat
            href="/director/data/catalog"
            value={stat("data.evidence_total") ? fmtNum(stat("data.evidence_total")!.value) : "—"}
            label="evidence rows"
          />
        </div>
      )}
    </section>
  );
}
