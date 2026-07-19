"use client";

// Data · Vehicle Catalog — Config Workspace /data/catalog/[id] (Data spec §4B
// Atlas, T5-ish two panes). Zones: workspace header (identity 20px + fill ring
// + verification chip + actions) → body grid: left = specs field list (click a
// field) + enrichment runs; right = evidence trail for the selected field with
// layer badge (A/B/C/D/E/X) derived from source_type + confidence — the
// derivation formula is shown on hover (title attr), never invented.
// Read-only page: Re-enrich / Flag / Export from the spec are pipeline actions
// owned by the Control Room triggers, not this workspace.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { AuditDrawer } from "@/components/portal/AuditDrawer";
import { Ceremony } from "@/components/portal/Ceremony";
import { useMutation } from "convex/react";

const CARD = "rounded-xl border border-slate-200 bg-white p-5";
const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

// --- Layer badge (derivation shared with the external API's sellability gate
//     in convex/lib/dataLayers.ts; rendered honestly: badge + confidence
//     number, formula visible on hover). Letters per spec §4B: A blue /
//     B grey / C amber / D green / E purple / X red. ---------------------------
import { deriveLayer, LAYER_FORMULA, type LayerLetter } from "@/convex/lib/dataLayers";

const LAYER_CLASSES: Record<LayerLetter, string> = {
  A: "bg-blue-100 text-blue-700",
  B: "bg-slate-200 text-slate-700",
  C: "bg-amber-100 text-amber-700",
  D: "bg-emerald-100 text-emerald-700",
  E: "bg-purple-100 text-purple-700",
  X: "bg-red-100 text-red-700",
};

