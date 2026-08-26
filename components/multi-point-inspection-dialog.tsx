"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  FluidCatalogSelectField,
  FLUID_KIND_BY_KEY,
} from "@/components/fluid-catalog-select-field";
import {
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  EyeOff,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  Wrench,
} from "lucide-react";
import { useMutation, useQuery, useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";
import { FindingTaxonomyDialog } from "@/components/finding-taxonomy-dialog";
import MidJobScopeDialog from "@/components/booking/mid-job-scope-dialog";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import { Combobox } from "@/components/ui/combobox";
import MonthPicker from "@/components/ui/month-picker";
import { TireSizeInput } from "@/components/ui/tire-size-input";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  classifyInspectionMeasure,
  cornerCopyPatch,
  createInspectionState,
  defaultZoneState,
  derivePrejobFromInspection,
  deriveSuggestedRecommendations,
  gatherFindings,
  getDirtyIncompleteZones,
  inspectionSlugTaxonomy,
  INSPECTION_NAV_ZONE_IDS,
  deriveTierInspectionScope,
  isBrakeDetailFieldRelevant,
  isFieldApplicableToZone,
  isFieldRequiredForZone,
  isSpecPrefillField,
  normalizeTireSize,
  OPPOSITE_CORNER,
  patchInspectionZone,
  patchSharedInspectionText,
  zoneHasInput,
  specPrefillFromPassport,
  INSPECTION_ZONES,
  INSPECTION_ZONES_BY_ID,
  requiredZonesForBooking,
  requiresRotorStampPhoto,
  toggleInspectionTreadMode,
  TRI_LABELS,
  triLabelFor,
  validateZoneForCompletion,
  WARNING_LIGHT_PICKER_OPTIONS,
  type BrakeAxleScope,
  type CornerZoneId,
  type FieldUnavailableStatus,
  type InspectionField,
  type InspectionState,
  type SpecPrefillEntry,
  type TriValue,
  type WarningLightEntry,
  type WarningLightSelection,
  type ZoneCompletionContext,
  type ZoneId,
  type ZoneState,
} from "@/lib/inspection-template";
import {
  BRAKE_FLUID_OPTIONS,
  BRAKE_PAD_BRAND_OPTIONS,
  COOLANT_TYPE_OPTIONS,
  OIL_TYPE_OPTIONS,
  OIL_VISCOSITY_OPTIONS,
  OTHER_INSPECTION_OPTION,
  POWER_STEERING_FLUID_OPTIONS,
  resolveInspectionOption,
  TIRE_BRAND_OPTIONS,
  TIRE_MODEL_OPTIONS,
  tireModelOptionsForBrand,
  tireSizeOptionsFromList,
  TIRE_SIZE_OPTIONS,
  TRANSMISSION_FLUID_OPTIONS,
  type InspectionOption,
} from "@/lib/inspection-options";
import {
  convertRotorValue,
  formatRotorReferenceMinimum,
  formatRotorValue,
  getTireTreadMinimum,
  type RotorUnit,
  type TireTreadReading,
} from "@/lib/inspection-measurements";
import {
  getSkippedOwnerQuestions,
  type OwnerProfileAnswerValue,
  type OwnerQuestion,
} from "@/lib/owner-profile-questions";
import type {
  InspectionStatus,
  PassportSource,
  PreJobSurveyPayload,
  VehiclePassportData,
} from "@/lib/vehicle-passport";
import { serviceMatchKey } from "@/convex/lib/serviceMatch";
import {
  AFFECTED_SYSTEMS,
  servicesForSystems,
  type AffectedSystem,
} from "@/lib/vehicle-mod-systems";

type SubmitIntent = "close" | "start";
type BookedTirePosition = "FL" | "FR" | "RL" | "RR";

export type InspectionInputPayload = {
  template_version: string;
  zones: Array<{
    zone_id: string;
    done: boolean;
    measures?: Record<string, string>;
    tri?: Record<string, TriValue>;
    descriptors?: Record<string, string[]>;
    text?: Record<string, string>;
    select?: Record<string, string>;
    statuses?: Record<string, FieldUnavailableStatus>;
    methods?: Record<string, string>;
    photo_ids?: Id<"_storage">[];
    photo_tags?: Record<string, "general" | "rotor_stamp">;
    lights?: Record<
      string,
      Array<{
        light: Exclude<WarningLightSelection, "" | "not_sure_which">;
        other_text?: string;
      }>
    >;
  }>;
  odometer?: number;
  lift_status?: "yes" | "no";
  findings_attention: Array<{ label: string; zone: string }>;
  findings_monitor: Array<{ label: string; zone: string }>;
};

type ResolvedSuggestion = {
  key: string;
  label: string;
  urgency: "soon" | "within_3_months" | "next_visit";
  reasons: string[];
  serviceId: Id<"services"> | null;
  serviceName: string | null;
  // Taxonomy the catalog slug implies (inspectionSlugTaxonomy), so promoting a
  // known service into mid-job work is one tap. Null for a freeform finding,
  // which opens the picker instead — see handleAddToJob.
  systemTags: string[] | null;
  workType: string | null;
};

const prepareInspectionPhotoUploadRef = makeFunctionReference<"mutation">(
  "inspections:prepareInspectionPhotoUpload",
);
const attachInspectionPhotoRef = makeFunctionReference<"mutation">(
  "inspections:attachInspectionPhoto",
);
const generateInspectionPdfRef = makeFunctionReference<"action">(
  "inspections_node:generateInspectionPdf",
);
const deleteInspectionPhotoRef = makeFunctionReference<"mutation">(
  "inspections:deleteInspectionPhoto",
);

const NAV_ZONE_IDS = INSPECTION_NAV_ZONE_IDS;

// DOM id of the gutter slot the dialog shell renders just left of the card, into
// which the floating vertical field rail is portaled.
const INSPECTION_SIDE_RAIL_ID = "inspection-side-rail-slot";

// Diagram geometry (top-down car). Mirrors the prototype layout. OWNER is not a
// physical location, so it renders as a chip below the diagram, not on the car.
const DIAGRAM_RECTS: Record<
  Exclude<ZoneId, "OWNER">,
  { x: number; y: number; w: number; h: number; lx: number; ly: number }
> = {
  FL: { x: 70, y: 52, w: 18, h: 36, lx: 79, ly: 74 },
  FR: { x: 212, y: 52, w: 18, h: 36, lx: 221, ly: 74 },
  RL: { x: 70, y: 144, w: 18, h: 36, lx: 79, ly: 166 },
  RR: { x: 212, y: 144, w: 18, h: 36, lx: 221, ly: 166 },
  ENG: { x: 100, y: 24, w: 100, h: 40, lx: 150, ly: 48 },
  FRT: { x: 112, y: 112, w: 76, h: 34, lx: 150, ly: 133 },
  UND: { x: 100, y: 166, w: 100, h: 44, lx: 150, ly: 191 },
};

const GRADE_TAG: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  bad: "bg-red-50 text-red-700 border-red-200",
  none: "bg-muted text-muted-foreground border-transparent",
};

const TRI_DOT: Record<TriValue, string> = {
  g: "bg-emerald-500 border-emerald-500",
  y: "bg-amber-500 border-amber-500",
  r: "bg-red-500 border-red-500",
};

// Matches the green/blue/red answer-choice palette in pre-job-survey-dialog.tsx
// (ConditionButtons' conditionPalette), used for tri fields rendered as pills.
const TRI_PILL_ACTIVE_CLASS: Record<TriValue, string> = {
  g: "border-emerald-300 bg-emerald-50 text-emerald-700",
  y: "border-sky-300 bg-sky-50 text-sky-700",
  r: "border-red-300 bg-red-50 text-red-700",
};

// Fields that stay on screen regardless of the booked service's scope —
// only their required-ness is gated (isFieldRequiredForZone), not whether
// they render. Applicability (isFieldApplicableToZone) still gates payload
// derivation elsewhere in lib/inspection-template.ts, so the visibility
// override lives here, at the render layer, rather than in that function.
// Tire 5 identity fields (first visit / tread increase) started this
// pattern; wheel-off brake/rotor fields (aside from the ones below, which
// still depend on another field in the same corner rather than scope) and
// steering/suspension play join it so a missing axle-scope selection on the
// booking no longer hides the entire brake section — a mechanic can still
// record what they see even when the service hasn't specified which axle
// it covers yet.
const ALWAYS_VISIBLE_FIELDS = new Set([
  "tire_brand",
  "tire_model",
  "tire_size",
  "run_flat",
  "tire_type",
  "pad_inner",
  "pad_outer",
  "rotor_applicable",
  "caliper",
  "brake_hose",
  "pad_brand",
  "steering_play",
  "ball_joint_play",
  "wheel_bearing_play",
]);

// Wheel-off fields that also stay visible regardless of scope, but that
// still depend on another answer in the same corner — no rotor detail once
// "no rotor / drum brake" is selected, no measurement-method field until
// something's actually been measured. See isBrakeDetailFieldRelevant.
const SCOPE_INDEPENDENT_BRAKE_DETAIL_FIELDS = new Set([
  "rotor",
  "rotor_stamp",
  "desc",
  "pad_method",
  "rotor_tool",
]);

// "Applicable rotor present" gates whether these fields are grayed out —
// same pattern as pad measurement method being gated by pad_inner/pad_outer
// actually having a reading — not whether they're shown at all.
const ROTOR_GATE_FIELDS = new Set([
  "rotor",
  "rotor_tool",
  "rotor_stamp",
  "desc",
]);

// Tier 4 fields record what's being installed, not an observed condition —
// they get a "Not available" option in the combobox itself (alongside
// "Other / not listed") rather than a separate unavailable toggle.
const NOT_AVAILABLE_OPTION = "__not_available__";
const TIER4_SPEC_FIELDS = new Set([
  "oil_viscosity",
  "oil_type",
  "coolant_type",
  "brake_fluid_type",
  "transmission_fluid_type",
  "power_steering_fluid_type",
]);

const URGENCY_LABEL: Record<string, string> = {
  soon: "Soon",
  within_3_months: "Within 3 months",
  next_visit: "Next visit",
};

const INSPECTION_STATUS_OPTIONS: { value: InspectionStatus; label: string }[] =
  [
    { value: "current", label: "Current" },
    { value: "not_current", label: "Not current" },
    { value: "not_visible", label: "Not visible" },
  ];

function userFacingInspectionError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const uncaught = error.message.match(/Uncaught Error:\s*([^\n]+)/);
  return (uncaught?.[1] ?? error.message).replace(
    /^\[CONVEX[^\]]*\]\s*(?:Server Error\s*)?/,
    "",
  );
}

function serverValidationTarget(
  message: string,
): { zoneId: ZoneId; fieldKey: string } | null {
  const lower = message.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const position = lower.includes("front left")
    ? "FL"
    : lower.includes("front right")
      ? "FR"
      : lower.includes("rear left")
        ? "RL"
        : lower.includes("rear right")
          ? "RR"
          : lower.includes("front ")
            ? "FL"
            : lower.includes("rear ")
              ? "RL"
              : null;
  if (lower.includes("tread"))
    return { zoneId: position ?? "FL", fieldKey: "tread" };
  if (lower.includes("rotor thickness")) {
    return { zoneId: position ?? "FL", fieldKey: "rotor" };
  }
  if (lower.includes("pad thickness")) {
    return { zoneId: position ?? "FL", fieldKey: "pad_inner" };
  }
  if (lower.includes("tire brand")) {
    return { zoneId: position ?? "FL", fieldKey: "tire_brand" };
  }
  if (lower.includes("tire size")) {
    return { zoneId: position === "RL" ? "RL" : "FL", fieldKey: "tire_size" };
  }
  if (lower.includes("tire condition")) {
    return { zoneId: position ?? "FL", fieldKey: "wear" };
  }
  if (lower.includes("tire air pressure")) {
    return { zoneId: position ?? "FL", fieldKey: "psi" };
  }
  if (lower.includes("brake visual")) {
    return { zoneId: position ?? "FL", fieldKey: "brake_visual" };
  }
  if (lower.includes("oil viscosity")) {
    return { zoneId: "ENG", fieldKey: "oil_viscosity" };
  }
  if (lower.includes("oil type"))
    return { zoneId: "ENG", fieldKey: "oil_type" };
  return null;
}

// ---------------------------------------------------------------------------

export default function MultiPointInspectionDialog(props: {
  open: boolean;
  bookingId?: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices?: string[];
  /** True once the booking is in_progress. Gates "Add to this job" —
   *  addMidJobCustomService refuses work on a job that isn't running. */
  jobInProgress?: boolean;
  tireReplacementPositions?: BookedTirePosition[];
  passportData: VehiclePassportData | null | undefined;
  prefillData?: PreJobSurveyPayload | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (
    payload: PreJobSurveyPayload,
    inspection: InspectionInputPayload,
    action: SubmitIntent,
  ) => Promise<void>;
  /** Persist without closing the dialog (used before generating the PDF). */
  onSaveDraft?: (
    payload: PreJobSurveyPayload,
    inspection: InspectionInputPayload,
  ) => Promise<void>;
}) {
  return (
    <MultiPointInspectionDialogBody
      key={`${props.passportData?.vin ?? "no-vin"}-${props.bookingId ?? "no-booking"}`}
      {...props}
    />
  );
}

