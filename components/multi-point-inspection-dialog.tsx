"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Camera, Download } from "lucide-react";
import { useMutation, useQuery, useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import { cn } from "@/lib/utils";
import {
  classify,
  createInspectionState,
  defaultZoneState,
  derivePrejobFromInspection,
  deriveSuggestedRecommendations,
  gatherFindings,
  getDirtyIncompleteZones,
  zoneHasInput,
  INSPECTION_ZONES,
  INSPECTION_ZONES_BY_ID,
  requiredZonesForBooking,
  TRI_LABELS,
  type InspectionField,
  type InspectionState,
  type TriValue,
  type ZoneId,
  type ZoneState,
} from "@/lib/inspection-template";
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
import type { AffectedSystem } from "@/lib/vehicle-mod-systems";

type SubmitIntent = "close" | "start";

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
  serviceId: string | null;
  serviceName: string | null;
};

const generateUploadUrlRef = makeFunctionReference<"mutation">(
  "bookings:generatePostjobPhotoUploadUrl",
);
const generateInspectionPdfRef = makeFunctionReference<"action">(
  "inspections_node:generateInspectionPdf",
);

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

// ---------------------------------------------------------------------------

export default function MultiPointInspectionDialog(props: {
  open: boolean;
  bookingId?: string | null;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices?: string[];
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
    bookingId ? { bookingId: bookingId as any } : "skip",
  );
  const ownerProfile = useQuery(
    api.inspections.getOwnerProfileForBooking,
    bookingId ? { bookingId: bookingId as any } : "skip",
  );
  const saveOwnerAnswers = useMutation(api.inspections.saveOwnerProfileAnswers);
  const submitInspectionRecs = useMutation(
    api.inspections.submitInspectionRecommendations,
  );
  const services = useQuery(api.services.list);
  const generateUploadUrl = useMutation(generateUploadUrlRef) as (args: {
    bookingId: string;
  }) => Promise<string>;
  const generateInspectionPdf = useAction(generateInspectionPdfRef) as (args: {
    bookingId: string;
  }) => Promise<{ url: string | null }>;

  // ---- state -------------------------------------------------------------
  const [state, setState] = useState<InspectionState>(() => createInspectionState());
  const [activeZone, setActiveZone] = useState<ZoneId | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  // Global header fields that don't belong to a single wheel.
  const [mileage, setMileage] = useState("");
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

  const requiredZones = useMemo(
    () => requiredZonesForBooking(bookingServices),
    [bookingServices],
  );
  const requiredSet = useMemo(() => new Set(requiredZones), [requiredZones]);

  const skippedOwnerQuestions = useMemo<OwnerQuestion[]>(
    () => (ownerProfile ? getSkippedOwnerQuestions(ownerProfile) : []),
    [ownerProfile],
  );

  // ---- hydrate from saved inspection or legacy prefill -------------------
  useEffect(() => {
    if (hydrated) return;
    // Wait for the saved-inspection query to resolve (undefined = loading).
    if (bookingId && savedInspection === undefined) return;

    const next = createInspectionState();

    if (savedInspection && Array.isArray(savedInspection.zones)) {
      for (const z of savedInspection.zones) {
        const id = z.zone_id as ZoneId;
        if (!INSPECTION_ZONES_BY_ID[id] || id === "OWNER") continue;
        next.zones[id] = {
          done: !!z.done,
          measures: { ...(z.measures ?? {}) },
          tri: { ...(z.tri ?? {}) },
          descriptors: { ...(z.descriptors ?? {}) },
          text: { ...(z.text ?? {}) },
          select: { ...(z.select ?? {}) },
          photoIds: Array.isArray(z.photo_ids) ? [...z.photo_ids] : [],
        };
      }
    } else {
      applyLegacyPrefill(next, prefillData, passportData);
    }

    setState(next);

    // Header fields from prefill / passport.
    const pf = prefillData;
    const baselineMileage =
      pf?.mileage ?? passportData?.passport.mileage ?? null;
    if (typeof baselineMileage === "number") setMileage(String(baselineMileage));
    if (pf?.inspection?.status) setInspectionStatus(pf.inspection.status);
    if (pf?.inspection?.expires_at) setInspectionExpires(pf.inspection.expires_at);
    if (
      pf?.modifications?.has_mods ??
      passportData?.passport.modifications.has_mods
    ) {
      setModAftermarket(true);
    }
    const seedNotes =
      pf?.modifications?.notes ?? passportData?.passport.modifications.notes;
    if (seedNotes) setModNotes(seedNotes);
    setModAffectedSystems(
      pf?.modifications?.affected_systems ??
        passportData?.passport.modifications.affected_systems ??
        []
    );
    if (pf?.next_mechanic_tip) setNextTip(pf.next_mechanic_tip);

    setHydrated(true);
  }, [hydrated, bookingId, savedInspection, prefillData, passportData]);

  // ---- helpers -----------------------------------------------------------
  const zoneState = useCallback(
    (id: ZoneId): ZoneState =>
      state.zones[id] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[id]),
    [state],
  );

  const patchZone = useCallback((id: ZoneId, patch: Partial<ZoneState>) => {
    setState((prev) => {
      const current =
        prev.zones[id] ?? defaultZoneState(INSPECTION_ZONES_BY_ID[id]);
      return {
        ...prev,
        zones: { ...prev.zones, [id]: { ...current, ...patch } },
      };
    });
  }, []);

  const doneCount = useMemo(
    () => requiredZones.filter((id) => state.zones[id]?.done).length,
    [requiredZones, state],
  );
  const allRequiredDone = doneCount >= requiredZones.length;

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
      const found = (services ?? []).find((svc: any) =>
        svc.slug ? s.match.includes(svc.slug) : false,
      );
      return {
        ...s,
        serviceId: found ? String((found as any)._id) : null,
        serviceName: found ? (found as any).name : null,
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
      modifications: {
        has_mods: modAftermarket,
        notes: modAftermarket ? modNotes.trim() || null : null,
        affected_systems: modAftermarket ? modAffectedSystems : [],
      },
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
    if (!bookingId) return;
    const answers: Record<string, OwnerProfileAnswerValue> = {};
    for (const q of skippedOwnerQuestions) {
      const a = ownerAnswers[q.key];
      if (a != null) answers[q.key] = a;
    }
    if (Object.keys(answers).length === 0) return;
    try {
      await saveOwnerAnswers({ bookingId: bookingId as any, answers });
    } catch {
      // best-effort; never blocks the inspection
    }
  }, [bookingId, skippedOwnerQuestions, ownerAnswers, saveOwnerAnswers]);

  async function handleSubmit(action: SubmitIntent) {
    setError("");
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
      return;
    }
    if (action === "start" && !mileage.trim()) {
      setError("Odometer reading is required to start the job.");
      setActiveZone(null);
      return;
    }
    await persistOwnerAnswers();
    const { prejob, inspection } = buildPayloads();
    try {
      await onSubmit(prejob, inspection, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save inspection.");
    }
  }

  async function handleDownloadPdf() {
    if (!bookingId) return;
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
      setError(err instanceof Error ? err.message : "Could not generate the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  async function handleAddRecommendations(keys: string[]) {
    if (!bookingId || keys.length === 0) return;
    setRecsBusy(true);
    setError("");
    try {
      // Persist the inspection first so a job_actual exists to attribute recs to.
      await persistOwnerAnswers();
      const { prejob, inspection } = buildPayloads();
      if (onSaveDraft) await onSaveDraft(prejob, inspection);
      const chosen = suggestedRecs.filter((s) => keys.includes(s.key));
      const recommendations = chosen.map((s) => ({
        recommended_service_id: s.serviceId ? (s.serviceId as any) : null,
        freeform_service_name: s.serviceId ? null : s.label,
        urgency: s.urgency,
        reason: s.reason,
        visible_to_driver: true,
      }));
      await submitInspectionRecs({
        bookingId: bookingId as any,
        recommendations: recommendations as any,
      });
      setRecsSubmitted(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not add recommendations.",
      );
    } finally {
      setRecsBusy(false);
    }
  }

  async function handlePhotoUpload(id: ZoneId, file: File) {
    if (!bookingId) return;
    try {
      const url = await generateUploadUrl({ bookingId });
      const result = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!result.ok) throw new Error("Upload failed");
      const { storageId } = (await result.json()) as { storageId?: string };
      if (!storageId) throw new Error("Upload did not return an id");
      const zs = zoneState(id);
      patchZone(id, { photoIds: [...zs.photoIds, storageId] });
    } catch {
      setError("Photo upload failed. Try again.");
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
          disabled={isSubmitting || !allRequiredDone}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Submit → Vehicle Health
        </button>
      </div>
    </div>
  );

  return (
    <SurveyDialogShell
      open={open}
      onClose={onClose}
      title="Multi-point inspection"
      description={bookingSubLabel}
      maxWidthClassName="max-w-2xl"
      mobileFullBleed
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
      ) : (
        <div className="space-y-4">
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
                Odometer
              </div>
              <div className="mt-0.5 flex items-baseline gap-1">
                <input
                  inputMode="numeric"
                  value={mileage}
                  onChange={(e) => setMileage(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="—"
                  className="w-24 rounded-lg border border-primary/20 bg-card px-2 py-1 text-[14px] tabular-nums text-foreground focus:border-primary focus:outline-none"
                />
                <span className="text-[11px] text-muted-foreground">mi</span>
              </div>
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
          <div className="rounded-xl border border-primary/10 bg-card p-4">
            {activeZone == null ? (
              <p className="py-8 text-center text-[13px] text-muted-foreground">
                Tap a wheel or body zone on the car to begin.
              </p>
            ) : activeZone === "OWNER" ? (
              <OwnerZone
                questions={skippedOwnerQuestions}
                answers={ownerAnswers}
                loading={ownerProfile === undefined}
                onChange={(key, value) =>
                  setOwnerAnswers((prev) => ({ ...prev, [key]: value }))
                }
              />
            ) : (
              <ZonePanel
                zoneId={activeZone}
                zs={zoneState(activeZone)}
                isFirstVisit={isFirstVisit}
                isRequired={requiredSet.has(activeZone)}
                canPhoto={!!bookingId}
                extraHeader={
                  activeZone === "FRT" ? (
                    <InspectionStickerFields
                      status={inspectionStatus}
                      expires={inspectionExpires}
                      aftermarket={modAftermarket}
                      notes={modNotes}
                      onStatus={setInspectionStatus}
                      onExpires={setInspectionExpires}
                      onAftermarket={setModAftermarket}
                      onNotes={setModNotes}
                    />
                  ) : null
                }
                onPatch={(patch) => patchZone(activeZone, patch)}
                onPhoto={(file) => handlePhotoUpload(activeZone, file)}
                onToggleDone={() =>
                  patchZone(activeZone, { done: !zoneState(activeZone).done })
                }
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
        </div>
      )}
    </SurveyDialogShell>
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
  canPhoto,
  extraHeader,
  onPatch,
  onPhoto,
  onToggleDone,
}: {
  zoneId: ZoneId;
  zs: ZoneState;
  isFirstVisit: boolean;
  isRequired: boolean;
  canPhoto: boolean;
  extraHeader?: React.ReactNode;
  onPatch: (patch: Partial<ZoneState>) => void;
  onPhoto: (file: File) => void;
  onToggleDone: () => void;
}) {
  const zone = INSPECTION_ZONES_BY_ID[zoneId];
  return (
    <div className="space-y-1">
      <div className="mb-2 flex items-center justify-between">
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
        {zs.done ? (
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600">
            <Check className="h-3.5 w-3.5" /> saved
          </span>
        ) : null}
      </div>

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
              field={field}
              zs={zs}
              isFirstVisit={isFirstVisit}
              onPatch={onPatch}
            />
          </div>
        );
      })}

      {extraHeader}

      {!zs.done && zoneHasInput(zoneId, zs) ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          You&apos;ve entered readings here — tap{" "}
          <span className="font-semibold">Mark zone complete</span> so they count
          toward findings &amp; recommendations.
        </p>
      ) : null}

      <div className="flex items-center gap-2 pt-3">
        {canPhoto ? (
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-primary/20 px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-primary/5">
            <Camera className="h-3.5 w-3.5" />
            {zs.photoIds.length ? `Photo ✓ (${zs.photoIds.length})` : "Add photo"}
            <input
              type="file"
              accept="image/*"
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
          {zs.done ? "Zone saved ✓" : "Mark zone complete"}
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  field,
  zs,
  isFirstVisit,
  onPatch,
}: {
  field: InspectionField;
  zs: ZoneState;
  isFirstVisit: boolean;
  onPatch: (patch: Partial<ZoneState>) => void;
}) {
  if (field.type === "measure") {
    const value = zs.measures[field.key] ?? "";
    const res = classify(field.classify, value, field.ref);
    return (
      <Row
        label={field.label}
        hint={field.hint}
        required={field.required}
      >
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) =>
            onPatch({ measures: { ...zs.measures, [field.key]: e.target.value } })
          }
          className="w-16 rounded-lg border border-primary/20 bg-card px-1 py-1.5 text-center text-[14px] tabular-nums text-foreground focus:border-primary focus:outline-none"
        />
        <span className="w-10 text-[11px] text-muted-foreground">{field.unit}</span>
        {field.classify ? (
          <span
            className={cn(
              "min-w-[64px] rounded-md border px-2 py-1 text-center text-[11px] font-semibold",
              GRADE_TAG[res.lvl],
            )}
          >
            {res.txt}
          </span>
        ) : null}
      </Row>
    );
  }

  if (field.type === "tri") {
    const sel = zs.tri[field.key];
    return (
      <Row label={field.label}>
        <div className="flex gap-2">
          {(["g", "y", "r"] as TriValue[]).map((c) => (
            <button
              key={c}
              type="button"
              aria-label={TRI_LABELS[c]}
              onClick={() => onPatch({ tri: { ...zs.tri, [field.key]: c } })}
              className={cn(
                "h-7 w-7 rounded-full border-2 transition-transform active:scale-90",
                sel === c ? TRI_DOT[c] : "border-primary/25 bg-transparent",
              )}
            />
          ))}
        </div>
      </Row>
    );
  }

  if (field.type === "descriptors") {
    const on = zs.descriptors[field.key] ?? [];
    return (
      <div className="border-b border-primary/10 py-2">
        <div className="mb-1.5 text-[13px] text-foreground">{field.label}</div>
        <div className="flex flex-wrap gap-2">
          {field.options.map((opt) => {
            const active = on.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  const next = active ? on.filter((o) => o !== opt) : [...on, opt];
                  onPatch({ descriptors: { ...zs.descriptors, [field.key]: next } });
                }}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-[12px] transition-colors",
                  active
                    ? "border-amber-400 bg-amber-50 font-semibold text-amber-700"
                    : "border-primary/20 bg-card text-muted-foreground hover:bg-primary/5",
                )}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === "select") {
    const value = zs.select[field.key] ?? "";
    return (
      <Row label={field.label}>
        <select
          value={value}
          onChange={(e) =>
            onPatch({ select: { ...zs.select, [field.key]: e.target.value } })
          }
          className="w-44 rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
        >
          <option value="">—</option>
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Row>
    );
  }

  // text
  const value = zs.text[field.key] ?? "";
  return (
    <Row
      label={field.label}
      badge={field.firstVisitOnly && isFirstVisit ? "1ST" : undefined}
    >
      <input
        value={value}
        onChange={(e) => onPatch({ text: { ...zs.text, [field.key]: e.target.value } })}
        className="w-40 rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
      />
    </Row>
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
  aftermarket,
  notes,
  onStatus,
  onExpires,
  onAftermarket,
  onNotes,
}: {
  status: InspectionStatus | "";
  expires: string;
  aftermarket: boolean;
  notes: string;
  onStatus: (s: InspectionStatus | "") => void;
  onExpires: (s: string) => void;
  onAftermarket: (b: boolean) => void;
  onNotes: (s: string) => void;
}) {
  return (
    <div className="mt-3 space-y-1 rounded-lg bg-primary/[0.03] p-3">
      <Row label="Inspection sticker">
        <select
          value={status}
          onChange={(e) => onStatus(e.target.value as InspectionStatus | "")}
          className="w-36 rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
        >
          <option value="">—</option>
          {INSPECTION_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Expires">
        <input
          type="date"
          value={expires}
          onChange={(e) => onExpires(e.target.value)}
          className="rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
        />
      </Row>
      <Row label="Aftermarket modifications observed">
        <input
          type="checkbox"
          checked={aftermarket}
          onChange={(e) => onAftermarket(e.target.checked)}
          className="h-4 w-4 accent-[var(--primary)]"
        />
      </Row>
      {aftermarket ? (
        <input
          value={notes}
          onChange={(e) => onNotes(e.target.value)}
          placeholder="Modification notes"
          className="mt-1 w-full rounded-lg border border-primary/20 bg-card px-2 py-1.5 text-[13px] text-foreground focus:border-primary focus:outline-none"
        />
      ) : null}
    </div>
  );
}

function OwnerZone({
  questions,
  answers,
  loading,
  onChange,
}: {
  questions: OwnerQuestion[];
  answers: Record<string, OwnerProfileAnswerValue>;
  loading: boolean;
  onChange: (key: string, value: OwnerProfileAnswerValue) => void;
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
      <div className="mb-2">
        <h4 className="text-[15px] font-semibold text-foreground">Owner profile</h4>
        <p className="text-[11px] text-muted-foreground">
          {questions.length === 0
            ? "The customer answered everything during onboarding — nothing to fill in."
            : "Questions the customer skipped during onboarding. Fill in what you can observe or ask."}
        </p>
      </div>
      {questions.map((q) => (
        <OwnerQuestionRow
          key={q.key}
          question={q}
          value={answers[q.key] ?? null}
          onChange={(value) => onChange(q.key, value)}
        />
      ))}
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

// ---------------------------------------------------------------------------
// Legacy prefill — seed corner/engine zones from the last PreJobSurveyPayload
// or passport so non-first-visit jobs don't start blank (and validation passes).
// ---------------------------------------------------------------------------

function applyLegacyPrefill(
  state: InspectionState,
  prefill: PreJobSurveyPayload | null | undefined,
  passport: VehiclePassportData | null | undefined,
) {
  const tires = passport?.passport.tires;
  const brakes = prefill?.brakes ?? passport?.passport.brakes;
  const fluids = prefill?.fluid_overrides ?? passport?.passport.fluids;

  const setText = (id: ZoneId, key: string, value: unknown) => {
    if (typeof value === "string" && value.trim() && state.zones[id]) {
      state.zones[id]!.text[key] = value;
    }
  };
  const setMeasure = (id: ZoneId, key: string, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && state.zones[id]) {
      state.zones[id]!.measures[key] = String(value);
    }
  };
  const setSelect = (key: string, value: unknown) => {
    if (typeof value === "string" && value.trim() && state.zones.ENG) {
      state.zones.ENG.select[key] = value;
    }
  };

  setText("FL", "tire_brand", prefill?.tire_brand ?? tires?.brand);
  setText("FL", "tire_model", tires?.model);
  setText("FL", "tire_size", prefill?.tire_size_front ?? tires?.size_front);
  setText("RL", "tire_size", prefill?.tire_size_rear ?? tires?.size_rear);
  setText("FL", "pad_brand", brakes?.pad_brand);

  setMeasure("FL", "pad", brakes?.front_pad_mm);
  setMeasure("FR", "pad", brakes?.front_pad_mm);
  setMeasure("RL", "pad", brakes?.rear_pad_mm);
  setMeasure("RR", "pad", brakes?.rear_pad_mm);

  setSelect("oil_viscosity", fluids?.oil_viscosity);
  setSelect("oil_type", fluids?.oil_type);
  setSelect("coolant_type", fluids?.coolant_type);
  setSelect("brake_fluid_type", fluids?.brake_fluid_type);
  setSelect("transmission_fluid_type", fluids?.transmission_fluid_type);
}
