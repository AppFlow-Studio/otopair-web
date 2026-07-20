"use client";

// Shops · Offerings Matrix — /shops/offerings (Shops spec §4.6).
// Sticky service column (grouped by category) × shop columns; ✓/— cells,
// click = ceremony toggle (shops.write). Right rail: coverage gaps. Price
// band mini-bars are honestly descoped (needs a quote-engine run per cell).

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import {
  CARD,
  PILL as KIT_PILL,
  BarRows,
  PageHeader,
  StatTile,
  Skeleton,
  fmtNum,
} from "@/components/portal/ChartKit";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type MatrixService = {
  service_id: string;
  name: string;
  category: string;
  offered_by: string[];
};

export default function ShopsOfferingsPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("shops.write");
  const data = useQuery(api.shopsOfferings.matrix, { token });
  const toggle = useMutation(api.shopsOfferings.toggleOffering);
  const [target, setTarget] = useState<{
    service: MatrixService;
    shop: { id: string; name: string };
    offered: boolean;
  } | null>(null);

  const grouped = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, MatrixService[]>();
    for (const s of data.services as MatrixService[]) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return [...map.entries()];
  }, [data]);

  // ── Coverage analytics (client-side from the matrix payload) ───────────────
  const coverage = useMemo(() => {
    if (!data) return undefined;
    const services = data.services as MatrixService[];
    const shopCount = (data.shops as { id: string; name: string }[]).length;
    const offeredCells = services.reduce((s, svc) => s + svc.offered_by.length, 0);
    const totalCells = services.length * shopCount;
    const sorted = [...services].sort((a, b) => b.offered_by.length - a.offered_by.length);
    return {
      serviceCount: services.length,
      shopCount,
      offeredCells,
      pct: totalCells > 0 ? Math.round((offeredCells / totalCells) * 100) : null,
      most: sorted.slice(0, 6).map((s) => ({
        label: s.name,
        value: s.offered_by.length,
        sub: `of ${shopCount}`,
      })),
      least: sorted
        .slice(-6)
        .reverse()
        .map((s) => ({ label: s.name, value: s.offered_by.length, sub: `of ${shopCount}` })),
    };
  }, [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Offerings Matrix"
        subtitle="Which shop offers which service — cells toggle through a ceremony (shops.write)."
      />

      {/* ── Coverage tiles ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Services in catalog"
          value={coverage === undefined ? <Skeleton /> : fmtNum(coverage.serviceCount)}
        />
        <StatTile
          label="Shops"
          value={coverage === undefined ? <Skeleton /> : fmtNum(coverage.shopCount)}
        />
        <StatTile
          label="Matrix coverage"
          value={
            coverage === undefined ? (
              <Skeleton />
            ) : coverage.pct === null ? (
              "—"
            ) : (
              `${coverage.pct}%`
            )
          }
          chip={
            coverage !== undefined ? (
              <span className={`${KIT_PILL} bg-blue-50 text-blue-700`}>
                {fmtNum(coverage.offeredCells)} offered cells
              </span>
            ) : undefined
          }
        />
        <StatTile
          label="Coverage gaps (≤1 shop)"
          value={data === undefined ? <Skeleton /> : fmtNum(data.coverage_gaps.length)}
          chip={
            data !== undefined ? (
              <span
                className={`${KIT_PILL} ${
                  data.coverage_gaps.length > 0
                    ? "bg-red-50 text-red-700"
                    : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {data.coverage_gaps.length > 0 ? "thin coverage" : "all ≥2 shops"}
              </span>
            ) : undefined
          }
        />
      </div>

      {/* ── Most / least offered ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={CARD}>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Most offered services</h2>
            <span className="text-[11px] text-slate-400">shops offering each</span>
          </div>
          {coverage === undefined ? (
            <Skeleton className="h-24 w-full" />
          ) : coverage.most.length === 0 ? (
            <p className="text-sm text-slate-500">No services in the catalog yet.</p>
          ) : (
            <BarRows rows={coverage.most} color="#6ee7b7" />
          )}
        </div>
        <div className={CARD}>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Least offered services</h2>
            <span className="text-[11px] text-slate-400">expansion candidates</span>
          </div>
          {coverage === undefined ? (
            <Skeleton className="h-24 w-full" />
          ) : coverage.least.length === 0 ? (
            <p className="text-sm text-slate-500">No services in the catalog yet.</p>
          ) : (
            <BarRows rows={coverage.least} color="#fcd34d" />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_260px]">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          {data === undefined ? (
            <div className="h-72 animate-pulse rounded-lg bg-slate-100" />
          ) : data.shops.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No shops on this deployment.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className="sticky left-0 bg-white px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Service
                    </th>
                    {data.shops.map((s: { id: string; name: string }) => (
                      <th key={s.id} className="px-2 py-2 text-center text-[11px] font-semibold text-slate-500">
                        <Link href={`/shops/all/${s.id}`} className="hover:text-blue-700 hover:underline">
                          {s.name}
                        </Link>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(([category, services]) => (
                    <SvcGroup
                      key={category}
                      category={category}
                      services={services}
                      shops={data.shops}
                      canWrite={canWrite}
                      onToggle={(service, shop, offered) => setTarget({ service, shop, offered })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right rail — coverage gaps */}
        <div className="space-y-4">
          <div className="rounded-xl border border-red-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-red-700">Coverage gaps (≤1 shop)</h2>
            {data === undefined ? (
              <div className="mt-2 h-16 animate-pulse rounded-lg bg-slate-100" />
            ) : data.coverage_gaps.length === 0 ? (
              <p className="mt-2 text-[13px] text-emerald-700">
                Every service is offered by 2+ shops.
              </p>
            ) : (
              <div className="mt-2 space-y-1">
                {data.coverage_gaps.map((g: { service: string; offered_by: number }) => (
                  <div key={g.service} className="flex items-center gap-2 text-[13px]">
                    <span className="text-slate-700">{g.service}</span>
                    <span className={`${pill} ml-auto bg-red-50 text-red-700`}>
                      {g.offered_by} shop{g.offered_by === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-500">
            Per-service network price bands need a quote-engine run per cell — they ship
            with the pricing work, not as invented numbers here.
          </div>
        </div>
      </div>

      <Ceremony
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`${target?.offered ? "Enable" : "Disable"} ${target?.service.name ?? ""}`}
        destructive={target ? !target.offered : false}
        summary={
          target && (
            <>
              {target.shop.name} will {target.offered ? "start offering" : "STOP offering"}{" "}
              <span className="font-semibold">{target.service.name}</span>.{" "}
              {target.offered
                ? "It becomes bookable there immediately."
                : "New bookings for it stop immediately; existing bookings are untouched."}
            </>
          )
        }
        onConfirm={async (reason) => {
          if (!target) return;
          await toggle({
            token,
            reason,
            shopId: target.shop.id as Id<"shops">,
            serviceId: target.service.service_id as Id<"services">,
            offered: target.offered,
          });
        }}
      />
    </div>
  );
}

function SvcGroup({
  category,
  services,
  shops,
  canWrite,
  onToggle,
}: {
  category: string;
  services: MatrixService[];
  shops: { id: string; name: string }[];
  canWrite: boolean;
  onToggle: (service: MatrixService, shop: { id: string; name: string }, offered: boolean) => void;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={shops.length + 1}
          className="sticky left-0 bg-[#F8FAFC] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500"
        >
          {category}
        </td>
      </tr>
      {services.map((svc) => (
        <tr key={svc.service_id} className="border-b border-slate-50">
          <td className="sticky left-0 bg-white px-3 py-1.5 text-slate-700">{svc.name}</td>
          {shops.map((shop) => {
            const offered = svc.offered_by.includes(shop.id);
            return (
              <td key={shop.id} className="px-2 py-1.5 text-center">
                <button
                  disabled={!canWrite}
                  onClick={() => onToggle(svc, shop, !offered)}
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-[13px] font-bold ${
                    offered ? "text-[#059669]" : "text-[#D1D5DB]"
                  } ${canWrite ? "hover:bg-slate-100" : "cursor-default"}`}
                  title={`${shop.name} · ${svc.name}: ${offered ? "offered" : "not offered"}${canWrite ? " — click to toggle (ceremony)" : ""}`}
                >
                  {offered ? "✓" : "—"}
                </button>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
