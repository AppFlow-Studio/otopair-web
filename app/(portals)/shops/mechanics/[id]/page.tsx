"use client";

// Shops · Mechanic detail — /shops/mechanics/:id (Shops spec §4.4).
// 2×2 panel grid: Performance (recent jobs) · Reviews · Week strip · Data
// contributions (verification stream). Read-only. Heavy per-job detail
// (pre/post-job reports, photos, full parts list) deep-links to
// /ops/bookings/:id via the booking chip — not duplicated here.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "../../../portal-session";
import { AuditDrawer } from "@/components/portal/AuditDrawer";
import { EntityChip } from "@/components/portal/EntityChip";
import { CARD, PILL, money, fmtNum } from "@/components/portal/ChartKit";

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

/** ±pct chip: green within ±10%, amber to ±25%, red beyond. */
function VarianceChip({ pct }: { pct: number }) {
  const abs = Math.abs(pct);
  const cls =
    abs <= 0.1
      ? "bg-emerald-50 text-emerald-700"
      : abs <= 0.25
        ? "bg-amber-50 text-amber-700"
        : "bg-red-50 text-red-700";
  const sign = pct > 0 ? "+" : "";
  return <span className={`${PILL} ${cls}`}>{sign}{Math.round(pct * 100)}%</span>;
}

