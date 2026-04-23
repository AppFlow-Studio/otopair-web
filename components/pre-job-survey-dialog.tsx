"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import {
  drawerInputClassName,
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
  drawerTextareaClassName,
  DrawerFieldLabel,
} from "@/components/drawer-panel-styles";
import {
  passportSourceLabel,
  type PassportSource,
  type PreJobSurveyPayload,
  type TireCondition,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";

function ConditionButtons({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TireCondition | null;
  onChange: (next: TireCondition) => void;
}) {
  return (
    <div className="space-y-2">
      <DrawerFieldLabel>{label}</DrawerFieldLabel>
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
          rotorCondition === "" ? null : (rotorCondition as "good" | "scored" | "needs_attention"),
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
          {bookingLabel} - {bookingSubLabel}
        </span>
      }
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          {error ? <p className="text-sm text-destructive sm:mr-auto">{error}</p> : null}
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={drawerSecondaryButtonClassName}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
            className={drawerPrimaryButtonClassName}
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Confirm vehicle specs and start job
          </button>
        </div>
      }
    >
      <div className="rounded-2xl border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium text-foreground">{bookingLabel}</p>
        <p className="mt-1 text-sm text-muted-foreground">{bookingSubLabel}</p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="space-y-4 rounded-2xl border border-border bg-background px-4 py-4">
          <div>
            <p className="text-[11px] font-bold tracking-widest text-primary">Q1 · Mileage</p>
            <DrawerFieldLabel className="mt-3">Odometer reading</DrawerFieldLabel>
            <input
              value={mileage}
              onChange={(event) => setMileage(event.target.value)}
              inputMode="numeric"
              placeholder="Enter mileage"
              className={drawerInputClassName}
            />
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              Q2 · Tire condition
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {passportData?.passport.tires.size_front ?? "Unknown size"}
              {passportData?.sources["tires.size_front"] ? (
                <>
                  {" "}
                  · {passportSourceLabel(passportData.sources["tires.size_front"])}
                </>
              ) : null}
            </p>
            <div className="mt-4 space-y-4">
              <ConditionButtons
                label="Front"
                value={frontCondition}
                onChange={setFrontCondition}
              />
              <ConditionButtons
                label="Rear"
                value={rearCondition}
                onChange={setRearCondition}
              />
              <div>
                <DrawerFieldLabel>Observed tire brand</DrawerFieldLabel>
                <input
                  value={tireBrand}
                  onChange={(event) => setTireBrand(event.target.value)}
                  placeholder="e.g. Goodyear Wrangler"
                  className={drawerInputClassName}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              Q3 · Brakes
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Optional if the car is already on the lift.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <DrawerFieldLabel>Front pad thickness</DrawerFieldLabel>
                <input
                  value={frontPadMm}
                  onChange={(event) => setFrontPadMm(event.target.value)}
                  placeholder="mm"
                  className={drawerInputClassName}
                />
              </div>
              <div>
                <DrawerFieldLabel>Rear pad thickness</DrawerFieldLabel>
                <input
                  value={rearPadMm}
                  onChange={(event) => setRearPadMm(event.target.value)}
                  placeholder="mm"
                  className={drawerInputClassName}
                />
              </div>
            </div>
            <div className="mt-3">
              <DrawerFieldLabel>Rotors overall</DrawerFieldLabel>
              <select
                value={rotorCondition}
                onChange={(event) => setRotorCondition(event.target.value)}
                className={`${drawerInputClassName} h-10`}
              >
                <option value="">Select...</option>
                <option value="good">Good</option>
                <option value="scored">Scored</option>
                <option value="needs_attention">Needs attention</option>
              </select>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-border bg-background px-4 py-4">
          <div>
            <p className="text-[11px] font-bold tracking-widest text-primary">Q4 · Fluids</p>
            <label className="mt-3 flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={fluidsMatchOem}
                onChange={(event) => setFluidsMatchOem(event.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Fluid specs match the stored defaults.
            </label>
            <div className="mt-4 space-y-3 text-sm">
              <FluidRow
                label="Oil"
                value={passportData?.passport.fluids.oil_viscosity ?? "Unknown"}
                badge={passportData?.sources["fluids.oil_viscosity"]}
              />
              <FluidRow
                label="Oil type"
                value={passportData?.passport.fluids.oil_type ?? "Unknown"}
                badge={passportData?.sources["fluids.oil_type"]}
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
              <div className="mt-4 grid gap-3">
                <input
                  value={oilViscosity}
                  onChange={(event) => setOilViscosity(event.target.value)}
                  placeholder="Oil viscosity"
                  className={drawerInputClassName}
                />
                <input
                  value={oilType}
                  onChange={(event) => setOilType(event.target.value)}
                  placeholder="Oil type"
                  className={drawerInputClassName}
                />
                <input
                  value={coolantType}
                  onChange={(event) => setCoolantType(event.target.value)}
                  placeholder="Coolant type"
                  className={drawerInputClassName}
                />
                <input
                  value={brakeFluidType}
                  onChange={(event) => setBrakeFluidType(event.target.value)}
                  placeholder="Brake fluid"
                  className={drawerInputClassName}
                />
                <input
                  value={transmissionFluidType}
                  onChange={(event) => setTransmissionFluidType(event.target.value)}
                  placeholder="Transmission fluid"
                  className={drawerInputClassName}
                />
              </div>
            ) : null}
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              Q5 · Inspection sticker
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {[
                { value: "yes", label: "Yes" },
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
            <div className="mt-3">
              <DrawerFieldLabel>Expires approx.</DrawerFieldLabel>
              <input
                type="month"
                value={inspectionExpiresAt}
                onChange={(event) => setInspectionExpiresAt(event.target.value)}
                className={drawerInputClassName}
              />
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-[11px] font-bold tracking-widest text-primary">
              Q6 · Modifications
            </p>
            <div className="mt-3">
              <DrawerFieldLabel>Aftermarket observed?</DrawerFieldLabel>
              <select
                value={modificationsStatus}
                onChange={(event) =>
                  setModificationsStatus(
                    event.target.value as "" | "none_observed" | "aftermarket_observed"
                  )
                }
                className={`${drawerInputClassName} h-10`}
              >
                <option value="">No selection</option>
                <option value="none_observed">None observed</option>
                <option value="aftermarket_observed">Yes - see notes</option>
              </select>
            </div>
            {modificationsStatus === "aftermarket_observed" ? (
              <div className="mt-3">
                <DrawerFieldLabel>Modification notes</DrawerFieldLabel>
                <textarea
                  value={modificationNotes}
                  onChange={(event) => setModificationNotes(event.target.value)}
                  placeholder="Describe what you observed."
                  className={drawerTextareaClassName}
                />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </SurveyDialogShell>
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
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">
        {value}
        {badge ? (
          <span className="ml-2 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {passportSourceLabel(badge)}
          </span>
        ) : null}
      </span>
    </div>
  );
}
