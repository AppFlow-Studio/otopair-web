"use client";

// Data · Service Catalog — /data/service-catalog (Data spec §11).
// 23 services grouped by the four locked categories (Routine · Tires &
// Brakes · Scheduled Service · Inspections). default_labor_hours edits are a
// ceremony (the value multiplies across every shop's pricing). Options
// drawer with phone-frame preview. SLIM 7→4 migration card (user decision
// Jul 14): collapsed green record where the consolidation already ran (dev),
// expandable dry-run/execute kept for the prod cutover.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "@/app/(portals)/portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleString());

type ServiceRow = {
  id: string;
  name: string;
  slug: string | null;
  default_labor_hours: number | null;
  display_order: number | null;
  options_count: number;
  offered_by_shops: number;
  bookable_signal: boolean;
  parts_kind: string | null;
};
type CategoryGroup = {
  id: string;
  name: string;
  display_order: number | null;
  services: ServiceRow[];
};
type ServiceOptionRow = {
  id: string;
  option_label: string;
  option_type: string | null;
  labor_hours: number | null;
  parts_cost_low: number | null;
  parts_cost_high: number | null;
  state_fee: number | null;
  display_order: number | null;
};
type ConsolidationResult = {
  dryRun: boolean;
  creates: string[];
  moves: { slug: string; from: string; to: string }[];
  deletes: string[];
  services?: number;
};

