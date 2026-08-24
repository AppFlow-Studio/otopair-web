"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowLeftRight,
  Ban,
  Camera,
  Car,
  Check,
  ChevronRight,
  Copy,
  Info,
  Loader2,
  Lock,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  CalendarClock,
  Gauge,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import { useApprovalWorkflow, type ApprovalWorkflow } from "@/lib/use-approval-workflow";
import { computeBookingTax } from "@/lib/tax";
import { computePlatformFeeDollars } from "@/lib/platformFee";
import {
  formatHoursValue,
  hoursToMinutes,
  minutesToHours,
  parseHoursInput,
} from "@/lib/labor-units";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import ScheduleSlotPicker from "@/components/booking/schedule-slot-picker";
import ServiceOptionsPicker from "@/components/booking/service-options-picker";
import TireSpecPicker from "@/components/booking/tire-spec-picker";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FluidCatalogSelectField,
  FLUID_KIND_BY_KEY,
} from "@/components/fluid-catalog-select-field";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import {
  getVehicleUpdatePrompts,
  passportSourceLabel,
  serviceLikelyUsesParts,
  sumJobActualParts,
  formatPartIdentity,
  type JobActualPartPayload,
  type JobRecommendationInput,
  type PartsAccuracyStatus,
  type PostjobPhotoInput,
  type PostJobSurveyPayload,
  type CustomJobOutcome,
  type RecommendationUrgency,
  type TimeVariance,
  type TimeVarianceReason,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import type { Id } from "@/convex/_generated/dataModel";
import ServiceSuggestions from "@/components/booking/service-suggestions";
import { cn } from "@/lib/utils";
import { formatFixedCentCurrency } from "@/lib/fixed-cent-currency";
import {
  BRAKE_PAD_BRAND_OPTIONS,
  TIRE_BRAND_OPTIONS,
  TIRE_MODEL_OPTIONS,
  TIRE_SIZE_OPTIONS,
} from "@/lib/inspection-options";
import FixedCentCurrencyInput from "@/components/ui/fixed-cent-currency-input";
import { LIGHT_LABELS } from "@/lib/warningLightItems";
import {
  CustomJobTaxonomyPicker,
  isCustomJobTaxonomyComplete,
} from "@/components/custom-job-taxonomy-picker";
import KnownNameSuggestions from "@/components/booking/known-name-suggestions";
import ServicePickerModal from "@/components/booking/service-picker-modal";
import { describeCustomJobTaxonomy } from "@/lib/custom-job-taxonomy";
import { isTireReplacementService } from "@/lib/vehicle-service-relevance";
import TirePartsEditor, {
  type TireLine,
  isTirePartRow,
  tireLinesFromParts,
  tireLinesFromPrejob,
  tireLinesToPartPayloads,
} from "@/components/booking/tire-parts-editor";

/** Best-effort axle from a part name ("Front Brake Pads" → "front"). Mirrors
 *  convex/lib/brakeScope.partNameAxle; kept inline so the client bundle
 *  doesn't import the Convex module. Null for neutral/ambiguous names. */
function partNameAxleClient(name: string | null | undefined): "front" | "rear" | null {
  if (!name) return null;
  const n = name.toLowerCase();
  const hasFront = /\bfront\b/.test(n);
  const hasRear = /\brear\b/.test(n);
  if (hasFront && !hasRear) return "front";
  if (hasRear && !hasFront) return "rear";
  return null;
}

type OemRecommendationPart = {
  oem_part_number: string;
  part_name: string;
  brand?: string | null;
  part_tier?: string | null;
  category?: string | null;
  quantity_needed?: number | null;
  position?: string | null;
  average_price?: number;
  median_price?: number;
  price_sample_size?: number;
  price_sources_used?: number;
};

type OemRecommendation = {
  service_slug: string;
  service_name: string;
  parts: OemRecommendationPart[];
};

/** The locked, customer-approved quote breakdown shown read-only on the
 *  post-job confirmation so the mechanic sees how parts roll up to the agreed
 *  total. All values in cents. */
type LockedQuote = {
  partsCents: number;
  laborCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  /** The pre-adjustment quote total (cents). Set only when the mechanic's
   *  adjustment changed the price, so the confirmation can show original →
   *  new. Null when the quote was never adjusted. */
  originalTotalCents?: number | null;
  /** Whether partsCents/laborCents/taxCents/feeCents reconcile to totalCents.
   *  False in the robust fallback where only the agreed TOTAL is known (the
   *  per-line breakdown isn't available) — callers hide the per-line rows. */
  hasBreakdown?: boolean;
};

type PriorOpenRecommendation = {
  _id: string;
  service_name: string;
  is_freeform: boolean;
  urgency: RecommendationUrgency;
  reason: string | null;
  created_at: number;
};

// A recommendation the mechanic already confirmed at pre-job, from this
// same visit's inspection — shown read-only, since it's already created.
type ConfirmedThisVisitRecommendation = PriorOpenRecommendation;

// A candidate the mechanic saw on the pre-job "Suggested follow-ups" screen
// but didn't check — offered again here as a second chance. Mirrors
// ResolvedSuggestion in multi-point-inspection-dialog.tsx.
type SuggestedFromInspection = {
  key: string;
  label: string;
  urgency: RecommendationUrgency;
  reasons: string[];
  serviceId: string | null;
  serviceName: string | null;
};

type PostJobPrefillData = {
  vehicleLabel: string;
  serviceName: string;
  serviceSlug: string;
  serviceId?: string | null;
  suggestedParts: JobActualPartPayload[];
  // Optional engine/trim context used by the parts step's sticky vehicle bar.
  // Server-side getPrefillData already returns engineCode; the others are
  // forward-compatible if/when we choose to surface them.
  engineCode?: string | null;
  engineId?: string | null;
  chassisLabel?: string | null;
  trimLabel?: string | null;
  oemRecommendations?: OemRecommendation[];
  priorOpenRecommendations?: PriorOpenRecommendation[];
  confirmedThisVisit?: ConfirmedThisVisitRecommendation[];
  suggestedFromInspection?: SuggestedFromInspection[];
  /** Canonical warning-light codes currently on file for this vehicle, any
   *  source. Offered as a "still on?" clear list — see "Dashboard warning
   *  lights." */
  currentWarningLights?: string[];
  // Prejob inspection tire findings (per axle) — seeds the custom tire editor
  // when tire replacement is added mid-job. From getPrefillData.prejobTires.
  prejobTires?: {
    tire_size_front?: string | null;
    tire_size_rear?: string | null;
    front?: { brand?: string | null; model?: string | null } | null;
    rear?: { brand?: string | null; model?: string | null } | null;
  } | null;
} | null;

type RecRowState = {
  id: string;
  recommended_service_id: string | null;
  service_label: string;
  service_slug: string | null;
  service_has_options: boolean;
  freeform_service_name: string;
  urgency: RecommendationUrgency;
  reason: string;
  visible_to_driver: boolean;
  target_mileage: string;
  scheduled_at: number | null;
  scheduled_mechanic_id: string | null;
  scheduled_mechanic_name: string | null;
  selected_service_option: {
    option_id: string;
    option_label: string;
    option_type?: string;
  } | null;
  tire_specs: {
    size: string;
    type: string;
    tier: string;
    quantity: number;
    positions?: Array<"FL" | "FR" | "RL" | "RR">;
  } | null;
};

function makeRecId() {
  return `rec_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

const URGENCY_CHOICES: { value: RecommendationUrgency; label: string }[] = [
  { value: "soon", label: "Soon" },
  { value: "within_3_months", label: "Within 3 months" },
  { value: "next_visit", label: "Next visit" },
];

function urgencyLabel(value: RecommendationUrgency) {
  return URGENCY_CHOICES.find((c) => c.value === value)?.label ?? value;
}

type PartRowState = {
  part_name: string;
  brand: string;
  oem_number: string;
  cost: string;
  quantity: number;
  supplied_by: "shop" | "customer";
  part_tier: string;
  // Optional: which booking service this part belongs to. Stamped by suggestions
  // and by per-service "Add part" buttons so multi-service jobs attribute
  // correctly downstream. Legacy rows leave it unset; snapshot path falls
  // back to booking.service_ids[0].
  service_id?: string | null;
  // Set instead of service_id when the part belongs to an off-catalog line.
  // Carried verbatim from the locked quote through to the submit payload so
  // completion can record it against the custom job it was fitted to — a
  // custom line has no services row for service_id to point at.
  custom_service_name?: string | null;
  // "catalog" = seeded from the Otopair prefill, identity fields locked.
  // "manual" = mechanic-added row, fully editable. Absent on legacy rows
  // (treated as "manual" so we never accidentally lock a user-typed row).
  source?: "catalog" | "manual";
  // Set by the Swap modal — the OEM number we swapped FROM. Feeds the
  // audit log (single "swap" event instead of paired remove+add) and the
  // preference loop (vote against the prior part for this car/service).
  swap_from_oem_number?: string;
  // Toggled by the new "Not used" affordance. Different from Remove (deletes
  // the row) and Customer-supplied (driver brought it). Excludes the price
  // from aggregates and counts toward demoting the catalog default.
  not_used?: boolean;
  // Which layer of the cascade put this row in front of the mechanic. Drives
  // the small "Used last time on this car" / "Shop default" badge. Stamped
  // by the server in getPrefillData.
  learned_from?: "vin" | "shop" | "config" | "catalog";
  // Optional free-text note on a "manual" row. Not required; when present it's
  // kept in the payment audit trail.
  justification_text?: string;
  // Mechanic-entered tire-replacement line (mid-job / walk-in). When is_tire is
  // set the row is edited through the custom TirePartsEditor (size / brand /
  // model / per-tire price) instead of the generic OEM part fields, and is
  // hidden from the generic parts list. oem_number still carries `TIRE-{size}`.
  is_tire?: boolean;
  tire_size?: string;
  tire_brand?: string;
  tire_model?: string;
  tire_position?: string;
};

export type PhotoState = {
  id: string;
  storageId: string;
  previewUrl: string;
  caption: string;
  status: "uploading" | "ready" | "error";
  /** Capture time (ms). Preserved from the mid-job layover so the report keeps
   *  the real timestamp; absent for photos shot fresh in the post-job. */
  takenAt?: number;
};

type StepKey =
  | "time_check"
  | "time_reason"
  | "mileage"
  | "parts"
  | "labor"
  | "difficulty"
  | "parts_accuracy"
  | "vehicle_updates"
  | "findings"
  | "photos"
  | "tip"
  | "found_work"
  | "custom_outcomes"
  | "recommendations"
  // Gate between the core wrap-up (findings/photos/recommendations) and the
  // optional analytics steps: "Do you have time to answer more questions?".
  | "more_gate"
  | "flag"
  | "summary";

const generateUploadUrlRef = makeFunctionReference<"mutation">(
  "bookings:generatePostjobPhotoUploadUrl"
);

const SLOWER_REASON_CHOICES: { value: TimeVarianceReason; label: string }[] = [
  { value: "vehicle_quirk", label: "Vehicle-specific quirk" },
  { value: "parts_issue", label: "Parts issue" },
  { value: "customer_info_wrong", label: "Customer info was wrong" },
  { value: "unexpected_complication", label: "Unexpected complication" },
  { value: "other", label: "Other" },
];

const FASTER_REASON_CHOICES: { value: TimeVarianceReason; label: string }[] = [
  { value: "easier_than_expected", label: "Simpler than expected" },
  { value: "experienced_with_platform", label: "Familiar with this platform" },
  { value: "customer_info_accurate", label: "Customer info was spot on" },
  { value: "well_prepped", label: "Pre-prepped, no surprises" },
  { value: "other", label: "Other" },
];

type FluidOption = { value: string; label: string; aliases?: string[] };

// Mirrors pre-job-survey-dialog.tsx OIL_VISCOSITY_OPTIONS / OIL_TYPE_OPTIONS / COOLANT_TYPE_OPTIONS / BRAKE_FLUID_OPTIONS / TRANSMISSION_FLUID_OPTIONS exactly.
const OIL_VISCOSITY_DROPDOWN: FluidOption[] = [
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

const OIL_TYPE_DROPDOWN: FluidOption[] = [
  { value: "full_synthetic", label: "Full synthetic", aliases: ["synthetic", "fully synthetic"] },
  { value: "synthetic_blend", label: "Synthetic blend", aliases: ["blend", "semi synthetic", "semi-synthetic"] },
  { value: "conventional", label: "Conventional", aliases: ["mineral"] },
  { value: "high_mileage", label: "High mileage", aliases: ["hm"] },
  { value: "diesel_hd", label: "Diesel (HD)", aliases: ["hdeo", "ck-4", "cj-4", "diesel"] },
];

const COOLANT_TYPE_DROPDOWN: FluidOption[] = [
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

const BRAKE_FLUID_DROPDOWN: FluidOption[] = [
  { value: "dot_3", label: "DOT 3", aliases: ["dot3"] },
  { value: "dot_4", label: "DOT 4", aliases: ["dot4"] },
  { value: "dot_4_lv", label: "DOT 4 LV", aliases: ["dot4lv", "dot 4 low viscosity", "low viscosity dot 4"] },
  { value: "dot_5", label: "DOT 5 (silicone)", aliases: ["dot5", "silicone"] },
  { value: "dot_5_1", label: "DOT 5.1", aliases: ["dot5.1", "dot 5-1", "dot51"] },
];

const TRANSMISSION_FLUID_DROPDOWN: FluidOption[] = [
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

const TIRE_BRAND_DROPDOWN: FluidOption[] = TIRE_BRAND_OPTIONS;

const TIRE_MODEL_DROPDOWN: FluidOption[] = TIRE_MODEL_OPTIONS;

const TIRE_SIZE_DROPDOWN: FluidOption[] = TIRE_SIZE_OPTIONS;
const BRAKE_PAD_BRAND_DROPDOWN: FluidOption[] = BRAKE_PAD_BRAND_OPTIONS;

// keep in sync with pre-job — pre-job does not yet curate oil filter brand, so post-job defines the canonical slugs
const OIL_FILTER_BRAND_DROPDOWN: FluidOption[] = [
  { value: "mobil_1", label: "Mobil 1", aliases: ["mobil1", "mobil-1"] },
  { value: "fram", label: "Fram" },
  { value: "wix", label: "Wix" },
  { value: "k_n", label: "K&N", aliases: ["kn", "k and n"] },
  { value: "bosch", label: "Bosch" },
  { value: "mann", label: "Mann", aliases: ["mann filter", "mann-filter"] },
  { value: "mahle", label: "Mahle" },
  { value: "acdelco", label: "ACDelco", aliases: ["ac delco"] },
  { value: "motorcraft", label: "Motorcraft" },
  { value: "denso", label: "Denso" },
  { value: "purolator", label: "Purolator" },
  { value: "hengst", label: "Hengst" },
  { value: "oem", label: "OEM (vehicle brand)", aliases: ["oe", "factory"] },
];

const FLUID_OPTIONS_BY_KEY: Record<string, FluidOption[]> = {
  oil_viscosity: OIL_VISCOSITY_DROPDOWN,
  oil_type: OIL_TYPE_DROPDOWN,
  coolant_type: COOLANT_TYPE_DROPDOWN,
  brake_fluid_type: BRAKE_FLUID_DROPDOWN,
  transmission_fluid_type: TRANSMISSION_FLUID_DROPDOWN,
  pad_brand: BRAKE_PAD_BRAND_DROPDOWN,
  tire_brand: TIRE_BRAND_DROPDOWN,
  tire_model: TIRE_MODEL_DROPDOWN,
  tire_size_front: TIRE_SIZE_DROPDOWN,
  tire_size_rear: TIRE_SIZE_DROPDOWN,
};

const FLUID_PLACEHOLDERS: Record<string, { placeholder: string; otherPlaceholder: string }> = {
  oil_viscosity: { placeholder: "Select viscosity…", otherPlaceholder: "Oil viscosity" },
  oil_type: { placeholder: "Select oil type…", otherPlaceholder: "Oil type" },
  coolant_type: { placeholder: "Select coolant chemistry…", otherPlaceholder: "Coolant type" },
  brake_fluid_type: { placeholder: "Select DOT spec…", otherPlaceholder: "Brake fluid type" },
  transmission_fluid_type: { placeholder: "Select ATF spec…", otherPlaceholder: "Transmission fluid type" },
  pad_brand: { placeholder: "Select pad brand…", otherPlaceholder: "Pad brand" },
  tire_brand: { placeholder: "Select tire brand…", otherPlaceholder: "Tire brand" },
  tire_model: { placeholder: "Select tire model…", otherPlaceholder: "Tire model" },
  tire_size_front: { placeholder: "Select size (e.g. 225/45R18)…", otherPlaceholder: "Front tire size" },
  tire_size_rear: { placeholder: "Select size (e.g. 225/45R18)…", otherPlaceholder: "Rear tire size" },
};

const OTHER_OPTION_ID = "__other__";

// Post-job additionally routes oil TYPE through the OEM catalog picker (as
// engine-oil products), on top of the four product fluids the shared map
// already covers. Kept local so the pre-job inspection — which deliberately
// keeps oil on its generic grade/type combobox — is unaffected.
const POSTJOB_FLUID_KIND_BY_KEY: Record<string, string> = {
  ...FLUID_KIND_BY_KEY,
  oil_type: "engine_oil",
};

function resolveFluidOption(
  value: string | null | undefined,
  options: FluidOption[]
): FluidOption | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return (
    options.find((opt) => {
      if (opt.value.toLowerCase() === lower) return true;
      if (opt.label.toLowerCase() === lower) return true;
      return (opt.aliases ?? []).some((alias) => alias.toLowerCase() === lower);
    }) ?? null
  );
}

const fluidSelectTrigger =
  "bg-background h-10 rounded-lg border border-primary/15 px-3 text-[13px] text-foreground sm:w-64 w-full justify-between";
const fluidSelectItem = "min-h-0 rounded-sm px-2.5 py-1.5 text-[13px]";
const fluidOtherInput =
  "mt-2 w-full rounded-lg border border-primary/15 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary sm:w-64";

function FluidSelectField({
  value,
  onChange,
  options,
  placeholder,
  otherPlaceholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: FluidOption[];
  placeholder: string;
  otherPlaceholder: string;
}) {
  const matched = resolveFluidOption(value, options);
  const isOther = !!value && !matched;
  const selectedKey = matched
    ? matched.value
    : isOther
      ? OTHER_OPTION_ID
      : "none";
  const triggerLabel = matched
    ? matched.label
    : isOther
      ? "Other…"
      : placeholder;
  const showSearch = options.length > 5;
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions = normalizedQuery
    ? options.filter((option) => {
        const haystack = [
          option.label,
          option.value,
          ...(option.aliases ?? []),
        ];
        return haystack.some((h) =>
          h.toLowerCase().includes(normalizedQuery)
        );
      })
    : options;
  const otherMatchesQuery = !normalizedQuery || "other".includes(normalizedQuery);

  return (
    <div className="w-full sm:w-auto">
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
        <SelectTrigger className={fluidSelectTrigger}>
          <SelectValue>{triggerLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopover className="rounded-md">
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
                  if (
                    e.key !== "ArrowDown" &&
                    e.key !== "ArrowUp" &&
                    e.key !== "Enter" &&
                    e.key !== "Escape"
                  ) {
                    e.stopPropagation();
                  }
                }}
                placeholder="Search…"
                className="h-8 w-full rounded-md border border-primary/15 bg-background px-2.5 text-[12px] outline-none focus:border-primary"
              />
            </div>
          ) : null}
          <SelectListBox
            shouldFocusWrap
            className="max-h-64 overflow-y-auto p-1 text-[13px]"
          >
            <SelectItem
              id="none"
              textValue={placeholder}
              className={fluidSelectItem}
            >
              <span className="text-muted-foreground">{placeholder}</span>
            </SelectItem>
            {filteredOptions.map((option) => (
              <SelectItem
                key={option.value}
                id={option.value}
                textValue={option.label}
                className={fluidSelectItem}
              >
                {option.label}
              </SelectItem>
            ))}
            {otherMatchesQuery ? (
              <SelectItem
                id={OTHER_OPTION_ID}
                textValue="Other…"
                className={fluidSelectItem}
              >
                Other…
              </SelectItem>
            ) : null}
            {filteredOptions.length === 0 && !otherMatchesQuery ? (
              <SelectItem
                id="__no_results__"
                isDisabled
                textValue="No matches"
                className={cn(fluidSelectItem, "text-muted-foreground")}
              >
                No matches
              </SelectItem>
            ) : null}
          </SelectListBox>
        </SelectPopover>
      </Select>
      {isOther ? (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={otherPlaceholder}
          className={fluidOtherInput}
        />
      ) : null}
    </div>
  );
}


function parseOilFilterValue(value: string): { brand: string; code: string } {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return { brand: "", code: "" };

  // Try matching against full multi-word brand labels first, longest-first.
  const candidates = [...OIL_FILTER_BRAND_DROPDOWN].sort(
    (a, b) => b.label.length - a.label.length,
  );
  const lower = trimmed.toLowerCase();
  for (const opt of candidates) {
    const tokens = [opt.label, opt.value.replace(/_/g, " "), ...(opt.aliases ?? [])];
    for (const token of tokens) {
      const t = token.toLowerCase();
      if (lower === t) return { brand: opt.value, code: "" };
      if (lower.startsWith(t + " ")) {
        return { brand: opt.value, code: trimmed.slice(t.length).trim() };
      }
    }
  }
  // Unparseable legacy value — keep it in the code field so it remains visible.
  return { brand: "", code: trimmed };
}

function composeOilFilterValue(brand: string, code: string): string {
  const brandLabel = brand
    ? OIL_FILTER_BRAND_DROPDOWN.find((o) => o.value === brand)?.label ?? brand
    : "";
  return [brandLabel, code.trim()].filter(Boolean).join(" ").trim();
}

function OilFilterField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const parsed = parseOilFilterValue(value);
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
      <FluidSelectField
        value={parsed.brand}
        onChange={(nextBrand) =>
          onChange(composeOilFilterValue(nextBrand, parsed.code))
        }
        options={OIL_FILTER_BRAND_DROPDOWN}
        placeholder="Select filter brand…"
        otherPlaceholder="Filter brand"
      />
      <input
        value={parsed.code}
        onChange={(event) =>
          onChange(composeOilFilterValue(parsed.brand, event.target.value))
        }
        placeholder="Part #"
        inputMode="text"
        maxLength={24}
        className="h-10 rounded-lg border border-primary/15 bg-background px-3 text-[13px] outline-none focus:border-primary sm:w-40"
      />
    </div>
  );
}

function buildPartRows(parts: JobActualPartPayload[]): PartRowState[] {
  return parts.map((part) => {
    // Prefer the explicit source if it's been persisted on the row. Fall back
    // to the heuristic: a row carrying both a part name AND an OEM number is
    // almost certainly catalog-derived (prefill, prior snapshot, or a swap).
    // Bare mechanic-typed rows start blank → "manual".
    const resolvedSource: "catalog" | "manual" =
      part.source === "catalog" || part.source === "manual"
        ? part.source
        : part.part_name && part.oem_number
          ? "catalog"
          : "manual";
    return {
      part_name: part.part_name,
      brand: part.brand ?? "",
      oem_number: part.oem_number,
      cost: Number.isFinite(part.cost) ? formatFixedCentCurrency(part.cost) : "0.00",
      quantity:
        typeof part.quantity === "number" && Number.isFinite(part.quantity)
          ? Math.max(1, Math.round(part.quantity))
          : 1,
      supplied_by: part.supplied_by === "customer" ? "customer" : "shop",
      part_tier: part.part_tier ?? "oem",
      service_id: part.service_id ?? null,
      custom_service_name: part.custom_service_name ?? null,
      source: resolvedSource,
      not_used: part.not_used === true ? true : undefined,
      learned_from:
        part.learned_from === "vin" ||
        part.learned_from === "shop" ||
        part.learned_from === "config" ||
        part.learned_from === "catalog"
          ? part.learned_from
          : undefined,
      is_tire:
        part.is_tire === true ||
        (typeof part.oem_number === "string" &&
          part.oem_number.toUpperCase().startsWith("TIRE-"))
          ? true
          : undefined,
      tire_size: part.tire_size ?? undefined,
      tire_brand: part.tire_brand ?? undefined,
      tire_model: part.tire_model ?? undefined,
      tire_position: part.tire_position ?? undefined,
    };
  });
}

/**
 * Parts + labor + tax + fee → cents — the client-side estimate preview.
 * Mirrors server-side computeMechanicSetPrice. Shared by the running-total bar
 * (the mechanic's live edits) AND the quoted baseline (the seeded/quoted
 * parts + labor), so "did the mechanic move the price?" compares like-for-like
 * and can never drift against the server's midpoint-based quoted_set_price.
 */
function computeEstimateTotals(args: {
  parts: PartRowState[];
  hours: number;
  laborRateCents: number;
  shopState: string | null;
  shopZip: string | null;
}): {
  partsCents: number;
  laborCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
} {
  let partsCents = 0;
  for (const p of args.parts) {
    if (p.not_used) continue;
    if (p.supplied_by === "customer") continue;
    const cost = Number(p.cost) || 0;
    const qty = Math.max(1, Math.round(p.quantity || 1));
    partsCents += Math.round(cost * qty * 100);
  }
  const laborCents =
    args.hours > 0 ? Math.round(args.hours * args.laborRateCents) : 0;
  const subtotalCents = partsCents + laborCents;
  const tax = computeBookingTax({
    laborDollars: laborCents / 100,
    partsDollars: partsCents / 100,
    state: args.shopState ?? null,
    zip: args.shopZip ?? null,
  });
  const taxCents = Math.round((tax.taxDollars ?? 0) * 100);
  const feeCents = Math.max(
    0,
    Math.round(computePlatformFeeDollars(subtotalCents / 100) * 100),
  );
  return {
    partsCents,
    laborCents,
    taxCents,
    feeCents,
    totalCents: subtotalCents + taxCents + feeCents,
  };
}

/**
 * Part number rendered as a click-to-copy control. Mechanics read these off to
 * order/look up parts, so make them one-tap copyable instead of hand-typing.
 * Falls back to a plain "—" when there's no number. Copy failures (blocked
 * clipboard / insecure context) degrade silently — the text stays selectable.
 */
function CopyableOemNumber({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const canCopy = value.trim().length > 0;
  if (!canCopy) return <span className={className}>—</span>;
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable — leave the text selectable */
        }
      }}
      title={copied ? "Copied!" : "Copy part number"}
      aria-label={`Copy part number ${value}`}
      className={cn(
        "group inline-flex max-w-full items-center gap-1 text-left font-mono tabular-nums transition-colors hover:text-primary",
        className,
      )}
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-opacity group-hover:text-primary" />
      )}
    </button>
  );
}

function makePhotoId() {
  return `photo_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/**
 * Pre-Job Approval cycle. When `cycle` is set, the dialog's submit path is
 * routed to the corresponding mutation in `booking_approvals.ts` instead
 * of writing job_actuals via the parent's onSubmit. Default (undefined)
 * preserves the legacy post-job completion flow exactly.
 *   - "pre_job"            → submitPreJobEstimate
 *   - "mid_job"            → submitMidJobChange
 *   - "post_job_reapproval" → submitPostJobReapproval (rarely opened from
 *     UI — the action invokes it internally; included for parity)
 */
export type PostJobSurveyCycle = "pre_job" | "mid_job" | "post_job_reapproval";

export default function PostJobSurveyDialog({
  open,
  bookingId,
  bookingLabel,
  bookingSubLabel,
  passportData,
  estimatedLaborMinutes,
  prefillData,
  isSubmitting,
  onClose,
  onSubmit,
  layoverNotes,
  layoverPhotos,
  cycle,
  onApprovalSubmitted,
  laborRateCents,
  laborCostDollars,
  shopState,
  shopZip,
  lockBilling,
  quotedParts,
  lockedQuote,
  isFixedPrice,
}: {
  open: boolean;
  bookingId?: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  passportData: VehiclePassportData | null | undefined;
  estimatedLaborMinutes?: number | null;
  prefillData: PostJobPrefillData;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (
    payload: PostJobSurveyPayload,
    customJobOutcomes?: CustomJobOutcome[],
    resolvedPriorRecommendationIds?: string[],
  ) => Promise<void>;
  /** Notes captured during the mid-job "Active Job Layover" (newline-joined
   *  entries). Shown read-only in the post-job review — never seeded into an
   *  editable field, so the mechanic's "tip" stays their own. */
  layoverNotes?: string;
  /** Photos captured during the mid-job layover. Shown read-only in the review
   *  and merged into the final report photos at submit. */
  layoverPhotos?: PhotoState[];
  cycle?: PostJobSurveyCycle;
  onApprovalSubmitted?: (result: {
    state: string;
    totalCents: number;
    ceilingCents: number;
  }) => void;
  /** Customer agreed to a shop_service_fixed_prices flat rate. Parts/labor
   *  edits are accepted (audit only) but won't move the customer total. */
  isFixedPrice?: boolean;
  /** Shop's labor rate in cents/hour. Drives the running-total bar and the
   *  Labor step for cycle modes. */
  laborRateCents?: number | null;
  /** Booking's stored labor_cost (dollars). Used as a fallback rate hint
   *  when shopLaborRateCents isn't set. */
  laborCostDollars?: number | null;
  /** Shop state + zip for client-side tax preview. Mirrors the server
   *  computeBookingTax signature. */
  shopState?: string | null;
  shopZip?: string | null;
  /** Final post-job submission: parts/labor were locked when the customer
   *  confirmed the quote. Surfaces a banner directing mechanics to back out
   *  and use Add unforeseen scope (mid-job) for any pricing change. Only
   *  honored when `cycle` is undefined (the legacy post-job completion path);
   *  the cycle paths (pre_job/mid_job) are themselves the change-request
   *  flow and must remain editable. */
  lockBilling?: boolean;
  /** Parts actually quoted on this booking (mapped from
   *  `bookings.priced_parts_snapshot`). When the dialog opens in the pre_job
   *  cycle ("Adjust quote"), seed the editable parts list from this rather
   *  than the broader prefill cascade (`prefillData.suggestedParts`) so the
   *  mechanic adjusts the parts ACTUALLY on the quote — not every part the
   *  catalog suggests for this service. */
  quotedParts?: JobActualPartPayload[] | null;
  /** Locked customer-approved quote breakdown (cents). When set alongside
   *  `lockBilling`, the post-job parts step renders read-only and shows the
   *  parts → labor → tax/fee → agreed-total flow instead of editable fields. */
  lockedQuote?: LockedQuote | null;
}) {
  return (
    <PostJobSurveyDialogBody
      key={`${passportData?.vin ?? "no-vin"}-${bookingLabel}-${prefillData?.serviceSlug ?? "no-service"}-${cycle ?? "postjob"}`}
      lockedQuote={lockedQuote ?? null}
      open={open}
      bookingId={bookingId ?? null}
      bookingLabel={bookingLabel}
      bookingSubLabel={bookingSubLabel}
      passportData={passportData ?? null}
      estimatedLaborMinutes={estimatedLaborMinutes ?? null}
      prefillData={prefillData}
      isSubmitting={isSubmitting}
      onClose={onClose}
      onSubmit={onSubmit}
      layoverNotes={layoverNotes ?? ""}
      layoverPhotos={layoverPhotos ?? []}
      cycle={cycle}
      onApprovalSubmitted={onApprovalSubmitted}
      laborRateCents={laborRateCents ?? null}
      laborCostDollars={laborCostDollars ?? null}
      shopState={shopState ?? null}
      shopZip={shopZip ?? null}
      lockBilling={lockBilling ?? false}
      quotedParts={quotedParts ?? null}
      isFixedPrice={isFixedPrice ?? false}
    />
  );
}

function PostJobSurveyDialogBody({
  open,
  bookingId,
  bookingLabel,
  bookingSubLabel,
  passportData,
  estimatedLaborMinutes,
  prefillData,
  isSubmitting,
  onClose,
  onSubmit,
  layoverNotes,
  layoverPhotos,
  cycle,
  onApprovalSubmitted,
  laborRateCents,
  laborCostDollars,
  shopState,
  shopZip,
  lockBilling,
  quotedParts,
  lockedQuote,
  isFixedPrice,
}: {
  open: boolean;
  bookingId: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  passportData: VehiclePassportData | null;
  estimatedLaborMinutes: number | null;
  prefillData: PostJobPrefillData;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (
    payload: PostJobSurveyPayload,
    customJobOutcomes?: CustomJobOutcome[],
    resolvedPriorRecommendationIds?: string[],
  ) => Promise<void>;
  layoverNotes: string;
  layoverPhotos: PhotoState[];
  cycle?: PostJobSurveyCycle;
  onApprovalSubmitted?: (result: {
    state: string;
    totalCents: number;
    ceilingCents: number;
  }) => void;
  laborRateCents: number | null;
  laborCostDollars: number | null;
  shopState: string | null;
  shopZip: string | null;
  lockBilling: boolean;
  quotedParts: JobActualPartPayload[] | null;
  lockedQuote: LockedQuote | null;
  isFixedPrice: boolean;
}) {
  // Phase 2 — Pre-Job Approval mutation handles (only invoked when cycle is set).
  const submitPreJobEstimate = useMutation(
    (api as any).booking_approvals.submitPreJobEstimate,
  );
  const submitMidJobChange = useMutation(
    (api as any).booking_approvals.submitMidJobChange,
  );

  // Live workflow state for the post-submit status panel. Subscribes only
  // when cycle is set — the legacy post-job actuals path doesn't need it.
  const workflow = useApprovalWorkflow({
    bookingId: cycle ? bookingId : null,
    cycle,
  });
  const [submittedForApproval, setSubmittedForApproval] = useState(false);
  // When the mechanic clicks "Revise estimate" on a declined / SLA-expired
  // status panel we drop them back to the form. The booking row is still in a
  // terminal *_declined / sla_expired state, so without this guard the
  // re-entry effect below would immediately re-promote them back to the panel
  // (the button would look dead). Sticks until they resubmit or reopen.
  const manualReviseRef = useRef(false);
  // Reset the revise intent whenever the dialog is (re)opened so a fresh open
  // on a still-declined booking correctly shows the status panel, not the form.
  useEffect(() => {
    if (open) manualReviseRef.current = false;
  }, [open]);
  // Re-entry: if the dialog opens on a booking that already has an in-flight
  // approval for *this* cycle, jump straight to the status panel.
  // A mid-job dialog opened on a booking still at pre_job_approved /
  // in_range is a brand-new cycle, not a re-entry — render the form.
  useEffect(() => {
    if (!cycle) return;
    if (submittedForApproval) return;
    if (manualReviseRef.current) return;
    const state = workflow.state;
    const matchesCycle =
      (cycle === "pre_job" &&
        (state === "pre_job_pending" ||
          state === "pre_job_approved" ||
          state === "pre_job_declined" ||
          state === "in_range")) ||
      (cycle === "mid_job" &&
        (state === "mid_job_pending" ||
          state === "mid_job_approved" ||
          state === "mid_job_declined")) ||
      (cycle === "post_job_reapproval" &&
        (state === "post_job_pending" ||
          state === "post_job_approved" ||
          state === "post_job_declined"));
    // sla_expired is cycle-agnostic on the booking row, so disambiguate via
    // last_cycle from the approval snapshot.
    const slaMatches =
      state === "sla_expired" &&
      ((cycle === "pre_job" &&
        workflow.approvalState?.last_cycle === "pre_job") ||
        (cycle === "mid_job" &&
          workflow.approvalState?.last_cycle === "mid_job") ||
        (cycle === "post_job_reapproval" &&
          workflow.approvalState?.last_cycle === "post_job"));
    if (matchesCycle || slaMatches) {
      setSubmittedForApproval(true);
    }
  }, [
    cycle,
    workflow.state,
    workflow.approvalState?.last_cycle,
    submittedForApproval,
  ]);
  const serviceSlug =
    passportData?.service_slug ?? prefillData?.serviceSlug ?? null;
  const requiresParts = serviceLikelyUsesParts(
    serviceSlug,
    passportData?.requires_parts
  );
  // Tire replacement added mid-job / logged as a walk-in has no quote — the
  // mechanic enters tires directly (size / brand / model / price) through the
  // custom TirePartsEditor instead of the OEM-number parts fields.
  const isTireService = useMemo(() => {
    const names = [
      prefillData?.serviceName,
      passportData?.service_name,
      serviceSlug,
      ...(passportData?.parts_required_services ?? []).map((s) => s.name),
    ].filter(Boolean) as string[];
    return names.some((n) => isTireReplacementService(n));
  }, [
    prefillData?.serviceName,
    passportData?.service_name,
    serviceSlug,
    passportData?.parts_required_services,
  ]);
  // Vehicle OEM tire fitments [front, rear] → size suggestion chips.
  const tireOemSizes = useMemo<string[]>(() => {
    const fromAvailable = passportData?.available_tire_sizes
      ? [
          ...(passportData.available_tire_sizes.front ?? []),
          ...(passportData.available_tire_sizes.rear ?? []),
        ]
      : [];
    const fromPassport = [
      passportData?.passport?.tires?.size_front,
      passportData?.passport?.tires?.size_rear,
    ].filter(Boolean) as string[];
    const fromPrejob = [
      prefillData?.prejobTires?.tire_size_front,
      prefillData?.prejobTires?.tire_size_rear,
    ].filter(Boolean) as string[];
    return Array.from(
      new Set([...fromAvailable, ...fromPassport, ...fromPrejob]),
    );
  }, [
    passportData?.available_tire_sizes,
    passportData?.passport?.tires?.size_front,
    passportData?.passport?.tires?.size_rear,
    prefillData?.prejobTires,
  ]);
  const updatePrompts = useMemo(
    () => (passportData ? getVehicleUpdatePrompts(serviceSlug, passportData) : []),
    [passportData, serviceSlug]
  );

  // Answers
  const [timeVariance, setTimeVariance] = useState<TimeVariance | null>(null);
  const [timeReason, setTimeReason] = useState<TimeVarianceReason | null>(null);
  const [timeReasonNote, setTimeReasonNote] = useState("");
  const [completionMileage, setCompletionMileage] = useState(
    typeof passportData?.passport.mileage === "number"
      ? String(Math.round(passportData.passport.mileage))
      : ""
  );
  // Last odometer reading on file for this VIN. The server rejects a
  // completion mileage below this (odometers don't run backward), so mirror
  // the rule client-side to catch it inline instead of on final submit.
  const baselineMileage =
    typeof passportData?.passport.mileage === "number" &&
    Number.isFinite(passportData.passport.mileage)
      ? Math.round(passportData.passport.mileage)
      : null;
  const [parts, setParts] = useState<PartRowState[]>(() => {
    // Read the parts ACTUALLY quoted on this booking first — the snapshot the
    // customer confirmed — not the catalog's broader suggestions. This is what
    // keeps the list to what was booked (e.g. rear pads only). Falls back to
    // the cascade/catalog prefill when the booking has no priced snapshot
    // (walk-ins, legacy jobs).
    if (quotedParts && quotedParts.length > 0) {
      return buildPartRows(quotedParts);
    }
    return buildPartRows(prefillData?.suggestedParts ?? []);
  });

  // Off-catalog / mid-job "extra work" lines on this booking. Their parts are
  // persisted on custom_jobs.parts (that's how the customer approved them), so
  // this query is the source of truth for what the mechanic attached to each
  // extra job — used both for the outcomes step and to seed those parts into
  // the Parts step below.
  const customJobs = useQuery(
    api.customJobs.listForBooking,
    open && bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  );
  // Tire replacement can arrive as mid-job "found work" (an extra job added via
  // Flag Issue) rather than a booked service, so it won't be in prefillData /
  // parts_required_services. Detect it from the custom-job lines too, otherwise
  // the parts step falls back to the generic OEM editor for a tire line.
  const foundWorkHasTire = useMemo(
    () =>
      (customJobs ?? []).some(
        (j) => j.name && isTireReplacementService(j.name),
      ),
    [customJobs],
  );
  const tireServiceActive = isTireService || foundWorkHasTire;
  // Part rows for anything already saved against an extra-work line. Without
  // this the Parts step only knew each extra job's NAME, so an approved part
  // reappeared as a blank "Add part for X" row after a refresh — the mechanic's
  // own line, gone. Seeding from the persisted custom_jobs makes it survive a
  // reload for free.
  const customJobPartRows = useMemo<PartRowState[]>(() => {
    const rows: PartRowState[] = [];
    for (const job of customJobs ?? []) {
      for (const p of job.parts ?? []) {
        if (!p.part_name || !p.part_name.trim()) continue;
        const qty = p.quantity && p.quantity > 0 ? Math.round(p.quantity) : 1;
        const unitCents =
          p.unit_price_cents != null
            ? p.unit_price_cents
            : p.line_total_cents != null && qty > 0
              ? Math.round(p.line_total_cents / qty)
              : 0;
        rows.push({
          part_name: p.part_name,
          brand: p.brand ?? "",
          oem_number: p.oem_number ?? "",
          // `cost` is a DOLLAR string and formatFixedCentCurrency expects dollars
          // (it multiplies by 100 internally), but unitCents is CENTS — so divide
          // first. Passing cents straight in rendered $4.68 as $468.
          cost: unitCents > 0 ? formatFixedCentCurrency(unitCents / 100) : "0.00",
          quantity: qty,
          supplied_by: "shop",
          part_tier: "oem",
          custom_service_name: job.name,
          source: "manual",
        });
      }
    }
    return rows;
  }, [customJobs]);
  // Reconcile the persisted extra-work parts into a row list. Idempotent, so
  // it's safe to run on every re-seed:
  //   • already present (by OEM #, or by extra-line + part name) → leave it,
  //   • an empty "Add part for X" placeholder the quote seeded for that same
  //     extra line → FILL it (avoids a duplicate blank+filled pair),
  //   • otherwise → append.
  // Returns the SAME array reference when nothing changed so setState bails out
  // instead of churning.
  const applyCustomJobParts = (rows: PartRowState[]): PartRowState[] => {
    if (customJobPartRows.length === 0) return rows;
    const norm = (s?: string | null) => (s ?? "").trim().toLowerCase();
    const next = [...rows];
    const oemSeen = new Set(next.map((r) => norm(r.oem_number)).filter(Boolean));
    let changed = false;
    for (const cj of customJobPartRows) {
      const cjOem = norm(cj.oem_number);
      if (cjOem && oemSeen.has(cjOem)) continue;
      const already = next.some(
        (r) =>
          norm(cj.part_name) !== "" &&
          norm(r.custom_service_name) === norm(cj.custom_service_name) &&
          norm(r.part_name) === norm(cj.part_name),
      );
      if (already) continue;
      const placeholderIdx = next.findIndex(
        (r) =>
          !r.is_tire &&
          norm(r.part_name) === "" &&
          norm(r.custom_service_name) === norm(cj.custom_service_name),
      );
      if (placeholderIdx >= 0) {
        next[placeholderIdx] = { ...next[placeholderIdx], ...cj };
      } else {
        next.push(cj);
      }
      if (cjOem) oemSeen.add(cjOem);
      changed = true;
    }
    return changed ? next : rows;
  };

  // Hard guard: never offer a brake axle the customer didn't book. Even if the
  // prefill (or a stale snapshot) carries an off-axle part, prune it from the
  // initial seed once the booking's scope resolves. Runs once, before any
  // mechanic edits — mechanics add genuinely-extra parts via "Add another
  // part" / "Add unforeseen scope", which this never touches.
  const brakeScope = useQuery(
    api.serviceParts.getBrakeScopeForBooking,
    open && bookingId
      ? ({ bookingId } as { bookingId: Id<"bookings"> })
      : "skip",
  );
  const axlePrunedRef = useRef(false);
  useEffect(() => {
    if (axlePrunedRef.current) return;
    if (!brakeScope) return;
    axlePrunedRef.current = true;
    // In the locked confirmation the seeded rows ARE the agreed quote — leave
    // them exactly as quoted so they reconcile with the breakdown total.
    if (lockBilling && !cycle) return;
    if (!brakeScope.hasBrakeWork) return;
    if (brakeScope.front && brakeScope.rear) return;
    setParts((current) =>
      current.filter((p) => {
        const axle = partNameAxleClient(p.part_name);
        if (axle == null) return true;
        return axle === "front" ? brakeScope.front : brakeScope.rear;
      }),
    );
  }, [brakeScope]);
  // Re-seed the parts list when the dialog actually OPENS. `quotedParts` (the
  // customer-approved snapshot for locked / mid-job flows) resolves a tick after
  // this component first mounts, so the useState initializer above can capture
  // the pre-approval fallback (the booking's original priced snapshot) instead
  // of the agreed prices + Not-used flags. This corrects that:
  //   - Locked review (post-job): no edits to preserve, so mirror the freshest
  //     quote reactively.
  //   - Editable cycles (pre/mid-job): seed once per open so a later quote
  //     refresh can't clobber the mechanic's in-progress edits.
  const readOnlyBillingMode = lockBilling && !cycle;
  const seededPartsForOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededPartsForOpenRef.current = false;
      return;
    }
    if (!quotedParts || quotedParts.length === 0) return;
    if (readOnlyBillingMode) {
      // Re-apply extra-work parts every mirror so a quote refresh can't drop
      // them (they're deduped against the quote, so no double-count).
      setParts(applyCustomJobParts(buildPartRows(quotedParts)));
      return;
    }
    if (seededPartsForOpenRef.current) return;
    seededPartsForOpenRef.current = true;
    setParts(applyCustomJobParts(buildPartRows(quotedParts)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quotedParts, readOnlyBillingMode, lockBilling, cycle]);
  // custom_jobs resolves a tick after mount and can arrive after the quote seed
  // (or with no quote at all, e.g. a walk-in). This union brings the extra-work
  // parts in whenever they load — idempotent, so it neither double-counts the
  // quote nor overwrites edits.
  useEffect(() => {
    if (!open) return;
    if (customJobPartRows.length === 0) return;
    setParts((current) => applyCustomJobParts(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customJobPartRows]);
  // Seed the custom tire editor from the prejob inspection when tire
  // replacement is added mid-job — there's no quote to seed from, so pre-load
  // every axle the inspection recorded a size for. Runs once per open and only
  // when no tire rows already exist (a walk-in's priced snapshot brings its own
  // via quotedParts).
  const seededTiresForOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededTiresForOpenRef.current = false;
      return;
    }
    if (readOnlyBillingMode) return;
    if (!tireServiceActive) return;
    if (seededTiresForOpenRef.current) return;
    const prejobLines = tireLinesFromPrejob(prefillData?.prejobTires);
    if (prejobLines.length === 0) return;
    seededTiresForOpenRef.current = true;
    setParts((current) => {
      if (current.some((p) => p.is_tire)) return current;
      // Attribute to a mid-job "found work" tire line if that's how it was
      // added; otherwise to the booked tire service.
      const tireCustomName =
        (customJobs ?? []).find(
          (j) => j.name && isTireReplacementService(j.name),
        )?.name ?? null;
      const svcId = tireCustomName ? null : prefillData?.serviceId ?? null;
      const payloads = tireLinesToPartPayloads(prejobLines, svcId).map((p) => ({
        ...p,
        service_id: svcId,
        custom_service_name: tireCustomName,
      }));
      return [...current, ...buildPartRows(payloads)];
    });
  }, [
    open,
    readOnlyBillingMode,
    tireServiceActive,
    prefillData?.prejobTires,
    prefillData?.serviceId,
  ]);
  // Scope the catalog's OEM recommendations to the booked axle too, so the
  // "N of M confirmed" counter and the swap/suggestion rows only count what
  // was actually quoted (rear-only → 1 of 1, never 1 of 2).
  const scopedOemRecommendations = useMemo<OemRecommendation[]>(() => {
    const recs = prefillData?.oemRecommendations ?? [];
    if (!brakeScope?.hasBrakeWork) return recs;
    if (brakeScope.front && brakeScope.rear) return recs;
    return recs.map((rec) => ({
      ...rec,
      parts: rec.parts.filter((p) => {
        const axle =
          p.position === "front" || p.position === "rear"
            ? p.position
            : partNameAxleClient(p.part_name);
        if (axle == null) return true;
        return axle === "front" ? brakeScope.front : brakeScope.rear;
      }),
    }));
  }, [prefillData?.oemRecommendations, brakeScope]);
  const [vehicleUpdates, setVehicleUpdates] = useState<
    Record<string, string | boolean>
  >(
    Object.fromEntries(
      updatePrompts.map((prompt) => [prompt.key, prompt.value ?? ""])
    )
  );
  const [technicianNotes, setTechnicianNotes] = useState("");
  // Customer-facing "what did you find / do" summary — the driver reads this
  // on the receipt and Past Service report. Kept separate from technicianNotes
  // (shop-to-shop tip) and additionalObservations (private shop note).
  const [mechanicFindings, setMechanicFindings] = useState("");
  // Seed the findings from the working notes the mechanic already jotted in the
  // active-job overlay (job_actuals.inProgressNotes → layoverNotes), so they're
  // not asked to retype what they did. One-shot: fires once the notes load and
  // only while the field is still untouched, so it never clobbers live typing.
  const findingsSeededRef = useRef(false);
  useEffect(() => {
    if (findingsSeededRef.current) return;
    const seed = (layoverNotes ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    if (!seed) return;
    findingsSeededRef.current = true;
    setMechanicFindings((prev) => (prev.trim() ? prev : seed));
  }, [layoverNotes]);
  const [flaggedVehicleSpecs, setFlaggedVehicleSpecs] = useState(false);
  const [flaggedReason, setFlaggedReason] = useState("");
  // Mechanic's actual labor time in decimal HOURS (industry-standard entry).
  // Seeded from the estimate (minutes) via formatHoursValue; converted back to
  // whole minutes at submit. Stays the single labor money source of truth.
  const [actualLaborHours, setActualLaborHours] = useState(
    typeof estimatedLaborMinutes === "number"
      ? formatHoursValue(estimatedLaborMinutes)
      : ""
  );
  // Per-service labor split for the estimate-cycle labor step, in HOURS. Keyed
  // by "base" (the original quoted work) plus one entry per custom job id. The
  // sum is written back to `actualLaborHours`, the single money source of truth
  // — this just lets the mechanic see and set each service's share.
  const [laborAllocations, setLaborAllocations] = useState<
    Record<string, string>
  >({});
  // Every labor line must resolve to a real time before the mechanic can leave
  // the labor step — a line still at 0 (no estimate, nothing typed) would quote
  // free labor. Mirrors LaborStep's per-line rule: the explicit entry wins,
  // otherwise the line's estimate (base = estimatedLaborMinutes; each added line
  // = its estimated_minutes). A catalog service we enrich for arrives with an
  // estimate, so this only blocks lines that genuinely have none.
  const laborStepValid = useMemo(() => {
    const lineDefs: Array<{ key: string; defMin: number }> = [
      {
        key: "base",
        defMin:
          typeof estimatedLaborMinutes === "number" && estimatedLaborMinutes > 0
            ? estimatedLaborMinutes
            : 0,
      },
      ...(customJobs ?? []).map((j) => ({
        key: String(j._id),
        defMin:
          typeof j.estimated_minutes === "number" && j.estimated_minutes > 0
            ? j.estimated_minutes
            : 0,
      })),
    ];
    return lineDefs.every((l) => {
      const raw = laborAllocations[l.key];
      const hours =
        raw !== undefined
          ? Number(raw) || 0
          : l.defMin > 0
            ? l.defMin / 60
            : 0;
      return hours > 0;
    });
  }, [estimatedLaborMinutes, customJobs, laborAllocations]);
  const [actualPartsCost, setActualPartsCost] = useState("");
  const [difficultyRating, setDifficultyRating] = useState("");
  const [partsAccuracyStatus, setPartsAccuracyStatus] =
    useState<PartsAccuracyStatus | null>(null);
  const [partsAccuracyFeedback, setPartsAccuracyFeedback] = useState("");
  const [additionalObservations, setAdditionalObservations] = useState("");

  /* ── Off-catalog outcomes (Off-Catalog Work spec, §7) ───────────────────────
     What the mechanic reports about each custom line. `resolution` +
     `resolved_complaint` close the triple that the complaint opened at booking
     time: symptom → what we did → whether it worked. That's the whole reason to
     capture any of this. (The `customJobs` query itself is declared above,
     where the Parts step also reads it to seed extra-work parts.) */
  const [customJobOutcomes, setCustomJobOutcomes] = useState<
    Record<string, { resolution: string; resolved: boolean | null }>
  >({});
  const [recommendations, setRecommendations] = useState<RecRowState[]>([]);
  // Canonical light codes the mechanic confirmed are no longer on the
  // dashboard — see "Dashboard warning lights."
  const [clearedWarningLights, setClearedWarningLights] = useState<string[]>([]);
  // Prior open recommendations the mechanic marks done this visit, keyed by the
  // job_recommendations _id. Sent as a separate arg to completeWithPostjob to
  // close them out (status → completed, follow-up cancelled).
  const [resolvedPriorRecIds, setResolvedPriorRecIds] = useState<
    Record<string, boolean>
  >({});
  const toggleResolvedPriorRec = (id: string) =>
    setResolvedPriorRecIds((current) => ({ ...current, [id]: !current[id] }));

  /* ── Mid-job flags seed the survey (Flag Issue spec, §4) ────────────────────
     Anything the mechanic flagged from the active-job overlay is already a
     job_recommendations row. Asking again at completion would be asking the same
     question twice and inviting a duplicate, so the survey opens with those rows
     already filled in — confirm or edit, don't re-enter.

     Seeded once per booking: after that the mechanic owns the list, and
     re-seeding would clobber their edits on every re-render. */
  const midJobFlagged = useQuery(
    api.jobRecommendations.getMidJobFlaggedForBooking,
    open && bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  );
  const seededRecsForBookingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !bookingId || !midJobFlagged) return;
    const key = String(bookingId);
    if (seededRecsForBookingRef.current === key) return;
    seededRecsForBookingRef.current = key;
    if (midJobFlagged.length === 0) return;

    setRecommendations((prev) => {
      const already = new Set(
        prev.map((r) =>
          (r.recommended_service_id ?? r.freeform_service_name).toLowerCase(),
        ),
      );
      const seeded: RecRowState[] = midJobFlagged
        .filter((f) => {
          const key2 = (
            f.recommended_service_id ?? f.freeform_service_name
          ).toLowerCase();
          return !already.has(key2);
        })
        .map((f) => ({
          id: makeRecId(),
          recommended_service_id: f.recommended_service_id as string | null,
          service_label: f.service_label ?? f.freeform_service_name,
          service_slug: f.service_slug,
          service_has_options: f.service_has_options,
          freeform_service_name: f.recommended_service_id
            ? ""
            : f.freeform_service_name,
          urgency: f.urgency as RecommendationUrgency,
          reason: f.reason,
          visible_to_driver: f.visible_to_driver,
          target_mileage: defaultTriggerMileage(Number(completionMileage)),
          scheduled_at: null,
          scheduled_mechanic_id: null,
          scheduled_mechanic_name: null,
          selected_service_option: null,
          tire_specs: null,
        }));
      return seeded.length > 0 ? [...seeded, ...prev] : prev;
    });
  }, [open, bookingId, midJobFlagged]);
  const [photos, setPhotos] = useState<PhotoState[]>([]);
  // Optional evidence photos the mechanic attaches on the "Why the added
  // scope?" reasoning step (estimate cycles only). Separate from the post-job
  // report `photos`; these ride along with the approval so the customer sees
  // them on the approval screen.
  const [scopePhotos, setScopePhotos] = useState<PhotoState[]>([]);
  const [error, setError] = useState("");

  const generateUploadUrl = useMutation(generateUploadUrlRef) as (args: {
    bookingId: string;
  }) => Promise<string>;

  // Steps
  const visibleSteps = useMemo<StepKey[]>(() => {
    const list: StepKey[] = [];
    const isEstimateCycle = cycle === "pre_job" || cycle === "mid_job";
    // Pre/mid-job cycles are forward-looking quotes, not retrospective job
    // reports. Hide every step that describes a *completed* job — mileage,
    // parts_accuracy, vehicle_updates, time variance, difficulty, tip,
    // recommendations. Parts → Labor → Flag (optional) → Photos → Summary.
    // Flag Issue spec, §3. "Add unforeseen scope" could add money and time but had
    // no way to say WHAT the work was, so a mechanic who found a whole extra
    // service either faked it as anonymous parts-and-hours — leaving nothing in
    // the service history, nothing in the maintenance record and nothing readable
    // on the receipt — or mentioned it verbally. This step comes first because the
    // answer changes what the Parts step should even show.
    if (cycle === "mid_job") {
      list.push("found_work");
    }
    if (!isEstimateCycle) {
      list.push("mileage");
    }
    if (requiresParts || (prefillData?.suggestedParts?.length ?? 0) > 0 || isEstimateCycle) {
      list.push("parts");
    }
    if (isEstimateCycle) {
      // Mechanic confirms / adjusts labor hours for the estimate. Drives the
      // running-total bar and the final mutation payload.
      list.push("labor");
    }
    if (requiresParts && !isEstimateCycle) list.push("parts_accuracy");
    // Estimate cycles skip the post-job survey ritual (flag, photos, tip,
    // recommendations, time/difficulty). The 3-step "Adjust quote" flow is:
    // Parts → Labor → Summary (which doubles as the reasoning + send screen).
    if (!isEstimateCycle) {
      // ── Core wrap-up: the steps a mechanic should always fill, ending on the
      //    three the customer actually reads. Findings/photos/recommendations
      //    sit here (roughly steps 5–7) so the essentials are captured before
      //    the "more questions?" gate.
      // Off-catalog outcomes (Off-Catalog Work spec, §7). Only shown when the
      // booking actually carries custom lines, so the survey doesn't grow a
      // dead step for the overwhelming majority of bookings.
      if ((customJobs?.length ?? 0) > 0) list.push("custom_outcomes");
      list.push("findings");
      list.push("photos");
      list.push("recommendations");
      // ── Gate: everything past here is optional. "No, mark job complete" ends
      //    the survey here and completes the job; "Yes, keep going" reveals the
      //    remaining analytics + spec-correction steps.
      list.push("more_gate");
      // ── Behind the gate: vehicle spec corrections, out-of-scope flag, timing,
      //    difficulty, and the shop-to-shop tip.
      if (updatePrompts.length > 0) list.push("vehicle_updates");
      list.push("flag");
      list.push("time_check");
      if (timeVariance && timeVariance !== "on_time") list.push("time_reason");
      list.push("difficulty");
      list.push("tip");
    }
    list.push("summary");
    return list;
  }, [
    cycle,
    timeVariance,
    requiresParts,
    prefillData?.suggestedParts?.length,
    updatePrompts.length,
    // The custom-outcomes step appears only for bookings with off-catalog lines,
    // and this query resolves after first render.
    customJobs?.length,
  ]);

  // ─── Estimate-cycle running total ──────────────────────────────────────
  // Mirrors `computeMechanicSetPrice` on the server: parts subtotal + labor
  // + tax + platform fee. Only computed when cycle is set; the legacy
  // post-job actuals path renders a plain `Submit report` button.
  const isEstimateCycle = cycle === "pre_job" || cycle === "mid_job";
  // Resolve a per-hour labor rate. Priority:
  //   1. Shop's stored labor_rate (cents/hour) — the canonical rate.
  //   2. Derived from booking.labor_cost / estimated_labor_minutes — matches
  //      what the customer was quoted, even if the shop's rate has drifted.
  //   3. Industry default $125/hr — last resort so the bar never shows $0.
  const effectiveLaborRateCents = useMemo(() => {
    if (typeof laborRateCents === "number" && laborRateCents > 0) {
      return laborRateCents;
    }
    if (
      typeof laborCostDollars === "number" &&
      laborCostDollars > 0 &&
      typeof estimatedLaborMinutes === "number" &&
      estimatedLaborMinutes > 0
    ) {
      const hours = estimatedLaborMinutes / 60;
      return Math.round((laborCostDollars / hours) * 100);
    }
    return 12500;
  }, [laborRateCents, laborCostDollars, estimatedLaborMinutes]);

  const liveTotals = useMemo(() => {
    if (!isEstimateCycle) return null;
    return computeEstimateTotals({
      parts,
      hours: Number(actualLaborHours) || 0,
      laborRateCents: effectiveLaborRateCents,
      shopState,
      shopZip,
    });
  }, [
    isEstimateCycle,
    parts,
    actualLaborHours,
    effectiveLaborRateCents,
    shopState,
    shopZip,
  ]);

  // The quoted price as the CLIENT computes it — same formula as liveTotals but
  // over the seeded (quoted) parts + estimated labor, i.e. the untouched state
  // when the dialog opens. Lets the pre-job summary decide whether the mechanic
  // actually pushed the price ABOVE the quote before asking them to justify an
  // "adjustment" — without exposing (or drifting against) the customer's hidden
  // disclosed range. Because it reuses computeEstimateTotals with the same
  // labor-hours seed, an unchanged quote compares exactly equal (integer cents),
  // so no reason is requested. Null when there's no quoted snapshot to compare
  // against (e.g. walk-ins).
  const quotedBaselineTotalCents = useMemo(() => {
    if (!isEstimateCycle) return null;
    if (!quotedParts || quotedParts.length === 0) return null;
    const hours =
      typeof estimatedLaborMinutes === "number"
        ? Number(formatHoursValue(estimatedLaborMinutes)) || 0
        : 0;
    return computeEstimateTotals({
      parts: buildPartRows(quotedParts),
      hours,
      laborRateCents: effectiveLaborRateCents,
      shopState,
      shopZip,
    }).totalCents;
  }, [
    isEstimateCycle,
    quotedParts,
    estimatedLaborMinutes,
    effectiveLaborRateCents,
    shopState,
    shopZip,
  ]);

  const [stepIndex, setStepIndex] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);

  // "What did you find?" keeps a pending add/edit in its own local state that
  // only persists when the mechanic clicks Save/Add. If they hit Continue with
  // a valid line still in the form, we'd silently drop it. FoundWorkStep
  // registers a flush here so navigating forward commits that pending line
  // first — no lost inputs, and its labor time reaches the labor step.
  const foundWorkFlushRef = useRef<(() => Promise<void>) | null>(null);

  // Note: we intentionally do NOT compare the mechanic's per-row price to a
  // catalog median in the UI. The shop sets the price; the customer decides.
  // Manual-part justification is optional (no client or server gate); the note
  // is kept in the audit trail when provided.

  useEffect(() => {
    if (stepIndex >= visibleSteps.length) {
      setStepIndex(Math.max(0, visibleSteps.length - 1));
    }
  }, [visibleSteps.length, stepIndex]);

  const currentStep = visibleSteps[stepIndex] ?? "summary";
  const isLast = currentStep === "summary";

  function goNext() {
    setError("");
    if (stepIndex < visibleSteps.length - 1) {
      setStepIndex(stepIndex + 1);
      setAnsweredCount((n) => n + 1);
    }
  }

  // Continue from the footer. Commit any valid pending "What did you find?"
  // line before advancing so its taxonomy and labor time are saved rather than
  // dropped — the labor step reads that saved estimate to pre-fill the row.
  async function handleContinue() {
    if (currentStep === "found_work" && foundWorkFlushRef.current) {
      try {
        await foundWorkFlushRef.current();
      } catch {
        // FoundWorkStep surfaces its own error toast; don't block navigation.
      }
    }
    goNext();
  }

  function goBack() {
    setError("");
    if (stepIndex > 0) setStepIndex(stepIndex - 1);
  }

  function skipStep() {
    setError("");
    if (stepIndex < visibleSteps.length - 1) {
      setStepIndex(stepIndex + 1);
    }
  }

  function normalizeParts() {
    return parts
      .map((part) => {
        const suppliedBy: "shop" | "customer" =
          part.supplied_by === "customer" ? "customer" : "shop";
        const rawCost = Number(part.cost || 0);
        // Customer-supplied parts log at $0 regardless of what's in the field.
        const cost = suppliedBy === "customer" ? 0 : rawCost;
        const quantity = Math.max(1, Math.round(part.quantity || 1));
        const notUsed = part.not_used === true;
        return {
          part_name: part.part_name.trim(),
          brand: part.brand.trim() || null,
          oem_number: part.oem_number.trim(),
          // "Not used" rows force $0 so a leftover input value doesn't leak
          // into snapshot price aggregates. Mirror of normalizePartsUsed.
          cost: notUsed ? 0 : cost,
          quantity,
          supplied_by: suppliedBy,
          part_tier: part.part_tier || "oem",
          service_id: part.service_id ?? null,
          custom_service_name: part.custom_service_name ?? null,
          source: part.source,
          swap_from_oem_number: part.swap_from_oem_number || undefined,
          not_used: notUsed ? true : undefined,
          justification_text: part.justification_text?.trim() || undefined,
          is_tire: part.is_tire === true ? true : undefined,
          tire_size: part.tire_size?.trim() || undefined,
          tire_brand: part.tire_brand?.trim() || undefined,
          tire_model: part.tire_model?.trim() || undefined,
          tire_position: part.tire_position?.trim() || undefined,
        };
      })
      .filter(
        (part) =>
          part.part_name ||
          part.brand ||
          part.oem_number ||
          (Number.isFinite(part.cost) && part.cost > 0) ||
          part.supplied_by === "customer" ||
          part.not_used === true ||
          part.is_tire === true
      );
  }

  async function handleFinalSubmit() {
    const parsedMileage = Number(completionMileage);
    // Mileage isn't part of the estimate-cycle flow (the form hides that
    // step). Only enforce on the legacy post-job actuals path.
    if (
      !cycle &&
      (!Number.isFinite(parsedMileage) || completionMileage.trim() === "")
    ) {
      setError("Completion mileage is required.");
      const mileageIdx = visibleSteps.indexOf("mileage");
      if (mileageIdx >= 0) setStepIndex(mileageIdx);
      return;
    }
    // Odometer can't read below the last value on file — the server enforces
    // this too, so catch it here and send the mechanic back to the field.
    if (
      !cycle &&
      baselineMileage != null &&
      Number.isFinite(parsedMileage) &&
      parsedMileage < baselineMileage
    ) {
      setError(
        `Completion mileage can't be below the last recorded reading of ${baselineMileage.toLocaleString("en-US")} mi.`
      );
      const mileageIdx = visibleSteps.indexOf("mileage");
      if (mileageIdx >= 0) setStepIndex(mileageIdx);
      return;
    }

    const normalizedParts = normalizeParts();
    const partsRequiredList = passportData?.parts_required_services ?? [];
    if (partsRequiredList.length > 1) {
      // Multi-service: each parts-required service must contribute ≥1 row.
      const missing = partsRequiredList.find(
        (svc) =>
          !normalizedParts.some(
            (p) => p.service_id != null && p.service_id === svc._id,
          ),
      );
      if (missing) {
        setError(`Add at least one part for ${missing.name}.`);
        const partsIdx = visibleSteps.indexOf("parts");
        if (partsIdx >= 0) setStepIndex(partsIdx);
        return;
      }
    } else if (requiresParts && normalizedParts.length === 0) {
      setError(
        "This service requires parts — please add at least one part to be installed before submitting."
      );
      const partsIdx = visibleSteps.indexOf("parts");
      if (partsIdx >= 0) setStepIndex(partsIdx);
      return;
    }
    // Manual-part justification is optional — the mechanic can add a note but is
    // never blocked from submitting for a missing one.
    if (flaggedVehicleSpecs && flaggedReason.trim() === "") {
      setError("Please explain why the vehicle specs should be reviewed.");
      const flagIdx = visibleSteps.indexOf("flag");
      if (flagIdx >= 0) setStepIndex(flagIdx);
      return;
    }
    if (
      partsAccuracyStatus === "different_parts" &&
      partsAccuracyFeedback.trim() === ""
    ) {
      setError("Please note which parts were different.");
      const paIdx = visibleSteps.indexOf("parts_accuracy");
      if (paIdx >= 0) setStepIndex(paIdx);
      return;
    }

    // Fresh post-job photos + the mid-job layover photos (shown read-only in
    // the review) — merged so the layover evidence persists into the report.
    // Deduped by storage id; layover photos keep their real capture time.
    const seenPhotoStorageIds = new Set<string>();
    const photosPayload: PostjobPhotoInput[] = [...photos, ...layoverPhotos]
      .filter((photo) => {
        if (photo.status !== "ready" || !photo.storageId) return false;
        if (seenPhotoStorageIds.has(photo.storageId)) return false;
        seenPhotoStorageIds.add(photo.storageId);
        return true;
      })
      .map((photo) => ({
        storage_id: photo.storageId,
        caption: photo.caption.trim() || null,
        taken_at: photo.takenAt ?? Date.now(),
      }));

    const skipOptionalSurvey = answeredCount === 0;

    setError("");

    // Pre-Job Approval flow: when the dialog is opened with a cycle, the
    // submit lands on booking_approvals.* instead of writing job_actuals.
    // The customer-side approval state then drives further UI (live
    // status banner inside this dialog after submit).
    if (cycle && bookingId) {
      const partsForApproval = normalizedParts.map((p) => ({
        part_name: p.part_name,
        brand: p.brand ?? undefined,
        oem_number: p.oem_number ?? "",
        cost: p.cost,
        quantity: p.quantity ?? 1,
        supplied_by: p.supplied_by ?? undefined,
        part_tier: p.part_tier ?? undefined,
        service_id: p.service_id ?? undefined,
        custom_service_name: p.custom_service_name ?? undefined,
        source: p.source ?? undefined,
        swap_from_oem_number: p.swap_from_oem_number ?? undefined,
        not_used: p.not_used ?? undefined,
        justification_text: p.justification_text ?? undefined,
        evidence_photo_ids: (p as any).evidence_photo_ids ?? undefined,
        is_tire: p.is_tire ?? undefined,
        tire_size: p.tire_size ?? undefined,
        tire_brand: p.tire_brand ?? undefined,
        tire_model: p.tire_model ?? undefined,
        tire_position: p.tire_position ?? undefined,
      }));
      const laborHoursValue =
        actualLaborHours.trim() === "" ? null : Number(actualLaborHours);
      const laborHours =
        laborHoursValue != null &&
        Number.isFinite(laborHoursValue) &&
        laborHoursValue > 0
          ? laborHoursValue
          : undefined;
      // Send the rate alongside hours so the server can multiply directly
      // instead of falling back to booking.labor_cost. effectiveLaborRateCents
      // priorities shop.labor_rate, falls back to the booking's quoted rate,
      // then a $125 default.
      const laborRateCentsForSubmit = laborHours != null
        ? effectiveLaborRateCents
        : undefined;
      // Only fully-uploaded scope photos carry a storage id. Still-uploading or
      // errored ones are dropped rather than blocking the send.
      const scopePhotoIds = scopePhotos
        .filter((p) => p.status === "ready" && p.storageId)
        .map((p) => p.storageId as Id<"_storage">);
      const scopePhotoIdsForSubmit =
        scopePhotoIds.length > 0 ? scopePhotoIds : undefined;
      try {
        let result;
        if (cycle === "pre_job") {
          result = await submitPreJobEstimate({
            bookingId: bookingId as any,
            parts: partsForApproval as any,
            laborHours,
            laborRateCents: laborRateCentsForSubmit,
            notes: technicianNotes.trim() || undefined,
            scopePhotoIds: scopePhotoIdsForSubmit,
          });
        } else if (cycle === "mid_job") {
          result = await submitMidJobChange({
            bookingId: bookingId as any,
            parts: partsForApproval as any,
            laborHours,
            laborRateCents: laborRateCentsForSubmit,
            notes: technicianNotes.trim() || undefined,
            scopePhotoIds: scopePhotoIdsForSubmit,
          });
        }
        if (result) {
          onApprovalSubmitted?.(result as any);
          // Fresh estimate sent — clear the revise intent so a subsequent
          // decline correctly re-promotes the status panel on re-entry.
          manualReviseRef.current = false;
          setSubmittedForApproval(true);
        }
        return;
      } catch (err: any) {
        setError(err?.message ?? "Could not submit estimate. Try again.");
        return;
      }
    }

    await onSubmit({
      completion_mileage: parsedMileage,
      parts_used: normalizedParts,
      vehicle_updates: Object.fromEntries(
        Object.entries(vehicleUpdates).map(([key, value]) => [
          key,
          value === "" ? null : value,
        ])
      ),
      technician_notes: technicianNotes.trim() || null,
      mechanic_findings: mechanicFindings.trim() || null,
      flagged_vehicle_specs: flaggedVehicleSpecs,
      flagged_vehicle_specs_reason: flaggedReason.trim() || null,
      actual_labor_minutes:
        actualLaborHours.trim() === ""
          ? null
          : hoursToMinutes(Number(actualLaborHours)),
      actual_parts_cost:
        actualPartsCost.trim() === ""
          ? sumJobActualParts(normalizedParts)
          : Number(actualPartsCost),
      difficulty_rating:
        difficultyRating.trim() === "" ? null : Number(difficultyRating),
      parts_accuracy_status: partsAccuracyStatus,
      parts_accuracy_feedback: partsAccuracyFeedback.trim() || null,
      additional_observations: additionalObservations.trim() || null,
      skip_optional_survey: skipOptionalSurvey,
      postjob_photos: photosPayload,
      time_variance: timeVariance,
      time_variance_reason: timeReason,
      time_variance_note: timeReasonNote.trim() || null,
      recommendations: recommendations
        .filter(
          (r) => r.recommended_service_id || r.freeform_service_name.trim() !== "",
        )
        .map<JobRecommendationInput>((r) => {
          const mileage = Number(r.target_mileage);
          return {
            recommended_service_id: r.recommended_service_id,
            freeform_service_name: r.recommended_service_id
              ? null
              : r.freeform_service_name.trim() || null,
            urgency: r.urgency,
            reason: r.reason.trim() || null,
            // Always visible — the per-row toggle is gone. Forced here rather
            // than trusting the row state so a draft restored from a row saved
            // while the toggle still existed can't submit as hidden.
            visible_to_driver: true,
            target_mileage:
              r.target_mileage.trim() && Number.isFinite(mileage) && mileage > 0
                ? mileage
                : null,
            scheduled_at: r.scheduled_at ?? null,
            scheduled_mechanic_id: r.scheduled_mechanic_id ?? null,
            selected_service_option: r.selected_service_option
              ? {
                  option_id: r.selected_service_option.option_id as any,
                  option_label: r.selected_service_option.option_label,
                  option_type: r.selected_service_option.option_type,
                }
              : null,
            tire_specs: r.tire_specs ?? null,
          };
        }),
      cleared_warning_lights:
        clearedWarningLights.length > 0 ? clearedWarningLights : undefined,
      },
      // Only send lines the mechanic actually reported on. An untouched line
      // still closes server-side, but as "completed, no outcome recorded" —
      // which the director view reports honestly rather than inventing a result.
      (customJobs ?? []).flatMap<CustomJobOutcome>((job) => {
        const entry = customJobOutcomes[job._id];
        if (!entry) return [];
        if (!entry.resolution.trim() && entry.resolved === null) return [];
        return [
          {
            name: job.name,
            resolution: entry.resolution.trim() || undefined,
            resolved_complaint:
              entry.resolved === null ? undefined : entry.resolved,
          },
        ];
      }),
      // Prior recs the mechanic marked done this visit — server closes them out.
      Object.keys(resolvedPriorRecIds).filter((id) => resolvedPriorRecIds[id]),
    );
  }

  async function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    if (!bookingId) {
      setError("Cannot upload photos before the job is saved.");
      return;
    }

    const remaining = Math.max(0, 6 - photos.length);
    const accepted = files.slice(0, remaining);

    for (const file of accepted) {
      const id = makePhotoId();
      const previewUrl = URL.createObjectURL(file);
      setPhotos((current) => [
        ...current,
        { id, storageId: "", previewUrl, caption: "", status: "uploading" },
      ]);
      try {
        const uploadUrl = await generateUploadUrl({ bookingId });
        const result = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!result.ok) throw new Error("Upload failed");
        const { storageId } = (await result.json()) as { storageId?: string };
        if (!storageId) throw new Error("Upload did not return an id");
        setPhotos((current) =>
          current.map((photo) =>
            photo.id === id
              ? { ...photo, storageId, status: "ready" }
              : photo
          )
        );
      } catch (uploadError) {
        setPhotos((current) =>
          current.map((photo) =>
            photo.id === id ? { ...photo, status: "error" } : photo
          )
        );
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : "Photo upload failed"
        );
      }
    }
  }

  // Scope-justification photos (estimate cycles). Mirrors `handleFilesSelected`
  // but targets `scopePhotos` with its own cap; kept separate so the post-job
  // report photo flow is untouched.
  async function handleScopeFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    if (!bookingId) {
      setError("Cannot upload photos before the job is saved.");
      return;
    }

    const remaining = Math.max(0, 4 - scopePhotos.length);
    const accepted = files.slice(0, remaining);

    for (const file of accepted) {
      const id = makePhotoId();
      const previewUrl = URL.createObjectURL(file);
      setScopePhotos((current) => [
        ...current,
        { id, storageId: "", previewUrl, caption: "", status: "uploading" },
      ]);
      try {
        const uploadUrl = await generateUploadUrl({ bookingId });
        const result = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!result.ok) throw new Error("Upload failed");
        const { storageId } = (await result.json()) as { storageId?: string };
        if (!storageId) throw new Error("Upload did not return an id");
        setScopePhotos((current) =>
          current.map((photo) =>
            photo.id === id ? { ...photo, storageId, status: "ready" } : photo,
          ),
        );
      } catch (uploadError) {
        setScopePhotos((current) =>
          current.map((photo) =>
            photo.id === id ? { ...photo, status: "error" } : photo,
          ),
        );
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : "Photo upload failed",
        );
      }
    }
  }

  function removeScopePhoto(id: string) {
    setScopePhotos((current) => {
      const photo = current.find((p) => p.id === id);
      if (photo) URL.revokeObjectURL(photo.previewUrl);
      return current.filter((p) => p.id !== id);
    });
  }

  const skipMoreVisible = answeredCount >= 5;
  // Required steps that can't be skipped — the billing-critical core that sits
  // before the "more questions?" gate. Vehicle-spec updates and flag-for-review
  // used to live here too, but they now sit BEHIND the gate (opt-in), so they're
  // skippable like the rest of the optional tail.
  const REQUIRED_STEPS: StepKey[] = ["mileage", "parts", "parts_accuracy"];
  // The gate owns its own Yes/No buttons, so suppress the top-right Skip there.
  // Labor also can't be skipped — a skipped labor line quotes free labor, which
  // is the whole point of gating Continue on it.
  const skipHiddenForStep =
    REQUIRED_STEPS.includes(currentStep) ||
    currentStep === "more_gate" ||
    currentStep === "labor";

  const stepHeader = (
    <div className="flex items-center justify-between gap-2 px-4 pt-3 sm:px-6">
      <button
        type="button"
        onClick={stepIndex === 0 ? onClose : goBack}
        className="-m-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
        aria-label={stepIndex === 0 ? "Close" : "Back"}
      >
        {stepIndex === 0 ? <X className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
      </button>
      <div className="flex items-center gap-1">
        {visibleSteps.map((_, idx) => (
          <span
            key={idx}
            className={cn(
              "h-1.5 rounded-full transition-all duration-300",
              idx === stepIndex
                ? "w-7 bg-primary"
                : idx < stepIndex
                  ? "w-1.5 bg-primary/40"
                  : "w-1.5 bg-primary/15"
            )}
          />
        ))}
      </div>
      {isLast || skipHiddenForStep ? (
        <span className="w-8" />
      ) : (
        <button
          type="button"
          onClick={skipStep}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
            skipMoreVisible
              ? "bg-muted/60 text-foreground hover:bg-muted"
              : "text-muted-foreground/70 hover:text-foreground"
          )}
        >
          Skip
        </button>
      )}
    </div>
  );

  const dialogTitle =
    cycle === "pre_job"
      ? "Set your price"
      : cycle === "mid_job"
        ? "Found extra work?"
        : cycle === "post_job_reapproval"
          ? "Confirm final billing"
          : "Job report";

  // Post-submit status panel takes over the dialog body once the mechanic
  // sends a cycle estimate. Status is live via the workflow hook.
  if (cycle && submittedForApproval) {
    return (
      <SurveyDialogShell
        open={open}
        title={dialogTitle}
        onClose={onClose}
        maxWidthClassName="max-w-2xl"
        mobileFullBleed
        hideHeader
        contentClassName="flex min-h-0 flex-1 flex-col"
      >
        <ApprovalStatusPanel
          workflow={workflow}
          cycle={cycle}
          onDismiss={onClose}
          onReviseRequested={() => {
            manualReviseRef.current = true;
            setSubmittedForApproval(false);
            // Drop back to the first step of the estimate flow, not the
            // summary step they submitted from.
            setStepIndex(0);
            setError("");
          }}
          bookingLabel={bookingLabel}
        />
      </SurveyDialogShell>
    );
  }

  return (
    <SurveyDialogShell
      open={open}
      title={dialogTitle}
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      mobileFullBleed
      hideHeader
      contentClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {stepHeader}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 sm:px-10 sm:py-10">
          {passportData?.vehicle_spec_label || prefillData?.serviceName ? (
            <div className="mx-auto mb-7 flex w-full max-w-xl flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-full border border-primary/10 bg-muted/40 px-4 py-2">
              {prefillData?.serviceName ? (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
                  <Car className="h-3.5 w-3.5" />
                  <span className="truncate">{prefillData.serviceName}</span>
                </span>
              ) : null}
              {prefillData?.serviceName && passportData?.vehicle_spec_label ? (
                <span className="h-3 w-px bg-primary/15" aria-hidden />
              ) : null}
              {passportData?.vehicle_spec_label ? (
                <span className="truncate text-[12px] font-medium text-foreground/70">
                  {passportData.vehicle_spec_label}
                </span>
              ) : null}
            </div>
          ) : null}

          {isFixedPrice ? (
            <LockedNote
              icon={Info}
              title="Fixed price service"
              body="Updating parts and time won't change the price. Edits are logged for the audit trail only."
              footnote={
                <>
                  Need to change what the customer pays? Update the{" "}
                  <span className="font-semibold">fixed price</span> in the
                  shop&apos;s service catalog — it applies to future bookings,
                  not this one.
                </>
              }
            />
          ) : null}

          {lockBilling && !cycle ? (
            <LockedNote
              icon={Lock}
              title="Billing locked"
              body="Parts and labor were locked when the customer confirmed the quote. This survey records what you found, vehicle condition, and recommendations only."
              footnote={
                <>
                  Need to change parts or labor? Back out and use{" "}
                  <span className="font-semibold">Add unforeseen scope</span>{" "}
                  before marking the job completed.
                </>
              }
            />
          ) : null}

          <StepContent
            step={currentStep}
            bookingId={bookingId}
            vin={passportData?.vin ?? null}
            onFoundWorkToast={(m) => setError(m)}
            foundWorkFlushRef={foundWorkFlushRef}
            customJobs={customJobs}
            customJobOutcomes={customJobOutcomes}
            setCustomJobOutcomes={setCustomJobOutcomes}
            readOnlyBilling={lockBilling && !cycle}
            lockedQuote={lockedQuote}
            bookingLabel={bookingLabel}
            bookingSubLabel={bookingSubLabel}
            serviceLabel={prefillData?.serviceName ?? null}
            vehicleLabel={prefillData?.vehicleLabel ?? null}
            engineCode={prefillData?.engineCode ?? null}
            estimatedLaborMinutes={estimatedLaborMinutes}
            timeVariance={timeVariance}
            setTimeVariance={(value) => {
              setTimeVariance(value);
              setTimeReason(null);
              setTimeReasonNote("");
              goNext();
            }}
            timeReason={timeReason}
            setTimeReason={(value) => {
              setTimeReason(value);
              if (value !== "other") goNext();
            }}
            timeReasonNote={timeReasonNote}
            setTimeReasonNote={setTimeReasonNote}
            completionMileage={completionMileage}
            setCompletionMileage={setCompletionMileage}
            baselineMileage={baselineMileage}
            actualLaborHours={actualLaborHours}
            setActualLaborHours={setActualLaborHours}
            laborAllocations={laborAllocations}
            setLaborAllocations={setLaborAllocations}
            parts={parts}
            setParts={setParts}
            requiresParts={requiresParts}
            partsRequiredServices={passportData?.parts_required_services ?? []}
            customPartLines={(customJobs ?? []).map((j) => ({ name: j.name }))}
            suggestedParts={prefillData?.suggestedParts ?? []}
            oemRecommendations={scopedOemRecommendations}
            difficultyRating={difficultyRating}
            setDifficultyRating={(value) => {
              setDifficultyRating(value);
              goNext();
            }}
            partsAccuracyStatus={partsAccuracyStatus}
            setPartsAccuracyStatus={(value) => {
              setPartsAccuracyStatus(value);
              if (value === "correct") goNext();
            }}
            partsAccuracyFeedback={partsAccuracyFeedback}
            setPartsAccuracyFeedback={setPartsAccuracyFeedback}
            updatePrompts={updatePrompts}
            vehicleUpdates={vehicleUpdates}
            setVehicleUpdates={setVehicleUpdates}
            photos={photos}
            onFilesSelected={handleFilesSelected}
            updatePhotoCaption={(id, caption) =>
              setPhotos((current) =>
                current.map((photo) =>
                  photo.id === id ? { ...photo, caption } : photo
                )
              )
            }
            removePhoto={(id) =>
              setPhotos((current) => {
                const photo = current.find((p) => p.id === id);
                if (photo) URL.revokeObjectURL(photo.previewUrl);
                return current.filter((p) => p.id !== id);
              })
            }
            scopePhotos={scopePhotos}
            onScopeFilesSelected={handleScopeFilesSelected}
            updateScopePhotoCaption={(id, caption) =>
              setScopePhotos((current) =>
                current.map((photo) =>
                  photo.id === id ? { ...photo, caption } : photo,
                ),
              )
            }
            removeScopePhoto={removeScopePhoto}
            technicianNotes={technicianNotes}
            setTechnicianNotes={setTechnicianNotes}
            layoverNotes={layoverNotes}
            layoverPhotos={layoverPhotos}
            mechanicFindings={mechanicFindings}
            setMechanicFindings={setMechanicFindings}
            additionalObservations={additionalObservations}
            setAdditionalObservations={setAdditionalObservations}
            recommendations={recommendations}
            setRecommendations={setRecommendations}
            engineId={prefillData?.engineId ?? null}
            priorOpenRecommendations={
              prefillData?.priorOpenRecommendations ?? []
            }
            resolvedPriorRecIds={resolvedPriorRecIds}
            toggleResolvedPriorRec={toggleResolvedPriorRec}
            confirmedThisVisit={prefillData?.confirmedThisVisit ?? []}
            suggestedFromInspection={prefillData?.suggestedFromInspection ?? []}
            currentWarningLights={prefillData?.currentWarningLights ?? []}
            clearedWarningLights={clearedWarningLights}
            setClearedWarningLights={setClearedWarningLights}
            actualPartsCost={actualPartsCost}
            setActualPartsCost={setActualPartsCost}
            partsCostSum={sumJobActualParts(normalizeParts())}
            flaggedVehicleSpecs={flaggedVehicleSpecs}
            setFlaggedVehicleSpecs={setFlaggedVehicleSpecs}
            flaggedReason={flaggedReason}
            setFlaggedReason={setFlaggedReason}
            timeReasonChoices={
              timeVariance === "faster"
                ? FASTER_REASON_CHOICES
                : SLOWER_REASON_CHOICES
            }
            cycle={cycle}
            laborRateCents={effectiveLaborRateCents}
            liveTotals={liveTotals}
            quotedBaselineTotalCents={quotedBaselineTotalCents}
            isTireService={tireServiceActive || parts.some((p) => isTirePartRow(p))}
            tireOemSizes={tireOemSizes}
            tirePrefill={prefillData?.prejobTires ?? null}
          />

          {error ? (
            <p className="mt-4 text-center text-[12px] font-medium text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        {/* Running total bar — only when cycle is set. Mirrors server-side
            computeMechanicSetPrice exactly: parts + labor + tax + 7% fee.
            Hidden on the summary step (which renders its own full breakdown). */}
        {isEstimateCycle && liveTotals && currentStep !== "summary" ? (
          <div className="border-t border-primary/10 bg-primary/[0.025] px-5 py-2.5 sm:px-10 sm:py-3">
            <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-between gap-3 text-[12px]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                <span>Parts <span className="font-medium tabular-nums text-foreground">${(liveTotals.partsCents / 100).toFixed(2)}</span></span>
                <span>·</span>
                <span>Labor <span className="font-medium tabular-nums text-foreground">${(liveTotals.laborCents / 100).toFixed(2)}</span></span>
                <span>·</span>
                <span>Tax <span className="font-medium tabular-nums text-foreground">${(liveTotals.taxCents / 100).toFixed(2)}</span></span>
                <span>·</span>
                <span>Fee <span className="font-medium tabular-nums text-foreground">${(liveTotals.feeCents / 100).toFixed(2)}</span></span>
              </div>
              <div className="text-[13px]">
                <span className="text-muted-foreground">Your total </span>
                <span className="font-semibold tabular-nums text-foreground">
                  ${(liveTotals.totalCents / 100).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        ) : null}

        <div className="border-t border-primary/10 bg-[rgba(17,24,28,0.025)] px-5 py-3 sm:px-10 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-muted-foreground">
              {bookingLabel}
            </div>
            {currentStep === "more_gate" ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleFinalSubmit()}
                  disabled={isSubmitting}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-primary/20 px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-60"
                >
                  {isSubmitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  No, mark job complete
                </button>
                <button
                  type="button"
                  onClick={() => void handleContinue()}
                  className={cn(
                    drawerPrimaryButtonClassName,
                    "h-10 rounded-lg px-5 text-[13px]"
                  )}
                >
                  Yes, keep going
                  <ChevronRight className="ml-1 h-4 w-4" />
                </button>
              </div>
            ) : isLast ? (
              <button
                type="button"
                onClick={() => void handleFinalSubmit()}
                disabled={isSubmitting}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "h-10 rounded-lg px-5 text-[13px]"
                )}
              >
                {isSubmitting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {cycle
                  ? cycle === "post_job_reapproval"
                    ? "Confirm final"
                    : isEstimateCycle && liveTotals
                      ? `Send for confirmation · $${(liveTotals.totalCents / 100).toFixed(2)}`
                      : "Send for confirmation"
                  : "Submit report"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleContinue()}
                disabled={!canAdvance(currentStep, {
                  completionMileage,
                  baselineMileage,
                  timeReason,
                  timeReasonNote,
                  partsAccuracyStatus,
                  partsAccuracyFeedback,
                  requiresParts,
                  filledPartsCount: parts.filter((p) => p.part_name.trim() !== "").length,
                  // Billing locked → prices aren't editable, so never block on
                  // them. Otherwise: any named, billable shop part left at $0.
                  unpricedBlockingCount:
                    lockBilling && !cycle
                      ? 0
                      : parts.filter(
                          (p) =>
                            p.supplied_by !== "customer" &&
                            p.not_used !== true &&
                            p.part_name.trim() !== "" &&
                            (Number(p.cost) || 0) <= 0,
                        ).length,
                  recommendations,
                  laborStepValid,
                })}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "h-10 rounded-lg px-5 text-[13px]"
                )}
              >
                Continue
                <ChevronRight className="ml-1 h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </SurveyDialogShell>
  );
}

