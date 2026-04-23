"use client";

import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import {
  passportSourceLabel,
  type PassportSource,
  type PreJobSurveyPayload,
  type TireCondition,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import { cn } from "@/lib/utils";

const conditionPalette: Record<
  TireCondition,
  { label: string; activeClassName: string }
> = {
  good: {
    label: "Good",
    activeClassName: "border-success/40 bg-success/10 text-success",
  },
  fair: {
    label: "Fair",
    activeClassName: "border-primary/40 bg-primary/10 text-primary",
  },
  replace_soon: {
    label: "Replace soon",
    activeClassName: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

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

function ConditionButtons({
  value,
  onChange,
}: {
  value: TireCondition | null;
  onChange: (next: TireCondition) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(conditionPalette) as TireCondition[]).map((key) => {
        const option = conditionPalette[key];
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
              active
                ? option.activeClassName
                : "border-primary/10 bg-muted/60 text-muted-foreground hover:bg-muted"
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

  const mileageError = mileage.trim() === "" && error !== "";
  const isFirstVisit = !!passportData && !passportData.is_complete;

  async function handleSubmit() {
    const parsedMileage = Number(mileage);
    if (!Number.isFinite(parsedMileage) || mileage.trim() === "") {
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

  const tireSizeLabel = passportData?.passport.tires.size_front ?? "Unknown size";
  const tireSizeSource = passportData?.sources["tires.size_front"];

  return (
    <SurveyDialogShell
      open={open}
      title="Pre-job vehicle check"
      headerBadge={
        isFirstVisit ? (
          <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
            First visit
          </span>
        ) : null
      }
      onClose={onClose}
      maxWidthClassName="max-w-lg"
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {error ? (
            <p className="text-[11px] font-medium text-destructive sm:mr-auto">{error}</p>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={cn(
              drawerSecondaryButtonClassName,
              "h-9 rounded-lg border-primary/10 text-[12px]"
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
            className={cn(drawerPrimaryButtonClassName, "h-9 rounded-lg text-[12px]")}
          >
            {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Confirm vehicle specs and start job
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <VehicleSummaryCard label={bookingLabel} subLabel={bookingSubLabel} />

        {isFirstVisit ? (
          <div className="rounded-lg border-l-2 border-primary bg-primary/5 px-3 py-2 text-[11px] leading-5 text-foreground/80">
            First visit — confirm what you see. Takes under 90 seconds.
          </div>
        ) : null}

        <div className="divide-y divide-primary/10">
          <SectionBlock eyebrow="Q1 · Mileage" badge="Required" accent="required">
            <FieldRow label="Odometer reading">
              <input
                value={mileage}
                onChange={(event) => setMileage(event.target.value)}
                inputMode="numeric"
                placeholder="Enter mileage"
                className={narrowField(mileageError)}
              />
            </FieldRow>
          </SectionBlock>

          <SectionBlock eyebrow="Q2 · Tire condition" badge="Required" accent="required">
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              {tireSizeLabel}
              {tireSizeSource ? (
                <>
                  <span className="mx-1.5 text-muted-foreground/50">·</span>
                  <span className="normal-case tracking-normal">
                    {passportSourceLabel(tireSizeSource)}
                  </span>
                </>
              ) : null}
            </p>
            <div className="mt-3 space-y-2">
              <TireConditionRow
                label="Front"
                value={frontCondition}
                onChange={setFrontCondition}
              />
              <TireConditionRow
                label="Rear"
                value={rearCondition}
                onChange={setRearCondition}
              />
            </div>
            <div className="mt-3 rounded-lg border border-primary/10 border-l-2 border-l-primary bg-muted/60 px-3 py-2.5">
              <p className="text-[10px] italic text-muted-foreground">
                First visit — what brand is on the car?
              </p>
              <input
                value={tireBrand}
                onChange={(event) => setTireBrand(event.target.value)}
                placeholder="e.g. Goodyear Wrangler"
                className={cn(baseField(), "mt-2 w-full text-left")}
              />
            </div>
          </SectionBlock>

          <SectionBlock
            eyebrow="Q3 · Brakes"
            badge="Optional — if on lift"
            accent="muted"
          >
            <FieldRow label="Front pad thickness">
              <div className="flex items-center gap-2">
                <input
                  value={frontPadMm}
                  onChange={(event) => setFrontPadMm(event.target.value)}
                  placeholder="mm"
                  inputMode="decimal"
                  className={cn(baseField(), "w-[90px] text-right")}
                />
                <span className="text-[10px] text-muted-foreground">
                  → system classifies
                </span>
              </div>
            </FieldRow>
            <FieldRow label="Rear pad thickness">
              <input
                value={rearPadMm}
                onChange={(event) => setRearPadMm(event.target.value)}
                placeholder="mm"
                inputMode="decimal"
                className={cn(baseField(), "w-[90px] text-right")}
              />
            </FieldRow>
            <FieldRow label="Rotors overall">
              <select
                value={rotorCondition}
                onChange={(event) => setRotorCondition(event.target.value)}
                className={cn(narrowField(), "pr-7")}
              >
                <option value="">Select...</option>
                <option value="good">Good</option>
                <option value="scored">Scored</option>
                <option value="needs_attention">Needs attention</option>
              </select>
            </FieldRow>
          </SectionBlock>

          <SectionBlock eyebrow="Q4 · Fluids" badge="Confirm OEM" accent="info">
            <button
              type="button"
              onClick={() => setFluidsMatchOem((current) => !current)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12px] font-medium transition-colors",
                fluidsMatchOem
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-primary/10 bg-muted/60 text-muted-foreground hover:bg-muted"
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                  fluidsMatchOem
                    ? "border-success bg-success text-success-foreground"
                    : "border-primary/25 bg-background"
                )}
              >
                {fluidsMatchOem ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
              </span>
              Fluid specs match OEM defaults — no changes
            </button>

            <div className="mt-3 space-y-1.5">
              <FluidRow
                label="Oil"
                value={`${passportData?.passport.fluids.oil_viscosity ?? "Unknown"} · ${
                  passportData?.passport.fluids.oil_type ?? "Unknown"
                }`}
                source={passportData?.sources["fluids.oil_viscosity"]}
              />
              <FluidRow
                label="Coolant"
                value={passportData?.passport.fluids.coolant_type ?? "Unknown"}
                source={passportData?.sources["fluids.coolant_type"]}
              />
              <FluidRow
                label="Brake fluid"
                value={passportData?.passport.fluids.brake_fluid_type ?? "Unknown"}
                source={passportData?.sources["fluids.brake_fluid_type"]}
              />
            </div>

            {!fluidsMatchOem ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input
                  value={oilViscosity}
                  onChange={(event) => setOilViscosity(event.target.value)}
                  placeholder="Oil viscosity"
                  className={cn(baseField(), "w-full text-left")}
                />
                <input
                  value={oilType}
                  onChange={(event) => setOilType(event.target.value)}
                  placeholder="Oil type"
                  className={cn(baseField(), "w-full text-left")}
                />
                <input
                  value={coolantType}
                  onChange={(event) => setCoolantType(event.target.value)}
                  placeholder="Coolant type"
                  className={cn(baseField(), "w-full text-left")}
                />
                <input
                  value={brakeFluidType}
                  onChange={(event) => setBrakeFluidType(event.target.value)}
                  placeholder="Brake fluid"
                  className={cn(baseField(), "w-full text-left")}
                />
                <input
                  value={transmissionFluidType}
                  onChange={(event) => setTransmissionFluidType(event.target.value)}
                  placeholder="Transmission fluid"
                  className={cn(baseField(), "w-full text-left sm:col-span-2")}
                />
              </div>
            ) : null}
          </SectionBlock>

          <SectionBlock eyebrow="Q5 · Inspection" badge="Optional" accent="muted">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[12px] text-muted-foreground">
                Sticker looks current?
              </span>
              <div className="flex flex-wrap gap-1.5">
                {[
                  {
                    value: "yes",
                    label: "Looks current",
                    active: "border-success/40 bg-success/10 text-success",
                  },
                  {
                    value: "no",
                    label: "No / not visible",
                    active: "border-primary/40 bg-primary/10 text-primary",
                  },
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
            </div>
            <div className="mt-3">
              <FieldRow label="Expires approx.">
                <input
                  type="month"
                  value={inspectionExpiresAt}
                  onChange={(event) => setInspectionExpiresAt(event.target.value)}
                  className={cn(baseField(), "w-[150px] text-right")}
                />
              </FieldRow>
            </div>
          </SectionBlock>

          <SectionBlock eyebrow="Q6 · Modifications" badge="Optional" accent="muted">
            <FieldRow label="Aftermarket observed?">
              <select
                value={modificationsStatus}
                onChange={(event) =>
                  setModificationsStatus(
                    event.target.value as "" | "none_observed" | "aftermarket_observed"
                  )
                }
                className={cn(narrowField(), "w-[170px] pr-7")}
              >
                <option value="">No selection</option>
                <option value="none_observed">None observed</option>
                <option value="aftermarket_observed">Yes — see notes</option>
              </select>
            </FieldRow>
            {modificationsStatus === "aftermarket_observed" ? (
              <textarea
                value={modificationNotes}
                onChange={(event) => setModificationNotes(event.target.value)}
                placeholder="Describe what you observed."
                className={cn(
                  baseField(),
                  "mt-3 min-h-[80px] w-full resize-y py-2 text-left"
                )}
              />
            ) : null}
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
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-14 shrink-0 text-[12px] font-medium text-muted-foreground">
        {label}
      </span>
      <ConditionButtons value={value} onChange={onChange} />
    </div>
  );
}

function FluidRow({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source?: PassportSource;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-1.5 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 text-right font-medium text-foreground">
        {value}
        {source ? (
          <span className="rounded-full border border-primary/10 bg-background px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {passportSourceLabel(source)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function baseField() {
  return "h-8 rounded-md border border-primary/15 bg-background px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-all focus:border-primary/40 focus:ring-2 focus:ring-primary/15";
}

function narrowField(isError?: boolean) {
  return cn(
    baseField(),
    "w-[140px] text-right",
    isError ? "border-destructive/50 focus:border-destructive/60 focus:ring-destructive/20" : null
  );
}
