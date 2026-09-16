"use client";

import {
  FIXED_PRICE_GROUPS,
  FIXED_PRICE_TIERS,
  type FixedPriceMap,
  type FixedPriceTier,
} from "@/components/shop/fixed-price-tier-strip";

export type ServicePricingMode = "fixed" | "range";
export type RangePriceMap = Partial<
  Record<FixedPriceTier, { minimum: string; maximum: string }>
>;

export type ServicePricingDraft = {
  mode: ServicePricingMode;
  fixedPrices: FixedPriceMap;
  rangePrices: RangePriceMap;
};

export type SavedServicePricing = {
  mode: ServicePricingMode;
  prices: Partial<
    Record<FixedPriceTier, { low_cents: number; high_cents: number }>
  >;
};

export function emptyServicePricingDraft(): ServicePricingDraft {
  return { mode: "fixed", fixedPrices: {}, rangePrices: {} };
}

/** Clear the now-inactive draft after persistence, not while toggling modes. */
export function clearInactivePricingDraft(
  draft: ServicePricingDraft,
): ServicePricingDraft {
  return draft.mode === "fixed"
    ? { ...draft, rangePrices: {} }
    : { ...draft, fixedPrices: {} };
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function pricingRecordToDraft(
  saved?: SavedServicePricing,
): ServicePricingDraft {
  const draft = emptyServicePricingDraft();
  if (!saved) return draft;
  draft.mode = saved.mode;
  for (const tier of FIXED_PRICE_TIERS) {
    const pair = saved.prices[tier];
    if (!pair) continue;
    if (saved.mode === "fixed") {
      draft.fixedPrices[tier] = dollars(pair.low_cents);
    } else {
      draft.rangePrices[tier] = {
        minimum: dollars(pair.low_cents),
        maximum: dollars(pair.high_cents),
      };
    }
  }
  return draft;
}

/**
 * Seed the editor once without discarding anything entered while its query was
 * still loading. Subsequent query updates are ignored by the editor so an
 * older subscription snapshot cannot replace a just-saved draft.
 */
export function mergeInitialServicePricingDrafts(
  saved: Record<string, SavedServicePricing>,
  current: Record<string, ServicePricingDraft>,
): {
  pricingByService: Record<string, ServicePricingDraft>;
  pricingBaseline: Record<string, ServicePricingDraft>;
} {
  const pricingBaseline: Record<string, ServicePricingDraft> = {};
  for (const [serviceId, pricing] of Object.entries(saved)) {
    pricingBaseline[serviceId] = pricingRecordToDraft(pricing);
  }

  const pricingByService = { ...pricingBaseline };
  const empty = JSON.stringify(emptyServicePricingDraft());
  for (const [serviceId, draft] of Object.entries(current)) {
    if (JSON.stringify(draft) !== empty) pricingByService[serviceId] = draft;
  }

  return { pricingByService, pricingBaseline };
}

function parseDollars(raw: string, label: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1 || value > 100_000) {
    throw new Error(`${label} must be between $1 and $100,000.`);
  }
  return Math.round(value * 100);
}

export function servicePricingDraftToCents(draft: ServicePricingDraft): {
  mode: ServicePricingMode;
  prices: Partial<
    Record<
      FixedPriceTier,
      { low_cents: number; high_cents: number } | null
    >
  >;
} {
  const prices: Partial<
    Record<
      FixedPriceTier,
      { low_cents: number; high_cents: number } | null
    >
  > = {};

  for (const group of FIXED_PRICE_GROUPS) {
    if (draft.mode === "fixed") {
      const raw = draft.fixedPrices[group.tiers[0]]?.trim() ?? "";
      const pair = raw
        ? {
            low_cents: parseDollars(raw, `${group.name} price`),
            high_cents: parseDollars(raw, `${group.name} price`),
          }
        : null;
      for (const tier of group.tiers) prices[tier] = pair;
      continue;
    }

    const range = draft.rangePrices[group.tiers[0]] ?? {
      minimum: "",
      maximum: "",
    };
    const minimum = range.minimum.trim();
    const maximum = range.maximum.trim();
    if (!minimum && !maximum) {
      for (const tier of group.tiers) prices[tier] = null;
      continue;
    }
    if (!minimum || !maximum) {
      throw new Error(`${group.name} needs both a minimum and maximum price.`);
    }
    const low_cents = parseDollars(minimum, `${group.name} minimum`);
    const high_cents = parseDollars(maximum, `${group.name} maximum`);
    if (low_cents > high_cents) {
      throw new Error(`${group.name} minimum cannot be greater than maximum.`);
    }
    for (const tier of group.tiers) prices[tier] = { low_cents, high_cents };
  }

  return { mode: draft.mode, prices };
}

