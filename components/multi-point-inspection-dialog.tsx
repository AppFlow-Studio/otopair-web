"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Loader2,
  Trash2,
} from "lucide-react";
import { useMutation, useQuery, useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import { Combobox } from "@/components/ui/combobox";
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
  createInspectionState,
  defaultZoneState,
  derivePrejobFromInspection,
  deriveSuggestedRecommendations,
  gatherFindings,
  getDirtyIncompleteZones,
  INSPECTION_NAV_ZONE_IDS,
  isFieldRequiredForZone,
  normalizeTireSize,
  nextInspectionZoneAfterCompletion,
  patchInspectionZone,
  patchSharedInspectionText,
  zoneHasInput,
  INSPECTION_ZONES,
  INSPECTION_ZONES_BY_ID,
  requiredZonesForBooking,
  toggleInspectionTreadMode,
  TRI_LABELS,
  validateZoneForCompletion,
  type BrakeAxleScope,
  type InspectionField,
  type InspectionState,
  type TriValue,
  type ZoneId,
  type ZoneState,
} from "@/lib/inspection-template";
import {
  BRAKE_PAD_BRAND_OPTIONS,
  OTHER_INSPECTION_OPTION,
  resolveInspectionOption,
  TIRE_BRAND_OPTIONS,
  TIRE_MODEL_OPTIONS,
  TIRE_SIZE_OPTIONS,
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
  PreJobSurveyPayload,
  VehiclePassportData,
} from "@/lib/vehicle-passport";
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
    photo_ids?: string[];
  }>;
  findings_attention: Array<{ label: string; zone: string }>;
  findings_monitor: Array<{ label: string; zone: string }>;
};