export default function ServiceCatalogPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");

  const catalog = useQuery(api.dataServiceCatalog.catalog, { token });
  const migration = useQuery(api.dataServiceCatalog.migrationStatus, { token });
  const updateHours = useMutation(api.dataServiceCatalog.updateDefaultLaborHours);
  const runMigration = useMutation(api.dataServiceCatalog.runCategoryMigration);

  const [optionsFor, setOptionsFor] = useState<ServiceRow | null>(null);
  const options = useQuery(
    api.dataServiceCatalog.optionsForService,
    optionsFor ? { token, serviceId: optionsFor.id as Id<"services"> } : "skip",
  );

  const [hoursTarget, setHoursTarget] = useState<ServiceRow | null>(null);
  const [hoursValue, setHoursValue] = useState("");
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<ConsolidationResult | null>(null);
  const [executeOpen, setExecuteOpen] = useState(false);
  const [dryRunOpen, setDryRunOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Service Catalog</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          The 23 established services across 4 locked categories.
          default_labor_hours multiplies across every shop&apos;s pricing — edits are
          ceremonies (single-signer; no co-sign primitive exists yet, stated honestly).
        </p>
      </div>

      {/* ---- 7→4 migration card (SLIM) ---- */}
      {migration === undefined ? (
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
      ) : migration.executed ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <button
            onClick={() => setMigrationOpen((o) => !o)}
            className="flex w-full items-center gap-2 text-left"
          >
            <span className={`${pill} bg-emerald-600 text-white`}>DONE</span>
            <span className="text-[13px] font-semibold text-emerald-900">
              7 → 4 category cleanup executed {fmtDate(migration.executed_at)}
            </span>
            <span className="ml-auto text-[12px] text-emerald-700">
              {migrationOpen ? "collapse ▾" : "evidence & prod affordances ▸"}
            </span>
          </button>
          {migrationOpen && (
            <div className="mt-3 space-y-3">
              <div className="rounded-lg bg-white/70 px-3 py-2 font-mono text-[12px] text-emerald-900">
                {migration.executed_detail ?? "(audit detail unavailable)"}
              </div>
              <div className="flex flex-wrap gap-2">
                {migration.categories.map((c: { name: string; services: number }) => (
                  <span key={c.name} className={`${pill} bg-white text-emerald-800`}>
                    {c.name} · {c.services}
                  </span>
                ))}
              </div>
              {canWrite && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDryRunOpen(true)}
                    className="rounded-lg border border-emerald-300 px-3 py-1.5 text-[13px] font-medium text-emerald-800 hover:bg-white"
                  >
                    Dry-run again
                  </button>
                  <span className="text-[12px] text-emerald-700">
                    kept for the prod cutover — on an already-migrated deployment the diff
                    is zero moves
                  </span>
                </div>
              )}
              {dryRunResult && <DryRunDiff result={dryRunResult} />}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2">
            <span className={`${pill} bg-amber-500 text-white`}>PENDING</span>
            <span className="text-[13px] font-semibold text-amber-900">
              7 → 4 category cleanup (Jun 22, owner: Temur) has NOT run on this deployment
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="text-[12px] text-amber-800">Targets:</span>
            {migration.target_names.map((n: string) => (
              <span key={n} className={`${pill} bg-white text-amber-800`}>
                {n}
              </span>
            ))}
          </div>
          {canWrite && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => setDryRunOpen(true)}
                className="rounded-lg border border-amber-400 px-3 py-1.5 text-[13px] font-medium text-amber-900 hover:bg-white"
              >
                Dry-run diff
              </button>
              <button
                onClick={() => setExecuteOpen(true)}
                disabled={dryRunResult == null}
                title={dryRunResult == null ? "Run the dry-run first" : undefined}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                Execute (ceremony)
              </button>
            </div>
          )}
          {dryRunResult && <DryRunDiff result={dryRunResult} />}
        </div>
      )}

      {/* ---- Catalog ---- */}
      {catalog === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : catalog.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No service categories on this deployment.
        </div>
      ) : (
        (catalog as CategoryGroup[]).map((g) => (
          <div key={g.id} className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
              <span className="text-sm font-semibold text-slate-900">{g.name}</span>
              <span className={`${pill} bg-slate-100 text-slate-500`}>
                {g.services.length} service{g.services.length === 1 ? "" : "s"}
              </span>
            </div>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2">Service</th>
                  <th className="px-2 py-2">Slug</th>
                  <th className="px-2 py-2">Default labor</th>
                  <th className="px-2 py-2">Options</th>
                  <th className="px-2 py-2">Offered by</th>
                  <th className="px-2 py-2">Parts kind</th>
                </tr>
              </thead>
              <tbody>
                {g.services.map((s) => (
                  <tr key={s.id} className="border-b border-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-800">
                      {s.name}
                      {!s.bookable_signal && (
                        <span
                          className={`${pill} ml-2 bg-red-50 text-red-700`}
                          title="0 shop offerings — phantom-service signal"
                        >
                          0 offerings
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 font-mono text-[12px] text-slate-500">
                      {s.slug ?? "—"}
                    </td>
                    <td className="px-2 py-2">
                      <span className="font-semibold text-slate-900">
                        {s.default_labor_hours != null ? `${s.default_labor_hours}h` : "—"}
                      </span>
                      {canWrite && (
                        <button
                          onClick={() => {
                            setHoursTarget(s);
                            setHoursValue(String(s.default_labor_hours ?? ""));
                          }}
                          className="ml-2 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                        >
                          edit
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <button
                        onClick={() => setOptionsFor(s)}
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                      >
                        {s.options_count} option{s.options_count === 1 ? "" : "s"} ▸
                      </button>
                    </td>
                    <td className="px-2 py-2 text-slate-600">{s.offered_by_shops} shops</td>
                    <td className="px-2 py-2 text-slate-500">{s.parts_kind ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {/* ---- Options drawer with phone-frame preview ---- */}
      {optionsFor && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/40"
          onClick={() => setOptionsFor(null)}
        >
          <div
            className="absolute right-0 top-0 h-full w-full max-w-2xl overflow-auto bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                {optionsFor.name} — options
              </h2>
              <button
                onClick={() => setOptionsFor(null)}
                className="ml-auto rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-100"
              >
                close ✕
              </button>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                {options === undefined ? (
                  <div className="h-40 animate-pulse rounded-lg bg-slate-100" />
                ) : options.length === 0 ? (
                  <p className="text-sm text-slate-500">No options on this service.</p>
                ) : (
                  <div className="space-y-2">
                    {(options as ServiceOptionRow[]).map((o) => (
                      <div key={o.id} className="rounded-lg border border-slate-100 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium text-slate-800">
                            {o.option_label}
                          </span>
                          {o.option_type && (
                            <span className={`${pill} bg-slate-100 text-slate-500`}>
                              {o.option_type}
                            </span>
                          )}
                          {o.labor_hours != null && (
                            <span className="ml-auto text-[12px] text-slate-600">
                              {o.labor_hours}h
                            </span>
                          )}
                        </div>
                        {(o.parts_cost_low != null || o.parts_cost_high != null) && (
                          <div
                            className="mt-1 text-[11px] text-slate-400 line-through"
                            title="stored for records — removed from pricing math (May 28)"
                          >
                            parts_cost ${o.parts_cost_low ?? "?"}–${o.parts_cost_high ?? "?"}{" "}
                            (stored for records — removed from math, May 28)
                          </div>
                        )}
                        {o.state_fee != null && (
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            state fee ${o.state_fee}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Phone-frame preview */}
              <div className="flex justify-center">
                <div className="h-[420px] w-[210px] rounded-[28px] border-[6px] border-slate-800 bg-slate-50 p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    app preview
                  </div>
                  <div className="mt-1 text-[13px] font-bold text-slate-900">
                    {optionsFor.name}
                  </div>
                  <div className="mt-2 space-y-1.5 overflow-auto">
                    {(options ?? []).map((o: ServiceOptionRow) => (
                      <div
                        key={o.id}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-2"
                      >
                        <div className="text-[11px] font-medium text-slate-800">
                          {o.option_label}
                        </div>
                        {o.labor_hours != null && (
                          <div className="text-[10px] text-slate-500">~{o.labor_hours}h labor</div>
                        )}
                      </div>
                    ))}
                    {(options ?? []).length === 0 && (
                      <div className="rounded-lg border border-dashed border-slate-200 px-2.5 py-4 text-center text-[10px] text-slate-400">
                        no options — service books directly
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hours edit ceremony */}
      <Ceremony
        open={hoursTarget !== null}
        onOpenChange={(o) => !o && setHoursTarget(null)}
        title={`Change default labor hours — ${hoursTarget?.name ?? ""}`}
        summary={
          <>
            <div className="mb-2">
              {hoursTarget?.name}: {hoursTarget?.default_labor_hours ?? "—"}h →{" "}
              <input
                value={hoursValue}
                onChange={(e) => setHoursValue(e.target.value)}
                className="w-16 rounded-md border border-slate-300 px-2 py-0.5 text-center text-sm"
              />
              h
            </div>
            Blast radius: this default multiplies across{" "}
            <span className="font-semibold">every shop&apos;s pricing</span> for this service.
          </>
        }
        onConfirm={async (reason) => {
          if (!hoursTarget) return;
          const hours = parseFloat(hoursValue);
          if (isNaN(hours)) throw new Error("Enter a number of hours.");
          await updateHours({
            token,
            reason,
            serviceId: hoursTarget.id as Id<"services">,
            hours,
          });
        }}
      />

      {/* Dry-run ceremony */}
      <Ceremony
        open={dryRunOpen}
        onOpenChange={setDryRunOpen}
        title="7→4 dry-run diff"
        confirmLabel="Run dry-run"
        summary={
          <>
            Computes the full category-mapping diff (creates / moves / deletes) without
            writing anything. Audit-logged as a dry run.
          </>
        }
        onConfirm={async (reason) => {
          const result = await runMigration({ token, reason, dryRun: true });
          setDryRunResult(result as ConsolidationResult);
        }}
      />
      {/* Execute ceremony */}
      <Ceremony
        open={executeOpen}
        onOpenChange={setExecuteOpen}
        title="EXECUTE 7→4 category migration"
        destructive
        confirmLabel="Execute migration"
        summary={
          <>
            Re-points every service onto the four locked categories and deletes the old
            rows. The dry-run diff below is what will happen:
            {dryRunResult && (
              <span className="mt-1 block font-mono text-[12px]">
                {dryRunResult.creates.length} creates · {dryRunResult.moves.length} moves ·{" "}
                {dryRunResult.deletes.length} deletes
              </span>
            )}
          </>
        }
        onConfirm={async (reason) => {
          const result = await runMigration({ token, reason, dryRun: false });
          setDryRunResult(result as ConsolidationResult);
        }}
      />
    </div>
  );
}

function DryRunDiff({ result }: { result: ConsolidationResult }) {
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-[12px]">
      <div className="font-semibold text-slate-800">
        {result.dryRun ? "Dry-run diff" : "Executed"} — {result.creates.length} creates ·{" "}
        {result.moves.length} moves · {result.deletes.length} deletes
      </div>
      {result.creates.length > 0 && (
        <div className="mt-1.5 text-slate-600">creates: {result.creates.join(", ")}</div>
      )}
      {result.moves.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {result.moves.map((m) => (
            <div key={m.slug} className="font-mono text-slate-600">
              {m.slug}: {m.from} → {m.to}
            </div>
          ))}
        </div>
      )}
      {result.deletes.length > 0 && (
        <div className="mt-1.5 text-red-600">deletes: {result.deletes.join(", ")}</div>
      )}
      {result.creates.length === 0 &&
        result.moves.length === 0 &&
        result.deletes.length === 0 && (
          <div className="mt-1.5 text-emerald-700">
            Zero-move diff — this deployment already matches the four locked categories.
          </div>
        )}
    </div>
  );
}
