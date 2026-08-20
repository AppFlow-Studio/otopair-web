"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Info, X } from "lucide-react";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import { cn } from "@/lib/utils";
import { getBookedTireReplacementPositions } from "@/lib/inspection-measurements";

export type TirePosition = "FL" | "FR" | "RL" | "RR";

export type TireSpecs = {
  size: string;
  type: string;
  tier: string;
  quantity: number;
  positions?: TirePosition[];
};

export interface TireSpecPickerProps {
  open: boolean;
  initial?: TireSpecs | null;
  vehicleMake?: string | null;
  /**
   * Sizes recorded on the vehicle passport by a mechanic (pre-job/post-job).
   * Tuple [front, rear]. When present, these are surfaced as the first
   * chips and take precedence over the hardcoded OEM-by-make fallback so
   * customers see the actual sizes their car was last serviced with.
   */
  passportTireSizes?: Array<string | null | undefined>;
  vehicleLabel?: string | null;
  onCancel: () => void;
  onConfirm: (specs: TireSpecs) => void;
}

const TIRE_TYPES = [
  { id: "all-season", label: "All-Season" },
  { id: "performance", label: "Performance" },
  { id: "winter", label: "Winter" },
];

const TIRE_TIERS = [
  {
    id: "premium",
    label: "Premium",
    warrantyRange: "60K – 80K mi",
    brandSample: ["Michelin", "Continental", "Bridgestone"],
  },
  {
    id: "plus",
    label: "Plus",
    warrantyRange: "45K – 70K mi",
    brandSample: ["Hankook", "Yokohama", "Cooper"],
  },
  {
    id: "standard",
    label: "Standard",
    warrantyRange: "30K – 50K mi",
    brandSample: ["Kumho", "Nexen", "Sailun"],
  },
];

const OEM_SIZES_BY_MAKE: Record<string, string[]> = {
  Toyota: ["215/55R17", "235/45R18"],
  Honda: ["215/60R16", "235/45R18"],
  Volkswagen: ["225/45R18", "235/55R17"],
  BMW: ["225/45R18", "245/40R19"],
  Mercedes: ["245/45R18", "255/35R19"],
  Ford: ["235/65R17", "265/60R18"],
  Chevrolet: ["225/65R17", "265/65R18"],
  Tesla: ["235/45R19", "265/35R21"],
  Nissan: ["215/60R16", "235/55R18"],
};

const DEFAULT_OEM_SIZES = ["225/55R17", "235/50R18"];
const POSITION_ORDER: TirePosition[] = ["FL", "FR", "RL", "RR"];
const TIRE_SIZE_PATTERN = /^\d{3}\/\d{2}R\d{2}$/i;

export function normalizeTireSizeValue(value?: string | null) {
  return (value ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^0-9R/]/g, "");
}

export function isValidTireSize(value: string) {
  return TIRE_SIZE_PATTERN.test(normalizeTireSizeValue(value));
}

function parseTireSizeParts(value: string): { width: string; aspect: string; wheel: string } {
  const normalized = normalizeTireSizeValue(value);
  const match = normalized.match(/^(\d{0,3})(?:\/(\d{0,2}))?(?:R(\d{0,2}))?$/i);
  return { width: match?.[1] ?? "", aspect: match?.[2] ?? "", wheel: match?.[3] ?? "" };
}

function composeTireSize(width: string, aspect: string, wheel: string): string {
  if (!width && !aspect && !wheel) return "";
  return `${width}/${aspect}R${wheel}`;
}