function LayerBadge({ sourceType, confidence }: { sourceType: string | null; confidence: number | null }) {
  const layer = { ...deriveLayer(sourceType, confidence), classes: "" };
  layer.classes = LAYER_CLASSES[layer.letter];
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`Layer ${layer.letter} — ${layer.reason}; confidence ${confidence ?? "n/a"}. Formula: ${LAYER_FORMULA}`}
    >
      <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold ${layer.classes}`}>
        {layer.letter}
      </span>
      <span className="text-[11px] text-slate-500">{confidence == null ? "—" : confidence.toFixed(2)}</span>
    </span>
  );
}

function statusPill(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (["complete", "completed", "enriched", "verified", "success"].includes(s)) return `${PILL} bg-emerald-50 text-emerald-700`;
  if (["pending", "partial", "in_progress", "enriching", "running"].includes(s)) return `${PILL} bg-amber-50 text-amber-700`;
  if (["failed", "error"].includes(s)) return `${PILL} bg-red-50 text-red-700`;
  return `${PILL} bg-slate-100 text-slate-600`;
}

function FillRing({ pct }: { pct: number | null }) {
  const r = 14;
  const circ = 2 * Math.PI * r;
  const frac = pct == null ? 0 : Math.max(0, Math.min(1, pct / 100));
  const color = pct == null ? "#cbd5e1" : pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center" title={pct == null ? "fill rate not computed" : `fill rate ${pct.toFixed(0)}%`}>
      <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="#e2e8f0" strokeWidth="4" />
        <circle cx="18" cy="18" r={r} fill="none" stroke={color} strokeWidth="4" strokeDasharray={`${circ * frac} ${circ}`} strokeLinecap="round" />
      </svg>
      <span className="absolute text-[9px] font-semibold text-slate-600">{pct == null ? "—" : Math.round(pct)}</span>
    </span>
  );
}

function fmtDateTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ConfigWorkspacePage() {
  const params = useParams<{ id: string }>();
  const configId = params.id as Id<"vehicle_configs">;
  const { token } = usePortalSession();

  const ws: FunctionReturnType<typeof api.dataCatalog.configWorkspace> | undefined =
    useQuery(api.dataCatalog.configWorkspace, { token, id: configId });
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [imageFetchOpen, setImageFetchOpen] = useState(false);
  const canTrigger = useCan("data.trigger");
  const fetchImage = useMutation(api.dataCatalog.fetchConfigImage);

  const evidence: FunctionReturnType<typeof api.dataCatalog.fieldEvidence> | undefined =
    useQuery(
      api.dataCatalog.fieldEvidence,
      selectedField ? { token, configId, fieldName: selectedField } : "skip",
    );

  if (ws === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-96 animate-pulse rounded bg-slate-100" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="h-96 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-96 animate-pulse rounded-xl bg-slate-100" />
        </div>
      </div>
    );
  }

  if (ws === null) {
    return (
      <div className={CARD}>
        <p className="text-sm text-slate-600">
          This vehicle config does not exist (it may have been merged or removed).
        </p>
        <Link href="/director/data/catalog" className="mt-2 inline-block text-[13px] text-blue-700 hover:underline">
          ← Back to Vehicle Catalog
        </Link>
      </div>
    );
  }

  const selected = ws.fields.find((f) => f.field_name === selectedField) ?? null;
  const groups = [...new Set(ws.fields.map((f) => f.group))];

  return (
    <div className="space-y-6">
      {/* Zone 1 — workspace header */}
      <div className={`${CARD} flex flex-wrap items-center gap-4`}>
        {/* Vehicle render — VD/EVOX cache on the config (YMMT-level).
            The licensed VD image folder will replace these URLs with
            self-hosted media; the card stays the same. */}
        {ws.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={ws.image_url}
            alt={`${ws.year} ${ws.make} ${ws.model}`}
            className="h-20 w-32 shrink-0 rounded-lg bg-slate-50 object-contain"
            title="Vehicle Databases render (cached at the config level)"
          />
        ) : (
          <div className="flex h-20 w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-200">
            <span className="text-[10px] text-slate-400">no image cached</span>
            {canTrigger && (
              <button
                onClick={() => setImageFetchOpen(true)}
                className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50"
              >
                Fetch from VD
              </button>
            )}
          </div>
        )}
        <FillRing pct={ws.fill_rate} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-semibold text-slate-900">
              {ws.year} {ws.make} {ws.model}
              {ws.engine_label ? ` · ${ws.engine_label}` : ""}
            </h1>
            <span className={statusPill(ws.enrichment_status)}>{ws.enrichment_status ?? "no status"}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
            {ws.trim_name && <span>{ws.trim_name}</span>}
            {ws.chassis_code && <span className="font-mono">{ws.chassis_code}</span>}
            <span className={`${PILL} bg-slate-100 text-slate-600`}>
              {ws.verification_count} verification{ws.verification_count === 1 ? "" : "s"}
            </span>
            {ws.pricing_tier && <span className={`${PILL} bg-blue-50 text-blue-700`}>tier: {ws.pricing_tier}</span>}
            {ws.enrichment_version && <span className="font-mono">v{ws.enrichment_version}</span>}
            <span>
              conf avg {ws.confidence_avg == null ? "—" : ws.confidence_avg.toFixed(2)} · last enriched{" "}
              {fmtDateTime(ws.last_enriched_at)}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setAuditOpen(true)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
          >
            Audit
          </button>
          <Link
            href="/director/data/catalog"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
          >
            All configs
          </Link>
        </div>
      </div>

      {/* Zone 2 — two-pane body */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[46%_1fr]">
        {/* Left pane: specs field list + runs */}
        <div className="space-y-4">
          <div className={CARD}>
            <h2 className="text-sm font-semibold text-slate-900">Specs</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Select a field to inspect its evidence trail on the right.
            </p>
            {ws.fields.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No spec fields resolved for this config.</p>
            ) : (
              groups.map((group) => (
                <div key={group} className="mt-4">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group}</h3>
                  <div className="mt-1.5 divide-y divide-slate-50">
                    {ws.fields
                      .filter((f) => f.group === group)
                      .map((f) => (
                        <button
                          key={f.field_name}
                          onClick={() => setSelectedField(f.field_name)}
                          className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-slate-50 ${
                            selectedField === f.field_name ? "bg-blue-50 hover:bg-blue-50" : ""
                          }`}
                        >
                          <span className="text-[12px] text-slate-500">{f.label}</span>
                          <span className="flex items-center gap-2">
                            <span className={`text-[14px] ${f.value == null ? "text-slate-300" : "text-slate-900"}`}>
                              {f.value ?? "empty"}
                            </span>
                            <span className={`${PILL} bg-slate-100 text-slate-500`} title={`evidence keyed as entity_type "${f.entity_type}"`}>
                              {f.entity_type}
                            </span>
                          </span>
                        </button>
                      ))}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className={CARD}>
            <h2 className="text-sm font-semibold text-slate-900">Enrichment runs</h2>
            {ws.runs.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No enrichment runs recorded for this config yet.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">Trigger</th>
                      <th className="pb-2 pr-4">Fill</th>
                      <th className="pb-2 pr-4">Cost</th>
                      <th className="pb-2 pr-4">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ws.runs.map((r) => (
                      <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="py-2.5 pr-4">
                          <span className={statusPill(r.status)}>{r.status}</span>
                          {r.error_count > 0 && (
                            <span className={`${PILL} ml-1 bg-red-50 text-red-700`}>{r.error_count} err</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 text-slate-600">{r.trigger ?? "—"}</td>
                        <td className="py-2.5 pr-4 text-slate-600">
                          {r.fill_rate != null ? `${Math.round(r.fill_rate)}%` : "—"}
                          {r.fields_filled != null && r.fields_total != null && (
                            <span className="text-slate-400"> ({r.fields_filled}/{r.fields_total})</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 text-slate-600">
                          {r.estimated_cost_usd != null ? `$${r.estimated_cost_usd.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2.5 pr-4 text-slate-500">{fmtDateTime(r.started_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right pane: per-field evidence */}
        <div className={CARD}>
          {selected === null ? (
            <div className="flex h-full min-h-48 items-center justify-center">
              <p className="max-w-64 text-center text-sm text-slate-400">
                Select a spec field on the left to see every evidence observation behind it.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    Evidence · <span className="font-mono text-[13px]">{selected.field_name}</span>
                  </h2>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    current value: {selected.value ?? "empty"}
                  </p>
                </div>
                {evidence && evidence.rows.length > 0 && (
                  <LayerBadge
                    sourceType={evidence.rows.find((r) => r.is_latest)?.source_type ?? evidence.rows[0].source_type}
                    confidence={evidence.rows.find((r) => r.is_latest)?.confidence ?? evidence.rows[0].confidence}
                  />
                )}
              </div>

              {evidence === undefined ? (
                <div className="mt-4 space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded bg-slate-100" />
                  ))}
                </div>
              ) : evidence === null ? (
                <p className="mt-4 text-sm text-red-600">Config disappeared while loading evidence.</p>
              ) : evidence.rows.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">
                  No evidence recorded for this field — the value{" "}
                  {selected.value == null
                    ? "has never been filled."
                    : "predates evidence logging or was written by a path that skips it."}
                </p>
              ) : (
                <>
                  {!evidence.canonical && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                      Rows found under legacy keying ({evidence.entity_type_used} / …
                      {evidence.entity_id_used.slice(-6)}) — written before the entity-id fix.
                    </p>
                  )}
                  <ul className="mt-3 space-y-2">
                    {evidence.rows.map((row) => (
                      <li
                        key={row.id}
                        className={`rounded-lg border px-3 py-2.5 ${
                          row.is_latest ? "border-blue-200 bg-blue-50/40" : "border-slate-100"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[14px] font-medium text-slate-900">
                            {row.observed_value ?? "—"}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {row.is_latest && <span className={`${PILL} bg-blue-100 text-blue-700`}>latest</span>}
                            <LayerBadge sourceType={row.source_type} confidence={row.confidence} />
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                          <span className="font-medium">{row.source_domain ?? "no domain"}</span>
                          <span className={`${PILL} bg-slate-100 text-slate-500`}>
                            {row.source_type ?? "unknown source_type"}
                          </span>
                          <span>{fmtDateTime(row.observed_at)}</span>
                          {row.enrichment_run_id && (
                            <span className="font-mono text-slate-400">run …{String(row.enrichment_run_id).slice(-6)}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <AuditDrawer
        open={auditOpen}
        onOpenChange={setAuditOpen}
        entityType="vehicle_config"
        entityId={String(configId)}
      />

      {/* Image fetch ceremony — one VDB vehicle-images call, 30-min cooldown */}
      <Ceremony
        open={imageFetchOpen}
        onOpenChange={setImageFetchOpen}
        title={`Fetch vehicle image — ${ws.year} ${ws.make} ${ws.model}`}
        confirmLabel="Fetch"
        summary={
          <>
            Calls the Vehicle Databases vehicle-images API once (VIN-first if a decoded
            sibling exists, else year/make/model/trim) and caches the render on this
            config. 30-minute cooldown per config; the licensed VD image folder will
            replace these with self-hosted media later.
          </>
        }
        onConfirm={async (reason) => {
          await fetchImage({ token, reason, configId });
        }}
      />
    </div>
  );
}
