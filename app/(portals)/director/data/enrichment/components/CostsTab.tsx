"use client";

// Tab 3 · Costs — token-derived spend (the stored estimated_cost_usd column is
// dead, so every figure here is recomputed from token counts). Daily cost +
// token trend, top-cost runs, web-search volume. Never dual-axis.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  TrendArea,
  TrendBars,
  BarRows,
  StatTile,
  SegmentedControl,
  Skeleton,
  money,
  fmtNum,
} from "@/components/portal/ChartKit";
import { Panel, Empty } from "./helpers";

const WINDOWS = ["7", "14", "30"] as const;
type Win = (typeof WINDOWS)[number];

export function CostsTab({ token }: { token: string }) {
  const [win, setWin] = useState<Win>("14");
  const daily = useQuery(api.directorEnrichment.costDaily, { token });
  const top = useQuery(api.directorEnrichment.topCostRuns, { token, days: Number(win) });

  const dailyChart = (daily ?? []).map((d) => ({ ...d, tokens: d.tokensIn + d.tokensOut }));
  const runs = top?.runs ?? [];
  const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
  const avgCost = runs.length ? totalCost / runs.length : 0;
  const maxCost = runs.length ? runs[0].costUsd : 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label={`Spend · ${win}d`}
          value={top ? money(totalCost, { cents: true }) : <Skeleton />}
          sparkColor="#10b981"
        />
        <StatTile
          label="Avg / run"
          value={top ? money(avgCost, { cents: true }) : <Skeleton />}
        />
        <StatTile
          label="Costliest run"
          value={top ? money(maxCost, { cents: true }) : <Skeleton />}
        />
        <StatTile label="Runs" value={top ? fmtNum(top.runsScanned) : <Skeleton />} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Daily cost" sub="token-derived">
          <TrendArea data={dailyChart} dataKey="costUsd" name="Cost" color="#10b981" isMoney />
        </Panel>
        <Panel title="Daily tokens" sub="in + out">
          <TrendBars data={dailyChart} dataKey="tokens" name="Tokens" color="#93c5fd" />
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Top-cost runs" sub={`${win}d`} right={<Window win={win} setWin={setWin} />}>
          {!top ? (
            <Skeleton className="h-40 w-full" />
          ) : runs.length === 0 ? (
            <Empty>No runs in this window.</Empty>
          ) : (
            <BarRows
              color="#6ee7b7"
              valueFormat={(v) => money(v, { cents: true })}
              rows={runs.slice(0, 10).map((r) => ({
                label: <span className="font-mono">{r.configKey ?? "(deleted)"}</span>,
                value: r.costUsd,
              }))}
            />
          )}
        </Panel>

        <Panel title="Web searches" sub="daily count (not $-priced)">
          <TrendBars data={dailyChart} dataKey="webSearches" name="Searches" color="#c4b5fd" />
        </Panel>
      </div>

      <p className="px-1 text-[12px] leading-relaxed text-slate-400">
        <b>Methodology:</b> cost is computed from token counts at a blended $0.80/MTok in + $4.00/MTok
        out (matching the pipeline). The <code>estimated_cost_usd</code> and{" "}
        <code>total_firecrawl_credits</code> columns are never written by the pipeline, so they are
        ignored here. FireCrawl/web-search volume is shown as counts, not dollars.
      </p>
    </div>
  );
}

function Window({ win, setWin }: { win: Win; setWin: (w: Win) => void }) {
  return (
    <SegmentedControl
      value={win}
      options={WINDOWS}
      onChange={setWin}
      labels={{ "7": "7d", "14": "14d", "30": "30d" }}
    />
  );
}
