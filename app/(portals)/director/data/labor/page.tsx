"use client";

// Data · Labor Times Command Center — /data/labor (Data spec §9.1).
// Zones top-to-bottom: header + fixed policy banner → selector bar
// (service × config) → source ladder (signature panel: one row per source,
// effective value highlighted with its selection reason) → aggregate row /
// guardrail flags. Read-only: the weights/caps lever is Super-Admin + co-sign
// and lives elsewhere.

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { ConfigPicker, type PickedConfig } from "@/components/portal/ConfigPicker";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

// Client-side mirrors of the dataLabor query return shapes (the generated api
// typing collapses in this repo, so callbacks are annotated explicitly).
type ServiceOpt = {
  id: string;
  name: string;
  slug: string | null;
  default_labor_hours: number | null;
};
type Obs = {
  id: string;
  source: string;
  hours: number;
  weight: number;
  tier: string;
  observed_at: number;
  sibling_slug: string | null;
  match_key: string | null;
};

// Observation source → display label + trust note (reality: labor_observations
// sources; spec names repairpal_motor / vehicle_databases map onto these).
const SOURCE_META: Record<string, { label: string; note: string }> = {
  repairpal_endpoint: {
    label: "RepairPal / MOTOR",
    note: "high-confidence flat-rate — wins outright when present (Jun 18)",
  },
  olp_labor: { label: "OLP labor", note: "scraped book time — strong anchor" },
  web_labor: { label: "Web labor", note: "scraped corroboration" },
  llm_web: { label: "LLM (web search)", note: "model estimate with search" },
  llm_training: { label: "LLM (training)", note: "model estimate, no search" },
  vdb_repair_estimates: {
    label: "Vehicle Databases",
    note: "known-low (May 29)",
  },
};

// Engine source → human selection reason for the effective highlight.
const SELECTION_REASON: Record<string, string> = {
  empirical:
    "Empirical post-job actuals at/over the sample gate — highest trust, bypasses the tier floor.",
  aggregated:
    "Weighted robust median of the catalog sources below (RepairPal face value wins outright when present).",
  vdb: "Direct book row (quality-gated single source).",
  vdb_camry_baseline: "Camry anchor row (this config IS the baseline).",
  sibling: "Sibling-chassis book hours (platform-equivalent match).",
  tier_estimate:
    "Camry baseline × tier multiplier — internal fallback, bound only, never truth.",
};

