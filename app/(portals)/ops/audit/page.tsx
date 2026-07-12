"use client";

// Ops · Audit Log — /ops/audit (spec §5.13, Atlas T2 variant).
// Zones: header (title + count + entity filter input) → immutable table
// (When · Actor · Action · Entity · Detail), newest first from
// audit_log.listRecent. Filter is client-side over the recent window.

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

type AuditRow = {
  _id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  detail?: string | null;
  created_at: number;
};

function formatWhen(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export default function AuditLogPage() {
  const { token } = usePortalSession();
  const rows = useQuery(api.audit_log.listRecent, { token });
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!rows) return undefined;
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r: AuditRow) =>
        r.entity_type.toLowerCase().includes(q) ||
        r.entity_id.toLowerCase().includes(q) ||
        r.action.toLowerCase().includes(q) ||
        r.actor.toLowerCase().includes(q) ||
        (r.detail ?? "").toLowerCase().includes(q),
    );
  }, [rows, filter]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Audit Log</h1>
        {rows !== undefined && (
          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
            {rows.length} recent
          </span>
        )}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by entity, action, actor…"
          className="ml-auto w-64 rounded-lg border-[1.5px] border-slate-200 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-500"
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        {filtered === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
            ))}
          </div>
        ) : rows !== undefined && rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            No audit entries yet — portal writes will appear here as they happen.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing in the recent window matches “{filter.trim()}”.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">When</th>
                  <th className="pb-2 pr-4">Actor</th>
                  <th className="pb-2 pr-4">Action</th>
                  <th className="pb-2 pr-4">Entity</th>
                  <th className="pb-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r: AuditRow) => (
                  <tr key={String(r._id)} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="whitespace-nowrap py-2.5 pr-4 text-slate-500">
                      {formatWhen(r.created_at)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                        {r.actor}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 font-medium text-slate-900">{r.action}</td>
                    <td className="py-2.5 pr-4">
                      <span className="inline-flex max-w-[220px] items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        <span>{r.entity_type}</span>
                        <span className="truncate font-mono font-normal text-slate-400">
                          …{r.entity_id.slice(-6)}
                        </span>
                      </span>
                    </td>
                    <td className="max-w-[380px] py-2.5">
                      <span className="line-clamp-2 text-slate-600">{r.detail ?? "—"}</span>
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
