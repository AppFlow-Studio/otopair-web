"use client";

// Data · Parts Pricing Engine — /data/parts-pricing (Data spec §9.2).
// Three tabs: Price Strip (the signature layout; the May 28 worked example is
// the empty state) · Pathologies (poison price_types → split-view verdict,
// ceremony) · Validation (Estimator endpoint tier-test runs, read-only).

import { useState } from "react";
import Link from "next/link";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import { PriceStrip } from "@/components/portal/PriceStrip";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());

type PricedPartRow = {
  part_id: string;
  oem_part_number: string;
  name: string;
  subcategory: string | null;
  latest_price: number;
  latest_source: string | null;
  refreshed_at: number | null;
};
type StripPoint = {
  row_id: string;
  price: number;
  price_type: string | null;
  source_domain: string | null;
  source_url: string | null;
  refreshed_at: number | null;
  kept: boolean;
  poison: boolean;
  non_pooled: boolean;
};
type PathologyRow = {
  row_id: string;
  part_id: string;
  oem_part_number: string | null;
  part_name: string | null;
  price: number;
  price_type: string;
  msrp: number | null;
  discount: number | null;
  source_domain: string | null;
  source_url: string | null;
  refreshed_at: number | null;
};
type ValidationRunRow = {
  id: string;
  config_key: string | null;
  service: string | null;
  labor_hours: number | null;
  labor_band: { low: number; high: number } | null;
  parts_count: number;
  match_quality: string | null;
  fetched_at: number;
};

const TABS = ["Price Strip", "Pathologies", "Validation"] as const;
type Tab = (typeof TABS)[number];

// The May 28 worked example — ships as the empty-state illustration exactly
// as spec'd: 47 / 50 / 51.8 / 55.8 with $90 rejected → median $51.19 (the
// engine's blend of median+mean over kept sources).
const WORKED_EXAMPLE = [
  { price: 47, source: "example-a", kept: true },
  { price: 50, source: "example-b", kept: true },
  { price: 51.8, source: "example-c", kept: true },
  { price: 55.8, source: "example-d", kept: true },
  { price: 90, source: "example-outlier", kept: false, flag: "MAD outlier" },
];

