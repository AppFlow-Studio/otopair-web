"use client";

// Data · Pricing Engine (tiers & multipliers) — /data/pricing-engine
// (Data spec §9.3). INTERNAL — GATED. Flow: capability check (data.write →
// super_admin + data_admin only) → red interstitial with TOTP re-auth
// (director_auth.reverifyTotp) → recordGateEntry audits the view → page.
// Layout: tier list | Camry golden record | editable multiplier grids with
// blast-radius preview; every edit is a CO-SIGNED ceremony. Fixed verbatim
// policy banner. Edit history from pricing_fallback_snapshots.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession, useCan } from "../../portal-session";
import { CoSignCeremony } from "@/components/portal/CoSignCeremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleString();

type TierOverviewRow = {
  id: string;
  code: string;
  name: string;
  anchor_vehicle_label: string;
  description: string | null;
  is_active: boolean;
  config_count: number;
  config_count_capped: boolean;
  assignment_count: number;
  assignment_count_capped: boolean;
};
type MatrixCellV1 = {
  id: string;
  tier_id: string;
  category_id: string;
  multiplier: number;
  is_locked: boolean;
  notes: string | null;
};
type MatrixCellV2 = {
  id: string;
  category_id: string;
  tier: string;
  multiplier: number;
  source: string | null;
};
type BaselineRow = {
  id: string;
  service_name: string;
  service_slug: string | null;
  base_price_low_cents: number;
  base_price_high_cents: number;
  is_real_data: boolean;
  data_source: string | null;
  notes: string | null;
};
type HistoryRow = {
  id: string;
  entity_type: string;
  entity_label: string;
  changes_summary: string;
  is_restore: boolean;
  actor_name: string;
  created_at: number;
};
type EditKind = "v1_multiplier" | "parts_multiplier" | "labor_multiplier" | "baseline";
type PendingEdit =
  | { kind: "v1_multiplier"; id: string; label: string; from: number; multiplier: number }
  | { kind: "parts_multiplier"; id: string; label: string; from: number; multiplier: number }
  | { kind: "labor_multiplier"; id: string; label: string; from: number; multiplier: number }
  | {
      kind: "baseline";
      id: string;
      label: string;
      from: string;
      base_price_low_cents: number;
      base_price_high_cents: number;
    };