function canAdvance(
  step: StepKey,
  state: {
    completionMileage: string;
    baselineMileage: number | null;
    timeReason: TimeVarianceReason | null;
    timeReasonNote: string;
    partsAccuracyStatus: PartsAccuracyStatus | null;
    partsAccuracyFeedback: string;
    requiresParts: boolean;
    filledPartsCount: number;
    // Billable shop parts left at $0 (excludes customer-supplied and Not-used
    // rows). Non-zero blocks the parts step. Always 0 when billing is locked,
    // since prices aren't editable there.
    unpricedBlockingCount: number;
    recommendations: RecRowState[];
    laborStepValid: boolean;
  }
) {
  if (step === "labor") {
    // Can't leave labor with any line at 0 — that would quote free labor.
    return state.laborStepValid;
  }
  if (step === "recommendations") {
    // Every rec for a has_options service must carry a pick.
    return state.recommendations.every((r) => {
      if (!r.recommended_service_id) return true;
      if (r.service_slug === "tire-replacement") return r.tire_specs != null;
      if (r.service_has_options) return r.selected_service_option != null;
      return true;
    });
  }
  if (step === "mileage") {
    if (state.completionMileage.trim() === "") return false;
    const parsed = Number(state.completionMileage);
    if (!Number.isFinite(parsed)) return false;
    // Odometer can't read below the last value on file.
    if (state.baselineMileage != null && parsed < state.baselineMileage) {
      return false;
    }
    return true;
  }
  if (step === "time_reason") {
    if (state.timeReason === "other") return state.timeReasonNote.trim() !== "";
    return state.timeReason !== null;
  }
  if (step === "parts") {
    // If the service is flagged as requiring parts, the mechanic must add at
    // least one part with a non-empty name before moving on.
    if (state.requiresParts && state.filledPartsCount === 0) return false;
    // Every billable shop part must carry a price. An unpriced row has to be
    // priced, swapped, marked Not used, or removed before continuing.
    if (state.unpricedBlockingCount > 0) return false;
    return true;
  }
  if (step === "parts_accuracy") {
    if (state.partsAccuracyStatus === "different_parts") {
      return state.partsAccuracyFeedback.trim() !== "";
    }
    return true;
  }
  return true;
}

