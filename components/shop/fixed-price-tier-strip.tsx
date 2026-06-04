"use client";

import { DollarSign, X } from "lucide-react";

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

// Display labels mirror app/(portal)/settings/labor-rate-card.tsx so shops
// see the same vocabulary across both screens.
const TIER_SHORT_LABEL: Record<FixedPriceTier, string> = {
  T1: "Mainstream",
  T2a: "Value premium",
  T2b: "German mid",
  T2c: "BMW non-M",
  T3a: "Performance",
  T3b: "Premium sports",
  T4: "Ultra-exotic",
};

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

type Props = {
  prices: FixedPriceMap;
  declinedTiers: ReadonlySet<string>;
  onChange: (next: FixedPriceMap) => void;
  /** Compact mode shrinks padding for use inside service rows. */
  compact?: boolean;
};

export default function FixedPriceTierStrip({
  prices,
  declinedTiers,
  onChange,
  compact = true,
}: Props) {
  function setTier(tier: FixedPriceTier, value: string) {
    onChange({ ...prices, [tier]: value });
  }

  function clearTier(tier: FixedPriceTier) {
    onChange({ ...prices, [tier]: "" });
  }

  return (
    <div className={compact ? "px-3 pb-3 pt-1" : "p-3"}>
      <p className="mb-2 text-[11px] leading-snug text-gray-500">
        Set a fixed total (labor + parts) per tier. Leave blank to use the
        standard quote range. Tax and fees are added on top at checkout.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {FIXED_PRICE_TIERS.map((tier) => {
          const declined = declinedTiers.has(tier);
          const value = prices[tier] ?? "";
          const trimmed = value.trim();
          const numeric = Number(trimmed);
          const invalid =
            trimmed !== "" && (!Number.isFinite(numeric) || numeric <= 0);
          return (
            <div
              key={tier}
              className="rounded-md border border-gray-200 bg-white px-2 py-1.5"
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <div className="leading-tight">
                  <div className="text-[11px] font-semibold text-gray-900">
                    {tier}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {TIER_SHORT_LABEL[tier]}
                  </div>
                </div>
                {!declined && trimmed !== "" ? (
                  <button
                    type="button"
                    onClick={() => clearTier(tier)}
                    className="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                    aria-label={`Clear fixed price for ${tier}`}
                    title="Clear"
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
              {declined ? (
                <div className="rounded bg-gray-50 px-1.5 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-gray-400">
                  Declined
                </div>
              ) : (
                <div className="relative">
                  <DollarSign className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={value}
                    onChange={(e) => setTier(tier, e.target.value)}
                    placeholder="—"
                    aria-label={`Fixed price for ${tier}`}
                    className={`w-full rounded-md border bg-white py-1 pl-5 pr-1.5 text-xs text-gray-900 outline-none transition-colors focus:border-blue-500 ${
                      invalid ? "border-red-300" : "border-gray-200"
                    }`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
