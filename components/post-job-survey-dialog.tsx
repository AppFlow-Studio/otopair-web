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
  Camera,
  Check,
  ChevronRight,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useMutation } from "convex/react";
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
  type PartsAccuracyStatus,
  type PostjobPhotoInput,
  type PostJobSurveyPayload,
  type TimeVariance,
  type TimeVarianceReason,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import { cn } from "@/lib/utils";

type PostJobPrefillData = {
  vehicleLabel: string;
  serviceName: string;
  serviceSlug: string;
  suggestedParts: JobActualPartPayload[];
} | null;

type PartRowState = {
  part_name: string;
  brand: string;
  oem_number: string;
  cost: string;
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
  | "observations"
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
  const [photos, setPhotos] = useState<PhotoState[]>([]);
  const [error, setError] = useState("");

  const generateUploadUrl = useMutation(generateUploadUrlRef) as (args: {
    bookingId: string;
  }) => Promise<string>;

  // Steps
  const visibleSteps = useMemo<StepKey[]>(() => {
    const list: StepKey[] = ["time_check"];
    if (timeVariance && timeVariance !== "on_time") list.push("time_reason");
    list.push("mileage");
    if (requiresParts || (prefillData?.suggestedParts?.length ?? 0) > 0) {
      list.push("parts");
    }
    list.push("difficulty");
    if (requiresParts) list.push("parts_accuracy");
    if (updatePrompts.length > 0) list.push("vehicle_updates");
    list.push("photos");
    list.push("tip");
    list.push("observations");
    list.push("flag");
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
      .map((part) => ({
        part_name: part.part_name.trim(),
        brand: part.brand.trim() || null,
        oem_number: part.oem_number.trim(),
        cost: Number(part.cost || 0),
      }))
      .filter(
        (part) =>
          part.part_name ||
          part.brand ||
          part.oem_number ||
          (Number.isFinite(part.cost) && part.cost > 0)
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
      setError("Please add at least one part used.");
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
    answeredCount === 3 || answeredCount === 6 || answeredCount === 9;
  const skipMoreVisible = answeredCount >= 5;

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
      {isLast ? (
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
          <StepContent
            step={currentStep}
            bookingLabel={bookingLabel}
            bookingSubLabel={bookingSubLabel}
            serviceLabel={prefillData?.serviceName ?? null}
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
  }
) {
  if (step === "mileage") return state.completionMileage.trim() !== "";
  if (step === "time_reason") {
    if (state.timeReason === "other") return state.timeReasonNote.trim() !== "";
    return state.timeReason !== null;
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
          actualPartsCost={props.actualPartsCost}
          setActualPartsCost={props.setActualPartsCost}
          partsCostSum={props.partsCostSum}
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
    case "observations":
      return (
        <QuestionScreen
          eyebrow="For the customer & the shop"
          question="Anything else to note?"
          hint='e.g. "Recommend brake inspection at next visit."'
        >
          <textarea
            value={props.additionalObservations}
            onChange={(event) =>
              props.setAdditionalObservations(event.target.value)
            }
            placeholder="Optional."
            className="min-h-[120px] w-full resize-y rounded-xl border border-primary/15 bg-background px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-primary"
          />
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

function PartsStep({
  parts,
  setParts,
  requiresParts,
  suggestedParts,
  actualPartsCost,
  setActualPartsCost,
  partsCostSum,
}: {
  parts: PartRowState[];
  setParts: React.Dispatch<React.SetStateAction<PartRowState[]>>;
  requiresParts: boolean;
  suggestedParts: JobActualPartPayload[];
  actualPartsCost: string;
  setActualPartsCost: (value: string) => void;
  partsCostSum: number;
}) {
  function updatePart(index: number, next: Partial<PartRowState>) {
    setParts((current) =>
      current.map((part, idx) => (idx === index ? { ...part, ...next } : part))
    );
  }

  return (
    <QuestionScreen
      eyebrow={requiresParts ? "Required" : "Optional"}
      question="What parts did you use?"
      hint={
        suggestedParts.length > 0
          ? "Suggested parts pre-loaded — tweak as needed."
          : "Add each part you installed. Skip if none."
      }
    >
      <div className="space-y-3">
        {parts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-primary/20 bg-muted/30 px-4 py-6 text-center text-[12px] text-muted-foreground">
            No parts added yet.
          </div>
        ) : (
          parts.map((part, index) => (
            <div
              key={index}
              className="rounded-xl border border-primary/15 bg-background px-3 py-3"
            >
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput
                  label="Part name"
                  value={part.part_name}
                  onChange={(value) => updatePart(index, { part_name: value })}
                />
                <LabeledInput
                  label="Brand"
                  value={part.brand}
                  onChange={(value) => updatePart(index, { brand: value })}
                />
                <LabeledInput
                  label="Part number"
                  value={part.oem_number}
                  onChange={(value) => updatePart(index, { oem_number: value })}
                />
                <LabeledInput
                  label="Cost"
                  value={part.cost}
                  onChange={(value) => updatePart(index, { cost: value })}
                  inputMode="decimal"
                />
              </div>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    setParts((current) =>
                      current.filter((_, idx) => idx !== index)
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/5 hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          onClick={() =>
            setParts((current) => [
              ...current,
              { part_name: "", brand: "", oem_number: "", cost: "" },
            ])
          }
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <Plus className="h-3.5 w-3.5" />
          Add another part
        </button>

        <div className="mt-4 flex items-center justify-between rounded-xl bg-muted/40 px-4 py-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Actual parts cost
            </p>
            <p className="text-[11px] text-muted-foreground">
              Auto: {partsCostSum.toFixed(2)}
            </p>
          </div>
          <input
            value={actualPartsCost}
            onChange={(event) => setActualPartsCost(event.target.value)}
            placeholder={partsCostSum.toFixed(2)}
            inputMode="decimal"
            className="w-32 rounded-lg border border-primary/15 bg-background px-3 py-2 text-right text-[13px] outline-none focus:border-primary"
          />
        </div>
      </div>
    </QuestionScreen>
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