function StepContent(props: {
  step: StepKey;
  bookingId: string | null;
  /** VIN of the booking's vehicle — resolves the make for the fluid catalog
   *  picker so this vehicle's own products pin to the top. */
  vin: string | null;
  onFoundWorkToast?: (message: string) => void;
  /** Lets the parent commit a valid pending "What did you find?" line before
   *  navigating forward, so a typed-but-not-clicked-Save row isn't lost. */
  foundWorkFlushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  customJobs: CustomJobRow[] | undefined;
  customJobOutcomes: Record<string, { resolution: string; resolved: boolean | null }>;
  setCustomJobOutcomes: (
    next: Record<string, { resolution: string; resolved: boolean | null }>,
  ) => void;
  readOnlyBilling: boolean;
  lockedQuote: LockedQuote | null;
  bookingLabel: string;
  bookingSubLabel: string;
  serviceLabel: string | null;
  vehicleLabel: string | null;
  engineCode: string | null;
  estimatedLaborMinutes: number | null;
  timeVariance: TimeVariance | null;
  setTimeVariance: (value: TimeVariance) => void;
  timeReason: TimeVarianceReason | null;
  setTimeReason: (value: TimeVarianceReason) => void;
  timeReasonNote: string;
  setTimeReasonNote: (value: string) => void;
  completionMileage: string;
  setCompletionMileage: (value: string) => void;
  baselineMileage: number | null;
  actualLaborHours: string;
  setActualLaborHours: (value: string) => void;
  laborAllocations: Record<string, string>;
  setLaborAllocations: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  parts: PartRowState[];
  setParts: React.Dispatch<React.SetStateAction<PartRowState[]>>;
  requiresParts: boolean;
  // List of services on this booking whose catalog row sets requires_parts.
  // Used by PartsStep to render one parts block per service when length > 1.
  partsRequiredServices: Array<{ _id: string; name: string }>;
  /** Off-catalog lines on this booking. They get their own add-part buttons:
   *  a custom line has no services row, so without this a part fitted to one
   *  was stamped with the first catalog service_id (or nothing) and the
   *  association was lost — which is why the director's cluster read showed
   *  "none" against work that plainly consumed a part. */
  customPartLines?: Array<{ name: string }>;
  suggestedParts: JobActualPartPayload[];
  oemRecommendations: OemRecommendation[];
  difficultyRating: string;
  setDifficultyRating: (value: string) => void;
  partsAccuracyStatus: PartsAccuracyStatus | null;
  setPartsAccuracyStatus: (value: PartsAccuracyStatus) => void;
  partsAccuracyFeedback: string;
  setPartsAccuracyFeedback: (value: string) => void;
  updatePrompts: ReturnType<typeof getVehicleUpdatePrompts>;
  vehicleUpdates: Record<string, string | boolean>;
  setVehicleUpdates: React.Dispatch<
    React.SetStateAction<Record<string, string | boolean>>
  >;
  photos: PhotoState[];
  onFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  updatePhotoCaption: (id: string, caption: string) => void;
  removePhoto: (id: string) => void;
  scopePhotos: PhotoState[];
  onScopeFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  updateScopePhotoCaption: (id: string, caption: string) => void;
  removeScopePhoto: (id: string) => void;
  technicianNotes: string;
  setTechnicianNotes: (value: string) => void;
  /** Read-only mid-job layover data, surfaced in the summary/review step. */
  layoverNotes: string;
  layoverPhotos: PhotoState[];
  mechanicFindings: string;
  setMechanicFindings: (value: string) => void;
  additionalObservations: string;
  setAdditionalObservations: (value: string) => void;
  recommendations: RecRowState[];
  setRecommendations: React.Dispatch<React.SetStateAction<RecRowState[]>>;
  engineId: string | null;
  priorOpenRecommendations: PriorOpenRecommendation[];
  resolvedPriorRecIds: Record<string, boolean>;
  toggleResolvedPriorRec: (id: string) => void;
  confirmedThisVisit: ConfirmedThisVisitRecommendation[];
  suggestedFromInspection: SuggestedFromInspection[];
  currentWarningLights: string[];
  clearedWarningLights: string[];
  setClearedWarningLights: React.Dispatch<React.SetStateAction<string[]>>;
  actualPartsCost: string;
  setActualPartsCost: (value: string) => void;
  partsCostSum: number;
  flaggedVehicleSpecs: boolean;
  setFlaggedVehicleSpecs: (value: boolean) => void;
  flaggedReason: string;
  setFlaggedReason: (value: string) => void;
  timeReasonChoices: { value: TimeVarianceReason; label: string }[];
  // Estimate-cycle additions. When `cycle` is null, the legacy actuals
  // path runs and these are ignored.
  cycle?: PostJobSurveyCycle;
  laborRateCents: number;
  liveTotals: {
    partsCents: number;
    laborCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
  } | null;
  /** The quoted total as the client computes it (cents), for the pre-job
   *  "Why this adjustment?" gate. Null when there's no quote to compare to. */
  quotedBaselineTotalCents: number | null;
  /** True when the booking's service is tire replacement — the parts step
   *  renders the custom TirePartsEditor (size/brand/model/price) for tire
   *  lines instead of the generic OEM part fields. */
  isTireService: boolean;
  /** Vehicle OEM tire fitments [front, rear] surfaced as size chips. */
  tireOemSizes: string[];
  /** Prejob inspection tire findings (per axle) — the editor's "Add axle"
   *  affordance uses these sizes when the mechanic adds a fresh line. */
  tirePrefill: {
    tire_size_front?: string | null;
    tire_size_rear?: string | null;
    front?: { brand?: string | null; model?: string | null } | null;
    rear?: { brand?: string | null; model?: string | null } | null;
  } | null;
}) {
  switch (props.step) {
    case "time_check":
      return (
        <QuestionScreen
          eyebrow={props.bookingLabel}
          question="How did the timing feel?"
          hint="One tap. We use this to tune labor times for this platform."
        >
          <ChipGrid>
            {(
              [
                { value: "faster", label: "Faster than expected" },
                { value: "on_time", label: "About right" },
                { value: "slower", label: "Took longer" },
              ] as const
            ).map((opt) => (
              <Chip
                key={opt.value}
                active={props.timeVariance === opt.value}
                onClick={() => props.setTimeVariance(opt.value)}
              >
                {opt.label}
              </Chip>
            ))}
          </ChipGrid>
        </QuestionScreen>
      );
    case "time_reason":
      return (
        <QuestionScreen
          eyebrow="One quick why"
          question={
            props.timeVariance === "slower"
              ? "What slowed it down?"
              : "What helped it move faster?"
          }
        >
          <ChipGrid>
            {props.timeReasonChoices.map((opt) => (
              <Chip
                key={opt.value}
                active={props.timeReason === opt.value}
                onClick={() => props.setTimeReason(opt.value)}
              >
                {opt.label}
              </Chip>
            ))}
          </ChipGrid>
          {props.timeReason === "other" ? (
            <textarea
              value={props.timeReasonNote}
              onChange={(event) => props.setTimeReasonNote(event.target.value)}
              placeholder="Tell us in a sentence."
              autoFocus
              className="mt-4 min-h-[96px] w-full resize-y rounded-xl border border-primary/15 bg-background px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-primary"
            />
          ) : null}
        </QuestionScreen>
      );
    case "mileage": {
      const parsedCompletion = Number(props.completionMileage);
      const belowBaseline =
        props.baselineMileage != null &&
        props.completionMileage.trim() !== "" &&
        Number.isFinite(parsedCompletion) &&
        parsedCompletion < props.baselineMileage;
      return (
        <QuestionScreen
          eyebrow="Required"
          question="What's the current odometer?"
          hint="Vehicle passport keeps this on the VIN."
        >
          <div
            className={cn(
              "mx-auto flex max-w-md items-center gap-3 rounded-2xl border bg-card px-5 py-4 shadow-[0_1px_2px_rgba(17,24,28,0.04)] transition-colors focus-within:ring-4",
              belowBaseline
                ? "border-destructive/50 focus-within:border-destructive focus-within:ring-destructive/10"
                : "border-primary/15 focus-within:border-primary focus-within:ring-primary/10",
            )}
          >
            <Gauge
              className={cn(
                "h-5 w-5 shrink-0",
                belowBaseline ? "text-destructive/70" : "text-primary/70",
              )}
            />
            <input
              value={
                props.completionMileage
                  ? Number(props.completionMileage).toLocaleString("en-US")
                  : ""
              }
              onChange={(event) =>
                props.setCompletionMileage(
                  event.target.value.replace(/\D+/g, "")
                )
              }
              inputMode="numeric"
              autoFocus
              placeholder="0"
              className="min-w-0 flex-1 bg-transparent text-center text-[32px] font-semibold tabular-nums tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
            />
            <span className="shrink-0 text-[13px] font-medium text-muted-foreground">
              mi
            </span>
          </div>
          {belowBaseline ? (
            <p className="mx-auto mt-3 max-w-md text-center text-[12px] font-medium text-destructive">
              Below the last recorded reading of{" "}
              {props.baselineMileage?.toLocaleString("en-US")} mi. Odometers
              don&apos;t run backward — double-check the number. If the reading
              on file is wrong, it has to be corrected in the vehicle&apos;s
              profile before you can close the job.
            </p>
          ) : null}
          {props.estimatedLaborMinutes ? (
            <div className="mx-auto mt-6 flex max-w-md flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Actual labor time
                <span className="ml-1 text-muted-foreground/60">· optional</span>
              </label>
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-lg border border-primary/15 bg-card pr-3 transition-colors focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
                  <input
                    value={props.actualLaborHours}
                    onChange={(event) =>
                      props.setActualLaborHours(
                        event.target.value.replace(/[^0-9.]/g, "")
                      )
                    }
                    inputMode="decimal"
                    placeholder="0"
                    className="w-20 bg-transparent px-3 py-2 text-right text-[13px] font-medium tabular-nums outline-none placeholder:text-muted-foreground/40"
                  />
                  <span className="text-[11px] text-muted-foreground">hr</span>
                </div>
                <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                  Est. {formatHoursValue(props.estimatedLaborMinutes)}
                </span>
              </div>
            </div>
          ) : null}
        </QuestionScreen>
      );
    }
    case "parts":
      return (
        <PartsStep
          parts={props.parts}
          setParts={props.setParts}
          requiresParts={props.requiresParts}
          partsRequiredServices={props.partsRequiredServices}
          customPartLines={props.customPartLines}
          suggestedParts={props.suggestedParts}
          oemRecommendations={props.oemRecommendations}
          actualPartsCost={props.actualPartsCost}
          setActualPartsCost={props.setActualPartsCost}
          partsCostSum={props.partsCostSum}
          vehicleLabel={props.vehicleLabel}
          engineCode={props.engineCode}
          cycle={props.cycle}
          readOnly={props.readOnlyBilling}
          lockedQuote={props.lockedQuote}
          isTireService={props.isTireService}
          tireOemSizes={props.tireOemSizes}
          tirePrefill={props.tirePrefill}
        />
      );
    case "difficulty":
      return (
        <QuestionScreen
          eyebrow="How was the job?"
          question="Difficulty?"
          hint="1 = much easier. 5 = much harder."
        >
          <div className="flex justify-center gap-2">
            {["1", "2", "3", "4", "5"].map((value) => {
              const active = props.difficultyRating === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => props.setDifficultyRating(value)}
                  className={cn(
                    "flex h-16 w-16 items-center justify-center rounded-2xl border text-[22px] font-semibold transition-all",
                    active
                      ? "border-primary bg-primary text-primary-foreground shadow-sm"
                      : "border-primary/15 bg-background text-foreground hover:bg-primary/5"
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </QuestionScreen>
      );
    case "parts_accuracy":
      return (
        <QuestionScreen
          eyebrow="Were the suggested parts right?"
          question="Parts accuracy"
        >
          <ChipGrid>
            <Chip
              active={props.partsAccuracyStatus === "correct"}
              onClick={() => props.setPartsAccuracyStatus("correct")}
            >
              Correct
            </Chip>
            <Chip
              active={props.partsAccuracyStatus === "different_parts"}
              onClick={() => props.setPartsAccuracyStatus("different_parts")}
            >
              Used different parts
            </Chip>
          </ChipGrid>
          {props.partsAccuracyStatus === "different_parts" ? (
            <textarea
              value={props.partsAccuracyFeedback}
              onChange={(event) =>
                props.setPartsAccuracyFeedback(event.target.value)
              }
              placeholder="Which parts differed?"
              autoFocus
              className="mt-4 min-h-[96px] w-full resize-y rounded-xl border border-primary/15 bg-background px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-primary"
            />
          ) : null}
        </QuestionScreen>
      );
    case "vehicle_updates":
      return (
        <QuestionScreen
          eyebrow="Vehicle passport"
          question="Any updates from what you saw?"
          hint="Skip anything that hasn't changed."
        >
          <div className="space-y-3">
            {props.updatePrompts.map((prompt) => (
              <div
                key={prompt.key}
                className="rounded-xl border border-primary/15 bg-background px-4 py-3"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-foreground">
                      {prompt.label}
                    </p>
                    {prompt.source ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Current source: {passportSourceLabel(prompt.source)}
                      </p>
                    ) : null}
                  </div>
                  {typeof prompt.value === "boolean" ? (
                    <select
                      value={
                        props.vehicleUpdates[prompt.key] === true
                          ? "yes"
                          : props.vehicleUpdates[prompt.key] === false
                            ? "no"
                            : ""
                      }
                      onChange={(event) =>
                        props.setVehicleUpdates((current) => ({
                          ...current,
                          [prompt.key]:
                            event.target.value === ""
                              ? ""
                              : event.target.value === "yes",
                        }))
                      }
                      className="rounded-lg border border-primary/15 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary"
                    >
                      <option value="">Not set</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  ) : prompt.key === "oil_filter_part_number" ? (
                    <OilFilterField
                      value={String(props.vehicleUpdates[prompt.key] ?? "")}
                      onChange={(next) =>
                        props.setVehicleUpdates((current) => ({
                          ...current,
                          [prompt.key]: next,
                        }))
                      }
                    />
                  ) : POSTJOB_FLUID_KIND_BY_KEY[prompt.key as string] ? (
                    <FluidCatalogSelectField
                      value={String(props.vehicleUpdates[prompt.key] ?? "")}
                      onChange={(next) =>
                        props.setVehicleUpdates((current) => ({
                          ...current,
                          [prompt.key]: next,
                        }))
                      }
                      fluidKind={POSTJOB_FLUID_KIND_BY_KEY[prompt.key as string]}
                      vin={props.vin}
                      placeholder={
                        FLUID_PLACEHOLDERS[prompt.key as string]?.placeholder ??
                        "Select…"
                      }
                      otherPlaceholder={
                        FLUID_PLACEHOLDERS[prompt.key as string]
                          ?.otherPlaceholder ?? "Other"
                      }
                    />
                  ) : (
                    <FluidSelectField
                      value={String(props.vehicleUpdates[prompt.key] ?? "")}
                      onChange={(next) =>
                        props.setVehicleUpdates((current) => ({
                          ...current,
                          [prompt.key]: next,
                        }))
                      }
                      options={FLUID_OPTIONS_BY_KEY[prompt.key as string] ?? []}
                      placeholder={
                        FLUID_PLACEHOLDERS[prompt.key as string]?.placeholder ??
                        "Select…"
                      }
                      otherPlaceholder={
                        FLUID_PLACEHOLDERS[prompt.key as string]
                          ?.otherPlaceholder ?? "Other"
                      }
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </QuestionScreen>
      );
    case "findings":
      return (
        <QuestionScreen
          eyebrow="For the customer"
          question="What did you find or do?"
          hint="The driver sees this in their receipt and service history — write it for them, not the shop."
        >
          <textarea
            value={props.mechanicFindings}
            onChange={(event) => props.setMechanicFindings(event.target.value)}
            placeholder='e.g. "Both front pads were down to 3mm and the rotors had a lip, so I replaced the pads and resurfaced the rotors. Everything else looked good."'
            autoFocus
            className="min-h-[140px] w-full resize-y rounded-xl border border-primary/15 bg-background px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-primary"
          />
        </QuestionScreen>
      );
    case "photos":
      return (
        <PhotosStep
          photos={props.photos}
          layoverPhotos={props.layoverPhotos}
          onFilesSelected={props.onFilesSelected}
          updatePhotoCaption={props.updatePhotoCaption}
          removePhoto={props.removePhoto}
        />
      );
    case "tip":
      return (
        <QuestionScreen
          eyebrow="For the next mechanic"
          question="Any tip worth remembering?"
          hint='e.g. "Drain plug slightly worn" · "Customer prefers Mobil 1"'
        >
          <textarea
            value={props.technicianNotes}
            onChange={(event) => props.setTechnicianNotes(event.target.value)}
            placeholder="Optional — a sentence is plenty."
            autoFocus
            className="min-h-[140px] w-full resize-y rounded-xl border border-primary/15 bg-background px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-primary"
          />
        </QuestionScreen>
      );
    case "found_work":
      return (
        <FoundWorkStep
          bookingId={props.bookingId}
          engineId={props.engineId}
          onToast={props.onFoundWorkToast}
          flushRef={props.foundWorkFlushRef}
        />
      );
    case "custom_outcomes":
      return (
        <CustomOutcomesStep
          jobs={props.customJobs ?? []}
          outcomes={props.customJobOutcomes}
          setOutcomes={props.setCustomJobOutcomes}
        />
      );
    case "recommendations":
      return (
        <RecommendationsStep
          recommendations={props.recommendations}
          setRecommendations={props.setRecommendations}
          engineId={props.engineId}
          priorOpenRecommendations={props.priorOpenRecommendations}
          resolvedPriorRecIds={props.resolvedPriorRecIds}
          toggleResolvedPriorRec={props.toggleResolvedPriorRec}
          confirmedThisVisit={props.confirmedThisVisit}
          suggestedFromInspection={props.suggestedFromInspection}
          bookingId={props.bookingId}
          currentWarningLights={props.currentWarningLights}
          clearedWarningLights={props.clearedWarningLights}
          setClearedWarningLights={props.setClearedWarningLights}
          additionalObservations={props.additionalObservations}
          setAdditionalObservations={props.setAdditionalObservations}
          completionMileage={props.completionMileage}
        />
      );
    case "more_gate":
      // The Yes/No actions live in the footer (so they sit where every other
      // primary action does); this screen is just the ask.
      return (
        <QuestionScreen
          eyebrow="Almost done"
          question="Do you have time to answer more questions?"
          hint="The essentials are saved. A few optional questions help us tune labor times and round out the customer's records."
        >
          <p className="text-center text-[12px] leading-relaxed text-muted-foreground">
            Mark the job complete now, or keep going for a few more.
          </p>
        </QuestionScreen>
      );
    case "flag":
      return (
        <QuestionScreen
          eyebrow="Flag for review"
          question="Spotted anything wrong with our vehicle specs?"
        >
          <ChipGrid>
            <Chip
              active={!props.flaggedVehicleSpecs}
              onClick={() => props.setFlaggedVehicleSpecs(false)}
            >
              All good
            </Chip>
            <Chip
              active={props.flaggedVehicleSpecs}
              onClick={() => props.setFlaggedVehicleSpecs(true)}
            >
              Flag for review
            </Chip>
          </ChipGrid>
          {props.flaggedVehicleSpecs ? (
            <textarea
              value={props.flaggedReason}
              onChange={(event) => props.setFlaggedReason(event.target.value)}
              placeholder="What looked off?"
              autoFocus
              className="mt-4 min-h-[96px] w-full resize-y rounded-xl border border-primary/15 bg-background px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-primary"
            />
          ) : null}
        </QuestionScreen>
      );
    case "labor":
      return (
        <LaborStep
          allocations={props.laborAllocations}
          setAllocations={props.setLaborAllocations}
          setTotalHours={props.setActualLaborHours}
          rateCents={props.laborRateCents}
          estimatedLaborMinutes={props.estimatedLaborMinutes}
          baseLabel={props.serviceLabel}
          customJobs={props.customJobs}
        />
      );
    case "summary":
      if (props.cycle && props.liveTotals) {
        return (
          <EstimateSummary
            cycle={props.cycle}
            bookingLabel={props.bookingLabel}
            bookingSubLabel={props.bookingSubLabel}
            parts={props.parts.filter(
              (p) =>
                (p.part_name.trim() !== "" || p.oem_number.trim() !== "") &&
                !p.not_used,
            )}
            laborHours={props.actualLaborHours}
            laborRateCents={props.laborRateCents}
            totals={props.liveTotals}
            quotedTotalCents={props.quotedBaselineTotalCents}
            technicianNotes={props.technicianNotes}
            setTechnicianNotes={props.setTechnicianNotes}
            scopePhotos={props.scopePhotos}
            onScopeFilesSelected={props.onScopeFilesSelected}
            updateScopePhotoCaption={props.updateScopePhotoCaption}
            removeScopePhoto={props.removeScopePhoto}
          />
        );
      }
      return (
        <SummaryStep
          bookingLabel={props.bookingLabel}
          bookingSubLabel={props.bookingSubLabel}
          serviceLabel={props.serviceLabel}
          completionMileage={props.completionMileage}
          timeVariance={props.timeVariance}
          timeReason={props.timeReason}
          difficultyRating={props.difficultyRating}
          partsCount={props.parts.filter((p) => p.part_name.trim()).length}
          photoCount={
            new Set(
              [...props.photos, ...props.layoverPhotos]
                .filter((p) => p.status === "ready" && p.storageId)
                .map((p) => p.storageId),
            ).size
          }
          layoverNotes={props.layoverNotes}
          layoverPhotos={props.layoverPhotos}
          flagged={props.flaggedVehicleSpecs}
        />
      );
  }
}

function LockedNote({
  icon: Icon,
  title,
  body,
  footnote,
}: {
  icon: typeof Lock;
  title: string;
  body: string;
  footnote?: ReactNode;
}) {
  return (
    <div className="mx-auto mb-6 flex w-full max-w-xl gap-3 rounded-xl border border-amber-500/25 bg-amber-50/70 px-4 py-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-amber-900">{title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-amber-900/75">
          {body}
        </p>
        {footnote ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-800/70">
            {footnote}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function QuestionScreen({
  eyebrow,
  question,
  hint,
  children,
}: {
  eyebrow?: string;
  question: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col">
      {eyebrow ? (
        <p className="text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="mt-2.5 text-center text-[22px] font-semibold leading-[1.15] tracking-tight text-foreground sm:text-[26px]">
        {question}
      </h2>
      {hint ? (
        <p className="mx-auto mt-2 max-w-sm text-center text-[12px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <div className="mt-7">{children}</div>
    </div>
  );
}

function ChipGrid({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">{children}</div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center rounded-full border px-4 py-2 text-[13px] font-medium transition-all",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-primary/15 bg-background text-foreground hover:border-primary/30 hover:bg-primary/5"
      )}
    >
      {children}
    </button>
  );
}

function tierLabelOf(tier?: string) {
  switch (tier) {
    case "oem":
      return "OEM";
    case "aftermarket":
      return "Aftermarket";
    case "performance":
      return "Performance";
    case "economy":
      return "Economy";
    default:
      return null;
  }
}

function PartsStep({
  parts,
  setParts,
  requiresParts,
  partsRequiredServices,
  customPartLines = [],
  suggestedParts,
  oemRecommendations,
  actualPartsCost,
  setActualPartsCost,
  partsCostSum,
  vehicleLabel,
  engineCode,
  cycle,
  readOnly,
  lockedQuote,
  isTireService,
  tireOemSizes,
  tirePrefill,
}: {
  parts: PartRowState[];
  setParts: React.Dispatch<React.SetStateAction<PartRowState[]>>;
  requiresParts: boolean;
  // List of services on this booking whose catalog row sets requires_parts.
  // Used by PartsStep to render one parts block per service when length > 1.
  partsRequiredServices: Array<{ _id: string; name: string }>;
  /** Off-catalog lines on this booking. They get their own add-part buttons:
   *  a custom line has no services row, so without this a part fitted to one
   *  was stamped with the first catalog service_id (or nothing) and the
   *  association was lost — which is why the director's cluster read showed
   *  "none" against work that plainly consumed a part. */
  customPartLines?: Array<{ name: string }>;
  suggestedParts: JobActualPartPayload[];
  oemRecommendations: OemRecommendation[];
  actualPartsCost: string;
  setActualPartsCost: (value: string) => void;
  partsCostSum: number;
  vehicleLabel: string | null;
  engineCode: string | null;
  // When set, this dialog is in an approval flow (pre/mid/post). Manual
  // (mechanic-added) part rows may carry an optional justification note.
  cycle?: PostJobSurveyCycle;
  // Billing is locked (post-job completion of a customer-confirmed quote):
  // render parts read-only with the agreed breakdown instead of the editor.
  readOnly?: boolean;
  lockedQuote?: LockedQuote | null;
  // Tire replacement: render the custom TirePartsEditor for tire lines.
  isTireService?: boolean;
  tireOemSizes?: string[];
  tirePrefill?: {
    tire_size_front?: string | null;
    tire_size_rear?: string | null;
    front?: { brand?: string | null; model?: string | null } | null;
    rear?: { brand?: string | null; model?: string | null } | null;
  } | null;
}) {
  const normalizeOem = (n: string) =>
    n.trim().toUpperCase().replace(/\s+/g, "");
  // Tire lines are edited through TirePartsEditor and hidden from the generic
  // parts list below. `tireLines` mirrors the is_tire rows in `parts`; writing
  // back replaces just that subset so non-tire rows (multi-service jobs) keep
  // their positions and index-based edit handlers stay correct.
  // The editor's working set. Kept in local state (not derived from `parts`)
  // so a freshly-added, still-blank axle line survives — blank lines are
  // filtered out when they're written back to `parts` for persistence, which
  // would otherwise make "Add front/rear tires" appear to do nothing.
  const [tireLines, setTireLinesState] = useState<TireLine[]>(() =>
    tireLinesFromParts(parts.filter((p) => isTirePartRow(p))),
  );
  // Adopt tire rows that arrive from an external source (the prejob seed in the
  // parent, or a walk-in's priced snapshot) — but only as the initial fill, so
  // it never clobbers in-progress blank lines the mechanic is editing.
  useEffect(() => {
    const fromParts = tireLinesFromParts(parts.filter((p) => isTirePartRow(p)));
    setTireLinesState((cur) =>
      cur.length === 0 && fromParts.length > 0 ? fromParts : cur,
    );
  }, [parts]);
  // Where tire lines attribute: a booked catalog tire service (service_id) wins;
  // otherwise a mid-job "found work" line named tire replacement (custom
  // line → custom_service_name). Preserves whatever existing tire rows already
  // carry so re-opening the dialog keeps the attribution.
  const tireAttribution = useMemo<{
    serviceId: string | null;
    customName: string | null;
  }>(() => {
    const existing = parts.find((p) => isTirePartRow(p));
    if (existing?.service_id) {
      return { serviceId: existing.service_id, customName: null };
    }
    if (existing?.custom_service_name) {
      return { serviceId: null, customName: existing.custom_service_name };
    }
    const svc = partsRequiredServices.find((s) =>
      isTireReplacementService(s.name),
    );
    if (svc) return { serviceId: svc._id, customName: null };
    const custom = (customPartLines ?? []).find((l) =>
      isTireReplacementService(l.name),
    );
    if (custom) return { serviceId: null, customName: custom.name };
    return {
      serviceId: partsRequiredServices[0]?._id ?? null,
      customName: null,
    };
  }, [parts, partsRequiredServices, customPartLines]);
  function setTireLines(next: TireLine[]) {
    // Keep every line (including blank ones the mechanic is still filling in)
    // in the editor's working set...
    setTireLinesState(next);
    // ...but only persist filled lines onto `parts` (tireLinesToPartPayloads
    // drops blanks) so the booking snapshot never carries an empty tire row.
    const payloads = tireLinesToPartPayloads(next, tireAttribution.serviceId).map(
      (p) => ({
        ...p,
        service_id: tireAttribution.serviceId ?? null,
        custom_service_name: tireAttribution.customName ?? null,
      }),
    );
    setParts((current) => [
      ...current.filter((p) => !isTirePartRow(p)),
      ...buildPartRows(payloads),
    ]);
  }
  const oemRecommendedMap = useMemo(() => {
    const map = new Map<string, OemRecommendationPart>();
    for (const rec of oemRecommendations) {
      for (const part of rec.parts) {
        const key = normalizeOem(part.oem_part_number);
        if (key && !map.has(key)) map.set(key, part);
      }
    }
    return map;
  }, [oemRecommendations]);
  const oemRecommendedSet = useMemo(
    () => new Set(oemRecommendedMap.keys()),
    [oemRecommendedMap],
  );
  const totalRecommended = oemRecommendedSet.size;
  const confirmedRecommended = useMemo(() => {
    const present = new Set<string>();
    for (const p of parts) {
      const key = normalizeOem(p.oem_number ?? "");
      if (key && oemRecommendedSet.has(key)) present.add(key);
    }
    return present.size;
  }, [parts, oemRecommendedSet]);
  // Flattened "Otopair OEM Catalog" picker options — every recommended part
  // across the booking's services, each carrying the resolved service_id so a
  // picked row attributes correctly. Lets the mechanic drop in a catalog part
  // instead of typing it; free-form "Add another part" still covers the rest.
  const catalogOptions = useMemo(() => {
    const opts: Array<{
      key: string;
      part: OemRecommendationPart;
      serviceId: string | null;
    }> = [];
    oemRecommendations.forEach((rec, recIdx) => {
      const serviceId =
        partsRequiredServices.find((s) => s.name === rec.service_name)?._id ??
        partsRequiredServices[0]?._id ??
        null;
      rec.parts.forEach((part, partIdx) => {
        opts.push({ key: `${recIdx}:${partIdx}`, part, serviceId });
      });
    });
    return opts;
  }, [oemRecommendations, partsRequiredServices]);

  // Every place a manually-added part can be attributed: the booking's
  // parts-required catalog services (stamped as service_id) plus any
  // off-catalog custom-job lines (stamped as custom_service_name). Unioning in
  // names already stamped on rows keeps a just-created custom job selectable
  // even if the reactive customPartLines query hasn't caught up yet — otherwise
  // the part could silently land on a catalog service instead of that job.
  const assignTargets = useMemo(() => {
    type Target = {
      key: string;
      label: string;
      serviceId?: string;
      customName?: string;
    };
    const targets: Target[] = [];
    const seen = new Set<string>();
    const push = (t: Target) => {
      if (seen.has(t.key)) return;
      seen.add(t.key);
      targets.push(t);
    };
    for (const svc of partsRequiredServices) {
      push({ key: svc._id, label: svc.name, serviceId: svc._id });
    }
    for (const line of customPartLines) {
      if (!line.name) continue;
      push({ key: `custom:${line.name}`, label: line.name, customName: line.name });
    }
    for (const p of parts) {
      const name = p.custom_service_name;
      if (name) push({ key: `custom:${name}`, label: name, customName: name });
    }
    return targets;
  }, [partsRequiredServices, customPartLines, parts]);

  function addCatalogPart(optionKey: string) {
    const opt = catalogOptions.find((o) => o.key === optionKey);
    if (!opt) return;
    const { part, serviceId } = opt;
    const unit = part.median_price || part.average_price || 0;
    setParts((current) => [
      ...current,
      {
        part_name: part.part_name,
        brand: part.brand ?? "",
        oem_number: part.oem_part_number,
        cost: unit > 0 ? formatFixedCentCurrency(unit) : "0.00",
        quantity:
          part.quantity_needed && part.quantity_needed > 0
            ? part.quantity_needed
            : 1,
        supplied_by: "shop",
        part_tier: part.part_tier ?? "oem",
        service_id: serviceId,
        source: "catalog",
      },
    ]);
  }

  function updatePart(index: number, next: Partial<PartRowState>) {
    setParts((current) =>
      current.map((part, idx) => (idx === index ? { ...part, ...next } : part))
    );
  }

  function adjustQuantity(index: number, delta: number) {
    setParts((current) =>
      current.map((part, idx) =>
        idx === index
          ? { ...part, quantity: Math.max(1, (part.quantity || 1) + delta) }
          : part,
      ),
    );
  }

  const hasFilledPart = parts.some((p) => p.part_name.trim() !== "");
  // Billable shop parts still sitting at $0 — these block Continue (mirrors the
  // parent's canAdvance gate). Customer-supplied and Not-used rows are exempt;
  // the locked/read-only path returns above and never reaches this.
  const unpricedBlockingCount = parts.filter(
    (p) =>
      p.supplied_by !== "customer" &&
      p.not_used !== true &&
      p.part_name.trim() !== "" &&
      (Number(p.cost) || 0) <= 0,
  ).length;
  const prefilled = suggestedParts.length > 0;
  // Step copy adapts on two axes. Prefill: when the cascade pre-loaded
  // suggestions the step is "confirm" — otherwise "tell us." Tense: estimate
  // cycles (pre/mid-job) are forward-looking quotes for work not yet done, so
  // they keep present/future phrasing; the post-job report describes a
  // completed job, so it reads in past tense.
  const isEstimateCycle = cycle === "pre_job" || cycle === "mid_job";
  const eyebrow = prefilled ? "Confirm" : requiresParts ? "Required" : "Optional";
  const question = prefilled
    ? isEstimateCycle
      ? "Confirm parts to use"
      : "Confirm parts used"
    : isEstimateCycle
      ? "What parts are you using?"
      : "What parts did you use?";
  const hint = prefilled
    ? "Verify the inventory planned for this service task."
    : requiresParts
      ? isEstimateCycle
        ? "This service requires parts — please add at least one part to be installed before continuing."
        : "This service requires parts — please add at least one part you installed before continuing."
      : isEstimateCycle
        ? "Add each part to be installed. Skip if none."
        : "Add each part you installed. Skip if none.";

  const [swapIndex, setSwapIndex] = useState<number | null>(null);
  const closeSwap = () => setSwapIndex(null);
  const applySwap = (next: {
    part_name: string;
    oem_number: string;
    brand?: string | null;
    part_tier?: string | null;
  }) => {
    if (swapIndex === null) return;
    const prev = parts[swapIndex];
    // A swap result is by definition a catalog SKU, so lock the row's identity
    // even if the mechanic swapped from a "manual" entry into a known part.
    // Capture the OEM we're swapping FROM so the server can emit a single
    // "swap" audit event and so the learning loop can vote against the prior
    // part for this (vehicle / service) combo.
    const swapFromOem = prev?.oem_number?.trim() || undefined;
    // Don't self-reference if the mechanic re-picked the same OEM somehow.
    const sameOem =
      swapFromOem &&
      swapFromOem.toLowerCase() === next.oem_number.trim().toLowerCase();
    updatePart(swapIndex, {
      part_name: next.part_name,
      oem_number: next.oem_number,
      brand: next.brand ?? "",
      part_tier: next.part_tier ?? "oem",
      source: "catalog",
      swap_from_oem_number: sameOem ? undefined : swapFromOem,
      // Re-enable the row in case it was previously "Not used" — picking a
      // new part means the mechanic is using something here.
      not_used: undefined,
    });
    closeSwap();
  };

  const vehicleBarSubtitle = [vehicleLabel, engineCode]
    .filter((v) => typeof v === "string" && v.trim().length > 0)
    .join(" · ");

  // Locked post-job confirmation: billing was fixed when the customer
  // approved the quote, so the mechanic only verifies what was installed —
  // no price edits, swaps, or overrides. Show the agreed parts → labor →
  // tax/fee → total flow read-only.
  if (readOnly) {
    const usedParts = parts.filter((p) => p.not_used !== true);
    // Per-line breakdown reconciles only when the locked quote carries it
    // (hasBreakdown). In the robust fallback (only the agreed TOTAL is known)
    // we show the total + the summed rows for Parts, and hide labor/tax/fee.
    const showBreakdown = lockedQuote?.hasBreakdown === true;
    const partsCents = showBreakdown
      ? lockedQuote!.partsCents
      : Math.round(partsCostSum * 100);
    const totalCents = lockedQuote
      ? lockedQuote.totalCents
      : Math.round(partsCostSum * 100);
    const originalCents = lockedQuote?.originalTotalCents ?? null;
    const wasAdjusted =
      originalCents != null && originalCents !== totalCents;
    return (
      <QuestionScreen
        eyebrow="Confirm"
        question="Confirm parts used"
        hint="Billing is locked to the customer-approved quote — review only."
      >
        <div className="space-y-3">
          {usedParts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-primary/20 bg-muted/30 px-4 py-6 text-center text-[12px] text-muted-foreground">
              No parts on this quote.
            </div>
          ) : (
            usedParts.map((part, index) => {
              const qty = Math.max(1, part.quantity || 1);
              const unit =
                part.supplied_by === "customer" ? 0 : Number(part.cost) || 0;
              const tierLabel = tierLabelOf(part.part_tier);
              return (
                <div
                  key={index}
                  className="rounded-2xl border border-primary/15 bg-muted/20 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-foreground">
                          {part.part_name}
                        </span>
                        {tierLabel ? (
                          <span className="inline-flex shrink-0 items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-primary">
                            {tierLabel}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {isTirePartRow(part) ? (
                          <span className="text-[11px] text-muted-foreground">
                            {formatPartIdentity(part)}
                          </span>
                        ) : (
                          <CopyableOemNumber
                            value={part.oem_number || ""}
                            className="text-[11px] text-muted-foreground"
                          />
                        )}
                        {qty > 1 ? <span>· qty {qty}</span> : null}
                        {part.supplied_by === "customer" ? (
                          <span>· customer-supplied</span>
                        ) : null}
                      </div>
                    </div>
                    <span className="shrink-0 text-[13px] font-medium tabular-nums text-foreground">
                      ${(unit * qty).toFixed(2)}
                    </span>
                  </div>
                </div>
              );
            })
          )}

          {/* Agreed-quote breakdown: parts → labor → tax/fee → total. */}
          <div className="overflow-hidden rounded-2xl border border-primary/15">
            <div className="space-y-1.5 bg-muted/30 px-4 py-3 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Parts</span>
                <span className="font-medium tabular-nums text-foreground">
                  ${(partsCents / 100).toFixed(2)}
                </span>
              </div>
              {showBreakdown && lockedQuote ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Labor</span>
                    <span className="font-medium tabular-nums text-foreground">
                      ${(lockedQuote.laborCents / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Tax + fee</span>
                    <span className="font-medium tabular-nums text-foreground">
                      $
                      {(
                        (lockedQuote.taxCents + lockedQuote.feeCents) /
                        100
                      ).toFixed(2)}
                    </span>
                  </div>
                </>
              ) : null}
            </div>
            <div className="flex items-center justify-between border-t border-primary/15 bg-primary/5 px-4 py-3">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <Lock className="h-3 w-3" />
                {wasAdjusted ? "New quoted total" : "Quoted total"}
              </span>
              <span className="flex items-baseline gap-2">
                {wasAdjusted && originalCents != null ? (
                  <span className="text-[13px] font-medium tabular-nums text-muted-foreground line-through">
                    ${(originalCents / 100).toFixed(2)}
                  </span>
                ) : null}
                <span className="text-[18px] font-bold tabular-nums text-foreground">
                  ${(totalCents / 100).toFixed(2)}
                </span>
              </span>
            </div>
          </div>
          <p className="text-center text-[11px] text-muted-foreground">
            Parts and labor are locked to what the customer approved. To change
            them, back out and use{" "}
            <span className="font-medium text-foreground">
              Add unforeseen scope
            </span>
            .
          </p>
        </div>
      </QuestionScreen>
    );
  }

  return (
    <QuestionScreen eyebrow={eyebrow} question={question} hint={hint}>
      <div className="space-y-3">
        {prefilled ? (
          <div className="flex items-start gap-2 rounded-xl bg-primary/8 px-3 py-2.5 text-[12px] text-primary">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>Pre-filled from Otopair catalog — confirm or swap.</span>
          </div>
        ) : null}

        {requiresParts && !hasFilledPart ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            This service is flagged as requiring parts. Add at least one part below to continue.
          </div>
        ) : null}

        {unpricedBlockingCount > 0 ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            {unpricedBlockingCount === 1
              ? "1 part is still unpriced. Enter its price — or swap it, mark it Not used, or remove it — to continue."
              : `${unpricedBlockingCount} parts are still unpriced. Enter each price — or swap, mark Not used, or remove them — to continue.`}
          </div>
        ) : null}

        {isTireService && !readOnly ? (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Tires
            </p>
            <TirePartsEditor
              value={tireLines}
              onChange={setTireLines}
              oemSizes={tireOemSizes}
            />
          </div>
        ) : null}

        {!parts.some((p) => !isTirePartRow(p)) ? (
          // Empty state is only for non-tire parts; when this is a tire service
          // the editor above already covers the lines.
          isTireService ? null : (
            <div className="rounded-xl border border-dashed border-primary/20 bg-muted/30 px-4 py-6 text-center text-[12px] text-muted-foreground">
              No parts added yet.
            </div>
          )
        ) : (
          parts.map((part, index) => {
            // Tire lines are edited in TirePartsEditor above; returning null
            // keeps `index` aligned for the remaining rows' updatePart calls.
            if (isTirePartRow(part)) return null;
            const isCustomer = part.supplied_by === "customer";
            const isNotUsed = part.not_used === true;
            const tierLabel = tierLabelOf(part.part_tier);
            const qty = Math.max(1, part.quantity || 1);
            const oemKey = normalizeOem(part.oem_number ?? "");
            const oemRec = oemKey.length > 0 ? oemRecommendedMap.get(oemKey) : undefined;
            const isOemRecommended = !!oemRec;
            const sourcesUsed = oemRec?.price_sources_used ?? 0;
            const avgPrice = oemRec?.average_price ?? 0;
            const medianPrice = oemRec?.median_price ?? 0;
            // A shop-supplied row that resolved to $0 — the catalog had no
            // trustworthy price for this part (e.g. every source was
            // discount-typed and got filtered out of the aggregate). Surface it
            // as "unpriced" and prompt the mechanic to set the real price,
            // rather than letting the line silently bill $0.
            const costNum = Number(part.cost) || 0;
            const isUnpriced = !isCustomer && costNum <= 0;
            // Identity (name / brand / OEM number) is locked when the row was
            // seeded from the catalog. Mechanic-added "manual" rows stay fully
            // editable. Falls back to isOemRecommended for legacy rows that
            // were saved before `source` existed.
            const isCatalogRow =
              part.source === "catalog" ||
              (part.source === undefined && isOemRecommended);
            const lockedFieldClasses =
              "h-8 min-w-0 flex-1 truncate rounded-md bg-muted/40 px-2 py-1.5 text-[13px] font-semibold leading-tight text-foreground";
            const lockedSmallClasses =
              "h-7 truncate rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-foreground";
            // Provenance badge — surfaces *why* this row was suggested so the
            // mechanic can trust (or override) the prefill at a glance.
            const learnedFromLabel: string | null = (() => {
              switch (part.learned_from) {
                case "vin":
                  return "Used last time on this car";
                case "shop":
                  return "Shop default";
                case "config":
                  return "Common for this model";
                default:
                  return null;
              }
            })();
            return (
              <div
                key={index}
                className={cn(
                  "rounded-2xl border border-primary/15 bg-background px-3 py-3 transition-opacity",
                  isNotUsed && "opacity-60",
                )}
              >
                {/* Top: name + tier chip on the left, quantity stepper on the right */}
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Part name
                    </span>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      {isCatalogRow ? (
                        <span
                          className={lockedFieldClasses}
                          title="From catalog — swap the part to change its identity."
                        >
                          {part.part_name}
                        </span>
                      ) : (
                        <input
                          value={part.part_name}
                          onChange={(event) =>
                            updatePart(index, { part_name: event.target.value })
                          }
                          placeholder="Part name"
                          className="h-8 min-w-0 flex-1 rounded-md border border-primary/10 bg-background px-2 text-[13px] font-semibold leading-tight text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground focus:border-primary/30"
                        />
                      )}
                      {isOemRecommended ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-primary"
                          title="Matches the OEM part Otopair has on file for this car"
                        >
                          OEM
                        </span>
                      ) : null}
                      {tierLabel ? (
                        <span className="inline-flex shrink-0 items-center rounded-md bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          {tierLabel}
                        </span>
                      ) : null}
                      {isNotUsed ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-800"
                          title="Mechanic flagged this part as not used on this job"
                        >
                          Not used
                        </span>
                      ) : null}
                    </div>
                    {learnedFromLabel ? (
                      <p
                        className="mt-1 text-[10px] italic text-muted-foreground"
                        title="Where this suggestion came from"
                      >
                        {learnedFromLabel}
                      </p>
                    ) : null}
                    {/*
                      "For:" selector — attribute this part to a catalog service
                      or an off-catalog custom job. Only rendered when there's a
                      real choice (≥2 targets); single-target bookings auto-stamp
                      via the add buttons below. Writes service_id /
                      custom_service_name mutually exclusively so completion
                      groups the part under the intended work.
                    */}
                    {!readOnly && assignTargets.length >= 2 ? (
                      <div className="mt-2 flex items-center gap-1.5">
                        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          For
                        </span>
                        <Select
                          aria-label="Assign this part to a service"
                          selectedKey={
                            part.custom_service_name
                              ? `custom:${part.custom_service_name}`
                              : part.service_id ?? null
                          }
                          onSelectionChange={(key) => {
                            if (key == null) return;
                            const target = assignTargets.find(
                              (t) => t.key === String(key),
                            );
                            if (!target) return;
                            updatePart(index, {
                              service_id: target.serviceId ?? null,
                              custom_service_name: target.customName ?? null,
                            });
                          }}
                          placeholder="Choose service"
                        >
                          <SelectTrigger className="inline-flex h-7 w-auto max-w-full items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-2.5 py-1 text-[11px] font-medium text-primary/90">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopover
                            placement="bottom start"
                            className="w-[18rem] max-w-[calc(100vw-2rem)]"
                          >
                            <SelectListBox shouldFocusWrap className="p-1.5">
                              {assignTargets.map((t) => (
                                <SelectItem
                                  key={t.key}
                                  id={t.key}
                                  textValue={t.label}
                                  className="rounded-lg px-3 py-2 text-[13px] data-[selected]:bg-transparent data-[selected]:text-foreground"
                                >
                                  {t.label}
                                </SelectItem>
                              ))}
                            </SelectListBox>
                          </SelectPopover>
                        </Select>
                      </div>
                    ) : null}
                    {/* Brand + part number, compact and inline */}
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      <div className="min-w-0">
                        <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          Brand
                        </span>
                        {isCatalogRow ? (
                          <span
                            className={`${lockedSmallClasses} mt-0.5 block`}
                            title="From catalog — swap the part to change its brand."
                          >
                            {part.brand || "—"}
                          </span>
                        ) : (
                          <input
                            value={part.brand}
                            onChange={(event) =>
                              updatePart(index, { brand: event.target.value })
                            }
                            placeholder="Brand"
                            className="mt-0.5 h-7 w-full rounded-md border border-primary/10 bg-background px-2 text-[11px] outline-none focus:border-primary/30"
                          />
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          Part number
                        </span>
                        {isCatalogRow ? (
                          <CopyableOemNumber
                            value={part.oem_number || ""}
                            className={cn(
                              lockedSmallClasses,
                              "mt-0.5 flex w-full items-center justify-between",
                            )}
                          />
                        ) : (
                          <input
                            value={part.oem_number}
                            onChange={(event) =>
                              updatePart(index, { oem_number: event.target.value })
                            }
                            placeholder="Part number"
                            className="mt-0.5 h-7 w-full rounded-md border border-primary/10 bg-background px-2 text-[11px] outline-none focus:border-primary/30"
                          />
                        )}
                      </div>
                    </div>
                    {/* Otopair price line / cost editor — suppressed when the
                        mechanic flagged the row Not used; price doesn't apply
                        when the part didn't go in. */}
                    {!isNotUsed &&
                      (isCustomer ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                          <span className="text-muted-foreground">
                            Customer-supplied:
                          </span>
                          <span className="font-medium text-muted-foreground">$0</span>
                        </div>
                      ) : (
                        // Keep the price input mounted in a fixed position across
                        // the unpriced→priced transition — the fixed-cent input
                        // flips cost > 0 on the first digit, so remounting it
                        // would steal focus mid-type. Only the warning banner and
                        // styling toggle on `isUnpriced`.
                        <div className="mt-2 space-y-1.5">
                          {isUnpriced ? (
                            <div className="flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5">
                              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                              <div className="min-w-0">
                                <span className="text-[12px] font-semibold text-amber-800">
                                  This part is unpriced
                                </span>
                                <p className="text-[11px] leading-snug text-amber-700">
                                  Otopair doesn&apos;t have a price on file — enter the
                                  price per unit you&apos;re charging.
                                </p>
                              </div>
                            </div>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-2 text-[12px]">
                            <span
                              className={
                                isUnpriced
                                  ? "font-medium text-amber-800"
                                  : "text-muted-foreground"
                              }
                            >
                              Price per unit:
                            </span>
                            <div className="flex items-center gap-1">
                              <span
                                className={
                                  isUnpriced ? "text-amber-800" : "text-muted-foreground"
                                }
                              >
                                $
                              </span>
                              <FixedCentCurrencyInput
                                value={part.cost}
                                onValueChange={(value) =>
                                  updatePart(index, {
                                    cost: value,
                                  })
                                }
                                placeholder={
                                  medianPrice > 0
                                    ? medianPrice.toFixed(2)
                                    : avgPrice > 0
                                      ? avgPrice.toFixed(2)
                                      : "0.00"
                                }
                                title={
                                  isOemRecommended && sourcesUsed > 0 && medianPrice > 0
                                    ? `Otopair median $${medianPrice.toFixed(2)} across ${sourcesUsed} source${sourcesUsed === 1 ? "" : "s"}`
                                    : isOemRecommended && sourcesUsed > 0 && avgPrice > 0
                                      ? `Otopair average $${avgPrice.toFixed(2)} across ${sourcesUsed} source${sourcesUsed === 1 ? "" : "s"}`
                                      : undefined
                                }
                                className={cn(
                                  "h-6 rounded-md border bg-background px-1.5 text-[12px] font-medium tabular-nums outline-none",
                                  isUnpriced
                                    ? "w-24 border-amber-400 text-amber-900 focus:border-amber-500"
                                    : "w-20 border-primary/10 focus:border-primary/30",
                                )}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                  {/* Quantity stepper — hidden alongside the price input when
                      the row is flagged Not used. */}
                  {!isNotUsed && (
                  <div className="inline-flex items-center gap-0 rounded-full border border-primary/15 bg-background">
                    <button
                      type="button"
                      onClick={() => adjustQuantity(index, -1)}
                      aria-label="Decrease quantity"
                      disabled={qty <= 1}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors enabled:hover:bg-primary/5 enabled:hover:text-foreground disabled:opacity-30"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-6 text-center text-[13px] font-semibold tabular-nums">
                      {qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => adjustQuantity(index, 1)}
                      aria-label="Increase quantity"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  )}
                </div>

                {/* Optional note on an editable (manual) row. Shown via the same
                    `!isCatalogRow` heuristic that makes identity fields editable.
                    Never required — a mechanic can leave it blank and still
                    submit; when filled it's kept in the payment audit trail. */}
                {!isCatalogRow && !isCustomer && !isNotUsed && (
                    <div className="mt-2.5">
                      <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        Why this part?{" "}
                        <span className="font-normal normal-case text-muted-foreground/80">
                          (optional)
                        </span>
                      </span>
                      <textarea
                        value={part.justification_text ?? ""}
                        onChange={(event) =>
                          updatePart(index, {
                            justification_text: event.target.value,
                          })
                        }
                        placeholder="Add a note if useful (vehicle condition, OEM unavailable, customer request, etc.)"
                        rows={2}
                        className="mt-1 w-full resize-y rounded-md border border-primary/10 bg-background px-2 py-1.5 text-[12px] leading-snug text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/30"
                      />
                    </div>
                  )}

                {/* Footer row: Swap | Remove | Customer-supplied toggle.
                    Swap is hidden on blank rows (no part name yet) — it's only
                    useful once you have an item to swap. */}
                <div className="mt-3 flex items-center justify-between border-t border-primary/10 pt-2.5 text-[12px]">
                  <div className="flex items-center gap-3">
                    {part.part_name.trim() !== "" ? (
                      <button
                        type="button"
                        onClick={() => setSwapIndex(index)}
                        className="inline-flex items-center gap-1.5 rounded-md text-foreground transition-colors hover:text-primary"
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                        <span className="font-medium">Swap part</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        setParts((current) => current.filter((_, idx) => idx !== index))
                      }
                      className="inline-flex items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Remove</span>
                    </button>
                    {/* "Not used" — captures the deliberate signal "this part
                        was suggested but I'm not installing it on this car"
                        without deleting the row. Drives the demote loop on
                        shop+config and per-VIN preferences. Mutually
                        exclusive with Customer supplied. */}
                    <button
                      type="button"
                      onClick={() =>
                        updatePart(index, {
                          not_used: isNotUsed ? undefined : true,
                          // Mutually exclusive with customer-supplied.
                          supplied_by: isNotUsed
                            ? part.supplied_by
                            : "shop",
                        })
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md transition-colors",
                        isNotUsed
                          ? "font-semibold text-amber-700 hover:text-amber-800"
                          : "text-muted-foreground hover:text-amber-700",
                      )}
                      aria-pressed={isNotUsed}
                      title={
                        isNotUsed
                          ? "Click to un-flag — the part will count as used."
                          : "Mark this prefilled part as not used on this job. Logs the signal for learning without deleting the row."
                      }
                    >
                      <Ban className="h-3.5 w-3.5" />
                      <span>{isNotUsed ? "Marked Not used" : "Not used"}</span>
                    </button>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                    <span className="text-[11px] text-muted-foreground">
                      Customer supplied
                    </span>
                    <span
                      role="switch"
                      aria-checked={isCustomer}
                      tabIndex={0}
                      onClick={() =>
                        updatePart(index, {
                          supplied_by: isCustomer ? "shop" : "customer",
                          // Mutually exclusive with Not used — toggling
                          // customer-supplied on implies the part WAS used
                          // (just provided by the driver).
                          not_used: !isCustomer ? undefined : part.not_used,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          updatePart(index, {
                            supplied_by: isCustomer ? "shop" : "customer",
                            not_used: !isCustomer ? undefined : part.not_used,
                          });
                        }
                      }}
                      className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                        isCustomer ? "bg-primary" : "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 transform rounded-full bg-background shadow-sm transition-transform",
                          isCustomer ? "translate-x-4" : "translate-x-0.5",
                        )}
                      />
                    </span>
                  </label>
                </div>
              </div>
            );
          })
        )}

        {/*
          Otopair OEM Catalog picker — drop in a recommended part for this
          vehicle/service with its price prefilled. Selecting acts as an "add";
          the dropdown resets so it can be used repeatedly. Free-form rows below
          cover anything not in the catalog.
        */}
        {!readOnly && catalogOptions.length > 0 ? (
          <Select
            aria-label="Add from Otopair OEM Catalog"
            selectedKey={null}
            onSelectionChange={(key) => {
              if (key != null) addCatalogPart(String(key));
            }}
            placeholder="+ Otopair OEM Catalog"
          >
            <SelectTrigger className="inline-flex w-auto items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-[12px] font-medium text-primary">
              <SelectValue />
            </SelectTrigger>
            {/* Fixed, roomy width instead of the trigger's pill width — the
                default `w-(--trigger-width)` squeezed every part name onto three
                wrapped lines. Two-line rows (name, then OEM # · price) read far
                cleaner than one ` · `-joined string. */}
            <SelectPopover
              placement="bottom start"
              className="w-[24rem] max-w-[calc(100vw-2rem)]"
            >
              <SelectListBox shouldFocusWrap className="p-1.5">
                {catalogOptions.map((o) => {
                  const unit = o.part.median_price || o.part.average_price || 0;
                  const meta = [
                    o.part.oem_part_number || null,
                    unit > 0 ? `$${unit.toFixed(2)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const label = `${o.part.part_name}${meta ? ` · ${meta}` : ""}`;
                  return (
                    <SelectItem
                      key={o.key}
                      id={o.key}
                      textValue={label}
                      className="flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 data-[selected]:bg-transparent data-[selected]:text-foreground"
                    >
                      <span className="text-[13px] font-medium leading-snug text-foreground">
                        {o.part.part_name}
                      </span>
                      {meta ? (
                        <span className="text-[11px] leading-snug text-muted-foreground">
                          {meta}
                        </span>
                      ) : null}
                    </SelectItem>
                  );
                })}
              </SelectListBox>
            </SelectPopover>
          </Select>
        ) : null}

        {/*
          Add-row controls. For multi-service bookings each parts-required
          service gets its own button so the new row is stamped with the
          right service_id and snapshots attribute correctly downstream.
        */}
        {partsRequiredServices.length + customPartLines.length > 1 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {/* One button per off-catalog line, stamping the line's NAME rather
                than a service id — that name is the key completion groups parts
                by when it writes them onto custom_jobs. */}
            {customPartLines.map((line) => (
              <button
                key={`custom-${line.name}`}
                type="button"
                onClick={() =>
                  setParts((current) => [
                    ...current,
                    {
                      part_name: "",
                      brand: "",
                      oem_number: "",
                      cost: "0.00",
                      quantity: 1,
                      supplied_by: "shop",
                      part_tier: "oem",
                      service_id: null,
                      custom_service_name: line.name,
                      source: "manual",
                    },
                  ])
                }
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add part for {line.name}</span>
              </button>
            ))}
            {partsRequiredServices.map((svc) => (
              <button
                key={svc._id}
                type="button"
                onClick={() =>
                  setParts((current) => [
                    ...current,
                    {
                      part_name: "",
                      brand: "",
                      oem_number: "",
                      cost: "0.00",
                      quantity: 1,
                      supplied_by: "shop",
                      part_tier: "oem",
                      service_id: svc._id,
                      source: "manual",
                    },
                  ])
                }
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add part for {svc.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() =>
              setParts((current) => [
                ...current,
                {
                  part_name: "",
                  brand: "",
                  oem_number: "",
                  cost: "0.00",
                  quantity: 1,
                  supplied_by: "shop",
                  part_tier: "oem",
                  service_id: partsRequiredServices[0]?._id ?? null,
                  // Sole line is off-catalog — attribute the part to it rather
                  // than leaving it unattached to anything.
                  custom_service_name:
                    partsRequiredServices.length === 0 &&
                    customPartLines.length === 1
                      ? customPartLines[0].name
                      : undefined,
                  source: "manual",
                },
              ])
            }
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <Plus className="h-3.5 w-3.5" />
            Add another part
          </button>
        )}

        {totalRecommended > 0 ? (
          <div className="rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-[11px] text-foreground">
            <span className="font-semibold">{confirmedRecommended}</span>
            <span className="text-muted-foreground"> of </span>
            <span className="font-semibold">{totalRecommended}</span>
            <span className="text-muted-foreground">
              {" "}
              OEM-recommended part{totalRecommended === 1 ? "" : "s"} confirmed
              {confirmedRecommended < totalRecommended
                ? " — swap any rows that aren't what you're using."
                : "."}
            </span>
          </div>
        ) : null}

        {/* Pinned vehicle-identified + total parts footer */}
        <div className="mt-2 flex items-center justify-between gap-3 rounded-2xl border border-primary/10 bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-background text-muted-foreground">
              <Car className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Vehicle identified
              </p>
              <p className="truncate text-[11px] font-medium text-foreground">
                {vehicleBarSubtitle || "—"}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Total parts
            </p>
            <p className="text-[14px] font-semibold tabular-nums text-foreground">
              ${partsCostSum.toFixed(2)}
            </p>
          </div>
        </div>

        {/* Override the auto-summed parts cost if the shop charges differently. */}
        <div className="flex items-center justify-between rounded-xl bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          <div className="flex flex-col">
            <span>Override total (optional)</span>
            <span className="text-[10px]">Auto sum: ${partsCostSum.toFixed(2)}</span>
          </div>
          <input
            value={actualPartsCost}
            onChange={(event) => setActualPartsCost(event.target.value)}
            placeholder={partsCostSum.toFixed(2)}
            inputMode="decimal"
            className="w-24 rounded-lg border border-primary/15 bg-background px-2 py-1.5 text-right text-[12px] outline-none focus:border-primary"
          />
        </div>
      </div>

      {swapIndex !== null ? (
        <SwapPartModal
          onClose={closeSwap}
          onPick={applySwap}
          initialQuery={parts[swapIndex]?.oem_number || parts[swapIndex]?.part_name || ""}
        />
      ) : null}
    </QuestionScreen>
  );
}

/**
 * Modal picker against the canonical oem_parts catalog. Used by the "Swap
 * part" action on each parts-row footer. Otopair currently supplies OEM only,
 * but the search query already ranks OEM-tier first so future tiers slot in
 * cleanly. The mechanic sees brand + name + part number; on pick, those plus
 * the part_tier propagate back to the row.
 */
function SwapPartModal({
  onClose,
  onPick,
  initialQuery,
}: {
  onClose: () => void;
  onPick: (next: {
    part_name: string;
    oem_number: string;
    brand?: string | null;
    part_tier?: string | null;
  }) => void;
  initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const results = useQuery(api.oemParts.search, {
    query,
    limit: 25,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Swap part"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-foreground/40 px-3 pb-3 sm:items-center sm:pb-0"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-primary/10 bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-primary/10 px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Swap part
            </p>
            <p className="text-[13px] font-semibold">Pick from the catalog</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-primary/10 px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-primary/15 bg-background px-2.5 py-2 focus-within:border-primary">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by part number, name, or brand…"
              autoFocus
              className="flex-1 bg-transparent text-[13px] outline-none"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {results === undefined ? (
            <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted-foreground">
              No catalog matches. Try a different query, or type the part in directly.
            </div>
          ) : (
            <ul className="space-y-1">
              {results.map((part) => {
                const tierLabel = tierLabelOf(part.part_tier ?? "oem");
                return (
                  <li key={part._id}>
                    <button
                      type="button"
                      onClick={() =>
                        onPick({
                          part_name: part.name ?? "",
                          oem_number: part.oem_part_number ?? "",
                          brand: part.brand ?? null,
                          part_tier: part.part_tier ?? "oem",
                        })
                      }
                      className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-primary/15 hover:bg-primary/5"
                    >
                      <div className="flex w-full items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-foreground">
                          {part.name}
                        </span>
                        {tierLabel ? (
                          <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                            {tierLabel}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex w-full items-center gap-2 text-[11px] text-muted-foreground">
                        {part.brand ? <span>{part.brand}</span> : null}
                        {part.brand && part.oem_part_number ? (
                          <span aria-hidden>·</span>
                        ) : null}
                        {part.oem_part_number ? (
                          <span className="font-mono">{part.oem_part_number}</span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function PhotosStep({
  photos,
  layoverPhotos,
  onFilesSelected,
  updatePhotoCaption,
  removePhoto,
}: {
  photos: PhotoState[];
  /** Photos the mechanic already added in the active-job overlay. Shown here
   *  read-only so they don't re-add them; merged into the report at submit. */
  layoverPhotos: PhotoState[];
  onFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  updatePhotoCaption: (id: string, caption: string) => void;
  removePhoto: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const layoverReadyPhotos = layoverPhotos.filter(
    (photo) => photo.status === "ready" && photo.previewUrl,
  );
  // The 6-photo cap is across both sets, since the layover photos are carried
  // into the same report.
  const canAddMore = photos.length + layoverReadyPhotos.length < 6;

  return (
    <QuestionScreen
      eyebrow="Optional"
      question="Snap a few photos of the work"
      hint="Like a delivery photo — customers see this in their job history. Up to 6."
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        onChange={onFilesSelected}
        className="hidden"
      />
      {layoverReadyPhotos.length > 0 ? (
        <div className="mb-5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            From the active job
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {layoverReadyPhotos.map((photo) => (
              <div
                key={photo.id}
                className="relative overflow-hidden rounded-xl border border-primary/15 bg-background"
                title={photo.caption || undefined}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.previewUrl}
                  alt=""
                  className="aspect-square w-full object-cover"
                />
                {photo.caption ? (
                  <p className="truncate border-t border-primary/10 bg-background/80 px-2 py-1.5 text-[11px] text-muted-foreground">
                    {photo.caption}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground/80">
            Carried over from what you shot while working — no need to re-add
            these.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((photo) => (
          <div
            key={photo.id}
            className="group relative overflow-hidden rounded-xl border border-primary/15 bg-background"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.previewUrl}
              alt=""
              className="aspect-square w-full object-cover"
            />
            {photo.status === "uploading" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 className="h-5 w-5 animate-spin text-white" />
              </div>
            ) : null}
            {photo.status === "error" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-destructive/70 text-[11px] font-medium text-white">
                Failed
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => removePhoto(photo.id)}
              className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-90 transition-opacity hover:opacity-100"
              aria-label="Remove photo"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <input
              value={photo.caption}
              onChange={(event) =>
                updatePhotoCaption(photo.id, event.target.value)
              }
              placeholder="Add caption"
              className="block w-full border-t border-primary/10 bg-background/80 px-2 py-1.5 text-[11px] outline-none focus:bg-background"
            />
          </div>
        ))}
        {canAddMore ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-primary/25 bg-primary/5 text-primary transition-colors hover:bg-primary/10"
          >
            <Camera className="h-5 w-5" />
            <span className="text-[11px] font-medium">Add photo</span>
          </button>
        ) : null}
      </div>
    </QuestionScreen>
  );
}

// Common "next interval" jumps for a follow-up's mileage trigger. Added onto
// the car's current odometer so the mechanic never does the arithmetic.
const MILEAGE_INCREMENTS = [3000, 5000, 10000] as const;

/**
 * A follow-up's default mileage trigger: the car's current odometer plus one
 * service interval (+5k). Never below the current reading, and the +5k is
 * already done so the mechanic doesn't have to. Empty when the odometer is
 * unknown (walk-ins / missing passport) — the field then falls back to exact
 * entry with no default.
 */
function defaultTriggerMileage(
  currentOdometer: number | null | undefined,
): string {
  if (
    currentOdometer == null ||
    !Number.isFinite(currentOdometer) ||
    currentOdometer <= 0
  ) {
    return "";
  }
  return String(Math.round(currentOdometer) + 5000);
}

/**
 * Trigger-at-mileage picker for a follow-up recommendation. Two ways to land on
 * the same absolute odometer target:
 *   • "At mileage" — type the exact reading it's due at.
 *   • "+ Miles"    — pick how far ahead (e.g. +5,000); we add it to the car's
 *                    current odometer so the mechanic never does the math.
 * The current odometer is the floor — a follow-up can't come due before now — so
 * exact entries clamp up to it on blur and relative jumps add on top of it.
 * `value` is the absolute mileage stored on the row; this only offers two ways
 * to arrive at it. When the odometer is unknown, relative mode is hidden.
 */
function MileageTriggerField({
  value,
  onChange,
  currentOdometer,
}: {
  value: string;
  onChange: (next: string) => void;
  currentOdometer: number | null;
}) {
  const floor =
    currentOdometer != null &&
    Number.isFinite(currentOdometer) &&
    currentOdometer > 0
      ? Math.round(currentOdometer)
      : null;
  const absolute = Number(value);
  const hasAbsolute =
    value.trim() !== "" && Number.isFinite(absolute) && absolute > 0;
  const activeDelta =
    floor != null && hasAbsolute && absolute > floor ? absolute - floor : null;
  const belowFloor = floor != null && hasAbsolute && absolute < floor;
  const canUseRelative = floor != null;

  // A follow-up defaulted to current + 5k opens in "+ Miles" so the jump the
  // mechanic will most often reach for is already in front of them.
  const [mode, setMode] = useState<"exact" | "relative">(
    canUseRelative && (activeDelta != null || !hasAbsolute) ? "relative" : "exact",
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Trigger at mileage
        </label>
        {canUseRelative ? (
          <div className="inline-flex rounded-md border border-primary/15 p-0.5">
            {(
              [
                ["relative", "+ Miles"],
                ["exact", "Exact"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors",
                  mode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {mode === "relative" && floor != null ? (
        <div className="mt-1 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {MILEAGE_INCREMENTS.map((inc) => {
              const active = activeDelta === inc;
              return (
                <button
                  key={inc}
                  type="button"
                  onClick={() => onChange(String(floor + inc))}
                  className={cn(
                    "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-primary/15 bg-background text-foreground hover:bg-primary/5",
                  )}
                >
                  +{inc.toLocaleString()}
                </button>
              );
            })}
            {value.trim() ? (
              <button
                type="button"
                onClick={() => onChange("")}
                className="inline-flex items-center rounded-full border border-primary/15 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-all hover:bg-primary/5"
              >
                Clear
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {hasAbsolute && absolute > floor
              ? `Due at ${absolute.toLocaleString()} mi — ${floor.toLocaleString()} + ${(activeDelta ?? absolute - floor).toLocaleString()}`
              : `Adds onto the current ${floor.toLocaleString()} mi`}
          </p>
        </div>
      ) : (
        <>
          <div
            className={cn(
              "mt-1 flex items-center gap-1.5 rounded-lg border bg-background px-2.5",
              belowFloor ? "border-destructive/50" : "border-primary/15",
            )}
          >
            <Gauge
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            <input
              type="number"
              inputMode="numeric"
              min={floor ?? 0}
              step={1000}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onBlur={() => {
                // Odometers don't run backward — clamp a below-floor entry up to
                // the current reading rather than silently rejecting it.
                if (belowFloor && floor != null) onChange(String(floor));
              }}
              placeholder={floor != null ? floor.toLocaleString() : "e.g. 170000"}
              className="h-9 w-full bg-transparent text-[12px] outline-none"
            />
            <span className="text-[11px] text-muted-foreground">mi</span>
          </div>
          {belowFloor && floor != null ? (
            <p className="mt-1 text-[10px] text-destructive">
              Can&apos;t be below the current {floor.toLocaleString()} mi.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Replaces the old "Anything else to note?" textarea with structured
 * recommendations. Each row captures {service, urgency, reason, visible}
 * so the rec gets a real lifecycle on the backend. Mechanics who want to
 * type unstructured prose still can — via the demoted private-note details
 * block below the cards.
 */
function RecommendationsStep({
  recommendations,
  setRecommendations,
  engineId,
  priorOpenRecommendations,
  resolvedPriorRecIds,
  toggleResolvedPriorRec,
  confirmedThisVisit,
  suggestedFromInspection,
  bookingId,
  currentWarningLights,
  clearedWarningLights,
  setClearedWarningLights,
  additionalObservations,
  setAdditionalObservations,
  completionMileage,
}: {
  recommendations: RecRowState[];
  setRecommendations: React.Dispatch<React.SetStateAction<RecRowState[]>>;
  engineId: string | null;
  priorOpenRecommendations: PriorOpenRecommendation[];
  /** Which prior recs the mechanic has marked done this visit (keyed by _id). */
  resolvedPriorRecIds: Record<string, boolean>;
  toggleResolvedPriorRec: (id: string) => void;
  confirmedThisVisit: ConfirmedThisVisitRecommendation[];
  suggestedFromInspection: SuggestedFromInspection[];
  bookingId: string | null;
  currentWarningLights: string[];
  clearedWarningLights: string[];
  setClearedWarningLights: React.Dispatch<React.SetStateAction<string[]>>;
  additionalObservations: string;
  setAdditionalObservations: (value: string) => void;
  completionMileage: string;
}) {
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const [slotPickerIndex, setSlotPickerIndex] = useState<number | null>(null);
  const [optionPickerIndex, setOptionPickerIndex] = useState<number | null>(null);
  const [tirePickerIndex, setTirePickerIndex] = useState<number | null>(null);
  const currentMileage = Number(completionMileage);

  const confirmFromPreJob = useMutation(api.jobRecommendations.confirmFromPreJob);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  async function handleUndoConfirmed(recId: string) {
    if (!bookingId || undoingId) return;
    setUndoingId(recId);
    try {
      await confirmFromPreJob({
        bookingId: bookingId as Id<"bookings">,
        confirmations: [
          {
            recommendation_id: recId as Id<"job_recommendations">,
            outcome: "dismissed",
            dismissed_reason: "mistake",
          },
        ],
      });
    } finally {
      setUndoingId(null);
    }
  }

  function updateRec(index: number, patch: Partial<RecRowState>) {
    setRecommendations((current) =>
      current.map((rec, idx) => (idx === index ? { ...rec, ...patch } : rec)),
    );
  }

  function addRec() {
    setRecommendations((current) => [
      ...current,
      {
        id: makeRecId(),
        recommended_service_id: null,
        service_label: "",
        service_slug: null,
        service_has_options: false,
        freeform_service_name: "",
        urgency: "within_3_months",
        reason: "",
        visible_to_driver: true,
        target_mileage: defaultTriggerMileage(currentMileage),
        scheduled_at: null,
        scheduled_mechanic_id: null,
        scheduled_mechanic_name: null,
        selected_service_option: null,
        tire_specs: null,
      },
    ]);
  }

  function removeRec(index: number) {
    setRecommendations((current) => current.filter((_, idx) => idx !== index));
  }

  // Gap 2 — a suggestion the mechanic saw at pre-job but didn't check gets a
  // second chance here. Checking it appends a real row to `recommendations`
  // (tagged by a stable `sugg_<key>` id so the checkbox state round-trips);
  // unchecking removes that same row. Submits through the same
  // submitRecommendationsForBooking path as every other row on this screen.
  function suggestionRowId(key: string) {
    return `sugg_${key}`;
  }
  function toggleSuggestion(s: SuggestedFromInspection) {
    const id = suggestionRowId(s.key);
    setRecommendations((current) => {
      if (current.some((r) => r.id === id)) {
        return current.filter((r) => r.id !== id);
      }
      return [
        ...current,
        {
          id,
          recommended_service_id: s.serviceId,
          service_label: s.serviceName ?? s.label,
          service_slug: null,
          service_has_options: false,
          freeform_service_name: s.serviceId ? "" : s.label,
          urgency: s.urgency,
          reason: s.reasons.join("; "),
          visible_to_driver: true,
          target_mileage: defaultTriggerMileage(currentMileage),
          scheduled_at: null,
          scheduled_mechanic_id: null,
          scheduled_mechanic_name: null,
          selected_service_option: null,
          tire_specs: null,
        },
      ];
    });
  }

  function toggleClearedLight(code: string) {
    setClearedWarningLights((current) =>
      current.includes(code)
        ? current.filter((c) => c !== code)
        : [...current, code],
    );
  }

  return (
    <QuestionScreen
      eyebrow="Looking ahead"
      question="Any recommendations for this car?"
      hint="Each one becomes a tracked follow-up — you'll confirm or dismiss them on the next visit."
    >
      {priorOpenRecommendations.length > 0 ? (
        <div className="mb-4 rounded-xl border border-primary/10 bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Still open from last visit
          </p>
          <ul className="mt-1.5 space-y-1">
            {priorOpenRecommendations.map((rec) => {
              const done = resolvedPriorRecIds[rec._id] === true;
              return (
                <li
                  key={rec._id}
                  className="flex items-start gap-2 text-[12px] text-foreground/80"
                >
                  <span
                    className={cn(
                      "mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full",
                      done ? "bg-emerald-500" : "bg-muted-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      done && "text-muted-foreground line-through",
                    )}
                  >
                    <span className="font-medium">{rec.service_name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {urgencyLabel(rec.urgency)}
                    </span>
                    {rec.reason ? (
                      <span className="text-muted-foreground">
                        {" "}
                        — {rec.reason}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleResolvedPriorRec(rec._id)}
                    aria-pressed={done}
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors",
                      done
                        ? "bg-emerald-500/15 text-emerald-700"
                        : "border border-primary/20 text-muted-foreground hover:bg-primary/5 hover:text-foreground",
                    )}
                  >
                    {done ? (
                      <>
                        <Check className="h-3 w-3" />
                        Done
                      </>
                    ) : (
                      "Mark done"
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Did any of these this visit? Mark them done — the rest you&apos;ll
            confirm on the next pre-job survey.
          </p>
        </div>
      ) : null}

      {confirmedThisVisit.length > 0 ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50/50 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700">
            From today's inspection
          </p>
          <ul className="mt-1.5 space-y-1">
            {confirmedThisVisit.map((rec) => (
              <li
                key={rec._id}
                className="flex items-start gap-2 text-[12px] text-foreground/80"
              >
                <Check className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-600" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{rec.service_name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {urgencyLabel(rec.urgency)}
                  </span>
                  {rec.reason ? (
                    <span className="text-muted-foreground"> — {rec.reason}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => handleUndoConfirmed(rec._id)}
                  disabled={!bookingId || undoingId !== null}
                  className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:bg-emerald-100 hover:text-emerald-800 disabled:opacity-50"
                >
                  {undoingId === rec._id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                  Undo
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Already confirmed at pre-job — changed your mind or fixed it during the job? Undo it.
          </p>
        </div>
      ) : null}

      {suggestedFromInspection.length > 0 ? (
        <div className="mb-4 rounded-xl border border-primary/10 bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Also flagged during today's inspection
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {suggestedFromInspection.map((s) => {
              const checked = recommendations.some(
                (r) => r.id === suggestionRowId(s.key),
              );
              return (
                <li key={s.key}>
                  <label className="flex cursor-pointer items-start gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSuggestion(s)}
                      className="mt-0.5 h-3.5 w-3.5 accent-[var(--primary)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-foreground">
                        {s.serviceName ?? s.label}
                      </span>
                      {!s.serviceId ? (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                          not in catalog
                        </span>
                      ) : null}
                      <span className="block text-muted-foreground">
                        {s.reasons.join(" · ")} · {urgencyLabel(s.urgency)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Skipped at pre-job — check any you still want to recommend.
          </p>
        </div>
      ) : null}

      {currentWarningLights.length > 0 ? (
        <div className="mb-4 rounded-xl border border-primary/10 bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Dashboard lights on file for this car
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Still on? Clear any you resolved this visit.
          </p>
          <ul className="mt-1.5 space-y-1">
            {currentWarningLights.map((code) => {
              const cleared = clearedWarningLights.includes(code);
              return (
                <li
                  key={code}
                  className="flex items-center justify-between gap-2 py-1"
                >
                  <span
                    className={cn(
                      "text-[12px]",
                      cleared
                        ? "text-muted-foreground line-through"
                        : "font-medium text-foreground",
                    )}
                  >
                    {LIGHT_LABELS[code as keyof typeof LIGHT_LABELS] ?? code}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleClearedLight(code)}
                    className={cn(
                      "flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                      cleared
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : "border-primary/25 bg-card text-muted-foreground hover:bg-primary/5",
                    )}
                  >
                    {cleared ? "✓ Cleared" : "Clear"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="space-y-3">
        {recommendations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-primary/20 bg-muted/30 px-4 py-6 text-center text-[12px] text-muted-foreground">
            No follow-ups yet. Skip is fine if there's nothing to flag.
          </div>
        ) : (
          recommendations.map((rec, index) => {
            const hasService =
              !!rec.recommended_service_id || rec.service_label !== "";
            return (
              <div
                key={rec.id}
                className="rounded-2xl border border-primary/15 bg-background px-3 py-3"
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => setPickerIndex(index)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors",
                      hasService
                        ? "border-primary/20 bg-background text-foreground"
                        : "border-dashed border-primary/30 bg-primary/5 text-primary",
                    )}
                  >
                    <span className="truncate">
                      {hasService
                        ? rec.service_label ||
                          rec.freeform_service_name ||
                          "Pick a service"
                        : "Pick a service…"}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRec(index)}
                    aria-label="Remove recommendation"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {rec.service_has_options || rec.service_slug === "tire-replacement" ? (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-2.5 py-1.5">
                    <span className="text-[11px] text-amber-900">
                      {rec.service_slug === "tire-replacement"
                        ? rec.tire_specs
                          ? `${rec.tire_specs.size} · ${rec.tire_specs.type} · ${rec.tire_specs.tier} · ${rec.tire_specs.quantity} tires`
                          : "Tire specs required"
                        : rec.selected_service_option
                          ? rec.selected_service_option.option_label
                          : "Option required"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (rec.service_slug === "tire-replacement") {
                          setTirePickerIndex(index);
                        } else {
                          setOptionPickerIndex(index);
                        }
                      }}
                      className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-900 hover:bg-amber-100"
                    >
                      {(rec.service_slug === "tire-replacement"
                        ? rec.tire_specs
                        : rec.selected_service_option)
                        ? "Edit"
                        : "Pick"}
                    </button>
                  </div>
                ) : null}

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {URGENCY_CHOICES.map((opt) => {
                    const active = rec.urgency === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => updateRec(index, { urgency: opt.value })}
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-primary/15 bg-background text-foreground hover:bg-primary/5",
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                <input
                  value={rec.reason}
                  onChange={(event) =>
                    updateRec(index, { reason: event.target.value.slice(0, 60) })
                  }
                  placeholder='Why? (optional, e.g. "slight pull to the right")'
                  maxLength={60}
                  className="mt-2.5 h-9 w-full rounded-lg border border-primary/15 bg-background px-3 text-[12px] outline-none focus:border-primary"
                />

                <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                  <MileageTriggerField
                    value={rec.target_mileage}
                    onChange={(next) =>
                      updateRec(index, { target_mileage: next })
                    }
                    currentOdometer={
                      Number.isFinite(currentMileage) && currentMileage > 0
                        ? currentMileage
                        : null
                    }
                  />
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Schedule a specific time
                    </label>
                    {rec.scheduled_at ? (
                      <div className="mt-1 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[12px]">
                        <CalendarClock className="h-3.5 w-3.5 text-primary" />
                        <span className="min-w-0 flex-1 truncate">
                          {new Date(rec.scheduled_at).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                          {rec.scheduled_mechanic_name
                            ? ` · ${rec.scheduled_mechanic_name}`
                            : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSlotPickerIndex(index)}
                          className="text-[11px] font-medium text-primary hover:underline"
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updateRec(index, {
                              scheduled_at: null,
                              scheduled_mechanic_id: null,
                              scheduled_mechanic_name: null,
                            })
                          }
                          className="text-[11px] font-medium text-muted-foreground hover:text-destructive"
                        >
                          Clear
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSlotPickerIndex(index)}
                        className="mt-1 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
                      >
                        <CalendarClock className="h-3.5 w-3.5" />
                        Pick date &amp; time
                      </button>
                    )}
                  </div>
                </div>

                {/* Preview (Off-Catalog Work spec, §6): off-catalog advice is
                    shown to the mechanic exactly as the driver will read it —
                    attributed to them, with no price and no booking. Nobody
                    should find out after the fact that their recommendation was
                    presented as an opinion.

                    No longer gated on a visibility toggle: every recommendation
                    reaches the driver now, so the preview always applies. */}
                {!rec.recommended_service_id &&
                rec.freeform_service_name.trim() ? (
                  <AdvisoryPreview
                    name={rec.freeform_service_name.trim()}
                    reason={rec.reason}
                  />
                ) : null}
              </div>
            );
          })
        )}

        <button
          type="button"
          onClick={addRec}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <Plus className="h-3.5 w-3.5" />
          Add recommendation
        </button>

        {/* Demoted private note. Collapsed by default so it doesn't compete
            with the structured rec cards. Driver never sees this. */}
        <details className="rounded-xl border border-primary/10 bg-muted/20 px-3 py-2 text-[12px]">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            Private note for the shop (not seen by the driver)
          </summary>
          <textarea
            value={additionalObservations}
            onChange={(event) =>
              setAdditionalObservations(event.target.value)
            }
            placeholder="Optional internal note."
            className="mt-2 min-h-[80px] w-full resize-y rounded-lg border border-primary/15 bg-background px-3 py-2 text-[12px] leading-relaxed outline-none focus:border-primary"
          />
        </details>
      </div>

      <ServiceOptionsPicker
        open={optionPickerIndex !== null}
        serviceIds={
          optionPickerIndex !== null &&
          recommendations[optionPickerIndex]?.recommended_service_id
            ? [recommendations[optionPickerIndex].recommended_service_id as any]
            : ([] as any)
        }
        initialSelections={
          optionPickerIndex !== null &&
          recommendations[optionPickerIndex]?.selected_service_option &&
          recommendations[optionPickerIndex]?.recommended_service_id
            ? [
                {
                  service_id: recommendations[optionPickerIndex]
                    .recommended_service_id as any,
                  option_id: recommendations[optionPickerIndex]
                    .selected_service_option!.option_id as any,
                  option_label: recommendations[optionPickerIndex]
                    .selected_service_option!.option_label,
                  option_type:
                    recommendations[optionPickerIndex].selected_service_option!
                      .option_type,
                },
              ]
            : []
        }
        onCancel={() => setOptionPickerIndex(null)}
        onConfirm={(picks) => {
          if (optionPickerIndex === null) return;
          const pick = picks[0];
          if (pick) {
            updateRec(optionPickerIndex, {
              selected_service_option: {
                option_id: pick.option_id as unknown as string,
                option_label: pick.option_label,
                option_type: pick.option_type,
              },
            });
          }
          setOptionPickerIndex(null);
        }}
      />

      <TireSpecPicker
        open={tirePickerIndex !== null}
        initial={
          tirePickerIndex !== null
            ? recommendations[tirePickerIndex]?.tire_specs ?? null
            : null
        }
        onCancel={() => setTirePickerIndex(null)}
        onConfirm={(specs) => {
          if (tirePickerIndex === null) return;
          updateRec(tirePickerIndex, { tire_specs: specs });
          setTirePickerIndex(null);
        }}
      />

      <ScheduleSlotPicker
        open={slotPickerIndex !== null}
        title="Schedule the follow-up visit"
        initialDate={
          slotPickerIndex !== null &&
          recommendations[slotPickerIndex]?.scheduled_at
            ? new Date(recommendations[slotPickerIndex].scheduled_at as number)
            : undefined
        }
        onCancel={() => setSlotPickerIndex(null)}
        onConfirm={(slot) => {
          if (slotPickerIndex === null) return;
          const [h, m] = slot.time.split(":").map(Number);
          const [y, mo, d] = slot.date.split("-").map(Number);
          const ts = new Date(y, mo - 1, d, h, m, 0, 0).getTime();
          updateRec(slotPickerIndex, {
            scheduled_at: ts,
            scheduled_mechanic_id: slot.mechanicId,
            scheduled_mechanic_name: slot.mechanicName,
          });
          setSlotPickerIndex(null);
        }}
      />

      {pickerIndex !== null ? (
        <ServicePickerModal
          engineId={engineId}
          initialQuery={
            recommendations[pickerIndex]?.service_label ||
            recommendations[pickerIndex]?.freeform_service_name ||
            ""
          }
          onClose={() => setPickerIndex(null)}
          onPick={(picked) => {
            if (pickerIndex === null) return;
            const idx = pickerIndex;
            if (picked.kind === "service") {
              updateRec(idx, {
                recommended_service_id: picked.id,
                service_label: picked.name,
                service_slug: picked.slug,
                service_has_options: picked.has_options,
                freeform_service_name: "",
                // Reset option state when service changes.
                selected_service_option: null,
                tire_specs: null,
              });
              setPickerIndex(null);
              if (picked.slug === "tire-replacement") {
                setTirePickerIndex(idx);
              } else if (picked.has_options) {
                setOptionPickerIndex(idx);
              }
            } else {
              updateRec(idx, {
                recommended_service_id: null,
                service_label: picked.name,
                service_slug: null,
                service_has_options: false,
                freeform_service_name: picked.name,
                selected_service_option: null,
                tire_specs: null,
              });
              setPickerIndex(null);
            }
          }}
        />
      ) : null}
    </QuestionScreen>
  );
}

/**
 * Modal service picker — engine-matched services float to the top, and the
 * mechanic can submit a freeform name (routed to admin review server-side)
 * when nothing in the canonical catalog fits.
 */
// ServicePickerModal now lives in components/booking/service-picker-modal
// so the Flag Issue sheet uses the same one — see that file's header.

/**
 * Step 0 of "Add unforeseen scope" (Flag Issue spec, §3).
 *
 * The three steps that existed — Parts → Labor → Summary — could add money and
 * time to a job but had no way to say what the work actually WAS. So extra work
 * became anonymous parts-and-hours: nothing in the service history, nothing in the
 * maintenance record, nothing readable on the customer's receipt.
 *
 * Naming it first also gets the complaint at the only moment the mechanic really
 * knows it. "Found a split hose while doing the oil change" is a better complaint
 * than anything reconstructed at 4pm.
 *
 * Adding a line here does NOT re-quote. The following Parts and Labor steps and
 * the existing mid-job approval cycle own the money — this only records what the
 * work is.
 */
function FoundWorkStep({
  bookingId,
  engineId,
  onToast,
  flushRef,
}: {
  bookingId: string | null;
  engineId: string | null;
  onToast?: (message: string) => void;
  /** The parent calls this before navigating forward so a valid line still
   *  sitting in the add/edit form gets committed instead of dropped. */
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [complaint, setComplaint] = useState("");
  const [systemTags, setSystemTags] = useState<string[]>([]);
  const [workType, setWorkType] = useState<string | null>(null);
  // Labor estimate for this line, in decimal HOURS. Flows through to the labor
  // step's per-service breakdown so the quote adds this work's time to the total.
  const [laborHoursInput, setLaborHoursInput] = useState("");
  const [pending, setPending] = useState<{
    kind: "service" | "freeform";
    name: string;
    id?: string;
  } | null>(null);
  // When set, the form below is editing this existing line rather than adding
  // a new one — commit() branches to the update mutation.
  const [editingId, setEditingId] = useState<string | null>(null);

  const addMidJob = useMutation(api.customJobs.addMidJobCustomService);
  const updateMidJob = useMutation(api.customJobs.updateMidJobCustomService);
  const removeMidJob = useMutation(api.customJobs.removeMidJobCustomService);
  const existing = useQuery(
    api.customJobs.listForBooking,
    bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  );
  const midJobLines = (existing ?? []).filter((j) => j.name);

  function resetForm() {
    setPending(null);
    setEditingId(null);
    setComplaint("");
    setSystemTags([]);
    setWorkType(null);
    setLaborHoursInput("");
  }

  function startEdit(line: (typeof midJobLines)[number]) {
    setPicking(false);
    setEditingId(String(line._id));
    setPending({ kind: "freeform", name: line.name });
    setComplaint(line.complaint ?? "");
    setSystemTags(line.system_tags ?? []);
    setWorkType(line.work_type ?? null);
    setLaborHoursInput(
      typeof line.estimated_minutes === "number" && line.estimated_minutes > 0
        ? formatHoursValue(line.estimated_minutes)
        : "",
    );
  }

  async function remove(line: (typeof midJobLines)[number]) {
    if (!bookingId) return;
    setBusy(true);
    try {
      await removeMidJob({
        bookingId: bookingId as Id<"bookings">,
        customJobId: line._id as Id<"custom_jobs">,
      });
      if (editingId === String(line._id)) resetForm();
    } catch (err: unknown) {
      onToast?.(
        err instanceof Error ? err.message : "Could not remove that work.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!pending || !bookingId) return;
    setBusy(true);
    const laborHours = parseHoursInput(laborHoursInput);
    const estimatedMinutes =
      laborHours != null && laborHours > 0 ? hoursToMinutes(laborHours) : undefined;
    try {
      if (editingId) {
        await updateMidJob({
          bookingId: bookingId as Id<"bookings">,
          customJobId: editingId as Id<"custom_jobs">,
          name: pending.name,
          complaint: complaint.trim() || undefined,
          systemTags,
          workType: workType ?? undefined,
          estimatedMinutes,
        });
      } else {
        // Catalog picks land on the booking's service_ids through the normal
        // approval payload; only off-catalog lines need the custom-job record.
        await addMidJob({
          bookingId: bookingId as Id<"bookings">,
          name: pending.name,
          complaint: complaint.trim() || undefined,
          systemTags,
          workType: workType ?? undefined,
          estimatedMinutes,
        });
      }
      resetForm();
    } catch (err: unknown) {
      onToast?.(
        err instanceof Error ? err.message : "Could not save that work.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Expose a flush so the footer's Continue commits a line the mechanic filled
  // out but didn't explicitly Save/Add — but only when it's actually valid
  // (taxonomy complete), which is the same gate the Save/Add button enforces.
  // An incomplete draft is left untouched, exactly as it is today. No dep array
  // so the closure always sees the latest form state.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = async () => {
      if (
        pending &&
        !busy &&
        isCustomJobTaxonomyComplete(systemTags, workType)
      ) {
        await commit();
      }
    };
    return () => {
      if (flushRef) flushRef.current = null;
    };
  });

  return (
    <QuestionScreen
      eyebrow="Extra work"
      question="What did you find?"
      hint="Naming it keeps it on the customer's service history. Pricing comes next."
    >
      <div className="space-y-3">
        {midJobLines.some((line) => String(line._id) !== editingId) ? (
          <ul className="space-y-1.5">
            {midJobLines
              .filter((line) => String(line._id) !== editingId)
              .map((line) => (
                <li
                  key={String(line._id)}
                  className="flex items-start gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-foreground">
                      {line.name}
                    </p>
                    <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-primary/70">
                      {describeCustomJobTaxonomy(
                        line.system_tags,
                        line.work_type,
                      )}
                      {typeof line.estimated_minutes === "number" &&
                      line.estimated_minutes > 0
                        ? ` · ${formatHoursValue(line.estimated_minutes)} hr`
                        : ""}
                    </p>
                    {line.complaint ? (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        {line.complaint}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => startEdit(line)}
                      aria-label={`Edit ${line.name}`}
                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-40"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(line)}
                      aria-label={`Remove ${line.name}`}
                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        ) : null}

        {pending ? (
          <div className="rounded-xl border border-primary/20 bg-background p-3">
            {editingId ? (
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-primary/70">
                Editing
              </p>
            ) : null}
            <p className="text-[13px] font-semibold text-foreground">
              {pending.name}
            </p>
            <textarea
              value={complaint}
              autoFocus
              onChange={(event) => setComplaint(event.target.value)}
              placeholder="What did you see? (optional)"
              className="mt-2 min-h-[64px] w-full resize-y rounded-lg border border-primary/15 bg-background px-3 py-2 text-[12px] leading-relaxed outline-none focus:border-primary"
            />
            {/* Same two mandatory axes as the booking drawer. Work found
                mid-job is the most valuable row in the table — it's the case
                nobody planned for — so it's the last place worth letting the
                taxonomy be optional. */}
            <div className="mt-2.5">
              <CustomJobTaxonomyPicker
                dense
                systemTags={systemTags}
                workType={workType}
                onSystemTagsChange={setSystemTags}
                onWorkTypeChange={setWorkType}
              />
            </div>
            {/* Labor time for this line. Optional here — the mechanic can also
                set it on the labor step — but capturing it at the keyboard is
                when they best know how long it took. */}
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Labor time
                <span className="ml-1 text-muted-foreground/60">· optional</span>
              </label>
              <div className="flex items-center rounded-lg border border-primary/15 bg-background pr-3 focus-within:border-primary">
                <input
                  value={laborHoursInput}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === "" || /^\d{0,2}(\.\d{0,2})?$/.test(raw))
                      setLaborHoursInput(raw);
                  }}
                  inputMode="decimal"
                  placeholder="0"
                  className="w-16 bg-transparent px-3 py-1.5 text-right text-[13px] font-semibold tabular-nums outline-none placeholder:text-muted-foreground/40"
                />
                <span className="text-[11px] text-muted-foreground">hr</span>
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  busy || !isCustomJobTaxonomyComplete(systemTags, workType)
                }
                onClick={commit}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {editingId ? "Save changes" : "Add to job"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <Plus className="h-3.5 w-3.5" />
            {midJobLines.length > 0 ? "Add something else" : "Name the work"}
          </button>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Just more parts or time on the original job? Skip this and carry on.
        </p>
      </div>

      {picking ? (
        // Same picker the recommendations step uses, so the match gate applies
        // here too — a mechanic typing "oil change" gets caught before it becomes
        // off-catalog work that earns no maintenance credit.
        <ServicePickerModal
          engineId={engineId}
          initialQuery=""
          recentNames={midJobLines.map((l) => ({
            name: l.name,
            system_tags: l.system_tags,
            work_type: l.work_type,
          }))}
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setPicking(false);
            if (picked.kind === "freeform") {
              if (picked.system_tags?.length) setSystemTags(picked.system_tags);
              if (picked.work_type) setWorkType(picked.work_type);
            }
            setPending(
              picked.kind === "service"
                ? { kind: "service", name: picked.name, id: picked.id }
                : { kind: "freeform", name: picked.name },
            );
          }}
        />
      ) : null}
    </QuestionScreen>
  );
}

type CustomJobRow = {
  _id: string;
  name: string;
  system_tags?: string[];
  work_type?: string | null;
  parts?: Array<{
    part_name: string;
    oem_number?: string;
    quantity: number;
    line_total_cents?: number;
  }>;
  quoted_parts_cents?: number | null;
  estimated_minutes?: number | null;
  complaint: string | null;
  resolution: string | null;
  resolved_complaint: boolean | null;
};

/**
 * Outcome capture for off-catalog work (Off-Catalog Work spec, §7).
 *
 * The complaint was recorded when the line was added. This closes the triple:
 * symptom → what we did → whether it worked. Those three together are a labelled
 * training example for symptom→service, produced as a by-product of a mechanic
 * finishing a job, and nothing else in the schema captures them.
 *
 * Everything here is optional. A skipped line still closes server-side as
 * "completed, no outcome recorded", which the director view reports as exactly
 * that rather than guessing.
 */
function CustomOutcomesStep({
  jobs,
  outcomes,
  setOutcomes,
}: {
  jobs: CustomJobRow[];
  outcomes: Record<string, { resolution: string; resolved: boolean | null }>;
  setOutcomes: (
    next: Record<string, { resolution: string; resolved: boolean | null }>,
  ) => void;
}) {
  const entryFor = (id: string) =>
    outcomes[id] ?? { resolution: "", resolved: null };

  const update = (
    id: string,
    patch: Partial<{ resolution: string; resolved: boolean | null }>,
  ) => setOutcomes({ ...outcomes, [id]: { ...entryFor(id), ...patch } });

  return (
    <QuestionScreen
      eyebrow="Custom work"
      question={
        jobs.length === 1
          ? "How did the custom work go?"
          : "How did the custom work go?"
      }
      hint="Off-catalog work doesn't affect the customer's vehicle health score — this is for our records."
    >
      <div className="space-y-3">
        {jobs.map((job) => {
          const entry = entryFor(job._id);
          return (
            <div
              key={job._id}
              className="rounded-xl border border-primary/15 bg-background p-3"
            >
              <p className="text-[13px] font-semibold text-foreground">
                {job.name}
              </p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-primary/70">
                {describeCustomJobTaxonomy(job.system_tags, job.work_type)}
              </p>
              {job.complaint ? (
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  Reported: {job.complaint}
                </p>
              ) : null}
              {/* What was quoted against this line at booking time. Shown so
                  the resolution can be written against the actual parts rather
                  than from memory — and so a part quoted but never fitted is
                  visible while the mechanic can still say so. */}
              {job.parts && job.parts.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                  {job.parts.map((part, i) => (
                    <li
                      key={`${part.part_name}-${i}`}
                      className="text-[11px] leading-relaxed text-muted-foreground"
                    >
                      {part.part_name}
                      {part.quantity > 1 ? ` ×${part.quantity}` : ""}
                      {part.oem_number ? (
                        <span className="font-mono"> {part.oem_number}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              <textarea
                value={entry.resolution}
                onChange={(event) =>
                  update(job._id, { resolution: event.target.value })
                }
                placeholder="What did you actually do? (optional)"
                className="mt-2 min-h-[64px] w-full resize-y rounded-lg border border-primary/15 bg-background px-3 py-2 text-[12px] leading-relaxed outline-none focus:border-primary"
              />
            </div>
          );
        })}
      </div>
    </QuestionScreen>
  );
}

/**
 * What the driver actually sees for off-catalog advice (Off-Catalog Work
 * spec, §6) — rendered back to the mechanic before they commit to it.
 *
 * The card is deliberately not a booking card: no price, no Book button. We
 * can't quote work we don't model, and a disabled button reads as a bug rather
 * than a boundary. What it does carry is attribution — this is one person's
 * professional opinion, and saying so is the whole point.
 *
 * Kept in sync with jobRecommendations.ADVISORY_DISCLAIMER by hand; if that
 * string changes, change this one.
 */
function AdvisoryPreview({
  name,
  reason,
}: {
  name: string;
  reason: string;
}) {
  return (
    <div className="mt-2.5 rounded-xl border border-dashed border-primary/25 bg-muted/20 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        What the driver will see
      </p>
      <div className="mt-2 rounded-lg border border-primary/15 bg-background p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">
          You at your shop suggest
        </p>
        <p className="mt-1 text-[13px] font-semibold text-foreground">{name}</p>
        {reason.trim() ? (
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            &ldquo;{reason.trim()}&rdquo;
          </p>
        ) : null}
        <p className="mt-2 rounded-md border border-primary/10 bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Otopair doesn&apos;t price or book this service yet — this is the
          shop&apos;s recommendation, not an Otopair estimate.
        </p>
        <div className="mt-2 flex gap-1.5">
          <span className="rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground">
            Message the shop
          </span>
          <span className="rounded-md border border-primary/15 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
            Not interested
          </span>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        No price and no booking — the driver contacts you directly. It won&apos;t
        affect their vehicle health score.
      </p>
    </div>
  );
}

/**
 * What the mechanic sees under the search box when nothing in the list fits.
 *
 * Matching catalog services appear as options; whatever they typed stays the
 * default. The older version asked "Did you mean?" and made them answer it,
 * which is the wrong thing to put in front of someone with dirty hands — the
 * protection was never the question, it was the canonical option being visible
 * and one tap away.
 */
function CustomNameGate({
  typed,
  onPick,
}: {
  typed: string;
  onPick: (
    picked:
      | {
          kind: "service";
          id: string;
          name: string;
          slug: string | null;
          has_options: boolean;
        }
      | { kind: "freeform"; name: string },
  ) => void;
}) {
  return (
    <div className="mt-3 space-y-2 border-t border-primary/10 pt-3">
      <ServiceSuggestions
        typed={typed}
        onPick={(s) =>
          onPick({
            kind: "service",
            id: s.serviceId,
            name: s.name,
            slug: s.slug,
            has_options: s.has_options,
          })
        }
      />
      <button
        type="button"
        onClick={() => onPick({ kind: "freeform", name: typed })}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-left text-[12px] text-primary transition-colors hover:bg-primary/10"
      >
        <span>
          Add &ldquo;<span className="font-semibold">{typed}</span>&rdquo; as
          custom work
        </span>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SummaryStep({
  bookingLabel,
  bookingSubLabel,
  serviceLabel,
  completionMileage,
  timeVariance,
  timeReason,
  difficultyRating,
  partsCount,
  photoCount,
  layoverNotes,
  layoverPhotos,
  flagged,
}: {
  bookingLabel: string;
  bookingSubLabel: string;
  serviceLabel: string | null;
  completionMileage: string;
  timeVariance: TimeVariance | null;
  timeReason: TimeVarianceReason | null;
  difficultyRating: string;
  partsCount: number;
  photoCount: number;
  layoverNotes: string;
  layoverPhotos: PhotoState[];
  flagged: boolean;
}) {
  // Notes are stored as newline-joined entries by the layover overlay.
  const layoverNoteEntries = layoverNotes
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const layoverReadyPhotos = layoverPhotos.filter(
    (photo) => photo.status === "ready" && photo.previewUrl,
  );
  const hasLayoverContext =
    layoverNoteEntries.length > 0 || layoverReadyPhotos.length > 0;
  const rows: { label: string; value: string }[] = [
    {
      label: "Vehicle",
      value: `${bookingLabel}${serviceLabel ? ` · ${serviceLabel}` : ""}`,
    },
    {
      label: "Mileage",
      value: completionMileage ? `${completionMileage} mi` : "—",
    },
    {
      label: "Timing",
      value: timeVariance
        ? timeVariance === "on_time"
          ? "About right"
          : timeVariance === "faster"
            ? `Faster${timeReason ? ` · ${timeReason.replaceAll("_", " ")}` : ""}`
            : `Slower${timeReason ? ` · ${timeReason.replaceAll("_", " ")}` : ""}`
        : "—",
    },
    { label: "Difficulty", value: difficultyRating || "—" },
    { label: "Parts", value: partsCount ? `${partsCount} logged` : "None" },
    { label: "Photos", value: photoCount ? `${photoCount} attached` : "None" },
    { label: "Flag for review", value: flagged ? "Yes" : "No" },
  ];

  return (
    <div className="mx-auto w-full max-w-xl">
      <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Almost there
      </p>
      <h2 className="mt-2 text-center text-[24px] font-semibold leading-tight text-foreground sm:text-[28px]">
        Ready to close the job?
      </h2>
      <p className="mt-2 text-center text-[12px] text-muted-foreground">
        {bookingSubLabel}
      </p>
      <div className="mt-8 overflow-hidden rounded-2xl border border-primary/15 bg-background">
        {rows.map((row, idx) => (
          <div
            key={row.label}
            className={cn(
              "flex items-center justify-between gap-3 px-4 py-3",
              idx > 0 && "border-t border-primary/10"
            )}
          >
            <span className="text-[12px] font-medium text-muted-foreground">
              {row.label}
            </span>
            <span className="text-right text-[13px] text-foreground">
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {hasLayoverContext ? (
        <div className="mt-6 overflow-hidden rounded-2xl border border-primary/15 bg-muted/30">
          <div className="border-b border-primary/10 px-4 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              From the active job
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">
              Notes &amp; photos you added while working — carried into this
              report.
            </p>
          </div>
          {layoverNoteEntries.length > 0 ? (
            <ul className="space-y-1.5 px-4 py-3">
              {layoverNoteEntries.map((entry, idx) => (
                <li
                  key={idx}
                  className="flex gap-2 text-[13px] leading-snug text-foreground"
                >
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/40" />
                  <span className="min-w-0 break-words">{entry}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {layoverReadyPhotos.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-4 pb-3 pt-1">
              {layoverReadyPhotos.map((photo) => (
                <div
                  key={photo.id}
                  className="h-16 w-16 overflow-hidden rounded-lg border border-primary/15 bg-background"
                  title={photo.caption || undefined}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.previewUrl}
                    alt={photo.caption || "Active-job photo"}
                    className="h-full w-full object-cover"
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-success" />
        All data attaches to this VIN's passport.
      </div>
    </div>
  );
}

/**
 * Post-submit status panel for the Pre-Job Approval flow. Five states, all
 * driven reactively by the useApprovalWorkflow hook. Mechanic-facing copy
 * never uses the word "approval" — frames it as "confirmation" — and never
 * displays the customer's disclosed range.
 */
function ApprovalStatusPanel({
  workflow,
  cycle,
  onDismiss,
  onReviseRequested,
  bookingLabel,
}: {
  workflow: ApprovalWorkflow;
  cycle: PostJobSurveyCycle;
  onDismiss: () => void;
  onReviseRequested: () => void;
  bookingLabel: string;
}) {
  const setPrice = workflow.mechanicSetPriceCents
    ? `$${(workflow.mechanicSetPriceCents / 100).toFixed(2)}`
    : null;
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [busyAction, setBusyAction] = useState<null | "start" | "release" | "withdraw">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // No auto-dismiss: every state requires an explicit mechanic action
  // (Start work, Withdraw, Revise, Release). Auto-closing the dialog would
  // strand the booking at live_stage=inspection_complete with no obvious
  // path forward on the dashboard.

  async function runAction(
    kind: "start" | "release" | "withdraw",
    fn: () => Promise<void>,
  ) {
    setActionError(null);
    setBusyAction(kind);
    try {
      await fn();
      if (kind === "start" || kind === "release") onDismiss();
    } catch (err: any) {
      setActionError(err?.message ?? "Action failed. Try again.");
    } finally {
      setBusyAction(null);
    }
  }

  const headerCopy =
    cycle === "pre_job"
      ? "Set your price"
      : cycle === "mid_job"
        ? "Added scope"
        : "Final billing";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 sm:px-6">
        <button
          type="button"
          onClick={onDismiss}
          className="-m-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {headerCopy}
        </span>
        <span className="w-8" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10 sm:px-12">
        {/* Submitted set price — visible across every state so the mechanic
            can always see what the customer is being asked to confirm.
            Hidden only when no price is on record yet (initial mount). */}
        {setPrice ? (
          <div className="w-full max-w-md text-center">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              You submitted
            </div>
            <div className="mt-0.5 text-[28px] font-semibold tabular-nums leading-none text-foreground sm:text-[32px]">
              {setPrice}
            </div>
          </div>
        ) : null}

        {workflow.isInRange ? (
          <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-emerald-50 px-5 py-5">
            <div className="flex items-center gap-2">
              <Check className="h-5 w-5 text-emerald-600" />
              <p className="text-[14px] font-semibold text-emerald-900">
                Price confirmed
              </p>
            </div>
            <p className="mt-1 text-[13px] text-emerald-900/80">
              The customer&apos;s hold has been updated{setPrice ? ` to ${setPrice}` : ""}.
            </p>
            {cycle === "mid_job" ? (
              <button
                type="button"
                onClick={onDismiss}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "mt-4 h-10 w-full rounded-lg px-5 text-[13px]",
                )}
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runAction("start", workflow.onStartWork)}
                disabled={busyAction === "start"}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "mt-4 h-10 w-full rounded-lg px-5 text-[13px]",
                )}
              >
                {busyAction === "start" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {workflow.startWorkBeginsJob ? "Start work →" : "Confirm booking →"}
              </button>
            )}
          </div>
        ) : null}

        {workflow.isPending ? (
          <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-amber-50 px-5 py-5">
            <div className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-amber-700" />
              <p className="text-[14px] font-semibold text-amber-900">
                Sent for confirmation
              </p>
            </div>
            <p className="mt-1 text-[13px] text-amber-900/80">
              {workflow.relativeSentLabel ?? "Just sent"} — most customers reply within a few minutes.
            </p>
            <p className="mt-2 text-[12px] text-amber-900/70">
              You can close this and come back — we&apos;ll notify you.
            </p>
            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => void runAction("withdraw", workflow.onWithdraw)}
                disabled={busyAction === "withdraw"}
                className="text-[12px] font-medium text-amber-900/80 underline-offset-4 hover:underline"
              >
                {busyAction === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className={cn(
                  drawerSecondaryButtonClassName,
                  "h-9 rounded-lg px-4 text-[12px]",
                )}
              >
                Close
              </button>
            </div>
          </div>
        ) : null}

        {workflow.isApproved ? (
          <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-emerald-50 px-5 py-5">
            <div className="flex items-center gap-2">
              <Check className="h-5 w-5 text-emerald-600" />
              <p className="text-[14px] font-semibold text-emerald-900">
                Confirmed by customer
              </p>
            </div>
            <p className="mt-1 text-[13px] text-emerald-900/80">
              {cycle === "post_job_reapproval"
                ? `Final billing confirmed${setPrice ? ` · ${setPrice}` : ""}. Capture is processing.`
                : cycle === "mid_job"
                  ? `Added scope confirmed${setPrice ? ` · ${setPrice}` : ""}.`
                  : workflow.startWorkBeginsJob
                    ? `You're cleared to start work${setPrice ? ` · ${setPrice}` : ""}.`
                    : `Price locked in${setPrice ? ` · ${setPrice}` : ""}. Confirm the booking — you can start work once the vehicle is here.`}
            </p>
            {cycle === "pre_job" ? (
              <button
                type="button"
                onClick={() => void runAction("start", workflow.onStartWork)}
                disabled={busyAction === "start"}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "mt-4 h-10 w-full rounded-lg px-5 text-[13px]",
                )}
              >
                {busyAction === "start" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {workflow.startWorkBeginsJob ? "Start work →" : "Confirm booking →"}
              </button>
            ) : (
              <button
                type="button"
                onClick={onDismiss}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "mt-4 h-10 w-full rounded-lg px-5 text-[13px]",
                )}
              >
                Continue
              </button>
            )}
          </div>
        ) : null}

        {workflow.isDeclined ? (
          <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-5">
            <div className="flex items-center gap-2">
              <X className="h-5 w-5 text-destructive" />
              <p className="text-[14px] font-semibold text-destructive">
                Customer declined
              </p>
            </div>
            <p className="mt-1 text-[13px] text-foreground/80">
              {cycle === "post_job_reapproval"
                ? "Capture will fall back to the previously approved amount. No further action needed."
                : cycle === "mid_job"
                  ? "Work continues at the previously approved scope. Found other work? Submit a new request below."
                  : "You can adjust the price and resend, or release the vehicle."}
            </p>
            {cycle === "mid_job" ? (
              // A declined added-scope isn't a dead end — the mechanic may have
              // found different work. Drop them back into the form to submit a
              // fresh request (the declined lines were already reverted server-
              // side), or acknowledge and continue at the approved scope.
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  onClick={onReviseRequested}
                  className={cn(
                    drawerPrimaryButtonClassName,
                    "h-10 flex-1 rounded-lg px-5 text-[13px]",
                  )}
                >
                  Add a new request
                </button>
                <button
                  type="button"
                  onClick={onDismiss}
                  className={cn(
                    drawerSecondaryButtonClassName,
                    "h-10 flex-1 rounded-lg px-5 text-[13px]",
                  )}
                >
                  Acknowledge
                </button>
              </div>
            ) : cycle === "post_job_reapproval" ? (
              <button
                type="button"
                onClick={onDismiss}
                className={cn(
                  drawerSecondaryButtonClassName,
                  "mt-4 h-10 w-full rounded-lg px-5 text-[13px]",
                )}
              >
                Acknowledge
              </button>
            ) : null}
            {cycle === "pre_job" ? (
              confirmingRelease ? (
                <div className="mt-4 rounded-lg border border-destructive/30 bg-white px-3 py-3 text-[12px]">
                  <p className="font-medium text-foreground">
                    Release this vehicle?
                  </p>
                  <p className="mt-1 text-foreground/70">
                    Void the customer&apos;s hold, cancel the booking, and free the bay.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmingRelease(false)}
                      disabled={busyAction === "release"}
                      className={cn(
                        drawerSecondaryButtonClassName,
                        "h-8 flex-1 rounded-md px-3 text-[12px]",
                      )}
                    >
                      Keep waiting
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAction("release", workflow.onRelease)}
                      disabled={busyAction === "release"}
                      className={cn(
                        drawerPrimaryButtonClassName,
                        "h-8 flex-1 rounded-md bg-destructive px-3 text-[12px] hover:bg-destructive",
                      )}
                    >
                      {busyAction === "release" ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : null}
                      Release
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    onClick={onReviseRequested}
                    className={cn(
                      drawerPrimaryButtonClassName,
                      "h-10 flex-1 rounded-lg px-5 text-[13px]",
                    )}
                  >
                    Revise estimate
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRelease(true)}
                    className={cn(
                      drawerSecondaryButtonClassName,
                      "h-10 flex-1 rounded-lg px-5 text-[13px]",
                    )}
                  >
                    Release vehicle
                  </button>
                </div>
              )
            ) : null}
          </div>
        ) : null}

        {workflow.isReauthRequired ? (
          <div className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-rose-50 px-5 py-5">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-rose-700" />
              <p className="text-[14px] font-semibold text-rose-900">
                Card reauthorization needed
              </p>
            </div>
            <p className="mt-1 text-[13px] text-rose-900/80">
              The customer&apos;s card couldn&apos;t cover the updated hold. We&apos;ve
              notified them to confirm or update their payment method — work
              should not start until the hold is restored.
            </p>
            <div className="mt-4">
              <button
                type="button"
                onClick={onDismiss}
                className={cn(
                  drawerSecondaryButtonClassName,
                  "h-9 rounded-lg px-4 text-[12px]",
                )}
              >
                Close
              </button>
            </div>
          </div>
        ) : null}

        {workflow.isSlaExpired ? (
          <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-5">
            <div className="flex items-center gap-2">
              <X className="h-5 w-5 text-destructive" />
              <p className="text-[14px] font-semibold text-destructive">
                No response in 24h
              </p>
            </div>
            <p className="mt-1 text-[13px] text-foreground/80">
              The customer didn&apos;t respond. You can revise and resend or release the vehicle.
            </p>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={onReviseRequested}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "h-10 flex-1 rounded-lg px-5 text-[13px]",
                )}
              >
                Revise &amp; resend
              </button>
              <button
                type="button"
                onClick={() => void runAction("release", workflow.onRelease)}
                disabled={busyAction === "release"}
                className={cn(
                  drawerSecondaryButtonClassName,
                  "h-10 flex-1 rounded-lg px-5 text-[13px]",
                )}
              >
                {busyAction === "release" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Release vehicle
              </button>
            </div>
          </div>
        ) : null}

        {actionError ? (
          <p className="text-[12px] font-medium text-destructive">{actionError}</p>
        ) : null}
      </div>

      <div className="border-t border-primary/10 bg-[rgba(17,24,28,0.025)] px-5 py-3 text-[11px] text-muted-foreground sm:px-10 sm:py-4">
        {bookingLabel}
      </div>
    </div>
  );
}

/**
 * Labor step for estimate cycles.
 *
 * One row per piece of work — the original quoted service plus every custom
 * line the mechanic found — each with its own labor hours. The displayed labor
 * cost is `Σ hours × shop labor_rate`, and that sum (in hours) is written back
 * to the single `actualLaborHours` money field the submit mutation reads (as
 * minutes), so the server's recomputation lands on the same number the mechanic
 * just saw.
 *
 * The per-service split is only a lens on that total: it lets the mechanic add
 * the extra work's time on top of the original quote instead of re-typing one
 * lump figure, and shows the breakdown that makes the number legible.
 */
function LaborStep({
  allocations,
  setAllocations,
  setTotalHours,
  rateCents,
  estimatedLaborMinutes,
  baseLabel,
  customJobs,
}: {
  allocations: Record<string, string>;
  setAllocations: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setTotalHours: (value: string) => void;
  rateCents: number;
  estimatedLaborMinutes: number | null;
  baseLabel: string | null;
  customJobs: CustomJobRow[] | undefined;
}) {
  const lines = useMemo(() => {
    const rows: Array<{ key: string; label: string; def: number }> = [
      {
        key: "base",
        label: baseLabel?.trim() || "Original service",
        def:
          typeof estimatedLaborMinutes === "number" && estimatedLaborMinutes > 0
            ? estimatedLaborMinutes
            : 0,
      },
    ];
    for (const job of customJobs ?? []) {
      rows.push({
        key: String(job._id),
        label: job.name,
        def:
          typeof job.estimated_minutes === "number" && job.estimated_minutes > 0
            ? job.estimated_minutes
            : 0,
      });
    }
    return rows;
  }, [baseLabel, estimatedLaborMinutes, customJobs]);

  // Sum in HOURS. Allocation strings hold hours; a line the mechanic hasn't
  // touched has no entry and falls back to its estimate (`def` is minutes →
  // convert).
  const sumFor = (alloc: Record<string, string>) =>
    lines.reduce((sum, line) => {
      const raw = alloc[line.key];
      const value = raw === undefined ? minutesToHours(line.def) : Number(raw) || 0;
      return sum + (value > 0 ? value : 0);
    }, 0);

  // What the field shows: the mechanic's explicit entry if they've typed one,
  // otherwise the line's live estimate. We deliberately do NOT seed the
  // estimate into `allocations` — if we did, an estimate that arrives later
  // (the mechanic went back to "What did you find?", filled in the labor time
  // for that service, and returned here) would be masked by the stale seeded
  // "" and the field would keep showing 0. Reading through to `def` each
  // render keeps this step in sync with the one before it.
  const valueFor = (line: { key: string; def: number }) => {
    const raw = allocations[line.key];
    if (raw !== undefined) return raw;
    return line.def > 0 ? formatHoursValue(line.def) : "";
  };

  function updateLine(key: string, raw: string) {
    if (raw !== "" && !/^\d{0,2}(\.\d{0,2})?$/.test(raw)) return;
    setAllocations((prev) => ({ ...prev, [key]: raw }));
  }

  const totalHours = sumFor(allocations);

  // Keep `actualLaborHours` — the single money source of truth — in step with
  // the lines: on mount, on every edit, and crucially when a line's estimate
  // changes underneath us (a service's labor time set on an earlier step).
  // Untouched lines contribute their live estimate through `sumFor`, so this
  // is always the sum the mechanic actually sees. `setTotalHours` is a stable
  // state setter, so a no-op value change won't re-render.
  useEffect(() => {
    setTotalHours(String(totalHours));
  }, [totalHours, setTotalHours]);

  const laborDollars = totalHours > 0 ? totalHours * (rateCents / 100) : 0;
  const ratePerHourDollars = (rateCents / 100).toFixed(2);
  const multiline = lines.length > 1;

  return (
    <QuestionScreen
      eyebrow="Labor"
      question="How long will this take?"
      hint={
        multiline
          ? `Your shop's labor rate is $${ratePerHourDollars}/hr — set the time for each and we'll add it up.`
          : `Your shop's labor rate is $${ratePerHourDollars}/hr — we'll calculate from the hours you enter.`
      }
    >
      <div className="mx-auto w-full max-w-md space-y-3">
        <div className="space-y-2">
          {lines.map((line) => {
            const lineHours = Number(valueFor(line)) || 0;
            const lineDollars =
              lineHours > 0 ? lineHours * (rateCents / 100) : 0;
            return (
              <div
                key={line.key}
                className="flex items-center justify-between gap-3 rounded-xl border border-primary/10 bg-card px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {line.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {line.def > 0 ? `Est. ${formatHoursValue(line.def)} hr · ` : ""}$
                    {lineDollars.toFixed(2)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center rounded-lg border border-primary/15 bg-background pr-2.5 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
                  <input
                    value={valueFor(line)}
                    onChange={(e) => updateLine(line.key, e.target.value)}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`Labor hours for ${line.label}`}
                    className="w-16 bg-transparent px-2.5 py-2 text-right text-[16px] font-semibold tabular-nums outline-none placeholder:text-muted-foreground/40"
                  />
                  <span className="text-[11px] text-muted-foreground">hr</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {multiline ? "Total labor" : "Labor cost"}
            </p>
            <p className="mt-0.5 text-[12px] text-muted-foreground tabular-nums">
              {Number(totalHours.toFixed(2))} hr · ${ratePerHourDollars}/hr
            </p>
          </div>
          <span className="text-[22px] font-semibold tabular-nums">
            ${laborDollars.toFixed(2)}
          </span>
        </div>
      </div>
    </QuestionScreen>
  );
}

/**
 * Compact, optional photo attach for the "Why the added scope?" reasoning
 * block. Rides along with the approval so the customer sees the evidence on
 * their approval screen. Reuses the same upload machinery as the post-job
 * photos step; capped at 4 to keep the reasoning screen light.
 */
function ScopePhotoPicker({
  photos,
  onFilesSelected,
  updateCaption,
  removePhoto,
}: {
  photos: PhotoState[];
  onFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  updateCaption?: (id: string, caption: string) => void;
  removePhoto?: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canAddMore = photos.length < 4;

  return (
    <div className="mt-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        onChange={onFilesSelected}
        className="hidden"
      />
      {photos.length > 0 ? (
        <div className="mb-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div
              key={photo.id}
              className="group relative overflow-hidden rounded-lg border border-primary/15 bg-background"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.previewUrl}
                alt=""
                className="aspect-square w-full object-cover"
              />
              {photo.status === "uploading" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <Loader2 className="h-4 w-4 animate-spin text-white" />
                </div>
              ) : null}
              {photo.status === "error" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-destructive/70 text-[10px] font-medium text-white">
                  Failed
                </div>
              ) : null}
              {removePhoto ? (
                <button
                  type="button"
                  onClick={() => removePhoto(photo.id)}
                  className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-90 transition-opacity hover:opacity-100"
                  aria-label="Remove photo"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
              {updateCaption ? (
                <input
                  value={photo.caption}
                  onChange={(event) =>
                    updateCaption(photo.id, event.target.value)
                  }
                  placeholder="Caption"
                  className="block w-full border-t border-primary/10 bg-background/80 px-1.5 py-1 text-[10px] outline-none focus:bg-background"
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {canAddMore ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <Camera className="h-3.5 w-3.5" />
          {photos.length > 0 ? "Add another photo" : "Attach a photo (optional)"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Final-step summary for estimate cycles. Itemized parts + labor + tax +
 * fee + total. Mechanic reviews their numbers before sending for
 * confirmation. Replaces the legacy `SummaryStep` (which assumed a
 * completed job with mileage / timing / difficulty).
 */
function EstimateSummary({
  cycle,
  bookingLabel,
  bookingSubLabel,
  parts,
  laborHours,
  laborRateCents,
  totals,
  quotedTotalCents,
  technicianNotes,
  setTechnicianNotes,
  scopePhotos,
  onScopeFilesSelected,
  updateScopePhotoCaption,
  removeScopePhoto,
}: {
  cycle: PostJobSurveyCycle;
  bookingLabel: string;
  bookingSubLabel: string;
  parts: PartRowState[];
  laborHours: string;
  laborRateCents: number;
  totals: {
    partsCents: number;
    laborCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
  };
  /** Quoted total (cents), client-computed. Pre-job only asks the mechanic to
   *  justify an adjustment when the live total rises above this. Null = unknown
   *  baseline (fall back to always asking). */
  quotedTotalCents?: number | null;
  technicianNotes?: string;
  setTechnicianNotes?: (value: string) => void;
  scopePhotos?: PhotoState[];
  onScopeFilesSelected?: (event: ChangeEvent<HTMLInputElement>) => void;
  updateScopePhotoCaption?: (id: string, caption: string) => void;
  removeScopePhoto?: (id: string) => void;
}) {
  const canAdjust = typeof setTechnicianNotes === "function";
  // Pre-job: the customer already agreed to their quote, so only ask "Why this
  // adjustment?" when the mechanic's live total rises ABOVE the quoted price —
  // leaving it unchanged (or lowering it) needs no justification. Other cycles
  // (mid-job added scope, post-job re-approval) always collect a reason. When
  // the quoted baseline is unknown (null) we fall back to asking.
  const isUnjustifiedPreJob =
    cycle === "pre_job" &&
    quotedTotalCents != null &&
    totals.totalCents <= quotedTotalCents;
  const showReasoning = canAdjust && !isUnjustifiedPreJob;
  const eyebrow = showReasoning ? "Reasoning · review · send" : "Review · send";
  const question = !showReasoning
    ? "Review & send"
    : cycle === "post_job_reapproval"
      ? "Confirm the final billing"
      : cycle === "mid_job"
        ? "Why the added scope?"
        : "Why this adjustment?";
  const reasoningHint =
    cycle === "post_job_reapproval"
      ? "Optional — explain anything the customer should know."
      : cycle === "mid_job"
        ? 'e.g. "Found a seized caliper that needs replacing in addition to the pads."'
        : 'e.g. "OEM pads were back-ordered; substituting Akebono ceramic at higher cost."';
  const hoursNum = Number(laborHours) || 0;
  function laborDurationLabel(mins: number): string {
    const total = Math.round(mins);
    if (total < 60) return `${total} min`;
    const h = Math.floor(total / 60);
    const m = total - h * 60;
    if (m === 0) return `${h} hr`;
    return `${h} hr ${m} min`;
  }
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col">
      <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-center text-[24px] font-semibold leading-tight text-foreground sm:text-[28px]">
        {question}
      </h2>
      <p className="mt-1 text-center text-[12px] text-muted-foreground">
        {bookingSubLabel || bookingLabel}
      </p>

      {showReasoning ? (
        <div className="mt-6">
          <textarea
            value={technicianNotes ?? ""}
            onChange={(event) => setTechnicianNotes?.(event.target.value)}
            placeholder={reasoningHint}
            autoFocus
            className="min-h-[120px] w-full resize-y rounded-xl border border-primary/15 bg-background px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-primary"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Sent to the customer alongside the new total so they know why
            you&apos;re adjusting.
          </p>
          {/* Only pre/mid-job submit paths persist scope photos, so don't offer
              the picker where it would silently no-op. */}
          {onScopeFilesSelected &&
          (cycle === "pre_job" || cycle === "mid_job") ? (
            <ScopePhotoPicker
              photos={scopePhotos ?? []}
              onFilesSelected={onScopeFilesSelected}
              updateCaption={updateScopePhotoCaption}
              removePhoto={removeScopePhoto}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-xl border border-primary/10">
        <div className="bg-primary/[0.025] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Parts
        </div>
        {parts.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-muted-foreground">
            No parts.
          </div>
        ) : (
          <ul className="divide-y divide-primary/5">
            {parts.map((p, idx) => {
              const qty = Math.max(1, Math.round(p.quantity || 1));
              const unit = Number(p.cost) || 0;
              const isCustomer = p.supplied_by === "customer";
              const line = isCustomer ? 0 : unit * qty;
              return (
                <li
                  key={`${p.oem_number || p.part_name}-${idx}`}
                  className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">
                      {p.part_name || p.oem_number || "Part"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {(() => {
                        const id = formatPartIdentity(p);
                        return id ? `${id} · ` : "";
                      })()}
                      qty {qty}
                      {isCustomer
                        ? " · customer-supplied"
                        : unit > 0
                          ? ` · $${unit.toFixed(2)} ea`
                          : ""}
                    </div>
                  </div>
                  <div className="font-medium tabular-nums">
                    ${line.toFixed(2)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-primary/10">
        <ul className="divide-y divide-primary/5">
          <li className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px]">
            <div>
              <div className="font-medium text-foreground">Labor</div>
              <div className="text-[11px] text-muted-foreground">
                {hoursNum > 0
                  ? `${laborDurationLabel(hoursToMinutes(hoursNum))} @ $${(laborRateCents / 100).toFixed(2)}/hr`
                  : "—"}
              </div>
            </div>
            <div className="font-medium tabular-nums">
              ${(totals.laborCents / 100).toFixed(2)}
            </div>
          </li>
          <li className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px] text-muted-foreground">
            <div>Tax</div>
            <div className="tabular-nums">
              ${(totals.taxCents / 100).toFixed(2)}
            </div>
          </li>
          <li className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px] text-muted-foreground">
            <div>Otopair service fee (7%)</div>
            <div className="tabular-nums">
              ${(totals.feeCents / 100).toFixed(2)}
            </div>
          </li>
          <li className="flex items-baseline justify-between gap-3 bg-primary/[0.03] px-4 py-3 text-[14px]">
            <div className="font-semibold text-foreground">Your total</div>
            <div className="font-semibold tabular-nums text-foreground">
              ${(totals.totalCents / 100).toFixed(2)}
            </div>
          </li>
        </ul>
      </div>

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        Tap below to send this for customer confirmation.
      </p>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "decimal" | "numeric" | "text";
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        className="rounded-md border border-primary/15 bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-primary"
      />
    </label>
  );
}
