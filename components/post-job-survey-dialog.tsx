"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import {
  drawerInputClassName,
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
  drawerTextareaClassName,
  DrawerFieldLabel,
} from "@/components/drawer-panel-styles";
import {
  getVehicleUpdatePrompts,
  passportSourceLabel,
  serviceLikelyUsesParts,
  sumJobActualParts,
  type JobActualPartPayload,
  type PartsAccuracyStatus,
  type PostJobSurveyPayload,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";

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

function buildPartRows(parts: JobActualPartPayload[]) {
  return parts.map((part) => ({
    part_name: part.part_name,
    brand: part.brand ?? "",
    oem_number: part.oem_number,
    cost: Number.isFinite(part.cost) ? String(part.cost) : "",
  }));
}

export default function PostJobSurveyDialog({
  open,
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
      key={`${passportData?.vin ?? "no-vin"}-${bookingLabel}-${bookingSubLabel}-${prefillData?.serviceSlug ?? "no-service"}`}
      open={open}
      bookingLabel={bookingLabel}
      bookingSubLabel={bookingSubLabel}
      passportData={passportData ?? null}
      estimatedLaborMinutes={estimatedLaborMinutes}
      prefillData={prefillData}
      isSubmitting={isSubmitting}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function PostJobSurveyDialogBody({
  open,
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
  bookingLabel: string;
  bookingSubLabel: string;
  passportData: VehiclePassportData | null;
  estimatedLaborMinutes?: number | null;
  prefillData: PostJobPrefillData;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PostJobSurveyPayload) => Promise<void>;
}) {
  const serviceSlug = passportData?.service_slug ?? prefillData?.serviceSlug ?? null;
  const requiresParts = serviceLikelyUsesParts(
    serviceSlug,
    passportData?.requires_parts
  );
  const updatePrompts = useMemo(
    () => (passportData ? getVehicleUpdatePrompts(serviceSlug, passportData) : []),
    [passportData, serviceSlug]
  );
  const [completionMileage, setCompletionMileage] = useState(
    typeof passportData?.passport.mileage === "number"
      ? String(Math.round(passportData.passport.mileage))
      : ""
  );
  const [parts, setParts] = useState<PartRowState[]>(
    buildPartRows(prefillData?.suggestedParts ?? [])
  );
  const [vehicleUpdates, setVehicleUpdates] = useState<Record<string, string | boolean>>(
    Object.fromEntries(updatePrompts.map((prompt) => [prompt.key, prompt.value ?? ""]))
  );
  const [technicianNotes, setTechnicianNotes] = useState("");
  const [flaggedVehicleSpecs, setFlaggedVehicleSpecs] = useState(false);
  const [flaggedReason, setFlaggedReason] = useState("");
  const [actualLaborMinutes, setActualLaborMinutes] = useState(
    typeof estimatedLaborMinutes === "number" ? String(estimatedLaborMinutes) : ""
  );
  const [actualPartsCost, setActualPartsCost] = useState("");
  const [difficultyRating, setDifficultyRating] = useState("");
  const [partsAccuracyStatus, setPartsAccuracyStatus] =
    useState<PartsAccuracyStatus | null>(null);
  const [partsAccuracyFeedback, setPartsAccuracyFeedback] = useState("");
  const [additionalObservations, setAdditionalObservations] = useState("");
  const [error, setError] = useState("");

  function updatePart(index: number, next: Partial<PartRowState>) {
    setParts((current) =>
      current.map((part, partIndex) =>
        partIndex === index
          ? {
              ...part,
              ...next,
            }
          : part
      )
    );
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

  async function handleSubmit(skipOptionalSurvey: boolean) {
    const parsedMileage = Number(completionMileage);
    if (!Number.isFinite(parsedMileage)) {
      setError("Completion mileage is required.");
      return;
    }

    const normalizedParts = normalizeParts();
    if (requiresParts && normalizedParts.length === 0) {
      setError("At least one part row is required for this service.");
      return;
    }
    if (flaggedVehicleSpecs && flaggedReason.trim() === "") {
      setError("Please explain why the vehicle specs should be reviewed.");
      return;
    }
    if (partsAccuracyStatus === "different_parts" && partsAccuracyFeedback.trim() === "") {
      setError("Please note which parts were different.");
      return;
    }

    setError("");
    await onSubmit({
      completion_mileage: parsedMileage,
      parts_used: normalizedParts,
      vehicle_updates: Object.fromEntries(
        Object.entries(vehicleUpdates).map(([key, value]) => [key, value === "" ? null : value])
      ),
      technician_notes: technicianNotes.trim() || null,
      flagged_vehicle_specs: flaggedVehicleSpecs,
      flagged_vehicle_specs_reason: flaggedReason.trim() || null,
      actual_labor_minutes:
        skipOptionalSurvey || actualLaborMinutes.trim() === ""
          ? null
          : Number(actualLaborMinutes),
      actual_parts_cost:
        actualPartsCost.trim() === ""
          ? sumJobActualParts(normalizedParts)
          : Number(actualPartsCost),
      difficulty_rating:
        skipOptionalSurvey || difficultyRating.trim() === ""
          ? null
          : Number(difficultyRating),
      parts_accuracy_status: skipOptionalSurvey ? null : partsAccuracyStatus,
      parts_accuracy_feedback:
        skipOptionalSurvey ? null : partsAccuracyFeedback.trim() || null,
      additional_observations:
        skipOptionalSurvey ? null : additionalObservations.trim() || null,
      skip_optional_survey: skipOptionalSurvey,
    });
  }

  return (
    <SurveyDialogShell
      open={open}
      title="Job completion report"
      description="Close the job and capture the current vehicle state in one flow."
      subtitle={
        <span>
          {bookingLabel} - {bookingSubLabel}
        </span>
      }
      onClose={onClose}
      maxWidthClassName="max-w-4xl"
      footer={
        <div className="flex flex-col gap-3">
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => void handleSubmit(true)}
              disabled={isSubmitting}
              className={drawerSecondaryButtonClassName}
            >
              Skip survey and close job
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit(false)}
              disabled={isSubmitting}
              className={drawerPrimaryButtonClassName}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Submit report and close job
            </button>
          </div>
        </div>
      }
    >
      <div className="rounded-2xl border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium text-foreground">{bookingLabel}</p>
        <p className="mt-1 text-sm text-muted-foreground">{bookingSubLabel}</p>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="space-y-4 rounded-2xl border border-border bg-background px-4 py-4">
          <div className="flex items-center gap-2 border-b border-border pb-3">
            <p className="text-sm font-semibold text-foreground">Part A</p>
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
              Required
            </span>
          </div>

          <div>
            <p className="text-[11px] font-bold tracking-widest text-primary">
              PJ1 · Mileage at completion
            </p>
            <DrawerFieldLabel className="mt-3">Odometer</DrawerFieldLabel>
            <input
              value={completionMileage}
              onChange={(event) => setCompletionMileage(event.target.value)}
              inputMode="numeric"
              className={drawerInputClassName}
            />
          </div>

          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-bold tracking-widest text-primary">
                  PJ2 · Parts used
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {requiresParts ? "Required for this service." : "Optional for this service."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {prefillData?.suggestedParts?.length ? (
                  <button
                    type="button"
                    onClick={() => setParts(buildPartRows(prefillData.suggestedParts))}
                    className={drawerSecondaryButtonClassName}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Load suggested
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    setParts((current) => [
                      ...current,
                      { part_name: "", brand: "", oem_number: "", cost: "" },
                    ])
                  }
                  className={drawerSecondaryButtonClassName}
                >
                  <Plus className="h-4 w-4" />
                  Add part
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {parts.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No parts added yet.
                </p>
              ) : (
                parts.map((part, index) => (
                  <div
                    key={`${index}-${part.part_name}-${part.oem_number}`}
                    className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3 md:grid-cols-[1.2fr_1fr_1fr_0.8fr_auto]"
                  >
                    <input
                      value={part.part_name}
                      onChange={(event) =>
                        updatePart(index, { part_name: event.target.value })
                      }
                      placeholder="Part name"
                      className={drawerInputClassName}
                    />
                    <input
                      value={part.brand}
                      onChange={(event) =>
                        updatePart(index, { brand: event.target.value })
                      }
                      placeholder="Brand"
                      className={drawerInputClassName}
                    />
                    <input
                      value={part.oem_number}
                      onChange={(event) =>
                        updatePart(index, { oem_number: event.target.value })
                      }
                      placeholder="Part number"
                      className={drawerInputClassName}
                    />
                    <input
                      value={part.cost}
                      onChange={(event) =>
                        updatePart(index, { cost: event.target.value })
                      }
                      inputMode="decimal"
                      placeholder="Cost"
                      className={drawerInputClassName}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setParts((current) =>
                          current.filter((_, partIndex) => partIndex !== index)
                        )
                      }
                      className={drawerSecondaryButtonClassName}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              PJ3 · Update vehicle passport
            </p>
            <div className="mt-4 space-y-3">
              {updatePrompts.length === 0 ? (
                <p className="rounded-xl border border-border px-3 py-3 text-sm text-muted-foreground">
                  No context-specific passport updates suggested for this service.
                </p>
              ) : (
                updatePrompts.map((prompt) => (
                  <div
                    key={prompt.key}
                    className="rounded-xl border border-border bg-muted/20 px-3 py-3"
                  >
                    <DrawerFieldLabel>{prompt.label}</DrawerFieldLabel>
                    {typeof prompt.value === "boolean" ? (
                      <select
                        value={
                          vehicleUpdates[prompt.key] === true
                            ? "yes"
                            : vehicleUpdates[prompt.key] === false
                              ? "no"
                              : ""
                        }
                        onChange={(event) =>
                          setVehicleUpdates((current) => ({
                            ...current,
                            [prompt.key]:
                              event.target.value === ""
                                ? ""
                                : event.target.value === "yes",
                          }))
                        }
                        className={`${drawerInputClassName} h-10`}
                      >
                        <option value="">Not set</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    ) : (
                      <input
                        value={String(vehicleUpdates[prompt.key] ?? "")}
                        onChange={(event) =>
                          setVehicleUpdates((current) => ({
                            ...current,
                            [prompt.key]: event.target.value,
                          }))
                        }
                        className={drawerInputClassName}
                        placeholder="Optional"
                      />
                    )}
                    {prompt.source ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Current source: {passportSourceLabel(prompt.source)}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              PJ4 · Tip for next mechanic
            </p>
            <textarea
              value={technicianNotes}
              onChange={(event) => setTechnicianNotes(event.target.value)}
              placeholder='e.g. "Drain plug slightly worn" or "Customer prefers Mobil 1".'
              className={`${drawerTextareaClassName} mt-3`}
            />
          </div>

          <div className="border-t border-border pt-4">
            <label className="flex items-start gap-3 rounded-xl border border-border bg-muted/20 px-3 py-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={flaggedVehicleSpecs}
                onChange={(event) => setFlaggedVehicleSpecs(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span>Our vehicle specs may be incorrect for this car.</span>
            </label>
            {flaggedVehicleSpecs ? (
              <textarea
                value={flaggedReason}
                onChange={(event) => setFlaggedReason(event.target.value)}
                placeholder="Describe what appears incorrect."
                className={`${drawerTextareaClassName} mt-3`}
              />
            ) : null}
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-border bg-background px-4 py-4">
          <div className="flex items-center gap-2 border-b border-border pb-3">
            <p className="text-sm font-semibold text-foreground">Part B</p>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Optional
            </span>
          </div>

          <div>
            <p className="text-[11px] font-bold tracking-widest text-primary">
              OPT1 · Actual labor time
            </p>
            <DrawerFieldLabel className="mt-3">Minutes</DrawerFieldLabel>
            <input
              value={actualLaborMinutes}
              onChange={(event) => setActualLaborMinutes(event.target.value)}
              placeholder={estimatedLaborMinutes ? `Est. ${estimatedLaborMinutes}` : "Minutes"}
              className={drawerInputClassName}
            />
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              OPT2 · Difficulty rating
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                { value: "1", label: "1 Much easier" },
                { value: "2", label: "2" },
                { value: "3", label: "3 Normal" },
                { value: "4", label: "4" },
                { value: "5", label: "5 Much harder" },
              ].map((option) => {
                const active = difficultyRating === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setDifficultyRating(option.value)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:bg-muted"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              OPT3 · Parts accuracy
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                { value: "correct", label: "Yes - correct" },
                { value: "different_parts", label: "No - used different parts" },
              ].map((option) => {
                const active = partsAccuracyStatus === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      setPartsAccuracyStatus(option.value as PartsAccuracyStatus)
                    }
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:bg-muted"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {partsAccuracyStatus === "different_parts" ? (
              <textarea
                value={partsAccuracyFeedback}
                onChange={(event) => setPartsAccuracyFeedback(event.target.value)}
                placeholder="Note which parts differed."
                className={`${drawerTextareaClassName} mt-3`}
              />
            ) : null}
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              OPT4 · Additional observations
            </p>
            <textarea
              value={additionalObservations}
              onChange={(event) => setAdditionalObservations(event.target.value)}
              placeholder='e.g. "Recommend brake inspection at the next visit."'
              className={`${drawerTextareaClassName} mt-3`}
            />
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              Cost summary
            </p>
            <DrawerFieldLabel className="mt-3">Actual parts cost</DrawerFieldLabel>
            <input
              value={actualPartsCost}
              onChange={(event) => setActualPartsCost(event.target.value)}
              placeholder={String(sumJobActualParts(normalizeParts()))}
              className={drawerInputClassName}
            />
          </div>
        </section>
      </div>
    </SurveyDialogShell>
  );
}
