"use client";

// Data · Coverage & Quality — /data/coverage (Data spec §10.4).
// Make × year-band matrix with fill shading (live over 384 configs) ·
// per-field-family completeness bars from the DAY stat (applicability-aware
// denominators via the runs' own stamps) · launch-make tracker chips · the
// April launch-reality annotation pinned as copy. Trend chart starts the day
// a second daily snapshot exists — computed_at rendered honestly until then.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import { MatrixGrid, type MatrixCell } from "@/components/portal/MatrixGrid";
import { MiniBar } from "@/components/portal/MiniBar";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

type MatrixCellData = {
  make: string;
  band: string;
  configs: number;
  avg_fill: number | null;
  avg_applicable_fill: number | null;
};

type FamilyMeta = {
  families?: Record<string, { filled: number; total: number }>;
  intervals?: { avg_applicable_fill_rate: number; samples: number };
  parts_quotability?: { avg_pct: number; samples: number };
  configs?: number;
};

export default function CoveragePage() {
  const { token } = usePortalSession();
  const data = useQuery(api.dataCoverage.matrix, { token });
  const famStat = useQuery(api.portalStats.getStats, {
    token,
    keys: ["data.coverage.field_families"],
  });

  const fam = famStat?.["data.coverage.field_families"];
  const famMeta = (fam?.meta ?? null) as FamilyMeta | null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Coverage &amp; Quality</h1>
        {/* Launch reality, pinned (Apr measurement / spec §10.4) */}
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-[12px] font-medium text-slate-600">
          Launch reality (Apr measurement): intervals 35% / labor 52% pre-fallback — 89%
          where fallback applies. Saturday data sessions aim at the true weak spots; this
          page tracks whether they land. Applicability-aware denominators: a field that
          shouldn&apos;t exist never counts as missing.
        </div>
      </div>

      {/* Matrix */}
      {data === undefined ? (
        <div className="h-72 animate-pulse rounded-xl bg-slate-100" />
      ) : data.cells.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No vehicle configs on this deployment.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">
            Make × year band — avg fill rate{" "}
            <span className="font-normal text-slate-400">
              ({data.configs_total} configs{data.truncated ? ", window truncated at 500" : ""})
            </span>
          </h2>
          <div className="mt-4">
            <MatrixGrid
              rowLabels={data.makes}
              colLabels={data.bands}
              cells={data.makes.map((make: string) =>
                data.bands.map((band: string): MatrixCell => {
                  const cell = (data.cells as MatrixCellData[]).find(
                    (c) => c.make === make && c.band === band,
                  );
                  if (!cell) return { value: null };
                  return {
                    value: cell.avg_fill,
                    sub: `${cell.configs} cfg`,
                    title: `${make} ${band}: ${cell.configs} configs, avg fill ${
                      cell.avg_fill == null ? "—" : Math.round(cell.avg_fill * 100) + "%"
                    }`,
                  };
                }),
              )}
            />
          </div>
        </div>
      )}

      {/* Launch-make tracker */}
      {data && data.launch_makes.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Launch-make tracker</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {(data.launch_makes as { make: string; configs: number; avg_fill: number | null }[]).map(
              (m) => (
                <span
                  key={m.make}
                  className={`${pill} ${
                    m.avg_fill != null && m.avg_fill >= 0.8
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {m.make} · {m.configs} cfg ·{" "}
                  {m.avg_fill == null ? "—" : `${Math.round(m.avg_fill * 100)}%`}
                </span>
              ),
            )}
          </div>
        </div>
      )}

      {/* Field-family bars from the DAY stat */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Field-family completeness{" "}
          <span className="font-normal text-slate-400">
            (daily stat{fam ? `, computed ${fmtDate(fam.computed_at)}` : ""})
          </span>
        </h2>
        {famStat === undefined ? (
          <div className="mt-3 h-24 animate-pulse rounded-lg bg-slate-100" />
        ) : fam == null ? (
          <p className="mt-3 text-sm text-slate-500">
            The daily coverage sweep hasn&apos;t produced its first snapshot on this deployment
            yet — run <span className="font-mono">portalStats:recomputeEvidenceStats</span>.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {Object.entries(famMeta?.families ?? {}).map(([name, f]) => (
              <div key={name} className="flex items-center gap-3 text-[13px]">
                <span className="w-28 font-medium text-slate-700">{name}</span>
                <MiniBar value={f.total > 0 ? f.filled / f.total : 0} width={160} />
                <span className="text-slate-500">
                  {f.filled}/{f.total} ({f.total > 0 ? Math.round((f.filled / f.total) * 100) : 0}
                  %)
                </span>
              </div>
            ))}
            {famMeta?.intervals && (
              <div className="flex items-center gap-3 text-[13px]">
                <span className="w-28 font-medium text-slate-700">Intervals</span>
                <MiniBar value={(famMeta.intervals.avg_applicable_fill_rate ?? 0) / 100} width={160} />
                <span className="text-slate-500">
                  avg applicable fill {Math.round(famMeta.intervals.avg_applicable_fill_rate)}% (
                  {famMeta.intervals.samples} configs with runs)
                </span>
              </div>
            )}
            {famMeta?.parts_quotability && (
              <div className="flex items-center gap-3 text-[13px]">
                <span className="w-28 font-medium text-slate-700">Parts</span>
                <MiniBar value={famMeta.parts_quotability.avg_pct} width={160} />
                <span className="text-slate-500">
                  avg quotability {Math.round(famMeta.parts_quotability.avg_pct * 100)}% (
                  {famMeta.parts_quotability.samples} configs)
                </span>
              </div>
            )}
            <p className="pt-1 text-[11px] text-slate-400">
              Trend lines begin once a second daily snapshot exists — until then this shows
              the latest computation, honestly dated.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
