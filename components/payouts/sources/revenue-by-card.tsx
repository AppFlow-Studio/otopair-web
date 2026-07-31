"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { RankedBars, type RankedRow } from "../charts";
import {
  Card,
  CardEyebrow,
  ChartTableView,
  EmptyHint,
  Skeleton,
  formatMoneyCents,
} from "../shared";
import { cn } from "@/lib/utils";
import type { ShopPaymentInsights } from "../types";

const TOP_N = 6;

/** Collapses the tail into "Other" so the chart doesn't grow unbounded. */
function rank(
  rows: { key: string; label: string; cents: number; sub?: string | null }[],
): RankedRow[] {
  const sorted = [...rows].sort((a, b) => b.cents - a.cents);
  const head = sorted.slice(0, TOP_N);
  const tail = sorted.slice(TOP_N);
  const out: RankedRow[] = head.map((r) => ({
    key: r.key,
    label: r.label,
    valueCents: r.cents,
    sublabel: r.sub ?? null,
  }));
  if (tail.length > 0) {
    out.push({
      key: "__other",
      label: `Other (${tail.length})`,
      valueCents: tail.reduce((s, r) => s + r.cents, 0),
      sublabel: null,
    });
  }
  return out;
}

export function RevenueByCard({
  insights,
  loading,
}: {
  insights: ShopPaymentInsights | null | undefined;
  loading: boolean;
}) {
  const [dimension, setDimension] = useState<"service" | "mechanic">("service");

  const services = insights?.revenueByService ?? [];
  const mechanics = insights?.revenueByMechanic ?? [];

  const rows =
    dimension === "service"
      ? rank(
          services.map((s) => ({
            key: String(s.serviceId ?? s.name),
            label: s.name,
            cents: s.capturedCents,
            sub: `${s.jobCount} job${s.jobCount === 1 ? "" : "s"}`,
          })),
        )
      : rank(
          mechanics.map((m) => ({
            key: String(m.mechanicId ?? m.name),
            label: m.name,
            cents: m.capturedCents,
            sub: `${m.jobCount} job${m.jobCount === 1 ? "" : "s"} · ${formatMoneyCents(
              m.avgTicketCents,
            )} avg`,
          })),
        );

  // Multi-service bookings have no per-service dollar split in the data, so
  // their revenue is allocated evenly. Saying so is the difference between a
  // number and a guess presented as a number.
  const hasEvenSplit =
    dimension === "service" && services.some((s) => s.allocation === "even_split");

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <CardEyebrow>Where revenue comes from</CardEyebrow>
        <div className="flex rounded-lg bg-muted p-0.5">
          {(["service", "mechanic"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDimension(d)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                dimension === d
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="mt-4 space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-2 h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyHint>No captured revenue in this range.</EmptyHint>
      ) : (
        <>
          <div className="mt-4">
            <RankedBars rows={rows} />
          </div>

          {hasEvenSplit ? (
            <p className="mt-4 flex items-start gap-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              Jobs covering several services are split evenly between them — the
              data has no per-service price.
            </p>
          ) : null}

          <ChartTableView
            caption={`Captured revenue by ${dimension}`}
            columns={[dimension === "service" ? "Service" : "Mechanic", "Captured"]}
            rows={rows.map((r) => [r.label, formatMoneyCents(r.valueCents)])}
          />
        </>
      )}
    </Card>
  );
}
