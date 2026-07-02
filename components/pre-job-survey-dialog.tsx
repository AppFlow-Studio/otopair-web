"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FirstVisitNotice,
  SourceBadge,
  sourceBadgeClassName,
} from "@/components/vehicle-passport-section";
import EnrichmentStatusBanner from "@/components/enrichment-status-banner";
import {
  FILTER_STATUSES,
  filterStatusLabel,
  hasText,
  isFilterStatus,
  isTireCondition,
  passportSourceLabel,
  tireConditionLabel,
  type FilterStatus,
  type PassportSource,
  type RotorCondition,
  type PreJobSurveyPayload,
  type TireCondition,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import { getBookingServiceFlags } from "@/lib/vehicle-service-relevance";
import {
  TIRE_POSITIONS,
  convertRotorValue,
  formatRotorValue,
  getTireTreadMinimum,
  rotorValueToMicrometers,
  validateInspectionMeasurementDraft,
  validateInspectionMeasurements,
  type RotorUnit,
  type TirePosition,
  type TireTreadReading,
} from "@/lib/inspection-measurements";
import { cn } from "@/lib/utils";

const conditionPalette: Record<
  TireCondition,
  { label: string; activeClassName: string }
> = {
  good: {
    label: "Good",
    activeClassName: "border-emerald-300 bg-emerald-50 text-emerald-700",
  },
  fair: {
    label: "Fair",
    activeClassName: "border-sky-300 bg-sky-50 text-sky-700",
  },
  replace_soon: {
    label: "Replace soon",
    activeClassName: "border-red-300 bg-red-50 text-red-700",
  },
};

const TIRE_SIZE_PATTERN = /^\d{3}\/\d{2}R\d{2}$/i;

type SelectOption = { value: string; label: string; aliases?: string[] };

function normalizeForAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveOption(value: string | null | undefined, options: SelectOption[]): SelectOption | null {
  if (!value) return null;
  const direct = options.find((o) => o.value === value);
  if (direct) return direct;
  const normalized = normalizeForAlias(value);
  return (
    options.find(
      (o) =>
        normalizeForAlias(o.value) === normalized ||
        normalizeForAlias(o.label) === normalized ||
        o.aliases?.some((a) => normalizeForAlias(a) === normalized),
    ) ?? null
  );
}

function optionLabel(value: string | null | undefined, options: SelectOption[]): string {
  return resolveOption(value, options)?.label ?? (value ?? "");
}

const TIRE_BRAND_OPTIONS: SelectOption[] = [
  { value: "goodyear", label: "Goodyear" },
  { value: "michelin", label: "Michelin" },
  { value: "bridgestone", label: "Bridgestone" },
  { value: "firestone", label: "Firestone" },
  { value: "continental", label: "Continental" },
  { value: "pirelli", label: "Pirelli" },
  { value: "cooper", label: "Cooper" },
  { value: "hankook", label: "Hankook" },
  { value: "yokohama", label: "Yokohama" },
  { value: "bfgoodrich", label: "BFGoodrich", aliases: ["bf goodrich", "b.f. goodrich"] },
  { value: "toyo", label: "Toyo" },
  { value: "falken", label: "Falken" },
  { value: "general", label: "General" },
  { value: "kumho", label: "Kumho" },
  { value: "dunlop", label: "Dunlop" },
  { value: "nitto", label: "Nitto" },
  { value: "nexen", label: "Nexen" },
  { value: "mastercraft", label: "Mastercraft" },
  { value: "sumitomo", label: "Sumitomo" },
];

const OIL_VISCOSITY_OPTIONS: SelectOption[] = [
  { value: "0w_8", label: "0W-8", aliases: ["0w8", "0w-8"] },
  { value: "0w_16", label: "0W-16", aliases: ["0w16", "0w-16"] },
  { value: "0w_20", label: "0W-20", aliases: ["0w20", "0w-20"] },
  { value: "0w_30", label: "0W-30", aliases: ["0w30", "0w-30"] },
  { value: "0w_40", label: "0W-40", aliases: ["0w40", "0w-40"] },
  { value: "5w_20", label: "5W-20", aliases: ["5w20", "5w-20"] },
  { value: "5w_30", label: "5W-30", aliases: ["5w30", "5w-30"] },
  { value: "5w_40", label: "5W-40", aliases: ["5w40", "5w-40"] },
  { value: "10w_30", label: "10W-30", aliases: ["10w30", "10w-30"] },
  { value: "10w_40", label: "10W-40", aliases: ["10w40", "10w-40"] },
  { value: "15w_40", label: "15W-40", aliases: ["15w40", "15w-40"] },
  { value: "20w_50", label: "20W-50", aliases: ["20w50", "20w-50"] },
];

const OIL_TYPE_OPTIONS: SelectOption[] = [
  { value: "full_synthetic", label: "Full synthetic", aliases: ["synthetic", "fully synthetic"] },
  { value: "synthetic_blend", label: "Synthetic blend", aliases: ["blend", "semi synthetic", "semi-synthetic"] },
  { value: "conventional", label: "Conventional", aliases: ["mineral"] },
  { value: "high_mileage", label: "High mileage", aliases: ["hm"] },
  { value: "diesel_hd", label: "Diesel (HD)", aliases: ["hdeo", "ck-4", "cj-4", "diesel"] },
];

const OIL_CAPACITY_OPTIONS: SelectOption[] = (() => {
  const out: SelectOption[] = [];
  for (let q = 3.0; q <= 10.0 + 1e-9; q += 0.5) {
    const s = q.toFixed(1);
    out.push({ value: s, label: `${s} qts` });
  }
  return out;
})();

const COOLANT_TYPE_OPTIONS: SelectOption[] = [
  { value: "iat", label: "IAT (Green)", aliases: ["iat green", "green"] },
  {
    value: "oat",
    label: "OAT (Orange / Yellow / Red — Dex-Cool, G12)",
    aliases: ["oat", "dexcool", "dex-cool", "dex cool", "g12", "orange"],
  },
  { value: "hoat", label: "HOAT (Yellow / Orange)", aliases: ["hoat", "yellow"] },
  {
    value: "p_hoat",
    label: "P-HOAT (Pink / Blue — Asian OEM)",
    aliases: ["phoat", "p-hoat", "asian", "toyota red", "honda blue", "pink"],
  },
  {
    value: "si_oat",
    label: "Si-OAT (Pink / Purple — VW/Audi/MB)",
    aliases: ["sioat", "si-oat", "g12++", "g13", "mb 325.5"],
  },
  { value: "universal", label: "Universal / Global", aliases: ["universal", "prediluted"] },
];

const BRAKE_FLUID_OPTIONS: SelectOption[] = [
  { value: "dot_3", label: "DOT 3", aliases: ["dot3"] },
  { value: "dot_4", label: "DOT 4", aliases: ["dot4"] },
  { value: "dot_4_lv", label: "DOT 4 LV", aliases: ["dot4lv", "dot 4 low viscosity", "low viscosity dot 4"] },
  { value: "dot_5", label: "DOT 5 (silicone)", aliases: ["dot5", "silicone"] },
  { value: "dot_5_1", label: "DOT 5.1", aliases: ["dot5.1", "dot 5-1", "dot51"] },
];

const TRANSMISSION_FLUID_OPTIONS: SelectOption[] = [
  { value: "dexron_vi", label: "Dexron VI", aliases: ["dex 6", "dexvi", "dex vi", "dexron 6"] },
  { value: "dexron_iii_mercon", label: "Dexron III / Mercon (legacy)", aliases: ["dex iii", "dex/merc", "dexron iii", "dex-merc"] },
  { value: "mercon_lv", label: "Mercon LV", aliases: ["merc lv"] },
  { value: "mercon_v", label: "Mercon V", aliases: ["merc v"] },
  { value: "atf_plus_4", label: "ATF+4", aliases: ["atf 4", "atf+4", "atf plus 4"] },
  { value: "type_f", label: "Type F", aliases: ["typef"] },
  { value: "toyota_ws", label: "Toyota WS", aliases: ["ws", "world standard"] },
  { value: "toyota_t_iv", label: "Toyota T-IV", aliases: ["t-iv", "t4", "tiv"] },
  { value: "honda_dw_1", label: "Honda DW-1", aliases: ["dw1", "atf-z1", "z1", "dw-1"] },
  { value: "nissan_matic_s", label: "Nissan Matic-S", aliases: ["matic s", "matic-j", "matic j"] },
  { value: "hyundai_kia_sp_iv", label: "Hyundai/Kia SP-IV", aliases: ["sp-iv", "sp4", "sp iv"] },
  { value: "cvt_ns_2_3", label: "CVT NS-2 / NS-3", aliases: ["ns-2", "ns-3", "ns2", "ns3"] },
  { value: "cvt_universal", label: "CVT (universal)", aliases: ["cvt"] },
  { value: "dct_universal", label: "DCT (universal)", aliases: ["dct", "dsg"] },
  { value: "manual_75w90_gl4", label: "Manual 75W-90 GL-4", aliases: ["75w90 gl-4", "gl-4"] },
  { value: "manual_75w90_gl5", label: "Manual 75W-90 GL-5", aliases: ["75w90 gl-5", "gl-5"] },
];

const PAD_THICKNESS_OPTIONS: SelectOption[] = (() => {
  const out: SelectOption[] = [];
  for (let mm = 1.0; mm <= 12.0 + 1e-9; mm += 0.5) {
    const s = mm.toFixed(1);
    out.push({ value: s, label: `${s} mm` });
  }
  return out;
})();

type SubmitIntent = "close" | "start";
type SectionTabId =
  | "mileage"
  | "tire-condition"
  | "brakes"
  | "fluids"
  | "filters"
  | "inspection"
  | "modifications"
  | "review";

const SECTION_TABS: Array<{
  id: SectionTabId;
  label: string;
  requiredWhen?: "always" | "brake-work" | "oil-change";
}> = [
  { id: "mileage", label: "Mileage", requiredWhen: "always" },
  {
    id: "tire-condition",
    label: "Tire condition",
    requiredWhen: "always",
  },
  { id: "brakes", label: "Brakes", requiredWhen: "brake-work" },
  { id: "fluids", label: "Fluids", requiredWhen: "oil-change" },
  {
    id: "filters",
    label: "Filters",
  },
  {
    id: "inspection",
    label: "Inspection",
  },
  {
    id: "modifications",
    label: "Modifications",
  },
  { id: "review", label: "Review" },
];

function keepDigitsOnly(value: string) {
  return value.replace(/\D+/g, "");
}

function keepNumericInput(value: string) {
  const normalized = value.replace(/[^0-9.]+/g, "");
  const [whole, ...rest] = normalized.split(".");
  return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

type TreadInputState = Record<
  TirePosition,
  {
    minimum: string;
    detailed: boolean;
    inner: string;
    center: string;
    outer: string;
  }
>;

type RotorInputState = Record<TirePosition, string>;

const POSITION_LABELS: Record<TirePosition, string> = {
  front_left: "Front left",
  front_right: "Front right",
  rear_left: "Rear left",
  rear_right: "Rear right",
};

function treadReadingToInput(
  reading: TireTreadReading | null | undefined,
): TreadInputState[TirePosition] {
  const detailed =
    reading?.inner_32nds != null ||
    reading?.center_32nds != null ||
    reading?.outer_32nds != null;
  return {
    minimum:
      reading?.reported_min_32nds == null
        ? ""
        : String(reading.reported_min_32nds),
    detailed,
    inner: reading?.inner_32nds == null ? "" : String(reading.inner_32nds),
    center:
      reading?.center_32nds == null ? "" : String(reading.center_32nds),
    outer: reading?.outer_32nds == null ? "" : String(reading.outer_32nds),
  };
}

function buildInitialTreadInputs(
  readings: PreJobSurveyPayload["tire_tread"],
): TreadInputState {
  return Object.fromEntries(
    TIRE_POSITIONS.map((position) => [
      position,
      treadReadingToInput(readings?.[position]),
    ]),
  ) as TreadInputState;
}

function sanitizeTreadInput(value: string) {
  return keepDigitsOnly(value).slice(0, 2);
}

function buildTreadReading(
  input: TreadInputState[TirePosition],
): TireTreadReading | undefined {
  const parse = (value: string) => (value === "" ? null : Number(value));
  const reported = parse(input.minimum);
  const inner = parse(input.inner);
  const center = parse(input.center);
  const outer = parse(input.outer);
  if (
    reported == null &&
    inner == null &&
    center == null &&
    outer == null
  ) {
    return undefined;
  }
  return {
    reported_min_32nds: reported,
    ...(input.detailed
      ? {
          inner_32nds: inner,
          center_32nds: center,
          outer_32nds: outer,
        }
      : {}),
  };
}

function initialRotorUnit(
  brakes: PreJobSurveyPayload["brakes"],
): RotorUnit {
  for (const position of TIRE_POSITIONS) {
    const reading = brakes?.rotor_thickness?.[position];
    if (reading) return reading.entered_unit;
  }
  return "in";
}

function buildInitialRotorInputs(
  brakes: PreJobSurveyPayload["brakes"],
  unit: RotorUnit,
): RotorInputState {
  return Object.fromEntries(
    TIRE_POSITIONS.map((position) => {
      const reading = brakes?.rotor_thickness?.[position];
      if (!reading) return [position, ""];
      const value =
        reading.entered_unit === unit
          ? reading.entered_value
          : convertRotorValue(
              reading.entered_value,
              reading.entered_unit,
              unit,
            );
      return [position, formatRotorValue(value, unit)];
    }),
  ) as RotorInputState;
}

function normalizeTireSizeValue(value?: string | null) {
  return (value ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^0-9R/]/g, "");
}

function isValidTireSize(value: string) {
  return TIRE_SIZE_PATTERN.test(normalizeTireSizeValue(value));
}

function parseTireSizeParts(value: string): { width: string; aspect: string; wheel: string } {
  const normalized = normalizeTireSizeValue(value);
  const match = normalized.match(/^(\d{0,3})(?:\/(\d{0,2}))?(?:R(\d{0,2}))?$/i);
  return {
    width: match?.[1] ?? "",
    aspect: match?.[2] ?? "",
    wheel: match?.[3] ?? "",
  };
}

function composeTireSize(width: string, aspect: string, wheel: string): string {
  if (!width && !aspect && !wheel) return "";
  return `${width}/${aspect}R${wheel}`;
}

function TireSizeInput({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const parts = parseTireSizeParts(value);
  const aspectRef = useRef<HTMLInputElement | null>(null);
  const wheelRef = useRef<HTMLInputElement | null>(null);

  const emit = (width: string, aspect: string, wheel: string) => {
    onChange(composeTireSize(width, aspect, wheel));
  };

  const sanitize = (s: string, max: number) =>
    s.replace(/[^0-9]/g, "").slice(0, max);

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

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;

  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    const canScroll = current.scrollHeight > current.clientHeight;

    if (canScroll && (overflowY === "auto" || overflowY === "scroll")) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function rotorConditionLabel(value: string) {
  if (value === "good") return "Good";
  if (value === "scored") return "Scored";
  if (value === "needs_attention") return "Needs attention";
  return "Select...";
}

function modificationStatusLabel(value: string) {
  if (value === "none_observed") return "None observed";
  if (value === "aftermarket_observed") return "Yes - see notes";
  return "Select...";
}

function initialFilterStatus(value?: string | null): FilterStatus {
  return isFilterStatus(value) ? value : "not_checked";
}

function getInitials(label: string): string {
  const raw = label.trim();
  if (!raw) return "VH";
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "VH";
  if (/^\d{4}$/.test(words[0]) && words.length >= 3) {
    return (words[1][0] + words[2][0]).toUpperCase();
  }
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function hasPrefilledText(value?: string | null) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasPrefilledNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value);
}

function shouldRenderSourceBadge(source?: PassportSource) {
  return !!source && source !== "empty";
}

function ConditionButtons({
  value,
  onChange,
}: {
  value: TireCondition | null;
  onChange: (next: TireCondition) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(conditionPalette) as TireCondition[]).map((key) => {
        const option = conditionPalette[key];
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
              active
                ? option.activeClassName
                : "border-primary/10 bg-muted/60 text-muted-foreground hover:bg-muted"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export type PreJobOemPart = {
  oem_part_number: string;
  name: string;
  category?: string | null;
  position?: string | null;
  quantity_needed?: number | null;
};

export type PreJobOemPartsForService = {
  serviceName: string;
  serviceSlug: string;
  parts: PreJobOemPart[];
};

/** Locked/agreed quote summary for the pre-job header. Mirrors the post-job
 *  `LockedQuote` shape. When `originalTotalCents` differs from `totalCents`, the
 *  customer approved a price adjustment — shown as original → new. */
export type PreJobLockedQuote = {
  totalCents: number;
  originalTotalCents?: number | null;
  hasBreakdown?: boolean;
  partsCents: number;
  laborCents: number;
  taxCents: number;
  feeCents: number;
};

export default function PreJobSurveyDialog({
  open,
  bookingId,
  bookingLabel,
  bookingSubLabel,
  bookingServices = [],
  passportData,
  prefillData,
  oemPartsByService,
  lockedQuote,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bookingId?: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices?: string[];
  passportData: VehiclePassportData | null | undefined;
  prefillData?: PreJobSurveyPayload | null;
  oemPartsByService?: PreJobOemPartsForService[] | null;
  lockedQuote?: PreJobLockedQuote | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PreJobSurveyPayload, action: SubmitIntent) => Promise<void>;
}) {
  return (
    <PreJobSurveyDialogBody
      key={`${passportData?.vin ?? "no-vin"}-${bookingLabel}-${bookingSubLabel}`}
      open={open}
      bookingId={bookingId ?? null}
      bookingLabel={bookingLabel}
      bookingSubLabel={bookingSubLabel}
      bookingServices={bookingServices}
      passportData={passportData ?? null}
      prefillData={prefillData ?? null}
      oemPartsByService={oemPartsByService ?? null}
      lockedQuote={lockedQuote ?? null}
      isSubmitting={isSubmitting}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function PreJobSurveyDialogBody({
  open,
  bookingId,
  bookingLabel,
  bookingSubLabel,
  bookingServices,
  passportData,
  prefillData,
  oemPartsByService,
  lockedQuote,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bookingId: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices: string[];
  passportData: VehiclePassportData | null;
  prefillData: PreJobSurveyPayload | null;
  oemPartsByService: PreJobOemPartsForService[] | null;
  lockedQuote: PreJobLockedQuote | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PreJobSurveyPayload, action: SubmitIntent) => Promise<void>;
}) {
  const serviceFlags = getBookingServiceFlags(bookingServices);

  // Which brake axle(s) this booking actually covers. A "Rear pads only" job
  // hides the front-pad field (and vice versa) so the mechanic only measures
  // what's in scope. Falls back to both axles while loading, for non-brake
  // bookings, and for legacy bookings with no recorded axle option.
  const brakeScope = useQuery(
    api.serviceParts.getBrakeScopeForBooking,
    open && bookingId ? ({ bookingId } as { bookingId: Id<"bookings"> }) : "skip",
  );
  const padScope =
    serviceFlags.hasBrakeWork && brakeScope?.hasBrakeWork
      ? { front: brakeScope.front, rear: brakeScope.rear }
      : { front: true, rear: true };
  const rotorPositions: TirePosition[] = serviceFlags.hasBrakeWork
    ? [
        ...(padScope.front
          ? (["front_left", "front_right"] as TirePosition[])
          : []),
        ...(padScope.rear
          ? (["rear_left", "rear_right"] as TirePosition[])
          : []),
      ]
    : [...TIRE_POSITIONS];

  const initialMileage =
    typeof prefillData?.mileage === "number" && Number.isFinite(prefillData.mileage)
      ? String(Math.round(prefillData.mileage))
      : typeof passportData?.passport.mileage === "number"
        ? String(Math.round(passportData.passport.mileage))
        : "";
  const initialFrontTireSize = normalizeTireSizeValue(
    prefillData?.tire_size_front ?? passportData?.passport.tires.size_front
  );
  const initialRearTireSize = normalizeTireSizeValue(
    prefillData?.tire_size_rear ??
      passportData?.passport.tires.size_rear ??
      passportData?.passport.tires.size_front
  );
  const initialRearMatchesFront =
    !initialRearTireSize || initialRearTireSize === initialFrontTireSize;
  const initialFrontPad =
    typeof prefillData?.brakes?.front_pad_mm === "number"
      ? String(prefillData.brakes.front_pad_mm)
      : typeof passportData?.passport.brakes.front_pad_mm === "number"
        ? String(passportData.passport.brakes.front_pad_mm)
        : "";
  const initialRearPad =
    typeof prefillData?.brakes?.rear_pad_mm === "number"
      ? String(prefillData.brakes.rear_pad_mm)
      : typeof passportData?.passport.brakes.rear_pad_mm === "number"
        ? String(passportData.passport.brakes.rear_pad_mm)
        : "";
  const initialTreadInputs = buildInitialTreadInputs(prefillData?.tire_tread);
  const initialRotorMeasurementUnit = initialRotorUnit(prefillData?.brakes);
  const initialRotorInputs = buildInitialRotorInputs(
    prefillData?.brakes,
    initialRotorMeasurementUnit,
  );
  const initialOilCapacity =
    typeof prefillData?.fluid_overrides?.oil_capacity_qts === "number"
      ? String(prefillData.fluid_overrides.oil_capacity_qts)
      : typeof passportData?.passport.fluids.oil_capacity_qts === "number"
        ? String(passportData.passport.fluids.oil_capacity_qts)
        : "";

  const [mileage, setMileage] = useState(initialMileage);
  const [tireBrand, setTireBrand] = useState(
    prefillData?.tire_brand ?? passportData?.passport.tires.brand ?? ""
  );
  const [frontTireSize, setFrontTireSize] = useState(initialFrontTireSize);
  const [rearMatchesFront, setRearMatchesFront] = useState(initialRearMatchesFront);
  const [rearTireSize, setRearTireSize] = useState(
    initialRearMatchesFront ? initialFrontTireSize : initialRearTireSize
  );
  const [frontCondition, setFrontCondition] = useState<TireCondition | null>(
    prefillData?.front_tire_condition ?? passportData?.passport.tires.front_condition ?? null
  );
  const [rearCondition, setRearCondition] = useState<TireCondition | null>(
    prefillData?.rear_tire_condition ?? passportData?.passport.tires.rear_condition ?? null
  );
  const [treadInputs, setTreadInputs] =
    useState<TreadInputState>(initialTreadInputs);
  const [frontPadMm, setFrontPadMm] = useState(initialFrontPad);
  const [rearPadMm, setRearPadMm] = useState(initialRearPad);
  const [rotorUnit, setRotorUnit] = useState<RotorUnit>(
    initialRotorMeasurementUnit,
  );
  const [rotorInputs, setRotorInputs] =
    useState<RotorInputState>(initialRotorInputs);
  const [rotorCondition, setRotorCondition] = useState<"" | RotorCondition>(
    prefillData?.brakes?.rotor_condition ??
      passportData?.passport.brakes.rotor_condition ??
      ""
  );
  const [oilViscosity, setOilViscosity] = useState(
    prefillData?.fluid_overrides?.oil_viscosity ??
      passportData?.passport.fluids.oil_viscosity ??
      ""
  );
  const [oilCapacity, setOilCapacity] = useState(initialOilCapacity);
  const [oilType, setOilType] = useState(
    prefillData?.fluid_overrides?.oil_type ?? passportData?.passport.fluids.oil_type ?? ""
  );
  const [coolantType, setCoolantType] = useState(
    prefillData?.fluid_overrides?.coolant_type ??
      passportData?.passport.fluids.coolant_type ??
      ""
  );
  const [brakeFluidType, setBrakeFluidType] = useState(
    prefillData?.fluid_overrides?.brake_fluid_type ??
      passportData?.passport.fluids.brake_fluid_type ??
      ""
  );
  const [transmissionFluidType, setTransmissionFluidType] = useState(
    prefillData?.fluid_overrides?.transmission_fluid_type ??
      passportData?.passport.fluids.transmission_fluid_type ??
      ""
  );
  const [engineAirFilterStatus, setEngineAirFilterStatus] = useState<FilterStatus>(
    initialFilterStatus(prefillData?.filters?.engine_air_filter)
  );
  const [cabinAirFilterStatus, setCabinAirFilterStatus] = useState<FilterStatus>(
    initialFilterStatus(prefillData?.filters?.cabin_air_filter)
  );
  const [inspectionLooksCurrent, setInspectionLooksCurrent] = useState<
    "" | "yes" | "no"
  >(
    prefillData?.inspection?.looks_current == null
      ? passportData?.passport.inspection.looks_current == null
        ? ""
        : passportData.passport.inspection.looks_current
          ? "yes"
          : "no"
      : prefillData.inspection.looks_current
        ? "yes"
        : "no"
  );
  const [inspectionExpiresAt, setInspectionExpiresAt] = useState(
    prefillData?.inspection?.expires_at ?? passportData?.passport.inspection.expires_at ?? ""
  );
  const [modificationsStatus, setModificationsStatus] = useState<
    "" | "none_observed" | "aftermarket_observed"
  >(
    prefillData?.modifications?.status ??
      passportData?.passport.modifications.status ??
      ""
  );
  const [modificationNotes, setModificationNotes] = useState(
    prefillData?.modifications?.notes ?? passportData?.passport.modifications.notes ?? ""
  );
  const [flaggedVehicleSpecs, setFlaggedVehicleSpecs] = useState(
    prefillData?.flagged_vehicle_specs ?? false
  );
  const [nextMechanicTip, setNextMechanicTip] = useState(
    prefillData?.next_mechanic_tip ?? ""
  );
  const [error, setError] = useState("");
  const [activeSubmitAction, setActiveSubmitAction] = useState<SubmitIntent | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionTabId>("mileage");
  // If the passport already has the full tire profile (sizes + both
  // conditions + brand), collapse the tire-condition section to a
  // "Already on file — looks the same?" snapshot so the mechanic isn't
  // re-answering the same questions every booking. Expanding restores
  // the full editor.
  const passportTireProfileComplete = useMemo(() => {
    const t = passportData?.passport.tires;
    if (!t) return false;
    const hasFront = hasText(t.size_front);
    const hasRear = hasText(t.size_rear) || hasText(t.size_front);
    const hasBrand = hasText(t.brand);
    const hasCurrentTread = TIRE_POSITIONS.every(
      (position) =>
        typeof prefillData?.tire_tread?.[position]?.reported_min_32nds ===
        "number",
    );
    return hasFront && hasRear && hasBrand && hasCurrentTread;
  }, [passportData, prefillData]);
  const [tireSectionExpanded, setTireSectionExpanded] = useState(
    !passportTireProfileComplete,
  );
  const activeSectionRef = useRef<SectionTabId>("mileage");
  const navRef = useRef<HTMLDivElement | null>(null);
  const scrollStripRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollTargetRef = useRef(0);
  const horizontalScrollFrameRef = useRef<number | null>(null);
  const sectionRefs = useRef<Record<SectionTabId, HTMLElement | null>>({
    mileage: null,
    "tire-condition": null,
    brakes: null,
    fluids: null,
    filters: null,
    inspection: null,
    modifications: null,
    review: null,
  });

  const isFirstVisit = !!passportData && !passportData.is_complete;
  const frontSizeSource = passportData?.sources["tires.size_front"];
  const rearSizeSource = passportData?.sources["tires.size_rear"];

  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        mileage: initialMileage,
        tireBrand: prefillData?.tire_brand ?? passportData?.passport.tires.brand ?? "",
        frontTireSize: initialFrontTireSize,
        rearMatchesFront: initialRearMatchesFront,
        rearTireSize: initialRearMatchesFront ? initialFrontTireSize : initialRearTireSize,
        frontCondition:
          prefillData?.front_tire_condition ??
          passportData?.passport.tires.front_condition ??
          null,
        rearCondition:
          prefillData?.rear_tire_condition ??
          passportData?.passport.tires.rear_condition ??
          null,
        treadInputs: initialTreadInputs,
        frontPadMm: initialFrontPad,
        rearPadMm: initialRearPad,
        rotorUnit: initialRotorMeasurementUnit,
        rotorInputs: initialRotorInputs,
        rotorCondition:
          prefillData?.brakes?.rotor_condition ??
          passportData?.passport.brakes.rotor_condition ??
          "",
        oilViscosity:
          prefillData?.fluid_overrides?.oil_viscosity ??
          passportData?.passport.fluids.oil_viscosity ??
          "",
        oilCapacity: initialOilCapacity,
        oilType:
          prefillData?.fluid_overrides?.oil_type ??
          passportData?.passport.fluids.oil_type ??
          "",
        coolantType:
          prefillData?.fluid_overrides?.coolant_type ??
          passportData?.passport.fluids.coolant_type ??
          "",
        brakeFluidType:
          prefillData?.fluid_overrides?.brake_fluid_type ??
          passportData?.passport.fluids.brake_fluid_type ??
          "",
        transmissionFluidType:
          prefillData?.fluid_overrides?.transmission_fluid_type ??
          passportData?.passport.fluids.transmission_fluid_type ??
          "",
        engineAirFilterStatus: initialFilterStatus(
          prefillData?.filters?.engine_air_filter
        ),
        cabinAirFilterStatus: initialFilterStatus(
          prefillData?.filters?.cabin_air_filter
        ),
        inspectionLooksCurrent:
          prefillData?.inspection?.looks_current == null
            ? passportData?.passport.inspection.looks_current == null
              ? ""
              : passportData.passport.inspection.looks_current
                ? "yes"
                : "no"
            : prefillData.inspection.looks_current
              ? "yes"
              : "no",
        inspectionExpiresAt:
          prefillData?.inspection?.expires_at ??
          passportData?.passport.inspection.expires_at ??
          "",
        modificationsStatus:
          prefillData?.modifications?.status ??
          passportData?.passport.modifications.status ??
          "",
        modificationNotes:
          prefillData?.modifications?.notes ??
          passportData?.passport.modifications.notes ??
          "",
        flaggedVehicleSpecs: prefillData?.flagged_vehicle_specs ?? false,
        nextMechanicTip: prefillData?.next_mechanic_tip ?? "",
      }),
    [
      initialFrontPad,
      initialFrontTireSize,
      initialMileage,
      initialOilCapacity,
      initialRearMatchesFront,
      initialRearPad,
      initialRearTireSize,
      initialRotorInputs,
      initialRotorMeasurementUnit,
      initialTreadInputs,
      passportData,
      prefillData,
    ]
  );

  const currentSnapshot = JSON.stringify({
    mileage,
    tireBrand,
    frontTireSize,
    rearMatchesFront,
    rearTireSize,
    frontCondition,
    rearCondition,
    treadInputs,
    frontPadMm,
    rearPadMm,
    rotorUnit,
    rotorInputs,
    rotorCondition,
    oilViscosity,
    oilCapacity,
    oilType,
    coolantType,
    brakeFluidType,
    transmissionFluidType,
    engineAirFilterStatus,
    cabinAirFilterStatus,
    inspectionLooksCurrent,
    inspectionExpiresAt,
    modificationsStatus,
    modificationNotes,
    flaggedVehicleSpecs,
    nextMechanicTip,
  });
  const hasUnsavedChanges = currentSnapshot !== initialSnapshot;

  function buildPayload(): PreJobSurveyPayload {
    const parsedMileage = mileage.trim() === "" ? null : Number(mileage);
    const normalizedFrontTireSize = normalizeTireSizeValue(frontTireSize);
    const normalizedRearTireSize = rearMatchesFront
      ? normalizedFrontTireSize
      : normalizeTireSizeValue(rearTireSize);
    const parsedOilCapacity =
      oilCapacity.trim() === "" ? null : Number(oilCapacity);
    const tireTread = Object.fromEntries(
      TIRE_POSITIONS.flatMap((position) => {
        const reading = buildTreadReading(treadInputs[position]);
        return reading ? [[position, reading]] : [];
      }),
    );
    const rotorThickness = Object.fromEntries(
      TIRE_POSITIONS.flatMap((position) => {
        const raw = rotorInputs[position].trim();
        if (!raw) return [];
        const enteredValue = Number(raw);
        if (!Number.isFinite(enteredValue)) return [];
        return [
          [
            position,
            {
              entered_value: enteredValue,
              entered_unit: rotorUnit,
              normalized_um: rotorValueToMicrometers(
                enteredValue,
                rotorUnit,
              ),
            },
          ],
        ];
      }),
    );

    return {
      mileage:
        typeof parsedMileage === "number" && Number.isFinite(parsedMileage)
          ? parsedMileage
          : null,
      tire_brand: tireBrand.trim() || null,
      tire_size_front: normalizedFrontTireSize || null,
      tire_size_rear: normalizedRearTireSize || null,
      front_tire_condition: frontCondition,
      rear_tire_condition: rearCondition,
      tire_tread: tireTread,
      brakes: {
        front_pad_mm: frontPadMm.trim() === "" ? null : Number(frontPadMm),
        rear_pad_mm: rearPadMm.trim() === "" ? null : Number(rearPadMm),
        rotor_condition:
          rotorCondition === ""
            ? null
            : (rotorCondition as "good" | "scored" | "needs_attention"),
        rotor_thickness: rotorThickness,
      },
      fluids_match_oem: false,
      fluid_overrides: {
        oil_viscosity: oilViscosity.trim() || null,
        oil_capacity_qts:
          typeof parsedOilCapacity === "number" && Number.isFinite(parsedOilCapacity)
            ? parsedOilCapacity
            : null,
        oil_type: oilType.trim() || null,
        coolant_type: coolantType.trim() || null,
        brake_fluid_type: brakeFluidType.trim() || null,
        transmission_fluid_type: transmissionFluidType.trim() || null,
      },
      filters: {
        engine_air_filter: engineAirFilterStatus,
        cabin_air_filter: cabinAirFilterStatus,
      },
      inspection: {
        looks_current:
          inspectionLooksCurrent === ""
            ? null
            : inspectionLooksCurrent === "yes",
        expires_at: inspectionExpiresAt || null,
        status:
          inspectionLooksCurrent === ""
            ? null
            : inspectionLooksCurrent === "yes"
              ? "current"
              : "not_visible",
      },
      modifications: {
        status: modificationsStatus === "" ? null : modificationsStatus,
        notes: modificationNotes.trim() || null,
      },
      flagged_vehicle_specs: flaggedVehicleSpecs,
      next_mechanic_tip: nextMechanicTip.trim() || null,
    };
  }

  function validateStartPayload(payload: PreJobSurveyPayload) {
    if (payload.mileage == null || !Number.isFinite(payload.mileage)) {
      throw new Error("Mileage is required.");
    }
    if (!payload.tire_brand?.trim()) {
      throw new Error("Tire brand is required.");
    }
    if (!payload.tire_size_front?.trim()) {
      throw new Error("Front tire size is required.");
    }
    if (!isValidTireSize(payload.tire_size_front)) {
      throw new Error("Front tire size must use the format 275/45R20.");
    }
    if (!payload.tire_size_rear?.trim()) {
      throw new Error("Rear tire size is required.");
    }
    if (!isValidTireSize(payload.tire_size_rear)) {
      throw new Error("Rear tire size must use the format 275/45R20.");
    }
    if (!payload.front_tire_condition || !payload.rear_tire_condition) {
      throw new Error("Front and rear tire conditions are required.");
    }
    if (serviceFlags.hasBrakeWork) {
      if (
        padScope.front &&
        (typeof payload.brakes?.front_pad_mm !== "number" ||
          !Number.isFinite(payload.brakes.front_pad_mm))
      ) {
        throw new Error("Front pad thickness is required for brake-related work.");
      }
      if (
        padScope.rear &&
        (typeof payload.brakes?.rear_pad_mm !== "number" ||
          !Number.isFinite(payload.brakes.rear_pad_mm))
      ) {
        throw new Error("Rear pad thickness is required for brake-related work.");
      }
      if (!payload.brakes?.rotor_condition) {
        throw new Error("Rotor condition is required for brake-related work.");
      }
    }
    const measurementResult = validateInspectionMeasurements({
      tire_tread: payload.tire_tread,
      brakes: payload.brakes,
      brake_scope: {
        hasBrakeWork: serviceFlags.hasBrakeWork,
        front: padScope.front,
        rear: padScope.rear,
      },
    });
    if (!measurementResult.valid) {
      throw new Error(measurementResult.error);
    }
    if (serviceFlags.hasOilChange) {
      if (!payload.fluid_overrides?.oil_viscosity?.trim()) {
        throw new Error("Oil viscosity is required for an oil change.");
      }
      if (!payload.fluid_overrides?.oil_type?.trim()) {
        throw new Error("Oil type is required for an oil change.");
      }
    }
  }

  function validateDraftPayload(payload: PreJobSurveyPayload) {
    if (payload.tire_size_front && !isValidTireSize(payload.tire_size_front)) {
      throw new Error("Front tire size must use the format 275/45R20.");
    }
    if (payload.tire_size_rear && !isValidTireSize(payload.tire_size_rear)) {
      throw new Error("Rear tire size must use the format 275/45R20.");
    }
    const measurementResult = validateInspectionMeasurementDraft({
      tire_tread: payload.tire_tread,
      brakes: payload.brakes,
    });
    if (!measurementResult.valid) {
      throw new Error(measurementResult.error);
    }
  }

  async function handleSubmit(action: SubmitIntent) {
    const payload = buildPayload();

    try {
      if (action === "start") {
        validateStartPayload(payload);
      } else {
        validateDraftPayload(payload);
      }

      setError("");
      setActiveSubmitAction(action);
      await onSubmit(payload, action);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not save the pre-job vehicle check.";
      setError(message);
    } finally {
      setActiveSubmitAction(null);
    }
  }

  function updateTreadInput(
    position: TirePosition,
    field: "minimum" | "inner" | "center" | "outer",
    rawValue: string,
  ) {
    const value = sanitizeTreadInput(rawValue);
    setTreadInputs((current) => {
      const nextPosition = { ...current[position], [field]: value };
      if (field !== "minimum" && nextPosition.detailed) {
        const detailedReading: TireTreadReading = {
          inner_32nds:
            nextPosition.inner === "" ? null : Number(nextPosition.inner),
          center_32nds:
            nextPosition.center === "" ? null : Number(nextPosition.center),
          outer_32nds:
            nextPosition.outer === "" ? null : Number(nextPosition.outer),
        };
        const minimum = getTireTreadMinimum(detailedReading);
        if (minimum != null) {
          nextPosition.minimum = String(minimum);
        }
      }
      return { ...current, [position]: nextPosition };
    });
  }

  function toggleDetailedTread(position: TirePosition) {
    setTreadInputs((current) => {
      const positionInput = current[position];
      const detailed = !positionInput.detailed;
      return {
        ...current,
        [position]: {
          ...positionInput,
          detailed,
          ...(detailed ? {} : { inner: "", center: "", outer: "" }),
        },
      };
    });
  }

  function changeRotorUnit(nextUnit: RotorUnit) {
    if (nextUnit === rotorUnit) return;
    setRotorInputs((current) =>
      Object.fromEntries(
        TIRE_POSITIONS.map((position) => {
          const raw = current[position].trim();
          if (!raw) return [position, ""];
          const value = Number(raw);
          if (!Number.isFinite(value)) return [position, raw];
          return [
            position,
            formatRotorValue(
              convertRotorValue(value, rotorUnit, nextUnit),
              nextUnit,
            ),
          ];
        }),
      ) as RotorInputState,
    );
    setRotorUnit(nextUnit);
  }

  function requestClose() {
    if (isSubmitting) {
      return;
    }
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }

  const mileageError = mileage.trim() === "" && error !== "";

  const cancelTabScrollAnimation = useCallback(() => {
    if (horizontalScrollFrameRef.current == null) {
      return;
    }

    window.cancelAnimationFrame(horizontalScrollFrameRef.current);
    horizontalScrollFrameRef.current = null;
  }, []);

  const centerTab = useCallback(
    (sectionId: SectionTabId, behavior: ScrollBehavior = "smooth") => {
      const scrollElement = scrollStripRef.current;
      const tabElement = navRef.current?.querySelector<HTMLElement>(
        `[data-tab-id="${sectionId}"]`
      );
      if (!scrollElement || !tabElement) {
        return;
      }

      const scrollRect = scrollElement.getBoundingClientRect();
      const tabRect = tabElement.getBoundingClientRect();
      const targetLeft =
        scrollElement.scrollLeft +
        tabRect.left -
        scrollRect.left -
        (scrollElement.clientWidth - tabRect.width) / 2;
      const maxScrollLeft = scrollElement.scrollWidth - scrollElement.clientWidth;
      const nextScrollLeft = Math.max(0, Math.min(targetLeft, maxScrollLeft));

      cancelTabScrollAnimation();
      horizontalScrollTargetRef.current = nextScrollLeft;
      scrollElement.scrollTo({
        left: nextScrollLeft,
        behavior,
      });
    },
    [cancelTabScrollAnimation]
  );

  useEffect(() => {
    if (!open) {
      activeSectionRef.current = "mileage";
      setActiveSection("mileage");
      return;
    }

    const navElement = navRef.current;
    const scrollContainer = navElement ? findScrollableAncestor(navElement) : null;
    if (!navElement || !scrollContainer) {
      return;
    }

    const updateActiveSection = () => {
      const navHeight = navElement.getBoundingClientRect().height;
      const containerTop = scrollContainer.getBoundingClientRect().top;
      const probeLine = containerTop + navHeight + 24;
      let currentSection: SectionTabId = "mileage";

      for (const tab of SECTION_TABS) {
        const element = sectionRefs.current[tab.id];
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (rect.top <= probeLine) {
          currentSection = tab.id;
        } else {
          break;
        }
      }

      const activeSectionChanged = activeSectionRef.current !== currentSection;
      if (activeSectionChanged) {
        activeSectionRef.current = currentSection;
        setActiveSection(currentSection);
      }
      centerTab(currentSection, "auto");
    };

    updateActiveSection();
    scrollContainer.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("resize", updateActiveSection);

    return () => {
      scrollContainer.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, [centerTab, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const el = scrollStripRef.current;
    if (!el) {
      return;
    }

    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;
    horizontalScrollTargetRef.current = el.scrollLeft;

    const animateScroll = () => {
      const distance = horizontalScrollTargetRef.current - el.scrollLeft;
      if (Math.abs(distance) < 0.5) {
        el.scrollLeft = horizontalScrollTargetRef.current;
        horizontalScrollFrameRef.current = null;
        return;
      }

      el.scrollLeft += distance * 0.18;
      horizontalScrollFrameRef.current = window.requestAnimationFrame(animateScroll);
    };

    const startSmoothScroll = () => {
      if (horizontalScrollFrameRef.current != null) {
        return;
      }
      horizontalScrollFrameRef.current = window.requestAnimationFrame(animateScroll);
    };

    const onMouseDown = (event: MouseEvent) => {
      isDown = true;
      cancelTabScrollAnimation();
      el.style.cursor = "grabbing";
      startX = event.pageX - el.offsetLeft;
      scrollLeft = el.scrollLeft;
      horizontalScrollTargetRef.current = el.scrollLeft;
    };

    const onMouseLeave = () => {
      isDown = false;
      el.style.cursor = "grab";
    };

    const onMouseUp = () => {
      isDown = false;
      el.style.cursor = "grab";
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!isDown) {
        return;
      }
      event.preventDefault();
      const x = event.pageX - el.offsetLeft;
      const walk = (x - startX) * 1.5;
      el.scrollLeft = scrollLeft - walk;
      horizontalScrollTargetRef.current = el.scrollLeft;
    };

    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      if (maxScrollLeft <= 0) {
        return;
      }

      event.preventDefault();
      horizontalScrollTargetRef.current = Math.max(
        0,
        Math.min(horizontalScrollTargetRef.current + event.deltaY, maxScrollLeft)
      );
      startSmoothScroll();
    };

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("mouseleave", onMouseLeave);
    el.addEventListener("mouseup", onMouseUp);
    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("mouseleave", onMouseLeave);
      el.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("wheel", onWheel);
      cancelTabScrollAnimation();
    };
  }, [cancelTabScrollAnimation, open]);

  function scrollToSection(sectionId: SectionTabId) {
    const target = sectionRefs.current[sectionId];
    const navElement = navRef.current;
    const scrollContainer = navElement ? findScrollableAncestor(navElement) : null;
    if (!target || !navElement || !scrollContainer) return;

    activeSectionRef.current = sectionId;
    setActiveSection(sectionId);
    centerTab(sectionId);
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    const navHeight = navElement.getBoundingClientRect().height;

    scrollContainer.scrollTo({
      top: scrollContainer.scrollTop + targetTop - containerTop - navHeight,
      behavior: "smooth",
    });
  }

  return (
    <>
      <SurveyDialogShell
        open={open}
        title="Pre-job vehicle check"
        headerBadge={
          isFirstVisit ? (
            <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
              First visit
            </span>
          ) : null
        }
        onClose={requestClose}
        maxWidthClassName="max-w-6xl"
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {error ? (
              <p className="text-[11px] font-medium text-destructive sm:mr-auto">{error}</p>
            ) : null}
            <button
              type="button"
              onClick={requestClose}
              disabled={isSubmitting}
              className={cn(
                drawerSecondaryButtonClassName,
                "h-9 rounded-lg border-primary/10 text-[12px]"
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit("close")}
              disabled={isSubmitting}
              className={cn(
                drawerSecondaryButtonClassName,
                "h-9 rounded-lg border-primary/10 text-[12px]"
              )}
            >
              {isSubmitting && activeSubmitAction === "close" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save and close
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit("start")}
              disabled={isSubmitting}
              className={cn(drawerPrimaryButtonClassName, "h-9 rounded-lg text-[12px]")}
            >
              {isSubmitting && activeSubmitAction === "start" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save and continue
            </button>
          </div>
        }
      >
        <div className="lg:flex lg:items-start lg:gap-6">
          <aside className="hidden lg:sticky lg:top-0 lg:block lg:w-56 lg:shrink-0 lg:self-start lg:py-1">
            <nav aria-label="Pre-job sections" className="flex flex-col gap-1">
              <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Sections
              </p>
              {SECTION_TABS.map((tab) => {
                const isActive = activeSection === tab.id;
                const isRequired =
                  tab.requiredWhen === "always" ||
                  (tab.requiredWhen === "brake-work" && serviceFlags.hasBrakeWork) ||
                  (tab.requiredWhen === "oil-change" && serviceFlags.hasOilChange);
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => scrollToSection(tab.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md border-l-2 px-3 py-2 text-left text-[13px] font-medium transition-colors",
                      isActive
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-transparent text-muted-foreground hover:bg-primary/5 hover:text-foreground"
                    )}
                  >
                    <span className="truncate">{tab.label}</span>
                    {isRequired ? (
                      <span className="text-destructive" aria-label="required">*</span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </aside>

        <div className="space-y-4 lg:min-w-0 lg:flex-1">
          <VehicleSummaryCard
            label={bookingLabel}
            subLabel={bookingSubLabel}
            specLabel={passportData?.vehicle_spec_label ?? null}
          />

          <EnrichmentStatusBanner
            status={passportData?.enrichment_status}
            fillRate={passportData?.enrichment_fill_rate}
          />

          {bookingId && passportData?.vin ? (
            <PriorRecommendationsCard
              bookingId={bookingId}
              vin={passportData.vin}
            />
          ) : null}

          {lockedQuote ? (
            (() => {
              const adjusted =
                lockedQuote.originalTotalCents != null &&
                lockedQuote.originalTotalCents !== lockedQuote.totalCents;
              return (
                <section className="rounded-lg border border-primary/15 bg-card p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      {adjusted ? "Agreed price" : "Quoted price"}
                      {adjusted ? (
                        <span className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-success">
                          Adjusted
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-baseline gap-2">
                      {adjusted && lockedQuote.originalTotalCents != null ? (
                        <span className="text-[12px] font-medium tabular-nums text-muted-foreground line-through">
                          ${(lockedQuote.originalTotalCents / 100).toFixed(2)}
                        </span>
                      ) : null}
                      <span className="text-[16px] font-bold tabular-nums text-foreground">
                        ${(lockedQuote.totalCents / 100).toFixed(2)}
                      </span>
                    </span>
                  </div>
                  {lockedQuote.hasBreakdown ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Parts ${(lockedQuote.partsCents / 100).toFixed(2)} ·{" "}
                      Labor ${(lockedQuote.laborCents / 100).toFixed(2)} ·{" "}
                      Tax+Fee $
                      {((lockedQuote.taxCents + lockedQuote.feeCents) / 100).toFixed(2)}
                    </p>
                  ) : null}
                  {adjusted ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Customer approved this adjusted total.
                    </p>
                  ) : null}
                </section>
              );
            })()
          ) : null}

          {oemPartsByService && oemPartsByService.length > 0 ? (
            <section className="rounded-lg border border-primary/15 bg-card p-3.5">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-[13px] font-semibold uppercase tracking-wide text-foreground">
                  OEM parts for this job
                </h3>
                <span className="text-[11px] text-muted-foreground">
                  From Otopair catalog · informational
                </span>
              </div>
              <div className="space-y-3">
                {oemPartsByService.map((svc) => (
                  <div
                    key={svc.serviceSlug}
                    className="rounded-md border border-primary/10 bg-muted/30 p-3"
                  >
                    <div className="mb-2 text-[12px] font-semibold text-foreground">
                      {svc.serviceName}
                    </div>
                    {svc.parts.length === 0 ? (
                      <div className="text-[12px] text-muted-foreground">
                        No catalog parts on file for this service — capture
                        what&apos;s used in post-job.
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {svc.parts.map((p) => (
                          <li
                            key={`${svc.serviceSlug}-${p.oem_part_number}`}
                            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]"
                          >
                            <span className="font-medium text-foreground">
                              {p.name}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {p.oem_part_number}
                            </span>
                            {p.position ? (
                              <span className="text-[11px] text-muted-foreground">
                                · {p.position}
                              </span>
                            ) : null}
                            {p.quantity_needed && p.quantity_needed > 1 ? (
                              <span className="text-[11px] text-muted-foreground">
                                · qty {p.quantity_needed}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {isFirstVisit ? (
            <FirstVisitNotice>
              <>
                <span className="font-semibold text-foreground">First time on Otopair.</span>{" "}
                The data you confirm here builds this vehicle&apos;s passport for the next
                mechanic.
              </>
            </FirstVisitNotice>
          ) : null}

          <div
            ref={navRef}
            className="sticky -top-4 z-20 -mx-5 border-b border-primary/10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/88 sm:-top-5 sm:-mx-6 lg:hidden"
          >
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-card/95 to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-card/95 to-transparent" />
            <div
              ref={scrollStripRef}
              className="tab-strip-scroll overflow-x-auto px-5 pb-0.5 pt-3 select-none sm:px-6"
              style={{
                scrollbarWidth: "none",
                msOverflowStyle: "none",
                WebkitOverflowScrolling: "touch",
                cursor: "grab",
              }}
            >
              <style>{`
                .tab-strip-scroll::-webkit-scrollbar { display: none; }
              `}</style>
              <div className="flex min-w-max gap-5 px-1">
                {SECTION_TABS.map((tab) => {
                  const isActive = activeSection === tab.id;
                  const isRequired =
                    tab.requiredWhen === "always" ||
                    (tab.requiredWhen === "brake-work" && serviceFlags.hasBrakeWork) ||
                    (tab.requiredWhen === "oil-change" && serviceFlags.hasOilChange);
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      data-tab-id={tab.id}
                      onClick={() => scrollToSection(tab.id)}
                      className={cn(
                        "relative flex shrink-0 items-center gap-1.5 border-b-2 px-0 py-3 text-[13px] font-semibold transition-colors",
                        isActive
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {tab.label}
                      {isRequired ? (
                        <span className="text-destructive" aria-label="required">
                          *
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="divide-y divide-primary/10">
            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current.mileage = element;
              }}
              sectionId="prejob-section-mileage"
              eyebrow="Mileage"
              badge="Required"
              accent="required"
            >
              <FieldRow
                label={
                  <FieldLabelWithSource
                    text="Odometer reading"
                    required
                    source={passportData?.sources.mileage}
                    showSource={hasPrefilledNumber(passportData?.passport.mileage)}
                  />
                }
              >
                <input
                  value={mileage ? Number(mileage).toLocaleString("en-US") : ""}
                  onChange={(event) => setMileage(keepDigitsOnly(event.target.value))}
                  inputMode="numeric"
                  placeholder="Enter mileage"
                  className={narrowField(mileageError)}
                />
              </FieldRow>
            </SectionBlock>

            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current["tire-condition"] = element;
              }}
              sectionId="prejob-section-tire-condition"
              eyebrow="Tire condition"
              badge={passportTireProfileComplete && !tireSectionExpanded ? "On file" : "Required"}
              accent="required"
            >
              {passportTireProfileComplete && !tireSectionExpanded ? (
                <div className="rounded-lg border border-primary/15 bg-muted/40 p-3 text-[12px]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-foreground">Already on file from last service</p>
                        {passportData?.sources["tires.brand"] ? (
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
                              sourceBadgeClassName(passportData.sources["tires.brand"]),
                            )}
                          >
                            {passportSourceLabel(passportData.sources["tires.brand"])}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground">
                        {tireBrand ? `${tireBrand} · ` : ""}
                        {frontTireSize}
                        {rearMatchesFront || !rearTireSize
                          ? ""
                          : ` front / ${rearTireSize} rear`}
                        {isTireCondition(frontCondition) && isTireCondition(rearCondition)
                          ? ` · Front ${tireConditionLabel(frontCondition).toLowerCase()}, rear ${tireConditionLabel(rearCondition).toLowerCase()}`
                          : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTireSectionExpanded(true)}
                      className="shrink-0 rounded-md border border-primary/20 bg-background px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/5"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              ) : (
              <div className="space-y-2">
                <div className="rounded-lg border border-primary/10 bg-muted/40 px-3 py-2.5">
                  <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                    <button
                      type="button"
                      aria-pressed={rearMatchesFront}
                      onClick={() => {
                        const checked = !rearMatchesFront;
                        if (checked) {
                          setRearTireSize(frontTireSize);
                        }
                        setRearMatchesFront(checked);
                      }}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                        rearMatchesFront
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-primary/25 bg-background text-transparent"
                      )}
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </button>
                    <span>Rear size is same as front</span>
                  </label>
                </div>
                <FieldRow
                  label={
                    <FieldLabelWithSource
                      text="Tire size (e.g. 275/45R20)"
                      required
                      source={frontSizeSource}
                      showSource={hasPrefilledText(passportData?.passport.tires.size_front)}
                      includeVerified
                    />
                  }
                >
                  <TireSizeInput
                    value={frontTireSize}
                    onChange={setFrontTireSize}
                    className="sm:w-[160px]"
                  />
                </FieldRow>
                {!rearMatchesFront ? (
                  <FieldRow
                    label={
                      <FieldLabelWithSource
                        text="Rear tire size (e.g. 275/45R20)"
                        required
                        source={rearSizeSource}
                        showSource={hasPrefilledText(passportData?.passport.tires.size_rear)}
                        includeVerified
                      />
                    }
                  >
                    <TireSizeInput
                      value={rearTireSize}
                      onChange={setRearTireSize}
                      className="sm:w-[160px]"
                    />
                  </FieldRow>
                ) : null}
                <TireConditionRow
                  label={<RequiredLabel text="Front" />}
                  value={frontCondition}
                  onChange={setFrontCondition}
                />
                <TireConditionRow
                  label={<RequiredLabel text="Rear" />}
                  value={rearCondition}
                  onChange={setRearCondition}
                />
                <div className="pt-2">
                  <div className="mb-2 flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-medium text-foreground">
                        <RequiredLabel text="Tread depth" />
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Record the shallowest groove on each tire, in 32nds.
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {TIRE_POSITIONS.map((position) => (
                      <TreadMeasurementCard
                        key={position}
                        label={POSITION_LABELS[position]}
                        value={treadInputs[position]}
                        onMinimumChange={(value) =>
                          updateTreadInput(position, "minimum", value)
                        }
                        onDetailChange={(field, value) =>
                          updateTreadInput(position, field, value)
                        }
                        onToggleDetails={() => toggleDetailedTread(position)}
                      />
                    ))}
                  </div>
                </div>
                <div className="w-full sm:max-w-[260px] sm:self-end">
                  <SelectableFieldCard
                    label={
                      <FieldLabelWithSource
                        text="Tire brand"
                        required
                        source={passportData?.sources["tires.brand"]}
                        showSource={hasPrefilledText(passportData?.passport.tires.brand)}
                        includeVerified
                      />
                    }
                    value={tireBrand}
                    onChange={setTireBrand}
                    options={TIRE_BRAND_OPTIONS}
                    placeholder="Select brand…"
                    otherPlaceholder="Brand name"
                  />
                </div>
              </div>
              )}
            </SectionBlock>

            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current.brakes = element;
              }}
              sectionId="prejob-section-brakes"
              eyebrow="Brakes"
              badge={serviceFlags.hasBrakeWork ? "Required" : "Optional"}
              accent={serviceFlags.hasBrakeWork ? "required" : "muted"}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {padScope.front ? (
                  <SelectableFieldCard
                    label={
                      serviceFlags.hasBrakeWork ? (
                        <RequiredLabel text="Front pad thickness" />
                      ) : (
                        "Front pad thickness"
                      )
                    }
                    value={frontPadMm}
                    onChange={setFrontPadMm}
                    options={PAD_THICKNESS_OPTIONS}
                    placeholder="Select mm…"
                    otherPlaceholder="mm"
                    otherInputMode="decimal"
                    otherSanitize={keepNumericInput}
                    helperText="New ≈ 10–12mm · Replace soon ≤ 4mm · Replace immediately ≤ 3mm"
                  />
                ) : null}
                {padScope.rear ? (
                  <SelectableFieldCard
                    label={
                      serviceFlags.hasBrakeWork ? (
                        <RequiredLabel text="Rear pad thickness" />
                      ) : (
                        "Rear pad thickness"
                      )
                    }
                    value={rearPadMm}
                    onChange={setRearPadMm}
                    options={PAD_THICKNESS_OPTIONS}
                    placeholder="Select mm…"
                    otherPlaceholder="mm"
                    otherInputMode="decimal"
                    otherSanitize={keepNumericInput}
                    helperText="New ≈ 10–12mm · Replace soon ≤ 4mm · Replace immediately ≤ 3mm"
                  />
                ) : null}
              </div>
              {serviceFlags.hasBrakeWork && !(padScope.front && padScope.rear) ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Scoped to this booking — {padScope.front ? "front" : "rear"} axle only.
                </p>
              ) : null}
              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[12px] font-medium text-foreground">
                      {serviceFlags.hasBrakeWork ? (
                        <RequiredLabel text="Rotor thickness" />
                      ) : (
                        "Rotor thickness"
                      )}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      Measure each listed rotor with a brake micrometer.
                    </p>
                  </div>
                  <div
                    className="inline-flex h-8 rounded-md border border-primary/15 bg-background p-0.5"
                    aria-label="Rotor thickness unit"
                  >
                    {(["in", "mm"] as RotorUnit[]).map((unit) => (
                      <button
                        key={unit}
                        type="button"
                        aria-pressed={rotorUnit === unit}
                        onClick={() => changeRotorUnit(unit)}
                        className={cn(
                          "min-w-12 rounded px-2 text-[11px] font-semibold transition-colors",
                          rotorUnit === unit
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {unit === "in" ? "Inches" : "mm"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {rotorPositions.map((position) => (
                    <label
                      key={position}
                      className="rounded-lg border border-primary/10 bg-muted/40 p-3"
                    >
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {POSITION_LABELS[position]}
                      </span>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          aria-label={`${POSITION_LABELS[position]} rotor thickness`}
                          value={rotorInputs[position]}
                          onChange={(event) =>
                            setRotorInputs((current) => ({
                              ...current,
                              [position]: keepNumericInput(event.target.value),
                            }))
                          }
                          inputMode="decimal"
                          placeholder={rotorUnit === "in" ? "1.027" : "26.09"}
                          className={cn(baseField(), "w-full text-right")}
                        />
                        <span className="w-5 text-[11px] text-muted-foreground">
                          {rotorUnit}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <FieldRow
                label={
                  serviceFlags.hasBrakeWork ? (
                    <RequiredLabel text="Rotor condition" />
                  ) : (
                    "Rotor condition"
                  )
                }
              >
                <Select
                  selectedKey={rotorCondition || "none"}
                  onSelectionChange={(key) =>
                    setRotorCondition(key === "none" ? "" : (String(key) as RotorCondition))
                  }
                >
                  <SelectTrigger className={cn(selectTriggerClassName, "w-[140px] justify-end")}>
                    <SelectValue>{rotorConditionLabel(rotorCondition)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopover className={selectPopoverClassName}>
                    <SelectListBox shouldFocusWrap className={selectListBoxClassName}>
                      <SelectItem id="none" textValue="Select..." className={selectItemClassName}>
                        Select...
                      </SelectItem>
                      <SelectItem id="good" textValue="Good" className={selectItemClassName}>
                        Good
                      </SelectItem>
                      <SelectItem id="scored" textValue="Scored" className={selectItemClassName}>
                        Scored
                      </SelectItem>
                      <SelectItem
                        id="needs_attention"
                        textValue="Needs attention"
                        className={selectItemClassName}
                      >
                        Needs attention
                      </SelectItem>
                    </SelectListBox>
                  </SelectPopover>
                </Select>
              </FieldRow>
            </SectionBlock>

            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current.fluids = element;
              }}
              sectionId="prejob-section-fluids"
              eyebrow="Fluids"
              badge={serviceFlags.hasOilChange ? "Required" : "Optional"}
              accent={serviceFlags.hasOilChange ? "required" : "muted"}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <SelectableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Oil viscosity"
                      required={serviceFlags.hasOilChange}
                      source={passportData?.sources["fluids.oil_viscosity"]}
                      showSource={hasPrefilledText(passportData?.passport.fluids.oil_viscosity)}
                    />
                  }
                  value={oilViscosity}
                  onChange={setOilViscosity}
                  options={OIL_VISCOSITY_OPTIONS}
                  placeholder="Select grade…"
                  otherPlaceholder="e.g. 25W-60"
                />
                <SelectableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Oil capacity (qts)"
                      source={passportData?.sources["fluids.oil_capacity_qts"]}
                      showSource={hasPrefilledNumber(
                        passportData?.passport.fluids.oil_capacity_qts
                      )}
                    />
                  }
                  value={oilCapacity}
                  onChange={setOilCapacity}
                  options={OIL_CAPACITY_OPTIONS}
                  placeholder="Select capacity…"
                  otherPlaceholder="qts"
                  otherInputMode="decimal"
                  otherSanitize={keepNumericInput}
                />
                <SelectableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Oil type"
                      required={serviceFlags.hasOilChange}
                      source={passportData?.sources["fluids.oil_type"]}
                      showSource={hasPrefilledText(passportData?.passport.fluids.oil_type)}
                    />
                  }
                  value={oilType}
                  onChange={setOilType}
                  options={OIL_TYPE_OPTIONS}
                  placeholder="Select oil type…"
                  otherPlaceholder="Oil type"
                />
                <SelectableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Coolant type"
                      source={passportData?.sources["fluids.coolant_type"]}
                      showSource={hasPrefilledText(passportData?.passport.fluids.coolant_type)}
                    />
                  }
                  value={coolantType}
                  onChange={setCoolantType}
                  options={COOLANT_TYPE_OPTIONS}
                  placeholder="Select coolant chemistry…"
                  otherPlaceholder="Coolant type"
                  helperText="Match to chemistry family, not color — mixing chemistries can sludge the system."
                />
                <SelectableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Brake fluid type"
                      source={passportData?.sources["fluids.brake_fluid_type"]}
                      showSource={hasPrefilledText(
                        passportData?.passport.fluids.brake_fluid_type
                      )}
                    />
                  }
                  value={brakeFluidType}
                  onChange={setBrakeFluidType}
                  options={BRAKE_FLUID_OPTIONS}
                  placeholder="Select DOT spec…"
                  otherPlaceholder="Brake fluid type"
                />
                <SelectableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Transmission fluid type"
                      source={passportData?.sources["fluids.transmission_fluid_type"]}
                      showSource={hasPrefilledText(
                        passportData?.passport.fluids.transmission_fluid_type
                      )}
                    />
                  }
                  value={transmissionFluidType}
                  onChange={setTransmissionFluidType}
                  options={TRANSMISSION_FLUID_OPTIONS}
                  placeholder="Select ATF spec…"
                  otherPlaceholder="Transmission fluid type"
                />
              </div>
            </SectionBlock>

            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current.filters = element;
              }}
              sectionId="prejob-section-filters"
              eyebrow="Filters"
              badge="Optional"
              accent="muted"
            >
              <div className="rounded-lg border border-primary/10 bg-muted/30 px-3 py-2">
                <FieldRow label="Engine air filter">
                  <FilterStatusSelect
                    value={engineAirFilterStatus}
                    onChange={setEngineAirFilterStatus}
                  />
                </FieldRow>
                <FieldRow label="Cabin air filter">
                  <FilterStatusSelect
                    value={cabinAirFilterStatus}
                    onChange={setCabinAirFilterStatus}
                  />
                </FieldRow>
              </div>
            </SectionBlock>

            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current.inspection = element;
              }}
              sectionId="prejob-section-inspection"
              eyebrow="Inspection"
              badge="Optional"
              accent="muted"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[12px] text-muted-foreground">Sticker looks current?</span>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    {
                      value: "yes",
                      label: "Looks current",
                      active: "border-success/40 bg-success/10 text-success",
                    },
                    {
                      value: "no",
                      label: "No / not visible",
                      active: "border-primary/40 bg-primary/10 text-primary",
                    },
                  ].map((option) => {
                    const active = inspectionLooksCurrent === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() =>
                          setInspectionLooksCurrent(option.value as "yes" | "no")
                        }
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                          active
                            ? option.active
                            : "border-primary/10 bg-muted/60 text-muted-foreground hover:bg-muted"
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-3">
                <FieldRow label="Expires approx.">
                  <input
                    type="month"
                    value={inspectionExpiresAt}
                    onChange={(event) => setInspectionExpiresAt(event.target.value)}
                    className={cn(baseField(), "w-[150px] text-right")}
                  />
                </FieldRow>
              </div>
            </SectionBlock>

            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current.modifications = element;
              }}
              sectionId="prejob-section-modifications"
              eyebrow="Modifications"
              badge="Optional"
              accent="muted"
            >
              <FieldRow label="Any aftermarket parts?">
                <Select
                  selectedKey={modificationsStatus || "none"}
                  onSelectionChange={(key) =>
                    setModificationsStatus(
                      key === "none"
                        ? ""
                        : (String(key) as "" | "none_observed" | "aftermarket_observed")
                    )
                  }
                >
                  <SelectTrigger className={cn(selectTriggerClassName, "w-[160px] justify-end")}>
                    <SelectValue>{modificationStatusLabel(modificationsStatus)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopover className={selectPopoverClassName}>
                    <SelectListBox shouldFocusWrap className={selectListBoxClassName}>
                      <SelectItem id="none" textValue="Select..." className={selectItemClassName}>
                        Select...
                      </SelectItem>
                      <SelectItem
                        id="none_observed"
                        textValue="None observed"
                        className={selectItemClassName}
                      >
                        None observed
                      </SelectItem>
                      <SelectItem
                        id="aftermarket_observed"
                        textValue="Yes - see notes"
                        className={selectItemClassName}
                      >
                        Yes - see notes
                      </SelectItem>
                    </SelectListBox>
                  </SelectPopover>
                </Select>
              </FieldRow>
              {modificationsStatus === "aftermarket_observed" ? (
                <textarea
                  value={modificationNotes}
                  onChange={(event) => setModificationNotes(event.target.value)}
                  placeholder="Describe what you observed."
                  className={cn(
                    baseField(),
                    "mt-3 min-h-[80px] w-full resize-y py-2 text-left"
                  )}
                />
              ) : null}
            </SectionBlock>

            <SectionBlock
              sectionRef={(element) => {
                sectionRefs.current.review = element;
              }}
              sectionId="prejob-section-review"
              eyebrow="Review"
              badge="Optional"
              accent="muted"
            >
              <label className="flex items-start gap-2 text-[12px] text-foreground">
                <button
                  type="button"
                  aria-pressed={flaggedVehicleSpecs}
                  onClick={() => setFlaggedVehicleSpecs((current) => !current)}
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                    flaggedVehicleSpecs
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-primary/25 bg-background text-transparent"
                  )}
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </button>
                <span>Something looks wrong with this vehicle&apos;s specs</span>
              </label>
              <textarea
                value={nextMechanicTip}
                onChange={(event) => setNextMechanicTip(event.target.value)}
                rows={2}
                placeholder="e.g., Drain plug stripped - use oversized gasket"
                className={cn(baseField(), "mt-3 min-h-[64px] w-full resize-y py-2 text-left")}
              />
            </SectionBlock>
          </div>
        </div>
        </div>
      </SurveyDialogShell>

      <ConfirmationDialog
        open={showDiscardConfirm}
        title="Discard your changes?"
        onClose={() => setShowDiscardConfirm(false)}
        zIndexClassName="z-[80]"
        secondaryAction={{
          label: "Keep editing",
          onAction: () => setShowDiscardConfirm(false),
          variant: "outline",
        }}
        primaryAction={{
          label: "Discard",
          onAction: () => {
            setShowDiscardConfirm(false);
            onClose();
          },
          variant: "destructive",
        }}
      />
    </>
  );
}

const selectTriggerClassName =
  "bg-white h-8 rounded-md border-primary/15 px-2.5 text-[12px] text-foreground";
const selectPopoverClassName = "rounded-md";
const selectListBoxClassName = "p-1 text-[12px]";
const selectItemClassName = "min-h-0 rounded-sm px-2.5 py-1.5 text-[12px]";

function VehicleSummaryCard({
  label,
  subLabel,
  specLabel,
}: {
  label: string;
  subLabel: string;
  specLabel?: string | null;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-[12px] font-semibold text-primary-foreground">
        {getInitials(label)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-foreground">{label}</p>
        {specLabel ? (
          <p className="mt-0.5 truncate text-[11px] font-medium text-foreground/80">
            {specLabel}
          </p>
        ) : null}
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{subLabel}</p>
      </div>
    </div>
  );
}

type RecOutcome = "completed" | "dismissed";
type PriorRecommendation = {
  _id: string;
  service_name: string;
  urgency: string;
  reason?: string | null;
};
const URGENCY_LABELS: Record<string, string> = {
  soon: "Soon",
  within_3_months: "Within 3 months",
  next_visit: "Next visit",
};

/**
 * Surfaces open recommendations carried over from the last visit for this VIN
 * (same shop). Mechanic taps "Did it" or "Skip" per row; on Save we batch the
 * outcomes to confirmFromPreJob.
 */
function PriorRecommendationsCard({
  bookingId,
  vin,
}: {
  bookingId: string;
  vin: string;
}) {
  const recs = useQuery(api.jobRecommendations.getOpenForVehicle, {
    vin,
    limit: 10,
  });
  const confirm = useMutation(
    api.jobRecommendations.confirmFromPreJob,
  ) as unknown as (args: {
    bookingId: string;
    confirmations: Array<{
      recommendation_id: string;
      outcome: RecOutcome;
    }>;
  }) => Promise<unknown>;

  const [resolved, setResolved] = useState<Record<string, RecOutcome>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  if (recs === undefined) {
    return (
      <section className="rounded-lg border border-primary/15 bg-card p-3.5">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading prior recommendations…
        </div>
      </section>
    );
  }
  if (recs.length === 0) return null;

  async function pick(recId: string, outcome: RecOutcome) {
    setBusyId(recId);
    try {
      await confirm({
        bookingId,
        confirmations: [{ recommendation_id: recId, outcome }],
      });
      setResolved((prev) => ({ ...prev, [recId]: outcome }));
    } catch {
      // Surface inline; the form-level error banner doesn't own this row.
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-lg border border-primary/15 bg-card p-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-foreground">
          Last visit&apos;s recommendations
        </h3>
        <span className="text-[11px] text-muted-foreground">
          Confirm or skip
        </span>
      </div>
      <ul className="space-y-2">
        {(recs as PriorRecommendation[]).map((rec) => {
          const outcome = resolved[rec._id];
          const isBusy = busyId === rec._id;
          return (
            <li
              key={rec._id}
              className={cn(
                "flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5",
                outcome === "completed"
                  ? "border-success/30 bg-success/5"
                  : outcome === "dismissed"
                    ? "border-primary/10 bg-muted/30 opacity-70"
                    : "border-primary/15 bg-background",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">
                  {rec.service_name}
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    {URGENCY_LABELS[rec.urgency] ?? rec.urgency}
                  </span>
                </p>
                {rec.reason ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {rec.reason}
                  </p>
                ) : null}
              </div>
              {outcome ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  {outcome === "completed" ? (
                    <>
                      <Check className="h-3 w-3" /> Done
                    </>
                  ) : (
                    "Skipped"
                  )}
                </span>
              ) : (
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void pick(rec._id, "completed")}
                    className={cn(
                      drawerPrimaryButtonClassName,
                      "h-7 rounded-md px-2.5 text-[11px]",
                    )}
                  >
                    {isBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Did it"
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void pick(rec._id, "dismissed")}
                    className={cn(
                      drawerSecondaryButtonClassName,
                      "h-7 rounded-md px-2.5 text-[11px]",
                    )}
                  >
                    Skip
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SectionBlock({
  sectionId,
  sectionRef,
  eyebrow,
  badge,
  accent = "muted",
  children,
}: {
  sectionId?: string;
  sectionRef?: (element: HTMLElement | null) => void;
  eyebrow: string;
  badge?: string;
  accent?: "required" | "muted";
  children: ReactNode;
}) {
  const badgeClassName =
    accent === "required"
      ? "border-primary/25 bg-primary/10 text-primary"
      : "border border-border bg-card text-muted-foreground";

  return (
    <section
      id={sectionId}
      ref={sectionRef}
      className="scroll-mt-24 py-4 first:pt-0 last:pb-0"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
          {eyebrow}
        </p>
        {badge ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
              badgeClassName
            )}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-1.5 text-[12px] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

function FilterStatusSelect({
  value,
  onChange,
}: {
  value: FilterStatus;
  onChange: (next: FilterStatus) => void;
}) {
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => {
        const next = String(key);
        if (isFilterStatus(next)) {
          onChange(next);
        }
      }}
    >
      <SelectTrigger className={cn(selectTriggerClassName, "w-[180px] justify-end")}>
        <SelectValue>{filterStatusLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopover className={selectPopoverClassName}>
        <SelectListBox shouldFocusWrap className={selectListBoxClassName}>
          {FILTER_STATUSES.map((status) => (
            <SelectItem
              key={status}
              id={status}
              textValue={filterStatusLabel(status)}
              className={selectItemClassName}
            >
              {filterStatusLabel(status)}
            </SelectItem>
          ))}
        </SelectListBox>
      </SelectPopover>
    </Select>
  );
}

function TreadMeasurementCard({
  label,
  value,
  onMinimumChange,
  onDetailChange,
  onToggleDetails,
}: {
  label: string;
  value: TreadInputState[TirePosition];
  onMinimumChange: (value: string) => void;
  onDetailChange: (
    field: "inner" | "center" | "outer",
    value: string,
  ) => void;
  onToggleDetails: () => void;
}) {
  return (
    <div className="rounded-lg border border-primary/10 bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-foreground">
          {label}
        </span>
        <div className="flex items-center gap-1.5">
          <input
            aria-label={`${label} shallowest tread depth`}
            value={value.minimum}
            onChange={(event) => onMinimumChange(event.target.value)}
            inputMode="numeric"
            readOnly={value.detailed}
            placeholder="--"
            className={cn(
              baseField(),
              "w-14 text-right font-semibold",
              value.detailed ? "bg-muted text-muted-foreground" : null,
            )}
          />
          <span className="text-[11px] text-muted-foreground">/32&quot;</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleDetails}
        className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:text-primary/80"
      >
        {value.detailed ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
        {value.detailed ? "Use shallowest only" : "Add inner, center, outer"}
      </button>
      {value.detailed ? (
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(["inner", "center", "outer"] as const).map((field) => (
            <label key={field} className="space-y-1">
              <span className="block text-[9px] font-medium capitalize text-muted-foreground">
                {field}
              </span>
              <input
                aria-label={`${label} ${field} tread depth`}
                value={value[field]}
                onChange={(event) => onDetailChange(field, event.target.value)}
                inputMode="numeric"
                placeholder="--"
                className={cn(baseField(), "w-full text-right")}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TireConditionRow({
  label,
  value,
  onChange,
}: {
  label: ReactNode;
  value: TireCondition | null;
  onChange: (next: TireCondition) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-14 shrink-0 text-[12px] font-medium text-muted-foreground">
        {label}
      </span>
      <ConditionButtons value={value} onChange={onChange} />
    </div>
  );
}

function RequiredLabel({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-destructive">*</span>
      <span>{text}</span>
    </span>
  );
}

function FieldLabelWithSource({
  text,
  required = false,
  source,
  showSource = false,
  includeVerified = false,
}: {
  text: string;
  required?: boolean;
  source?: PassportSource;
  showSource?: boolean;
  /** When true, the "Verified" pill renders inline as well (default `SourceBadge`
   *  hides it). Used in the pre-job tire section so mechanics can see at a
   *  glance that the value already came from a previous job. */
  includeVerified?: boolean;
}) {
  const renderVerifiedPill =
    includeVerified && showSource && source === "verified";
  const renderStandardBadge =
    showSource && shouldRenderSourceBadge(source) && source !== "verified";
  return (
    <span className="inline-flex items-center gap-1.5">
      {required ? <span className="text-destructive">*</span> : null}
      <span>{text}</span>
      {renderStandardBadge ? <SourceBadge source={source!} /> : null}
      {renderVerifiedPill ? (
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
            sourceBadgeClassName(source),
          )}
        >
          {passportSourceLabel(source)}
        </span>
      ) : null}
    </span>
  );
}

function EditableFieldCard({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <div className="rounded-lg border border-primary/10 bg-muted/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className={cn(baseField(), "w-full text-left")}
      />
    </div>
  );
}

const OTHER_OPTION_ID = "__other__";

function SelectableFieldCard({
  label,
  value,
  onChange,
  options,
  placeholder = "Select...",
  otherPlaceholder = "Enter value",
  otherInputMode,
  otherSanitize,
  helperText,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  otherPlaceholder?: string;
  otherInputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
  otherSanitize?: (raw: string) => string;
  helperText?: ReactNode;
}) {
  const matched = resolveOption(value, options);
  const isOther = !!value && !matched;
  const selectedKey = matched ? matched.value : isOther ? OTHER_OPTION_ID : "none";
  const triggerLabel = matched ? matched.label : isOther ? "Other…" : placeholder;
  const showSearch = options.length > 5;
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) => {
        const haystack = [option.label, option.value, ...(option.aliases ?? [])];
        return haystack.some((h) => h.toLowerCase().includes(normalizedQuery));
      })
    : options;
  const otherMatchesQuery = !normalizedQuery || "other".includes(normalizedQuery);
  return (
    <div className="rounded-lg border border-primary/10 bg-muted/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      </div>
      <Select
        selectedKey={selectedKey}
        onSelectionChange={(key) => {
          const k = String(key);
          if (k === "none") {
            onChange("");
          } else if (k === OTHER_OPTION_ID) {
            if (matched) onChange("");
          } else {
            onChange(k);
          }
          setQuery("");
        }}
      >
        <SelectTrigger className={cn(selectTriggerClassName, "w-full justify-between")}>
          <SelectValue>{triggerLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopover className={selectPopoverClassName}>
          {showSearch ? (
            <div
              className="border-b border-primary/10 p-1.5"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Let printable keys edit the input; stop them bubbling into the listbox's typeahead.
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== "Escape") {
                    e.stopPropagation();
                  }
                }}
                placeholder="Search…"
                className={cn(baseField(), "w-full text-left")}
              />
            </div>
          ) : null}
          <SelectListBox shouldFocusWrap className={cn(selectListBoxClassName, "max-h-64 overflow-y-auto")}>
            <SelectItem id="none" textValue={placeholder} className={selectItemClassName}>
              <span className="text-muted-foreground">{placeholder}</span>
            </SelectItem>
            {filteredOptions.map((option) => (
              <SelectItem
                key={option.value}
                id={option.value}
                textValue={option.label}
                className={selectItemClassName}
              >
                {option.label}
              </SelectItem>
            ))}
            {otherMatchesQuery ? (
              <SelectItem id={OTHER_OPTION_ID} textValue="Other…" className={selectItemClassName}>
                Other…
              </SelectItem>
            ) : null}
            {filteredOptions.length === 0 && !otherMatchesQuery ? (
              <SelectItem id="__no_results__" isDisabled textValue="No matches" className={cn(selectItemClassName, "text-muted-foreground")}>
                No matches
              </SelectItem>
            ) : null}
          </SelectListBox>
        </SelectPopover>
      </Select>
      {isOther ? (
        <input
          value={value}
          onChange={(event) => {
            const next = otherSanitize ? otherSanitize(event.target.value) : event.target.value;
            onChange(next);
          }}
          placeholder={otherPlaceholder}
          inputMode={otherInputMode}
          className={cn(baseField(), "mt-2 w-full text-left")}
        />
      ) : null}
      {helperText ? (
        <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground/80">{helperText}</p>
      ) : null}
    </div>
  );
}

function baseField() {
  return "h-8 rounded-md border border-primary/15 bg-background px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-all focus:border-primary/40 focus:ring-2 focus:ring-primary/15";
}

function narrowField(isError?: boolean) {
  return cn(
    baseField(),
    "w-[140px] text-right",
    isError ? "border-destructive/50 focus:border-destructive/60 focus:ring-destructive/20" : null
  );
}