export default function PricingEnginePage() {
  const { token } = usePortalSession();
  const canWrite = useCan("data.write");

  const [unlocked, setUnlocked] = useState(false);
  const [totp, setTotp] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState("");

  const reverify = useAction(api.director_auth.reverifyTotp);
  const recordEntry = useMutation(api.dataPricingEngine.recordGateEntry);
  const applyCosigned = useAction(api.dataPricingEngine.applyCosigned);

  // Queries only fire after the gate (they'd throw for non-data.write roles).
  const overview = useQuery(api.dataPricingEngine.overview, unlocked ? { token } : "skip");
  const matrices = useQuery(api.dataPricingEngine.multiplierMatrices, unlocked ? { token } : "skip");
  const golden = useQuery(api.dataPricingEngine.camryGoldenRecord, unlocked ? { token } : "skip");
  const history = useQuery(api.dataPricingEngine.editHistory, unlocked ? { token } : "skip");

  const [pending, setPending] = useState<PendingEdit | null>(null);
  const radius = useQuery(
    api.dataPricingEngine.blastRadius,
    pending ? { token, kind: pending.kind as EditKind, id: pending.id } : "skip",
  );

  // ---- Restricted card (capability gate) ----
  if (!canWrite) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border-2 border-red-200 bg-white p-8 text-center">
        <div className="text-3xl">🔒</div>
        <h1 className="mt-2 text-lg font-semibold text-slate-900">
          Internal pricing system — restricted
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          This page is limited to Super Admin and Data Admin roles (the{" "}
          <span className="font-mono">data.write</span> capability). Your session&apos;s role
          can&apos;t view it; access attempts are logged.
        </p>
      </div>
    );
  }

  // ---- TOTP interstitial ----
  if (!unlocked) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border-2 border-red-300 bg-white p-8">
        <div className="text-center text-3xl">🔐</div>
        <h1 className="mt-2 text-center text-lg font-semibold text-slate-900">
          Internal pricing system — access logged
        </h1>
        <p className="mt-2 text-center text-sm text-slate-600">
          Re-enter your 6-digit TOTP code to open the tiers &amp; multipliers console. Every
          page view writes an audit row (spec §9.3).
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <input
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(e) => e.key === "Enter" && void unlock()}
            placeholder="123456"
            inputMode="numeric"
            autoFocus
            className="w-40 rounded-lg border-[1.5px] border-slate-300 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] outline-none focus:border-red-500"
          />
          <button
            onClick={() => void unlock()}
            disabled={gateBusy || totp.length !== 6}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {gateBusy ? "Verifying…" : "Unlock"}
          </button>
        </div>
        {gateError && (
          <p className="mt-3 text-center text-[13px] font-medium text-red-600">{gateError}</p>
        )}
      </div>
    );
  }

  async function unlock() {
    setGateBusy(true);
    setGateError("");
    try {
      const res = await reverify({ token, code: totp });
      if (!res.ok) {
        setGateError("Code invalid or expired — try the next code from your authenticator.");
        setGateBusy(false);
        return;
      }
      await recordEntry({ token });
      setUnlocked(true);
      setGateBusy(false);
    } catch (e) {
      setGateBusy(false);
      setGateError(e instanceof Error ? e.message : "Verification failed.");
    }
  }

  const cellButton = (edit: PendingEdit) => setPending(edit);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Pricing Engine — tiers &amp; multipliers{" "}
          <span className={`${pill} ml-1 bg-red-600 text-white`}>INTERNAL</span>
        </h1>
        {/* Fixed verbatim policy banner (spec §9.3) */}
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-[12px] font-semibold text-red-800">
          Fallback &amp; sanity-check only — never customer-facing, never overrides a sourced
          price.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Left — tier list */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">Tiers</h2>
          {overview === undefined ? (
            <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
          ) : (
            (overview.tiers as TierOverviewRow[]).map((t) => (
              <div key={t.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold text-slate-900">{t.code}</span>
                  <span className="text-[13px] font-medium text-slate-700">{t.name}</span>
                  {!t.is_active && (
                    <span className={`${pill} bg-slate-100 text-slate-500`}>inactive</span>
                  )}
                </div>
                <div className="mt-1 text-[12px] text-slate-500">
                  anchor: {t.anchor_vehicle_label}
                </div>
                <div className="mt-2 flex gap-2">
                  <span className={`${pill} bg-slate-100 text-slate-600`}>
                    {t.config_count}
                    {t.config_count_capped ? "+" : ""} configs
                  </span>
                  <span className={`${pill} bg-slate-100 text-slate-600`}>
                    {t.assignment_count}
                    {t.assignment_count_capped ? "+" : ""} assignments
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Center — Camry golden record */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Camry golden record{" "}
            <span className="font-normal text-slate-400">(the one perfectly-populated anchor)</span>
          </h2>
          {golden === undefined ? (
            <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              {/* 64px completeness ring */}
              <div className="flex items-center gap-4">
                <CompletenessRing pct={golden.completeness_pct} />
                <div className="text-[13px] text-slate-600">
                  {golden.baselines.filter((b: BaselineRow) => b.is_real_data).length} of{" "}
                  {golden.services_total} services carry a real-data Camry baseline.
                </div>
              </div>
              <div className="mt-3 max-h-[420px] space-y-1.5 overflow-auto">
                {(golden.baselines as BaselineRow[]).map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-2 rounded-lg border border-slate-100 px-3 py-1.5 text-[13px]"
                  >
                    <span className="truncate text-slate-700">{b.service_name}</span>
                    {!b.is_real_data && (
                      <span className={`${pill} bg-amber-50 text-amber-700`}>estimate</span>
                    )}
                    <span className="ml-auto font-mono text-[12px] text-slate-800">
                      ${(b.base_price_low_cents / 100).toFixed(0)}–$
                      {(b.base_price_high_cents / 100).toFixed(0)}
                    </span>
                    <button
                      onClick={() =>
                        cellButton({
                          kind: "baseline",
                          id: b.id,
                          label: b.service_name,
                          from: `$${(b.base_price_low_cents / 100).toFixed(0)}–$${(b.base_price_high_cents / 100).toFixed(0)}`,
                          base_price_low_cents: b.base_price_low_cents,
                          base_price_high_cents: b.base_price_high_cents,
                        })
                      }
                      className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:bg-blue-50"
                    >
                      edit
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right — multiplier grids */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">Multiplier matrices</h2>
          {matrices === undefined ? (
            <div className="h-64 animate-pulse rounded-xl bg-slate-100" />
          ) : (
            <div className="space-y-4">
              <MatrixCard
                title={`v2 parts (${matrices.parts.categories.length} × 7)`}
                tiers={overview?.v2_tier_codes ?? []}
                categories={matrices.parts.categories}
                cells={matrices.parts.cells as MatrixCellV2[]}
                onEdit={(cell, label) =>
                  cellButton({
                    kind: "parts_multiplier",
                    id: cell.id,
                    label,
                    from: cell.multiplier,
                    multiplier: cell.multiplier,
                  })
                }
              />
              <MatrixCard
                title={`v2 labor (${matrices.labor.categories.length} × 7)`}
                tiers={overview?.v2_tier_codes ?? []}
                categories={matrices.labor.categories}
                cells={matrices.labor.cells as MatrixCellV2[]}
                onEdit={(cell, label) =>
                  cellButton({
                    kind: "labor_multiplier",
                    id: cell.id,
                    label,
                    from: cell.multiplier,
                    multiplier: cell.multiplier,
                  })
                }
              />
              <V1MatrixCard
                v1={matrices.v1}
                onEdit={(cell, label) =>
                  cellButton({
                    kind: "v1_multiplier",
                    id: cell.id,
                    label,
                    from: cell.multiplier,
                    multiplier: cell.multiplier,
                  })
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Edit history */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
          Edit history (fallback snapshots — every change restorable)
        </div>
        {history === undefined ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No pricing edits recorded yet.</p>
        ) : (
          <div className="divide-y divide-slate-50">
            {(history as HistoryRow[]).map((h) => (
              <div key={h.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px]">
                <span className={`${pill} bg-slate-100 text-slate-600`}>{h.entity_type}</span>
                <span className="text-slate-700">{h.entity_label}</span>
                <span className="text-slate-500">{h.changes_summary}</span>
                {h.is_restore && <span className={`${pill} bg-amber-50 text-amber-700`}>restore</span>}
                <span className="ml-auto text-[12px] text-slate-400">
                  {h.actor_name} · {fmtDate(h.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Co-signed edit ceremony */}
      <CoSignCeremony
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Edit ${pending?.kind.replace(/_/g, " ")} — ${pending?.label ?? ""}`}
        summary={
          pending && (
            <div className="space-y-2">
              {pending.kind === "baseline" ? (
                <div className="flex items-center gap-2">
                  <span>{pending.from} →</span>
                  <input
                    type="number"
                    defaultValue={pending.base_price_low_cents / 100}
                    onChange={(e) =>
                      setPending({
                        ...pending,
                        base_price_low_cents: Math.round(parseFloat(e.target.value || "0") * 100),
                      })
                    }
                    className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  />
                  <span>–</span>
                  <input
                    type="number"
                    defaultValue={pending.base_price_high_cents / 100}
                    onChange={(e) =>
                      setPending({
                        ...pending,
                        base_price_high_cents: Math.round(parseFloat(e.target.value || "0") * 100),
                      })
                    }
                    className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  />
                  <span>USD</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span>×{pending.from} →</span>
                  <input
                    type="number"
                    step="0.05"
                    defaultValue={pending.multiplier}
                    onChange={(e) =>
                      setPending({ ...pending, multiplier: parseFloat(e.target.value || "0") })
                    }
                    className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  />
                </div>
              )}
            </div>
          )
        }
        blastRadius={
          radius === undefined
            ? "computing blast radius…"
            : radius
              ? `Affects ${radius.affected_configs}${radius.capped ? "+" : ""} configs' fallback prices (${radius.note}).`
              : null
        }
        onConfirm={async (reason, cosignEmail, cosignCode) => {
          if (!pending) return;
          const edit =
            pending.kind === "baseline"
              ? {
                  kind: "baseline" as const,
                  id: pending.id as never,
                  base_price_low_cents: pending.base_price_low_cents,
                  base_price_high_cents: pending.base_price_high_cents,
                }
              : {
                  kind: pending.kind,
                  id: pending.id as never,
                  multiplier: pending.multiplier,
                };
          await applyCosigned({
            token,
            reason,
            cosign_email: cosignEmail,
            cosign_code: cosignCode,
            edit: edit as never,
          });
        }}
      />
    </div>
  );
}

function CompletenessRing({ pct }: { pct: number }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex h-16 w-16 shrink-0 items-center justify-center">
      <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#e2e8f0" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={pct >= 80 ? "#10b981" : pct >= 40 ? "#f59e0b" : "#ef4444"}
          strokeWidth="6"
          strokeDasharray={`${(circ * pct) / 100} ${circ}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[13px] font-bold text-slate-800">{pct}%</span>
    </span>
  );
}

function MatrixCard({
  title,
  tiers,
  categories,
  cells,
  onEdit,
}: {
  title: string;
  tiers: string[];
  categories: { id: string; code: string; name: string }[];
  cells: MatrixCellV2[];
  onEdit: (cell: MatrixCellV2, label: string) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[13px] font-semibold text-slate-900">{title}</div>
      <div className="mt-2 overflow-x-auto">
        <table className="text-[11px]">
          <thead>
            <tr>
              <th />
              {tiers.map((t) => (
                <th key={t} className="px-1 pb-1 font-semibold text-slate-500">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td className="pr-2 text-right font-medium text-slate-600">{c.code}</td>
                {tiers.map((t) => {
                  const cell = cells.find((x) => x.category_id === c.id && x.tier === t);
                  return (
                    <td key={t} className="p-0.5">
                      {cell ? (
                        <button
                          onClick={() => onEdit(cell, `${c.code} × ${t}`)}
                          title={cell.source ?? undefined}
                          className="w-12 rounded-md border border-slate-200 py-1 text-center font-mono hover:border-blue-400 hover:bg-blue-50"
                        >
                          {cell.multiplier.toFixed(2)}
                        </button>
                      ) : (
                        <span className="block w-12 py-1 text-center text-slate-300">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function V1MatrixCard({
  v1,
  onEdit,
}: {
  v1: {
    tiers: { id: string; code: string; name: string }[];
    categories: { id: string; code: string; name: string }[];
    cells: MatrixCellV1[];
  };
  onEdit: (cell: MatrixCellV1, label: string) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[13px] font-semibold text-slate-900">
        v1 tier × service category ({v1.categories.length} × {v1.tiers.length})
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="text-[11px]">
          <thead>
            <tr>
              <th />
              {v1.tiers.map((t) => (
                <th key={t.id} className="px-1 pb-1 font-semibold text-slate-500">
                  {t.code}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v1.categories.map((c) => (
              <tr key={c.id}>
                <td className="pr-2 text-right font-medium text-slate-600">{c.code}</td>
                {v1.tiers.map((t) => {
                  const cell = v1.cells.find(
                    (x) => x.category_id === c.id && x.tier_id === t.id,
                  );
                  return (
                    <td key={t.id} className="p-0.5">
                      {cell ? (
                        <button
                          onClick={() => onEdit(cell, `${c.code} × ${t.code}`)}
                          disabled={cell.is_locked}
                          title={
                            cell.is_locked
                              ? "locked — validated by bookings"
                              : (cell.notes ?? undefined)
                          }
                          className={`w-12 rounded-md border py-1 text-center font-mono ${
                            cell.is_locked
                              ? "border-slate-100 bg-slate-50 text-slate-400"
                              : "border-slate-200 hover:border-blue-400 hover:bg-blue-50"
                          }`}
                        >
                          {cell.multiplier.toFixed(2)}
                          {cell.is_locked ? "🔒" : ""}
                        </button>
                      ) : (
                        <span className="block w-12 py-1 text-center text-slate-300">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
