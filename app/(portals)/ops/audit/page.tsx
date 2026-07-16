"use client";

// Ops · Audit Log — /ops/audit (spec §5.13, Atlas T2 variant).
// Zones: PageHeader (count + entity filter input) → analytics (actions/day +
// top actors) → immutable table (When · Actor · Action · Entity · Detail),
// newest first from audit_log.listRecent. Filter is client-side over the
// recent window. Entity cells deep-link when a detail route exists.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  BarRows,
  CARD_STATIC,
  MICRO_H,
  PILL,
  PageHeader,
  StatTile,
  TrendBars,
  fmtNum,
} from "@/components/portal/ChartKit";

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

/** Deep-link an audit entity to its detail page where one exists. */
function entityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "booking":
      return `/ops/bookings/${entityId}`;
    case "payment":
      return `/ops/payments/${entityId}`;
    case "user":
      return `/ops/users/${entityId}`;
    case "shop":
      return `/shops/all/${entityId}`;
    case "api_key":
      return "/developers";
    default:
      return null;
  }
}

function EntityCell({ r }: { r: AuditRow }) {
  const href = entityHref(r.entity_type, r.entity_id);
  const inner = (
    <>
      <span>{r.entity_type}</span>
      <span className="truncate font-mono font-normal text-slate-400">
        …{r.entity_id.slice(-6)}
      </span>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        title={`Open ${r.entity_type} ${r.entity_id}`}
        className="inline-flex max-w-[220px] items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100"
      >
        {inner}
        <span aria-hidden>→</span>
      </Link>
    );
  }
  return (
    <span
      title={r.entity_id}
      className="inline-flex max-w-[220px] items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600"
    >
      {inner}
    </span>
  );
}

export default function AuditLogPage() {
  const { token } = usePortalSession();
  const rows = useQuery(api.audit_log.listRecent, { token });
  const daily = useQuery(api.portalSeries.auditDaily, { token, days: 30 });
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

  const actions30d = daily?.days.reduce((s, d) => s + d.actions, 0);
  const topActor = daily?.top_actors[0];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit Log"
        subtitle="Immutable trail of every portal write — who did what, to which entity, and why."
      >
        <div className="flex items-center gap-3">
          {rows !== undefined && (
            <span className={`${PILL} bg-slate-100 text-slate-600`}>{rows.length} recent</span>
          )}
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by entity, action, actor…"
            className="w-64 rounded-lg border-[1.5px] border-slate-200 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-500"
          />
        </div>
      </PageHeader>

      {/* Analytics zone */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className={`${CARD_STATIC} lg:col-span-2`}>
          <div className="flex flex-wrap items-center gap-3">
            <div className={MICRO_H}>Audit actions per day · last 30 days</div>
            <span className="text-[12px] text-slate-400">
              {actions30d == null ? "" : `${fmtNum(actions30d)} total`}
            </span>
          </div>
          <div className="mt-3">
            <TrendBars data={daily?.days} dataKey="actions" name="Actions" color="#93c5fd" height={150} />
          </div>
        </div>
        <div className={CARD_STATIC}>
          <div className={MICRO_H}>Top actors · 30d</div>
          <div className="mt-3">
            {daily === undefined ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />
                ))}
              </div>
            ) : daily.top_actors.length === 0 ? (
              <p className="text-sm text-slate-500">No portal writes in the window.</p>
            ) : (
              <BarRows rows={daily.top_actors.map((a) => ({ label: a.actor, value: a.count }))} />
            )}
          </div>
          {topActor && (
            <p className="mt-3 text-[12px] text-slate-400">
              Most active: <span className="font-medium text-slate-600">{topActor.actor}</span> (
              {fmtNum(topActor.count)} actions)
            </p>
          )}
        </div>
      </div>

      {/* Table */}
      <div className={CARD_STATIC}>
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
                      <span className={`${PILL} bg-blue-50 text-blue-700`}>{r.actor}</span>
                    </td>
                    <td className="py-2.5 pr-4 font-medium text-slate-900">{r.action}</td>
                    <td className="py-2.5 pr-4">
                      <EntityCell r={r} />
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