export function TireSizeInput({ value, onChange, className }: { value: string; onChange: (next: string) => void; className?: string }) {
  const parts = parseTireSizeParts(value);
  const aspectRef = useRef<HTMLInputElement | null>(null);
  const wheelRef = useRef<HTMLInputElement | null>(null);
  const emit = (w: string, a: string, d: string) => onChange(composeTireSize(w, a, d));
  const sanitize = (s: string, max: number) => s.replace(/[^0-9]/g, "").slice(0, max);

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-sm",
        "focus-within:ring-2 focus-within:ring-ring focus-within:border-ring",
        className,
      )}
      aria-label="Tire size"
    >
      <input
        inputMode="numeric"
        maxLength={3}
        value={parts.width}
        placeholder="225"
        aria-label="Section width"
        onChange={(e) => {
          const next = sanitize(e.target.value, 3);
          emit(next, parts.aspect, parts.wheel);
          if (next.length === 3) aspectRef.current?.focus();
        }}
        className="w-9 bg-transparent text-center outline-none"
      />
      <span className="text-muted-foreground">/</span>
      <input
        ref={aspectRef}
        inputMode="numeric"
        maxLength={2}
        value={parts.aspect}
        placeholder="65"
        aria-label="Aspect ratio"
        onChange={(e) => {
          const next = sanitize(e.target.value, 2);
          emit(parts.width, next, parts.wheel);
          if (next.length === 2) wheelRef.current?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "Backspace" && !parts.aspect) {
            e.preventDefault();
            emit(parts.width.slice(0, -1), parts.aspect, parts.wheel);
          }
        }}
        className="w-7 bg-transparent text-center outline-none"
      />
      <span className="text-muted-foreground">R</span>
      <input
        ref={wheelRef}
        inputMode="numeric"
        maxLength={2}
        value={parts.wheel}
        placeholder="17"
        aria-label="Wheel diameter"
        onChange={(e) => {
          const next = sanitize(e.target.value, 2);
          emit(parts.width, parts.aspect, next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Backspace" && !parts.wheel) {
            e.preventDefault();
            emit(parts.width, parts.aspect.slice(0, -1), parts.wheel);
            aspectRef.current?.focus();
          }
        }}
        className="w-7 bg-transparent text-center outline-none"
      />
    </div>
  );
}

function TireSlot({
  position,
  selected,
  onToggle,
}: {
  position: TirePosition;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={`Toggle ${position} tire`}
      className={cn(
        "relative flex h-16 w-10 items-center justify-center rounded-md border-2 transition-all",
        selected
          ? "border-primary bg-primary text-primary-foreground shadow-md"
          : "border-muted-foreground/40 bg-background hover:border-primary/60",
      )}
    >
      <span className="text-[10px] font-bold tracking-wider">{position}</span>
      {selected ? (
        <span className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-2.5 w-2.5" />
        </span>
      ) : null}
    </button>
  );
}

