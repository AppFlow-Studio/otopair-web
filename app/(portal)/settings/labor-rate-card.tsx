"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AlertTriangle } from "lucide-react";
import { SettingsCard } from "@/components/settings/primitives";
import { useRegisterSaveable } from "@/components/settings/save-manager";

type TierCode = "T1" | "T2a" | "T2b" | "T2c" | "T3a" | "T3b" | "T4";

/**
 * The four shop-facing vehicle groups — the same taxonomy the onboarding labor
 * step shows (`app/(portal)/shop/setup/page.tsx`). Each group maps to one or
 * more internal pricing tiers; a group's rate is written to every tier it owns.
 */
const VEHICLE_GROUPS: {
  id: string;
  name: string;
  examples: string;
  rangeLow: number;
  rangeHigh: number;
  tiers: TierCode[];
}[] = [
  {
    id: "everyday",
    name: "Everyday cars",
    examples: "Toyota, Honda, Ford, Hyundai, Kia, Mazda, Nissan, Subaru",
    rangeLow: 130,
    rangeHigh: 150,
    tiers: ["T1"],
  },
  {
    id: "luxury",
    name: "Luxury sedans & SUVs",
    examples: "Lexus, Acura, Genesis, Volvo, Mercedes, Audi, BMW, Macan",
    rangeLow: 160,
    rangeHigh: 210,
    tiers: ["T2a", "T2b", "T2c"],
  },
  {
    id: "performance",
    name: "Performance & sports",
    examples: "BMW M, AMG, Audi RS, Porsche 911 / Cayman, Audi R8",
    rangeLow: 195,
    rangeHigh: 275,
    tiers: ["T3a", "T3b"],
  },
  {
    id: "exotic",
    name: "Exotic",
    examples: "Ferrari, Lamborghini, Rolls-Royce, Bentley, McLaren",
    rangeLow: 250,
    rangeHigh: 400,
    tiers: ["T4"],
  },
];

type GroupRow = { rate: string; notServiced: boolean };

type TierRow = {
  tier: TierCode;
  label: string;
  state: "priced" | "declined" | "unset";
  rate: number | null;
  band: { lo: number; hi: number; label: string };
};

/** Collapse the per-tier data the backend returns into one row per group. */
function deriveGroupRows(tiers: TierRow[]): Record<string, GroupRow> {
  const byTier = new Map<TierCode, TierRow>(tiers.map((t) => [t.tier, t]));
  const out: Record<string, GroupRow> = {};
  for (const group of VEHICLE_GROUPS) {
    const rows = group.tiers.map((t) => byTier.get(t)).filter(Boolean) as TierRow[];
    const notServiced = rows.length > 0 && rows.every((r) => r.state === "declined");
    let rate = "";
    for (const tier of group.tiers) {
      const r = byTier.get(tier);
      if (r && r.rate != null) {
        rate = String(r.rate);
        break;
      }
    }
    out[group.id] = { rate, notServiced };
  }
  return out;
}

