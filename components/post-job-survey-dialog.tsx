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
  ArrowLeft,
  ArrowLeftRight,
  Camera,
  Car,
  Check,
  ChevronRight,
  Info,
  Loader2,
  Minus,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import SurveyDialogShell from "@/components/survey-dialog-shell";
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
  freeform_service_name: string;
  urgency: RecommendationUrgency;
  reason: string;
  visible_to_driver: boolean;
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
};

type PhotoState = {
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

const FLUID_OPTIONS_BY_KEY: Record<string, FluidOption[]> = {
  oil_viscosity: OIL_VISCOSITY_DROPDOWN,
  oil_type: OIL_TYPE_DROPDOWN,
  coolant_type: COOLANT_TYPE_DROPDOWN,
  brake_fluid_type: BRAKE_FLUID_DROPDOWN,
  transmission_fluid_type: TRANSMISSION_FLUID_DROPDOWN,
};

const FLUID_PLACEHOLDERS: Record<string, { placeholder: string; otherPlaceholder: string }> = {
  oil_viscosity: { placeholder: "Select viscosity…", otherPlaceholder: "Oil viscosity" },
  oil_type: { placeholder: "Select oil type…", otherPlaceholder: "Oil type" },
  coolant_type: { placeholder: "Select coolant chemistry…", otherPlaceholder: "Coolant type" },
  brake_fluid_type: { placeholder: "Select DOT spec…", otherPlaceholder: "Brake fluid type" },
  transmission_fluid_type: { placeholder: "Select ATF spec…", otherPlaceholder: "Transmission fluid type" },
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

function buildPartRows(parts: JobActualPartPayload[]): PartRowState[] {
  return parts.map((part) => ({
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
  }));
}

function makePhotoId() {
  return `photo_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

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
}) {
  return (
    <PostJobSurveyDialogBody
      key={`${passportData?.vin ?? "no-vin"}-${bookingLabel}-${prefillData?.serviceSlug ?? "no-service"}`}
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
}) {
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
  const [technicianNotes, setTechnicianNotes] = useState("");
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
  const [photos, setPhotos] = useState<PhotoState[]>([]);
  const [error, setError] = useState("");

  const generateUploadUrl = useMutation(generateUploadUrlRef) as (args: {
    bookingId: string;
  }) => Promise<string>;

  // Steps
  const visibleSteps = useMemo<StepKey[]>(() => {
    const list: StepKey[] = [];
    // Required, non-skippable steps come first.
    list.push("mileage");
    if (requiresParts || (prefillData?.suggestedParts?.length ?? 0) > 0) {
      list.push("parts");
    }
    if (requiresParts) list.push("parts_accuracy");
    if (updatePrompts.length > 0) list.push("vehicle_updates");
    list.push("flag");
    // Optional steps follow — each shows a Skip button in the top-right.
    list.push("time_check");
    if (timeVariance && timeVariance !== "on_time") list.push("time_reason");
    list.push("difficulty");
    list.push("photos");
    list.push("tip");
    list.push("recommendations");
    list.push("summary");
    return list;
  }, [
    timeVariance,
    requiresParts,
    prefillData?.suggestedParts?.length,
    updatePrompts.length,
  ]);

  const [stepIndex, setStepIndex] = useState(0);
  const [answeredCount, setAnsweredCount] = useState(0);

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
        return {
          part_name: part.part_name.trim(),
          brand: part.brand.trim() || null,
          oem_number: part.oem_number.trim(),
          cost,
          quantity,
          supplied_by: suppliedBy,
          part_tier: part.part_tier || "oem",
        };
      })
      .filter(
        (part) =>
          part.part_name ||
          part.brand ||
          part.oem_number ||
          (Number.isFinite(part.cost) && part.cost > 0) ||
          part.supplied_by === "customer"
      );
  }

  async function handleFinalSubmit() {
    const parsedMileage = Number(completionMileage);
    if (!Number.isFinite(parsedMileage) || completionMileage.trim() === "") {
      setError("Completion mileage is required.");
      const mileageIdx = visibleSteps.indexOf("mileage");
      if (mileageIdx >= 0) setStepIndex(mileageIdx);
      return;
    }

    const normalizedParts = normalizeParts();
    if (requiresParts && normalizedParts.length === 0) {
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
        .map<JobRecommendationInput>((r) => ({
          recommended_service_id: r.recommended_service_id,
          freeform_service_name: r.recommended_service_id
            ? null
            : r.freeform_service_name.trim() || null,
          urgency: r.urgency,
          reason: r.reason.trim() || null,
          visible_to_driver: r.visible_to_driver,
        })),
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

  return (
    <SurveyDialogShell
      open={open}
      title="Job report"
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
                Submit report
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
  }
) {
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
                  ) : FLUID_OPTIONS_BY_KEY[prompt.key as string] ? (
                    <FluidSelectField
                      value={String(props.vehicleUpdates[prompt.key] ?? "")}
                      onChange={(next) =>
                        props.setVehicleUpdates((current) => ({
                          ...current,
                          [prompt.key]: next,
                        }))
                      }
                      options={FLUID_OPTIONS_BY_KEY[prompt.key as string]}
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
                    <input
                      value={String(props.vehicleUpdates[prompt.key] ?? "")}
                      onChange={(event) =>
                        props.setVehicleUpdates((current) => ({
                          ...current,
                          [prompt.key]: event.target.value,
                        }))
                      }
                      placeholder="Update"
                      className="w-full rounded-lg border border-primary/15 bg-background px-3 py-2 text-[13px] outline-none focus:border-primary sm:w-48"
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
    case "summary":
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
    updatePart(swapIndex, {
      part_name: next.part_name,
      oem_number: next.oem_number,
      brand: next.brand ?? "",
      part_tier: next.part_tier ?? "oem",
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
            const tierLabel = tierLabelOf(part.part_tier);
            const qty = Math.max(1, part.quantity || 1);
            const oemKey = normalizeOem(part.oem_number ?? "");
            const oemRec = oemKey.length > 0 ? oemRecommendedMap.get(oemKey) : undefined;
            const isOemRecommended = !!oemRec;
            const sourcesUsed = oemRec?.price_sources_used ?? 0;
            const avgPrice = oemRec?.average_price ?? 0;
            return (
              <div
                key={index}
                className="rounded-2xl border border-primary/15 bg-background px-3 py-3"
              >
                {/* Top: name + tier chip on the left, quantity stepper on the right */}
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <input
                        value={part.part_name}
                        onChange={(event) =>
                          updatePart(index, { part_name: event.target.value })
                        }
                        placeholder="Part name"
                        className="h-8 min-w-0 flex-1 rounded-md border border-primary/10 bg-background px-2 text-[13px] font-semibold leading-tight text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground focus:border-primary/30"
                      />
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
                    </div>
                    {/* Brand + part number, compact and inline */}
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                      <input
                        value={part.brand}
                        onChange={(event) =>
                          updatePart(index, { brand: event.target.value })
                        }
                        placeholder="Brand"
                        className="h-7 rounded-md border border-primary/10 bg-background px-2 text-[11px] outline-none focus:border-primary/30"
                      />
                      <input
                        value={part.oem_number}
                        onChange={(event) =>
                          updatePart(index, { oem_number: event.target.value })
                        }
                        placeholder="Part number"
                        className="h-7 rounded-md border border-primary/10 bg-background px-2 text-[11px] outline-none focus:border-primary/30"
                      />
                    </div>
                    {/* Otopair price line / cost editor */}
                    <div className="mt-2 flex items-center gap-2 text-[12px]">
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
                            placeholder={avgPrice > 0 ? avgPrice.toFixed(2) : "0.00"}
                            title={
                              isOemRecommended && sourcesUsed > 0 && avgPrice > 0
                                ? `Otopair average $${avgPrice.toFixed(2)} across ${sourcesUsed} source${sourcesUsed === 1 ? "" : "s"}`
                                : undefined
                            }
                            className="h-6 w-20 rounded-md border border-primary/10 bg-background px-1.5 text-[12px] font-medium tabular-nums outline-none focus:border-primary/30"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Quantity stepper */}
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
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          updatePart(index, {
                            supplied_by: isCustomer ? "shop" : "customer",
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
              },
            ])
          }
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <Plus className="h-3.5 w-3.5" />
          Add another part
        </button>

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
}: {
  recommendations: RecRowState[];
  setRecommendations: React.Dispatch<React.SetStateAction<RecRowState[]>>;
  engineId: string | null;
  priorOpenRecommendations: PriorOpenRecommendation[];
  additionalObservations: string;
  setAdditionalObservations: (value: string) => void;
}) {
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);

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
        freeform_service_name: "",
        urgency: "within_3_months",
        reason: "",
        visible_to_driver: true,
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
            if (picked.kind === "service") {
              updateRec(pickerIndex, {
                recommended_service_id: picked.id,
                service_label: picked.name,
                freeform_service_name: "",
              });
            } else {
              updateRec(pickerIndex, {
                recommended_service_id: null,
                service_label: picked.name,
                freeform_service_name: picked.name,
              });
            }
            setPickerIndex(null);
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
      | { kind: "service"; id: string; name: string }
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
