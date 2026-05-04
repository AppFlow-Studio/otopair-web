"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import SurveyDialogShell from "@/components/survey-dialog-shell";
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
  type PostJobSurveyPayload,
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

function buildPartRows(parts: JobActualPartPayload[]) {
  return parts.map((part) => ({
    part_name: part.part_name,
    brand: part.brand ?? "",
    oem_number: part.oem_number,
    cost: Number.isFinite(part.cost) ? String(part.cost) : "",
  }));
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
  const requiresParts = serviceLikelyUsesParts(serviceSlug, passportData?.requires_parts);
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
          ? sumJobActualParts(normalizeParts())
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

  const serviceLabel = prefillData?.serviceName ?? null;

  return (
    <SurveyDialogShell
      open={open}
      title="Job completion report"
      onClose={onClose}
      maxWidthClassName="max-w-xl"
      subtitle={
        <span>
          {bookingLabel} · {bookingSubLabel}
        </span>
      }
      footer={
        <div className="flex flex-col gap-2">
          {error ? (
            <p className="text-[11px] font-medium text-destructive">{error}</p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => void handleSubmit(true)}
              disabled={isSubmitting}
              className={cn(
                drawerSecondaryButtonClassName,
                "h-9 rounded-lg border-primary/10 text-[12px]"
              )}
            >
              Skip survey and close job
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit(false)}
              disabled={isSubmitting}
              className={cn(drawerPrimaryButtonClassName, "h-9 rounded-lg text-[12px]")}
            >
              {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Submit report and close job
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <VehicleSummaryCard label={bookingLabel} subLabel={bookingSubLabel} />

        {serviceLabel ? (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {serviceLabel} — relevant fields only
          </div>
        ) : null}

        <PartDivider label="Part A" badge="Required" accent="required">
          Close the job and capture the current vehicle state.
        </PartDivider>

        <div className="divide-y divide-primary/10">
          <SectionBlock
            eyebrow="PJ1 · Completion mileage"
            badge="Required"
            accent="required"
          >
            <FieldRow label="Odometer">
              <input
                value={completionMileage}
                onChange={(event) => setCompletionMileage(event.target.value)}
                inputMode="numeric"
                placeholder="Enter mileage"
                className={cn(baseField(), "w-[150px] text-right")}
              />
            </FieldRow>
          </SectionBlock>

          <SectionBlock
            eyebrow="PJ2 · Parts used"
            badge={requiresParts ? "Required" : "Optional"}
            accent={requiresParts ? "required" : "muted"}
          >
            <div className="flex flex-wrap gap-2">
              {prefillData?.suggestedParts?.length ? (
                <button
                  type="button"
                  onClick={() => setParts(buildPartRows(prefillData.suggestedParts))}
                  className="inline-flex items-center gap-1.5 rounded-md border border-primary/15 bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-primary/5"
                >
                  <RotateCcw className="h-3 w-3" />
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
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/15 bg-background px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/5"
              >
                <Plus className="h-3 w-3" />
                Add another part
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {parts.length === 0 ? (
                <p className="rounded-md border border-dashed border-primary/15 bg-muted/30 px-3 py-3 text-[11px] italic text-muted-foreground">
                  No parts added yet.
                </p>
              ) : (
                parts.map((part, index) => (
                  <div
                    key={`${index}-${part.part_name}-${part.oem_number}`}
                    className="rounded-lg bg-muted/60 px-3 py-2.5"
                  >
                    <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
                      <LabeledMicroInput
                        label="Part name"
                        value={part.part_name}
                        onChange={(value) => updatePart(index, { part_name: value })}
                      />
                      <LabeledMicroInput
                        label="Brand"
                        value={part.brand}
                        onChange={(value) => updatePart(index, { brand: value })}
                      />
                      <LabeledMicroInput
                        label="Part number"
                        value={part.oem_number}
                        onChange={(value) => updatePart(index, { oem_number: value })}
                      />
                      <LabeledMicroInput
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
                            current.filter((_, partIndex) => partIndex !== index)
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-destructive/5 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </SectionBlock>

          <SectionBlock
            eyebrow="PJ3 · Update vehicle ID"
            badge="Context-aware"
            accent="info"
          >
            {updatePrompts.length === 0 ? (
              <p className="rounded-md border border-dashed border-primary/15 bg-muted/30 px-3 py-3 text-[11px] italic text-muted-foreground">
                No context-specific passport updates suggested for this service.
              </p>
            ) : (
              <div className="space-y-2">
                {updatePrompts.map((prompt) => (
                  <div
                    key={prompt.key}
                    className="rounded-md border border-primary/15 bg-primary/5 px-3 py-2"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-foreground">
                          {prompt.label}
                        </p>
                        {prompt.source ? (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            Current source: {passportSourceLabel(prompt.source)}
                          </p>
                        ) : null}
                      </div>
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
                          className={cn(baseField(), "w-[160px] pr-7")}
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
                          className={cn(baseField(), "w-[180px] text-right")}
                          placeholder="Optional"
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionBlock>

          <SectionBlock eyebrow="PJ4 · Tip for next mechanic" badge="Optional">
            <textarea
              value={technicianNotes}
              onChange={(event) => setTechnicianNotes(event.target.value)}
              placeholder='e.g. "Drain plug slightly worn" · "Customer prefers Mobil 1" · "Check alignment next visit"'
              className={cn(baseField(), "min-h-[80px] w-full resize-y py-2 text-left")}
            />
          </SectionBlock>

          <SectionBlock eyebrow="PJ5 · Flag for review" badge="Optional">
            <label className="flex items-start gap-2.5 rounded-md bg-muted/60 px-3 py-2 text-[12px] text-foreground">
              <input
                type="checkbox"
                checked={flaggedVehicleSpecs}
                onChange={(event) => setFlaggedVehicleSpecs(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-primary"
              />
              <span>Our vehicle specs may be incorrect for this car.</span>
            </label>
            {flaggedVehicleSpecs ? (
              <textarea
                value={flaggedReason}
                onChange={(event) => setFlaggedReason(event.target.value)}
                placeholder="Describe what appears incorrect."
                className={cn(
                  baseField(),
                  "mt-3 min-h-[72px] w-full resize-y py-2 text-left"
                )}
              />
            ) : null}
          </SectionBlock>
        </div>

        <PartDivider label="Part B" badge="Optional" accent="muted">
          Optimization survey — helps Otopair improve estimates over time.
        </PartDivider>

        <div className="divide-y divide-primary/10">
          <SectionBlock eyebrow="OPT1 · Actual labor time" badge="Optional">
            <FieldRow label="How long did it take?">
              <div className="flex items-center gap-2">
                <input
                  value={actualLaborMinutes}
                  onChange={(event) => setActualLaborMinutes(event.target.value)}
                  placeholder="Minutes"
                  inputMode="numeric"
                  className={cn(baseField(), "w-[110px] text-right")}
                />
                {estimatedLaborMinutes ? (
                  <span className="text-[10px] text-muted-foreground">
                    Est. {estimatedLaborMinutes} min
                  </span>
                ) : null}
              </div>
            </FieldRow>
          </SectionBlock>

          <SectionBlock eyebrow="OPT2 · Difficulty rating" badge="Optional">
            <div className="flex flex-wrap gap-1.5">
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
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-primary/10 bg-muted/60 text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </SectionBlock>

          <SectionBlock eyebrow="OPT3 · Parts accuracy" badge="Optional">
            <div className="flex flex-wrap gap-1.5">
              {[
                {
                  value: "correct" as const,
                  label: "Yes — correct",
                  active: "border-success/40 bg-success/10 text-success",
                },
                {
                  value: "different_parts" as const,
                  label: "No — used different parts",
                  active: "border-destructive/40 bg-destructive/10 text-destructive",
                },
              ].map((option) => {
                const active = partsAccuracyStatus === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPartsAccuracyStatus(option.value)}
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
            {partsAccuracyStatus === "different_parts" ? (
              <textarea
                value={partsAccuracyFeedback}
                onChange={(event) => setPartsAccuracyFeedback(event.target.value)}
                placeholder="Note which parts differed."
                className={cn(
                  baseField(),
                  "mt-3 min-h-[72px] w-full resize-y py-2 text-left"
                )}
              />
            ) : null}
          </SectionBlock>

          <SectionBlock eyebrow="OPT4 · Additional observations" badge="Optional">
            <textarea
              value={additionalObservations}
              onChange={(event) => setAdditionalObservations(event.target.value)}
              placeholder='e.g. "Recommend brake inspection at the next visit."'
              className={cn(baseField(), "min-h-[80px] w-full resize-y py-2 text-left")}
            />
          </SectionBlock>

          <SectionBlock eyebrow="Cost summary" badge="Optional">
            <FieldRow label="Actual parts cost">
              <input
                value={actualPartsCost}
                onChange={(event) => setActualPartsCost(event.target.value)}
                placeholder={String(sumJobActualParts(normalizeParts()))}
                inputMode="decimal"
                className={cn(baseField(), "w-[140px] text-right")}
              />
            </FieldRow>
          </SectionBlock>
        </div>
      </div>
    </SurveyDialogShell>
  );
}

function VehicleSummaryCard({ label, subLabel }: { label: string; subLabel: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-[12px] font-semibold text-primary-foreground">
        {getInitials(label)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-foreground">{label}</p>
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{subLabel}</p>
      </div>
    </div>
  );
}

function PartDivider({
  label,
  badge,
  accent,
  children,
}: {
  label: string;
  badge: string;
  accent: "required" | "muted";
  children?: ReactNode;
}) {
  const badgeClassName =
    accent === "required"
      ? "border-destructive/25 bg-destructive/10 text-destructive"
      : "border-primary/10 bg-muted text-muted-foreground";

  return (
    <div className="flex items-center justify-between gap-3 border-t-2 border-primary/15 pt-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/80">
          {label}
        </p>
        {children ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">{children}</p>
        ) : null}
      </div>
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]",
          badgeClassName
        )}
      >
        {badge}
      </span>
    </div>
  );
}

function SectionBlock({
  eyebrow,
  badge,
  accent = "muted",
  children,
}: {
  eyebrow: string;
  badge: string;
  accent?: "required" | "info" | "muted";
  children: ReactNode;
}) {
  const badgeClassName =
    accent === "required"
      ? "border-destructive/25 bg-destructive/10 text-destructive"
      : accent === "info"
        ? "border-primary/20 bg-primary/10 text-primary"
        : "border-primary/10 bg-muted text-muted-foreground";

  return (
    <section className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
          {eyebrow}
        </p>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]",
            badgeClassName
          )}
        >
          {badge}
        </span>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-1.5 text-[12px] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

function LabeledMicroInput({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  inputMode?: "numeric" | "decimal" | "text";
}) {
  return (
    <div className="min-w-0">
      <label className="mb-0.5 block text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        className={cn(baseField(), "h-7 w-full text-left")}
      />
    </div>
  );
}

function baseField() {
  return "h-8 rounded-md border border-primary/15 bg-background px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-all focus:border-primary/40 focus:ring-2 focus:ring-primary/15";
}
