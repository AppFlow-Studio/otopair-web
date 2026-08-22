// Pure (non-React) helpers for the custom tire-replacement flow (mid-job +
// walk-in). Kept out of the TirePartsEditor component so they're unit-testable
// without a DOM and reusable from the create-booking drawer and post-job dialog.
//
// Tire replacement booked through the customer app is a quote system. When a
// mechanic adds tires mid-job or logs a walk-in there is no quote — they enter
// the tires directly. Tires carry no OEM number, so a line is identified by
// SIZE (fitment) / BRAND / MODEL with a mechanic-set per-tire price. Entry is
// per axle (front + rear) so staggered fitments are expressible.
//
// The emitted part-line objects keep oem_number = `TIRE-{size}` (the sentinel
// used everywhere else) so every OEM-keyed consumer keeps working, while the
// structured is_tire/tire_* fields carry the real identity.

import {
  TIRE_BRAND_OPTIONS,
  TIRE_MODEL_OPTIONS,
} from "@/lib/inspection-options";
import type { JobActualPartPayload } from "@/lib/vehicle-passport";

export type TireAxle = "front" | "rear";

export type TireLine = {
  position: TireAxle;
  size: string;
  brand: string;
  model: string;
  /** Per-tire price in dollars, kept as a string for the input. "" = unpriced. */
  perTirePrice: string;
  quantity: number;
};

export const DEFAULT_AXLE_QUANTITY = 2;

/** Strip a size to its canonical form: uppercase, no spaces, digits / R / slash
 *  only (matches tire-spec-picker's normalizeTireSizeValue). */
export function normalizeTireSize(value?: string | null): string {
  return (value ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^0-9R/]/g, "");
}

export function emptyTireLine(position: TireAxle): TireLine {
  return {
    position,
    size: "",
    brand: "",
    model: "",
    perTirePrice: "",
    quantity: DEFAULT_AXLE_QUANTITY,
  };
}

/** Resolve a brand/model free-text or option value to its human label. */
function labelFor(
  value: string | null | undefined,
  options: { value: string; label: string }[],
): string {
  if (!value) return "";
  const hit = options.find(
    (o) =>
      o.value.toLowerCase() === value.toLowerCase() ||
      o.label.toLowerCase() === value.toLowerCase(),
  );
  return hit ? hit.label : value;
}

/** True for a part row that represents a mechanic-entered tire line — either
 *  the explicit flag or the legacy `TIRE-` sentinel oem_number. */
export function isTirePartRow(part: {
  is_tire?: boolean | null;
  oem_number?: string | null;
}): boolean {
  return (
    part.is_tire === true ||
    (typeof part.oem_number === "string" &&
      part.oem_number.toUpperCase().startsWith("TIRE-"))
  );
}

/** Seed editor lines from the prejob inspection tire findings. Pre-loads every
 *  axle the inspection recorded a size for (user chose "all inspected tires"). */
export function tireLinesFromPrejob(
  prejob:
    | {
        tire_size_front?: string | null;
        tire_size_rear?: string | null;
        front?: { brand?: string | null; model?: string | null } | null;
        rear?: { brand?: string | null; model?: string | null } | null;
      }
    | null
    | undefined,
): TireLine[] {
  if (!prejob) return [];
  const lines: TireLine[] = [];
  if (prejob.tire_size_front) {
    lines.push({
      ...emptyTireLine("front"),
      size: normalizeTireSize(prejob.tire_size_front),
      brand: labelFor(prejob.front?.brand, TIRE_BRAND_OPTIONS),
      model: labelFor(prejob.front?.model, TIRE_MODEL_OPTIONS),
    });
  }
  if (prejob.tire_size_rear) {
    lines.push({
      ...emptyTireLine("rear"),
      size: normalizeTireSize(prejob.tire_size_rear),
      brand: labelFor(prejob.rear?.brand, TIRE_BRAND_OPTIONS),
      model: labelFor(prejob.rear?.model, TIRE_MODEL_OPTIONS),
    });
  }
  return lines;
}

/** Seed editor lines from existing part rows (e.g. a walk-in's priced snapshot
 *  or a prior mid-job submission). Groups by tire_position; unknown positions
 *  fall to front then rear. */
export function tireLinesFromParts(
  parts: Array<{
    is_tire?: boolean | null;
    oem_number?: string | null;
    tire_size?: string | null;
    tire_brand?: string | null;
    tire_model?: string | null;
    tire_position?: string | null;
    brand?: string | null;
    // Snapshot rows carry a number; the dialog's PartRowState carries a
    // formatted string — accept both.
    cost?: number | string | null;
    quantity?: number | null;
  }>,
): TireLine[] {
  const lines: TireLine[] = [];
  let fallbackUsedFront = false;
  for (const p of parts) {
    if (!isTirePartRow(p)) continue;
    const costNum = typeof p.cost === "string" ? Number(p.cost) : p.cost;
    const posRaw = (p.tire_position ?? "").toLowerCase();
    const position: TireAxle =
      posRaw.includes("rear") || posRaw === "rl" || posRaw === "rr"
        ? "rear"
        : posRaw.includes("front") || posRaw === "fl" || posRaw === "fr"
          ? "front"
          : fallbackUsedFront
            ? "rear"
            : "front";
    if (position === "front") fallbackUsedFront = true;
    const size = p.tire_size
      ? normalizeTireSize(p.tire_size)
      : p.oem_number
        ? normalizeTireSize(p.oem_number.replace(/^TIRE-/i, ""))
        : "";
    lines.push({
      position,
      size,
      brand: p.tire_brand ?? p.brand ?? "",
      model: p.tire_model ?? "",
      perTirePrice:
        typeof costNum === "number" && Number.isFinite(costNum) && costNum > 0
          ? String(costNum)
          : "",
      quantity:
        typeof p.quantity === "number" && p.quantity > 0
          ? Math.round(p.quantity)
          : DEFAULT_AXLE_QUANTITY,
    });
  }
  return lines;
}

/** Convert editor lines to part-line payloads for the booking snapshot / job
 *  actuals. Per-unit convention: cost = per-tire price, quantity = count — the
 *  parts step and createByShop both bill cost × quantity. */
export function tireLinesToPartPayloads(
  lines: TireLine[],
  serviceId?: string | null,
): JobActualPartPayload[] {
  return lines
    .filter((l) => l.size.trim() || l.brand.trim() || l.model.trim())
    .map((l) => {
      const size = normalizeTireSize(l.size);
      const brand = l.brand.trim();
      const model = l.model.trim();
      const qty = Math.max(1, Math.round(l.quantity || DEFAULT_AXLE_QUANTITY));
      const priceNum = Number(l.perTirePrice);
      const perTire = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : 0;
      const identity = [brand, model].filter(Boolean).join(" ");
      return {
        part_name: identity ? `Tires — ${identity} (x${qty})` : `Tires (x${qty})`,
        oem_number: size ? `TIRE-${size}` : "",
        brand: brand || null,
        cost: perTire,
        quantity: qty,
        part_tier: "oem",
        supplied_by: "shop" as const,
        source: "manual" as const,
        service_id: serviceId ?? null,
        is_tire: true,
        tire_size: size || null,
        tire_brand: brand || null,
        tire_model: model || null,
        tire_position: l.position,
      };
    });
}
