"use client";

// Data · Provenance & Incidents — /data/provenance (Data spec §10.4).
// Layer distribution chips → the two moat lines (ours = D empirical + E
// human-verified rising, X shrinking; repo taxonomy annotated — the spec's
// "D = mechanic" maps to repo E) → Layer-B exposure table with JSON export
// ("for legal day") → incident cards with declare/resolve ceremonies.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());

type MoatPoint = {
  date: string;
  by_layer: { A: number; B: number; C: number; D: number; E: number; X: number };
};
type IncidentRow = {
  id: string;
  number: number;
  title: string;
  severity: "sev1" | "sev2" | "sev3";
  status: "open" | "monitoring" | "resolved";
  summary: string;
  root_cause: string | null;
  scope_note: string | null;
  affected_entity_type: string | null;
  affected_count: number | null;
  declared_by: string;
  declared_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution_note: string | null;
};

const LAYER_STYLE: Record<string, string> = {
  A: "bg-blue-50 text-blue-700",
  B: "bg-slate-200 text-slate-700",
  C: "bg-amber-50 text-amber-700",
  D: "bg-emerald-50 text-emerald-700",
  E: "bg-purple-50 text-purple-700",
  X: "bg-red-50 text-red-700",
};

const SEV_STYLE: Record<string, string> = {
  sev1: "bg-red-600 text-white",
  sev2: "bg-amber-500 text-white",
  sev3: "bg-slate-400 text-white",
};

function MoatChart({ points }: { points: MoatPoint[] }) {
  const W = 640;
  const H = 160;
  const PAD = 28;
  const ours = points.map((p) => p.by_layer.D + p.by_layer.E);
  const xs = points.map((p) => p.by_layer.X);
  const maxY = Math.max(...ours, ...xs, 1);
  const x = (i: number) =>
    PAD + (points.length === 1 ? (W - 2 * PAD) / 2 : (i / (points.length - 1)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - (v / maxY) * (H - 2 * PAD);
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} className="max-w-full">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e2e8f0" />
        <path d={path(ours)} fill="none" stroke="#10b981" strokeWidth="2.5" />
        <path d={path(xs)} fill="none" stroke="#ef4444" strokeWidth="2.5" strokeDasharray="4 3" />
        {points.map((p, i) => (
          <g key={p.date}>
            <circle cx={x(i)} cy={y(ours[i])} r="3" fill="#10b981">
              <title>{`${p.date}: ours (D+E) = ${ours[i]}`}</title>
            </circle>
            <circle cx={x(i)} cy={y(xs[i])} r="3" fill="#ef4444">
              <title>{`${p.date}: X = ${xs[i]}`}</title>
            </circle>
          </g>
        ))}
        <text x={PAD} y={14} className="fill-slate-500 text-[10px]">
          max {maxY.toLocaleString("en-US")}
        </text>
      </svg>
      <div className="mt-1 flex gap-4 text-[11px] text-slate-500">
        <span>
          <span className="mr-1 inline-block h-2 w-4 bg-emerald-500 align-middle" /> ours = D
          empirical + E human-verified (should rise)
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-4 border-b-2 border-dashed border-red-500 align-middle" />{" "}
          X untraceable (should shrink)
        </span>
      </div>
    </div>
  );
}

