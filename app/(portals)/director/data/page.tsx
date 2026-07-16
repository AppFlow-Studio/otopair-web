"use client";

// Director Command Center — /director/data. The single pane of glass over
// all OtoPair operations, top-to-bottom by urgency of the question answered:
//   1 Pulse band     — is the business OK right now?
//   2 Trend + rail   — what's the trajectory, and what needs my intervention?
//   3 Shop activity  — who is producing supply and demand?
//   4 Usage & AI     — is the product being used, and what does it cost?
//   5 Actions        — what did my team and the marketplace just do?
//   6 Data platform  — is the data engine healthy? (the old page, condensed)
// All reads; every item deep-links into the page that owns the fix.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { PERIODS, PERIOD_DAYS, SegmentedControl, type Period } from "./components/shared";
import { PulseBand } from "./components/PulseBand";
import { RevenueChart } from "./components/RevenueChart";
import { AttentionRail } from "./components/AttentionRail";
import { ShopActivity } from "./components/ShopActivity";
import { UsageCards } from "./components/UsageCards";
import { GrowthSignals } from "./components/GrowthSignals";
import { ActionFeeds } from "./components/ActionFeeds";
import { DataHealthStrip, SLO_DEFS } from "./components/DataHealthStrip";

export default function CommandCenterPage() {
  const { token } = usePortalSession();
  const [period, setPeriod] = useState<Period>("30d");

  // Zone 1 — pulse (today numbers are always today; period drives the rest).
  const kpis = useQuery(api.opsOverview.kpis, { token });
  const metrics = useQuery(api.directorOverview.overviewMetrics, { token, period });
  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: [
      "ops.active_users_7d",
      ...SLO_DEFS.map((d) => d.key),
      "data.vin_queue_pending",
      "data.runs_7d",
      "data.incidents_open",
      "data.evidence_total",
    ],
  });
  const attention = useQuery(api.directorData.attention, { token });

  // Zone 2 — trend chart.
  const chart = useQuery(api.directorOverview.overviewRevenueChart, {
    token,
    days: PERIOD_DAYS[period],
  });

  // Zone 3 — shop activity.
  const topShops = useQuery(api.directorOverview.overviewTopShops, { token, period, limit: 8 });
  const topMechanics = useQuery(api.directorOverview.overviewTopMechanics, {
    token,
    period,
    limit: 8,
  });
  const serviceMix = useQuery(api.directorOverview.overviewServiceMix, { token, period, limit: 8 });
  const schedule = useQuery(api.directorOverview.overviewBookingsToday, {
    token,
    period: "today",
    limit: 6,
  });

  // Zone 4 — usage.
  const apiSeries = useQuery(api.dataInsights.apiUsageSeries, { token });
  const otoUsage = useQuery(api.directorData.otoUsage, { token });
  const eventPulse = useQuery(api.directorData.appEventPulse, { token });

  // Zone 4b — growth & lifecycle (previously-dark tables).
  const signals = useQuery(api.directorData.growthSignals, { token });

  // Zone 5 — actions.
  const audit = useQuery(api.audit_log.listRecent, { token });
  const activityFeed = useQuery(api.opsOverview.activityFeed, { token, limit: 12 });

  const activeUsersStat = stats?.["ops.active_users_7d"];
  const activeUsers7d =
    stats === undefined ? undefined : activeUsersStat ? activeUsersStat.value : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Command Center</h1>
          <p className="text-[13px] text-slate-500">Everything OtoPair, live.</p>
        </div>
        <SegmentedControl
          value={period}
          options={PERIODS}
          onChange={setPeriod}
          labels={{ today: "Today", "7d": "7d", "30d": "30d", "90d": "90d" }}
        />
      </div>

      {/* Zone 1 — pulse band */}
      <PulseBand
        kpis={kpis}
        metrics={metrics}
        activeUsers7d={activeUsers7d}
        attention={attention}
        period={period}
      />

      {/* Zone 2 — trend + attention rail */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <RevenueChart data={chart} />
        <AttentionRail attention={attention} />
      </div>

      {/* Zone 3 — shop activity */}
      <ShopActivity shops={topShops} mechanics={topMechanics} mix={serviceMix} schedule={schedule} />

      {/* Zone 4 — usage & AI */}
      <UsageCards apiSeries={apiSeries} oto={otoUsage} pulse={eventPulse} />

      {/* Zone 4b — growth & lifecycle signals */}
      <GrowthSignals signals={signals} />

      {/* Zone 5 — action feeds */}
      <ActionFeeds audit={audit} feed={activityFeed} />

      {/* Zone 6 — data platform strip */}
      <DataHealthStrip stats={stats} />
    </div>
  );
}
