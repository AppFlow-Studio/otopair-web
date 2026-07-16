"use client";

// Zone 4b — growth & lifecycle signals: the previously-dark tables
// (referrals, reward wallets, smartcar connections, late-start SLA,
// urgency-tier demand) surfaced as one compact card row.

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { CARD_STATIC, PILL, MICRO_H, money, fmtNum, timeAgo, Skeleton } from "./shared";

type Signals = FunctionReturnType<typeof api.directorData.growthSignals> | undefined;

function SignalCard({
  title,
  value,
  sub,
  pills,
  amber,
}: {
  title: string;
  value: React.ReactNode;
  sub?: string;
  pills?: { label: string; n: number; tone?: "amber" | "emerald" | "red" }[];
  amber?: boolean;
}) {
  return (
    <div className={CARD_STATIC}>
      <div className={MICRO_H}>{title}</div>
      <div className={`mt-1.5 text-[22px] font-bold leading-7 ${amber ? "text-amber-600" : "text-slate-900"}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-slate-500">{sub}</div>}
      {pills && pills.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {pills.map((p) => (
            <span
              key={p.label}
              className={`${PILL} ${
                p.tone === "amber"
                  ? "bg-amber-50 text-amber-700"
                  : p.tone === "emerald"
                    ? "bg-emerald-50 text-emerald-700"
                    : p.tone === "red"
                      ? "bg-red-50 text-red-700"
                      : "bg-slate-100 text-slate-600"
              }`}
            >
              {p.label} {p.n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function GrowthSignals({ signals }: { signals: Signals }) {
  if (signals === undefined) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={CARD_STATIC}>
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    );
  }
  const g = signals;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <SignalCard
        title="Referrals · 90d"
        value={fmtNum(g.referrals.total_90d)}
        pills={[
          { label: "credited", n: g.referrals.credited, tone: "emerald" },
          { label: "pending", n: g.referrals.pending, tone: g.referrals.pending > 0 ? "amber" : undefined },
          { label: "cancelled", n: g.referrals.cancelled },
        ]}
      />
      <SignalCard
        title="Rewards liability"
        value={money(g.rewards.balance_total)}
        sub={`${fmtNum(g.rewards.wallets)}${g.rewards.truncated ? "+" : ""} wallets · ${fmtNum(g.rewards.deals)} deals live`}
      />
      <SignalCard
        title="Connected cars"
        value={fmtNum(g.connected_cars.total)}
        sub={g.connected_cars.last_sync != null ? `last sync ${timeAgo(g.connected_cars.last_sync)}` : "no syncs yet"}
        pills={Object.entries(g.connected_cars.by_status).map(([label, n]) => ({
          label,
          n,
          tone: label === "active" ? ("emerald" as const) : label === "error" ? ("red" as const) : undefined,
        }))}
      />
      <SignalCard
        title="Late-start SLA"
        value={fmtNum(g.late_starts.open)}
        sub="open monitors"
        amber={g.late_starts.open > 0}
        pills={Object.entries(g.late_starts.by_status).map(([label, n]) => ({ label, n }))}
      />
      <SignalCard
        title="Urgency events · 30d"
        value={`${fmtNum(g.urgency_30d.total)}${g.urgency_30d.truncated ? "+" : ""}`}
        sub="maintenance items changing tier"
        pills={Object.entries(g.urgency_30d.by_tier).map(([label, n]) => ({
          label,
          n,
          tone: label.toLowerCase() === "now" ? ("red" as const) : label.toLowerCase() === "soon" ? ("amber" as const) : undefined,
        }))}
      />
    </div>
  );
}