export default function LaborRateCard({ shopId }: { shopId: Id<"shops"> }) {
  const tierData = useQuery(api.shopLaborRates.getLaborRatesByTier, { shop_id: shopId });
  const setTierRates = useMutation(api.shopLaborRates.setLaborRatesByTier);

  const [rows, setRows] = useState<Record<string, GroupRow>>({});
  const [warnings, setWarnings] = useState<
    { tier: string; kind: string; message: string }[]
  >([]);

  const baseline = useMemo<Record<string, GroupRow>>(() => {
    if (!tierData) return {};
    return deriveGroupRows(tierData.tiers as TierRow[]);
  }, [tierData]);

  useEffect(() => {
    if (!tierData) return;
    setRows(deriveGroupRows(tierData.tiers as TierRow[]));
  }, [tierData]);

  const inputsValid = VEHICLE_GROUPS.every((group) => {
    const row = rows[group.id];
    if (!row || row.notServiced) return true;
    const trimmed = row.rate.trim();
    if (trimmed === "") return true; // empty = leave unset, allowed
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 50 && n <= 900;
  });

  const changed = useMemo(() => {
    for (const group of VEHICLE_GROUPS) {
      const cur = rows[group.id];
      const base = baseline[group.id];
      if (!cur || !base) continue;
      if (cur.notServiced !== base.notServiced) return true;
      if (!cur.notServiced && cur.rate.trim() !== base.rate.trim()) return true;
    }
    return false;
  }, [rows, baseline]);

  function setRow(groupId: string, patch: Partial<GroupRow>) {
    setRows((prev) => ({
      ...prev,
      [groupId]: { ...(prev[groupId] ?? { rate: "", notServiced: false }), ...patch },
    }));
  }

  const save = useCallback(async () => {
    if (!inputsValid) {
      throw new Error("Enter labor rates between $50 and $900/hr.");
    }
    const rateMap: Partial<Record<TierCode, number>> = {};
    const declined: TierCode[] = [];
    for (const group of VEHICLE_GROUPS) {
      const row = rows[group.id];
      if (!row) continue;
      if (row.notServiced) {
        declined.push(...group.tiers);
        continue;
      }
      const trimmed = row.rate.trim();
      if (trimmed === "") continue;
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        for (const tier of group.tiers) rateMap[tier] = Math.round(n);
      }
    }
    const result = await setTierRates({
      shop_id: shopId,
      rates: rateMap,
      declined_tiers: declined,
    });
    setWarnings(result.warnings ?? []);
  }, [inputsValid, rows, setTierRates, shopId]);

  const reset = useCallback(() => {
    if (tierData) setRows(deriveGroupRows(tierData.tiers as TierRow[]));
    setWarnings([]);
  }, [tierData]);

  useRegisterSaveable("pricing", "Pricing", changed, save, reset);

  if (!tierData) {
    return (
      <SettingsCard title="Labor rates">
        <p className="text-sm text-muted-foreground">Loading labor rates…</p>
      </SettingsCard>
    );
  }

  const basePlaceholder =
    tierData.legacy_labor_rate != null ? String(tierData.legacy_labor_rate) : "150";

  return (
    <SettingsCard
      title="Labor rates"
      description={
        <>
          Set your hourly rate for each vehicle group.{" "}
          {tierData.legacy_labor_rate != null ? (
            <>
              Blank groups fall back to your base rate of{" "}
              <span className="font-medium text-foreground">
                ${tierData.legacy_labor_rate}/hr
              </span>
              .
            </>
          ) : (
            <>Blank groups won&apos;t be priced until a rate is set.</>
          )}
        </>
      }
    >
      <div className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_9rem] gap-4 pb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground md:grid">
        <span>Vehicle group</span>
        <span className="text-center">Typical range</span>
        <span>Your rate</span>
        <span aria-hidden />
      </div>

      <ul className="divide-y divide-border border-t border-border">
        {VEHICLE_GROUPS.map((group) => {
          const row = rows[group.id] ?? { rate: "", notServiced: false };
          const trimmed = row.rate.trim();
          const numeric = Number(trimmed);
          const inputValid =
            row.notServiced ||
            trimmed === "" ||
            (Number.isFinite(numeric) && numeric >= 50 && numeric <= 900);
          const outOfBand =
            !row.notServiced &&
            trimmed !== "" &&
            Number.isFinite(numeric) &&
            (numeric < group.rangeLow || numeric > group.rangeHigh);
          return (
            <li
              key={group.id}
              className="grid grid-cols-1 items-center gap-x-4 gap-y-3 py-5 md:grid-cols-[minmax(0,1fr)_6rem_8rem_9rem]"
            >
              <div
                title={`Internal pricing groups: ${group.tiers.join(", ")}`}
                className={row.notServiced ? "opacity-50 transition-opacity" : "transition-opacity"}
              >
                <p className="text-sm font-semibold text-foreground">{group.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  e.g. {group.examples}
                </p>
              </div>

              <p className="whitespace-nowrap text-xs text-muted-foreground md:text-center">
                ${group.rangeLow} – ${group.rangeHigh}
              </p>

              <div className="flex items-center gap-2">
                {row.notServiced ? (
                  <span className="inline-flex items-center rounded-xl bg-muted px-3.5 py-2.5 text-xs text-muted-foreground">
                    Not serviced
                  </span>
                ) : (
                  <div
                    className={`inline-flex items-center rounded-xl border bg-white transition-colors focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring ${
                      inputValid ? "border-input" : "border-destructive/50"
                    }`}
                  >
                    <span className="pl-3 pr-1 text-sm text-muted-foreground">$</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={row.rate}
                      onChange={(event) =>
                        setRow(group.id, {
                          rate: event.target.value.replace(/[^0-9]/g, ""),
                        })
                      }
                      placeholder={basePlaceholder}
                      aria-label={`Your hourly rate for ${group.name}`}
                      className="w-16 bg-transparent py-2.5 pr-3 text-sm font-medium text-foreground outline-none"
                    />
                  </div>
                )}
                {outOfBand ? (
                  <span
                    className="inline-flex items-center text-amber-600"
                    title="Outside the typical band — allowed, but flagged."
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                  </span>
                ) : null}
              </div>

              <div className="md:text-right">
                <button
                  type="button"
                  onClick={() =>
                    setRow(group.id, {
                      rate: row.notServiced ? row.rate : "",
                      notServiced: !row.notServiced,
                    })
                  }
                  className={`text-xs underline-offset-4 hover:underline ${
                    row.notServiced
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {row.notServiced ? "Undo" : "I don't work on these"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {warnings.length > 0 ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-start gap-2 text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="text-xs">
              <p className="mb-1 font-semibold">Saved with notes</p>
              <ul className="space-y-1">
                {warnings.map((w) => (
                  <li key={`${w.tier}-${w.kind}`}>{w.message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        Rate changes apply immediately to new bookings and the labor portion of
        future invoices. Already-confirmed bookings keep the rate that was
        disclosed to the customer.
      </p>
    </SettingsCard>
  );
}
