"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export const FIXED_PRICE_TIERS = [
  "T1",
  "T2a",
  "T2b",
  "T2c",
  "T3a",
  "T3b",
  "T4",
] as const;

export type FixedPriceTier = (typeof FIXED_PRICE_TIERS)[number];

// Shop-facing vehicle groups. The pricing engine still stores a price per
// internal tier, but the shop sets ONE price per group — it's written to every
// tier the group covers. Mirrors the groups on the labor-rate step so the
// vocabulary matches across the whole flow.
export const FIXED_PRICE_GROUPS: {
  id: string;
  name: string;
  tiers: FixedPriceTier[];
}[] = [
  { id: "everyday", name: "Everyday cars", tiers: ["T1"] },
  { id: "luxury", name: "Luxury sedans & SUVs", tiers: ["T2a", "T2b", "T2c"] },
  { id: "performance", name: "Performance & sports", tiers: ["T3a", "T3b"] },
  { id: "exotic", name: "Exotic", tiers: ["T4"] },
];

export type FixedPriceMap = Partial<Record<FixedPriceTier, string>>;

export function priceMapToCents(
  prices: FixedPriceMap,
): Partial<Record<FixedPriceTier, number | null>> {
  const out: Partial<Record<FixedPriceTier, number | null>> = {};
  for (const tier of FIXED_PRICE_TIERS) {
    const raw = prices[tier];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === "") {
      out[tier] = null;
      continue;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[tier] = Math.round(n * 100);
  }
  return out;
}

export function centsMapToInputs(
  centsMap: Partial<Record<FixedPriceTier, number>> | undefined,
): FixedPriceMap {
  const out: FixedPriceMap = {};
  if (!centsMap) return out;
  for (const tier of FIXED_PRICE_TIERS) {
    const cents = centsMap[tier];
    if (cents == null) continue;
    out[tier] = (cents / 100).toFixed(2);
  }
  return out;
}

export function countPricedTiers(prices: FixedPriceMap): number {
  let n = 0;
  for (const tier of FIXED_PRICE_TIERS) {
    const raw = prices[tier];
    if (raw && raw.trim() !== "") n += 1;
  }
  return n;
}

// Counts how many vehicle groups have a price set (rather than raw tiers), so
// badges reflect what the shop actually sees and sets.
export function countPricedGroups(prices: FixedPriceMap): number {
  let n = 0;
  for (const group of FIXED_PRICE_GROUPS) {
    if (group.tiers.some((tier) => (prices[tier] ?? "").trim() !== "")) n += 1;
  }
  return n;
}

type SaveStatus = "saving" | "saved" | "error";

type Props = {
  prices: FixedPriceMap;
  declinedTiers: ReadonlySet<string>;
  onChange: (next: FixedPriceMap) => void;
  /**
   * Optional: persist the full price map (debounced) whenever a value changes.
   * When provided, the edited group shows an inline saving → saved indicator so
   * the shop knows the price was actually stored.
   */
  onPersist?: (next: FixedPriceMap) => void | Promise<void>;
  /** Compact mode shrinks padding for use inside service rows. */
  compact?: boolean;
};

export default function FixedPriceTierStrip({
  prices,
  declinedTiers,
  onChange,
  onPersist,
  compact = true,
}: Props) {
  const [saveState, setSaveState] = useState<{
    groupId: string;
    status: SaveStatus;
  } | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(persistTimer.current);
    },
    [],
  );

  function setGroup(
    group: (typeof FIXED_PRICE_GROUPS)[number],
    value: string,
  ) {
    const next = { ...prices };
    for (const tier of group.tiers) next[tier] = value;
    onChange(next);

    if (!onPersist) return;
    clearTimeout(persistTimer.current);
    setSaveState({ groupId: group.id, status: "saving" });
    persistTimer.current = setTimeout(async () => {
      try {
        await onPersist(next);
        setSaveState((prev) =>
          prev?.groupId === group.id
            ? { groupId: group.id, status: "saved" }
            : prev,
        );
      } catch {
        setSaveState((prev) =>
          prev?.groupId === group.id
            ? { groupId: group.id, status: "error" }
            : prev,
        );
      }
    }, 650);
  }

  return (
    <div className={compact ? "px-3 pb-3 pt-2" : "p-3"}>
      <p className="mb-3 text-[11px] leading-snug text-gray-500">
        Set a fixed total (labor + parts) per vehicle group. Leave blank to use
        the standard quote range. Tax and fees are added on top at checkout.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {FIXED_PRICE_GROUPS.map((group) => {
          const declined = group.tiers.every((tier) => declinedTiers.has(tier));
          const value =
            group.tiers
              .map((tier) => prices[tier] ?? "")
              .find((raw) => raw.trim() !== "") ?? "";
          const trimmed = value.trim();
          const numeric = Number(trimmed);
          const invalid =
            trimmed !== "" && (!Number.isFinite(numeric) || numeric <= 0);
          const active =
            saveState?.groupId === group.id ? saveState.status : null;
          const showSpinner = active === "saving";
          const showError = active === "error";
          // A persistent check stays on any group that has a saved price
          // (server-loaded values are already saved, so they show it too).
          const showCheck =
            Boolean(onPersist) && !showSpinner && !showError && trimmed !== "";
          return (
            <div key={group.id}>
              <label
                htmlFor={`fp-${group.id}`}
                title={group.name}
                className="mb-1 block truncate text-[12px] font-medium text-gray-600"
              >
                {group.name}
              </label>
              {declined ? (
                <div className="flex h-9 items-center rounded-xl bg-gray-100 px-3 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                  Not serviced
                </div>
              ) : (
                <div
                  className={`relative flex h-9 items-center rounded-xl border bg-white transition-colors focus-within:border-blue-500 ${
                    invalid ? "border-red-300" : "border-gray-200"
                  }`}
                >
                  <span className="pl-3 pr-1 text-xs text-gray-400">$</span>
                  <input
                    id={`fp-${group.id}`}
                    type="text"
                    inputMode="decimal"
                    value={value}
                    onChange={(e) => setGroup(group, e.target.value)}
                    placeholder="Standard"
                    aria-label={`Fixed price for ${group.name}`}
                    className="h-full w-full min-w-0 bg-transparent pr-7 text-xs text-gray-900 outline-none placeholder:text-gray-400"
                  />
                  {showSpinner || showError || showCheck ? (
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                      {showSpinner ? (
                        <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
                      ) : showError ? (
                        <span
                          title="Couldn't save — it'll save when you continue"
                          className="text-[11px] font-bold text-red-500"
                        >
                          !
                        </span>
                      ) : (
                        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-600">
                          <Check
                            className="h-2 w-2 text-white"
                            strokeWidth={4}
                          />
                        </span>
                      )}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