function fmtHours(h: number | null | undefined): string {
  return h == null ? "—" : `${h.toFixed(1)}h`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

function LadderRow({
  label,
  badge,
  hours,
  meta,
  highlighted,
  reason,
  greyed,
}: {
  label: string;
  badge?: React.ReactNode;
  hours: string;
  meta: React.ReactNode;
  highlighted?: boolean;
  reason?: string;
  greyed?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        highlighted
          ? "border-emerald-300 bg-emerald-50"
          : "border-slate-100 bg-white"
      } ${greyed ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-slate-900">{label}</span>
        {badge}
        {highlighted && (
          <span className={`${pill} bg-emerald-600 text-white`}>EFFECTIVE</span>
        )}
        <span className="ml-auto text-base font-bold text-slate-900">{hours}</span>
      </div>
      <div className="mt-1 text-[12px] text-slate-500">{meta}</div>
      {highlighted && reason && (
        <div className="mt-1.5 text-[12px] font-medium text-emerald-700">{reason}</div>
      )}
    </div>
  );
}

export default function LaborCommandCenterPage() {
  const { token } = usePortalSession();

  const services = useQuery(api.dataLabor.servicesList, { token });

  const [serviceId, setServiceId] = useState<string>("");
  const [selectedConfig, setSelectedConfig] = useState<PickedConfig | null>(null);

  const ladder = useQuery(
    api.dataLabor.laborLadder,
    serviceId && selectedConfig
      ? {
          token,
          configId: selectedConfig.id as Id<"vehicle_configs">,
          serviceId: serviceId as Id<"services">,
        }
      : "skip",
  );

  // Group observations by source: median-ish display when a source has several.
  const obsBySource = useMemo(() => {
    const map = new Map<string, NonNullable<typeof ladder>["observations"]>();
    if (ladder?.observations) {
      for (const o of ladder.observations) {
        const list = map.get(o.source) ?? [];
        list.push(o);
        map.set(o.source, list);
      }
    }
    return map;
  }, [ladder]);

  const eff = ladder?.effective ?? null;
  const effSource = eff?.source ?? null;
  const agg = ladder?.aggregate ?? null;

  // Which ladder row carries the effective highlight.
  const bookEffective =
    effSource === "aggregated" ||
    effSource === "vdb" ||
    effSource === "vdb_camry_baseline" ||
    effSource === "sibling";
  // RepairPal face value drives the book value outright when present.
  const repairpalDrivesBook =
    bookEffective && (obsBySource.get("repairpal_endpoint")?.length ?? 0) > 0;

  const ladderLoading = serviceId && selectedConfig && ladder === undefined;

  const catalogOrder = [
    "repairpal_endpoint",
    "olp_labor",
    "web_labor",
    "llm_web",
    "llm_training",
    "vdb_repair_estimates",
  ];
  const knownSources = new Set(catalogOrder);
  const extraSources = [...obsBySource.keys()].filter((s) => !knownSources.has(s));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Labor Times Command Center
        </h1>
        {/* Fixed policy banner (May 29) */}
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
          Labor times are uniform car-to-car, not state-to-state. No state
          dimension exists here by design.
        </div>
      </div>

      {/* Zone 1 — selector bar: service × config */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="text-xs font-semibold text-slate-600">Service</label>
            {services === undefined ? (
              <div className="mt-1.5 h-9 animate-pulse rounded-lg bg-slate-100" />
            ) : services.length === 0 ? (
              <p className="mt-1.5 text-sm text-slate-500">
                No services exist in the catalog yet.
              </p>
            ) : (
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border-[1.5px] border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
              >
                <option value="">Select a service…</option>
                {services.map((s: ServiceOpt) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.default_labor_hours != null
                      ? ` (default ${s.default_labor_hours}h)`
                      : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          <ConfigPicker
            token={token}
            selected={selectedConfig}
            onSelect={setSelectedConfig}
            label="Vehicle (VIN · year/make/model · config_key)"
          />
        </div>
      </div>

      {/* Zone 2 — source ladder */}
      {!serviceId || !selectedConfig ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Pick a service and a vehicle config above — every labor value we hold
          for the pair renders below, one row per source, with the effective
          value the app uses highlighted.
        </div>
      ) : ladderLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : ladder === null ? (
        <div className="rounded-xl border border-red-200 bg-white p-5 text-sm text-red-700">
          That config or service no longer exists.
        </div>
      ) : ladder ? (
        <>
          {/* Effective summary strip */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  {eff ? fmtHours(eff.hours) : "—"}
                </div>
                <div className="mt-1 text-xs font-medium text-slate-500">
                  effective hours
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  {eff ? eff.confidence.toFixed(2) : "—"}
                </div>
                <div className="mt-1 text-xs font-medium text-slate-500">confidence</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  {ladder.guardrail.tier ?? "—"}
                </div>
                <div className="mt-1 text-xs font-medium text-slate-500">pricing tier</div>
              </div>
              <div className="min-w-0 flex-1 text-[12px] text-slate-500">
                {eff ? (
                  <>
                    Source <span className="font-semibold text-slate-700">{eff.source}</span>
                    {eff.tier_floor_applied && (
                      <span className={`${pill} ml-2 bg-amber-50 text-amber-700`}>
                        tier floor applied ({fmtHours(eff.raw_hours)} raw)
                      </span>
                    )}
                    {eff.above_tier_floor && (
                      <span className={`${pill} ml-2 bg-slate-100 text-slate-600`}>
                        above tier floor
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    Engine refused:{" "}
                    <span className="font-medium text-amber-700">
                      {ladder.effective_refusal ?? "unknown"}
                    </span>
                    {" — "}the app would fall back to the catalog default (
                    {fmtHours(ladder.service.default_labor_hours)}).
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">
              Source ladder ·{" "}
              <span className="font-mono text-[12px] font-normal text-slate-500">
                {ladder.service.name} × {ladder.config.config_key}
              </span>
            </h2>

            {ladder.observations.length === 0 && !agg && (
              <p className="mt-3 text-sm text-slate-500">
                No labor observations or aggregate row exist for this pair yet —
                the app would quote from the multiplier bound or the catalog
                default.
              </p>
            )}

            <div className="mt-3 space-y-2">
              {/* Catalog observation rows, fixed trust order */}
              {[...catalogOrder, ...extraSources].map((src) => {
                const rows = obsBySource.get(src);
                if (!rows || rows.length === 0) return null;
                const meta = SOURCE_META[src];
                const isVdb = src === "vdb_repair_estimates";
                const isRp = src === "repairpal_endpoint";
                return (
                  <LadderRow
                    key={src}
                    label={meta?.label ?? src}
                    badge={
                      isVdb ? (
                        <span className={`${pill} bg-amber-50 text-amber-700`}>
                          known-low (May 29)
                        </span>
                      ) : undefined
                    }
                    hours={
                      rows.length === 1
                        ? fmtHours(rows[0].hours)
                        : rows.map((r: Obs) => r.hours.toFixed(1)).join(" / ") + "h"
                    }
                    highlighted={isRp && repairpalDrivesBook}
                    reason="RepairPal face value drives book_hours outright when present."
                    meta={
                      <>
                        weight {rows[0].weight}
                        {meta?.note ? ` · ${meta.note}` : ""} · observed{" "}
                        {fmtDate(rows[0].observed_at)}
                        {rows[0].sibling_slug
                          ? ` · via sibling ${rows[0].sibling_slug}`
                          : ""}
                        {rows[0].match_key ? ` · ${rows[0].match_key}` : ""}
                      </>
                    }
                  />
                );
              })}

              {/* Aggregated book value (the materialized labor_times row) */}
              {agg && agg.book_hours != null && (
                <LadderRow
                  label="Aggregated book value"
                  badge={
                    agg.source == null ? (
                      <span className={`${pill} bg-slate-100 text-slate-500`}>
                        untagged
                      </span>
                    ) : (
                      <span className={`${pill} bg-slate-100 text-slate-600`}>
                        {agg.source}
                      </span>
                    )
                  }
                  hours={fmtHours(agg.book_hours)}
                  highlighted={bookEffective && !repairpalDrivesBook}
                  reason={effSource ? SELECTION_REASON[effSource] : undefined}
                  meta={
                    <>
                      confidence {agg.confidence?.toFixed(2) ?? "—"} · quality{" "}
                      {agg.data_quality ?? "—"}
                    </>
                  }
                />
              )}

              {/* Empirical (rolling post-job actuals) */}
              <LadderRow
                label="Empirical"
                hours={fmtHours(agg?.empirical_hours)}
                highlighted={effSource === "empirical"}
                reason={SELECTION_REASON.empirical}
                greyed={
                  agg?.empirical_hours == null ||
                  (agg?.empirical_sample_size ?? 0) < 3
                }
                meta={
                  agg?.empirical_hours == null ? (
                    "no post-job actuals yet — promoted at 3+ samples"
                  ) : (
                    <>
                      n={agg.empirical_sample_size ?? 0}
                      {(agg.empirical_sample_size ?? 0) < 5 &&
                        " (insufficient sample for percentiles)"}
                      {agg.empirical_p25 != null && agg.empirical_p75 != null && (
                        <>
                          {" "}
                          · p25 {fmtHours(agg.empirical_p25)} / p75{" "}
                          {fmtHours(agg.empirical_p75)}
                        </>
                      )}
                    </>
                  )
                }
              />

              {/* Multiplier guardrail bound */}
              <LadderRow
                label="Multiplier guardrail"
                badge={
                  <span className={`${pill} bg-slate-100 text-slate-600`}>
                    bound only — never truth
                  </span>
                }
                hours={fmtHours(ladder.guardrail.floor_hours)}
                highlighted={effSource === "tier_estimate"}
                reason={SELECTION_REASON.tier_estimate}
                greyed={ladder.guardrail.floor_hours == null}
                meta={
                  ladder.guardrail.floor_hours == null
                    ? "no bound — missing tier, multiplier row, or Camry seed hours"
                    : `Camry book hours × ${ladder.guardrail.tier} labor multiplier (Jun 18)`
                }
              />
            </div>
          </div>

          {/* Zone 3 — guardrail flags on the aggregate row */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Guardrail flags</h2>
            {!agg ? (
              <p className="mt-3 text-sm text-slate-500">
                No materialized labor_times row for this pair — nothing to flag.
              </p>
            ) : !agg.labor_outside_fallback_band && !agg.labor_sources_disagree ? (
              <p className="mt-3 text-sm text-slate-500">
                No guardrail flags on this row — book value sits inside the
                fallback band and sources agree.
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {agg.labor_outside_fallback_band && (
                  <span className={`${pill} bg-amber-50 text-amber-700`}>
                    outside fallback band
                    {agg.fallback_gap_minutes != null
                      ? ` · gap ${agg.fallback_gap_minutes} min`
                      : ""}
                  </span>
                )}
                {agg.labor_sources_disagree && (
                  <span className={`${pill} bg-red-50 text-red-700`}>
                    strong sources disagree
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