function statusPill(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (["completed", "active"].includes(s)) return `${PILL} bg-emerald-50 text-emerald-700`;
  if (["cancelled", "no_show", "declined"].includes(s)) return `${PILL} bg-red-50 text-red-700`;
  if (s) return `${PILL} bg-amber-50 text-amber-700`;
  return `${PILL} bg-slate-100 text-slate-500`;
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className={CARD}>
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 text-lg font-bold text-slate-900">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

export default function MechanicDetailPage() {
  const { token } = usePortalSession();
  const params = useParams<{ id: string }>();
  const [auditOpen, setAuditOpen] = useState(false);
  const detail = useQuery(api.shopsMechanics.detail, {
    token,
    mechanicId: params.id as Id<"mechanics">,
  });

  if (detail === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-56 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className={CARD}>
        <p className="text-sm text-red-600">That mechanic no longer exists.</p>
        <Link href="/shops/mechanics" className="mt-2 inline-block text-[13px] text-blue-600 hover:underline">
          ← Back to mechanics
        </Link>
      </div>
    );
  }

  const a = detail.aggregates;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-[12px] text-slate-500">
        <Link href="/shops/mechanics" className="font-medium text-slate-600 hover:underline">
          Mechanics
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700">{detail.name}</span>
      </div>

      {/* Header */}
      <div className={`${CARD} flex flex-wrap items-center gap-4`}>
        {detail.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={detail.photo} alt="" className="h-16 w-16 rounded-full object-cover" />
        ) : (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-xl font-bold text-slate-500">
            {detail.name.slice(0, 1)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-slate-900">{detail.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
            {detail.title && <span>{detail.title}</span>}
            {detail.email && (
              <a href={`mailto:${detail.email}`} className="text-blue-600 hover:underline">
                {detail.email}
              </a>
            )}
            {detail.shop && (
              <Link
                href={`/shops/all/${detail.shop_id}`}
                className={`${PILL} bg-blue-50 text-blue-700 hover:underline`}
              >
                {detail.shop}
              </Link>
            )}
            {detail.rating != null && (
              <span>★ {detail.rating.toFixed(1)} ({detail.review_count ?? 0})</span>
            )}
            <span className={`${PILL} ${detail.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
              {detail.active ? "active" : "inactive"}
            </span>
          </div>
        </div>
        <button
          onClick={() => setAuditOpen(true)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-50"
        >
          Audit
        </button>
      </div>

      {/* Utilization aggregates */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Jobs logged" value={fmtNum(a.total_jobs)} />
        <Stat
          label="Avg labor"
          value={a.avg_labor_minutes != null ? `${a.avg_labor_minutes} min` : "—"}
          sub={
            a.labor_variance_pct != null
              ? `${a.labor_variance_pct > 0 ? "+" : ""}${Math.round(a.labor_variance_pct * 100)}% vs estimate`
              : undefined
          }
        />
        <Stat label="Parts handled" value={money(a.total_parts_cost)} />
        <Stat label="Labor revenue" value={a.labor_revenue != null ? money(a.labor_revenue) : "—"} />
        <Stat label="Avg difficulty" value={a.avg_difficulty != null ? `${a.avg_difficulty.toFixed(1)}/5` : "—"} />
        <Stat label="Distinct services" value={fmtNum(a.distinct_services)} />
        <Stat label="Distinct customers" value={fmtNum(a.distinct_customers)} />
        <Stat label="Avg review" value={a.avg_review != null ? `★ ${a.avg_review.toFixed(2)}` : "—"} />
        <Stat
          label="Data accuracy"
          value={a.contribution_accuracy != null ? `${Math.round(a.contribution_accuracy * 100)}%` : "—"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Performance — recent jobs */}
        <div className={`${CARD} lg:col-span-2`}>
          <h2 className="text-sm font-semibold text-slate-900">Performance — recent jobs</h2>
          {detail.recent_jobs.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No completed jobs recorded.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="py-1.5 pr-3">When</th>
                    <th className="py-1.5 pr-3">Service / Vehicle</th>
                    <th className="py-1.5 pr-3">Labor est→act</th>
                    <th className="py-1.5 pr-3">Parts</th>
                    <th className="py-1.5 pr-3">Diff.</th>
                    <th className="py-1.5 pr-3">Mileage</th>
                    <th className="py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.recent_jobs.map((j) => {
                    const variance =
                      j.minutes != null && j.est_minutes != null && j.est_minutes > 0
                        ? (j.minutes - j.est_minutes) / j.est_minutes
                        : null;
                    return (
                      <tr key={j.id} className="border-b border-slate-50 align-top">
                        <td className="py-2 pr-3 text-slate-500">
                          <div>{fmtDate(j.at)}</div>
                          <EntityChip type="booking" id={j.booking_id} label="booking" />
                        </td>
                        <td className="py-2 pr-3">
                          <div className="text-slate-700">
                            {j.services.length > 0 ? j.services.join(", ") : "—"}
                          </div>
                          {j.vehicle && <div className="text-[12px] text-slate-400">{j.vehicle}</div>}
                          {j.notes && (
                            <div className="mt-0.5 max-w-xs text-[12px] italic text-slate-400">
                              “{j.notes}”
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-slate-700">
                          <div className="flex items-center gap-1.5">
                            <span>
                              {j.est_minutes != null ? `${j.est_minutes}` : "—"}
                              {" → "}
                              {j.minutes != null ? `${j.minutes} min` : "—"}
                            </span>
                            {variance != null && <VarianceChip pct={variance} />}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-slate-700">
                          {j.parts_cost != null ? money(j.parts_cost) : "—"}
                          {j.parts_count != null && (
                            <span className="text-[11px] text-slate-400"> ({j.parts_count})</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">
                          {j.difficulty != null ? `${j.difficulty}/5` : "—"}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">
                          {j.mileage_in != null || j.mileage_out != null
                            ? `${j.mileage_in != null ? fmtNum(j.mileage_in) : "—"} → ${j.mileage_out != null ? fmtNum(j.mileage_out) : "—"}`
                            : "—"}
                        </td>
                        <td className="py-2">
                          {j.status && <span className={statusPill(j.status)}>{j.status}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Reviews */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">Reviews</h2>
          {detail.reviews.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No reviews yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {detail.reviews.map((r) => (
                <div key={r.id} className={`rounded-lg border border-slate-100 px-3 py-2 ${r.hidden ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span style={{ color: "#F59E0B" }}>{"★".repeat(Math.round(r.rating))}</span>
                    {r.reviewer && <span className="text-[12px] font-medium text-slate-600">{r.reviewer}</span>}
                    {r.hidden && (
                      <span className={`${PILL} bg-slate-100 text-slate-500`} title={r.hidden_reason ?? undefined}>
                        hidden
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-slate-400">{fmtDate(r.at)}</span>
                  </div>
                  {(r.vehicle.ymm || r.service_names.length > 0) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-500">
                      {r.vehicle.ymm && <span>{r.vehicle.ymm}</span>}
                      {r.service_names.length > 0 && (
                        <span className="text-slate-400">· {r.service_names.join(", ")}</span>
                      )}
                      <EntityChip type="booking" id={r.booking_id} label="booking" />
                    </div>
                  )}
                  {r.comment && <p className="mt-1 text-[13px] text-slate-600">{r.comment}</p>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Week strip — derived open 15-min windows vs live bookings */}
        <div className={CARD}>
          <h2 className="text-sm font-semibold text-slate-900">This week</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Open windows are derived from shop hours minus bookings &amp; blocks.
          </p>
          <div className="mt-3 flex gap-2">
            {detail.week_slots.map((d) => (
              <div key={d.date} className="flex-1 rounded-lg border border-slate-100 p-2 text-center">
                <div className="text-[10px] font-semibold text-slate-400">{d.date.slice(5)}</div>
                <div className="mt-1 text-[15px] font-bold text-emerald-700">{d.available}</div>
                <div className="text-[10px] text-slate-400">open</div>
                <div className="mt-0.5 text-[11px] font-medium text-slate-600">{d.booked} booked</div>
              </div>
            ))}
          </div>
        </div>

        {/* Data contributions */}
        <div className={`${CARD} lg:col-span-2`}>
          <h2 className="text-sm font-semibold text-slate-900">
            Data contributions{" "}
            <span className={`${PILL} ml-1 bg-emerald-50 text-emerald-700`}>the moat</span>
          </h2>
          {detail.contributions.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No verification submissions yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="py-1.5 pr-3">Status</th>
                    <th className="py-1.5 pr-3">Service</th>
                    <th className="py-1.5 pr-3">Labor hrs</th>
                    <th className="py-1.5 pr-3">Parts ok</th>
                    <th className="py-1.5 pr-3">Fields</th>
                    <th className="py-1.5 pr-3">Decisions</th>
                    <th className="py-1.5 pr-3">Accuracy</th>
                    <th className="py-1.5 pr-3">Reviewer</th>
                    <th className="py-1.5">When</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.contributions.map((c) => (
                    <tr key={c.id} className="border-b border-slate-50">
                      <td className="py-1.5 pr-3">
                        <span
                          className={`${PILL} ${
                            c.status === "accepted"
                              ? "bg-emerald-50 text-emerald-700"
                              : c.status === "rejected"
                                ? "bg-red-50 text-red-700"
                                : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {c.status ?? "pending"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-slate-700">{c.service ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-slate-600">{c.labor_hours != null ? `${c.labor_hours}h` : "—"}</td>
                      <td className="py-1.5 pr-3 text-slate-600">
                        {c.parts_correct == null ? "—" : c.parts_correct ? "✓" : "✗"}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-600">{c.fields}</td>
                      <td className="py-1.5 pr-3 text-slate-600">{c.decisions}</td>
                      <td className="py-1.5 pr-3 text-slate-600">
                        {c.accuracy != null ? `${Math.round(c.accuracy * 100)}%` : "—"}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500">{c.reviewer ?? "—"}</td>
                      <td className="py-1.5 text-slate-400">{fmtDate(c.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <AuditDrawer
        open={auditOpen}
        onOpenChange={setAuditOpen}
        entityType="mechanic"
        entityId={String(params.id)}
        title={`Audit — ${detail.name}`}
      />
    </div>
  );
}