export default function ProvenancePage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");

  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: ["data.layer_distribution", "data.layer_b_exposure"],
  });
  const moat = useQuery(api.dataProvenance.moatSeries, { token });
  const incidents = useQuery(api.dataProvenance.listIncidents, { token });
  const declare = useMutation(api.dataProvenance.declareIncident);
  const setStatus = useMutation(api.dataProvenance.setIncidentStatus);

  const [declareOpen, setDeclareOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    severity: "sev2" as "sev1" | "sev2" | "sev3",
    summary: "",
    root_cause: "",
    affected_count: "",
  });
  const [statusTarget, setStatusTarget] = useState<{
    row: IncidentRow;
    status: "open" | "monitoring" | "resolved";
  } | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");

  const dist = stats?.["data.layer_distribution"];
  const distMeta = (dist?.meta ?? null) as { by_layer?: Record<string, number> } | null;
  const exposure = stats?.["data.layer_b_exposure"];
  const exposureMeta = (exposure?.meta ?? null) as {
    by_field?: { field: string; n: number }[];
    definition?: string;
  } | null;

  const exportExposure = () => {
    const payload = JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        total: exposure?.value ?? 0,
        computed_at: exposure ? new Date(exposure.computed_at).toISOString() : null,
        definition: exposureMeta?.definition,
        by_field: exposureMeta?.by_field ?? [],
      },
      null,
      2,
    );
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `layer-b-exposure-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Provenance &amp; Incidents</h1>
        {canWrite && (
          <button
            onClick={() => setDeclareOpen(true)}
            className="ml-auto rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
          >
            Declare incident
          </button>
        )}
      </div>

      {/* Layer distribution */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Layer distribution{" "}
          <span className="font-normal text-slate-400">
            (latest evidence rows{dist ? `, computed ${fmtDate(dist.computed_at)}` : ""})
          </span>
        </h2>
        {stats === undefined ? (
          <div className="mt-3 h-8 animate-pulse rounded-lg bg-slate-100" />
        ) : dist == null ? (
          <p className="mt-3 text-sm text-slate-500">
            No layer snapshot yet — run{" "}
            <span className="font-mono">portalStats:recomputeEvidenceStats</span>.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(distMeta?.by_layer ?? {}).map(([layer, n]) => (
              <span key={layer} className={`${pill} ${LAYER_STYLE[layer] ?? "bg-slate-100"}`}>
                {layer} · {n.toLocaleString("en-US")}
              </span>
            ))}
            <span className="self-center text-[12px] text-slate-400">
              of {dist.value.toLocaleString("en-US")} latest rows
            </span>
          </div>
        )}
      </div>

      {/* Moat lines */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">The two moat lines</h2>
        <p className="mt-1 text-[12px] text-slate-500">
          Repo taxonomy: D = empirical, E = human-verified (the spec&apos;s
          &quot;D = mechanic&quot; maps to repo E). Daily snapshots accumulate from the
          sweep&apos;s deploy day — the trend is honest, not backfilled.
        </p>
        {moat === undefined ? (
          <div className="mt-3 h-40 animate-pulse rounded-lg bg-slate-100" />
        ) : moat.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No daily snapshots yet.</p>
        ) : moat.length === 1 ? (
          <div className="mt-3 text-sm text-slate-600">
            First snapshot ({moat[0].date}): ours (D+E) ={" "}
            {(moat[0].by_layer.D + moat[0].by_layer.E).toLocaleString("en-US")} · X ={" "}
            {moat[0].by_layer.X.toLocaleString("en-US")} — the lines start drawing at the
            second snapshot.
          </div>
        ) : (
          <div className="mt-3">
            <MoatChart points={moat as MoatPoint[]} />
          </div>
        )}
      </div>

      {/* Layer B exposure */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Layer B exposure</h2>
          <span className={`${pill} bg-slate-200 text-slate-700`}>
            {exposure == null ? "—" : exposure.value.toLocaleString("en-US")} rows
          </span>
          <button
            onClick={exportExposure}
            disabled={exposure == null}
            className="ml-auto rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Export JSON (for legal day)
          </button>
        </div>
        <p className="mt-1 text-[12px] text-slate-500">
          {exposureMeta?.definition ??
            "Latest evidence rows whose derived layer is B excluding NHTSA — the same derivation the external API gate uses."}
        </p>
        {(exposureMeta?.by_field ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-emerald-700">
            Zero licensed-B exposure in latest evidence on this deployment — every layer-B
            row is the public-domain NHTSA carve-out.
          </p>
        ) : (
          <table className="mt-3 w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="py-1.5">Field</th>
                <th className="py-1.5">Rows</th>
              </tr>
            </thead>
            <tbody>
              {exposureMeta!.by_field!.map((f) => (
                <tr key={f.field} className="border-b border-slate-50">
                  <td className="py-1.5 font-mono text-[12px] text-slate-700">{f.field}</td>
                  <td className="py-1.5 text-slate-600">{f.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Incidents */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Incidents</h2>
        {incidents === undefined ? (
          <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
        ) : incidents.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            No incidents recorded — run{" "}
            <span className="font-mono">migrations/seedDataIncidents:seed</span> to load the
            two historical records.
          </div>
        ) : (
          (incidents as IncidentRow[]).map((inc) => (
            <div key={inc.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-bold text-slate-900">#{inc.number}</span>
                <span className="text-[14px] font-semibold text-slate-800">{inc.title}</span>
                <span className={`${pill} ${SEV_STYLE[inc.severity]}`}>{inc.severity}</span>
                <span
                  className={`${pill} ${
                    inc.status === "open"
                      ? "bg-red-50 text-red-700"
                      : inc.status === "monitoring"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {inc.status}
                </span>
                {inc.affected_count != null && (
                  <span className={`${pill} bg-slate-100 text-slate-600`}>
                    {inc.affected_count} {inc.affected_entity_type ?? "entities"}
                  </span>
                )}
                <span className="ml-auto text-[12px] text-slate-400">
                  declared {fmtDate(inc.declared_at)} by {inc.declared_by}
                </span>
              </div>
              <p className="mt-2 text-[13px] text-slate-600">{inc.summary}</p>
              {inc.root_cause ? (
                <p className="mt-1.5 text-[12px] text-slate-500">
                  <span className="font-semibold">Root cause:</span> {inc.root_cause}
                </p>
              ) : (
                inc.status !== "resolved" && (
                  <p className="mt-1.5 text-[12px] font-medium text-amber-700">
                    Root cause pending.
                  </p>
                )
              )}
              {inc.scope_note && (
                <p className="mt-1 text-[12px] text-slate-500">
                  <span className="font-semibold">Scope:</span> {inc.scope_note}
                </p>
              )}
              {inc.status === "resolved" && inc.resolution_note && (
                <p className="mt-1 text-[12px] text-emerald-700">
                  <span className="font-semibold">Resolution:</span> {inc.resolution_note}{" "}
                  ({fmtDate(inc.resolved_at)} by {inc.resolved_by})
                </p>
              )}
              {canWrite && inc.status !== "resolved" && (
                <div className="mt-2 flex gap-2">
                  {inc.status !== "monitoring" && (
                    <button
                      onClick={() => setStatusTarget({ row: inc, status: "monitoring" })}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-amber-600 hover:bg-amber-50"
                    >
                      → monitoring
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setResolutionNote("");
                      setStatusTarget({ row: inc, status: "resolved" });
                    }}
                    className="rounded-md px-2 py-1 text-[12px] font-medium text-emerald-600 hover:bg-emerald-50"
                  >
                    Resolve
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Declare ceremony */}
      <Ceremony
        open={declareOpen}
        onOpenChange={setDeclareOpen}
        title="Declare data incident"
        destructive
        confirmLabel="Declare"
        summary={
          <div className="space-y-2">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Title — e.g. Cross-make fitment contamination"
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
            <div className="flex gap-2">
              <select
                value={form.severity}
                onChange={(e) =>
                  setForm({ ...form, severity: e.target.value as typeof form.severity })
                }
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="sev1">sev1 — customer-visible wrong data</option>
                <option value="sev2">sev2 — systemic quality defect</option>
                <option value="sev3">sev3 — contained / low blast radius</option>
              </select>
              <input
                value={form.affected_count}
                onChange={(e) => setForm({ ...form, affected_count: e.target.value })}
                placeholder="Affected count"
                className="w-32 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </div>
            <textarea
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              placeholder="Summary — what's wrong, how it was detected"
              rows={2}
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
            <input
              value={form.root_cause}
              onChange={(e) => setForm({ ...form, root_cause: e.target.value })}
              placeholder="Root cause (leave empty if pending)"
              className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
          </div>
        }
        onConfirm={async (reason) => {
          const affected = parseInt(form.affected_count, 10);
          await declare({
            token,
            reason,
            title: form.title,
            severity: form.severity,
            summary: form.summary,
            root_cause: form.root_cause || undefined,
            affected_count: isNaN(affected) ? undefined : affected,
          });
          setForm({ title: "", severity: "sev2", summary: "", root_cause: "", affected_count: "" });
        }}
      />
      {/* Status-change ceremony */}
      <Ceremony
        open={statusTarget !== null}
        onOpenChange={(o) => !o && setStatusTarget(null)}
        title={
          statusTarget?.status === "resolved"
            ? `Resolve incident #${statusTarget?.row.number}`
            : `Move #${statusTarget?.row.number} to ${statusTarget?.status}`
        }
        summary={
          <div className="space-y-2">
            <div>
              {statusTarget?.row.title}: {statusTarget?.row.status} → {statusTarget?.status}
            </div>
            {statusTarget?.status === "resolved" && (
              <textarea
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                placeholder="Resolution note (required) — what fixed it, with evidence"
                rows={2}
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            )}
          </div>
        }
        onConfirm={async (reason) => {
          if (!statusTarget) return;
          await setStatus({
            token,
            reason,
            id: statusTarget.row.id as Id<"data_incidents">,
            status: statusTarget.status,
            resolution_note: statusTarget.status === "resolved" ? resolutionNote : undefined,
          });
        }}
      />
    </div>
  );
}
