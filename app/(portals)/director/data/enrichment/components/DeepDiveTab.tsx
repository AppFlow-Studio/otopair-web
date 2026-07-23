"use client";

// Tab 5 · Deep-Dive — one config end-to-end. Pick a config (VIN / YMMT /
// config_key), then see its variant facets, latest run + flags, run timeline,
// parts + prices, and per-field evidence. Row actions re-run or purge the VIN.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ConfigPicker, type PickedConfig } from "@/components/portal/ConfigPicker";
import { Skeleton, timeAgo } from "@/components/portal/ChartKit";
import { RunTrace } from "./RunTrace";
import {
  Panel,
  Empty,
  TableSkeleton,
  THead,
  Th,
  StatusPill,
  fmtPct,
  fmtCost,
  fmtDuration,
  fmtWhen,
  type OpenTrigger,
} from "./helpers";

function Facet({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-0.5 text-[13px] text-slate-800">{value ?? "—"}</div>
    </div>
  );
}

export function DeepDiveTab({
  token,
  selected,
  onSelect,
  openTrigger,
}: {
  token: string;
  selected: PickedConfig | null;
  onSelect: (c: PickedConfig | null) => void;
  openTrigger: OpenTrigger;
}) {
  const configId = selected ? (selected.id as Id<"vehicle_configs">) : null;
  const ov = useQuery(
    api.directorEnrichment.configOverview,
    configId ? { token, vehicleConfigId: configId } : "skip",
  );
  const runs = useQuery(
    api.directorEnrichment.runsForConfig,
    configId ? { token, vehicleConfigId: configId } : "skip",
  );
  const parts = useQuery(
    api.directorEnrichment.partsForConfig,
    configId ? { token, vehicleConfigId: configId } : "skip",
  );
  const vins = useQuery(
    api.directorEnrichment.vinsForConfig,
    configId ? { token, vehicleConfigId: configId } : "skip",
  );
  const latestRunId = ov?.latestRun?.id ?? null;
  const evidence = useQuery(
    api.directorEnrichment.evidenceForRun,
    latestRunId ? { token, enrichmentRunId: latestRunId } : "skip",
  );

  // Which run the Pipeline-trace zone replays — defaults to the latest, click a
  // timeline row to switch.
  const [traceRunId, setTraceRunId] = useState<Id<"enrichment_runs"> | null>(null);
  const activeTraceRunId = traceRunId ?? latestRunId;

  const vin = vins && vins.length > 0 ? vins[0].vin : null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <ConfigPicker token={token} selected={selected} onSelect={onSelect} label="Config" />
      </div>

      {!selected ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center">
          <Empty>Pick a config by VIN, year/make/model, or config_key to inspect it end-to-end.</Empty>
        </div>
      ) : ov === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : ov === null ? (
        <Empty>That config no longer exists.</Empty>
      ) : (
        <>
          {/* Variant facets + actions */}
          <Panel
            title="Variant fingerprint"
            sub="resolved facets"
            right={
              <div className="flex gap-1.5">
                <button
                  disabled={!vin}
                  title={vin ? `Re-enrich ${vin}` : "No VIN attached to this config"}
                  onClick={() => vin && openTrigger({ kind: "reenrich", vin })}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Re-run
                </button>
                <button
                  disabled={!vin}
                  title={vin ? `Purge + re-enrich ${vin}` : "No VIN attached to this config"}
                  onClick={() => vin && openTrigger({ kind: "purge", vin })}
                  className="rounded-md border border-red-200 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Purge + re-enrich
                </button>
              </div>
            }
          >
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Facet
                label="Vehicle"
                value={`${ov.facets.year} ${ov.facets.make} ${ov.facets.model}${ov.facets.trim ? ` ${ov.facets.trim}` : ""}`}
              />
              <Facet label="Engine" value={ov.facets.engineLabel} />
              <Facet label="Transmission" value={ov.facets.transmissionLabel} />
              <Facet label="Drivetrain" value={ov.facets.drivetrain} />
              <Facet
                label="Status"
                value={ov.facets.enrichmentStatus ? <StatusPill status={ov.facets.enrichmentStatus} /> : "—"}
              />
              <Facet label="Fill rate" value={fmtPct(ov.facets.fillRate)} />
              <Facet label="Confidence" value={fmtPct(ov.facets.confidenceAvg)} />
              <Facet label="VIN" value={vin ? <span className="font-mono">{vin}</span> : "none attached"} />
            </div>
            <p className="mt-3 text-[11px] text-slate-400">
              The full variant fingerprint is computed at decode but not persisted today (log-only) —
              these facets are the stored engine/transmission/drivetrain resolution.
            </p>
          </Panel>

          {/* Latest run flags */}
          {ov.latestRun && (
            <Panel
              title="Latest run"
              sub={`${ov.latestRun.status} · ${fmtWhen(ov.latestRun.at)}`}
              right={<StatusPill status={ov.latestRun.status} />}
            >
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-1 text-[13px]">
                  <div>Fill: <b>{fmtPct(ov.latestRun.fillRate)}</b> · Applicable: <b>{fmtPct(ov.latestRun.applicableFillRate)}</b></div>
                  <div>Quotability: <b>{fmtPct(ov.latestRun.quotabilityPct)}</b></div>
                  <div>Cost: <b>{fmtCost(ov.latestRun.costUsd)}</b></div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Errors ({ov.latestRun.errors.length})
                  </div>
                  {ov.latestRun.errors.length === 0 ? (
                    <div className="mt-1 text-[12px] text-slate-400">none</div>
                  ) : (
                    <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-amber-700">
                      {ov.latestRun.errors.slice(0, 12).map((e, i) => (
                        <li key={i} className="truncate">{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Sanity flags ({ov.latestRun.sanityFlags.length}) · Gaps ({ov.latestRun.fieldGaps.length})
                  </div>
                  <ul className="mt-1 space-y-0.5 text-[11px]">
                    {ov.latestRun.sanityFlags.slice(0, 6).map((s, i) => (
                      <li key={`s${i}`} className="truncate">
                        <span className={s.severity === "reject" ? "text-red-600" : "text-amber-600"}>
                          {s.severity}
                        </span>{" "}
                        <span className="font-mono text-slate-600">{s.field}</span>: {s.reason}
                      </li>
                    ))}
                    {ov.latestRun.fieldGaps.slice(0, 6).map((g, i) => (
                      <li key={`g${i}`} className="truncate text-slate-500">
                        <span className="font-mono">{g.field}</span>: {g.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Panel>
          )}

          {/* Run timeline */}
          <Panel title="Run timeline" sub="latest 20 · click a row to trace it below">
            {runs === undefined ? (
              <TableSkeleton />
            ) : runs.length === 0 ? (
              <Empty>No runs for this config.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <THead>
                    <Th>Status</Th>
                    <Th>Trigger</Th>
                    <Th className="text-right">Fill</Th>
                    <Th className="text-right">Quot.</Th>
                    <Th className="text-right">Cost</Th>
                    <Th className="text-right">Duration</Th>
                    <Th className="text-right">Flags</Th>
                    <Th>When</Th>
                  </THead>
                  <tbody>
                    {runs.map((r) => (
                      <tr
                        key={String(r.id)}
                        onClick={() => setTraceRunId(r.id)}
                        className={`cursor-pointer border-b border-slate-50 hover:bg-slate-50 ${
                          r.id === activeTraceRunId ? "bg-blue-50/60" : ""
                        }`}
                      >
                        <td className="py-2 pr-4"><StatusPill status={r.status} /></td>
                        <td className="py-2 pr-4 text-slate-500">{r.trigger ?? "—"}</td>
                        <td className="py-2 pr-4 text-right text-slate-600">{fmtPct(r.fillRate)}</td>
                        <td className="py-2 pr-4 text-right text-slate-600">{fmtPct(r.quotabilityPct)}</td>
                        <td className="py-2 pr-4 text-right text-slate-600">{fmtCost(r.costUsd)}</td>
                        <td className="py-2 pr-4 text-right text-slate-500">{fmtDuration(r.durationMs)}</td>
                        <td className="py-2 pr-4 text-right text-amber-600">
                          {r.errorCount + r.sanityFlagCount || ""}
                        </td>
                        <td className="py-2 pr-4 text-slate-400">{timeAgo(r.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Pipeline trace — step-by-step replay of the selected run */}
          <RunTrace token={token} runId={activeTraceRunId} />

          {/* Parts */}
          <Panel title="Parts & fitments" sub={parts ? `${parts.length}` : undefined}>
            {parts === undefined ? (
              <TableSkeleton />
            ) : parts.length === 0 ? (
              <Empty>No parts attached to this config.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <THead>
                    <Th>OEM #</Th>
                    <Th>Part</Th>
                    <Th>Role</Th>
                    <Th className="text-right">Conf.</Th>
                    <Th className="text-right">Sources</Th>
                    <Th className="text-right">Price</Th>
                  </THead>
                  <tbody>
                    {parts.map((p) => (
                      <tr key={String(p.fitmentId)} className="border-b border-slate-50">
                        <td className="py-2 pr-4 font-mono text-[12px] text-slate-700">{p.oemNumber}</td>
                        <td className="max-w-[220px] truncate py-2 pr-4 text-slate-700">{p.name}</td>
                        <td className="py-2 pr-4 text-slate-500">{p.serviceRole ?? "—"}</td>
                        <td className="py-2 pr-4 text-right text-slate-600">{fmtPct(p.confidence)}</td>
                        <td className="py-2 pr-4 text-right text-slate-500">{p.sourceCount ?? "—"}</td>
                        <td className="py-2 pr-4 text-right text-slate-700">
                          {p.price != null ? fmtCost(p.price) : <span className="text-red-500">no price</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Evidence */}
          <Panel title="Evidence" sub={latestRunId ? "latest run" : undefined}>
            {!latestRunId ? (
              <Empty>No run to show evidence for.</Empty>
            ) : evidence === undefined ? (
              <TableSkeleton />
            ) : evidence.length === 0 ? (
              <Empty>No evidence recorded for the latest run.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <THead>
                    <Th>Field</Th>
                    <Th>Value</Th>
                    <Th>Source</Th>
                    <Th className="text-right">Conf.</Th>
                  </THead>
                  <tbody>
                    {evidence.slice(0, 100).map((e, i) => (
                      <tr key={i} className="border-b border-slate-50">
                        <td className="py-2 pr-4 font-mono text-[12px] text-slate-700">{e.field}</td>
                        <td className="max-w-[220px] truncate py-2 pr-4 text-slate-700">{e.value ?? "—"}</td>
                        <td className="py-2 pr-4 text-slate-500">{e.sourceDomain ?? "—"}</td>
                        <td className="py-2 pr-4 text-right text-slate-600">{fmtPct(e.confidence)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
