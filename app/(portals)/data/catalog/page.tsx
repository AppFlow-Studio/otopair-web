"use client";

// Data · Vehicle Catalog — /data/catalog (Data spec §4B Atlas: drill + T3
// workspace). Spec drill is Makes → Models → Trims → workspace; the live
// deployment carries 384 configs, so this renders the honest flat drill:
// header → filter row (make / search / status) → configs table → workspace
// link per row. Spec discrepancy noted in build return.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

const CARD = "rounded-xl border border-slate-200 bg-white p-5";
const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

function statusPill(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (["complete", "completed", "enriched", "verified"].includes(s)) return `${PILL} bg-emerald-50 text-emerald-700`;
  if (["pending", "partial", "in_progress", "enriching"].includes(s)) return `${PILL} bg-amber-50 text-amber-700`;
  if (["failed", "error"].includes(s)) return `${PILL} bg-red-50 text-red-700`;
  return `${PILL} bg-slate-100 text-slate-600`;
}

/** 36px fill ring per spec drill cards — SVG donut, honest % or dash. */
function FillRing({ pct }: { pct: number | null }) {
  const r = 14;
  const circ = 2 * Math.PI * r;
  const frac = pct == null ? 0 : Math.max(0, Math.min(1, pct / 100));
  const color = pct == null ? "#cbd5e1" : pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center" title={pct == null ? "fill rate not computed" : `fill rate ${pct.toFixed(0)}%`}>
      <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="#e2e8f0" strokeWidth="4" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeDasharray={`${circ * frac} ${circ}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[9px] font-semibold text-slate-600">
        {pct == null ? "—" : Math.round(pct)}
      </span>
    </span>
  );
}

export default function VehicleCatalogPage() {
  const { token } = usePortalSession();
  const data: FunctionReturnType<typeof api.dataCatalog.listConfigs> | undefined =
    useQuery(api.dataCatalog.listConfigs, { token });
  const stats = useQuery(api.portalStats.getStats, {
    token,
    keys: ["data.vehicle_configs_total"],
  });

  const [makeFilter, setMakeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const makes = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.rows.map((r) => r.make))].sort();
  }, [data]);

  const statuses = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.rows.map((r) => r.enrichment_status ?? "(none)"))].sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (makeFilter !== "all" && r.make !== makeFilter) return false;
      if (statusFilter !== "all" && (r.enrichment_status ?? "(none)") !== statusFilter) return false;
      if (q) {
        const hay = `${r.year} ${r.make} ${r.model} ${r.trim_name ?? ""} ${r.engine_label ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, makeFilter, statusFilter, search]);

  const avgFill = useMemo(() => {
    const withFill = filtered.filter((r) => r.fill_rate != null);
    if (withFill.length === 0) return null;
    return withFill.reduce((s, r) => s + (r.fill_rate ?? 0), 0) / withFill.length;
  }, [filtered]);

  const total = stats === undefined ? undefined : (stats["data.vehicle_configs_total"]?.value ?? null);

  return (
    <div className="space-y-6">
      {/* Zone 1 — header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Vehicle Catalog</h1>
          <p className="mt-1 text-[13px] text-slate-500">
            Year / make / model / trim / engine configs — click a row to open its workspace.
          </p>
        </div>
        <div className="flex items-end gap-8">
          <div>
            <div className="text-2xl font-bold text-slate-900">
              {total === undefined ? "…" : total === null ? "—" : total.toLocaleString("en-US")}
            </div>
            <div className="text-xs font-medium text-slate-500">configs (lifetime stat)</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900">
              {data === undefined ? "…" : avgFill == null ? "—" : `${avgFill.toFixed(0)}%`}
            </div>
            <div className="text-xs font-medium text-slate-500">avg fill (filtered)</div>
          </div>
        </div>
      </div>

      {/* Zone 2 — filter row */}
      <div className={`${CARD} flex flex-wrap items-center gap-3 py-3`}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search year, make, model, trim, engine…"
          className="w-72 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
        <select
          value={makeFilter}
          onChange={(e) => setMakeFilter(e.target.value)}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-[13px] text-slate-700"
        >
          <option value="all">All makes</option>
          {makes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-[13px] text-slate-700"
        >
          <option value="all">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {data !== undefined && (
          <span className="ml-auto text-[12px] text-slate-500">
            {filtered.length} of {data.rows.length} loaded
            {data.truncated && <span className="text-amber-600"> (first 500 shown)</span>}
          </span>
        )}
      </div>

      {/* Zone 3 — configs table */}
      <div className={CARD}>
        {data === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
          </div>
        ) : data.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            No vehicle configs exist on this deployment yet — the enrichment pipeline creates them
            as VINs are decoded.
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            No configs match the current filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Fill</th>
                  <th className="pb-2 pr-4">Vehicle</th>
                  <th className="pb-2 pr-4">Trim</th>
                  <th className="pb-2 pr-4">Engine</th>
                  <th className="pb-2 pr-4">Drive</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Conf</th>
                  <th className="pb-2 pr-4">Verifs</th>
                  <th className="pb-2 pr-4">Last enriched</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2.5 pr-4">
                      <FillRing pct={r.fill_rate} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/data/catalog/${r.id}`}
                        className="font-medium text-slate-900 hover:text-blue-700 hover:underline"
                      >
                        {r.year} {r.make} {r.model}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">{r.trim_name ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-slate-600">{r.engine_label ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-slate-600">{r.drivetrain ?? "—"}</td>
                    <td className="py-2.5 pr-4">
                      <span className={statusPill(r.enrichment_status)}>
                        {r.enrichment_status ?? "none"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">
                      {r.confidence_avg == null ? "—" : r.confidence_avg.toFixed(2)}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">{r.verification_count}</td>
                    <td className="py-2.5 pr-4 text-slate-500">
                      {r.last_enriched_at
                        ? new Date(r.last_enriched_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