export function countPricedServiceGroups(draft: ServicePricingDraft): number {
  return FIXED_PRICE_GROUPS.filter((group) => {
    const tier = group.tiers[0];
    if (draft.mode === "fixed") {
      return (draft.fixedPrices[tier] ?? "").trim() !== "";
    }
    const range = draft.rangePrices[tier];
    return Boolean(range?.minimum.trim() || range?.maximum.trim());
  }).length;
}

type Props = {
  serviceId: string;
  draft: ServicePricingDraft;
  declinedTiers: ReadonlySet<string>;
  onChange: (next: ServicePricingDraft) => void;
};

export default function ServicePriceTierStrip({
  serviceId,
  draft,
  declinedTiers,
  onChange,
}: Props) {
  function setFixed(group: (typeof FIXED_PRICE_GROUPS)[number], value: string) {
    const fixedPrices = { ...draft.fixedPrices };
    for (const tier of group.tiers) fixedPrices[tier] = value;
    onChange({ ...draft, fixedPrices });
  }

  function setRange(
    group: (typeof FIXED_PRICE_GROUPS)[number],
    field: "minimum" | "maximum",
    value: string,
  ) {
    const rangePrices = { ...draft.rangePrices };
    const next = {
      ...(rangePrices[group.tiers[0]] ?? { minimum: "", maximum: "" }),
      [field]: value,
    };
    for (const tier of group.tiers) rangePrices[tier] = next;
    onChange({ ...draft, rangePrices });
  }

  return (
    <div className="p-3 sm:p-4">
      <div
        className="mb-4 inline-flex rounded-lg border border-border bg-muted/60 p-1"
        aria-label="Pricing method"
      >
        {(["fixed", "range"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={draft.mode === mode}
            onClick={() => onChange({ ...draft, mode })}
            className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              draft.mode === mode
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {mode === "fixed" ? "Fixed price" : "Price range"}
          </button>
        ))}
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        {draft.mode === "fixed"
          ? "Set one labor-and-parts total per vehicle group."
          : "Set the expected minimum and maximum labor-and-parts total per vehicle group."}{" "}
        Leave a group blank to use the standard estimate. Tax and fees are
        added at checkout; booking still places only the standard $20 hold.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {FIXED_PRICE_GROUPS.map((group) => {
          const tier = group.tiers[0];
          const declined = group.tiers.every((item) => declinedTiers.has(item));
          const id = `${serviceId}-${draft.mode}-${group.id}`;
          if (declined) {
            return (
              <div key={group.id}>
                <p className="mb-1 text-xs font-medium text-foreground">{group.name}</p>
                <div className="flex h-10 items-center rounded-lg bg-muted px-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Not serviced
                </div>
              </div>
            );
          }

          return (
            <fieldset key={group.id} className="min-w-0">
              <legend className="mb-1 text-xs font-medium text-foreground">
                {group.name}
              </legend>
              {draft.mode === "fixed" ? (
                <MoneyInput
                  id={id}
                  label={`Fixed price for ${group.name}`}
                  placeholder="Standard"
                  value={draft.fixedPrices[tier] ?? ""}
                  onChange={(value) => setFixed(group, value)}
                />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <MoneyInput
                    id={`${id}-minimum`}
                    label={`Minimum price for ${group.name}`}
                    placeholder="Minimum"
                    value={draft.rangePrices[tier]?.minimum ?? ""}
                    onChange={(value) => setRange(group, "minimum", value)}
                  />
                  <MoneyInput
                    id={`${id}-maximum`}
                    label={`Maximum price for ${group.name}`}
                    placeholder="Maximum"
                    value={draft.rangePrices[tier]?.maximum ?? ""}
                    onChange={(value) => setRange(group, "maximum", value)}
                  />
                </div>
              )}
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

function MoneyInput({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex h-10 items-center rounded-lg border border-border bg-background transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15"
    >
      <span className="pl-3 pr-1 text-xs text-muted-foreground">$</span>
      <span className="sr-only">{label}</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-full w-full min-w-0 bg-transparent pr-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
      />
    </label>
  );
}
