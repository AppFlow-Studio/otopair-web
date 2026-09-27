"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import FixedCentCurrencyInput from "@/components/ui/fixed-cent-currency-input";
import { fixedCentCurrencyCents } from "@/lib/fixed-cent-currency";
import { MAX_PRICE_CENTS } from "@/lib/price-cap";
import { cn } from "@/lib/utils";

const fmt = (cents: number) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;

type ShopSetPriceInputProps = {
  /** Inclusive lower bound (cents, all-in incl. tax + fee). */
  lowCents: number;
  /** Inclusive upper bound (cents, all-in incl. tax + fee). */
  highCents: number;
  /** Current chosen price (cents). */
  valueCents: number;
  /** Fires with the new chosen price (cents) on every edit; clamped to the
   *  band on blur. */
  onChangeCents: (cents: number) => void;
  /** Label above the field. Defaults to "Set price". */
  label?: string;
  className?: string;
};

/**
 * Bounded price entry for a shop RANGE / mixed-subset job. The front desk or
 * mechanic sets ONE all-in price the customer already agreed to sit inside
 * [lowCents, highCents]; the value is clamped to the band on blur. When the
 * band collapses (low === high, a pure FIXED price) it renders read-only — the
 * price is the contract, nothing to choose.
 */
export default function ShopSetPriceInput({
  lowCents,
  highCents,
  valueCents,
  onChangeCents,
  label = "Set price",
  className,
}: ShopSetPriceInputProps) {
  const isFixed = highCents <= lowCents;
  const [text, setText] = useState(() => (valueCents / 100).toFixed(2));

  // Re-sync the display when the parent replaces the value (prefill, clamp,
  // reset) — but not on our own keystroke echoes (same cents ⇒ no-op, so the
  // field never fights the user mid-type).
  useEffect(() => {
    if (fixedCentCurrencyCents(text) !== valueCents) {
      setText((valueCents / 100).toFixed(2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueCents]);

  if (isFixed) {
    return (
      <div className={cn("space-y-1", className)}>
        <div className="text-[12px] font-medium text-muted-foreground">
          {label}
        </div>
        <div className="flex items-center gap-1.5 text-[15px] font-semibold tabular-nums text-foreground">
          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
          {fmt(lowCents)}
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Fixed
          </span>
        </div>
      </div>
    );
  }

  const outOfRange = valueCents < lowCents || valueCents > highCents;

  const commit = (next: string) => {
    setText(next);
    onChangeCents(fixedCentCurrencyCents(next));
  };
  const clampOnBlur = () => {
    const clamped = Math.min(highCents, Math.max(lowCents, valueCents));
    if (clamped !== valueCents) onChangeCents(clamped);
    setText((clamped / 100).toFixed(2));
  };

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between">
        <label className="text-[12px] font-medium text-muted-foreground">
          {label}
        </label>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {fmt(lowCents)} – {fmt(highCents)}
        </span>
      </div>
      <div
        className={cn(
          "flex h-11 items-center gap-1 rounded-lg border px-3",
          outOfRange ? "border-amber-400 bg-amber-50/40" : "border-primary/20",
        )}
      >
        <span className="text-muted-foreground">$</span>
        <FixedCentCurrencyInput
          value={text}
          onValueChange={commit}
          onBlur={clampOnBlur}
          maxCents={MAX_PRICE_CENTS}
          className="w-full bg-transparent text-[15px] font-semibold tabular-nums text-foreground outline-none"
          aria-label={label}
        />
      </div>
      {outOfRange ? (
        <p className="text-[11px] text-amber-700">
          Enter a price between {fmt(lowCents)} and {fmt(highCents)}.
        </p>
      ) : null}
    </div>
  );
}
