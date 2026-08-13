"use client";

// Data · Vehicle ID — Passports & Shop Truth (list) — /data/vehicle-id
// (Data spec §10.2). Tabs: Passports (VIN chip · two completeness rings ·
// last shop touch · verified sections) · Surveys (pre/post-job submission
// stream off job_actuals' typed reports).

import { useState } from "react";
import Link from "next/link";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());

type PassportListRow = {
  vin: string;
  vehicle: string | null;
  l1_pct: number;
  l2_pct: number;
  mileage: number | null;
  last_shop_touch: number | null;
  verified_sections: number;
  updated_at: number | null;
};
type SurveyRow = {
  id: string;
  kind: "pre-job" | "post-job" | "both" | "none";
  vin: string | null;
  shop: string | null;
  mechanic: string | null;
  mileage: number | null;
  flagged_specs: boolean;
  parts_count: number;
  photos: number;
  tread: unknown;
  rotor_thickness: unknown;
  filters: unknown;
  at: number;
};

function Ring({ pct, label }: { pct: number; label: string }) {
  const r = 12;
  const circ = 2 * Math.PI * r;
  const color = pct >= 80 ? "#10b981" : pct >= 40 ? "#f59e0b" : "#ef4444";
  return (
    <span
      className="relative inline-flex h-8 w-8 items-center justify-center"
      title={`${label} ${pct}%`}
    >
      <svg width="32" height="32" viewBox="0 0 32 32" className="-rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" stroke="#e2e8f0" strokeWidth="3.5" />
        <circle
          cx="16"
          cy="16"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeDasharray={`${(circ * pct) / 100} ${circ}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[8px] font-bold text-slate-600">{label}</span>
    </span>
  );
}

export default function VehicleIdPage() {
  const { token } = usePortalSession();
  const [tab, setTab] = useState<"Passports" | "Surveys">("Passports");

  const passports = usePaginatedQuery(
    api.dataPassports.listPassports,
    { token },
    { initialNumItems: 25 },
  );
  const surveys = usePaginatedQuery(
    api.dataPassports.surveyStream,
    { token },
    { initialNumItems: 25 },
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Vehicle ID — Passports &amp; Shop Truth
        </h1>
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
          Two layers (Apr 18): Layer 1 static — AI-enriched identity, shops cannot edit ·
          Layer 2 living — shop truth (shop &gt; AI &gt; user for enrichment-derived fields;
          shop &gt; user &gt; AI for user-provided).
        </div>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {(["Passports", "Surveys"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium ${
              tab === t ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Passports" && (
        <>
          {passports.status === "LoadingFirstPage" ? (
            <Skeleton />
          ) : passports.results.length === 0 ? (
            <Empty text="No vehicle passports on this deployment yet — rows appear as vehicles onboard." />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">VIN</th>
                    <th className="px-2 py-2">Vehicle</th>
                    <th className="px-2 py-2">Completeness</th>
                    <th className="px-2 py-2">Mileage</th>
                    <th className="px-2 py-2">Last shop touch</th>
                    <th className="px-2 py-2">Verified sections</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(passports.results as PassportListRow[]).map((p) => (
                    <tr key={p.vin} className="border-b border-slate-50">
                      <td className="px-4 py-2 font-mono text-[12px] text-slate-800">{p.vin}</td>
                      <td className="px-2 py-2 text-slate-600">{p.vehicle ?? "—"}</td>
                      <td className="px-2 py-2">
                        <span className="flex items-center gap-1.5">
                          <Ring pct={p.l1_pct} label="L1" />
                          <Ring pct={p.l2_pct} label="L2" />
                        </span>
                      </td>
                      <td className="px-2 py-2 text-slate-600">
                        {p.mileage != null ? p.mileage.toLocaleString("en-US") : "—"}
                      </td>
                      <td className="px-2 py-2 text-slate-500">{fmtDate(p.last_shop_touch)}</td>
                      <td className="px-2 py-2 text-slate-600">{p.verified_sections}/4</td>
                      <td className="px-2 py-2">
                        <Link
                          href={`/director/data/vehicle-id/${p.vin}`}
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {passports.status === "CanLoadMore" && (
            <button
              onClick={() => passports.loadMore(25)}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Load more
            </button>
          )}
        </>
      )}

      {tab === "Surveys" && (
        <>
          {surveys.status === "LoadingFirstPage" ? (
            <Skeleton />
          ) : surveys.results.length === 0 ? (
            <Empty text="No survey submissions yet — pre/post-job streams fill as shop jobs run." />
          ) : (
            <div className="space-y-3">
              {(surveys.results as SurveyRow[])
                .filter((s) => s.kind !== "none")
                .map((s) => (
                  <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`${pill} ${
                          s.kind === "pre-job"
                            ? "bg-blue-50 text-blue-700"
                            : s.kind === "post-job"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {s.kind}
                      </span>
                      {s.vin && (
                        <Link
                          href={`/director/data/vehicle-id/${s.vin}`}
                          className="font-mono text-[12px] text-blue-600 hover:underline"
                        >
                          {s.vin}
                        </Link>
                      )}
                      {s.shop && <span className={`${pill} bg-slate-100 text-slate-600`}>{s.shop}</span>}
                      {s.mechanic && (
                        <span className="text-[12px] text-slate-500">{s.mechanic}</span>
                      )}
                      {s.flagged_specs && (
                        <span className={`${pill} bg-red-50 text-red-700`}>flagged specs</span>
                      )}
                      <span className="ml-auto text-[12px] text-slate-400">{fmtDate(s.at)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-slate-500">
                      {s.mileage != null && (
                        <span>mileage {s.mileage.toLocaleString("en-US")}</span>
                      )}
                      {s.parts_count > 0 && <span>{s.parts_count} parts logged</span>}
                      {s.photos > 0 && <span>{s.photos} photos</span>}
                      {s.tread != null && <span className={`${pill} bg-slate-100 text-slate-600`}>tread 32nds ✓</span>}
                      {s.rotor_thickness != null && (
                        <span className={`${pill} bg-slate-100 text-slate-600`}>rotor µm ✓</span>
                      )}
                      {s.filters != null && (
                        <span className={`${pill} bg-slate-100 text-slate-600`}>filter checks ✓</span>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
          {surveys.status === "CanLoadMore" && (
            <button
              onClick={() => surveys.loadMore(25)}
              className="w-full rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}