export default function PartsPricingPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");
  const [tab, setTab] = useState<Tab>("Price Strip");
  const [selectedPart, setSelectedPart] = useState<{ id: string; label: string } | null>(null);
  const [verdictTarget, setVerdictTarget] = useState<{
    row: PathologyRow;
    verdict: "pathology" | "legit";
  } | null>(null);

  const priced = usePaginatedQuery(
    api.dataPartsPricing.pricedPartsWindow,
    { token },
    { initialNumItems: 25 },
  );
  const strip = useQuery(
    api.dataPartsPricing.priceStrip,
    selectedPart ? { token, partId: selectedPart.id as Id<"oem_parts"> } : "skip",
  );
  const pathologies = useQuery(api.dataPartsPricing.pathologyQueue, { token });
  const validation = useQuery(api.dataPartsPricing.endpointValidationRuns, { token });
  const resolvePathology = useMutation(api.dataPartsPricing.resolvePathology);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Parts Pricing Engine</h1>
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
          Range rules (May 28, locked): multi-source → 5–8% cap between ends (25% spreads are
          dead) · single source → ±8% · zero sources → Camry × multiplier, badged INTERNAL
          FALLBACK. Poison captures (you-save / multi-pack / wrong-qty) never enter the math.
        </div>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium ${
              tab === t ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t}
            {t === "Pathologies" && pathologies ? ` (${pathologies.rows.length})` : ""}
          </button>
        ))}
      </div>

      {/* ---- Price Strip ---- */}
      {tab === "Price Strip" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* part picker rail */}
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
                Recently priced parts
              </div>
              {priced.status === "LoadingFirstPage" ? (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
                  ))}
                </div>
              ) : priced.results.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">No priced parts on this deployment.</p>
              ) : (
                <div className="max-h-[520px] overflow-auto">
                  {(priced.results as PricedPartRow[]).map((r) => (
                    <button
                      key={r.part_id}
                      onClick={() =>
                        setSelectedPart({ id: r.part_id, label: `${r.oem_part_number} · ${r.name}` })
                      }
                      className={`flex w-full items-center gap-2 border-b border-slate-50 px-4 py-2 text-left hover:bg-slate-50 ${
                        selectedPart?.id === r.part_id ? "bg-blue-50" : ""
                      }`}
                    >
                      <span className="font-mono text-[12px] text-slate-800">
                        {r.oem_part_number}
                      </span>
                      <span className="truncate text-[12px] text-slate-500">{r.name}</span>
                      <span className="ml-auto text-[12px] font-semibold text-slate-700">
                        ${r.latest_price.toFixed(2)}
                      </span>
                    </button>
                  ))}
                  {priced.status === "CanLoadMore" && (
                    <button
                      onClick={() => priced.loadMore(25)}
                      className="w-full py-2 text-[12px] font-medium text-slate-500 hover:bg-slate-50"
                    >
                      Load more
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* strip panel */}
          <div className="lg:col-span-3">
            {!selectedPart ? (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <h2 className="text-sm font-semibold text-slate-900">
                  The worked example (May 28) — pick a part to see its live strip
                </h2>
                <div className="mt-4">
                  <PriceStrip
                    points={WORKED_EXAMPLE}
                    median={51.19}
                    range={{ low: 49.14, high: 53.24 }}
                    rangeRule="worked example: 47 / 50 / 51.8 / 55.8 + $90 rejected → $51.19"
                  />
                </div>
                <p className="mt-3 text-[12px] text-slate-500">
                  This is the illustration, not data: four sources pooled, the $90 capture
                  MAD-rejected, median $51.19, range capped to 8% around it.
                </p>
              </div>
            ) : strip === undefined ? (
              <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
            ) : strip === null ? (
              <div className="rounded-xl border border-red-200 bg-white p-5 text-sm text-red-700">
                That part no longer exists.
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">
                    <span className="font-mono">{strip.part.oem_part_number}</span> ·{" "}
                    {strip.part.name}
                  </h2>
                  <Link
                    href={`/director/data/parts/${strip.part.id}`}
                    className={`${pill} bg-blue-50 text-blue-700 hover:bg-blue-100`}
                  >
                    part detail →
                  </Link>
                </div>
                <div className="mt-4">
                  <PriceStrip
                    points={(strip.points as StripPoint[]).map((p) => ({
                      price: p.price,
                      source: p.source_domain ?? "unknown",
                      kept: p.kept,
                      flag: p.poison
                        ? `POISON: ${p.price_type}`
                        : p.non_pooled
                          ? `${p.price_type} (fallback point — excluded from pooled math)`
                          : (p.price_type ?? undefined),
                    }))}
                    median={strip.summary.used_sample_size > 0 ? strip.summary.median : null}
                    range={strip.range}
                    rangeRule={strip.range_rule}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[12px] text-slate-500">
                  <span>
                    {strip.summary.used_sample_size}/{strip.summary.sample_size} sources kept
                  </span>
                  <span>· {strip.summary.outliers_removed} outliers removed</span>
                  {(strip.points as StripPoint[]).some((p) => p.non_pooled) && (
                    <span className={`${pill} bg-slate-100 text-slate-600`}>
                      estimator_endpoint = fallback point, never pooled
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- Pathologies ---- */}
      {tab === "Pathologies" &&
        (pathologies === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : pathologies.rows.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            No poison-typed price rows in the scanned window ({pathologies.scanned} rows) —
            the three scraper failure modes (you-save · multi-pack · wrong-qty) have no live
            suspects right now.
          </div>
        ) : (
          <div className="space-y-3">
            {pathologies.truncated && (
              <div className={`${pill} bg-amber-50 text-amber-700`}>
                sweep truncated at 500 rows
              </div>
            )}
            {(pathologies.rows as PathologyRow[]).map((r) => (
              <div key={r.row_id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px] text-slate-800">
                    {r.oem_part_number ?? "?"}
                  </span>
                  <span className="truncate text-[13px] text-slate-600">{r.part_name}</span>
                  <span className={`${pill} bg-red-50 text-red-700`}>{r.price_type}</span>
                  <span className="ml-auto text-base font-bold text-slate-900">
                    ${r.price.toFixed(2)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-slate-500">
                  {r.msrp != null && <span>msrp ${r.msrp.toFixed(2)}</span>}
                  {r.discount != null && <span>discount ${r.discount.toFixed(2)}</span>}
                  <span>{r.source_domain ?? "unknown source"}</span>
                  <span>{fmtDate(r.refreshed_at)}</span>
                  {r.source_url && (
                    <a
                      href={r.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-600 hover:underline"
                    >
                      open source page ↗ (ten-second human verdict)
                    </a>
                  )}
                  {canWrite && (
                    <span className="ml-auto flex gap-2">
                      <button
                        onClick={() => setVerdictTarget({ row: r, verdict: "pathology" })}
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-red-600 hover:bg-red-50"
                      >
                        Confirm pathology
                      </button>
                      <button
                        onClick={() => setVerdictTarget({ row: r, verdict: "legit" })}
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-emerald-600 hover:bg-emerald-50"
                      >
                        Legit
                      </button>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

      {/* ---- Validation ---- */}
      {tab === "Validation" &&
        (validation === undefined ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : validation.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            No Estimator endpoint runs cached on this deployment. The Jun 18 next-step (tier
            test on part prices via the endpoint) lists its runs here as they land.
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-2.5 text-[12px] text-slate-500">
              Estimator endpoint estimates (read-only). Source-weight changes remain code
              constants — a weight-shift ceremony ships when weights become data (P2 note).
            </div>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2">Config</th>
                  <th className="px-2 py-2">Service</th>
                  <th className="px-2 py-2">Labor</th>
                  <th className="px-2 py-2">Labor $ band</th>
                  <th className="px-2 py-2">Parts</th>
                  <th className="px-2 py-2">Match</th>
                  <th className="px-2 py-2">Fetched</th>
                </tr>
              </thead>
              <tbody>
                {(validation as ValidationRunRow[]).map((r) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="px-4 py-2 font-mono text-[12px] text-slate-700">
                      {r.config_key ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-slate-700">{r.service ?? "—"}</td>
                    <td className="px-2 py-2 text-slate-600">
                      {r.labor_hours != null ? `${r.labor_hours.toFixed(1)}h` : "—"}
                    </td>
                    <td className="px-2 py-2 text-slate-600">
                      {r.labor_band
                        ? `$${r.labor_band.low.toFixed(0)}–$${r.labor_band.high.toFixed(0)}`
                        : "—"}
                    </td>
                    <td className="px-2 py-2 text-slate-600">{r.parts_count}</td>
                    <td className="px-2 py-2">
                      {r.match_quality && (
                        <span
                          className={`${pill} ${
                            r.match_quality === "exact"
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {r.match_quality}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-slate-500">{fmtDate(r.fetched_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {/* Pathology verdict ceremony */}
      <Ceremony
        open={verdictTarget !== null}
        onOpenChange={(o) => !o && setVerdictTarget(null)}
        title={
          verdictTarget?.verdict === "pathology" ? "Confirm pathology" : "Mark price legit"
        }
        destructive={verdictTarget?.verdict === "pathology"}
        summary={
          verdictTarget && (
            <>
              <span className="font-mono">{verdictTarget.row.oem_part_number}</span> — $
              {verdictTarget.row.price.toFixed(2)} from{" "}
              {verdictTarget.row.source_domain ?? "unknown"} (
              <span className="font-mono">{verdictTarget.row.price_type}</span>) →{" "}
              {verdictTarget.verdict === "pathology" ? (
                <>
                  stamped <span className="font-mono">unverified</span>: stays excluded from
                  the math, kept for audit. Confirms feed source scoring downstream.
                </>
              ) : (
                <>
                  stamped <span className="font-mono">sale</span>: enters the pooled
                  customer-facing aggregate immediately.
                </>
              )}
            </>
          )
        }
        onConfirm={async (reason) => {
          if (!verdictTarget) return;
          await resolvePathology({
            token,
            reason,
            priceRowId: verdictTarget.row.row_id as Id<"part_prices">,
            verdict: verdictTarget.verdict,
          });
        }}
      />
    </div>
  );
}
