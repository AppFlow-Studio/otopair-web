"use client";

// Tab 4 · Flags & Quality — the correctness surface. Flag taxonomy parsed from
// errors[]/sanity_flags across the window, fill-rate + quotability
// distributions against the completion gate, per-field-family coverage, and the
// open review queue.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { BarRows, SegmentedControl, Skeleton, fmtNum } from "@/components/portal/ChartKit";
import { Panel, Empty, StatusPill, fmtPct } from "./helpers";

const WINDOWS = ["7", "14", "30"] as const;
type Win = (typeof WINDOWS)[number];

type FamilyMeta = {
  families?: Record<string, { filled: number; total: number }>;
  intervals?: { avg_applicable_fill_rate: number; samples: number };
  parts_quotability?: { avg_pct: number; samples: number };
  configs?: number;
};

export function FlagsTab({ token }: { token: string }) {
  const [win, setWin] = useState<Win>("14");
  const tax = useQuery(api.directorEnrichment.flagTaxonomy, { token, days: Number(win) });
  const dist = useQuery(api.directorEnrichment.qualityDistributions, { token, days: Number(win) });
  const review = useQuery(api.directorEnrichment.reviewQueueOpen, { token });
  const famStat = useQuery(api.portalStats.getStats, {
    token,
    keys: ["data.coverage.field_families"],
  });

  const famMeta = (famStat?.["data.coverage.field_families"]?.meta ?? null) as FamilyMeta | null;
  const familyRows = Object.entries(famMeta?.families ?? {})
    .map(([family, f]) => ({
      label: family,
      value: f.total > 0 ? f.filled / f.total : 0,
      sub: `${f.filled}/${f.total}`,
    }))
    .sort((a, b) => a.value - b.value);

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <SegmentedControl
          value={win}
          options={WINDOWS}
          onChange={setWin}
          labels={{ "7": "7d", "14": "14d", "30": "30d" }}
        />
      </div>

      {/* Flag taxonomy */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title="Error flags"
          sub={tax ? `${tax.runsWithAnyFlag}/${tax.runsScanned} runs flagged` : undefined}
        >
          {!tax ? (
            <Skeleton className="h-40 w-full" />
          ) : tax.errorBuckets.length === 0 ? (
            <Empty>No error flags in this window.</Empty>
          ) : (
            <BarRows
              color="#fcd34d"
              rows={tax.errorBuckets.map((b) => ({ label: b.key, value: b.count }))}
            />
          )}
        </Panel>

        <Panel title="Sanity flags">
          {!tax ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2">
                  <div className="text-lg font-bold text-red-700">{fmtNum(tax.sanityBySeverity.reject)}</div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-red-500">
                    reject
                  </div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2">
                  <div className="text-lg font-bold text-amber-700">{fmtNum(tax.sanityBySeverity.flag)}</div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-500">
                    flag
                  </div>
                </div>
              </div>
              {tax.sanityByField.length === 0 ? (
                <Empty>No sanity flags in this window.</Empty>
              ) : (
                <BarRows
                  color="#fca5a5"
                  rows={tax.sanityByField.slice(0, 8).map((f) => ({ label: f.field, value: f.count }))}
                />
              )}
            </div>
          )}
        </Panel>
      </div>

      {tax && tax.partPatternByMake.length > 0 && (
        <Panel title="Suspect part patterns" sub="by make">
          <BarRows
            color="#fca5a5"
            rows={tax.partPatternByMake.map((m) => ({ label: m.make, value: m.count }))}
          />
        </Panel>
      )}

      {/* Distributions vs completion gate */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Fill-rate distribution" sub={dist ? `${dist.configsScanned} configs · gate ≥70` : undefined}>
          {!dist ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarRows
              color="#93c5fd"
              rows={dist.fillRateHist.map((b) => ({
                label: b.bucket,
                value: b.count,
                sub: Number(b.bucket.split("-")[0]) >= 70 ? "≥gate" : undefined,
              }))}
            />
          )}
        </Panel>
        <Panel
          title="Quotability distribution"
          sub={dist ? `${dist.runsScanned} runs · gate ≥80` : undefined}
        >
          {!dist ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarRows
              color="#6ee7b7"
              rows={dist.quotabilityHist.map((b) => ({
                label: b.bucket,
                value: b.count,
                sub: Number(b.bucket.split("-")[0]) >= 80 ? "≥gate" : undefined,
              }))}
            />
          )}
        </Panel>
      </div>

      {/* Field-family coverage */}
      <Panel
        title="Field-family coverage"
        sub={
          famMeta?.parts_quotability
            ? `avg quotability ${fmtPct(famMeta.parts_quotability.avg_pct)}`
            : undefined
        }
      >
        {!famStat ? (
          <Skeleton className="h-40 w-full" />
        ) : familyRows.length === 0 ? (
          <Empty>No coverage snapshot yet.</Empty>
        ) : (
          <BarRows
            color="#a7f3d0"
            valueFormat={(v) => `${Math.round(v * 100)}%`}
            rows={familyRows}
          />
        )}
      </Panel>

      {/* Review queue */}
      <Panel title="Open review queue" sub={review ? `${review.length} items` : undefined}>
        {!review ? (
          <Skeleton className="h-24 w-full" />
        ) : review.length === 0 ? (
          <Empty>Review queue is clear.</Empty>
        ) : (
          <ul className="space-y-1.5">
            {review.slice(0, 20).map((r) => (
              <li key={String(r.id)} className="flex items-center gap-2 text-[12px]">
                <StatusPill status={r.status} />
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {r.sourceStream}
                </span>
                <span className="truncate text-slate-700">{r.title}</span>
                {r.vin && <span className="ml-auto shrink-0 font-mono text-slate-400">{r.vin}</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="px-1 text-[12px] text-slate-400">
        Completion gate (completionGate.ts): a config is <b>complete</b> only at fill-rate ≥ 70 AND
        quotability ≥ 0.8. {tax?.truncated && "Flag window truncated at 1000 runs. "}
        {fmtNum(tax?.runsScanned ?? 0)} runs scanned.
      </p>
    </div>
  );
}