export default function TireSpecPicker({
  open,
  initial,
  vehicleMake,
  passportTireSizes,
  vehicleLabel,
  onCancel,
  onConfirm,
}: TireSpecPickerProps) {
  const sizes = useMemo(() => {
    const fromPassport = (passportTireSizes ?? [])
      .map((s) => normalizeTireSizeValue(s ?? ""))
      .filter((s) => s && isValidTireSize(s));
    const dedupedPassport = Array.from(new Set(fromPassport));
    if (dedupedPassport.length > 0) return dedupedPassport;
    if (vehicleMake && OEM_SIZES_BY_MAKE[vehicleMake]) {
      return OEM_SIZES_BY_MAKE[vehicleMake];
    }
    return DEFAULT_OEM_SIZES;
  }, [passportTireSizes, vehicleMake]);

  const [size, setSize] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [positions, setPositions] = useState<TirePosition[]>([]);
  const [showTierInfo, setShowTierInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSize(initial?.size ?? (sizes.length === 1 ? sizes[0] : ""));
    setType(initial?.type ?? null);
    setTier(initial?.tier ?? null);
    setPositions(getBookedTireReplacementPositions(initial));
    setShowTierInfo(null);
  }, [open, initial, sizes]);

  function togglePosition(p: TirePosition) {
    setPositions((current) => {
      const set = new Set(current);
      if (set.has(p)) set.delete(p);
      else set.add(p);
      return POSITION_ORDER.filter((pos) => set.has(pos));
    });
  }

  const showSizeSection = sizes.length > 1 || size.trim() === "";
  const sizeChosen = !!size && (sizes.includes(size) || isValidTireSize(size));
  const valid =
    positions.length > 0 && !!type && !!tier && (showSizeSection ? sizeChosen : true);

  const ctaLabel = (() => {
    if (positions.length === 0) return "Tap a wheel to continue";
    if (showSizeSection && !sizeChosen) return "Select a tire size";
    if (!type) return "Select a tire type";
    if (!tier) return "Select a tier";
    return "Confirm tire specs";
  })();

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-xl max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h3 className="text-base font-semibold">Shop tires</h3>
            {vehicleLabel ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Tires for {vehicleLabel}
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pick which wheels, size, type, and quality tier.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {/* 2D tire-position picker */}
          <div className="rounded-2xl border border-border bg-muted/20 p-5">
            <div className="mx-auto flex w-full max-w-[180px] flex-col gap-3">
              {/* Front axle */}
              <div className="flex items-center justify-between">
                <TireSlot
                  position="FL"
                  selected={positions.includes("FL")}
                  onToggle={() => togglePosition("FL")}
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Front
                </span>
                <TireSlot
                  position="FR"
                  selected={positions.includes("FR")}
                  onToggle={() => togglePosition("FR")}
                />
              </div>
              {/* Vehicle body */}
              <div className="mx-2 h-12 rounded-xl border border-dashed border-muted-foreground/40 bg-background/60" />
              {/* Rear axle */}
              <div className="flex items-center justify-between">
                <TireSlot
                  position="RL"
                  selected={positions.includes("RL")}
                  onToggle={() => togglePosition("RL")}
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Rear
                </span>
                <TireSlot
                  position="RR"
                  selected={positions.includes("RR")}
                  onToggle={() => togglePosition("RR")}
                />
              </div>
            </div>
            <p className="mt-4 text-center text-xs text-muted-foreground">
              {positions.length} of 4 tires selected · click a wheel to toggle
            </p>
          </div>

          {/* Size */}
          <section className="mt-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Size
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSize(s)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    s === size
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-muted",
                  )}
                >
                  {s}
                </button>
              ))}
              <TireSizeInput
                value={sizes.includes(size) ? "" : size}
                onChange={(next) => setSize(next)}
                className={cn(
                  "h-8 rounded-full border-dashed px-3 text-xs",
                  !sizes.includes(size) && size && isValidTireSize(size)
                    ? "border-primary bg-primary/5"
                    : "border-border",
                )}
              />
            </div>
          </section>

          {/* Type */}
          <section className="mt-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Type
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TIRE_TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setType(t.id)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    type === t.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-muted",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          {/* Tier */}
          <section className="mt-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Quality tier
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              How long the tires last before needing replacement.
            </p>
            <div className="mt-2 space-y-2">
              {TIRE_TIERS.map((t) => {
                const selected = tier === t.id;
                const expanded = showTierInfo === t.id;
                return (
                  <div
                    key={t.id}
                    className={cn(
                      "rounded-xl border bg-background transition-colors",
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/30",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setTier(t.id)}
                      className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">
                          {t.label}
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowTierInfo(expanded ? null : t.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setShowTierInfo(expanded ? null : t.id);
                            }
                          }}
                          className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`Learn more about ${t.label}`}
                        >
                          <Info className="h-3 w-3" />
                        </span>
                      </div>
                      <span
                        className={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/40",
                        )}
                      >
                        {selected ? <Check className="h-3 w-3" /> : null}
                      </span>
                    </button>
                    {expanded ? (
                      <div className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">
                          {t.warrantyRange}
                        </p>
                        <p className="mt-0.5">
                          Brands like {t.brandSample.join(", ")}.
                        </p>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-3">
          <button
            type="button"
            onClick={onCancel}
            className={drawerSecondaryButtonClassName}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm({
                size: size.trim(),
                type: type ?? "",
                tier: tier ?? "",
                quantity: positions.length,
                positions,
              })
            }
            disabled={!valid}
            className={drawerPrimaryButtonClassName}
          >
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
