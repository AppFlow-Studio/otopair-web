"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertTriangle,
  Ban,
  DollarSign,
  Loader2,
  Save,
  X,
} from "lucide-react";

const TIER_ORDER = ["T1", "T2a", "T2b", "T2c", "T3a", "T3b", "T4"] as const;
type Tier = (typeof TIER_ORDER)[number];

const TIER_EXAMPLES: Record<Tier, string> = {
  T1: "Toyota, Honda, Ford, Hyundai, Kia, Mazda, Nissan, Subaru",
  T2a: "Lexus, Acura, Genesis, Volvo, Infiniti, Buick",
  T2b: "Mercedes (non-AMG), Audi (non-S/RS), VW GTI/Golf R",
  T2c: "BMW 3/5/X3/X5, MINI JCW, Macan base",
  T3a: "BMW M3/M5/X3M, Mercedes-AMG C63/E63, Audi RS/S",
  T3b: "Porsche 911 / Cayman / Boxster, AMG GT, Audi R8",
  T4: "Ferrari, Lamborghini, Rolls-Royce, Bentley, McLaren",
};

type FormRow = {
  tier: Tier;
  label: string;
  band: { lo: number; hi: number; label: string };
  declined: boolean;
  rateInput: string;
};

type TierRow = {
  tier: Tier;
  label: string;
  state: "priced" | "declined" | "unset";
  rate: number | null;
  band: { lo: number; hi: number; label: string };
};