type ResolvedSuggestion = {
  key: string;
  label: string;
  urgency: "soon" | "within_3_months" | "next_visit";
  reason: string;
  serviceId: Id<"services"> | null;
  serviceName: string | null;
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

const URGENCY_LABEL: Record<string, string> = {
  soon: "Soon",
  within_3_months: "Within 3 months",
  next_visit: "Next visit",
};

const INSPECTION_STATUS_OPTIONS: { value: InspectionStatus; label: string }[] = [
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
  const lower = message.toLowerCase();
  const position =
    lower.includes("front left")
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
  if (lower.includes("tread")) return { zoneId: position ?? "FL", fieldKey: "tread" };
  if (lower.includes("rotor thickness")) {
    return { zoneId: position ?? "FL", fieldKey: "rotor" };
  }
  if (lower.includes("pad thickness")) {
    return { zoneId: position ?? "FL", fieldKey: "pad" };
  }
  if (lower.includes("tire brand")) return { zoneId: "FL", fieldKey: "tire_brand" };
  if (lower.includes("tire size")) {
    return { zoneId: position === "RL" ? "RL" : "FL", fieldKey: "tire_size" };
  }
  if (lower.includes("tire condition")) {
    return { zoneId: position === "RL" ? "RL" : "FL", fieldKey: "wear" };
  }
  if (lower.includes("oil viscosity")) {
    return { zoneId: "ENG", fieldKey: "oil_viscosity" };
  }
  if (lower.includes("oil type")) return { zoneId: "ENG", fieldKey: "oil_type" };
  return null;
}

// ---------------------------------------------------------------------------

export default function MultiPointInspectionDialog(props: {
  open: boolean;
  bookingId?: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices?: string[];
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
  const isFirstVisit = !!passportData && !passportData.is_complete;

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
  const services = useQuery(api.services.list);
  const prepareInspectionPhotoUpload = useMutation(
    prepareInspectionPhotoUploadRef,
  ) as (args: {
    bookingId: string;
    zoneId: Exclude<ZoneId, "OWNER">;
    uploadToken: string;
  }) => Promise<string>;
  const attachInspectionPhoto = useMutation(attachInspectionPhotoRef) as (args: {
    bookingId: string;
    zoneId: Exclude<ZoneId, "OWNER">;
    storageId: string;
    uploadToken: string;
  }) => Promise<void>;
  const generateInspectionPdf = useAction(generateInspectionPdfRef) as (args: {
    bookingId: string;
  }) => Promise<{ url: string | null }>;
  const deleteInspectionPhoto = useMutation(deleteInspectionPhotoRef) as (args: {
    bookingId: string;
    storageId: string;
    zoneId?: Exclude<ZoneId, "OWNER">;
    uploadToken?: string;
  }) => Promise<void>;

  // ---- state -------------------------------------------------------------
  const [state, setState] = useState<InspectionState>(() => createInspectionState());
  const [activeZone, setActiveZone] = useState<ZoneId | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<ZoneId, { fieldKey: string; message: string }>>
  >({});
  const [downloading, setDownloading] = useState(false);
  const [photoPreviews, setPhotoPreviews] = useState<Record<string, string>>({});
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const [photoToRemove, setPhotoToRemove] = useState<{
    zoneId: ZoneId;
    storageId: string;
  } | null>(null);
  const photoPreviewsRef = useRef(photoPreviews);

  // Global header fields that don't belong to a single wheel.
  const [mileage, setMileage] = useState("");
  const [mileageError, setMileageError] = useState("");
  const [inspectionStatus, setInspectionStatus] = useState<InspectionStatus | "">("");
  const [inspectionExpires, setInspectionExpires] = useState("");
  const [modAftermarket, setModAftermarket] = useState(false);
  const [modNotes, setModNotes] = useState("");
  // Carried through from the pre-job survey / passport so a multi-point save
  // doesn't wipe affected systems this dialog has no UI to edit.
  const [modAffectedSystems, setModAffectedSystems] = useState<AffectedSystem[]>([]);
  const [nextTip, setNextTip] = useState("");

  // Owner-profile (skipped onboarding) answers keyed by question key.
  const [ownerAnswers, setOwnerAnswers] = useState<
    Record<string, OwnerProfileAnswerValue>
  >({});
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [ownerDirty, setOwnerDirty] = useState(false);

  const requiredZones = useMemo(
    () => requiredZonesForBooking(bookingServices),
    [bookingServices],
  );
  const requiredSet = useMemo(() => new Set(requiredZones), [requiredZones]);
  const baselineMileage =
    prefillData?.mileage ?? passportData?.passport.mileage ?? null;
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
              /brake|rotor/i.test(name),
            ),
            front: true,
            rear: true,
          },
    [bookingServices, savedBrakeScope],
  );
  const completionContext = useMemo(
    () => ({
      serviceNames: bookingServices,
      brakeScope,
      tireReplacementPositions,
    }),
    [bookingServices, brakeScope, tireReplacementPositions],
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
          photoIds: Array.isArray(z.photo_ids) ? [...z.photo_ids] : [],
        };
      }
      const pf = prefillData;
      if (typeof pf?.mileage === "number") setMileage(String(pf.mileage));
      if (pf?.inspection?.status) setInspectionStatus(pf.inspection.status);
      if (pf?.inspection?.expires_at) setInspectionExpires(pf.inspection.expires_at);
      if (pf?.modifications?.has_mods) setModAftermarket(true);
      if (pf?.modifications?.notes) setModNotes(pf.modifications.notes);
      setModAffectedSystems(pf?.modifications?.affected_systems ?? []);
      if (pf?.next_mechanic_tip) setNextTip(pf.next_mechanic_tip);
    }

    setState(next);

    setHydrated(true);
  }, [hydrated, bookingId, savedInspection, prefillData]);

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
      setState((prev) =>
        patchSharedInspectionText(prev, sourceId, key, value),
      );
      setFieldErrors((prev) => {
        if (!prev[sourceId]) return prev;
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
    },
    [],
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
    const list = deriveSuggestedRecommendations(state, { onlyCompletedZones: true });
    return list.map((s) => {
      // `match` holds exact catalog slugs — resolve straight to the service.
      const found = (
        (services ?? []) as Array<{
          _id: Id<"services">;
          name: string;
          slug?: string;
        }>
      ).find((svc) =>
        svc.slug ? s.match.includes(svc.slug) : false,
      );
      return {
        ...s,
        serviceId: found?._id ?? null,
        serviceName: found?.name ?? null,
      };
    });
  }, [state, services]);

  const [recsSubmitted, setRecsSubmitted] = useState(false);
  const [recsBusy, setRecsBusy] = useState(false);

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
        photo_ids: zs!.photoIds,
      })),
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
  ]);

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
      document
        .getElementById(`inspection-${zoneId}-${fieldKey}`)
        ?.focus();
    });
  }

  function openZoneAtTop(zoneId: ZoneId) {
    setActiveZone(zoneId);
    requestAnimationFrame(() =>
      document
        .getElementById("inspection-zone-panel")
        ?.scrollIntoView({ behavior: "auto", block: "start" }),
    );
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
    setError("");
    patchZone(zoneId, { done: true });
    const next = nextInspectionZoneAfterCompletion(zoneId);
    if (next) {
      openZoneAtTop(next);
    }
  }

  function validateBeforePersistence(action: SubmitIntent): boolean {
    setError("");
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
      const labels = dirty.map((id) => INSPECTION_ZONES_BY_ID[id].label).join(", ");
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
        setError(`Mark ${INSPECTION_ZONES_BY_ID[incomplete].label} complete before submitting.`);
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
    if (
      action === "start" &&
      typeof baselineMileage === "number" &&
      Number(mileage) < baselineMileage
    ) {
      const message = `Odometer cannot be lower than the stored ${baselineMileage.toLocaleString()} mi.`;
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
    if (!validateBeforePersistence(action)) return;
    await persistOwnerAnswers();
    const { prejob, inspection } = buildPayloads();
    try {
      await onSubmit(prejob, inspection, action);
    } catch (err) {
      const message = userFacingInspectionError(err, "Could not save inspection.");
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
      else setError("Inspection sheet is not ready yet. Try again in a moment.");
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
        reason: s.reason,
        visible_to_driver: true,
      }));
      await submitInspectionRecs({
        bookingId: bookingId as Id<"bookings">,
        recommendations,
      });
      setRecsSubmitted(true);
    } catch (err) {
      setError(userFacingInspectionError(err, "Could not add recommendations."));
    } finally {
      setRecsBusy(false);
    }
  }

  async function handlePhotoUpload(id: ZoneId, file: File) {
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
      });
      const previewUrl = URL.createObjectURL(file);
      setPhotoPreviews((prev) => ({ ...prev, [storageId!]: previewUrl }));
      setState((prev) => {
        const current =
          prev.zones[id] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[id]);
        return patchInspectionZone(prev, id, {
          photoIds: [...current.photoIds, storageId!],
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
        <Camera className="h-3.5 w-3.5" /> Verify a measurement with a photo → rating boost
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
      onClose={onClose}
      title="Multi-point inspection"
      description={bookingSubLabel}
      maxWidthClassName="max-w-2xl"
      mobileFullBleed
      contentClassName="min-h-0 flex-1 overflow-y-auto px-5 pb-4 sm:px-6 sm:pb-5"
      headerBadge={
        isFirstVisit ? (
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
            First visit
          </span>
        ) : null
      }
      footer={showResults ? undefined : footer}
    >
      {showResults ? (
        <div className="pt-4 sm:pt-5">
          <ResultsScreen
            findings={findings}
            totalLogged={Object.values(state.zones).filter((z) => z?.done).length}
            vehicleLabel={bookingLabel}
            downloading={downloading}
            onBack={() => setShowResults(false)}
            onDownload={handleDownloadPdf}
            suggestions={suggestedRecs}
            canRecommend={!!bookingId}
            recsBusy={recsBusy}
            recsSubmitted={recsSubmitted}
            onAddRecommendations={handleAddRecommendations}
            error={error}
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
            <label className="block">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Odometer <span className="text-red-500">*</span>
              </div>
              <div className="mt-0.5 flex items-baseline gap-1">
                <input
                  id="inspection-odometer"
                  aria-invalid={!!mileageError}
                  inputMode="numeric"
                  value={mileage}
                  onChange={(e) => {
                    setMileage(e.target.value.replace(/[^0-9]/g, ""));
                    setMileageError("");
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
          </div>

          {/* progress ring */}
          <div className="flex items-center gap-4">
            <svg width="56" height="56" viewBox="0 0 58 58" aria-hidden>
              <circle cx="29" cy="29" r="22" fill="none" stroke="currentColor" className="text-primary/15" strokeWidth="6" />
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
              <text x="29" y="33.5" textAnchor="middle" fontSize="13" fontWeight="600" className="fill-foreground">
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
            <div className="hidden items-center gap-3 sm:flex">
              {(["g", "y", "r"] as TriValue[]).map((c) => (
                <span key={c} className="flex items-center gap-1 text-[11px] text-muted-foreground">
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
          <div className="flex justify-center">
            <CarDiagram
              activeZone={activeZone}
              isDone={(id) => !!state.zones[id]?.done}
              isRequired={(id) => requiredSet.has(id)}
              onSelect={setActiveZone}
            />
          </div>

          {/* owner-profile zone entry (not a physical location) */}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setActiveZone("OWNER")}
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
            ) : (
              <ZonePanel
                zoneId={activeZone}
                zs={zoneState(activeZone)}
                isFirstVisit={isFirstVisit}
                isRequired={requiredSet.has(activeZone)}
                completionContext={completionContext}
                fieldError={fieldErrors[activeZone]}
                canPhoto={!!bookingId}
                photoBusy={photoBusy}
                photoUrl={photoUrl}
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
                onPhoto={(file) => handlePhotoUpload(activeZone, file)}
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
                  openZoneAtTop(NAV_ZONE_IDS[(index + 1) % NAV_ZONE_IDS.length]);
                }}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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
    <svg width="300" height="232" viewBox="0 0 300 232" role="group" aria-label="Vehicle inspection map">
      <rect x="92" y="20" width="116" height="192" rx="32" className="fill-primary/[0.04] stroke-primary/15" strokeWidth="1.4" />
      {(Object.keys(DIAGRAM_RECTS) as Array<Exclude<ZoneId, "OWNER">>).map((id) => {
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
                done || active || required ? "fill-foreground" : "fill-muted-foreground",
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
              <circle cx={r.x + r.w - 3.5} cy={r.y + 3.5} r={3} className="fill-primary" />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function ZonePanel({
  zoneId,
  zs,
  isFirstVisit,
  isRequired,
  completionContext,
  fieldError,
  canPhoto,
  photoBusy,
  photoUrl,
  extraHeader,
  onPatch,
  onSharedText,
  onPhoto,
  onRemovePhoto,
  onToggleDone,
  onPrevious,
  onNext,
}: {
  zoneId: ZoneId;
  zs: ZoneState;
  isFirstVisit: boolean;
  isRequired: boolean;
  completionContext: {
    serviceNames: string[];
    brakeScope: BrakeAxleScope;
    tireReplacementPositions?: BookedTirePosition[];
  };
  fieldError?: { fieldKey: string; message: string };
  canPhoto: boolean;
  photoBusy: string | null;
  photoUrl: (storageId: string) => string | undefined;
  extraHeader?: React.ReactNode;
  onPatch: (patch: Partial<ZoneState>) => void;
  onSharedText: (key: string, value: string) => void;
  onPhoto: (file: File) => void;
  onRemovePhoto: (storageId: string) => void;
  onToggleDone: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const zone = INSPECTION_ZONES_BY_ID[zoneId];
  const tireReplacementScheduled =
    (zoneId === "FL" || zoneId === "FR" || zoneId === "RL" || zoneId === "RR") &&
    completionContext.tireReplacementPositions?.includes(zoneId);
  return (
    <div className="space-y-1">
      <div className="sticky top-0 z-20 -mx-2 mb-2 flex items-center justify-between gap-2 border-b border-primary/10 bg-card/95 px-2 py-2 backdrop-blur">
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

      {tireReplacementScheduled ? (
        <p className="rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-[12px] text-muted-foreground">
          <span className="font-semibold text-foreground">
            Tire replacement scheduled.
          </span>{" "}
          Outgoing-tire details are optional. Installed axle size is still
          required.
        </p>
      ) : null}

      {zone.fields.map((field, i) => {
        const prevSection = i > 0 ? zone.fields[i - 1].section : undefined;
        const showSection = field.section && field.section !== prevSection;
        return (
          <div key={field.key}>
            {showSection ? (
              <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-1">
                {field.section}
              </div>
            ) : null}
            <FieldRow
              zoneId={zoneId}
              field={field}
              zs={zs}
              isFirstVisit={isFirstVisit}
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
              onPatch={onPatch}
              onSharedText={onSharedText}
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

      {!zs.done && zoneHasInput(zoneId, zs) ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          You&apos;ve entered readings here — tap{" "}
          <span className="font-semibold">Mark zone complete</span> so they count
          toward findings &amp; recommendations.
        </p>
      ) : null}

      <div className="flex items-center gap-2 pt-3">
        {canPhoto ? (
          <label
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-primary/20 px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-primary/5",
              photoBusy === zoneId ? "cursor-wait opacity-60" : "cursor-pointer",
            )}
          >
            {photoBusy === zoneId ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
            Add photo
            <input
              type="file"
              accept="image/*"
              disabled={photoBusy === zoneId}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onPhoto(file);
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
  isFirstVisit,
  required,
  errorMessage,
  onPatch,
  onSharedText,
}: {
  zoneId: ZoneId;
  field: InspectionField;
  zs: ZoneState;
  isFirstVisit: boolean;
  required: boolean;
  errorMessage?: string;
  onPatch: (patch: Partial<ZoneState>) => void;
  onSharedText: (key: string, value: string) => void;
}) {
  if (field.type === "measure") {
    return (
      <MeasureField
        zoneId={zoneId}
        field={field}
        zs={zs}
        required={required}
        errorMessage={errorMessage}
        onPatch={onPatch}
      />
    );
  }

  if (field.type === "tri") {
    const selected = zs.tri[field.key];
    return (
      <div className="border-b border-primary/10">
        <Row label={field.label} required={required}>
          <div className="flex gap-2">
            {(["g", "y", "r"] as TriValue[]).map((color) => (
              <button
                key={color}
                id={
                  color === "g"
                    ? `inspection-${zoneId}-${field.key}`
                    : undefined
                }
                type="button"
                aria-label={TRI_LABELS[color]}
                onClick={() =>
                  onPatch({ tri: { ...zs.tri, [field.key]: color } })
                }
                className={cn(
                  "h-7 w-7 rounded-full border-2 transition-transform active:scale-90",
                  selected === color
                    ? TRI_DOT[color]
                    : "border-primary/25 bg-transparent",
                )}
              />
            ))}
          </div>
        </Row>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  if (field.type === "descriptors") {
    const selected = zs.descriptors[field.key] ?? [];
    return (
      <div className="border-b border-primary/10 py-2">
        <div className="mb-1.5 text-[13px] text-foreground">
          {field.label}
          {required ? <span className="ml-1 text-red-500">*</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {field.options.map((option, index) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                id={
                  index === 0
                    ? `inspection-${zoneId}-${field.key}`
                    : undefined
                }
                type="button"
                onClick={() =>
                  onPatch({
                    descriptors: {
                      ...zs.descriptors,
                      [field.key]: active
                        ? selected.filter((value) => value !== option)
                        : [...selected, option],
                    },
                  })
                }
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-[12px] transition-colors",
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

  if (field.type === "select") {
    const value = zs.select[field.key] ?? "";
    return (
      <div className="border-b border-primary/10">
        <Row label={field.label} required={required}>
          <CompactSelect
            id={`inspection-${zoneId}-${field.key}`}
            ariaLabel={field.label}
            value={value}
            options={field.options}
            className="w-44"
            onChange={(next) =>
              onPatch({ select: { ...zs.select, [field.key]: next } })
            }
          />
        </Row>
        {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
      </div>
    );
  }

  const value = zs.text[field.key] ?? "";
  const options = optionsForInspectionField(field.key);
  const resolved = resolveInspectionOption(value, options);
  const selected = resolved
    ? resolved.value
    : value
      ? OTHER_INSPECTION_OPTION
      : "";
  const setText = (next: string) => {
    const normalized =
      field.key === "tire_size" && next !== OTHER_INSPECTION_OPTION
        ? normalizeTireSize(next)
        : next;
    if (field.key === "tire_brand" || field.key === "tire_model") {
      onPatch({ text: { ...zs.text, [field.key]: normalized } });
      return;
    }
    onSharedText(field.key, normalized);
  };
  return (
    <div className="border-b border-primary/10">
      <Row
        label={field.label}
        required={required}
        badge={field.firstVisitOnly && isFirstVisit ? "1ST" : undefined}
      >
        <div className="w-48 space-y-1.5">
          <Combobox
            id={`inspection-${zoneId}-${field.key}`}
            ariaLabel={field.label}
            ariaInvalid={!!errorMessage}
            value={selected}
            options={[
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
        </div>
      </Row>
      {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
    </div>
  );
}

function MeasureField({
  zoneId,
  field,
  zs,
  required,
  errorMessage,
  onPatch,
}: {
  zoneId: ZoneId;
  field: Extract<InspectionField, { type: "measure" }>;
  zs: ZoneState;
  required: boolean;
  errorMessage?: string;
  onPatch: (patch: Partial<ZoneState>) => void;
}) {
  const value = zs.measures[field.key] ?? "";
  const result = classifyInspectionMeasure(field, zs.measures, zs.select);

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
      onPatch({ measures });
    };
    return (
      <div className="border-b border-primary/10 py-2.5">
        <Row label={field.label} hint={field.hint} required={required}>
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
                {label}<span className="ml-0.5 text-red-500">*</span>
                <div className="mt-1 flex items-center gap-1">
                  <input
                    id={`inspection-${zoneId}-${key}`}
                    aria-invalid={!!errorMessage}
                    inputMode="numeric"
                    value={zs.measures[key] ?? ""}
                    onChange={(event) => updateDetailed(key, event.target.value)}
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
      <Row label={field.label} hint={hint} required={required}>
        <input
          id={`inspection-${zoneId}-${field.key}`}
          aria-invalid={!!errorMessage}
          inputMode="decimal"
          value={value}
          onChange={(event) =>
            onPatch({
              measures: {
                ...zs.measures,
                [field.key]: event.target.value,
              },
            })
          }
          className={cn(
            "rounded-lg border border-primary/20 bg-card px-1 py-1.5 text-center text-[14px] tabular-nums text-foreground focus:border-primary focus:outline-none",
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
              });
            }}
          />
        ) : (
          <span className="w-10 text-[11px] text-muted-foreground">
            {field.unit}
          </span>
        )}
        {field.classify ? <GradeTag result={result} /> : null}
      </Row>
      {errorMessage ? <InlineFieldError message={errorMessage} /> : null}
    </div>
  );
}

function GradeTag({
  result,
}: {
  result: { lvl: string; txt: string };
}) {
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
  return [];
}

function CompactSelect({
  id,
  ariaLabel,
  value,
  options,
  className,
  onChange,
}: {
  id?: string;
  ariaLabel: string;
  value: string;
  options: InspectionOption[];
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      selectedKey={value || null}
      onSelectionChange={(key) => onChange(key == null ? "" : String(key))}
      aria-label={ariaLabel}
      placeholder="—"
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
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  badge?: string;
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
          <span className="ml-1 text-[11px] text-muted-foreground">· {hint}</span>
        ) : null}
      </span>
      {children}
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
        <input
          type="date"
          value={expires}
          onChange={(e) => onExpires(e.target.value)}
          className="rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
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
                    Cosmetic only — recorded, but won&apos;t flag any future service.
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
                  <span className="font-semibold">Hidden on everything else.</span>
                </div>
              );
            })()}
          </div>
        </div>
      ) : null}
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
          <span className="ml-1 text-[11px] text-muted-foreground">· {question.hint}</span>
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
                    active ? arr.filter((v) => v !== opt.value) : [...arr, opt.value],
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
  recsSubmitted,
  onAddRecommendations,
  error,
}: {
  findings: { attention: { label: string; zone: string }[]; monitor: { label: string; zone: string }[] };
  totalLogged: number;
  vehicleLabel: string;
  downloading: boolean;
  onBack: () => void;
  onDownload: () => void;
  suggestions: ResolvedSuggestion[];
  canRecommend: boolean;
  recsBusy: boolean;
  recsSubmitted: boolean;
  onAddRecommendations: (keys: string[]) => void;
  error: string;
}) {
  // Default-select the urgent ("soon") suggestions; mechanic can toggle.
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(suggestions.map((s) => [s.key, s.urgency === "soon"])),
  );
  const selectedKeys = suggestions.filter((s) => selected[s.key]).map((s) => s.key);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div>
          <h3 className="text-[16px] font-semibold text-foreground">Inspection summary</h3>
          <p className="text-[12px] text-muted-foreground">{vehicleLabel}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat n={findings.attention.length} label="Needs attention" tone="text-red-600" />
        <Stat n={findings.monitor.length} label="Monitor" tone="text-amber-600" />
        <Stat n={totalLogged} label="Zones logged" tone="text-emerald-600" />
      </div>

      {findings.attention.length ? (
        <FindingList title="Needs attention" tone="text-red-600" dot="bg-red-500" items={findings.attention} />
      ) : null}
      {findings.monitor.length ? (
        <FindingList title="Monitor" tone="text-amber-600" dot="bg-amber-500" items={findings.monitor} />
      ) : null}

      {/* Suggested follow-ups derived from the measurements */}
      {suggestions.length ? (
        <div className="rounded-xl border border-primary/15 bg-primary/[0.03] p-3">
          <div className="mb-1 text-[12px] font-semibold text-foreground">
            Suggested follow-ups
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Derived from your measurements. Confirm to send to the customer&apos;s
            recommendations — attributed to this shop&apos;s inspection, and
            lowers their Vehicle Health Score until resolved.
          </p>
          {recsSubmitted ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[12px] font-medium text-emerald-700">
              ✓ Recommendations added.
            </p>
          ) : (
            <>
              <div className="space-y-1">
                {suggestions.map((s) => (
                  <label
                    key={s.key}
                    className="flex cursor-pointer items-start gap-2 border-b border-primary/10 py-2 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={!!selected[s.key]}
                      onChange={(e) =>
                        setSelected((prev) => ({ ...prev, [s.key]: e.target.checked }))
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
                        {s.reason} · {URGENCY_LABEL[s.urgency]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={!canRecommend || recsBusy || selectedKeys.length === 0}
                onClick={() => onAddRecommendations(selectedKeys)}
                className="mt-2 inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-card px-3 py-1.5 text-[12px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                {recsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Add {selectedKeys.length || ""} recommendation
                {selectedKeys.length === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
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
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download inspection sheet
        </button>
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="rounded-xl border border-primary/10 bg-card px-3 py-3">
      <div className={cn("text-[22px] font-semibold tabular-nums", tone)}>{n}</div>
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
        <div key={i} className="flex items-center gap-2 border-b border-primary/10 py-2 last:border-b-0">
          <span className={cn("h-3 w-3 rounded-full", dot)} />
          <span className="flex-1 text-[13px] text-foreground">{it.label}</span>
          <span className="text-[11px] text-muted-foreground">{it.zone}</span>
        </div>
      ))}
    </div>
  );
}
