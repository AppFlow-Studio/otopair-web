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
  Info,
  Loader2,
  Minus,
  Plus,
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
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import {
  getVehicleUpdatePrompts,
  passportSourceLabel,
  serviceLikelyUsesParts,
  sumJobActualParts,
  type JobActualPartPayload,
  type JobRecommendationInput,
  type PartsAccuracyStatus,
  type PostjobPhotoInput,
  type PostJobSurveyPayload,
  type RecommendationUrgency,
  type TimeVariance,
  type TimeVarianceReason,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import { cn } from "@/lib/utils";

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

type PriorOpenRecommendation = {
  _id: string;
  service_name: string;
  is_freeform: boolean;
  urgency: RecommendationUrgency;
  reason: string | null;
  created_at: number;
};

type PostJobPrefillData = {
  vehicleLabel: string;
  serviceName: string;
  serviceSlug: string;
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
};

export type PhotoState = {
  id: string;
  storageId: string;
  previewUrl: string;
  caption: string;
  status: "uploading" | "ready" | "error";
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
  | "photos"
  | "tip"
  | "recommendations"
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

// keep in sync with pre-job-survey-dialog.tsx TIRE_BRAND_OPTIONS — same slugs so pre-job and post-job round-trip
const TIRE_BRAND_DROPDOWN: FluidOption[] = [
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

// keep in sync with pre-job — pre-job does not yet curate tire model, so post-job defines the canonical slugs
const TIRE_MODEL_DROPDOWN: FluidOption[] = [
  // Michelin
  { value: "michelin_defender", label: "Michelin Defender", aliases: ["defender", "defender t+h", "defender ltx m/s"] },
  { value: "michelin_crossclimate2", label: "Michelin CrossClimate2", aliases: ["crossclimate", "crossclimate 2", "cc2"] },
  { value: "michelin_pilot_sport_4s", label: "Michelin Pilot Sport 4S", aliases: ["ps4s", "pilot sport 4s"] },
  { value: "michelin_pilot_sport_as", label: "Michelin Pilot Sport A/S", aliases: ["pilot sport as", "ps as"] },
  { value: "michelin_primacy", label: "Michelin Primacy", aliases: ["primacy", "primacy mxm4", "primacy tour"] },
  // Continental
  { value: "continental_truecontact", label: "Continental TrueContact Tour", aliases: ["truecontact", "true contact"] },
  { value: "continental_extremecontact_dws06", label: "Continental ExtremeContact DWS06+", aliases: ["dws06", "extremecontact dws"] },
  { value: "continental_purecontact_ls", label: "Continental PureContact LS", aliases: ["purecontact"] },
  { value: "continental_procontact", label: "Continental ProContact", aliases: ["procontact"] },
  // Bridgestone
  { value: "bridgestone_turanza", label: "Bridgestone Turanza", aliases: ["turanza"] },
  { value: "bridgestone_potenza", label: "Bridgestone Potenza", aliases: ["potenza", "potenza re980", "potenza s007"] },
  { value: "bridgestone_blizzak", label: "Bridgestone Blizzak", aliases: ["blizzak", "blizzak ws90"] },
  { value: "bridgestone_dueler", label: "Bridgestone Dueler", aliases: ["dueler", "dueler h/l"] },
  // Goodyear
  { value: "goodyear_assurance_weatherready", label: "Goodyear Assurance WeatherReady", aliases: ["assurance weatherready", "weatherready"] },
  { value: "goodyear_eagle_sport", label: "Goodyear Eagle Sport", aliases: ["eagle sport", "eagle f1"] },
  { value: "goodyear_wrangler", label: "Goodyear Wrangler", aliases: ["wrangler", "wrangler trailrunner"] },
  // Pirelli
  { value: "pirelli_pzero", label: "Pirelli P Zero", aliases: ["pzero", "p zero"] },
  { value: "pirelli_cinturato_p7", label: "Pirelli Cinturato P7", aliases: ["cinturato", "cinturato p7"] },
  { value: "pirelli_scorpion", label: "Pirelli Scorpion", aliases: ["scorpion", "scorpion verde"] },
  // Hankook
  { value: "hankook_kinergy", label: "Hankook Kinergy", aliases: ["kinergy", "kinergy gt", "kinergy pt"] },
  { value: "hankook_ventus", label: "Hankook Ventus", aliases: ["ventus", "ventus v12"] },
  { value: "hankook_dynapro", label: "Hankook Dynapro", aliases: ["dynapro"] },
  // Yokohama
  { value: "yokohama_avid_ascend", label: "Yokohama Avid Ascend", aliases: ["avid ascend", "avid ascend gt"] },
  { value: "yokohama_geolandar", label: "Yokohama Geolandar", aliases: ["geolandar"] },
  { value: "yokohama_advan", label: "Yokohama Advan", aliases: ["advan", "advan sport"] },
  // Toyo
  { value: "toyo_proxes", label: "Toyo Proxes", aliases: ["proxes", "proxes sport"] },
  { value: "toyo_open_country", label: "Toyo Open Country", aliases: ["open country", "open country at"] },
  // Falken
  { value: "falken_azenis", label: "Falken Azenis", aliases: ["azenis", "azenis fk510"] },
  { value: "falken_wildpeak", label: "Falken Wildpeak", aliases: ["wildpeak", "wildpeak at3w"] },
  // BFGoodrich
  { value: "bfg_advantage_ta", label: "BFGoodrich Advantage T/A", aliases: ["advantage ta", "advantage t/a"] },
  { value: "bfg_at_ko2", label: "BFGoodrich All-Terrain T/A KO2", aliases: ["ko2", "at ko2", "all terrain ko2"] },
  // Cooper / General
  { value: "cooper_discoverer", label: "Cooper Discoverer", aliases: ["discoverer", "discoverer at3"] },
  { value: "general_altimax", label: "General AltiMAX", aliases: ["altimax", "altimax rt43"] },
];

// keep in sync with pre-job — normalized form (e.g. "225/45R18") matches normalizeTireSizeValue() in pre-job-survey-dialog.tsx
const TIRE_SIZE_DROPDOWN: FluidOption[] = [
  "195/65R15",
  "205/55R16",
  "215/55R17",
  "215/60R16",
  "225/45R17",
  "225/45R18",
  "225/50R17",
  "225/55R17",
  "225/60R17",
  "235/45R18",
  "235/55R18",
  "235/60R18",
  "245/40R18",
  "245/40R19",
  "245/45R18",
  "245/45R19",
  "255/35R19",
  "255/40R19",
  "255/45R20",
  "265/70R17",
  "275/35R19",
  "275/35R20",
  "275/40R19",
  "275/40R20",
  "275/45R20",
  "285/45R22",
  "295/35R21",
].map((size) => ({
  value: size,
  label: size,
  aliases: [size.replace(/(\d+)\/(\d+)R(\d+)/i, "$1 / $2 R $3"), size.toLowerCase()],
}));

// keep in sync with pre-job — pre-job does not yet curate pad brand, so post-job defines the canonical slugs
const BRAKE_PAD_BRAND_DROPDOWN: FluidOption[] = [
  { value: "akebono", label: "Akebono" },
  { value: "brembo", label: "Brembo" },
  { value: "ebc", label: "EBC" },
  { value: "wagner", label: "Wagner" },
  { value: "bosch", label: "Bosch" },
  { value: "raybestos", label: "Raybestos" },
  { value: "power_stop", label: "Power Stop", aliases: ["powerstop"] },
  { value: "hawk", label: "Hawk" },
  { value: "nrs_galvanized", label: "NRS Galvanized", aliases: ["nrs"] },
  { value: "acdelco", label: "ACDelco", aliases: ["ac delco", "ac-delco"] },
  { value: "motorcraft", label: "Motorcraft" },
  { value: "mopar", label: "Mopar" },
  { value: "stoptech", label: "StopTech", aliases: ["stop tech"] },
  { value: "centric", label: "Centric" },
  { value: "carquest", label: "Carquest" },
  { value: "napa", label: "NAPA" },
  { value: "oem", label: "OEM (vehicle brand)", aliases: ["oe", "factory"] },
];

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
      cost: Number.isFinite(part.cost) ? String(part.cost) : "",
      quantity:
        typeof part.quantity === "number" && Number.isFinite(part.quantity)
          ? Math.max(1, Math.round(part.quantity))
          : 1,
      supplied_by: part.supplied_by === "customer" ? "customer" : "shop",
      part_tier: part.part_tier ?? "oem",
      service_id: part.service_id ?? null,
      source: resolvedSource,
      not_used: part.not_used === true ? true : undefined,
      learned_from:
        part.learned_from === "vin" ||
        part.learned_from === "shop" ||
        part.learned_from === "config" ||
        part.learned_from === "catalog"
          ? part.learned_from
          : undefined,
    };
  });
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
  initialTechnicianNotes,
  initialPhotos,
  cycle,
  onApprovalSubmitted,
  laborRateCents,
  laborCostDollars,
  shopState,
  shopZip,
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
  onSubmit: (payload: PostJobSurveyPayload) => Promise<void>;
  initialTechnicianNotes?: string;
  initialPhotos?: PhotoState[];
  cycle?: PostJobSurveyCycle;
  onApprovalSubmitted?: (result: {
    state: string;
    totalCents: number;
    ceilingCents: number;
  }) => void;
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
}) {
  return (
    <PostJobSurveyDialogBody
      key={`${passportData?.vin ?? "no-vin"}-${bookingLabel}-${prefillData?.serviceSlug ?? "no-service"}-${cycle ?? "postjob"}`}
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
      initialTechnicianNotes={initialTechnicianNotes ?? ""}
      initialPhotos={initialPhotos ?? []}
      cycle={cycle}
      onApprovalSubmitted={onApprovalSubmitted}
      laborRateCents={laborRateCents ?? null}
      laborCostDollars={laborCostDollars ?? null}
      shopState={shopState ?? null}
      shopZip={shopZip ?? null}
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
  initialTechnicianNotes,
  initialPhotos,
  cycle,
  onApprovalSubmitted,
  laborRateCents,
  laborCostDollars,
  shopState,
  shopZip,
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
  onSubmit: (payload: PostJobSurveyPayload) => Promise<void>;
  initialTechnicianNotes: string;
  initialPhotos: PhotoState[];
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
  // Re-entry: if the dialog opens on a booking that already has an in-flight
  // approval for *this* cycle, jump straight to the status panel.
  // A mid-job dialog opened on a booking still at pre_job_approved /
  // in_range is a brand-new cycle, not a re-entry — render the form.
  useEffect(() => {
    if (!cycle) return;
    if (submittedForApproval) return;
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
  const [parts, setParts] = useState<PartRowState[]>(
    buildPartRows(prefillData?.suggestedParts ?? [])
  );
  const [vehicleUpdates, setVehicleUpdates] = useState<
    Record<string, string | boolean>
  >(
    Object.fromEntries(
      updatePrompts.map((prompt) => [prompt.key, prompt.value ?? ""])
    )
  );
  const [technicianNotes, setTechnicianNotes] = useState(initialTechnicianNotes);
  const [flaggedVehicleSpecs, setFlaggedVehicleSpecs] = useState(false);
  const [flaggedReason, setFlaggedReason] = useState("");
  const [actualLaborMinutes, setActualLaborMinutes] = useState(
    typeof estimatedLaborMinutes === "number"
      ? String(estimatedLaborMinutes)
      : ""
  );
  const [actualPartsCost, setActualPartsCost] = useState("");
  const [difficultyRating, setDifficultyRating] = useState("");
  const [partsAccuracyStatus, setPartsAccuracyStatus] =
    useState<PartsAccuracyStatus | null>(null);
  const [partsAccuracyFeedback, setPartsAccuracyFeedback] = useState("");
  const [additionalObservations, setAdditionalObservations] = useState("");
  const [recommendations, setRecommendations] = useState<RecRowState[]>([]);
  const [photos, setPhotos] = useState<PhotoState[]>(initialPhotos);
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
    if (updatePrompts.length > 0 && !isEstimateCycle) list.push("vehicle_updates");
    list.push("flag");
    // Optional steps follow — each shows a Skip button in the top-right.
    if (!isEstimateCycle) {
      list.push("time_check");
      if (timeVariance && timeVariance !== "on_time") list.push("time_reason");
      list.push("difficulty");
    }
    list.push("photos");
    if (!isEstimateCycle) {
      list.push("tip");
      list.push("recommendations");
    }
    list.push("summary");
    return list;
  }, [
    cycle,
    timeVariance,
    requiresParts,
    prefillData?.suggestedParts?.length,
    updatePrompts.length,
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
    let partsCents = 0;
    for (const p of parts) {
      if (p.not_used) continue;
      if (p.supplied_by === "customer") continue;
      const cost = Number(p.cost) || 0;
      const qty = Math.max(1, Math.round(p.quantity || 1));
      partsCents += Math.round(cost * qty * 100);
    }
    const hours = Number(actualLaborMinutes) || 0;
    const laborCents = hours > 0
      ? Math.round((hours / 60) * effectiveLaborRateCents)
      : 0;
    const subtotalCents = partsCents + laborCents;
    const tax = computeBookingTax({
      laborDollars: laborCents / 100,
      partsDollars: partsCents / 100,
      state: shopState ?? null,
      zip: shopZip ?? null,
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
  }, [
    isEstimateCycle,
    parts,
    actualLaborMinutes,
    effectiveLaborRateCents,
    shopState,
    shopZip,
  ]);

  const [stepIndex, setStepIndex] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);

  // Note: we intentionally do NOT compare the mechanic's per-row price to a
  // catalog median in the UI. The shop sets the price; the customer decides.
  // The justification gate for manual parts (source="manual") remains
  // enforced server-side in validatePartsForApproval.

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
          source: part.source,
          swap_from_oem_number: part.swap_from_oem_number || undefined,
          not_used: notUsed ? true : undefined,
        };
      })
      .filter(
        (part) =>
          part.part_name ||
          part.brand ||
          part.oem_number ||
          (Number.isFinite(part.cost) && part.cost > 0) ||
          part.supplied_by === "customer" ||
          part.not_used === true
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
        "This service requires parts — please add at least one part used before submitting."
      );
      const partsIdx = visibleSteps.indexOf("parts");
      if (partsIdx >= 0) setStepIndex(partsIdx);
      return;
    }
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

    const photosPayload: PostjobPhotoInput[] = photos
      .filter((photo) => photo.status === "ready" && photo.storageId)
      .map((photo) => ({
        storage_id: photo.storageId,
        caption: photo.caption.trim() || null,
        taken_at: Date.now(),
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
        source: p.source ?? undefined,
        swap_from_oem_number: p.swap_from_oem_number ?? undefined,
        not_used: p.not_used ?? undefined,
        justification_text: (p as any).justification_text ?? undefined,
        evidence_photo_ids: (p as any).evidence_photo_ids ?? undefined,
      }));
      const laborMinutes =
        actualLaborMinutes.trim() === "" ? null : Number(actualLaborMinutes);
      const laborHours =
        laborMinutes != null && Number.isFinite(laborMinutes) && laborMinutes > 0
          ? laborMinutes / 60
          : undefined;
      // Send the rate alongside hours so the server can multiply directly
      // instead of falling back to booking.labor_cost. effectiveLaborRateCents
      // priorities shop.labor_rate, falls back to the booking's quoted rate,
      // then a $125 default.
      const laborRateCentsForSubmit = laborHours != null
        ? effectiveLaborRateCents
        : undefined;
      try {
        let result;
        if (cycle === "pre_job") {
          result = await submitPreJobEstimate({
            bookingId: bookingId as any,
            parts: partsForApproval as any,
            laborHours,
            laborRateCents: laborRateCentsForSubmit,
            notes: technicianNotes.trim() || undefined,
          });
        } else if (cycle === "mid_job") {
          result = await submitMidJobChange({
            bookingId: bookingId as any,
            parts: partsForApproval as any,
            laborHours,
            laborRateCents: laborRateCentsForSubmit,
            notes: technicianNotes.trim() || undefined,
          });
        }
        if (result) {
          onApprovalSubmitted?.(result as any);
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
      flagged_vehicle_specs: flaggedVehicleSpecs,
      flagged_vehicle_specs_reason: flaggedReason.trim() || null,
      actual_labor_minutes:
        actualLaborMinutes.trim() === "" ? null : Number(actualLaborMinutes),
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
            visible_to_driver: r.visible_to_driver,
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
    });
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

  const showOneMore =
    answeredCount === 6 || answeredCount === 9;
  const skipMoreVisible = answeredCount >= 5;
  // Required steps that cannot be skipped: mileage, parts used, parts accuracy,
  // vehicle passport updates, and flag-for-review. Everything else is optional.
  const REQUIRED_STEPS: StepKey[] = [
    "mileage",
    "parts",
    "parts_accuracy",
    "vehicle_updates",
    "flag",
  ];
  const skipHiddenForStep = REQUIRED_STEPS.includes(currentStep);

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
              "h-1 rounded-full transition-all",
              idx === stepIndex
                ? "w-6 bg-primary"
                : idx < stepIndex
                  ? "w-3 bg-primary/40"
                  : "w-3 bg-primary/10"
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
          onReviseRequested={() => setSubmittedForApproval(false)}
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
            <div className="mx-auto mb-6 w-full max-w-xl rounded-xl border border-primary/10 bg-muted/40 px-3 py-2">
              {prefillData?.serviceName ? (
                <p className="truncate text-center text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
                  {prefillData.serviceName}
                </p>
              ) : null}
              {passportData?.vehicle_spec_label ? (
                <p className="truncate text-center text-[12px] font-medium text-foreground/80">
                  {passportData.vehicle_spec_label}
                </p>
              ) : null}
            </div>
          ) : null}

          <StepContent
            step={currentStep}
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
            actualLaborMinutes={actualLaborMinutes}
            setActualLaborMinutes={setActualLaborMinutes}
            parts={parts}
            setParts={setParts}
            requiresParts={requiresParts}
            partsRequiredServices={passportData?.parts_required_services ?? []}
            suggestedParts={prefillData?.suggestedParts ?? []}
            oemRecommendations={prefillData?.oemRecommendations ?? []}
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
            technicianNotes={technicianNotes}
            setTechnicianNotes={setTechnicianNotes}
            additionalObservations={additionalObservations}
            setAdditionalObservations={setAdditionalObservations}
            recommendations={recommendations}
            setRecommendations={setRecommendations}
            engineId={prefillData?.engineId ?? null}
            priorOpenRecommendations={
              prefillData?.priorOpenRecommendations ?? []
            }
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
          />

          {showOneMore && !isLast ? (
            <p className="mt-6 text-center text-[12px] font-medium text-muted-foreground">
              Thanks — one more?
            </p>
          ) : null}

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
            {isLast ? (
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
                onClick={goNext}
                disabled={!canAdvance(currentStep, {
                  completionMileage,
                  timeReason,
                  timeReasonNote,
                  partsAccuracyStatus,
                  partsAccuracyFeedback,
                  requiresParts,
                  filledPartsCount: parts.filter((p) => p.part_name.trim() !== "").length,
                  recommendations,
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
    timeReason: TimeVarianceReason | null;
    timeReasonNote: string;
    partsAccuracyStatus: PartsAccuracyStatus | null;
    partsAccuracyFeedback: string;
    requiresParts: boolean;
    filledPartsCount: number;
    recommendations: RecRowState[];
  }
) {
  if (step === "recommendations") {
    // Every rec for a has_options service must carry a pick.
    return state.recommendations.every((r) => {
      if (!r.recommended_service_id) return true;
      if (r.service_slug === "tire-replacement") return r.tire_specs != null;
      if (r.service_has_options) return r.selected_service_option != null;
      return true;
    });
  }
  if (step === "mileage") return state.completionMileage.trim() !== "";
  if (step === "time_reason") {
    if (state.timeReason === "other") return state.timeReasonNote.trim() !== "";
    return state.timeReason !== null;
  }
  if (step === "parts") {
    // If the service is flagged as requiring parts, the mechanic must add at
    // least one part with a non-empty name before moving on.
    if (state.requiresParts) return state.filledPartsCount > 0;
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
  actualLaborMinutes: string;
  setActualLaborMinutes: (value: string) => void;
  parts: PartRowState[];
  setParts: React.Dispatch<React.SetStateAction<PartRowState[]>>;
  requiresParts: boolean;
  // List of services on this booking whose catalog row sets requires_parts.
  // Used by PartsStep to render one parts block per service when length > 1.
  partsRequiredServices: Array<{ _id: string; name: string }>;
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
  technicianNotes: string;
  setTechnicianNotes: (value: string) => void;
  additionalObservations: string;
  setAdditionalObservations: (value: string) => void;
  recommendations: RecRowState[];
  setRecommendations: React.Dispatch<React.SetStateAction<RecRowState[]>>;
  engineId: string | null;
  priorOpenRecommendations: PriorOpenRecommendation[];
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
    case "mileage":
      return (
        <QuestionScreen
          eyebrow="Required"
          question="What's the current odometer?"
          hint="Vehicle passport keeps this on the VIN."
        >
          <input
            value={props.completionMileage}
            onChange={(event) => props.setCompletionMileage(event.target.value)}
            inputMode="numeric"
            autoFocus
            placeholder="0"
            className="w-full rounded-2xl border border-primary/15 bg-background py-5 text-center text-[36px] font-semibold tracking-tight outline-none focus:border-primary"
          />
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            miles
          </p>
          {props.estimatedLaborMinutes ? (
            <div className="mt-8">
              <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Actual labor time (optional)
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  value={props.actualLaborMinutes}
                  onChange={(event) =>
                    props.setActualLaborMinutes(event.target.value)
                  }
                  inputMode="numeric"
                  placeholder="Minutes"
                  className="w-32 rounded-lg border border-primary/15 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary"
                />
                <span className="text-[11px] text-muted-foreground">
                  Est. {props.estimatedLaborMinutes} min
                </span>
              </div>
            </div>
          ) : null}
        </QuestionScreen>
      );
    case "parts":
      return (
        <PartsStep
          parts={props.parts}
          setParts={props.setParts}
          requiresParts={props.requiresParts}
          partsRequiredServices={props.partsRequiredServices}
          suggestedParts={props.suggestedParts}
          oemRecommendations={props.oemRecommendations}
          actualPartsCost={props.actualPartsCost}
          setActualPartsCost={props.setActualPartsCost}
          partsCostSum={props.partsCostSum}
          vehicleLabel={props.vehicleLabel}
          engineCode={props.engineCode}
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
    case "photos":
      return (
        <PhotosStep
          photos={props.photos}
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
    case "recommendations":
      return (
        <RecommendationsStep
          recommendations={props.recommendations}
          setRecommendations={props.setRecommendations}
          engineId={props.engineId}
          priorOpenRecommendations={props.priorOpenRecommendations}
          additionalObservations={props.additionalObservations}
          setAdditionalObservations={props.setAdditionalObservations}
          completionMileage={props.completionMileage}
        />
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
          minutes={props.actualLaborMinutes}
          setMinutes={props.setActualLaborMinutes}
          rateCents={props.laborRateCents}
          estimatedLaborMinutes={props.estimatedLaborMinutes}
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
            laborMinutes={props.actualLaborMinutes}
            laborRateCents={props.laborRateCents}
            totals={props.liveTotals}
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
            props.photos.filter((p) => p.status === "ready").length
          }
          flagged={props.flaggedVehicleSpecs}
        />
      );
  }
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
        <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="mt-2 text-center text-[24px] font-semibold leading-tight text-foreground sm:text-[28px]">
        {question}
      </h2>
      {hint ? (
        <p className="mt-2 text-center text-[12px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <div className="mt-8">{children}</div>
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
  suggestedParts,
  oemRecommendations,
  actualPartsCost,
  setActualPartsCost,
  partsCostSum,
  vehicleLabel,
  engineCode,
}: {
  parts: PartRowState[];
  setParts: React.Dispatch<React.SetStateAction<PartRowState[]>>;
  requiresParts: boolean;
  // List of services on this booking whose catalog row sets requires_parts.
  // Used by PartsStep to render one parts block per service when length > 1.
  partsRequiredServices: Array<{ _id: string; name: string }>;
  suggestedParts: JobActualPartPayload[];
  oemRecommendations: OemRecommendation[];
  actualPartsCost: string;
  setActualPartsCost: (value: string) => void;
  partsCostSum: number;
  vehicleLabel: string | null;
  engineCode: string | null;
}) {
  const normalizeOem = (n: string) =>
    n.trim().toUpperCase().replace(/\s+/g, "");
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
  const prefilled = suggestedParts.length > 0;
  // Step copy adapts: when the cascade pre-loaded suggestions, the step is
  // "confirm what we already think you used" — otherwise it's "tell us what
  // you used."
  const eyebrow = prefilled ? "Confirm" : requiresParts ? "Required" : "Optional";
  const question = prefilled ? "Confirm parts used" : "What parts did you use?";
  const hint = prefilled
    ? "Verify the inventory used during this service task."
    : requiresParts
      ? "This service requires parts — please add at least one part used before continuing."
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

        {parts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-primary/20 bg-muted/30 px-4 py-6 text-center text-[12px] text-muted-foreground">
            No parts added yet.
          </div>
        ) : (
          parts.map((part, index) => {
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
                      {partsRequiredServices.length > 1 && part.service_id ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded-md bg-primary/8 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.06em] text-primary/80"
                          title="Service this part is attributed to"
                        >
                          {partsRequiredServices.find(
                            (s) => s._id === part.service_id,
                          )?.name ?? ""}
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
                          <span
                            className={`${lockedSmallClasses} mt-0.5 block font-mono tabular-nums`}
                            title="From catalog — swap the part to change its OEM number."
                          >
                            {part.oem_number || "—"}
                          </span>
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
                    {!isNotUsed && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="text-muted-foreground">
                        {isCustomer ? "Customer-supplied:" : "Price per unit: "}
                      </span>
                      {isCustomer ? (
                        <span className="font-medium text-muted-foreground">$0</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">$</span>
                          <input
                            value={part.cost}
                            onChange={(event) => {
                              const raw = event.target.value;
                              // Allow empty, digits, optional single dot, max 2 decimals.
                              if (raw === "" || /^\d*\.?\d{0,2}$/.test(raw)) {
                                updatePart(index, { cost: raw });
                              }
                            }}
                            onBlur={(event) => {
                              const raw = event.target.value.trim();
                              if (raw === "" || raw === ".") return;
                              const n = Number(raw);
                              if (Number.isFinite(n)) {
                                updatePart(index, {
                                  cost: (Math.round(n * 100) / 100).toFixed(2),
                                });
                              }
                            }}
                            inputMode="decimal"
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
                            className="h-6 w-20 rounded-md border border-primary/10 bg-background px-1.5 text-[12px] font-medium tabular-nums outline-none focus:border-primary/30"
                          />
                        </div>
                      )}
                    </div>
                    )}
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
          Add-row controls. For multi-service bookings each parts-required
          service gets its own button so the new row is stamped with the
          right service_id and snapshots attribute correctly downstream.
        */}
        {partsRequiredServices.length > 1 ? (
          <div className="grid gap-2 sm:grid-cols-2">
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
                      cost: "",
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
                  cost: "",
                  quantity: 1,
                  supplied_by: "shop",
                  part_tier: "oem",
                  service_id: partsRequiredServices[0]?._id ?? null,
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
                ? " — swap any rows that aren't what you installed."
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
  onFilesSelected,
  updatePhotoCaption,
  removePhoto,
}: {
  photos: PhotoState[];
  onFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  updatePhotoCaption: (id: string, caption: string) => void;
  removePhoto: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canAddMore = photos.length < 6;

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
  additionalObservations,
  setAdditionalObservations,
  completionMileage,
}: {
  recommendations: RecRowState[];
  setRecommendations: React.Dispatch<React.SetStateAction<RecRowState[]>>;
  engineId: string | null;
  priorOpenRecommendations: PriorOpenRecommendation[];
  additionalObservations: string;
  setAdditionalObservations: (value: string) => void;
  completionMileage: string;
}) {
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const [slotPickerIndex, setSlotPickerIndex] = useState<number | null>(null);
  const [optionPickerIndex, setOptionPickerIndex] = useState<number | null>(null);
  const [tirePickerIndex, setTirePickerIndex] = useState<number | null>(null);
  const currentMileage = Number(completionMileage);
  const mileageHint =
    Number.isFinite(currentMileage) && currentMileage > 0
      ? Math.round((currentMileage + 5000) / 1000) * 1000
      : null;

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
        target_mileage: "",
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
            {priorOpenRecommendations.map((rec) => (
              <li
                key={rec._id}
                className="flex items-start gap-2 text-[12px] text-foreground/80"
              >
                <span className="mt-1 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground" />
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
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-muted-foreground">
            You'll confirm these on the next pre-job survey.
          </p>
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
                  <div>
                    <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Trigger at mileage
                    </label>
                    <div className="mt-1 flex items-center gap-1.5 rounded-lg border border-primary/15 bg-background px-2.5">
                      <Gauge
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-hidden
                      />
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1000}
                        value={rec.target_mileage}
                        onChange={(event) =>
                          updateRec(index, {
                            target_mileage: event.target.value,
                          })
                        }
                        placeholder={
                          mileageHint ? mileageHint.toLocaleString() : "e.g. 170000"
                        }
                        className="h-9 w-full bg-transparent text-[12px] outline-none"
                      />
                      <span className="text-[11px] text-muted-foreground">mi</span>
                    </div>
                  </div>
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

                <div className="mt-2.5 flex items-center justify-end gap-2 border-t border-primary/10 pt-2.5">
                  <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                    <span className="text-[11px] text-muted-foreground">
                      Visible to driver
                    </span>
                    <span
                      role="switch"
                      aria-checked={rec.visible_to_driver}
                      tabIndex={0}
                      onClick={() =>
                        updateRec(index, {
                          visible_to_driver: !rec.visible_to_driver,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          updateRec(index, {
                            visible_to_driver: !rec.visible_to_driver,
                          });
                        }
                      }}
                      className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                        rec.visible_to_driver ? "bg-primary" : "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 transform rounded-full bg-background shadow-sm transition-transform",
                          rec.visible_to_driver
                            ? "translate-x-4"
                            : "translate-x-0.5",
                        )}
                      />
                    </span>
                  </label>
                </div>
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
function ServicePickerModal({
  engineId,
  initialQuery,
  onClose,
  onPick,
}: {
  engineId: string | null;
  initialQuery: string;
  onClose: () => void;
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
  const [query, setQuery] = useState(initialQuery);
  const results = useQuery(api.services.listForVehicle, {
    engineId: (engineId ?? undefined) as never,
    query,
    limit: 25,
  });
  const trimmed = query.trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a service"
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
              Pick a service
            </p>
            <p className="text-[13px] font-semibold">
              Vehicle-matched first
            </p>
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
              placeholder="Search the service catalog…"
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
          ) : (
            <>
              {results.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-muted-foreground">
                  No matching services.
                </div>
              ) : (
                <ul className="space-y-1">
                  {results.map((svc) => (
                    <li key={svc._id}>
                      <button
                        type="button"
                        onClick={() =>
                          onPick({
                            kind: "service",
                            id: svc._id,
                            name: svc.name,
                            slug: (svc as any).slug ?? null,
                            has_options: Boolean((svc as any).has_options),
                          })
                        }
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-3 py-2 text-left transition-colors hover:border-primary/15 hover:bg-primary/5"
                      >
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {svc.name}
                        </span>
                        {svc.is_vehicle_match ? (
                          <span className="inline-flex shrink-0 items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-primary">
                            Fits car
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {trimmed.length >= 2 ? (
                <div className="mt-3 border-t border-primary/10 pt-3">
                  <p className="px-3 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    Can't find it?
                  </p>
                  <button
                    type="button"
                    onClick={() => onPick({ kind: "freeform", name: trimmed })}
                    className="mt-1 flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-left text-[12px] text-primary transition-colors hover:bg-primary/10"
                  >
                    <span>
                      Submit "<span className="font-semibold">{trimmed}</span>"
                      for review
                    </span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
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
  flagged: boolean;
}) {
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
                Start work →
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
                  : `You're cleared to start work${setPrice ? ` · ${setPrice}` : ""}.`}
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
                Start work →
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
                  ? "Work continues at the previously approved scope. No new charges will be added."
                  : "You can adjust the price and resend, or release the vehicle."}
            </p>
            {cycle === "mid_job" || cycle === "post_job_reapproval" ? (
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
 * Labor step for estimate cycles. Mechanic enters labor hours; the
 * displayed labor cost is `hours × shop labor_rate`. The same rate is sent
 * to the submit mutation so the server's recomputation lands on the same
 * number the mechanic just saw.
 */
function LaborStep({
  minutes,
  setMinutes,
  rateCents,
  estimatedLaborMinutes,
}: {
  minutes: string;
  setMinutes: (value: string) => void;
  rateCents: number;
  estimatedLaborMinutes: number | null;
}) {
  const minutesNum = Number(minutes) || 0;
  const hours = minutesNum > 0 ? minutesNum / 60 : 0;
  const laborDollars = hours > 0 ? (hours * rateCents) / 100 : 0;
  const ratePerHourDollars = (rateCents / 100).toFixed(2);
  return (
    <QuestionScreen
      eyebrow="Labor"
      question="How long will this take?"
      hint={`Your shop's labor rate is $${ratePerHourDollars}/hr — we'll multiply by the hours you enter.`}
    >
      <div className="mx-auto flex w-full max-w-xs flex-col items-center gap-3">
        <div className="flex items-baseline gap-2">
          <input
            value={minutes}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "" || /^\d{0,4}$/.test(raw)) setMinutes(raw);
            }}
            inputMode="numeric"
            placeholder={
              typeof estimatedLaborMinutes === "number" && estimatedLaborMinutes > 0
                ? String(estimatedLaborMinutes)
                : "0"
            }
            className="h-16 w-28 rounded-xl border border-primary/15 bg-background text-center text-[36px] font-semibold tabular-nums outline-none focus:border-primary"
          />
          <span className="text-[13px] text-muted-foreground">minutes</span>
        </div>
        {typeof estimatedLaborMinutes === "number" && estimatedLaborMinutes > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Quoted estimate: {estimatedLaborMinutes} minutes
          </p>
        ) : null}
        <div className="mt-2 flex items-baseline justify-center gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            Labor cost
          </span>
          <span className="text-[18px] font-semibold tabular-nums">
            ${laborDollars.toFixed(2)}
          </span>
        </div>
      </div>
    </QuestionScreen>
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
  laborMinutes,
  laborRateCents,
  totals,
}: {
  cycle: PostJobSurveyCycle;
  bookingLabel: string;
  bookingSubLabel: string;
  parts: PartRowState[];
  laborMinutes: string;
  laborRateCents: number;
  totals: {
    partsCents: number;
    laborCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
  };
}) {
  const eyebrow = "Review and send";
  const question =
    cycle === "post_job_reapproval"
      ? "Confirm the final billing"
      : cycle === "mid_job"
        ? "Confirm the added scope"
        : "Confirm your price";
  const minutesNum = Number(laborMinutes) || 0;
  const hours = minutesNum > 0 ? minutesNum / 60 : 0;
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
                      {p.oem_number ? `${p.oem_number} · ` : ""}
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
                {hours > 0
                  ? `${hours.toFixed(2)} hr @ $${(laborRateCents / 100).toFixed(2)}/hr`
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
