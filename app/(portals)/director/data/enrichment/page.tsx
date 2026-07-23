"use client";

// Data · Enrichment Console (/director/data/enrichment) — a single page with
// five in-page tabs (Overview · Live Runs · Costs · Flags & Quality ·
// Deep-Dive), matching the sources/control-room convention. The page owns the
// tab state, the shared Deep-Dive config selection, and the trigger Ceremony
// (force-unstick / re-run / purge — gated by data.trigger). The Data-portal
// group layout already provides shell + auth + session.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { PageHeader } from "@/components/portal/ChartKit";
import { Ceremony } from "@/components/portal/Ceremony";
import type { PickedConfig } from "@/components/portal/ConfigPicker";
import { Zone, type TriggerRequest } from "./components/helpers";
import { OverviewTab } from "./components/OverviewTab";
import { LiveRunsTab } from "./components/LiveRunsTab";
import { CostsTab } from "./components/CostsTab";
import { FlagsTab } from "./components/FlagsTab";
import { DeepDiveTab } from "./components/DeepDiveTab";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Live Runs" },
  { id: "costs", label: "Costs" },
  { id: "flags", label: "Flags & Quality" },
  { id: "config", label: "Deep-Dive" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function EnrichmentConsolePage() {
  const { token } = usePortalSession();
  const canTrigger = useCan("data.trigger");
  const [tab, setTab] = useState<TabId>("overview");
  const [selected, setSelected] = useState<PickedConfig | null>(null);
  const [ceremony, setCeremony] = useState<TriggerRequest | null>(null);

  const reEnrich = useMutation(api.dataControlRoom.triggerReEnrich);
  const purge = useMutation(api.directorEnrichment.purgeAndReenrich);
  const unstick = useMutation(api.directorEnrichment.forceUnstickRun);

  const goDeepDive = (configId: string, configKey: string | null) => {
    setSelected({ id: configId, config_key: configKey ?? configId });
    setTab("config");
  };

  const runTrigger = async (reason: string) => {
    if (!ceremony) return;
    if (ceremony.kind === "reenrich") await reEnrich({ token, reason, vin: ceremony.vin });
    else if (ceremony.kind === "purge") await purge({ token, reason, vin: ceremony.vin });
    else await unstick({ token, reason, runId: ceremony.runId as Id<"enrichment_runs"> });
  };

  const ceremonyMeta = (req: TriggerRequest) => {
    if (req.kind === "reenrich")
      return {
        title: "Re-enrich VIN",
        destructive: false,
        summary: (
          <>
            Queue a fresh Tier-1 enrichment run for VIN{" "}
            <span className="font-mono font-semibold text-slate-900">{req.vin}</span>. Rate-limited
            to once per VIN every 30 minutes.
          </>
        ),
      };
    if (req.kind === "purge")
      return {
        title: "Purge + re-enrich VIN",
        destructive: true,
        summary: (
          <>
            <b>Wipe all enrichment data</b> for the config behind VIN{" "}
            <span className="font-mono font-semibold text-slate-900">{req.vin}</span> and re-run from
            scratch. This is destructive and cannot be undone.
          </>
        ),
      };
    return {
      title: "Force-unstick run",
      destructive: true,
      summary: (
        <>
          Mark the stale in-flight run for{" "}
          <span className="font-mono font-semibold text-slate-900">{req.label}</span> as{" "}
          <b>failed</b> so a new run can take over. Only eligible while its heartbeat is stale
          (&gt;15 min).
        </>
      ),
    };
  };

  const openTrigger = (req: TriggerRequest) => {
    if (!canTrigger) return;
    setCeremony(req);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Enrichment Console"
        subtitle="Live pipeline observability — runs, cost, quality, flags, and per-config deep-dive."
      />

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${
              tab === t.id
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!canTrigger && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] text-slate-500">
          Read-only: your role lacks the <code>data.trigger</code> capability, so run triggers are
          disabled.
        </div>
      )}

      {tab === "overview" && (
        <Zone label="Overview">
          <OverviewTab token={token} goTab={(t) => setTab(t as TabId)} />
        </Zone>
      )}
      {tab === "runs" && (
        <Zone label="Live Runs">
          <LiveRunsTab token={token} openTrigger={openTrigger} goDeepDive={goDeepDive} />
        </Zone>
      )}
      {tab === "costs" && (
        <Zone label="Costs">
          <CostsTab token={token} />
        </Zone>
      )}
      {tab === "flags" && (
        <Zone label="Flags & Quality">
          <FlagsTab token={token} />
        </Zone>
      )}
      {tab === "config" && (
        <Zone label="Deep-Dive">
          <DeepDiveTab
            token={token}
            selected={selected}
            onSelect={setSelected}
            openTrigger={openTrigger}
          />
        </Zone>
      )}

      {ceremony && (
        <Ceremony
          open
          onOpenChange={(open) => !open && setCeremony(null)}
          title={ceremonyMeta(ceremony).title}
          summary={ceremonyMeta(ceremony).summary}
          destructive={ceremonyMeta(ceremony).destructive}
          confirmLabel="Trigger"
          onConfirm={runTrigger}
        />
      )}
    </div>
  );
}