export default function LaborRateCard({ shopId }: { shopId: Id<"shops"> }) {
  const tierData = useQuery(api.shopLaborRates.getLaborRatesByTier, { shop_id: shopId });
  const setTierRates = useMutation(api.shopLaborRates.setLaborRatesByTier);

  const [rows, setRows] = useState<FormRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<
    { tier: string; kind: string; message: string }[]
  >([]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!tierData) return;
    const tiers = tierData.tiers as TierRow[];
    setRows(
      tiers.map((row) => ({
        tier: row.tier,
        label: row.label,
        band: row.band,
        declined: row.state === "declined",
        rateInput: row.rate != null ? String(row.rate) : "",
      })),
    );
  }, [tierData]);

  const inputsValid = rows.every((r) => {
    if (r.declined) return true;
    if (r.rateInput.trim() === "") return true; // empty = leave unset, allowed
    const n = Number(r.rateInput);
    return Number.isFinite(n) && n >= 50 && n <= 900;
  });

  const tiersChanged = useMemo(() => {
    if (!tierData) return false;
    const tiers = tierData.tiers as TierRow[];
    const before = new Map<Tier, { state: TierRow["state"]; rate: number | null }>(
      tiers.map((t) => [t.tier, { state: t.state, rate: t.rate }]),
    );
    for (const r of rows) {
      const prev = before.get(r.tier);
      if (!prev) return true;
      const trimmed = r.rateInput.trim();
      const nowState = r.declined
        ? "declined"
        : trimmed === ""
          ? "unset"
          : "priced";
      if (prev.state !== nowState) return true;
      if (nowState === "priced") {
        const n = Number(trimmed);
        if (!Number.isFinite(n) || Math.round(n) !== prev.rate) return true;
      }
    }
    return false;
  }, [rows, tierData]);

  const canSave = tiersChanged && inputsValid && !saving;

  function setRow(tier: Tier, patch: Partial<FormRow>) {
    setRows((prev) => prev.map((r) => (r.tier === tier ? { ...r, ...patch } : r)));
  }

  function openConfirm() {
    if (!canSave) return;
    setError(null);
    setMessage(null);
    setWarnings([]);
    setConfirmOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setMessage(null);
    setWarnings([]);
    try {
      const rateMap: Partial<Record<Tier, number>> = {};
      const declined: Tier[] = [];
      for (const r of rows) {
        if (r.declined) {
          declined.push(r.tier);
          continue;
        }
        const trimmed = r.rateInput.trim();
        if (trimmed === "") continue;
        const n = Number(trimmed);
        if (Number.isFinite(n)) rateMap[r.tier] = Math.round(n);
      }
      const result = await setTierRates({
        shop_id: shopId,
        rates: rateMap,
        declined_tiers: declined,
      });
      if (result.warnings.length > 0) setWarnings(result.warnings);
      setMessage("Labor rates saved.");
      setConfirmOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save labor rates.");
    } finally {
      setSaving(false);
    }
  }

  if (!tierData) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <p className="text-sm text-gray-400">Loading labor rates...</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-1 uppercase tracking-wide">
        Labor Rate Card
      </h2>
      <p className="text-sm text-gray-500 mb-5">
        Set your hourly rate for each vehicle tier.{" "}
        {tierData.legacy_labor_rate != null ? (
          <>
            Blank tiers fall back to your shop&apos;s base labor rate of{" "}
            <span className="font-medium text-gray-700">
              ${tierData.legacy_labor_rate}/hr
            </span>
            .
          </>
        ) : (
          <>Blank tiers won&apos;t be priced until a rate is set.</>
        )}{" "}
        Use Decline to mark a tier you don&apos;t service.
      </p>

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left font-semibold w-[40%]">Tier</th>
              <th className="px-4 py-3 text-left font-semibold">
                Suggested band
              </th>
              <th className="px-4 py-3 text-left font-semibold">Rate ($/hr)</th>
              <th className="px-4 py-3 text-right font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => {
              const trimmed = row.rateInput.trim();
              const numeric = Number(trimmed);
              const inputValid =
                row.declined ||
                trimmed === "" ||
                (Number.isFinite(numeric) && numeric >= 50 && numeric <= 900);
              const outOfBand =
                !row.declined &&
                trimmed !== "" &&
                Number.isFinite(numeric) &&
                (numeric < row.band.lo || numeric > row.band.hi);
              return (
                <tr key={row.tier} className="bg-white align-top">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-gray-900">
                      {row.tier}{" "}
                      <span className="font-normal text-gray-500">
                        · {row.label}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500 leading-snug">
                      e.g. {TIER_EXAMPLES[row.tier]}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    ${row.band.lo}–${row.band.hi}/hr
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <DollarSign className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                        <input
                          type="text"
                          inputMode="numeric"
                          value={row.rateInput}
                          onChange={(event) =>
                            setRow(row.tier, { rateInput: event.target.value })
                          }
                          disabled={row.declined}
                          placeholder={
                            tierData.legacy_labor_rate != null
                              ? String(tierData.legacy_labor_rate)
                              : "—"
                          }
                          className={`w-28 rounded-md border bg-white py-1.5 pl-7 pr-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-400 ${
                            inputValid ? "border-gray-200" : "border-red-300"
                          }`}
                        />
                      </div>
                      {outOfBand ? (
                        <span
                          className="inline-flex items-center text-amber-600"
                          title="Outside the typical NYC band — allowed, but flagged."
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.declined ? (
                      <button
                        type="button"
                        onClick={() => setRow(row.tier, { declined: false })}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setRow(row.tier, { declined: true, rateInput: "" })
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                        title="Mark this tier as not serviced"
                      >
                        <Ban className="h-3 w-3" />
                        Decline
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={openConfirm}
          disabled={!canSave}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          Save labor rates
        </button>
        {tierData.profile ? (
          <span className="text-xs text-gray-500">
            Shop profile:{" "}
            <span className="font-medium text-gray-700">{tierData.profile}</span>
          </span>
        ) : null}
        {message ? (
          <p className="text-sm text-green-700">{message}</p>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>

      {warnings.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-start gap-2 text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="text-xs">
              <p className="font-semibold mb-1">Saved with notes</p>
              <ul className="space-y-1">
                {warnings.map((w) => (
                  <li key={`${w.tier}-${w.kind}`}>{w.message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {confirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={saving ? undefined : () => setConfirmOpen(false)}
          />
          <div className="relative z-[91] w-full max-w-lg overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-5">
              <div>
                <div className="flex items-center gap-2 text-amber-600">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.2em]">
                    Confirm change
                  </span>
                </div>
                <h2 className="mt-2 text-lg font-semibold text-gray-900">
                  Update labor rates?
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={saving}
                className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-60"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-3 text-sm text-gray-700">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Per-tier changes
                </p>
                <ul className="space-y-1 text-xs">
                  {rows.map((r) => {
                    const tiers = tierData.tiers as TierRow[];
                    const prev = tiers.find((t) => t.tier === r.tier);
                    if (!prev) return null;
                    const trimmed = r.rateInput.trim();
                    const nowState = r.declined
                      ? "declined"
                      : trimmed === ""
                        ? "unset"
                        : "priced";
                    const nowRate =
                      nowState === "priced" ? Math.round(Number(trimmed)) : null;
                    const changed =
                      prev.state !== nowState ||
                      (nowState === "priced" && nowRate !== prev.rate);
                    if (!changed) return null;
                    return (
                      <li key={r.tier} className="flex justify-between gap-3">
                        <span className="font-medium text-gray-700">
                          {r.tier} · {r.label}
                        </span>
                        <span className="text-gray-600">
                          {formatState(
                            prev.state,
                            prev.rate,
                            tierData.legacy_labor_rate,
                          )}{" "}
                          <span className="text-gray-400">→</span>{" "}
                          <span className="font-semibold text-gray-900">
                            {formatState(
                              nowState,
                              nowRate,
                              tierData.legacy_labor_rate,
                            )}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <p className="text-xs text-gray-500">
                Applies immediately to new bookings and the labor portion of
                future invoices. Already-confirmed bookings keep the rate that
                was disclosed to the customer.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-4">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={saving}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatState(
  state: string,
  rate: number | null,
  fallback: number | null,
) {
  if (state === "declined") return "Not serviced";
  if (state === "priced" && rate != null) return `$${rate}/hr`;
  return fallback != null ? `$${fallback}/hr (base)` : "Unset";
}
