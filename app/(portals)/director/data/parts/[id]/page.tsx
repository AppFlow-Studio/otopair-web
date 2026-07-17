"use client";

// Data · Part detail — /data/parts/:id (Data spec §4B).
// Header identity → reverse-fitment graph grouped by make with the
// blast-radius banner ("correction touches N configs") → price strip (the
// May 28 engine via summarizePartPrices) → job_actuals usage panel with cost
// mini-histogram (Layer D price signal, honest window).

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { PriceStrip } from "@/components/portal/PriceStrip";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());

type FitmentGroup = {
  make: string;
  configs: { id: string; config_key: string; service_type: string | null; quantity: number | null }[];
};

export default function PartDetailPage() {
  const { token } = usePortalSession();
  const params = useParams<{ id: string }>();
  const [openMakes, setOpenMakes] = useState<Set<string>>(new Set());

  const detail = useQuery(api.dataParts.partDetail, {
    token,
    partId: params.id as Id<"oem_parts">,
  });

  if (detail === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-72 animate-pulse rounded-lg bg-slate-100" />
        <div className="h-40 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700">
        That part no longer exists.{" "}
        <Link href="/director/data/parts" className="font-medium text-blue-600 hover:underline">
          Back to parts
        </Link>
        .
      </div>
    );
  }

  const summary = detail.price_summary;
  const stripPoints = detail.price_rows.map((r) => ({
    price: r.price,
    source: r.source_domain ?? "unknown",
    kept: summary.sources_used.some(
      (s: { price: number; source_domain: string | null }) =>
        s.price === r.price && (s.source_domain ?? "") === (r.source_domain ?? ""),
    ),
    flag: r.price_type ?? undefined,
  }));

  const toggleMake = (make: string) =>
    setOpenMakes((prev) => {
      const next = new Set(prev);
      if (next.has(make)) next.delete(make);
      else next.add(make);
      return next;
    });

  return (
    <div className="space-y-6">
      {/* Header identity */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold text-slate-900">
          {detail.oem_part_number}
        </h1>
        <span className="text-lg text-slate-700">{detail.name}</span>
        {detail.category && (
          <span className={`${pill} bg-slate-100 text-slate-600`}>
            {detail.category}
            {detail.subcategory ? ` / ${detail.subcategory}` : ""}
          </span>
        )}
        {detail.part_tier && (
          <span className={`${pill} bg-slate-100 text-slate-600`}>{detail.part_tier}</span>
        )}
        {detail.data_quality && (
          <span className={`${pill} bg-slate-100 text-slate-500`}>{detail.data_quality}</span>
        )}
      </div>

      {/* Supersession chain */}
      {(detail.supersedes || detail.superseded_by) && (
        <div className="flex flex-wrap gap-2 text-[13px] text-slate-600">
          {detail.supersedes && (
            <span>
              supersedes{" "}
              {detail.supersedes.id ? (
                <Link
                  href={`/director/data/parts/${detail.supersedes.id}`}
                  className="font-mono text-blue-600 hover:underline"
                >
                  {detail.supersedes.number}
                </Link>
              ) : (
                <span className="font-mono">{detail.supersedes.number}</span>
              )}
            </span>
          )}
          {detail.superseded_by && (
            <span>
              superseded by{" "}
              {detail.superseded_by.id ? (
                <Link
                  href={`/director/data/parts/${detail.superseded_by.id}`}
                  className="font-mono text-blue-600 hover:underline"
                >
                  {detail.superseded_by.number}
                </Link>
              ) : (
                <span className="font-mono">{detail.superseded_by.number}</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Blast radius + reverse fitments */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[13px] font-medium text-amber-800">
          A correction to this part touches {detail.fitment_total}
          {detail.fitment_truncated ? "+" : ""} config
          {detail.fitment_total === 1 ? "" : "s"} — the blast-radius view.
        </div>
        {detail.fitment_groups.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No fitments — this part is an orphan (hygiene flag: unfitted).
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {(detail.fitment_groups as FitmentGroup[]).map((g) => (
              <div key={g.make} className="rounded-lg border border-slate-100">
                <button
                  onClick={() => toggleMake(g.make)}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[13px] font-semibold text-slate-800 hover:bg-slate-50"
                >
                  {g.make}
                  <span className="text-[12px] font-normal text-slate-500">
                    {g.configs.length} config{g.configs.length === 1 ? "" : "s"}{" "}
                    {openMakes.has(g.make) ? "▾" : "▸"}
                  </span>
                </button>
                {openMakes.has(g.make) && (
                  <div className="flex flex-wrap gap-1.5 border-t border-slate-100 px-4 py-3">
                    {g.configs.map((c) => (
                      <Link
                        key={`${c.id}-${c.service_type}`}
                        href={`/director/data/catalog/${c.id}`}
                        className={`${pill} bg-slate-100 font-mono text-slate-700 hover:bg-blue-50 hover:text-blue-700`}
                        title={c.service_type ?? undefined}
                      >
                        {c.config_key}
                        {c.quantity != null && c.quantity > 1 ? ` ×${c.quantity}` : ""}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Price strip */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Price summary{" "}
          <span className="font-normal text-slate-400">
            (median + MAD outlier rejection — the May 28 engine)
          </span>
        </h2>
        <div className="mt-4">
          <PriceStrip
            points={stripPoints}
            median={summary.used_sample_size > 0 ? summary.median : null}
            range={
              summary.used_sample_size > 0
                ? { low: summary.min_kept, high: summary.max_kept }
                : null
            }
            rangeRule={`${summary.used_sample_size}/${summary.sample_size} sources kept · ${summary.outliers_removed} outlier${summary.outliers_removed === 1 ? "" : "s"} removed`}
          />
        </div>
        <p className="mt-3 text-[11px] text-slate-400">
          Full range rules and the pathology queue live on{" "}
          <Link href="/director/data/parts-pricing" className="text-blue-600 hover:underline">
            Parts Pricing
          </Link>
          . price_cost_low/high never existed on part_prices rows in this schema — the
          stored-but-removed-from-math columns of the May 28 decision live on
          service_options (rendered greyed in the Service Catalog).
        </p>
      </div>

      {/* Usage panel */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Usage in jobs{" "}
          <span className={`${pill} ml-1 bg-emerald-50 text-emerald-700`}>Layer D signal</span>
        </h2>
        {detail.usage.jobs_matched === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No appearances in the last {detail.usage.window} jobs.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[13px] text-slate-600">
              {detail.usage.jobs_matched} appearance{detail.usage.jobs_matched === 1 ? "" : "s"} in
              the last {detail.usage.window} jobs.
            </p>
            {detail.usage.cost_histogram.length > 0 && (
              <div className="mt-3 flex items-end gap-2">
                {detail.usage.cost_histogram.map(
                  (b: { label: string; count: number }, i: number) => {
                    const maxN = Math.max(
                      ...detail.usage.cost_histogram.map((x: { count: number }) => x.count),
                    );
                    return (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <div
                          className="w-12 rounded-t bg-emerald-400"
                          style={{ height: 8 + (b.count / (maxN || 1)) * 56 }}
                          title={`${b.count} jobs`}
                        />
                        <span className="text-[10px] text-slate-500">{b.label}</span>
                      </div>
                    );
                  },
                )}
              </div>
            )}
          </>
        )}
        <p className="mt-2 text-[11px] text-slate-400">
          Window: last {detail.usage.window} jobs (no per-part job index — honest window, not
          lifetime). Freshest price {fmtDate(summary.most_recent_refreshed_at)}.
        </p>
      </div>
    </div>
  );
}
