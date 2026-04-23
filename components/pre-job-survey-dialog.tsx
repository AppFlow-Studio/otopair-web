"use client";

import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import {
  drawerInputClassName,
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
  drawerTextareaClassName,
} from "@/components/drawer-panel-styles";
import {
  passportSourceLabel,
  type PassportSource,
  type PreJobSurveyPayload,
  type TireCondition,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import { cn } from "@/lib/utils";

const surveyCardClassName =
  "rounded-[22px] border border-primary/10 bg-[rgba(255,255,255,0.78)] px-4 py-4 sm:px-5";

function ConditionButtons({
  value,
  onChange,
}: {
  value: TireCondition | null;
  onChange: (next: TireCondition) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {[
        { value: "good", label: "Good" },
        { value: "fair", label: "Fair" },
        { value: "replace_soon", label: "Replace soon" },
      ].map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value as TireCondition)}
            className={cn(
              "rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-primary/10 bg-white text-foreground hover:bg-primary/5"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default function PreJobSurveyDialog({
  open,
  bookingLabel,
  bookingSubLabel,
  passportData,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bookingLabel: string;
  bookingSubLabel: string;
  passportData: VehiclePassportData | null | undefined;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PreJobSurveyPayload) => Promise<void>;
}) {
  return (
    <PreJobSurveyDialogBody
      key={`${passportData?.vin ?? "no-vin"}-${bookingLabel}-${bookingSubLabel}`}
      open={open}
      bookingLabel={bookingLabel}
      bookingSubLabel={bookingSubLabel}
      passportData={passportData ?? null}
      isSubmitting={isSubmitting}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function PreJobSurveyDialogBody({
  open,
  bookingLabel,
  bookingSubLabel,
  passportData,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bookingLabel: string;
  bookingSubLabel: string;
  passportData: VehiclePassportData | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PreJobSurveyPayload) => Promise<void>;
}) {
  const [mileage, setMileage] = useState(
    typeof passportData?.passport.mileage === "number"
      ? String(Math.round(passportData.passport.mileage))
      : ""
  );
  const [tireBrand, setTireBrand] = useState(passportData?.passport.tires.brand ?? "");
  const [frontCondition, setFrontCondition] = useState<TireCondition | null>(
    passportData?.passport.tires.front_condition ?? null
  );
  const [rearCondition, setRearCondition] = useState<TireCondition | null>(
    passportData?.passport.tires.rear_condition ?? null
  );
  const [frontPadMm, setFrontPadMm] = useState(
    typeof passportData?.passport.brakes.front_pad_mm === "number"
      ? String(passportData.passport.brakes.front_pad_mm)
      : ""
  );
  const [rearPadMm, setRearPadMm] = useState(
    typeof passportData?.passport.brakes.rear_pad_mm === "number"
      ? String(passportData.passport.brakes.rear_pad_mm)
      : ""
  );
  const [rotorCondition, setRotorCondition] = useState(
    passportData?.passport.brakes.rotor_condition ?? ""
  );
  const [fluidsMatchOem, setFluidsMatchOem] = useState(true);
  const [oilViscosity, setOilViscosity] = useState(
    passportData?.passport.fluids.oil_viscosity ?? ""
  );
  const [oilType, setOilType] = useState(passportData?.passport.fluids.oil_type ?? "");
  const [coolantType, setCoolantType] = useState(
    passportData?.passport.fluids.coolant_type ?? ""
  );
  const [brakeFluidType, setBrakeFluidType] = useState(
    passportData?.passport.fluids.brake_fluid_type ?? ""
  );
  const [transmissionFluidType, setTransmissionFluidType] = useState(
    passportData?.passport.fluids.transmission_fluid_type ?? ""
  );
  const [inspectionLooksCurrent, setInspectionLooksCurrent] = useState<"" | "yes" | "no">(
    passportData?.passport.inspection.looks_current == null
      ? ""
      : passportData.passport.inspection.looks_current
        ? "yes"
        : "no"
  );
  const [inspectionExpiresAt, setInspectionExpiresAt] = useState(
    passportData?.passport.inspection.expires_at ?? ""
  );
  const [modificationsStatus, setModificationsStatus] = useState<
    "" | "none_observed" | "aftermarket_observed"
  >(passportData?.passport.modifications.status ?? "");
  const [modificationNotes, setModificationNotes] = useState(
    passportData?.passport.modifications.notes ?? ""
  );
  const [error, setError] = useState("");

  async function handleSubmit() {
    const parsedMileage = Number(mileage);
    if (!Number.isFinite(parsedMileage)) {
      setError("Mileage is required.");
      return;
    }
    if (!frontCondition || !rearCondition) {
      setError("Front and rear tire conditions are required.");
      return;
    }

    setError("");
    await onSubmit({
      mileage: parsedMileage,
      tire_brand: tireBrand.trim() || null,
      front_tire_condition: frontCondition,
      rear_tire_condition: rearCondition,
      brakes: {
        front_pad_mm: frontPadMm.trim() === "" ? null : Number(frontPadMm),
        rear_pad_mm: rearPadMm.trim() === "" ? null : Number(rearPadMm),
        rotor_condition:
          rotorCondition === ""
            ? null
            : (rotorCondition as "good" | "scored" | "needs_attention"),
      },
      fluids_match_oem: fluidsMatchOem,
      fluid_overrides: fluidsMatchOem
        ? null
        : {
            oil_viscosity: oilViscosity.trim() || null,
            oil_type: oilType.trim() || null,
            coolant_type: coolantType.trim() || null,
            brake_fluid_type: brakeFluidType.trim() || null,
            transmission_fluid_type: transmissionFluidType.trim() || null,
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
    });
  }

  return (
    <SurveyDialogShell
      open={open}
      title="Pre-job vehicle check"
      description="Confirm what you see on the vehicle before work begins."
      subtitle={
        <span>
          {bookingLabel} · {bookingSubLabel}
        </span>
      }
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          {error ? <p className="text-sm text-destructive sm:mr-auto">{error}</p> : null}
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={cn(drawerSecondaryButtonClassName, "rounded-xl border-primary/10")}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
            className={cn(drawerPrimaryButtonClassName, "rounded-xl")}
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Confirm vehicle specs and start job
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-[20px] border border-primary/10 bg-[rgba(17,24,28,0.03)] px-4 py-3">
          <p className="text-sm font-semibold text-foreground">{bookingLabel}</p>
          <p className="mt-1 text-sm text-muted-foreground">{bookingSubLabel}</p>
        </div>

        <QuestionCard
          eyebrow="Q1 · Mileage"
          badge="Required"
          accent="required"
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_190px] sm:items-center">
            <div>
              <p className="text-sm font-medium text-foreground">Odometer reading</p>
            </div>
            <input
              value={mileage}
              onChange={(event) => setMileage(event.target.value)}
              inputMode="numeric"
              placeholder="Enter mileage"
              className={fieldClassName()}
            />
          </div>
        </QuestionCard>

        <QuestionCard
          eyebrow="Q2 · Tire condition"
          badge="Required"
          accent="required"
        >
          <p className="text-xs font-medium text-muted-foreground">
            {passportData?.passport.tires.size_front ?? "Unknown size"}
            {passportData?.sources["tires.size_front"] ? (
              <>
                {" "}
                · {passportSourceLabel(passportData.sources["tires.size_front"])}
              </>
            ) : null}
          </p>
          <div className="mt-4 space-y-4">
            <TireConditionRow
              label="Front"
              value={frontCondition}
              onChange={setFrontCondition}
            />
            <TireConditionRow label="Rear" value={rearCondition} onChange={setRearCondition} />
          </div>
          <div className="mt-4 rounded-2xl border border-primary/10 bg-[rgba(17,24,28,0.02)] px-4 py-3">
            <p className="text-xs font-medium italic text-muted-foreground">
              First visit - what brand is on the car?
            </p>
            <input
              value={tireBrand}
              onChange={(event) => setTireBrand(event.target.value)}
              placeholder="e.g. Goodyear Wrangler"
              className={cn(fieldClassName(), "mt-3")}
            />
          </div>
        </QuestionCard>

        <QuestionCard eyebrow="Q3 · Brakes" badge="Optional - if on lift">
          <div className="grid gap-3 sm:grid-cols-2">
            <InlineField label="Front pad thickness">
              <input
                value={frontPadMm}
                onChange={(event) => setFrontPadMm(event.target.value)}
                placeholder="mm"
                className={fieldClassName()}
              />
            </InlineField>
            <InlineField label="Rear pad thickness">
              <input
                value={rearPadMm}
                onChange={(event) => setRearPadMm(event.target.value)}
                placeholder="mm"
                className={fieldClassName()}
              />
            </InlineField>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_190px] sm:items-center">
            <p className="text-sm font-medium text-foreground">Rotors overall</p>
            <select
              value={rotorCondition}
              onChange={(event) => setRotorCondition(event.target.value)}
              className={cn(fieldClassName(), "pr-10")}
            >
              <option value="">Select...</option>
              <option value="good">Good</option>
              <option value="scored">Scored</option>
              <option value="needs_attention">Needs attention</option>
            </select>
          </div>
        </QuestionCard>

        <QuestionCard eyebrow="Q4 · Fluids" badge="Confirm OEM" accent="info">
          <button
            type="button"
            onClick={() => setFluidsMatchOem((current) => !current)}
            className={cn(
              "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left text-sm font-medium transition-colors",
              fluidsMatchOem
                ? "border-success/20 bg-success/10 text-foreground"
                : "border-primary/10 bg-white text-foreground hover:bg-primary/5"
            )}
          >
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-md border",
                fluidsMatchOem
                  ? "border-success/20 bg-success text-success-foreground"
                  : "border-primary/10 bg-background"
              )}
            >
              {fluidsMatchOem ? <Check className="h-3.5 w-3.5" /> : null}
            </span>
            Fluid specs match OEM defaults - no changes
          </button>

          <div className="mt-4 space-y-2">
            <FluidRow
              label="Oil"
              value={`${passportData?.passport.fluids.oil_viscosity ?? "Unknown"} · ${passportData?.passport.fluids.oil_type ?? "Unknown"}`}
              badge={passportData?.sources["fluids.oil_viscosity"]}
            />
            <FluidRow
              label="Coolant"
              value={passportData?.passport.fluids.coolant_type ?? "Unknown"}
              badge={passportData?.sources["fluids.coolant_type"]}
            />
            <FluidRow
              label="Brake fluid"
              value={passportData?.passport.fluids.brake_fluid_type ?? "Unknown"}
              badge={passportData?.sources["fluids.brake_fluid_type"]}
            />
          </div>

          {!fluidsMatchOem ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <input
                value={oilViscosity}
                onChange={(event) => setOilViscosity(event.target.value)}
                placeholder="Oil viscosity"
                className={fieldClassName()}
              />
              <input
                value={oilType}
                onChange={(event) => setOilType(event.target.value)}
                placeholder="Oil type"
                className={fieldClassName()}
              />
              <input
                value={coolantType}
                onChange={(event) => setCoolantType(event.target.value)}
                placeholder="Coolant type"
                className={fieldClassName()}
              />
              <input
                value={brakeFluidType}
                onChange={(event) => setBrakeFluidType(event.target.value)}
                placeholder="Brake fluid"
                className={fieldClassName()}
              />
              <input
                value={transmissionFluidType}
                onChange={(event) => setTransmissionFluidType(event.target.value)}
                placeholder="Transmission fluid"
                className={cn(fieldClassName(), "sm:col-span-2")}
              />
            </div>
          ) : null}
        </QuestionCard>

        <QuestionCard eyebrow="Q5 · Inspection" badge="Optional">
          <div className="flex flex-wrap gap-2">
            {[
              { value: "yes", label: "Looks current" },
              { value: "no", label: "No / not visible" },
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
                    "rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-primary/10 bg-white text-foreground hover:bg-primary/5"
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_190px] sm:items-center">
            <p className="text-sm font-medium text-foreground">Expires approx.</p>
            <input
              type="month"
              value={inspectionExpiresAt}
              onChange={(event) => setInspectionExpiresAt(event.target.value)}
              className={fieldClassName()}
            />
          </div>
        </QuestionCard>

        <QuestionCard eyebrow="Q6 · Modifications" badge="Optional">
          <div className="grid gap-3 sm:grid-cols-[1fr_220px] sm:items-center">
            <p className="text-sm font-medium text-foreground">Aftermarket observed?</p>
            <select
              value={modificationsStatus}
              onChange={(event) =>
                setModificationsStatus(
                  event.target.value as "" | "none_observed" | "aftermarket_observed"
                )
              }
              className={cn(fieldClassName(), "pr-10")}
            >
              <option value="">No selection</option>
              <option value="none_observed">None observed</option>
              <option value="aftermarket_observed">Yes - see notes</option>
            </select>
          </div>
          {modificationsStatus === "aftermarket_observed" ? (
            <textarea
              value={modificationNotes}
              onChange={(event) => setModificationNotes(event.target.value)}
              placeholder="Describe what you observed."
              className={cn(
                drawerTextareaClassName,
                "mt-4 min-h-[112px] rounded-2xl border-primary/10 bg-white/92"
              )}
            />
          ) : null}
        </QuestionCard>
      </div>
    </SurveyDialogShell>
  );
}

function QuestionCard({
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
      ? "border-destructive/10 bg-destructive/10 text-destructive"
      : accent === "info"
        ? "border-primary/10 bg-primary/10 text-primary"
        : "border-primary/10 bg-white/85 text-muted-foreground";

  return (
    <section className={surveyCardClassName}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-primary/80">
          {eyebrow}
        </p>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", badgeClassName)}>
          {badge}
        </span>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TireConditionRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TireCondition | null;
  onChange: (next: TireCondition) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[64px_1fr] sm:items-center">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <ConditionButtons value={value} onChange={onChange} />
    </div>
  );
}

function InlineField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">{label}</p>
      {children}
    </div>
  );
}

function FluidRow({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: PassportSource;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-primary/10 bg-[rgba(17,24,28,0.02)] px-4 py-3">
      <span className="text-sm text-foreground/80">{label}</span>
      <span className="text-right text-sm font-semibold text-foreground">
        {value}
        {badge ? (
          <span className="ml-2 rounded-full border border-primary/10 bg-white px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {passportSourceLabel(badge)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function fieldClassName() {
  return cn(
    drawerInputClassName,
    "h-11 rounded-xl border border-primary/10 bg-white/92 shadow-none"
  );
}
