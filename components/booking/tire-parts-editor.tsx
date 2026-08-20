"use client";

import { useId, useMemo } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TIRE_MODEL_OPTIONS,
  tireModelOptionsForBrand,
  tireSizeOptionsFromList,
} from "@/lib/inspection-options";
import { TIRE_BRAND_OPTIONS } from "@/lib/inspection-options";
import {
  TireSizeInput,
  isValidTireSize,
} from "@/components/booking/tire-spec-picker";
import {
  type TireAxle,
  type TireLine,
  DEFAULT_AXLE_QUANTITY,
  emptyTireLine,
  isTirePartRow,
  normalizeTireSize,
  tireLinesFromParts,
  tireLinesFromPrejob,
  tireLinesToPartPayloads,
} from "@/lib/tire-part-lines";

// ─────────────────────────────────────────────────────────────────────────
// Custom tire-replacement editor (mid-job + walk-in). The pure line/payload
// helpers live in lib/tire-part-lines.ts (unit-tested); this file is the React
// UI. Re-exported below so existing consumers keep importing from here.
// ─────────────────────────────────────────────────────────────────────────

export type { TireAxle, TireLine };
export {
  isTirePartRow,
  tireLinesFromParts,
  tireLinesFromPrejob,
  tireLinesToPartPayloads,
};

const AXLES: { position: TireAxle; label: string }[] = [
  { position: "front", label: "Front axle" },
  { position: "rear", label: "Rear axle" },
];

export interface TirePartsEditorProps {
  value: TireLine[];
  onChange: (lines: TireLine[]) => void;
  /** Vehicle OEM fitments [front, rear] surfaced as size suggestion chips. */
  oemSizes?: Array<string | null | undefined> | null;
  disabled?: boolean;
  className?: string;
}

export default function TirePartsEditor({
  value,
  onChange,
  oemSizes,
  disabled,
  className,
}: TirePartsEditorProps) {
  const brandListId = useId();
  const modelListId = useId();

  const sizeChips = useMemo(() => {
    const cleaned = (oemSizes ?? [])
      .map((s) => normalizeTireSize(s ?? ""))
      .filter((s) => s && isValidTireSize(s));
    return Array.from(new Set(cleaned));
  }, [oemSizes]);

  const lineByPosition = useMemo(() => {
    const map = new Map<TireAxle, { line: TireLine; index: number }>();
    value.forEach((line, index) => {
      if (!map.has(line.position)) map.set(line.position, { line, index });
    });
    return map;
  }, [value]);

  function setAxleActive(position: TireAxle, active: boolean) {
    if (active) {
      if (lineByPosition.has(position)) return;
      onChange([...value, emptyTireLine(position)]);
    } else {
      onChange(value.filter((l) => l.position !== position));
    }
  }

  function patchLine(position: TireAxle, patch: Partial<TireLine>) {
    onChange(
      value.map((l) => (l.position === position ? { ...l, ...patch } : l)),
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <datalist id={brandListId}>
        {TIRE_BRAND_OPTIONS.map((o) => (
          <option key={o.value} value={o.label} />
        ))}
      </datalist>

      {AXLES.map(({ position, label }) => {
        const entry = lineByPosition.get(position);
        const active = !!entry;
        const line = entry?.line;
        const modelOptions = line?.brand
          ? tireModelOptionsForBrand(line.brand)
          : [];
        return (
          <div
            key={position}
            className={cn(
              "rounded-2xl border px-3 py-3 transition-colors",
              active
                ? "border-primary/25 bg-background"
                : "border-dashed border-primary/15 bg-muted/20",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {label}
              </span>
              {active ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setAxleActive(position, false)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  aria-label={`Remove ${label}`}
                >
                  <X className="h-3.5 w-3.5" />
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setAxleActive(position, true)}
                  className="inline-flex items-center gap-1 rounded-md border border-primary/20 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add {position} tires
                </button>
              )}
            </div>

            {active && line ? (
              <div className="mt-3 space-y-3">
                {/* Size */}
                <div>
                  <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Size (fitment)
                  </span>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {sizeChips.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={disabled}
                        onClick={() => patchLine(position, { size: s })}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
                          normalizeTireSize(line.size) === s
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background hover:bg-muted",
                        )}
                      >
                        {s}
                      </button>
                    ))}
                    <TireSizeInput
                      value={sizeChips.includes(normalizeTireSize(line.size)) ? "" : line.size}
                      onChange={(next) => patchLine(position, { size: next })}
                      className={cn(
                        "h-8 rounded-full border-dashed px-3 text-[11px]",
                        line.size &&
                          !sizeChips.includes(normalizeTireSize(line.size)) &&
                          isValidTireSize(line.size)
                          ? "border-primary bg-primary/5"
                          : "border-border",
                      )}
                    />
                  </div>
                </div>

                {/* Brand + model */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Brand
                    </span>
                    <input
                      list={brandListId}
                      value={line.brand}
                      disabled={disabled}
                      onChange={(e) => patchLine(position, { brand: e.target.value })}
                      placeholder="e.g. Michelin"
                      className="mt-1 h-8 w-full rounded-md border border-primary/10 bg-background px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/30 disabled:opacity-50"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Model
                    </span>
                    <input
                      list={`${modelListId}-${position}`}
                      value={line.model}
                      disabled={disabled}
                      onChange={(e) => patchLine(position, { model: e.target.value })}
                      placeholder="e.g. Pilot Sport 4S"
                      className="mt-1 h-8 w-full rounded-md border border-primary/10 bg-background px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/30 disabled:opacity-50"
                    />
                    <datalist id={`${modelListId}-${position}`}>
                      {(modelOptions.length > 0 ? modelOptions : TIRE_MODEL_OPTIONS).map(
                        (o) => (
                          <option key={o.value} value={o.label} />
                        ),
                      )}
                    </datalist>
                  </label>
                </div>

                {/* Price + quantity */}
                <div className="flex flex-wrap items-end gap-3">
                  <label className="block">
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Price / tire
                    </span>
                    <div className="mt-1 inline-flex items-center rounded-md border border-primary/10 bg-background pl-2 focus-within:border-primary/30">
                      <span className="text-[13px] text-muted-foreground">$</span>
                      <input
                        inputMode="decimal"
                        value={line.perTirePrice}
                        disabled={disabled}
                        onChange={(e) =>
                          patchLine(position, {
                            perTirePrice: e.target.value.replace(/[^0-9.]/g, ""),
                          })
                        }
                        placeholder="0.00"
                        className="h-8 w-20 bg-transparent px-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
                      />
                    </div>
                  </label>

                  <div>
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Quantity
                    </span>
                    <div className="mt-1 inline-flex items-center gap-1">
                      <button
                        type="button"
                        disabled={disabled || line.quantity <= 1}
                        onClick={() =>
                          patchLine(position, {
                            quantity: Math.max(1, line.quantity - 1),
                          })
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-primary/15 text-foreground hover:bg-muted disabled:opacity-40"
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-[13px] font-semibold tabular-nums">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        disabled={disabled || line.quantity >= 4}
                        onClick={() =>
                          patchLine(position, {
                            quantity: Math.min(4, line.quantity + 1),
                          })
                        }
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-primary/15 text-foreground hover:bg-muted disabled:opacity-40"
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="ml-auto text-right">
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Line total
                    </span>
                    <span className="text-[13px] font-semibold tabular-nums">
                      $
                      {(
                        (Number(line.perTirePrice) || 0) *
                        Math.max(1, line.quantity)
                      ).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