function MultiPointInspectionDialogBody({
  open,
  bookingId,
  bookingLabel,
  bookingSubLabel,
  bookingServices = [],
  jobInProgress = false,
  tireReplacementPositions = [],
  passportData,
  prefillData,
  isSubmitting,
  onClose,
  onSubmit,
  onSaveDraft,
}: {
  open: boolean;
  bookingId?: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices?: string[];
  /** True once the booking is in_progress. Gates "Add to this job" —
   *  addMidJobCustomService refuses work on a job that isn't running. */
  jobInProgress?: boolean;
  tireReplacementPositions?: BookedTirePosition[];
  passportData: VehiclePassportData | null | undefined;
  prefillData?: PreJobSurveyPayload | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (
    payload: PreJobSurveyPayload,
    inspection: InspectionInputPayload,
    action: SubmitIntent,
  ) => Promise<void>;
  /** Persist without closing the dialog (used before generating the PDF). */
  onSaveDraft?: (
    payload: PreJobSurveyPayload,
    inspection: InspectionInputPayload,
  ) => Promise<void>;
}) {
  // `is_complete` only tracks whether the passport's required spec fields
  // (mileage, tire brand, tire condition) are filled — NOT whether this car has
  // ever been serviced here. Split the two so a returning car with a thin
  // passport reads "Specs incomplete" instead of a bogus "First visit".
  const specsIncomplete = !!passportData && !passportData.is_complete;
  const hasPriorVisits = (passportData?.recent_services?.length ?? 0) > 0;
  const isFirstVisit =
    passportData?.is_first_shop_visit ??
    (passportData ? specsIncomplete && !hasPriorVisits : true);

  const savedInspection = useQuery(
    api.inspections.getByBooking,
    bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  );
  const ownerProfile = useQuery(
    api.inspections.getOwnerProfileForBooking,
    bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  );
  const savedBrakeScope = useQuery(
    api.serviceParts.getBrakeScopeForBooking,
    bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  );
  const saveOwnerAnswers = useMutation(api.inspections.saveOwnerProfileAnswers);
  const submitInspectionRecs = useMutation(
    api.inspections.submitInspectionRecommendations,
  );
  const undoInspectionRec = useMutation(
    api.jobRecommendations.confirmFromPreJob,
  );
  const addToJob = useMutation(api.customJobs.addMidJobCustomService);
  // Pre-start sibling of addToJob: appends the same line to a booking that
  // hasn't been started, to be sent as a PRE-job estimate the customer confirms
  // before work begins. Which one runs is decided by jobInProgress.
  const addToJobPreStart = useMutation(api.customJobs.addPreJobCustomService);
  const removeFromJob = useMutation(api.customJobs.removeMidJobCustomService);
  const removeFromJobPreStart = useMutation(
    api.customJobs.removePreJobCustomService,
  );
  // Work already on the booking (added via "Add to this job" or elsewhere). Read
  // from the server so the "Added to this job" list survives a refresh — the
  // local addedToJob flags don't — and so each line can be removed the same way
  // it was added, which the ephemeral flags never allowed.
  const addedJobs = useQuery(
    api.customJobs.listForBooking,
    bookingId ? { bookingId: bookingId as Id<"bookings"> } : "skip",
  ) as Array<{ _id: Id<"custom_jobs">; name: string }> | undefined;
  const [removingJobId, setRemovingJobId] = useState<string | null>(null);

  // Mechanic parts fill-in: parts the OEM-strict pipeline left MISSING or
  // LOW_CONFIDENCE that the mechanic must confirm/fill before starting work.
  const partsToVerify = useQuery(
    api.serviceParts.getPartsNeedingVerification,
    bookingId ? { bookingId: bookingId as any } : "skip",
  );
  const verifyPart = useMutation(api.fitments.verifyPartForBooking);
  const markServiceNotApplicable = useMutation(
    api.fitments.markServiceNotApplicable,
  );
  // Keys (`serviceId:roleKey`) resolved this session — cleared from the gate
  // optimistically; the query also drops them once the fitment is verified.
  const [verifiedKeys, setVerifiedKeys] = useState<Set<string>>(new Set());
  const services = useQuery(api.services.list);

  // On-demand OEM tire-size fill. Enrichment normally saves the vehicle's
  // wheel-size.com fitments to trim_specs.tire_options; the passport surfaces
  // them as `available_tire_sizes`. When a vehicle was never enriched the
  // passport comes back with `has_data: false` — fetch + save once on open so
  // the tire-size dropdown lists the vehicle's real sizes. The write reactively
  // re-runs the passport query, which fills the dropdown. Runs at most once per
  // booking; failures are silent (the dropdown keeps the generic size list).
  const ensureVehicleTireOptions = useAction(
    api.tireOptionsLookup.ensureVehicleTireOptions,
  );
  const tireLookupRequestedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bookingId || !passportData) return;
    if (passportData.available_tire_sizes?.has_data) return;
    if (tireLookupRequestedRef.current === bookingId) return;
    tireLookupRequestedRef.current = bookingId;
    ensureVehicleTireOptions({ bookingId: bookingId as Id<"bookings"> }).catch(
      () => {
        // non-fatal — the generic size list remains available
      },
    );
  }, [bookingId, passportData, ensureVehicleTireOptions]);

  const prepareInspectionPhotoUpload = useMutation(
    prepareInspectionPhotoUploadRef,
  ) as (args: {
    bookingId: string;
    zoneId: Exclude<ZoneId, "OWNER">;
    uploadToken: string;
  }) => Promise<string>;
  const attachInspectionPhoto = useMutation(
    attachInspectionPhotoRef,
  ) as (args: {
    bookingId: string;
    zoneId: Exclude<ZoneId, "OWNER">;
    storageId: string;
    uploadToken: string;
    tag?: "general" | "rotor_stamp";
  }) => Promise<void>;
  const generateInspectionPdf = useAction(generateInspectionPdfRef) as (args: {
    bookingId: string;
  }) => Promise<{ url: string | null }>;
  const deleteInspectionPhoto = useMutation(
    deleteInspectionPhotoRef,
  ) as (args: {
    bookingId: string;
    storageId: string;
    zoneId?: Exclude<ZoneId, "OWNER">;
    uploadToken?: string;
  }) => Promise<void>;

  // ---- state -------------------------------------------------------------
  const [state, setState] = useState<InspectionState>(() =>
    createInspectionState(),
  );
  // "PARTS" is a synthetic zone (like "OWNER") — never enters the diagram or
  // requiredZones; it hosts the mechanic parts fill-in gate.
  const [activeZone, setActiveZone] = useState<ZoneId | "PARTS" | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<ZoneId, { fieldKey: string; message: string }>>
  >({});
  const [downloading, setDownloading] = useState(false);
  const [photoPreviews, setPhotoPreviews] = useState<Record<string, string>>(
    {},
  );
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const [photoToRemove, setPhotoToRemove] = useState<{
    zoneId: ZoneId;
    storageId: string;
  } | null>(null);
  const photoPreviewsRef = useRef(photoPreviews);

  // ---- autosave ----------------------------------------------------------
  // Draft persistence as the mechanic fills in fields: a debounced write to
  // onSaveDraft (savePrejob) fires ~1s after the last change so their input is
  // registered without hunting for a save button. The header shows a
  // "Saving… / Saved" indicator. Owner-profile answers keep their own explicit
  // confirm flow and are intentionally excluded (savePrejob doesn't persist
  // them).
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const savedSignatureRef = useRef<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-field autosave state, keyed `${zoneId}::${fieldKey}`. A field flips to
  // "saving" the instant it's edited, then to "saved"/"error" when the shared
  // debounced draft write settles — so every answer carries its own proof it's
  // banked. Held here (not per-zone) so a zone-switch doesn't drop indicators.
  const [fieldSaveState, setFieldSaveState] = useState<
    Record<string, FieldSaveState>
  >({});
  const markFieldSaving = useCallback((zoneId: ZoneId, fieldKey: string) => {
    setFieldSaveState((prev) => ({
      ...prev,
      [`${zoneId}::${fieldKey}`]: "saving",
    }));
  }, []);
  // The queued draft write, exposed so a close/unmount can flush it immediately
  // instead of losing the last edit inside the debounce window.
  const pendingSaveRef = useRef<null | (() => Promise<void>)>(null);

  // Global header fields that don't belong to a single wheel.
  const [mileage, setMileage] = useState("");
  const [mileageError, setMileageError] = useState("");
  const [liftStatus, setLiftStatus] = useState<"yes" | "no" | "">("");
  const [inspectionStatus, setInspectionStatus] = useState<
    InspectionStatus | ""
  >("");
  const [inspectionExpires, setInspectionExpires] = useState("");
  const [modAftermarket, setModAftermarket] = useState(false);
  const [modNotes, setModNotes] = useState("");
  // Carried through from the pre-job survey / passport so a multi-point save
  // doesn't wipe affected systems this dialog has no UI to edit.
  const [modAffectedSystems, setModAffectedSystems] = useState<
    AffectedSystem[]
  >([]);
  const [nextTip, setNextTip] = useState("");

  // Owner-profile (skipped onboarding) answers keyed by question key.
  const [ownerAnswers, setOwnerAnswers] = useState<
    Record<string, OwnerProfileAnswerValue>
  >({});
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [ownerDirty, setOwnerDirty] = useState(false);

  // Zones whose pre-filled persistent specs the mechanic has reviewed this
  // session — either by tapping "Specs match" or by editing a spec field. A
  // zone with un-reviewed seeded specs can't be marked complete.
  const [confirmedSpecZones, setConfirmedSpecZones] = useState<Set<ZoneId>>(
    () => new Set(),
  );
  const markSpecReviewed = useCallback((zoneId: ZoneId) => {
    setConfirmedSpecZones((prev) => {
      if (prev.has(zoneId)) return prev;
      const next = new Set(prev);
      next.add(zoneId);
      return next;
    });
  }, []);

  const requiredZones = useMemo(
    () => requiredZonesForBooking(bookingServices),
    [bookingServices],
  );
  const requiredSet = useMemo(() => new Set(requiredZones), [requiredZones]);
  const baselineMileage =
    prefillData?.mileage ?? passportData?.passport.mileage ?? null;
  // An odometer physically can't run backwards, so a new reading below the
  // vehicle's stored mileage is always an error — enforced live as the mechanic
  // types and again as a hard gate on every "continue" path (submit + save).
  const odometerBelowBaseline = (value: string) =>
    typeof baselineMileage === "number" &&
    value.trim() !== "" &&
    Number(value) < baselineMileage;
  const odometerTooLowMessage = () =>
    `Odometer can't be below the current ${(baselineMileage as number).toLocaleString()} mi reading.`;
  const brakeScope = useMemo<BrakeAxleScope>(
    () =>
      savedBrakeScope?.hasBrakeWork
        ? {
            hasBrakeWork: true,
            front: savedBrakeScope.front,
            rear: savedBrakeScope.rear,
          }
        : {
            hasBrakeWork: bookingServices.some((name) =>
              /brake pad|rotor replacement/i.test(name),
            ),
            front: false,
            rear: false,
          },
    [bookingServices, savedBrakeScope],
  );
  const completionContext = useMemo(
    () => ({
      serviceNames: bookingServices,
      brakeScope,
      tireReplacementPositions,
      isFirstShopVisit: isFirstVisit,
      priorTreadReadings: {
        FL: passportData?.passport.tires.tread_depths?.front_left
          ?.reported_min_32nds,
        FR: passportData?.passport.tires.tread_depths?.front_right
          ?.reported_min_32nds,
        RL: passportData?.passport.tires.tread_depths?.rear_left
          ?.reported_min_32nds,
        RR: passportData?.passport.tires.tread_depths?.rear_right
          ?.reported_min_32nds,
      },
      rotorPhotoEvidence: passportData?.rotor_photo_evidence,
      inspectionState: state,
      liftStatus,
    }),
    [
      bookingServices,
      brakeScope,
      tireReplacementPositions,
      isFirstVisit,
      passportData,
      state,
      liftStatus,
    ],
  );

  useEffect(() => {
    photoPreviewsRef.current = photoPreviews;
  }, [photoPreviews]);

  useEffect(
    () => () => {
      Object.values(photoPreviewsRef.current).forEach((url) =>
        URL.revokeObjectURL(url),
      );
    },
    [],
  );

  const skippedOwnerQuestions = useMemo<OwnerQuestion[]>(
    () => (ownerProfile ? getSkippedOwnerQuestions(ownerProfile) : []),
    [ownerProfile],
  );

  // ---- resume values entered for this booking's saved inspection ----------
  useEffect(() => {
    if (hydrated) return;
    // Wait for the saved-inspection query to resolve (undefined = loading).
    if (bookingId && savedInspection === undefined) return;

    const next = createInspectionState();

    if (savedInspection && Array.isArray(savedInspection.zones)) {
      for (const z of savedInspection.zones) {
        const id = z.zone_id as ZoneId;
        if (!INSPECTION_ZONES_BY_ID[id] || id === "OWNER") continue;
        const base = defaultZoneState(INSPECTION_ZONES_BY_ID[id]);
        next.zones[id] = {
          done: !!z.done,
          dirty: false,
          measures: { ...base.measures, ...(z.measures ?? {}) },
          tri: { ...base.tri, ...(z.tri ?? {}) },
          descriptors: { ...base.descriptors, ...(z.descriptors ?? {}) },
          text: { ...base.text, ...(z.text ?? {}) },
          select: { ...base.select, ...(z.select ?? {}) },
          statuses: { ...base.statuses, ...(z.statuses ?? {}) },
          methods: { ...base.methods, ...(z.methods ?? {}) },
          photoIds: Array.isArray(z.photo_ids) ? [...z.photo_ids] : [],
          photoTags: { ...base.photoTags, ...(z.photo_tags ?? {}) },
          lights: {
            ...base.lights,
            ...Object.fromEntries(
              Object.entries((z.lights ?? {}) as Record<string, any[]>).map(
                ([key, entries]) => [
                  key,
                  entries.map((e) => ({
                    light: e.light,
                    otherText: e.other_text,
                  })),
                ],
              ),
            ),
          },
        };
      }
      const pf = prefillData;
      if (typeof savedInspection.odometer === "number") {
        setMileage(String(savedInspection.odometer));
      } else if (typeof pf?.mileage === "number") {
        setMileage(String(pf.mileage));
      }
      if (
        savedInspection.lift_status === "yes" ||
        savedInspection.lift_status === "no"
      ) {
        setLiftStatus(savedInspection.lift_status);
      }
      if (pf?.inspection?.status) setInspectionStatus(pf.inspection.status);
      // Trim to YYYY-MM: rows written before the sticker field became month-only
      // carry a full YYYY-MM-DD, which a `type="month"` input rejects outright
      // and renders as blank — silently losing the stored expiry on next save.
      if (pf?.inspection?.expires_at) {
        setInspectionExpires(pf.inspection.expires_at.slice(0, 7));
      }
      if (pf?.modifications?.has_mods) setModAftermarket(true);
      if (pf?.modifications?.notes) setModNotes(pf.modifications.notes);
      setModAffectedSystems(pf?.modifications?.affected_systems ?? []);
      if (pf?.next_mechanic_tip) setNextTip(pf.next_mechanic_tip);
    }

    setState(next);

    setHydrated(true);
  }, [hydrated, bookingId, savedInspection, prefillData]);

  // Persistent vehicle specs (tire identity, pad brand, fluid specs) to seed
  // from the stored passport so the mechanic reviews them instead of re-typing.
  // Measured/observed fields are never seeded — they change every visit.
  const specPrefill = useMemo(
    () =>
      specPrefillFromPassport(passportData?.passport, passportData?.sources),
    [passportData],
  );

  // ---- seed spec fields once, after base hydration and once the passport is
  // available. Only fills fields that are still empty, so a resumed draft (or a
  // value the mechanic has since typed) always wins. Seeds leave done/dirty
  // untouched — they're reference values, not mechanic input.
  const specsSeededRef = useRef(false);
  useEffect(() => {
    if (!hydrated || specsSeededRef.current) return;
    const entries = Object.entries(specPrefill) as Array<
      [ZoneId, SpecPrefillEntry[]]
    >;
    if (entries.length === 0) return; // passport not loaded yet (or nothing to seed)
    specsSeededRef.current = true;
    setState((prev) => {
      let changed = false;
      const zones = { ...prev.zones };
      for (const [zoneId, specs] of entries) {
        const base =
          zones[zoneId] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[zoneId]);
        let text = base.text;
        let select = base.select;
        for (const spec of specs) {
          if (spec.bucket === "text") {
            if ((text[spec.fieldKey] ?? "").trim() !== "") continue;
            text = { ...text, [spec.fieldKey]: spec.value };
          } else {
            if ((select[spec.fieldKey] ?? "").trim() !== "") continue;
            select = { ...select, [spec.fieldKey]: spec.value };
          }
          changed = true;
        }
        if (text !== base.text || select !== base.select) {
          zones[zoneId] = { ...base, text, select };
        }
      }
      return changed ? { ...prev, zones } : prev;
    });
  }, [hydrated, specPrefill]);

  // A zone has un-reviewed pre-filled specs when it carries seeded specs, is not
  // yet complete, and hasn't been confirmed (via "Specs match" or a spec edit).
  const zoneNeedsSpecReview = useCallback(
    (zoneId: ZoneId) =>
      (specPrefill[zoneId]?.length ?? 0) > 0 &&
      !state.zones[zoneId]?.done &&
      !confirmedSpecZones.has(zoneId),
    [specPrefill, state, confirmedSpecZones],
  );

  // ---- helpers -----------------------------------------------------------
  const zoneState = useCallback(
    (id: ZoneId): ZoneState =>
      state.zones[id] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[id]),
    [state],
  );

  const patchZone = useCallback((id: ZoneId, patch: Partial<ZoneState>) => {
    setState((prev) => patchInspectionZone(prev, id, patch));
    setFieldErrors((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const patchSharedText = useCallback(
    (sourceId: ZoneId, key: string, value: string) => {
      setState((prev) => patchSharedInspectionText(prev, sourceId, key, value));
      setFieldErrors((prev) => {
        if (!prev[sourceId]) return prev;
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
    },
    [],
  );

  // Mirror a corner's readings onto its same-axle sibling (FL↔FR, RL↔RR). The
  // two corners share an identical field set, so this is a straight overwrite;
  // the mechanic then only fixes the few values that differ. No-op if the source
  // corner is still blank (guards against wiping the sibling with empties).
  const copyCornerToOpposite = useCallback(
    (sourceId: ZoneId) => {
      const opposite = OPPOSITE_CORNER[sourceId as CornerZoneId];
      if (!opposite) return;
      const source = zoneState(sourceId);
      if (!zoneHasInput(sourceId, source)) return;
      patchZone(opposite, cornerCopyPatch(source));
      // The copied values equal the already-reviewed source, so don't force a
      // redundant "Specs match" re-confirm on the sibling.
      markSpecReviewed(opposite);
    },
    [zoneState, patchZone, markSpecReviewed],
  );

  const photoUrl = useCallback(
    (storageId: string) =>
      photoPreviews[storageId] ??
      (
        savedInspection as
          | (typeof savedInspection & {
              photo_urls?: Record<string, string | null>;
            })
          | null
          | undefined
      )?.photo_urls?.[storageId] ??
      undefined,
    [photoPreviews, savedInspection],
  );

  const doneCount = useMemo(
    () => requiredZones.filter((id) => state.zones[id]?.done).length,
    [requiredZones, state],
  );

  // Every required zone graded, with no zone left holding un-saved readings.
  // Gates "Price & send" for staged extra work: the pre-job estimate goes to the
  // customer only when the whole check is done. Sending it early parks the
  // booking in "awaiting hold" (payment_approval_state pre_job_pending), which
  // clears canStartJob in the booking panel and locks the mechanic out of
  // reopening the inspection to finish it — the trap the user hit.
  const inspectionComplete = useMemo(
    () =>
      requiredZones.length > 0 &&
      requiredZones.every((id) => state.zones[id]?.done) &&
      getDirtyIncompleteZones(state).length === 0,
    [requiredZones, state],
  );

  // Findings + suggestions are evaluated from COMPLETED zones only, so a finding
  // surfaces the moment its zone is marked complete (not after the whole
  // inspection) and never counts un-confirmed scratch input.
  const findings = useMemo(
    () => gatherFindings(state, { onlyCompletedZones: true }),
    [state],
  );

  // Suggested follow-up recommendations derived from threshold measurements,
  // each resolved to a real catalog service when possible.
  const suggestedRecs = useMemo<ResolvedSuggestion[]>(() => {
    const list = deriveSuggestedRecommendations(state, {
      onlyCompletedZones: true,
    });
    return list.map((s) => {
      // `match` holds exact catalog slugs — resolve straight to the service.
      const found = (
        (services ?? []) as Array<{
          _id: Id<"services">;
          name: string;
          slug?: string;
        }>
      ).find((svc) => (svc.slug ? s.match.includes(svc.slug) : false));
      const taxonomy = inspectionSlugTaxonomy(s.match);
      return {
        ...s,
        serviceId: found?._id ?? null,
        serviceName: found?.name ?? null,
        systemTags: taxonomy?.system_tags ?? null,
        workType: taxonomy?.work_type ?? null,
      };
    });
  }, [state, services]);

  // Drop anything this booking is already doing. Suggesting "tire replacement
  // — soon" on the job that is replacing the tires reads as the system not
  // following along, and it costs the mechanic a decision every time. Compared
  // on the same normalised token key the server uses so "Oil Change" and
  // "Oil Change Service" don't slip past each other.
  const bookedMatchKeys = useMemo(
    () => new Set(bookingServices.map((name) => serviceMatchKey(name))),
    [bookingServices],
  );
  const openSuggestedRecs = useMemo(
    () =>
      suggestedRecs.filter(
        (s) => !bookedMatchKeys.has(serviceMatchKey(s.serviceName ?? s.label)),
      ),
    [suggestedRecs, bookedMatchKeys],
  );

  // Keyed by suggestion key, not a single flag — grading another zone after
  // an initial submit surfaces new suggestions, and those must stay
  // addable/undoable independently of what was already submitted.
  const [submittedRecs, setSubmittedRecs] = useState<
    Record<string, Id<"job_recommendations">>
  >({});
  const [recsBusy, setRecsBusy] = useState(false);
  const [undoingKey, setUndoingKey] = useState<string | null>(null);
  const [addedToJob, setAddedToJob] = useState<Record<string, boolean>>({});
  const [addingToJobKey, setAddingToJobKey] = useState<string | null>(null);
  // A freeform finding awaiting a taxonomy before it can be added to the job.
  // Null for a catalog service, which adds in one tap. See handleAddToJob.
  const [pendingJobSuggestion, setPendingJobSuggestion] =
    useState<ResolvedSuggestion | null>(null);
  // The MID-JOB scope dialog (price it, say why, add parts, send for the
  // customer's confirmation) — the SAME flow the active-job overlay opens. Only
  // reachable while the job is running; a pre-job inspection sends its added
  // scope through the inspection submit instead. See onOpenScope / ResultsScreen.
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeSubmittedNote, setScopeSubmittedNote] = useState<string | null>(
    null,
  );

  const buildPayloads = useCallback((): {
    prejob: PreJobSurveyPayload;
    inspection: InspectionInputPayload;
  } => {
    const f = gatherFindings(state, { onlyCompletedZones: true });
    const prejob = derivePrejobFromInspection(state, {
      mileage: mileage.trim() ? Number(mileage) : null,
      inspectionStatus: inspectionStatus
        ? {
            status: inspectionStatus,
            looks_current: inspectionStatus === "current",
            expires_at: inspectionExpires.trim() || null,
          }
        : null,
      modifications: modAftermarket
        ? {
            has_mods: true,
            notes: modNotes.trim() || null,
            affected_systems: modAffectedSystems,
          }
        : null,
      nextMechanicTip: nextTip.trim() || null,
      completionContext,
    });
    const inspection: InspectionInputPayload = {
      template_version: state.template_version,
      zones: Object.entries(state.zones).map(([zone_id, zs]) => ({
        zone_id,
        done: zs!.done,
        measures: zs!.measures,
        tri: zs!.tri,
        descriptors: zs!.descriptors,
        text: zs!.text,
        select: zs!.select,
        statuses: zs!.statuses,
        methods: zs!.methods,
        photo_ids: zs!.photoIds as Id<"_storage">[],
        photo_tags: zs!.photoTags,
        lights: Object.fromEntries(
          Object.entries(zs!.lights)
            .map(([key, entries]) => [
              key,
              entries
                .filter((e) => !!e.light)
                .map((e) => ({
                  light: e.light as Exclude<
                    WarningLightSelection,
                    "" | "not_sure_which"
                  >,
                  other_text: e.otherText,
                })),
            ])
            .filter(([, entries]) => (entries as unknown[]).length > 0),
        ),
      })),
      odometer: mileage.trim() ? Number(mileage) : undefined,
      lift_status: liftStatus || undefined,
      findings_attention: f.attention,
      findings_monitor: f.monitor,
    };
    return { prejob, inspection };
  }, [
    state,
    mileage,
    inspectionStatus,
    inspectionExpires,
    modAftermarket,
    modNotes,
    modAffectedSystems,
    nextTip,
    liftStatus,
    completionContext,
  ]);

  // Compact signature of everything savePrejob persists — a change here is what
  // arms the autosave debounce. Owner answers are excluded on purpose (they
  // have their own confirm flow and savePrejob doesn't store them).
  const autosaveSignature = useMemo(
    () =>
      JSON.stringify({
        zones: state.zones,
        mileage,
        liftStatus,
        inspectionStatus,
        inspectionExpires,
        modAftermarket,
        modNotes,
        modAffectedSystems,
        nextTip,
      }),
    [
      state.zones,
      mileage,
      liftStatus,
      inspectionStatus,
      inspectionExpires,
      modAftermarket,
      modNotes,
      modAffectedSystems,
      nextTip,
    ],
  );

  useEffect(() => {
    if (!hydrated || !bookingId || !onSaveDraft) return;
    // First run after hydration is the baseline — a resumed draft is already
    // persisted, so don't re-save it (or flash "Saving…") on open.
    if (savedSignatureRef.current === null) {
      savedSignatureRef.current = autosaveSignature;
      return;
    }
    if (autosaveSignature === savedSignatureRef.current) return;

    setSaveStatus("saving");
    const signatureToPersist = autosaveSignature;

    // The actual write, reused by both the debounce timer and an immediate
    // flush on close/unmount. Marks every in-flight field saved (or failed) so
    // the per-field checkmarks resolve in lockstep with the draft write.
    const runSave = async () => {
      try {
        const { prejob, inspection } = buildPayloads();
        await onSaveDraft(prejob, inspection);
        savedSignatureRef.current = signatureToPersist;
        setSaveStatus("saved");
        setFieldSaveState((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const key in next) {
            if (next[key] === "saving") {
              next[key] = "saved";
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      } catch {
        // Non-blocking: the mechanic can still use "Save & close". A soft
        // "Not saved yet" tells them autosave didn't take (e.g. the booking
        // scope isn't resolved yet).
        setSaveStatus("error");
        setFieldSaveState((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const key in next) {
            if (next[key] === "saving") {
              next[key] = "error";
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      } finally {
        pendingSaveRef.current = null;
      }
    };
    pendingSaveRef.current = runSave;

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void runSave();
    }, 1000);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [hydrated, bookingId, onSaveDraft, autosaveSignature, buildPayloads]);

  // Flush a queued draft write right now — used when the mechanic closes the
  // dialog or the tab/app is about to unload, so an edit made inside the 1s
  // debounce window is still persisted instead of silently dropped.
  const flushPendingSave = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const run = pendingSaveRef.current;
    if (run) void run();
  }, []);

  // Last-resort safety net: if the tab/app is closed while a save is still
  // pending, flush it and warn so the mechanic can stay long enough for the
  // write to land. Only fires when there's genuinely unsaved work.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (pendingSaveRef.current || saveStatus === "saving") {
        flushPendingSave();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus, flushPendingSave]);

  // Flush on unmount too (dialog torn down without an explicit "Save & close").
  useEffect(() => () => flushPendingSave(), [flushPendingSave]);

  const persistOwnerAnswers = useCallback(async () => {
    if (!bookingId || !ownerConfirmed) return;
    const answers: Record<string, OwnerProfileAnswerValue> = {};
    for (const q of skippedOwnerQuestions) {
      const a = ownerAnswers[q.key];
      if (a != null) answers[q.key] = a;
    }
    if (Object.keys(answers).length === 0) return;
    try {
      await saveOwnerAnswers({
        bookingId: bookingId as Id<"bookings">,
        answers,
      });
    } catch {
      // best-effort; never blocks the inspection
    }
  }, [
    bookingId,
    ownerConfirmed,
    skippedOwnerQuestions,
    ownerAnswers,
    saveOwnerAnswers,
  ]);

  function focusZoneField(zoneId: ZoneId, fieldKey: string) {
    requestAnimationFrame(() => {
      document.getElementById(`inspection-${zoneId}-${fieldKey}`)?.focus();
    });
  }

  // Scroll the just-activated zone panel to the top of the form. Deferred to a
  // layout effect (below) rather than fired inline, so the scroll measures the
  // *incoming* zone after it commits — a bare requestAnimationFrame sometimes ran
  // before the new zone rendered, leaving the form scrolled partway down.
  const pendingZoneScrollRef = useRef<ScrollBehavior | null>(null);
  // Set (instead of pendingZoneScrollRef) when the next commit should land the
  // mechanic back on the car diagram rather than on the zone panel.
  const pendingDiagramScrollRef = useRef<ScrollBehavior | null>(null);
  useLayoutEffect(() => {
    const diagramBehavior = pendingDiagramScrollRef.current;
    if (diagramBehavior) {
      pendingDiagramScrollRef.current = null;
      pendingZoneScrollRef.current = null;
      document
        .getElementById("inspection-car-diagram")
        ?.scrollIntoView({ behavior: diagramBehavior, block: "start" });
      return;
    }
    const behavior = pendingZoneScrollRef.current;
    if (!behavior) return;
    pendingZoneScrollRef.current = null;
    document
      .getElementById("inspection-zone-panel")
      ?.scrollIntoView({ behavior, block: "start" });
  }, [activeZone]);

  function openZoneAtTop(zoneId: ZoneId) {
    pendingZoneScrollRef.current = "auto";
    setActiveZone(zoneId);
  }

  // Finishing a zone collapses the panel and brings the car diagram back into
  // view so the mechanic picks the next corner themselves — rather than us auto-
  // opening the next zone, which jumped them away and lost their place.
  function closeZoneToDiagram() {
    pendingDiagramScrollRef.current = "smooth";
    setActiveZone(null);
  }

  // User-initiated zone selection (tapping a part on the car diagram, or the
  // Owner-profile chip): switch zones and smoothly bring the panel into view so
  // the mechanic sees the section scroll down to them instead of having to hunt
  // for it below the diagram.
  function selectZone(zoneId: ZoneId | "PARTS") {
    pendingZoneScrollRef.current = "smooth";
    setActiveZone(zoneId);
  }

  function showZoneValidationError(
    zoneId: ZoneId,
    result: { fieldKey: string; error: string },
  ) {
    setFieldErrors((prev) => ({
      ...prev,
      [zoneId]: { fieldKey: result.fieldKey, message: result.error },
    }));
    setError(result.error);
    setShowResults(false);
    setActiveZone(zoneId);
    focusZoneField(zoneId, result.fieldKey);
  }

  function handleToggleZone(zoneId: ZoneId) {
    const current = zoneState(zoneId);
    if (current.done) {
      patchZone(zoneId, { done: false });
      return;
    }
    const result = validateZoneForCompletion(state, zoneId, completionContext);
    if (!result.valid) {
      showZoneValidationError(zoneId, result);
      return;
    }
    // Pre-filled specs must be actively reviewed before a zone can be completed
    // — the guard against rubber-stamping a form that's already full.
    if (zoneNeedsSpecReview(zoneId)) {
      setError(
        "Tap the amber markers in the rail to check the pre-filled specs, then mark the zone complete.",
      );
      setShowResults(false);
      setActiveZone(zoneId);
      return;
    }
    setError("");
    patchZone(zoneId, { done: true });
    closeZoneToDiagram();
  }

  function validateBeforePersistence(action: SubmitIntent): boolean {
    setError("");
    const scopeError =
      deriveTierInspectionScope(completionContext).bookingScopeError;
    if (scopeError) {
      setError(scopeError);
      setShowResults(false);
      setActiveZone("FL");
      return false;
    }
    if (ownerDirty && !ownerConfirmed) {
      setError(
        'Tap "Mark zone complete" in Owner profile before saving these answers.',
      );
      setShowResults(false);
      setActiveZone("OWNER");
      return false;
    }
    // Safeguard: if the mechanic typed readings into a zone but never tapped
    // "Mark zone complete", those values don't count — block and point them to it.
    const dirty = getDirtyIncompleteZones(state);
    if (dirty.length) {
      const labels = dirty
        .map((id) => INSPECTION_ZONES_BY_ID[id].label)
        .join(", ");
      setError(
        `Tap "Mark zone complete" in: ${labels}. Readings there won't be recorded until the zone is marked complete.`,
      );
      setShowResults(false);
      setActiveZone(dirty[0]);
      return false;
    }
    if (action === "start") {
      const incomplete = requiredZones.find((id) => !state.zones[id]?.done);
      if (incomplete) {
        setError(
          `Mark ${INSPECTION_ZONES_BY_ID[incomplete].label} complete before submitting.`,
        );
        setShowResults(false);
        setActiveZone(incomplete);
        return false;
      }
    }
    for (const zone of INSPECTION_ZONES) {
      if (zone.dynamic || !state.zones[zone.id]?.done) continue;
      const result = validateZoneForCompletion(
        state,
        zone.id,
        completionContext,
      );
      if (!result.valid) {
        showZoneValidationError(zone.id, result);
        return false;
      }
    }
    if (action === "start" && !mileage.trim()) {
      const message = "Odometer reading is required to start the job.";
      setError(message);
      setMileageError(message);
      requestAnimationFrame(() =>
        document.getElementById("inspection-odometer")?.focus(),
      );
      return false;
    }
    if (action === "start" && !liftStatus) {
      setError("Select whether the vehicle is on a lift before submitting.");
      requestAnimationFrame(() =>
        document.getElementById("inspection-lift-yes")?.focus(),
      );
      return false;
    }
    // A backwards odometer is invalid on every continue path — block both
    // "Submit" and "Save & close" whenever a reading has been entered (an empty
    // reading is only required for "start", handled above).
    if (odometerBelowBaseline(mileage)) {
      const message = odometerTooLowMessage();
      setError(message);
      setMileageError(message);
      requestAnimationFrame(() =>
        document.getElementById("inspection-odometer")?.focus(),
      );
      return false;
    }
    setMileageError("");
    return true;
  }

  async function handleSubmit(action: SubmitIntent) {
    // Cancel any queued autosave so it doesn't race the explicit submit (and so
    // the close/unmount flush can't re-fire a stale draft write afterward).
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    pendingSaveRef.current = null;
    if (!validateBeforePersistence(action)) return;
    await persistOwnerAnswers();
    const { prejob, inspection } = buildPayloads();
    try {
      await onSubmit(prejob, inspection, action);
      // This explicit save persisted everything on screen — resolve any field
      // still mid-spinner so the mechanic sees each answer landed.
      savedSignatureRef.current = autosaveSignature;
      setSaveStatus("saved");
      setFieldSaveState((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const key in next) {
          if (next[key] === "saving") {
            next[key] = "saved";
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    } catch (err) {
      const message = userFacingInspectionError(
        err,
        "Could not save inspection.",
      );
      if (message.toLowerCase().includes("mileage")) {
        setError(message);
        setMileageError(message);
        requestAnimationFrame(() =>
          document.getElementById("inspection-odometer")?.focus(),
        );
      } else {
        const target = serverValidationTarget(message);
        if (target) {
          showZoneValidationError(target.zoneId, {
            fieldKey: target.fieldKey,
            error: message,
          });
        } else {
          setError(message);
        }
      }
    }
  }

  async function handleVerifyPart(item: PartVerifyItem, input: VerifyInput) {
    await verifyPart({
      bookingId: bookingId as any,
      serviceSlug: item.serviceSlug,
      roleKey: item.roleKey,
      mode: input.mode,
      partId: input.partId as any,
      oemNumber: input.oemNumber,
      partName: input.partName,
    });
    setVerifiedKeys((prev) => {
      const next = new Set(prev);
      next.add(`${item.serviceId}:${item.roleKey}`);
      return next;
    });
  }

  async function handleMarkNotApplicable(item: PartVerifyItem) {
    await markServiceNotApplicable({
      bookingId: bookingId as any,
      serviceSlug: item.serviceSlug,
      roleKey: item.roleKey,
    });
    setVerifiedKeys((prev) => {
      const next = new Set(prev);
      next.add(`${item.serviceId}:${item.roleKey}`);
      return next;
    });
  }

  async function handleDownloadPdf() {
    if (!bookingId) return;
    if (!validateBeforePersistence("close")) return;
    setDownloading(true);
    setError("");
    try {
      // Save current state first so the PDF reflects what's on screen. Use the
      // non-closing draft save so the dialog stays open on the results screen.
      await persistOwnerAnswers();
      const { prejob, inspection } = buildPayloads();
      if (onSaveDraft) await onSaveDraft(prejob, inspection);
      else await onSubmit(prejob, inspection, "close");
      const res = await generateInspectionPdf({ bookingId });
      if (res?.url) window.open(res.url, "_blank", "noopener,noreferrer");
      else
        setError("Inspection sheet is not ready yet. Try again in a moment.");
    } catch (err) {
      setError(userFacingInspectionError(err, "Could not generate the PDF."));
    } finally {
      setDownloading(false);
    }
  }

  async function handleAddRecommendations(keys: string[]) {
    if (!bookingId || keys.length === 0) return;
    if (!validateBeforePersistence("close")) return;
    setRecsBusy(true);
    setError("");
    try {
      // Persist the inspection first so a job_actual exists to attribute recs to.
      await persistOwnerAnswers();
      const { prejob, inspection } = buildPayloads();
      if (onSaveDraft) await onSaveDraft(prejob, inspection);
      const chosen = suggestedRecs.filter((s) => keys.includes(s.key));
      const recommendations = chosen.map((s) => ({
        recommended_service_id: s.serviceId,
        freeform_service_name: s.serviceId ? null : s.label,
        urgency: s.urgency,
        reason: s.reasons.join("; "),
        visible_to_driver: true,
      }));
      const insertedIds = await submitInspectionRecs({
        bookingId: bookingId as Id<"bookings">,
        recommendations,
      });
      setSubmittedRecs((prev) => {
        const next = { ...prev };
        chosen.forEach((s, i) => {
          if (insertedIds?.[i]) next[s.key] = insertedIds[i];
        });
        return next;
      });
    } catch (err) {
      setError(
        userFacingInspectionError(err, "Could not add recommendations."),
      );
    } finally {
      setRecsBusy(false);
    }
  }

  /**
   * Promote a flagged finding into work on THIS job (Decision D1).
   *
   * STAGES an off-catalog line: it appears in "Added to this job" and nothing is
   * sent, no money moves, and the customer isn't notified. How it later reaches
   * the customer depends on whether the job is running:
   *   - pre-job (the usual inspection case): the added scope goes out as part of
   *     "Submit → Vehicle Health" — commitInspectionAndAwaitEstimate opens the
   *     pre-job estimate in the booking panel. There is NO send button here.
   *   - mid-job: the running job has no such submit step, so each line keeps its
   *     own "Price & send" → mid-job change.
   *
   * This intentionally does NOT open a send dialog. It used to, which marched the
   * mechanic straight into "Send for confirmation" mid-inspection — before the
   * remaining zones were done — reading as the whole inspection being submitted
   * early. Staging preserves the intended order:
   * inspect → add → finish the inspection → send on submit.
   *
   * Before "Add to this job" existed, a wiper flagged red here had to be
   * re-entered from scratch via Flag Issue → "Extra work needed now", which is
   * exactly what Abdul had to do on Aug 20 after the inspection didn't carry it
   * forward.
   */
  async function commitAddToJob(
    suggestion: ResolvedSuggestion,
    taxonomy: { systemTags: string[]; workType: string },
  ) {
    if (!bookingId || addingToJobKey) return;
    setAddingToJobKey(suggestion.key);
    setError("");
    try {
      // Persist first, same as the recommendation path — the line should never
      // exist against an inspection that was never saved.
      await persistOwnerAnswers();
      const { prejob, inspection } = buildPayloads();
      if (onSaveDraft) await onSaveDraft(prejob, inspection);
      // Which cycle depends on whether the job is already running. In progress →
      // mid-job change; not started yet (the usual case for a pre-job inspection)
      // → pre-job estimate. Both append the same line; only where it's later sent
      // from differs (mid-job "Price & send" vs the pre-job inspection submit).
      const add = jobInProgress ? addToJob : addToJobPreStart;
      await add({
        bookingId: bookingId as Id<"bookings">,
        name: suggestion.serviceName ?? suggestion.label,
        complaint: suggestion.reasons.join("; ") || undefined,
        systemTags: taxonomy.systemTags,
        workType: taxonomy.workType,
        // Catalog match → seed the line's parts from our OEM catalog/enrichment
        // so the scope dialog lists them instead of an empty "Add part for X".
        // Null for a freeform finding (nothing to look up).
        catalogServiceId: suggestion.serviceId ?? undefined,
      });
      setAddedToJob((prev) => ({ ...prev, [suggestion.key]: true }));
      setPendingJobSuggestion(null);
      setScopeSubmittedNote(null);
      // Staged only — NO auto-send. The line now shows in "Added to this job".
      // Pre-job: it goes out when the mechanic submits the inspection. Mid-job:
      // via that line's "Price & send". Auto-opening a send dialog here is what
      // jumped the mechanic into "Send for confirmation" mid-inspection.
    } catch (err) {
      setError(
        userFacingInspectionError(err, "Could not add that to the job."),
      );
    } finally {
      setAddingToJobKey(null);
    }
  }

  function handleAddToJob(key: string) {
    const suggestion = suggestedRecs.find((s) => s.key === key);
    if (!bookingId || !suggestion || addingToJobKey) return;
    // A catalog service carries its own taxonomy (derived from the slug) — add
    // it in one tap. A freeform finding has none, so collect one via the picker.
    if (suggestion.systemTags && suggestion.workType) {
      void commitAddToJob(suggestion, {
        systemTags: suggestion.systemTags,
        workType: suggestion.workType,
      });
    } else {
      setPendingJobSuggestion(suggestion);
    }
  }

  // Pull a line back off the job — the undo for "Add to this job". Routes to the
  // pre- or mid-job remove by status, mirroring the add. Nothing is charged
  // until the customer approves, so this just deletes the not-yet-agreed line.
  async function handleRemoveAddedJob(customJobId: Id<"custom_jobs">) {
    if (!bookingId || removingJobId) return;
    setRemovingJobId(String(customJobId));
    setError("");
    try {
      const remove = jobInProgress ? removeFromJob : removeFromJobPreStart;
      await remove({ bookingId: bookingId as Id<"bookings">, customJobId });
      // Clear the optimistic "added to this job" flag for the matching
      // suggestion(s). That ephemeral flag — not the reactive addedJobs list —
      // is what renders a suggestion as "Added to this job" in Suggested
      // follow-ups, and the server delete doesn't touch it. Without this the
      // removed line keeps showing as applied even though it's off the booking.
      // Matched on the name the line was added under (serviceName ?? label),
      // normalised the same way booked-service de-duping is.
      const removed = (addedJobs ?? []).find(
        (j) => String(j._id) === String(customJobId),
      );
      if (removed) {
        const removedKey = serviceMatchKey(removed.name);
        const staleKeys = suggestedRecs
          .filter(
            (s) => serviceMatchKey(s.serviceName ?? s.label) === removedKey,
          )
          .map((s) => s.key);
        if (staleKeys.length) {
          setAddedToJob((prev) => {
            const next = { ...prev };
            for (const k of staleKeys) delete next[k];
            return next;
          });
        }
      }
    } catch (err) {
      setError(
        userFacingInspectionError(err, "Could not remove that from the job."),
      );
    } finally {
      setRemovingJobId(null);
    }
  }

  async function handleUndoRecommendation(key: string) {
    const recId = submittedRecs[key];
    if (!bookingId || !recId || undoingKey) return;
    setUndoingKey(key);
    setError("");
    try {
      await undoInspectionRec({
        bookingId: bookingId as Id<"bookings">,
        confirmations: [
          {
            recommendation_id: recId,
            outcome: "dismissed",
            dismissed_reason: "mistake",
          },
        ],
      });
      setSubmittedRecs((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      setError(
        userFacingInspectionError(err, "Could not undo that recommendation."),
      );
    } finally {
      setUndoingKey(null);
    }
  }

  async function handlePhotoUpload(
    id: ZoneId,
    file: File,
    tag: "general" | "rotor_stamp" = "general",
  ) {
    if (!bookingId || id === "OWNER") return;
    let storageId: string | undefined;
    const uploadToken = crypto.randomUUID();
    try {
      setPhotoBusy(id);
      const url = await prepareInspectionPhotoUpload({
        bookingId,
        zoneId: id,
        uploadToken,
      });
      const result = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!result.ok) throw new Error("Upload failed");
      ({ storageId } = (await result.json()) as { storageId?: string });
      if (!storageId) throw new Error("Upload did not return an id");
      await attachInspectionPhoto({
        bookingId,
        zoneId: id,
        storageId,
        uploadToken,
        tag,
      });
      const previewUrl = URL.createObjectURL(file);
      setPhotoPreviews((prev) => ({ ...prev, [storageId!]: previewUrl }));
      setState((prev) => {
        const current =
          prev.zones[id] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[id]);
        return patchInspectionZone(prev, id, {
          photoIds: [...current.photoIds, storageId!],
          photoTags: { ...current.photoTags, [storageId!]: tag },
        });
      });
    } catch {
      if (storageId) {
        await deleteInspectionPhoto({
          bookingId,
          storageId,
          zoneId: id,
          uploadToken,
        }).catch(() => undefined);
      }
      setError("Photo upload failed. Try again.");
    } finally {
      setPhotoBusy(null);
    }
  }

  async function handleRemovePhoto(id: ZoneId, storageId: string) {
    if (!bookingId) return;
    setPhotoBusy(storageId);
    setError("");
    try {
      await deleteInspectionPhoto({ bookingId, storageId });
      const preview = photoPreviewsRef.current[storageId];
      if (preview) URL.revokeObjectURL(preview);
      setPhotoPreviews((prev) => {
        const next = { ...prev };
        delete next[storageId];
        return next;
      });
      setState((prev) => {
        const current =
          prev.zones[id] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[id]);
        return patchInspectionZone(prev, id, {
          photoIds: current.photoIds.filter((photoId) => photoId !== storageId),
          photoTags: Object.fromEntries(
            Object.entries(current.photoTags).filter(
              ([photoId]) => photoId !== storageId,
            ),
          ),
        });
      });
    } catch (err) {
      setError(userFacingInspectionError(err, "Could not remove photo."));
    } finally {
      setPhotoBusy(null);
    }
  }

  // ---- render ------------------------------------------------------------
  const totalRequired = requiredZones.length;
  const pct = totalRequired ? doneCount / totalRequired : 0;
  const ringDash = 138.2;

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <span className="hidden text-[11px] text-primary sm:inline-flex sm:items-center sm:gap-1.5">
        <Camera className="h-3.5 w-3.5" /> Verify a measurement with a photo →
        rating boost
      </span>
      <div className="flex flex-1 items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => handleSubmit("close")}
          disabled={isSubmitting}
          className="rounded-xl border border-primary/20 bg-card px-4 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-primary/5 disabled:opacity-60"
        >
          Save & close
        </button>
        <button
          type="button"
          onClick={() => handleSubmit("start")}
          disabled={isSubmitting}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Submit → Vehicle Health
        </button>
      </div>
    </div>
  );

  return (
    <>
      <SurveyDialogShell
        open={open}
        onClose={() => {
          // Bank any edit still sitting in the debounce window before the dialog
          // tears down, so closing never costs the mechanic their last answer.
          flushPendingSave();
          onClose();
        }}
        title="Multi-point inspection"
        description={bookingSubLabel}
        maxWidthClassName="max-w-2xl"
        mobileFullBleed
        sideRailSlotId={INSPECTION_SIDE_RAIL_ID}
        contentClassName="min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:px-6 sm:pb-5"
        headerBadge={
          isFirstVisit ? (
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
              First visit
            </span>
          ) : specsIncomplete ? (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
              Specs incomplete
            </span>
          ) : null
        }
        footer={showResults ? undefined : footer}
      >
        {showResults ? (
          <div className="pt-4 sm:pt-5">
            <ResultsScreen
              findings={findings}
              totalLogged={
                Object.values(state.zones).filter((z) => z?.done).length
              }
              vehicleLabel={bookingLabel}
              downloading={downloading}
              onBack={() => setShowResults(false)}
              onDownload={handleDownloadPdf}
              suggestions={openSuggestedRecs}
              canRecommend={!!bookingId}
              recsBusy={recsBusy}
              submittedRecs={submittedRecs}
              onAddRecommendations={handleAddRecommendations}
              onUndoRecommendation={handleUndoRecommendation}
              undoingKey={undoingKey}
              error={error}
              canAddToJob={!!bookingId}
              onAddToJob={handleAddToJob}
              addedToJob={addedToJob}
              addingToJobKey={addingToJobKey}
              addedJobs={addedJobs ?? []}
              onRemoveAddedJob={handleRemoveAddedJob}
              removingJobId={removingJobId}
              onOpenScope={() => setScopeOpen(true)}
              jobInProgress={jobInProgress}
              inspectionComplete={inspectionComplete}
              scopeSubmittedNote={scopeSubmittedNote}
            />
          </div>
        ) : (
          <div className="space-y-4 pt-4 sm:pt-5">
            {/* vehicle + odometer bar */}
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-xl border border-primary/10 bg-primary/[0.03] px-4 py-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Vehicle
                </div>
                <div className="text-[13px] font-medium text-foreground">
                  {bookingLabel}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Current odometer
                </div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <div className="w-24 rounded-lg border border-primary/15 bg-muted/50 px-2 py-1 text-[14px] tabular-nums text-muted-foreground">
                    {typeof baselineMileage === "number"
                      ? baselineMileage.toLocaleString()
                      : "—"}
                  </div>
                  <span className="text-[11px] text-muted-foreground">mi</span>
                </div>
              </div>
              <label className="block">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  New reading <span className="text-red-500">*</span>
                </div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <input
                    id="inspection-odometer"
                    aria-invalid={!!mileageError}
                    inputMode="numeric"
                    value={mileage}
                    onChange={(e) => {
                      const next = e.target.value.replace(/[^0-9]/g, "");
                      setMileage(next);
                      // Flag a backwards odometer the instant it's typed, so the
                      // mechanic fixes it in place instead of hitting a wall at
                      // submit time.
                      setMileageError(
                        odometerBelowBaseline(next)
                          ? odometerTooLowMessage()
                          : "",
                      );
                    }}
                    placeholder="—"
                    className="w-24 rounded-lg border border-primary/20 bg-card px-2 py-1 text-[14px] tabular-nums text-foreground focus:border-primary focus:outline-none"
                  />
                  <span className="text-[11px] text-muted-foreground">mi</span>
                </div>
                {mileageError ? (
                  <span className="mt-1 block text-[10px] font-medium normal-case tracking-normal text-red-600">
                    {mileageError}
                  </span>
                ) : null}
              </label>
              <fieldset>
                <legend className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Is the vehicle on a lift?{" "}
                  <span className="text-red-500">*</span>
                </legend>
                <div className="mt-1 flex gap-1.5">
                  {(["yes", "no"] as const).map((value) => (
                    <button
                      key={value}
                      id={value === "yes" ? "inspection-lift-yes" : undefined}
                      type="button"
                      aria-pressed={liftStatus === value}
                      onClick={() => setLiftStatus(value)}
                      className={cn(
                        "rounded-lg border px-3 py-1 text-[12px] font-medium capitalize",
                        liftStatus === value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-primary/20 text-muted-foreground",
                      )}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>

            {/* progress ring */}
            <div className="flex items-center gap-4">
              <svg width="56" height="56" viewBox="0 0 58 58" aria-hidden>
                <circle
                  cx="29"
                  cy="29"
                  r="22"
                  fill="none"
                  stroke="currentColor"
                  className="text-primary/15"
                  strokeWidth="6"
                />
                <circle
                  cx="29"
                  cy="29"
                  r="22"
                  fill="none"
                  stroke="currentColor"
                  className="text-primary"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={ringDash}
                  strokeDashoffset={(ringDash * (1 - pct)).toFixed(1)}
                  transform="rotate(-90 29 29)"
                />
                <text
                  x="29"
                  y="33.5"
                  textAnchor="middle"
                  fontSize="13"
                  fontWeight="600"
                  className="fill-foreground"
                >
                  {doneCount}/{totalRequired}
                </text>
              </svg>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-foreground">
                  {doneCount} of {totalRequired} required zones inspected
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Tap a part of the car to inspect it
                </div>
              </div>
              <SaveStatusIndicator
                status={saveStatus}
                enabled={!!bookingId && !!onSaveDraft}
              />
              <div className="hidden items-center gap-3 sm:flex">
                {(["g", "y", "r"] as TriValue[]).map((c) => (
                  <span
                    key={c}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground"
                  >
                    <span className={cn("h-3 w-3 rounded-full", TRI_DOT[c])} />
                    {TRI_LABELS[c]}
                  </span>
                ))}
              </div>
            </div>

            {/* required vs optional legend */}
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-[3px] border-2 border-primary bg-primary/10" />
                Required
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-[3px] border border-dashed border-muted-foreground/40" />
                Optional
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-[3px] border-2 border-emerald-500 bg-emerald-100" />
                Completed
              </span>
            </div>

            {/* diagram */}
            <div id="inspection-car-diagram" className="flex justify-center scroll-mt-4">
              <CarDiagram
                activeZone={activeZone === "PARTS" ? null : activeZone}
                isDone={(id) => !!state.zones[id]?.done}
                isRequired={(id) => requiredSet.has(id)}
                onSelect={selectZone}
              />
            </div>

            {/* owner-profile zone entry (not a physical location) */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => selectZone("OWNER")}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[12px] font-medium transition-colors",
                  activeZone === "OWNER"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-primary/20 text-muted-foreground hover:bg-primary/5",
                )}
              >
                Owner profile
                {skippedOwnerQuestions.length > 0 ? (
                  <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700">
                    {skippedOwnerQuestions.length} skipped
                  </span>
                ) : null}
              </button>
            </div>

            {/* panel */}
            <div
              id="inspection-zone-panel"
              className="rounded-xl border border-primary/10 bg-card p-4"
            >
              {activeZone == null ? (
                <p className="py-8 text-center text-[13px] text-muted-foreground">
                  Tap a wheel or body zone on the car to begin.
                </p>
              ) : activeZone === "OWNER" ? (
                <OwnerZone
                  questions={skippedOwnerQuestions}
                  answers={ownerAnswers}
                  loading={ownerProfile === undefined}
                  confirmed={ownerConfirmed}
                  onChange={(key, value) => {
                    setOwnerAnswers((prev) => ({ ...prev, [key]: value }));
                    setOwnerDirty(true);
                    setOwnerConfirmed(false);
                  }}
                  onToggleComplete={() => {
                    setOwnerConfirmed((confirmed) => !confirmed);
                    setOwnerDirty(
                      ownerConfirmed
                        ? Object.keys(ownerAnswers).length > 0
                        : false,
                    );
                  }}
                />
              ) : activeZone === "PARTS" ? (
                <PartsVerifyZone
                  items={partsToVerify?.items ?? []}
                  verifiedKeys={verifiedKeys}
                  onVerify={handleVerifyPart}
                  onNotApplicable={handleMarkNotApplicable}
                />
              ) : (
                <ZonePanel
                  zoneId={activeZone}
                  zs={zoneState(activeZone)}
                  vin={passportData?.vin ?? null}
                  isFirstVisit={isFirstVisit}
                  isRequired={requiredSet.has(activeZone)}
                  tireSizeOptions={tireSizeOptionsFromList(
                    activeZone === "FL" || activeZone === "FR"
                      ? passportData?.available_tire_sizes?.front
                      : activeZone === "RL" || activeZone === "RR"
                        ? passportData?.available_tire_sizes?.rear
                        : undefined,
                  )}
                  completionContext={completionContext}
                  fieldError={fieldErrors[activeZone]}
                  canPhoto={!!bookingId}
                  photoBusy={photoBusy}
                  photoUrl={photoUrl}
                  specPrefill={specPrefill[activeZone] ?? []}
                  specConfirmed={confirmedSpecZones.has(activeZone)}
                  onConfirmSpecs={() => markSpecReviewed(activeZone)}
                  extraHeader={
                    activeZone === "FRT" ? (
                      <InspectionStickerFields
                        status={inspectionStatus}
                        expires={inspectionExpires}
                        onStatus={(value) => {
                          setInspectionStatus(value);
                          patchZone("FRT", {});
                        }}
                        onExpires={(value) => {
                          setInspectionExpires(value);
                          patchZone("FRT", {});
                        }}
                      />
                    ) : null
                  }
                  onPatch={(patch) => patchZone(activeZone, patch)}
                  onSharedText={(key, value) =>
                    patchSharedText(activeZone, key, value)
                  }
                  onCopyToOpposite={() => copyCornerToOpposite(activeZone)}
                  onPhoto={(file, tag) =>
                    handlePhotoUpload(activeZone, file, tag)
                  }
                  onRemovePhoto={(storageId) =>
                    setPhotoToRemove({ zoneId: activeZone, storageId })
                  }
                  onToggleDone={() => handleToggleZone(activeZone)}
                  onPrevious={() => {
                    const index = NAV_ZONE_IDS.indexOf(activeZone);
                    openZoneAtTop(
                      NAV_ZONE_IDS[
                        (index - 1 + NAV_ZONE_IDS.length) % NAV_ZONE_IDS.length
                      ],
                    );
                  }}
                  onNext={() => {
                    const index = NAV_ZONE_IDS.indexOf(activeZone);
                    openZoneAtTop(
                      NAV_ZONE_IDS[(index + 1) % NAV_ZONE_IDS.length],
                    );
                  }}
                  fieldSaveState={fieldSaveState}
                  onFieldSaving={(key) => markFieldSaving(activeZone, key)}
                />
              )}
            </div>

            {error ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">
                {error}
              </p>
            ) : null}

            {Object.values(state.zones).some((z) => z?.done) ? (
              <button
                type="button"
                onClick={() => setShowResults(true)}
                className="w-full rounded-xl border border-primary/20 bg-primary/[0.04] py-2 text-[13px] font-semibold text-primary hover:bg-primary/10"
              >
                Review findings &amp; recommendations (
                {findings.attention.length + findings.monitor.length})
              </button>
            ) : null}

            <AftermarketModsSection
              aftermarket={modAftermarket}
              notes={modNotes}
              systems={modAffectedSystems}
              onAftermarket={setModAftermarket}
              onNotes={setModNotes}
              onSystems={setModAffectedSystems}
            />
          </div>
        )}
      </SurveyDialogShell>
      <ConfirmationDialog
        open={photoToRemove !== null}
        title="Remove this photo?"
        description="This photo will be permanently deleted and cannot be recovered."
        onClose={() => setPhotoToRemove(null)}
        zIndexClassName="z-[100]"
        secondaryAction={{
          label: "Cancel",
          onAction: () => setPhotoToRemove(null),
          variant: "outline",
        }}
        primaryAction={{
          label: "Remove photo",
          variant: "destructive",
          onAction: () => {
            if (!photoToRemove) return;
            const target = photoToRemove;
            setPhotoToRemove(null);
            void handleRemovePhoto(target.zoneId, target.storageId);
          },
        }}
      />

      {/* Only for a freeform flagged finding — a catalog service adds in one tap
          with its derived taxonomy and never opens this. */}
      <FindingTaxonomyDialog
        open={pendingJobSuggestion !== null}
        findingName={
          pendingJobSuggestion?.serviceName ?? pendingJobSuggestion?.label ?? ""
        }
        busy={addingToJobKey !== null}
        onCancel={() => setPendingJobSuggestion(null)}
        onConfirm={(taxonomy) => {
          if (pendingJobSuggestion)
            void commitAddToJob(pendingJobSuggestion, taxonomy);
        }}
      />

      {/* MID-JOB ONLY: price it, say why, add parts, send the added scope for
          the customer's confirmation. Opened from "Price & send" in the "Added
          to this job" box while the job is running (there's no inspection-submit
          step then to carry the estimate). A PRE-job inspection has no scope
          dialog here at all — its added scope rides the "Submit → Vehicle Health"
          flow (commitInspectionAndAwaitEstimate opens the pre-job estimate in the
          booking panel), so the mechanic can't send before the check is done. */}
      <MidJobScopeDialog
        open={scopeOpen}
        bookingId={bookingId ? (bookingId as Id<"bookings">) : null}
        onClose={() => setScopeOpen(false)}
        onSubmitted={() => {
          setScopeOpen(false);
          setScopeSubmittedNote(
            "Extra work sent to the customer for confirmation.",
          );
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// Autosave affordance shown in the progress row: reassures the mechanic their
// input is registered as they fill in fields, without a manual save step.
function SaveStatusIndicator({
  status,
  enabled,
}: {
  status: "idle" | "saving" | "saved" | "error";
  enabled: boolean;
}) {
  if (!enabled) return null;
  const base =
    "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors";
  if (status === "saving") {
    return (
      <span className={cn(base, "bg-primary/5 text-muted-foreground")}>
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className={cn(base, "bg-emerald-50 text-emerald-700")}>
        <Check className="h-3 w-3" /> Saved
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className={cn(base, "bg-amber-50 text-amber-700")}>
        Not saved yet
      </span>
    );
  }
  // idle: no edits yet — tell the mechanic autosave is on so they trust it.
  return (
    <span className={cn(base, "text-muted-foreground")}>
      Autosaves as you go
    </span>
  );
}

// Per-field save affordance shown right next to the answer the mechanic just
// entered: a spinner while the debounced draft write is in flight, a green
// check once the server has it, or an amber "Not saved" if the write failed
// (autosave keeps retrying on the next edit). This is what lets a mechanic
// trust that every individual answer is banked before they close the app.
export type FieldSaveState = "saving" | "saved" | "error";

function FieldSaveBadge({ state }: { state?: FieldSaveState }) {
  if (!state) return null;
  if (state === "saving") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600"
        title="Saved — safe to close"
      >
        <Check className="h-3 w-3" /> Saved
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-600"
      title="Not saved yet — this answer will retry on your next edit"
    >
      Not saved
    </span>
  );
}

function CarDiagram({
  activeZone,
  isDone,
  isRequired,
  onSelect,
}: {
  activeZone: ZoneId | null;
  isDone: (id: ZoneId) => boolean;
  isRequired: (id: ZoneId) => boolean;
  onSelect: (id: ZoneId) => void;
}) {
  return (
    <svg
      width="300"
      height="232"
      viewBox="0 0 300 232"
      role="group"
      aria-label="Vehicle inspection map"
    >
      <rect
        x="92"
        y="20"
        width="116"
        height="192"
        rx="32"
        className="fill-primary/[0.04] stroke-primary/15"
        strokeWidth="1.4"
      />
      <path
        d="M110 72 Q150 60 190 72 L184 106 L116 106 Z"
        className="fill-primary/10 stroke-primary/15"
        strokeWidth="1"
      />
      <rect
        x="120"
        y="150"
        width="60"
        height="30"
        rx="8"
        className="fill-primary/[0.06] stroke-primary/15"
        strokeWidth="1"
      />
      {(Object.keys(DIAGRAM_RECTS) as Array<Exclude<ZoneId, "OWNER">>).map(
        (id) => {
          const r = DIAGRAM_RECTS[id];
          const done = isDone(id);
          const active = activeZone === id;
          const required = isRequired(id);
          const todo = required && !done && !active;
          const zone = INSPECTION_ZONES_BY_ID[id];
          return (
            <g
              key={id}
              role="button"
              tabIndex={0}
              aria-label={zone.label}
              className="cursor-pointer"
              onClick={() => onSelect(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(id);
                }
              }}
            >
              <rect
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                rx={6}
                className={cn(
                  "transition-colors",
                  done
                    ? "fill-emerald-100 stroke-emerald-500"
                    : active
                      ? "fill-primary/25 stroke-primary"
                      : required
                        ? "fill-primary/10 stroke-primary"
                        : "fill-transparent stroke-muted-foreground/30",
                )}
                strokeWidth={done ? 1.6 : active ? 2 : required ? 2.25 : 1}
                strokeDasharray={required || done || active ? undefined : "4 3"}
              />
              <text
                x={r.lx}
                y={r.ly}
                textAnchor="middle"
                fontSize="11"
                fontWeight={required && !done ? 700 : 500}
                className={cn(
                  done || active || required
                    ? "fill-foreground"
                    : "fill-muted-foreground",
                )}
              >
                {zone.short}
              </text>
              {done ? (
                <path
                  d={`M${r.lx - 5} ${r.ly + 6} l3 3 l6 -7`}
                  fill="none"
                  className="stroke-emerald-600"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : todo ? (
                // "must inspect" marker so required zones read at a glance even
                // when the fill is subtle.
                <circle
                  cx={r.x + r.w - 3.5}
                  cy={r.y + 3.5}
                  r={3}
                  className="fill-primary"
                />
              ) : null}
            </g>
          );
        },
      )}
    </svg>
  );
}

// --- Zone field rail --------------------------------------------------------
// A textless, color-coded tracker that lists every question in the active zone
// so the mechanic sees what's left at a glance and can tap to jump to it. It's a
// floating vertical pill on desktop and a sticky horizontal strip on mobile.
// Colors: red = required & unanswered · amber = seeded spec to check ·
// blue = answered/done · gray = optional & unanswered.
type RailStatus = "req" | "spec" | "done" | "opt";

const RAIL_BAR_CLASS: Record<RailStatus, string> = {
  req: "bg-red-500",
  spec: "bg-amber-400",
  done: "bg-blue-500",
  opt: "border border-slate-300 bg-transparent",
};

const RAIL_STATUS_LABEL: Record<RailStatus, string> = {
  req: "required",
  spec: "check spec",
  done: "done",
  opt: "optional",
};

/** True when a field carries an answer — a value, a rating, or a "not visible" mark. */
function isFieldAnswered(field: InspectionField, zs: ZoneState): boolean {
  if (zs.statuses[field.key]) return true;
  switch (field.type) {
    case "measure":
      return (zs.measures[field.key] ?? "").trim() !== "";
    case "tri":
      return !!zs.tri[field.key];
    case "descriptors":
      return (zs.descriptors[field.key] ?? []).length > 0;
    case "lights":
      return (zs.lights[field.key] ?? []).some((entry) => !!entry.light);
    case "select":
      return (
        (zs.select[field.key] ?? "").trim() !== "" ||
        (zs.methods[field.key] ?? "").trim() !== ""
      );
    case "text":
      return (zs.text[field.key] ?? "").trim() !== "";
    default:
      return false;
  }
}

function LegendSwatch({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("inline-block h-2 w-2 rounded-full", className)} />
      {label}
    </span>
  );
}

function ZoneFieldRail({
  orientation,
  zoneId,
  fields,
  zs,
  completionContext,
  specByKey,
  specConfirmed,
  checkedSpecKeys,
  flashedFieldKey,
  onJump,
}: {
  /** "vertical" floats in the dialog's left gutter; "horizontal" is the mobile strip. */
  orientation: "vertical" | "horizontal";
  zoneId: ZoneId;
  fields: InspectionField[];
  zs: ZoneState;
  completionContext: ZoneCompletionContext;
  /** Seeded passport specs for this zone, keyed by field. */
  specByKey: Map<string, SpecPrefillEntry>;
  specConfirmed: boolean;
  /** Seeded specs the mechanic has already tapped/edited this session. */
  checkedSpecKeys: Set<string>;
  flashedFieldKey: string | null;
  onJump: (fieldKey: string) => void;
}) {
  const vertical = orientation === "vertical";
  const tabs = fields.map((field) => {
    const isPendingSpec =
      specByKey.has(field.key) &&
      !specConfirmed &&
      !checkedSpecKeys.has(field.key);
    const status: RailStatus = isPendingSpec
      ? "spec"
      : isFieldAnswered(field, zs)
        ? "done"
        : isFieldRequiredForZone(zoneId, field.key, completionContext)
          ? "req"
          : "opt";
    return { key: field.key, label: field.label, status };
  });
  // Horizontal (mobile) strip: track whether it's scrolled off either edge so
  // we can hint "more questions this way" with a fading chevron.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measureEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setEdges({
      left: scrollLeft > 1,
      right: Math.ceil(scrollLeft + clientWidth) < scrollWidth - 1,
    });
  }, []);
  useEffect(() => {
    if (vertical) return;
    measureEdges();
    const el = scrollRef.current;
    if (!el) return;
    // Re-measure when the strip resizes; content changes re-run via tabs.length.
    const ro = new ResizeObserver(() => measureEdges());
    ro.observe(el);
    return () => ro.disconnect();
  }, [vertical, measureEdges, tabs.length]);

  const tablist = (
    <div
      ref={vertical ? undefined : scrollRef}
      onScroll={vertical ? undefined : measureEdges}
      role="tablist"
      aria-label="Jump to a question in this section"
      className={cn(
        "flex gap-1.5",
        vertical
          ? // Floating labelled rail in the dialog's left gutter (desktop): each
            // row is [a few label chars][status bar], right-aligned so the bars
            // line up and every pill is legible without hovering.
            "pointer-events-auto max-h-[80vh] flex-col items-end overflow-y-auto rounded-2xl border border-primary/10 bg-card px-2 py-2 shadow-[0_8px_24px_-4px_rgba(14,27,43,0.16)]"
          : // Scrolling horizontal strip (mobile/narrow): each cell is the
            // question written vertically, left of a full-height status pill.
            "flex-row items-stretch overflow-x-auto px-1 py-1.5",
      )}
    >
      {tabs.map(({ key, label, status }) => {
        const emphasized = status === "req" || status === "spec";
        return (
          <button
            key={key}
            type="button"
            role="tab"
            onClick={() => onJump(key)}
            // Native tooltip naming the question on hover — reliable and never
            // clipped by the rail's own scroll container.
            title={`${label} · ${RAIL_STATUS_LABEL[status]}`}
            aria-label={`Jump to ${label} (${RAIL_STATUS_LABEL[status]})`}
            className={cn(
              "group relative flex shrink-0",
              // Both rails: [question label][status pill] in a row. Desktop shows
              // a few horizontal chars; the mobile strip writes the label
              // vertically to the LEFT of a full-height pill.
              vertical
                ? "items-center gap-1.5 py-0.5"
                : "h-[4.5rem] flex-row items-stretch gap-1 px-0.5",
            )}
          >
            <span
              className={cn(
                "truncate text-[10px] font-medium text-muted-foreground group-hover:text-foreground",
                vertical
                  ? "max-w-[4rem] leading-none"
                  : "leading-tight [writing-mode:vertical-rl]",
              )}
            >
              {label}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full transition-transform group-hover:scale-110 group-active:scale-95",
                vertical
                  ? emphasized
                    ? "h-2 w-7"
                    : "h-2 w-5"
                  : emphasized
                    ? "w-3 self-stretch"
                    : "w-2.5 self-stretch",
                RAIL_BAR_CLASS[status],
                flashedFieldKey === key &&
                  "ring-2 ring-amber-400 ring-offset-1 ring-offset-card",
              )}
            />
          </button>
        );
      })}
    </div>
  );

  if (vertical) return tablist;

  return (
    <div className="lg:hidden">
      <div className="relative border-t border-primary/10">
        {tablist}
        {/* "More questions this way" — a fading chevron on whichever edge the
            strip is scrolled past. pointer-events-none so it never blocks a pill. */}
        {edges.left ? (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-20 flex w-9 items-center justify-start bg-gradient-to-r from-card via-card/85 to-transparent">
            <ChevronLeft className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
        ) : null}
        {edges.right ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-20 flex w-9 items-center justify-end bg-gradient-to-l from-card via-card/85 to-transparent">
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ZonePanel({
  zoneId,
  zs,
  vin,
  isFirstVisit,
  isRequired,
  tireSizeOptions,
  completionContext,
  fieldError,
  canPhoto,
  photoBusy,
  photoUrl,
  specPrefill,
  specConfirmed,
  onConfirmSpecs,
  extraHeader,
  onPatch,
  onSharedText,
  onCopyToOpposite,
  onPhoto,
  onRemovePhoto,
  onToggleDone,
  onPrevious,
  onNext,
  fieldSaveState,
  onFieldSaving,
}: {
  zoneId: ZoneId;
  zs: ZoneState;
  /** Vehicle VIN — feeds the fluid catalog picker (make-pinned OEM options). */
  vin: string | null;
  isFirstVisit: boolean;
  isRequired: boolean;
  /** Axle-resolved tire-size options (vehicle's OEM fitments, generic fallback). */
  tireSizeOptions: InspectionOption[];
  completionContext: ZoneCompletionContext;
  fieldError?: { fieldKey: string; message: string };
  canPhoto: boolean;
  photoBusy: string | null;
  photoUrl: (storageId: string) => string | undefined;
  /** Persistent specs seeded from the passport for this zone. */
  specPrefill: SpecPrefillEntry[];
  specConfirmed: boolean;
  onConfirmSpecs: () => void;
  extraHeader?: React.ReactNode;
  onPatch: (patch: Partial<ZoneState>) => void;
  onSharedText: (key: string, value: string) => void;
  /** Copies this corner's readings onto its same-axle sibling (corners only). */
  onCopyToOpposite: () => void;
  onPhoto: (file: File, tag?: "general" | "rotor_stamp") => void;
  onRemovePhoto: (storageId: string) => void;
  onToggleDone: () => void;
  onPrevious: () => void;
  onNext: () => void;
  /** Per-field autosave state, keyed `${zoneId}::${fieldKey}`. */
  fieldSaveState: Record<string, FieldSaveState>;
  /** Flags a field as pending-save the moment the mechanic edits it. */
  onFieldSaving: (fieldKey: string) => void;
}) {
  // Transient "Copied ✓" confirmation on the copy-to-opposite button. Reset when
  // the panel switches zones and auto-cleared after a short beat.
  const [copiedFlash, setCopiedFlash] = useState(false);
  useEffect(() => setCopiedFlash(false), [zoneId]);
  useEffect(() => {
    if (!copiedFlash) return;
    const timer = window.setTimeout(() => setCopiedFlash(false), 2200);
    return () => window.clearTimeout(timer);
  }, [copiedFlash]);
  // Refs to every field row so the rail (and spec review) can jump straight to a
  // question, plus a transient highlight so the mechanic sees where they landed.
  const fieldRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [flashedFieldKey, setFlashedFieldKey] = useState<string | null>(null);
  useEffect(() => setFlashedFieldKey(null), [zoneId]);
  useEffect(() => {
    if (!flashedFieldKey) return;
    const timer = window.setTimeout(() => setFlashedFieldKey(null), 1800);
    return () => window.clearTimeout(timer);
  }, [flashedFieldKey]);
  // Per-tab spec review: each seeded spec shows amber in the rail until the
  // mechanic taps it (jumps to check it) or edits it, then it turns "done".
  // Once every seeded spec is checked, the zone's specs are confirmed.
  const [checkedSpecKeys, setCheckedSpecKeys] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => setCheckedSpecKeys(new Set()), [zoneId]);
  // The floating vertical rail lives in a gutter slot the dialog shell renders
  // just outside the card's left edge, so it can overhang without being clipped
  // by the card's overflow. We portal into it once it's in the DOM.
  const [railTarget, setRailTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setRailTarget(document.getElementById(INSPECTION_SIDE_RAIL_ID));
  }, []);
  const zone = INSPECTION_ZONES_BY_ID[zoneId];
  // Same-axle sibling for the one-tap copy (undefined on non-corner zones).
  const oppositeCorner = OPPOSITE_CORNER[zoneId as CornerZoneId] as
    | CornerZoneId
    | undefined;
  const oppositeLabel = oppositeCorner
    ? INSPECTION_ZONES_BY_ID[oppositeCorner].label
    : null;
  const canCopyOpposite = !!oppositeCorner && zoneHasInput(zoneId, zs);
  const tireReplacementScheduled =
    (zoneId === "FL" ||
      zoneId === "FR" ||
      zoneId === "RL" ||
      zoneId === "RR") &&
    completionContext.tireReplacementPositions?.includes(zoneId);
  const applicableFields = zone.fields.filter((field) => {
    if (ALWAYS_VISIBLE_FIELDS.has(field.key)) return true;
    if (SCOPE_INDEPENDENT_BRAKE_DETAIL_FIELDS.has(field.key)) {
      return isBrakeDetailFieldRelevant(field.key, zs);
    }
    return isFieldApplicableToZone(zoneId, field.key, completionContext);
  });
  const rotorPhotoRequired =
    (zoneId === "FL" ||
      zoneId === "FR" ||
      zoneId === "RL" ||
      zoneId === "RR") &&
    !!completionContext.inspectionState &&
    requiresRotorStampPhoto(
      completionContext.inspectionState,
      zoneId,
      completionContext,
    );
  // Per-field lookup of the seeded value/provenance for this zone.
  const specByKey = new Map(specPrefill.map((s) => [s.fieldKey, s]));
  const hasSpecPrefill = specPrefill.length > 0;
  const needsSpecReview = hasSpecPrefill && !zs.done && !specConfirmed;
  // Seeded specs that actually render here — the set the mechanic must check.
  const seededKeys = applicableFields
    .map((field) => field.key)
    .filter((key) => specByKey.has(key));
  const seededKeysSig = seededKeys.join("|");
  const markSpecChecked = (fieldKey: string) => {
    if (!specByKey.has(fieldKey)) return;
    setCheckedSpecKeys((prev) => {
      if (prev.has(fieldKey)) return prev;
      const next = new Set(prev);
      next.add(fieldKey);
      return next;
    });
  };
  const handleJump = (fieldKey: string) => {
    fieldRefs.current[fieldKey]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    setFlashedFieldKey(fieldKey);
    // Tapping a seeded spec counts as reviewing it.
    markSpecChecked(fieldKey);
  };
  // Confirm the zone's specs once every rendered seeded spec has been checked.
  // If the zone carries seeded specs that don't actually render here (all
  // filtered out of applicableFields), there's nothing to review — confirm
  // immediately so the mechanic isn't dead-ended with no marker to tap.
  useEffect(() => {
    if (!needsSpecReview) return;
    if (
      seededKeys.length === 0 ||
      seededKeys.every((key) => checkedSpecKeys.has(key))
    ) {
      onConfirmSpecs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedSpecKeys, needsSpecReview, seededKeysSig]);
  return (
    <div className="space-y-1">
      {/* Header + mobile field rail stick together as one block, so the rail
          tucks directly under the header and stays visible while the questions
          scroll — no magic offset, no z-index fight. */}
      <div className="sticky top-0 z-20 -mx-2 mb-2 border-b border-primary/10 bg-card/95 backdrop-blur">
        <div className="flex items-center justify-between gap-2 px-2 py-2">
        <h4 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          {zone.label}
          {isRequired ? (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
              Required
            </span>
          ) : (
            <span className="rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Optional
            </span>
          )}
        </h4>
        <div className="flex items-center gap-1">
          {zs.done ? (
            <span className="mr-1 inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600">
              <Check className="h-3.5 w-3.5" /> confirmed
            </span>
          ) : null}
          {oppositeCorner ? (
            <button
              type="button"
              onClick={() => {
                onCopyToOpposite();
                setCopiedFlash(true);
              }}
              disabled={!canCopyOpposite}
              title={
                canCopyOpposite
                  ? `Copy every reading from this corner to ${oppositeLabel}, then adjust the few that differ`
                  : `Enter this corner's readings first, then copy them to ${oppositeLabel}`
              }
              aria-label={`Copy all readings to ${oppositeLabel}`}
              className={cn(
                "mr-0.5 inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[12px] font-medium transition-colors",
                copiedFlash
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : canCopyOpposite
                    ? "border-primary/20 text-muted-foreground hover:bg-primary/5"
                    : "cursor-not-allowed border-primary/10 text-muted-foreground/40",
              )}
            >
              {copiedFlash ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Copied to {INSPECTION_ZONES_BY_ID[oppositeCorner].short}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy to {INSPECTION_ZONES_BY_ID[oppositeCorner].short}
                </>
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPrevious}
            aria-label="Previous inspection zone"
            className="rounded-lg border border-primary/20 p-1.5 text-muted-foreground hover:bg-primary/5"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="Next inspection zone"
            className="rounded-lg border border-primary/20 p-1.5 text-muted-foreground hover:bg-primary/5"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        </div>
        {applicableFields.length >= 2 ? (
          <ZoneFieldRail
            orientation="horizontal"
            zoneId={zoneId}
            fields={applicableFields}
            zs={zs}
            completionContext={completionContext}
            specByKey={specByKey}
            specConfirmed={specConfirmed}
            checkedSpecKeys={checkedSpecKeys}
            flashedFieldKey={flashedFieldKey}
            onJump={handleJump}
          />
        ) : null}
      </div>

      {tireReplacementScheduled ? (
        <p className="rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-[12px] text-muted-foreground">
          <span className="font-semibold text-foreground">
            Tire replacement scheduled.
          </span>{" "}
          Outgoing-tire tread, pressure, and condition are optional.
        </p>
      ) : null}

      {applicableFields.length >= 2 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 pt-1 text-[10px] text-muted-foreground">
          <LegendSwatch className="bg-red-500" label="Required" />
          {seededKeys.length > 0 ? (
            <LegendSwatch className="bg-amber-400" label="Check spec" />
          ) : null}
          <LegendSwatch className="bg-blue-500" label="Done" />
          <LegendSwatch
            className="border border-slate-300 bg-transparent"
            label="Optional"
          />
        </div>
      ) : null}

      {/* Desktop: floating vertical rail in the dialog's left gutter. The mobile
          strip now lives inside the sticky header block above. */}
      {applicableFields.length >= 2 && railTarget
        ? createPortal(
            <ZoneFieldRail
              orientation="vertical"
              zoneId={zoneId}
              fields={applicableFields}
              zs={zs}
              completionContext={completionContext}
              specByKey={specByKey}
              specConfirmed={specConfirmed}
              checkedSpecKeys={checkedSpecKeys}
              flashedFieldKey={flashedFieldKey}
              onJump={handleJump}
            />,
            railTarget,
          )
        : null}

      {applicableFields.map((field, i) => {
        const prevSection = i > 0 ? applicableFields[i - 1].section : undefined;
        const showSection = field.section && field.section !== prevSection;
        return (
          <div
            key={field.key}
            ref={(el) => {
              fieldRefs.current[field.key] = el;
            }}
            onFocus={(e) => {
              // Mobile: tapping a field brings it up under the sticky header
              // (clear of the keyboard) so you're always looking at what you're
              // editing. Only for real inputs — not every button tap — and never
              // on desktop, where the whole zone is already in view.
              if (window.matchMedia("(min-width: 1024px)").matches) return;
              const t = e.target as HTMLElement;
              if (
                !(t instanceof HTMLInputElement) &&
                !(t instanceof HTMLSelectElement) &&
                !(t instanceof HTMLTextAreaElement)
              )
                return;
              e.currentTarget.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={cn(
              // scroll-mt clears the sticky header + rail when we jump (or focus)
              // here so the question lands clearly below them, not tucked under.
              // Mobile's rail is taller (full-height labelled pills), so it needs
              // a bigger offset than the desktop header-only case.
              "scroll-mt-44 rounded-lg transition-shadow lg:scroll-mt-28",
              flashedFieldKey === field.key &&
                "ring-2 ring-amber-400 ring-offset-2 ring-offset-card",
            )}
          >
            {showSection ? (
              <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-1">
                {field.section}
              </div>
            ) : null}
            <FieldRow
              zoneId={zoneId}
              field={field}
              zs={zs}
              vin={vin}
              isFirstVisit={isFirstVisit}
              tireSizeOptions={tireSizeOptions}
              required={isFieldRequiredForZone(
                zoneId,
                field.key,
                completionContext,
              )}
              errorMessage={
                fieldError?.fieldKey === field.key ||
                (field.key === "tread" &&
                  fieldError?.fieldKey.startsWith("tread_"))
                  ? fieldError.message
                  : undefined
              }
              prefill={specByKey.get(field.key)}
              onSpecEdited={() => markSpecChecked(field.key)}
              onPatch={(patch) => {
                onFieldSaving(field.key);
                onPatch(patch);
              }}
              onSharedText={(key, value) => {
                onFieldSaving(field.key);
                onSharedText(key, value);
              }}
              saveState={fieldSaveState[`${zoneId}::${field.key}`]}
            />
          </div>
        );
      })}

      {extraHeader}

      {zs.photoIds.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {zs.photoIds.map((storageId) => {
            const src = photoUrl(storageId);
            return (
              <div
                key={storageId}
                className="relative overflow-hidden rounded-lg border border-primary/15 bg-muted"
              >
                {zs.photoTags[storageId] === "rotor_stamp" ? (
                  <span className="absolute left-2 top-2 z-10 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">
                    Rotor stamp
                  </span>
                ) : null}
                {src ? (
                  <a
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Enlarge inspection photo"
                    className="block"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt={`${zone.label} inspection`}
                      className="aspect-[4/3] w-full cursor-zoom-in object-cover"
                    />
                  </a>
                ) : (
                  <div className="flex aspect-[4/3] items-center justify-center text-[11px] text-muted-foreground">
                    Preview unavailable
                  </div>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/65 to-transparent p-2 pt-6">
                  <button
                    type="button"
                    aria-label="Remove inspection photo"
                    disabled={photoBusy === storageId}
                    onClick={() => onRemovePhoto(storageId)}
                    className="pointer-events-auto rounded-md bg-white/90 p-1.5 text-red-600 hover:bg-white disabled:opacity-60"
                  >
                    {photoBusy === storageId ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {fieldError?.fieldKey === "rotor_stamp_photo" ? (
        <InlineFieldError message={fieldError.message} />
      ) : null}

      {!zs.done && zs.dirty ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          You&apos;ve entered readings here — tap{" "}
          <span className="font-semibold">Mark zone complete</span> so they
          count toward findings &amp; recommendations.
        </p>
      ) : null}

      <div className="flex items-center gap-2 pt-3">
        {canPhoto ? (
          <label
            id={`inspection-${zoneId}-rotor_stamp_photo`}
            tabIndex={-1}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-primary/20 px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-primary/5",
              photoBusy === zoneId
                ? "cursor-wait opacity-60"
                : "cursor-pointer",
            )}
          >
            {photoBusy === zoneId ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
            {rotorPhotoRequired
              ? "Add required rotor-stamp photo"
              : "Add photo"}
            <input
              type="file"
              accept="image/*"
              disabled={photoBusy === zoneId}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  onPhoto(file, rotorPhotoRequired ? "rotor_stamp" : "general");
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
        <button
          type="button"
          onClick={onToggleDone}
          className={cn(
            "ml-auto rounded-xl px-4 py-2 text-[13px] font-semibold transition-colors",
            zs.done
              ? "border border-primary/20 bg-card text-muted-foreground hover:bg-primary/5"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {zs.done ? "Mark incomplete" : "Mark zone complete"}
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  zoneId,
  field,
  zs,
  vin,
  isFirstVisit,
  tireSizeOptions,
  required,
  errorMessage,
  prefill,
  onSpecEdited,
  onPatch,
  onSharedText,
  saveState,
}: {
  zoneId: ZoneId;
  field: InspectionField;
  zs: ZoneState;
  /** Vehicle VIN — feeds the fluid catalog picker. */
  vin: string | null;
  isFirstVisit: boolean;
  /** Axle-resolved tire-size options for this zone (OEM fitments + fallback). */
  tireSizeOptions: InspectionOption[];
  required: boolean;
  errorMessage?: string;
  /** Seeded passport value/provenance for this field, when it's a spec field. */
  prefill?: SpecPrefillEntry;
  /** Called when the mechanic edits a pre-filled spec field (marks reviewed). */
  onSpecEdited?: () => void;
  onPatch: (patch: Partial<ZoneState>) => void;
  onSharedText: (key: string, value: string) => void;
  /** Autosave state for this field's last edit (spinner / check / retry). */
  saveState?: FieldSaveState;
}) {
  const clearUnavailable = () => {
    const statuses = { ...zs.statuses };
    delete statuses[field.key];
    return statuses;
  };
  const unavailable = !!zs.statuses[field.key];
  const unavailableControl = (
    <UnavailableToggle
      active={unavailable}
      onToggle={() => {
        const statuses = { ...zs.statuses };
        if (unavailable) delete statuses[field.key];
        else statuses[field.key] = "not_applicable";
        onPatch({ statuses });
      }}
    />
  );
  const rotorNotConfirmed =
    ROTOR_GATE_FIELDS.has(field.key) && zs.select.rotor_applicable !== "yes";
  if (field.type === "measure") {
    return (
      <MeasureField
        zoneId={zoneId}
        field={field}
        zs={zs}
        required={required}
        errorMessage={errorMessage}
        disabled={rotorNotConfirmed}
        onPatch={onPatch}
        saveState={saveState}
      />
    );
  }

  if (field.type === "tri") {
    const selected = zs.tri[field.key];
    const hasCustomLabels = (["g", "y", "r"] as TriValue[]).some(
      (color) => triLabelFor(field.key, color) !== TRI_LABELS[color],
    );
    return (
      <div className="border-b border-primary/10">
        <Row label={field.label} required={required} saveState={saveState}>
          <div className="flex flex-wrap gap-2">
            {(["g", "y", "r"] as TriValue[]).map((color) => {
              const label = triLabelFor(field.key, color);
              const active = selected === color && !unavailable;
              const id =
                color === "g" ? `inspection-${zoneId}-${field.key}` : undefined;
              if (hasCustomLabels) {
                return (
                  <button
                    key={color}
                    id={id}
                    type="button"
                    onClick={() =>
                      onPatch({
                        tri: { ...zs.tri, [field.key]: color },
                        statuses: clearUnavailable(),
                      })
                    }
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? TRI_PILL_ACTIVE_CLASS[color]
                        : "border-primary/20 bg-card text-muted-foreground hover:bg-primary/5",
                    )}
                  >
                    {label}
                  </button>
                );
              }
              return (
                <button
                  key={color}
                  id={id}
                  type="button"
                  aria-label={label}
                  onClick={() =>
                    onPatch({
                      tri: { ...zs.tri, [field.key]: color },
                      statuses: clearUnavailable(),
                    })
                  }
                  className={cn(
                    "h-7 w-7 rounded-full border-2 transition-transform active:scale-90",
                    active
                      ? TRI_DOT[color]
                      : "border-primary/25 bg-transparent",
                  )}
                />
              );
            })}
            {unavailableControl}
          </div>
        </Row>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  if (field.type === "descriptors") {
    const selected = zs.descriptors[field.key] ?? [];
    return (
      <div
        className={cn(
          "border-b border-primary/10 py-2",
          required && "border-l-2 border-l-red-400 pl-2",
        )}
      >
        <div
          className={cn(
            "mb-1.5 flex items-center gap-2 text-[13px] text-foreground",
            required && "font-medium",
          )}
        >
          <span className="flex-1">
            {field.label}
            {required ? (
              <span className="ml-1 text-red-500" title="Required">
                *
              </span>
            ) : null}
          </span>
          <FieldSaveBadge state={saveState} />
        </div>
        <div className="flex flex-wrap gap-2">
          {field.options.map((option, index) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                id={
                  index === 0 ? `inspection-${zoneId}-${field.key}` : undefined
                }
                type="button"
                disabled={rotorNotConfirmed}
                onClick={() => {
                  let next: string[];
                  if (active) {
                    next = selected.filter((value) => value !== option);
                  } else if (option === "none") {
                    next = ["none"];
                  } else {
                    next = [
                      ...selected.filter((value) => value !== "none"),
                      option,
                    ];
                  }
                  onPatch({
                    descriptors: { ...zs.descriptors, [field.key]: next },
                    statuses: clearUnavailable(),
                  });
                }}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  active
                    ? "border-amber-400 bg-amber-50 font-semibold text-amber-700"
                    : "border-primary/20 bg-card text-muted-foreground hover:bg-primary/5",
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  if (field.type === "lights") {
    const entries: WarningLightEntry[] =
      zs.lights[field.key] && zs.lights[field.key].length > 0
        ? zs.lights[field.key]
        : [{ light: "" }];
    const hasNone = entries.some((e) => e.light === "none");
    const lightOptions: InspectionOption[] = [
      ...WARNING_LIGHT_PICKER_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
      })),
      { value: "other", label: "Other" },
      { value: "none", label: "None" },
    ];
    const setEntries = (next: WarningLightEntry[]) =>
      onPatch({
        lights: { ...zs.lights, [field.key]: next },
        statuses: clearUnavailable(),
      });
    return (
      <div
        className={cn(
          "border-b border-primary/10 py-2",
          required && "border-l-2 border-l-red-400 pl-2",
        )}
      >
        <div
          className={cn(
            "mb-1.5 flex items-center gap-2 text-[13px] text-foreground",
            required && "font-medium",
          )}
        >
          <span className="flex-1">
            {field.label}
            {required ? (
              <span className="ml-1 text-red-500" title="Required">
                *
              </span>
            ) : null}
          </span>
          <FieldSaveBadge state={saveState} />
        </div>
        <div className="space-y-2">
          {entries.map((entry, index) => (
            <div key={index} className="flex items-center gap-2">
              <CompactSelect
                id={
                  index === 0 ? `inspection-${zoneId}-${field.key}` : undefined
                }
                ariaLabel={field.label}
                value={entry.light}
                options={lightOptions}
                className="flex-1"
                isDisabled={rotorNotConfirmed}
                onChange={(next) => {
                  const light = next as WarningLightSelection;
                  if (light === "none") {
                    setEntries([{ light: "none" }]);
                    return;
                  }
                  setEntries(
                    entries.map((e, i) =>
                      i === index
                        ? {
                            light,
                            otherText:
                              light === "other" ? e.otherText : undefined,
                          }
                        : e,
                    ),
                  );
                }}
              />
              {entry.light === "other" ? (
                <input
                  value={entry.otherText ?? ""}
                  onChange={(e) =>
                    setEntries(
                      entries.map((row, i) =>
                        i === index
                          ? { ...row, otherText: e.target.value }
                          : row,
                      ),
                    )
                  }
                  placeholder="Which light?"
                  className="w-32 rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
                />
              ) : null}
              {index > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    setEntries(entries.filter((_, i) => i !== index))
                  }
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove light"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            disabled={hasNone || !entries[entries.length - 1]?.light}
            onClick={() => setEntries([...entries, { light: "" }])}
            className="inline-flex items-center gap-1 rounded-lg border border-dashed border-primary/30 px-2.5 py-1 text-[12px] font-medium text-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            Add light
          </button>
        </div>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  if (field.type === "select") {
    const isMeasurementMethod =
      field.key === "pad_method" || field.key === "rotor_tool";
    const value = isMeasurementMethod
      ? zs.methods[field.key] || zs.select[field.key] || ""
      : (zs.select[field.key] ?? "");
    const wasMeasured = (key: string) =>
      !zs.statuses[key] && !!(zs.measures[key] ?? "").trim();
    const measurementNotTaken =
      field.key === "pad_method"
        ? !wasMeasured("pad_inner") && !wasMeasured("pad_outer")
        : field.key === "rotor_tool"
          ? !wasMeasured("rotor")
          : false;
    // Verbatim OEM value that maps to no canonical option (odd coolant/trans
    // brand strings, or a pre-filled passport value): inject it so the enriched
    // spec still shows + stays picked.
    //
    // `tire_type` additionally gets an "Other…" escape hatch so a mechanic can
    // record a season/type not in the controlled catalog vocabulary. The typed
    // value is stored verbatim in the same `select` bucket; it simply won't join
    // the tire catalog for auto-rebooking (mapTireType returns undefined), which
    // is the intended graceful fallback. We deliberately do NOT add "Other" to
    // TIRE_TYPE_OPTIONS (that list is the join vocabulary); the affordance is
    // UI-only, and the transient sentinel is filtered out of the passport read
    // in lib/inspection-template.ts.
    const allowOther = field.key === "tire_type";
    const matchesOption = field.options.some((o) => o.value === value);
    const isKnown = value === "" || matchesOption;
    const isOtherMode = allowOther && value !== "" && !matchesOption;
    const selectOptions = allowOther
      ? [...field.options, { value: OTHER_INSPECTION_OPTION, label: "Other…" }]
      : isKnown
        ? field.options
        : [...field.options, { value, label: value }];
    const writeSelect = (next: string) => {
      if (prefill) onSpecEdited?.();
      onPatch(
        isMeasurementMethod
          ? {
              methods: { ...zs.methods, [field.key]: next },
              statuses: clearUnavailable(),
            }
          : {
              select: { ...zs.select, [field.key]: next },
              statuses: clearUnavailable(),
            },
      );
    };
    const showPrefillTag = !!prefill && value === prefill.value;
    return (
      <div className="border-b border-primary/10">
        <Row label={field.label} required={required} saveState={saveState}>
          <div className="flex w-44 flex-col items-end gap-1">
            <CompactSelect
              id={`inspection-${zoneId}-${field.key}`}
              ariaLabel={field.label}
              value={isOtherMode ? OTHER_INSPECTION_OPTION : value}
              options={selectOptions}
              className="w-44"
              isDisabled={measurementNotTaken}
              onChange={writeSelect}
            />
            {isOtherMode ? (
              <input
                id={`inspection-${zoneId}-${field.key}-other`}
                aria-label={`Custom ${field.label.toLowerCase()}`}
                value={value === OTHER_INSPECTION_OPTION ? "" : value}
                placeholder={`Enter ${field.label.toLowerCase()}`}
                onChange={(event) => writeSelect(event.target.value)}
                className="w-full rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
              />
            ) : null}
            {showPrefillTag ? <SpecSourceTag source={prefill!.source} /> : null}
          </div>
          {isMeasurementMethod || field.key === "rotor_applicable"
            ? null
            : unavailableControl}
        </Row>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  // Fluid PRODUCT fields (coolant / ATF / brake / power-steering) use the same
  // OEM + scraped catalog picker as the post-job survey instead of the generic
  // combobox. Value lives in the text bucket, where the passport prefill seeds
  // it and job_actuals reads it. Oil viscosity/type keep the generic picker —
  // oil is chosen by grade+type, not a single SKU.
  if (field.type === "text" && FLUID_KIND_BY_KEY[field.key]) {
    const fluidValue = zs.text[field.key] ?? "";
    const showFluidPrefillTag = !!prefill && fluidValue === prefill.value;
    return (
      <div className="border-b border-primary/10">
        <Row
          label={field.label}
          required={required}
          badge={field.firstVisitOnly && isFirstVisit ? "1ST" : undefined}
          saveState={saveState}
        >
          <div className="w-64 space-y-1.5">
            <FluidCatalogSelectField
              value={fluidValue}
              onChange={(next) => {
                if (prefill) onSpecEdited?.();
                onSharedText(field.key, next);
              }}
              fluidKind={FLUID_KIND_BY_KEY[field.key]}
              vin={vin}
              placeholder="Search or select"
              otherPlaceholder={`Enter ${field.label.toLowerCase()}`}
            />
            {showFluidPrefillTag ? (
              <div className="flex justify-end">
                <SpecSourceTag source={prefill!.source} />
              </div>
            ) : null}
          </div>
          {unavailableControl}
        </Row>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  const isTier4Spec = TIER4_SPEC_FIELDS.has(field.key);
  const value = zs.text[field.key] ?? "";
  const options =
    field.key === "tire_model"
      ? tireModelOptionsForBrand(zs.text.tire_brand)
      : field.key === "tire_size"
        ? tireSizeOptions
        : optionsForInspectionField(field.key);
  const resolved = resolveInspectionOption(value, options);
  const selected =
    isTier4Spec && zs.statuses[field.key]
      ? NOT_AVAILABLE_OPTION
      : resolved
        ? resolved.value
        : value
          ? OTHER_INSPECTION_OPTION
          : "";
  const setText = (next: string) => {
    if (prefill) onSpecEdited?.();
    if (isTier4Spec && next === NOT_AVAILABLE_OPTION) {
      onPatch({ statuses: { ...zs.statuses, [field.key]: "not_applicable" } });
      return;
    }
    const normalized =
      field.key === "tire_size" && next !== OTHER_INSPECTION_OPTION
        ? normalizeTireSize(next)
        : next;
    if (field.key === "tire_brand") {
      onPatch({
        text: { ...zs.text, tire_brand: normalized, tire_model: "" },
        statuses: clearUnavailable(),
      });
      return;
    }
    if (field.key === "tire_model") {
      onPatch({
        text: { ...zs.text, [field.key]: normalized },
        statuses: clearUnavailable(),
      });
      return;
    }
    onPatch({ statuses: clearUnavailable() });
    onSharedText(field.key, normalized);
  };
  const showPrefillTag = !!prefill && value === prefill.value;
  if (options.length === 0) {
    return (
      <div className="border-b border-primary/10">
        <Row label={field.label} required={required} saveState={saveState}>
          <div className="flex w-48 flex-col items-end gap-1">
            <input
              id={`inspection-${zoneId}-${field.key}`}
              aria-invalid={!!errorMessage}
              value={value}
              disabled={rotorNotConfirmed}
              onChange={(event) => setText(event.target.value)}
              className="w-full rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            {showPrefillTag ? <SpecSourceTag source={prefill!.source} /> : null}
          </div>
          {rotorNotConfirmed ? null : unavailableControl}
        </Row>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }
  return (
    <div className="border-b border-primary/10">
      <Row
        label={field.label}
        required={required}
        badge={field.firstVisitOnly && isFirstVisit ? "1ST" : undefined}
        saveState={saveState}
      >
        <div className="w-48 space-y-1.5">
          <Combobox
            id={`inspection-${zoneId}-${field.key}`}
            ariaLabel={field.label}
            ariaInvalid={!!errorMessage}
            value={selected}
            options={[
              ...(isTier4Spec
                ? [{ value: NOT_AVAILABLE_OPTION, label: "Not available" }]
                : []),
              { value: OTHER_INSPECTION_OPTION, label: "Other / not listed" },
              ...options,
            ]}
            onChange={setText}
            allowCustomValue={false}
            placeholder="Search or select"
            emptyText="No matching option"
            inputClassName="h-9 rounded-lg border border-primary/20 bg-card px-2 text-[13px] text-foreground focus:border-primary focus:outline-none"
          />
          {selected === OTHER_INSPECTION_OPTION ? (
            field.key === "tire_size" ? (
              <TireSizeInput
                value={value === OTHER_INSPECTION_OPTION ? "" : value}
                onChange={setText}
                className="w-full"
              />
            ) : (
              <input
                id={`inspection-${zoneId}-${field.key}-other`}
                aria-label={`Custom ${field.label.toLowerCase()}`}
                aria-invalid={!!errorMessage}
                value={value === OTHER_INSPECTION_OPTION ? "" : value}
                placeholder={`Enter ${field.label.toLowerCase()}`}
                onChange={(event) => setText(event.target.value)}
                className="w-full rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
              />
            )
          ) : null}
          {showPrefillTag ? (
            <div className="flex justify-end">
              <SpecSourceTag source={prefill!.source} />
            </div>
          ) : null}
        </div>
        {isTier4Spec ? null : unavailableControl}
      </Row>
      {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
    </div>
  );
}

/** Small provenance chip beside a pre-filled spec field. */
function SpecSourceTag({ source }: { source: PassportSource | null }) {
  const label =
    source === "oem_default"
      ? "OEM default"
      : source === "user_reported"
        ? "Reported"
        : "From records";
  const cls =
    source === "oem_default"
      ? "border-primary/10 bg-muted text-muted-foreground"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function MeasureField({
  zoneId,
  field,
  zs,
  required,
  errorMessage,
  disabled,
  onPatch,
  saveState,
}: {
  zoneId: ZoneId;
  field: Extract<InspectionField, { type: "measure" }>;
  zs: ZoneState;
  required: boolean;
  errorMessage?: string;
  disabled?: boolean;
  onPatch: (patch: Partial<ZoneState>) => void;
  /** Autosave state for this field's last edit (spinner / check / retry). */
  saveState?: FieldSaveState;
}) {
  const value = zs.measures[field.key] ?? "";
  const result = classifyInspectionMeasure(field, zs.measures, zs.select);
  const clearUnavailable = () => {
    const statuses = { ...zs.statuses };
    delete statuses[field.key];
    return statuses;
  };
  const unavailable = !!zs.statuses[field.key];
  const unavailableControl = (
    <UnavailableToggle
      active={unavailable}
      onToggle={() => {
        const statuses = { ...zs.statuses };
        if (unavailable) {
          delete statuses[field.key];
          onPatch({ statuses });
          return;
        }
        // Marking not visible / not available is mutually exclusive with a
        // reading: clear any typed measurement so a stale number (and its
        // auto-classified grade) can't linger behind the toggle.
        statuses[field.key] = "not_applicable";
        const measures = { ...zs.measures, [field.key]: "" };
        if (field.key === "tread") {
          measures.tread_inner = "";
          measures.tread_center = "";
          measures.tread_outer = "";
        }
        onPatch({ statuses, measures });
      }}
    />
  );

  if (field.key === "tread") {
    const detailed = zs.select.tread_mode === "detailed";
    const updateDetailed = (
      key: "tread_inner" | "tread_center" | "tread_outer",
      nextValue: string,
    ) => {
      const measures = { ...zs.measures, [key]: nextValue };
      const reading: TireTreadReading = {
        inner_32nds:
          measures.tread_inner === "" ? null : Number(measures.tread_inner),
        center_32nds:
          measures.tread_center === "" ? null : Number(measures.tread_center),
        outer_32nds:
          measures.tread_outer === "" ? null : Number(measures.tread_outer),
      };
      const minimum = getTireTreadMinimum(reading);
      measures.tread = minimum == null ? "" : String(minimum);
      onPatch({ measures, statuses: clearUnavailable() });
    };
    return (
      <div className="border-b border-primary/10 py-2.5">
        <Row
          label={field.label}
          hint={field.hint}
          required={required}
          saveState={saveState}
        >
          {!detailed ? (
            <>
              <input
                id={`inspection-${zoneId}-${field.key}`}
                aria-invalid={!!errorMessage}
                inputMode="numeric"
                value={value}
                onChange={(event) =>
                  onPatch({
                    measures: {
                      ...zs.measures,
                      [field.key]: event.target.value,
                    },
                    statuses: clearUnavailable(),
                  })
                }
                className="w-16 rounded-lg border border-primary/20 bg-card px-1 py-1.5 text-center text-[14px] tabular-nums text-foreground focus:border-primary focus:outline-none"
              />
              <span className="w-10 text-[11px] text-muted-foreground">
                {field.unit}
              </span>
              <GradeTag result={result} />
            </>
          ) : null}
          {unavailableControl}
        </Row>
        {detailed ? (
          <div className="grid grid-cols-3 gap-2 pt-2">
            {(
              [
                ["tread_inner", "Inner"],
                ["tread_center", "Center"],
                ["tread_outer", "Outer"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="text-[11px] text-muted-foreground">
                {label}
                <span className="ml-0.5 text-red-500">*</span>
                <div className="mt-1 flex items-center gap-1">
                  <input
                    id={`inspection-${zoneId}-${key}`}
                    aria-invalid={!!errorMessage}
                    inputMode="numeric"
                    value={zs.measures[key] ?? ""}
                    onChange={(event) =>
                      updateDetailed(key, event.target.value)
                    }
                    className="min-w-0 flex-1 rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-center text-[13px] tabular-nums text-foreground focus:border-primary focus:outline-none"
                  />
                  <span>/32&quot;</span>
                </div>
              </label>
            ))}
            <div className="col-span-3 text-[11px] text-muted-foreground">
              Shallowest: {value || "—"} /32&quot;
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => onPatch(toggleInspectionTreadMode(zs))}
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
        >
          {detailed ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          {detailed ? "Use shallowest only" : "Add inner, center, outer"}
        </button>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  const isRotor = field.key === "rotor";
  const unit: RotorUnit = zs.select.rotor_unit === "in" ? "in" : "mm";
  const hint =
    isRotor && field.ref != null
      ? `Reference min ${formatRotorReferenceMinimum(field.ref, unit)}`
      : field.hint;
  return (
    <div className="border-b border-primary/10">
      <Row
        label={field.label}
        hint={hint}
        required={required}
        saveState={saveState}
      >
        <input
          id={`inspection-${zoneId}-${field.key}`}
          aria-invalid={!!errorMessage}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(event) =>
            onPatch({
              measures: {
                ...zs.measures,
                [field.key]: event.target.value,
              },
              statuses: clearUnavailable(),
            })
          }
          className={cn(
            "rounded-lg border border-primary/20 bg-card px-1 py-1.5 text-center text-[14px] tabular-nums text-foreground focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            isRotor ? "w-20" : "w-16",
          )}
        />
        {isRotor ? (
          <CompactSelect
            ariaLabel="Brake rotor thickness unit"
            value={unit}
            options={[
              { value: "mm", label: "mm" },
              { value: "in", label: "in" },
            ]}
            className="w-20"
            isDisabled={disabled}
            onChange={(next) => {
              const nextUnit: RotorUnit = next === "in" ? "in" : "mm";
              const entered = Number(value);
              onPatch({
                select: { ...zs.select, rotor_unit: nextUnit },
                measures: {
                  ...zs.measures,
                  rotor:
                    value && Number.isFinite(entered)
                      ? formatRotorValue(
                          convertRotorValue(entered, unit, nextUnit),
                          nextUnit,
                        )
                      : value,
                },
                statuses: clearUnavailable(),
              });
            }}
          />
        ) : (
          <span className="w-10 text-[11px] text-muted-foreground">
            {field.unit}
          </span>
        )}
        {field.classify ? <GradeTag result={result} /> : null}
        {disabled ? null : unavailableControl}
      </Row>
      {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
    </div>
  );
}

function UnavailableToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label="Not visible or not available"
      title="Not visible or not available"
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        active
          ? "border-slate-500 bg-slate-500 text-white"
          : "border-primary/20 bg-transparent text-muted-foreground/40 hover:border-primary/40 hover:text-muted-foreground",
      )}
    >
      <EyeOff className="h-3.5 w-3.5" />
    </button>
  );
}

function GradeTag({ result }: { result: { lvl: string; txt: string } }) {
  return (
    <span
      className={cn(
        "min-w-[64px] rounded-md border px-2 py-1 text-center text-[11px] font-semibold",
        GRADE_TAG[result.lvl],
      )}
    >
      {result.txt}
    </span>
  );
}

function InlineFieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="px-2 pb-2 text-[11px] font-medium text-red-600">
      {message}
    </p>
  );
}

function optionsForInspectionField(fieldKey: string): InspectionOption[] {
  if (fieldKey === "tire_brand") return TIRE_BRAND_OPTIONS;
  if (fieldKey === "tire_model") return TIRE_MODEL_OPTIONS;
  if (fieldKey === "tire_size") return TIRE_SIZE_OPTIONS;
  if (fieldKey === "pad_brand") return BRAKE_PAD_BRAND_OPTIONS;
  if (fieldKey === "oil_viscosity") return OIL_VISCOSITY_OPTIONS;
  if (fieldKey === "oil_type") return OIL_TYPE_OPTIONS;
  if (fieldKey === "coolant_type") return COOLANT_TYPE_OPTIONS;
  if (fieldKey === "brake_fluid_type") return BRAKE_FLUID_OPTIONS;
  if (fieldKey === "transmission_fluid_type") return TRANSMISSION_FLUID_OPTIONS;
  if (fieldKey === "power_steering_fluid_type")
    return POWER_STEERING_FLUID_OPTIONS;
  return [];
}

function CompactSelect({
  id,
  ariaLabel,
  value,
  options,
  className,
  isDisabled,
  onChange,
}: {
  id?: string;
  ariaLabel: string;
  value: string;
  options: InspectionOption[];
  className?: string;
  isDisabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      selectedKey={value || null}
      onSelectionChange={(key) => onChange(key == null ? "" : String(key))}
      aria-label={ariaLabel}
      placeholder="—"
      isDisabled={isDisabled}
      className={className}
    >
      <SelectTrigger id={id} className="h-9 px-2 text-[13px]">
        <SelectValue />
      </SelectTrigger>
      <SelectPopover className="max-h-72 rounded-lg">
        <SelectListBox shouldFocusWrap>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              id={option.value}
              textValue={option.label}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectListBox>
      </SelectPopover>
    </Select>
  );
}

function Row({
  label,
  hint,
  required,
  badge,
  saveState,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  badge?: string;
  saveState?: FieldSaveState;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-primary/10 py-2.5 last:border-b-0",
        required && "border-l-2 border-l-red-400 pl-2",
      )}
    >
      <span
        className={cn(
          "flex-1 text-[13px] text-foreground",
          required && "font-medium",
        )}
      >
        {label}
        {required ? (
          <span className="ml-1 text-red-500" title="Required">
            *
          </span>
        ) : null}
        {badge ? (
          <span className="ml-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
            {badge}
          </span>
        ) : null}
        {hint ? (
          <span className="ml-1 text-[11px] text-muted-foreground">
            · {hint}
          </span>
        ) : null}
      </span>
      {children}
      <FieldSaveBadge state={saveState} />
    </div>
  );
}

function InspectionStickerFields({
  status,
  expires,
  onStatus,
  onExpires,
}: {
  status: InspectionStatus | "";
  expires: string;
  onStatus: (s: InspectionStatus | "") => void;
  onExpires: (s: string) => void;
}) {
  return (
    <div className="mt-3 space-y-1 rounded-lg bg-primary/[0.03] p-3">
      <Row label="Inspection sticker">
        <CompactSelect
          ariaLabel="Inspection sticker"
          value={status}
          options={INSPECTION_STATUS_OPTIONS}
          onChange={(value) => onStatus(value as InspectionStatus | "")}
          className="w-40"
        />
      </Row>
      <Row label="Expires">
        <MonthPicker
          // Month + year only — a state inspection sticker is punched to the
          // month, so the day input was asking for precision that doesn't
          // exist (Abdul, Aug 20 session). Custom Otopair-themed picker instead
          // of the browser's default `type="month"` popup.
          aria-label="Inspection sticker expiration"
          value={expires}
          onChange={onExpires}
          placeholder="—"
          className="w-40"
        />
      </Row>
    </div>
  );
}

// Vehicle-level aftermarket mods capture — rendered as the last section of
// the inspection form (not tied to any zone).
function AftermarketModsSection({
  aftermarket,
  notes,
  systems,
  onAftermarket,
  onNotes,
  onSystems,
}: {
  aftermarket: boolean;
  notes: string;
  systems: AffectedSystem[];
  onAftermarket: (b: boolean) => void;
  onNotes: (s: string) => void;
  onSystems: (s: AffectedSystem[]) => void;
}) {
  const toggleSystem = (value: AffectedSystem) => {
    if (value === "cosmetic_only") {
      onSystems(systems.includes("cosmetic_only") ? [] : ["cosmetic_only"]);
      return;
    }
    const withoutCosmetic = systems.filter((s) => s !== "cosmetic_only");
    onSystems(
      withoutCosmetic.includes(value)
        ? withoutCosmetic.filter((s) => s !== value)
        : [...withoutCosmetic, value],
    );
  };
  return (
    <div className="rounded-xl border border-primary/10 bg-card p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-[15px] font-semibold text-foreground">
          Aftermarket modifications
        </h4>
        <input
          type="checkbox"
          checked={aftermarket}
          onChange={(e) => onAftermarket(e.target.checked)}
          className="h-4 w-4 accent-[var(--primary)]"
        />
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Anything non-stock on this vehicle? Otopair flags it to future shops on
        the services it affects.
      </p>
      {aftermarket ? (
        <div className="mt-3">
          <input
            value={notes}
            onChange={(e) => onNotes(e.target.value)}
            placeholder="Modification notes"
            className="w-full rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
          />
          <div className="pt-2">
            <div className="text-[12px] font-medium text-foreground">
              Which systems do these affect?
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {AFFECTED_SYSTEMS.map((sys) => {
                const selected = systems.includes(sys.value);
                return (
                  <button
                    key={sys.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleSystem(sys.value)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[12px] font-medium transition-colors",
                      selected
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-primary/20 bg-card text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {selected ? <Check className="h-3 w-3" /> : null}
                    {sys.label}
                  </button>
                );
              })}
            </div>
            {(() => {
              const onlyCosmetic =
                systems.length === 1 && systems[0] === "cosmetic_only";
              const services = servicesForSystems(systems);
              if (onlyCosmetic) {
                return (
                  <div className="mt-2 rounded-lg border border-primary/20 bg-card px-2.5 py-2 text-[11px] text-muted-foreground">
                    Cosmetic only — recorded, but won&apos;t flag any future
                    service.
                  </div>
                );
              }
              if (services.length === 0) {
                return (
                  <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-2 text-[11px] text-blue-700">
                    No systems selected yet — tap the systems above and Otopair
                    flags the right future services automatically.
                  </div>
                );
              }
              return (
                <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-2 text-[11px] text-blue-700">
                  <span className="font-semibold">
                    Future shops will be alerted on {services.length} service
                    {services.length === 1 ? "" : "s"}:
                  </span>{" "}
                  {services.map((s) => s.name).join(" · ")}.{" "}
                  <span className="font-semibold">
                    Hidden on everything else.
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Mechanic parts fill-in ─────────────────────────────────────────────────

type PartVerifyPickOption = {
  partId: string;
  oemNumber: string;
  name: string;
  confidence: number;
  origin: "winner" | "loser" | "eliminated_by_gate" | "dropped_cross_make";
};

type PartVerifyItem = {
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  roleKey: string;
  roleLabel: string;
  status: "MISSING" | "LOW_CONFIDENCE";
  kind: "booked" | "gap";
  position?: "front" | "rear";
  current: {
    partId: string;
    oemNumber: string;
    name: string;
    confidence: number;
  } | null;
  pickOptions: PartVerifyPickOption[];
};

type VerifyInput = {
  mode: "confirm_existing" | "freehand";
  partId?: string;
  oemNumber?: string;
  partName?: string;
};

const ORIGIN_LABEL: Record<PartVerifyPickOption["origin"], string> = {
  winner: "current best match",
  loser: "alternate on file",
  eliminated_by_gate: "low-confidence on file",
  dropped_cross_make: "dropped by OEM-strict check",
};

function PartsVerifyZone({
  items,
  verifiedKeys,
  onVerify,
  onNotApplicable,
}: {
  items: PartVerifyItem[];
  verifiedKeys: Set<string>;
  onVerify: (item: PartVerifyItem, input: VerifyInput) => Promise<void>;
  onNotApplicable: (item: PartVerifyItem) => Promise<void>;
}) {
  const booked = items.filter((it) => it.kind === "booked");
  const gaps = items.filter((it) => it.kind === "gap");
  return (
    <div className="space-y-4">
      {booked.length > 0 ? (
        <div className="space-y-3">
          <div className="mb-1">
            <h4 className="text-[15px] font-semibold text-foreground">
              Parts for this job
            </h4>
            <p className="text-[11px] text-muted-foreground">
              Confirm the OEM part for the booked service — pick the match or
              type the number off the old part.
            </p>
          </div>
          {booked.map((item) => (
            <PartsVerifyRow
              key={`${item.serviceId}:${item.roleKey}`}
              item={item}
              verified={verifiedKeys.has(`${item.serviceId}:${item.roleKey}`)}
              onVerify={(input) => onVerify(item, input)}
              onNotApplicable={() => onNotApplicable(item)}
            />
          ))}
        </div>
      ) : null}
      {gaps.length > 0 ? (
        <div className="space-y-3">
          <div className="mb-1">
            <h4 className="text-[15px] font-semibold text-foreground">
              Missing parts for this vehicle
            </h4>
            <p className="text-[11px] text-muted-foreground">
              We have no OEM part on file for these services. Add the part off
              the vehicle to make the service available, or mark it not
              applicable.
            </p>
          </div>
          {gaps.map((item) => (
            <PartsVerifyRow
              key={`${item.serviceId}:${item.roleKey}`}
              item={item}
              verified={verifiedKeys.has(`${item.serviceId}:${item.roleKey}`)}
              onVerify={(input) => onVerify(item, input)}
              onNotApplicable={() => onNotApplicable(item)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PartsVerifyRow({
  item,
  verified,
  onVerify,
  onNotApplicable,
}: {
  item: PartVerifyItem;
  verified: boolean;
  onVerify: (input: VerifyInput) => Promise<void>;
  onNotApplicable: () => Promise<void>;
}) {
  const FREEHAND = "__freehand__";
  const [selected, setSelected] = useState<string>(
    () => item.pickOptions[0]?.partId ?? FREEHAND,
  );
  const [oemNumber, setOemNumber] = useState("");
  const [partName, setPartName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isFreehand = selected === FREEHAND;

  async function submit() {
    setError("");
    if (isFreehand && !oemNumber.trim()) {
      setError("Enter the OEM part number.");
      return;
    }
    setBusy(true);
    try {
      await onVerify(
        isFreehand
          ? {
              mode: "freehand",
              oemNumber: oemNumber.trim(),
              partName: partName.trim(),
            }
          : { mode: "confirm_existing", partId: selected },
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save this part.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function notApplicable() {
    setError("");
    setBusy(true);
    try {
      await onNotApplicable();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update this service.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (verified) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
        <Check className="h-4 w-4 text-emerald-600" />
        <div className="text-[13px]">
          <span className="font-semibold text-emerald-800">
            {item.roleLabel}
          </span>
          <span className="text-emerald-700">
            {" "}
            confirmed for {item.serviceName}.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground">
            {item.roleLabel}
            {item.position ? (
              <span className="text-muted-foreground"> ({item.position})</span>
            ) : null}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {item.serviceName}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
            item.status === "MISSING"
              ? "bg-red-100 text-red-700"
              : "bg-amber-100 text-amber-700",
          )}
        >
          {item.status === "MISSING" ? "No OEM part on file" : "Low confidence"}
        </span>
      </div>

      {item.current ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Current guess: {item.current.name} · {item.current.oemNumber} (
          {Math.round(item.current.confidence * 100)}% confidence)
        </p>
      ) : null}

      <div className="space-y-1.5">
        {item.pickOptions.map((opt) => (
          <label
            key={opt.partId}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors",
              selected === opt.partId
                ? "border-primary bg-primary/5"
                : "border-primary/15 hover:bg-primary/[0.03]",
            )}
          >
            <input
              type="radio"
              name={`pick-${item.serviceId}-${item.roleKey}`}
              checked={selected === opt.partId}
              onChange={() => setSelected(opt.partId)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="font-medium text-foreground">{opt.name}</span>
              <span className="text-muted-foreground"> · {opt.oemNumber}</span>
              <span className="block text-[10px] text-muted-foreground">
                {ORIGIN_LABEL[opt.origin]}
              </span>
            </span>
          </label>
        ))}

        <label
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors",
            isFreehand
              ? "border-primary bg-primary/5"
              : "border-primary/15 hover:bg-primary/[0.03]",
          )}
        >
          <input
            type="radio"
            name={`pick-${item.serviceId}-${item.roleKey}`}
            checked={isFreehand}
            onChange={() => setSelected(FREEHAND)}
          />
          <span className="font-medium text-foreground">
            Type the OEM number
          </span>
        </label>
      </div>

      {isFreehand ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            value={oemNumber}
            onChange={(e) => setOemNumber(e.target.value)}
            placeholder="OEM part number"
            className="flex-1 rounded-lg border border-primary/20 bg-card px-2.5 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
          />
          <input
            value={partName}
            onChange={(e) => setPartName(e.target.value)}
            placeholder="Part name (optional)"
            className="flex-1 rounded-lg border border-primary/20 bg-card px-2.5 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
          />
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          {error}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {item.kind === "gap" ? "Add part" : "Confirm part"}
        </button>
        {item.kind === "gap" ? (
          <button
            type="button"
            onClick={notApplicable}
            disabled={busy}
            className="text-[12px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
          >
            Not applicable to this vehicle
          </button>
        ) : null}
      </div>
    </div>
  );
}

function OwnerZone({
  questions,
  answers,
  loading,
  confirmed,
  onChange,
  onToggleComplete,
}: {
  questions: OwnerQuestion[];
  answers: Record<string, OwnerProfileAnswerValue>;
  loading: boolean;
  confirmed: boolean;
  onChange: (key: string, value: OwnerProfileAnswerValue) => void;
  onToggleComplete: () => void;
}) {
  if (loading) {
    return (
      <p className="py-6 text-center text-[13px] text-muted-foreground">
        Loading owner profile…
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
            Owner profile
            <span className="rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Optional
            </span>
          </h4>
          <p className="text-[11px] text-muted-foreground">
            {questions.length === 0
              ? "The customer answered everything during onboarding — nothing to fill in."
              : "Questions the customer skipped during onboarding. Fill in what you can observe or ask."}
          </p>
        </div>
        {confirmed ? (
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600">
            <Check className="h-3.5 w-3.5" /> confirmed
          </span>
        ) : null}
      </div>
      {questions.map((q) => (
        <OwnerQuestionRow
          key={q.key}
          question={q}
          value={answers[q.key] ?? null}
          onChange={(value) => onChange(q.key, value)}
        />
      ))}
      <div className="flex justify-end pt-3">
        <button
          type="button"
          onClick={onToggleComplete}
          className={cn(
            "rounded-xl px-4 py-2 text-[13px] font-semibold transition-colors",
            confirmed
              ? "border border-primary/20 bg-card text-muted-foreground hover:bg-primary/5"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {confirmed ? "Mark incomplete" : "Mark zone complete"}
        </button>
      </div>
    </div>
  );
}

function OwnerQuestionRow({
  question,
  value,
  onChange,
}: {
  question: OwnerQuestion;
  value: OwnerProfileAnswerValue;
  onChange: (value: OwnerProfileAnswerValue) => void;
}) {
  return (
    <div className="border-b border-primary/10 py-3 last:border-b-0">
      <div className="mb-1.5 text-[13px] text-foreground">
        {question.question}
        {question.hint ? (
          <span className="ml-1 text-[11px] text-muted-foreground">
            · {question.hint}
          </span>
        ) : null}
      </div>

      {question.type === "single" ? (
        <div className="flex flex-wrap gap-2">
          {question.options?.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-[12px] transition-colors",
                value === opt.value
                  ? "border-primary bg-primary/10 font-semibold text-primary"
                  : "border-primary/20 bg-card text-muted-foreground hover:bg-primary/5",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : null}

      {question.type === "multi" ? (
        <div className="flex flex-wrap gap-2">
          {question.options?.map((opt) => {
            const arr = Array.isArray(value) ? value : [];
            const active = arr.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  onChange(
                    active
                      ? arr.filter((v) => v !== opt.value)
                      : [...arr, opt.value],
                  )
                }
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-[12px] transition-colors",
                  active
                    ? "border-primary bg-primary/10 font-semibold text-primary"
                    : "border-primary/20 bg-card text-muted-foreground hover:bg-primary/5",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {question.type === "boolean" ? (
        <div className="flex gap-2">
          {[
            { v: true, label: "Yes" },
            { v: false, label: "No" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => onChange(o.v)}
              className={cn(
                "rounded-lg border px-4 py-1.5 text-[12px] transition-colors",
                value === o.v
                  ? "border-primary bg-primary/10 font-semibold text-primary"
                  : "border-primary/20 bg-card text-muted-foreground hover:bg-primary/5",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}

      {question.type === "text" ? (
        <input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
        />
      ) : null}
    </div>
  );
}

function ResultsScreen({
  findings,
  totalLogged,
  vehicleLabel,
  downloading,
  onBack,
  onDownload,
  suggestions,
  canRecommend,
  recsBusy,
  submittedRecs,
  onAddRecommendations,
  onUndoRecommendation,
  undoingKey,
  error,
  canAddToJob,
  onAddToJob,
  addedToJob,
  addingToJobKey,
  addedJobs,
  onRemoveAddedJob,
  removingJobId,
  onOpenScope,
  jobInProgress,
  inspectionComplete,
  scopeSubmittedNote,
}: {
  findings: {
    attention: { label: string; zone: string }[];
    monitor: { label: string; zone: string }[];
  };
  totalLogged: number;
  vehicleLabel: string;
  downloading: boolean;
  onBack: () => void;
  onDownload: () => void;
  suggestions: ResolvedSuggestion[];
  canRecommend: boolean;
  recsBusy: boolean;
  submittedRecs: Record<string, Id<"job_recommendations">>;
  onAddRecommendations: (keys: string[]) => void;
  onUndoRecommendation: (key: string) => void;
  undoingKey: string | null;
  error: string;
  /** Only true once the job is running — see onAddToJob. */
  canAddToJob: boolean;
  onAddToJob: (key: string) => void;
  addedToJob: Record<string, boolean>;
  addingToJobKey: string | null;
  /** Work already on the booking — the persistent, server-derived "added to this
   *  job" list (survives refresh, unlike addedToJob). */
  addedJobs: Array<{ _id: Id<"custom_jobs">; name: string }>;
  /** Pull a line back off the job. */
  onRemoveAddedJob: (customJobId: Id<"custom_jobs">) => void;
  removingJobId: string | null;
  /** Open the mid-job scope dialog for a line already added to the job. Only
   *  used when jobInProgress — a pre-job inspection sends its added scope through
   *  the inspection SUBMIT, not a button here. */
  onOpenScope: () => void;
  /** The booking is already running. Pre-job (false): the added scope is sent as
   *  part of "Submit → Vehicle Health" (commitInspectionAndAwaitEstimate opens
   *  the estimate), so there's NO "Price & send" here — just a note that submit
   *  will prompt it. Mid-job (true): the job's underway with no such submit step,
   *  so the line keeps its own "Price & send" → mid-job change. */
  jobInProgress: boolean;
  /** All required zones are graded, with no zone left holding unsaved readings.
   *  Gates the mid-job "Price & send" and flips the pre-job note to "ready". */
  inspectionComplete: boolean;
  /** Set once the (mid-job) scope dialog sends the extra work for confirmation. */
  scopeSubmittedNote: string | null;
}) {
  // Default-select the urgent ("soon") suggestions; mechanic can toggle.
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(suggestions.map((s) => [s.key, s.urgency === "soon"])),
  );
  // A suggestion already added to this job lives in the "Added to this job" box
  // above — drop it from the follow-ups list so it isn't shown and actionable
  // in two places at once. Keep it if it was ALSO submitted as a recommendation
  // so that Undo state still renders. addedToJob is the optimistic flag (the
  // add→server-catch-up window); addedJobs is the reactive server truth (it
  // survives a refresh), matched on the name the line was added under.
  const addedJobKeys = new Set(addedJobs.map((j) => serviceMatchKey(j.name)));
  const visibleSuggestions = suggestions.filter(
    (s) =>
      !!submittedRecs[s.key] ||
      (!addedToJob[s.key] &&
        !addedJobKeys.has(serviceMatchKey(s.serviceName ?? s.label))),
  );
  const selectableSuggestions = visibleSuggestions.filter(
    (s) => !submittedRecs[s.key],
  );
  const selectedKeys = selectableSuggestions
    .filter((s) => selected[s.key])
    .map((s) => s.key);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div>
          <h3 className="text-[16px] font-semibold text-foreground">
            Inspection summary
          </h3>
          <p className="text-[12px] text-muted-foreground">{vehicleLabel}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat
          n={findings.attention.length}
          label="Needs attention"
          tone="text-red-600"
        />
        <Stat
          n={findings.monitor.length}
          label="Monitor"
          tone="text-amber-600"
        />
        <Stat n={totalLogged} label="Zones logged" tone="text-emerald-600" />
      </div>

      {findings.attention.length ? (
        <FindingList
          title="Needs attention"
          tone="text-red-600"
          dot="bg-red-500"
          items={findings.attention}
        />
      ) : null}
      {findings.monitor.length ? (
        <FindingList
          title="Monitor"
          tone="text-amber-600"
          dot="bg-amber-500"
          items={findings.monitor}
        />
      ) : null}

      {/* Work added to this job. Server-derived so it survives a refresh (the
          per-suggestion "added" flags don't) and so each line can be pulled back
          off the same way it went on — the undo the ephemeral flags never had.
          Once here, the line drops out of "Suggested follow-ups" above (it's now
          on the booking), so this is where you act on it. */}
      {addedJobs.length ? (
        <div className="rounded-xl border border-primary/15 bg-primary/[0.03] p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
            <Wrench className="h-3.5 w-3.5 text-primary" />
            Added to this job
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            {jobInProgress
              ? "Price it, add parts, and send for the customer's confirmation — or remove it if you added it by mistake."
              : "Staged for this vehicle. You'll price it and send for the customer's confirmation when you submit the inspection — or remove it if you added it by mistake."}
          </p>
          {scopeSubmittedNote ? (
            <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-medium text-emerald-700">
              <Check className="h-3.5 w-3.5 flex-shrink-0" />
              {scopeSubmittedNote}
            </p>
          ) : !inspectionComplete ? (
            // The estimate must wait for a finished inspection. Sending it early
            // parks the booking in "awaiting hold", which blocks reopening the
            // check — the exact trap this guards against.
            <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-700">
              Finish every zone first
              {jobInProgress
                ? " — then send this for confirmation."
                : ", then submit the inspection to price and send this for the customer's confirmation."}
            </p>
          ) : !jobInProgress ? (
            // All zones done — the pre-job estimate goes out as part of the
            // inspection submit (commitInspectionAndAwaitEstimate), so tell the
            // mechanic that's where it happens. No standalone send button.
            <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-primary/[0.06] px-2.5 py-1.5 text-[11px] font-medium text-primary">
              <Wrench className="h-3.5 w-3.5 flex-shrink-0" />
              Ready — &ldquo;Submit → Vehicle Health&rdquo; will prompt you to
              price and send this added scope for the customer&apos;s
              confirmation.
            </p>
          ) : null}
          <div className="space-y-1">
            {addedJobs.map((job) => (
              <div
                key={String(job._id)}
                className="flex items-center gap-2 border-b border-primary/10 py-2 last:border-b-0"
              >
                <span className="flex-1 text-[13px] font-medium text-foreground">
                  {job.name}
                </span>
                {/* Mid-job only: the running job has no inspection-submit step to
                    carry the estimate, so each line keeps its own send. A pre-job
                    inspection sends everything through "Submit → Vehicle Health". */}
                {jobInProgress ? (
                  <button
                    type="button"
                    onClick={onOpenScope}
                    disabled={!inspectionComplete}
                    title={
                      inspectionComplete
                        ? undefined
                        : "Finish the inspection before sending for confirmation"
                    }
                    className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-primary/30 px-1.5 py-0.5 text-[10px] font-semibold text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    Price &amp; send
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRemoveAddedJob(job._id)}
                  disabled={removingJobId !== null}
                  aria-label={`Remove ${job.name}`}
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:bg-red-100 hover:text-red-700 disabled:opacity-50"
                >
                  {removingJobId === String(job._id) ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Suggested follow-ups derived from the measurements. Anything already
          added to this job is filtered out — it shows in the box above. */}
      {visibleSuggestions.length ? (
        <div className="rounded-xl border border-primary/15 bg-primary/[0.03] p-3">
          <div className="mb-1 text-[12px] font-semibold text-foreground">
            Suggested follow-ups
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Derived from your measurements. Confirm to send to the
            customer&apos;s recommendations — attributed to this shop&apos;s
            inspection, and lowers their Vehicle Health Score until resolved.
          </p>
          <div className="space-y-1">
            {visibleSuggestions.map((s) =>
              submittedRecs[s.key] ? (
                <div
                  key={s.key}
                  className="flex items-start gap-2 border-b border-primary/10 py-2 last:border-b-0"
                >
                  <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                  <span className="flex-1">
                    <span className="text-[13px] font-medium text-foreground">
                      {s.serviceName ?? s.label}
                    </span>
                    <span className="block text-[11px] text-emerald-700">
                      Added to customer&apos;s recommendations.
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onUndoRecommendation(s.key)}
                    disabled={undoingKey !== null}
                    className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:bg-emerald-100 hover:text-emerald-800 disabled:opacity-50"
                  >
                    {undoingKey === s.key ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Undo
                  </button>
                </div>
              ) : (
                <div
                  key={s.key}
                  className="flex items-start gap-2 border-b border-primary/10 py-2 last:border-b-0"
                >
                  <label className="flex flex-1 cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={!!selected[s.key]}
                      onChange={(e) =>
                        setSelected((prev) => ({
                          ...prev,
                          [s.key]: e.target.checked,
                        }))
                      }
                      className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                    />
                    <span className="flex-1">
                      <span className="text-[13px] font-medium text-foreground">
                        {s.serviceName ?? s.label}
                      </span>
                      {!s.serviceId ? (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                          not in catalog
                        </span>
                      ) : null}
                      <span className="block text-[11px] text-muted-foreground">
                        {s.reasons.join(" · ")} · {URGENCY_LABEL[s.urgency]}
                      </span>
                    </span>
                  </label>
                  {/* The second door. Without it a finding flagged here has to
                      be retyped from scratch through Flag Issue → Extra work,
                      which is exactly what Abdul had to do for the wipers. */}
                  {canAddToJob ? (
                    <button
                      type="button"
                      onClick={() => onAddToJob(s.key)}
                      disabled={addingToJobKey !== null}
                      className="mt-0.5 inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-primary/30 px-1.5 py-0.5 text-[10px] font-semibold text-primary transition hover:bg-primary/10 disabled:opacity-50"
                    >
                      {addingToJobKey === s.key ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Wrench className="h-3 w-3" />
                      )}
                      Add to this job
                    </button>
                  ) : null}
                </div>
              ),
            )}
          </div>
          {selectableSuggestions.length > 0 ? (
            <button
              type="button"
              disabled={!canRecommend || recsBusy || selectedKeys.length === 0}
              onClick={() => onAddRecommendations(selectedKeys)}
              className="mt-2 inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-card px-3 py-1.5 text-[12px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {recsBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Add {selectedKeys.length || ""} recommendation
              {selectedKeys.length === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border border-primary/20 bg-card px-4 py-2 text-[13px] font-semibold text-muted-foreground hover:bg-primary/5"
        >
          Back to inspection
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          className="ml-auto inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Download inspection sheet
        </button>
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="rounded-xl border border-primary/10 bg-card px-3 py-3">
      <div className={cn("text-[22px] font-semibold tabular-nums", tone)}>
        {n}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function FindingList({
  title,
  tone,
  dot,
  items,
}: {
  title: string;
  tone: string;
  dot: string;
  items: { label: string; zone: string }[];
}) {
  return (
    <div>
      <div className={cn("mb-1 text-[12px] font-semibold", tone)}>{title}</div>
      {items.map((it, i) => (
        <div
          key={i}
          className="flex items-center gap-2 border-b border-primary/10 py-2 last:border-b-0"
        >
          <span className={cn("h-3 w-3 rounded-full", dot)} />
          <span className="flex-1 text-[13px] text-foreground">{it.label}</span>
          <span className="text-[11px] text-muted-foreground">{it.zone}</span>
        </div>
      ))}
    </div>
  );
}
