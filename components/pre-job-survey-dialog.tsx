"use client";

import { useMemo, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import ConfirmationDialog from "@/components/confirmation-dialog";
import SurveyDialogShell from "@/components/survey-dialog-shell";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FirstVisitNotice, SourceBadge } from "@/components/vehicle-passport-section";
import {
  type PassportSource,
  type RotorCondition,
  type PreJobSurveyPayload,
  type TireCondition,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import { getBookingServiceFlags } from "@/lib/vehicle-service-relevance";
import { cn } from "@/lib/utils";

const conditionPalette: Record<
  TireCondition,
  { label: string; activeClassName: string }
> = {
  good: {
    label: "Good",
    activeClassName: "border-primary/40 bg-primary/10 text-primary",
  },
  fair: {
    label: "Fair",
    activeClassName: "border-primary/40 bg-primary/10 text-primary",
  },
  replace_soon: {
    label: "Replace soon",
    activeClassName: "border-primary/40 bg-primary/10 text-primary",
  },
};

const TIRE_SIZE_PATTERN = /^\d{3}\/\d{2}R\d{2}$/i;

type SubmitIntent = "close" | "start";

function keepDigitsOnly(value: string) {
  return value.replace(/\D+/g, "");
}

function keepNumericInput(value: string) {
  const normalized = value.replace(/[^0-9.]+/g, "");
  const [whole, ...rest] = normalized.split(".");
  return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

function normalizeTireSizeValue(value?: string | null) {
  return (value ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^0-9R/]/g, "");
}

function isValidTireSize(value: string) {
  return TIRE_SIZE_PATTERN.test(normalizeTireSizeValue(value));
}

function rotorConditionLabel(value: string) {
  if (value === "good") return "Good";
  if (value === "scored") return "Scored";
  if (value === "needs_attention") return "Needs attention";
  return "Select...";
}

function modificationStatusLabel(value: string) {
  if (value === "none_observed") return "None observed";
  if (value === "aftermarket_observed") return "Yes - see notes";
  return "Select...";
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

function hasPrefilledText(value?: string | null) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasPrefilledNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value);
}

function shouldRenderSourceBadge(source?: PassportSource) {
  return !!source && source !== "empty";
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
  bookingServices = [],
  passportData,
  prefillData,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices?: string[];
  passportData: VehiclePassportData | null | undefined;
  prefillData?: PreJobSurveyPayload | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PreJobSurveyPayload, action: SubmitIntent) => Promise<void>;
}) {
  return (
    <PreJobSurveyDialogBody
      key={`${passportData?.vin ?? "no-vin"}-${bookingLabel}-${bookingSubLabel}`}
      open={open}
      bookingLabel={bookingLabel}
      bookingSubLabel={bookingSubLabel}
      bookingServices={bookingServices}
      passportData={passportData ?? null}
      prefillData={prefillData ?? null}
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
  bookingServices,
  passportData,
  prefillData,
  isSubmitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  bookingLabel: string;
  bookingSubLabel: string;
  bookingServices: string[];
  passportData: VehiclePassportData | null;
  prefillData: PreJobSurveyPayload | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PreJobSurveyPayload, action: SubmitIntent) => Promise<void>;
}) {
  const serviceFlags = getBookingServiceFlags(bookingServices);

  const initialMileage =
    typeof prefillData?.mileage === "number" && Number.isFinite(prefillData.mileage)
      ? String(Math.round(prefillData.mileage))
      : typeof passportData?.passport.mileage === "number"
        ? String(Math.round(passportData.passport.mileage))
        : "";
  const initialFrontTireSize = normalizeTireSizeValue(
    prefillData?.tire_size_front ?? passportData?.passport.tires.size_front
  );
  const initialRearTireSize = normalizeTireSizeValue(
    prefillData?.tire_size_rear ??
      passportData?.passport.tires.size_rear ??
      passportData?.passport.tires.size_front
  );
  const initialRearMatchesFront =
    !initialRearTireSize || initialRearTireSize === initialFrontTireSize;
  const initialFrontPad =
    typeof prefillData?.brakes?.front_pad_mm === "number"
      ? String(prefillData.brakes.front_pad_mm)
      : typeof passportData?.passport.brakes.front_pad_mm === "number"
        ? String(passportData.passport.brakes.front_pad_mm)
        : "";
  const initialRearPad =
    typeof prefillData?.brakes?.rear_pad_mm === "number"
      ? String(prefillData.brakes.rear_pad_mm)
      : typeof passportData?.passport.brakes.rear_pad_mm === "number"
        ? String(passportData.passport.brakes.rear_pad_mm)
        : "";
  const initialOilCapacity =
    typeof prefillData?.fluid_overrides?.oil_capacity_qts === "number"
      ? String(prefillData.fluid_overrides.oil_capacity_qts)
      : typeof passportData?.passport.fluids.oil_capacity_qts === "number"
        ? String(passportData.passport.fluids.oil_capacity_qts)
        : "";

  const [mileage, setMileage] = useState(initialMileage);
  const [tireBrand, setTireBrand] = useState(
    prefillData?.tire_brand ?? passportData?.passport.tires.brand ?? ""
  );
  const [frontTireSize, setFrontTireSize] = useState(initialFrontTireSize);
  const [rearMatchesFront, setRearMatchesFront] = useState(initialRearMatchesFront);
  const [rearTireSize, setRearTireSize] = useState(
    initialRearMatchesFront ? initialFrontTireSize : initialRearTireSize
  );
  const [frontCondition, setFrontCondition] = useState<TireCondition | null>(
    prefillData?.front_tire_condition ?? passportData?.passport.tires.front_condition ?? null
  );
  const [rearCondition, setRearCondition] = useState<TireCondition | null>(
    prefillData?.rear_tire_condition ?? passportData?.passport.tires.rear_condition ?? null
  );
  const [frontPadMm, setFrontPadMm] = useState(initialFrontPad);
  const [rearPadMm, setRearPadMm] = useState(initialRearPad);
  const [rotorCondition, setRotorCondition] = useState<"" | RotorCondition>(
    prefillData?.brakes?.rotor_condition ??
      passportData?.passport.brakes.rotor_condition ??
      ""
  );
  const [oilViscosity, setOilViscosity] = useState(
    prefillData?.fluid_overrides?.oil_viscosity ??
      passportData?.passport.fluids.oil_viscosity ??
      ""
  );
  const [oilCapacity, setOilCapacity] = useState(initialOilCapacity);
  const [oilType, setOilType] = useState(
    prefillData?.fluid_overrides?.oil_type ?? passportData?.passport.fluids.oil_type ?? ""
  );
  const [coolantType, setCoolantType] = useState(
    prefillData?.fluid_overrides?.coolant_type ??
      passportData?.passport.fluids.coolant_type ??
      ""
  );
  const [brakeFluidType, setBrakeFluidType] = useState(
    prefillData?.fluid_overrides?.brake_fluid_type ??
      passportData?.passport.fluids.brake_fluid_type ??
      ""
  );
  const [transmissionFluidType, setTransmissionFluidType] = useState(
    prefillData?.fluid_overrides?.transmission_fluid_type ??
      passportData?.passport.fluids.transmission_fluid_type ??
      ""
  );
  const [inspectionLooksCurrent, setInspectionLooksCurrent] = useState<
    "" | "yes" | "no"
  >(
    prefillData?.inspection?.looks_current == null
      ? passportData?.passport.inspection.looks_current == null
        ? ""
        : passportData.passport.inspection.looks_current
          ? "yes"
          : "no"
      : prefillData.inspection.looks_current
        ? "yes"
        : "no"
  );
  const [inspectionExpiresAt, setInspectionExpiresAt] = useState(
    prefillData?.inspection?.expires_at ?? passportData?.passport.inspection.expires_at ?? ""
  );
  const [modificationsStatus, setModificationsStatus] = useState<
    "" | "none_observed" | "aftermarket_observed"
  >(
    prefillData?.modifications?.status ??
      passportData?.passport.modifications.status ??
      ""
  );
  const [modificationNotes, setModificationNotes] = useState(
    prefillData?.modifications?.notes ?? passportData?.passport.modifications.notes ?? ""
  );
  const [flaggedVehicleSpecs, setFlaggedVehicleSpecs] = useState(
    prefillData?.flagged_vehicle_specs ?? false
  );
  const [nextMechanicTip, setNextMechanicTip] = useState(
    prefillData?.next_mechanic_tip ?? ""
  );
  const [error, setError] = useState("");
  const [activeSubmitAction, setActiveSubmitAction] = useState<SubmitIntent | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const isFirstVisit = !!passportData && !passportData.is_complete;
  const frontSizeSource = passportData?.sources["tires.size_front"];
  const rearSizeSource = passportData?.sources["tires.size_rear"];

  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        mileage: initialMileage,
        tireBrand: prefillData?.tire_brand ?? passportData?.passport.tires.brand ?? "",
        frontTireSize: initialFrontTireSize,
        rearMatchesFront: initialRearMatchesFront,
        rearTireSize: initialRearMatchesFront ? initialFrontTireSize : initialRearTireSize,
        frontCondition:
          prefillData?.front_tire_condition ??
          passportData?.passport.tires.front_condition ??
          null,
        rearCondition:
          prefillData?.rear_tire_condition ??
          passportData?.passport.tires.rear_condition ??
          null,
        frontPadMm: initialFrontPad,
        rearPadMm: initialRearPad,
        rotorCondition:
          prefillData?.brakes?.rotor_condition ??
          passportData?.passport.brakes.rotor_condition ??
          "",
        oilViscosity:
          prefillData?.fluid_overrides?.oil_viscosity ??
          passportData?.passport.fluids.oil_viscosity ??
          "",
        oilCapacity: initialOilCapacity,
        oilType:
          prefillData?.fluid_overrides?.oil_type ??
          passportData?.passport.fluids.oil_type ??
          "",
        coolantType:
          prefillData?.fluid_overrides?.coolant_type ??
          passportData?.passport.fluids.coolant_type ??
          "",
        brakeFluidType:
          prefillData?.fluid_overrides?.brake_fluid_type ??
          passportData?.passport.fluids.brake_fluid_type ??
          "",
        transmissionFluidType:
          prefillData?.fluid_overrides?.transmission_fluid_type ??
          passportData?.passport.fluids.transmission_fluid_type ??
          "",
        inspectionLooksCurrent:
          prefillData?.inspection?.looks_current == null
            ? passportData?.passport.inspection.looks_current == null
              ? ""
              : passportData.passport.inspection.looks_current
                ? "yes"
                : "no"
            : prefillData.inspection.looks_current
              ? "yes"
              : "no",
        inspectionExpiresAt:
          prefillData?.inspection?.expires_at ??
          passportData?.passport.inspection.expires_at ??
          "",
        modificationsStatus:
          prefillData?.modifications?.status ??
          passportData?.passport.modifications.status ??
          "",
        modificationNotes:
          prefillData?.modifications?.notes ??
          passportData?.passport.modifications.notes ??
          "",
        flaggedVehicleSpecs: prefillData?.flagged_vehicle_specs ?? false,
        nextMechanicTip: prefillData?.next_mechanic_tip ?? "",
      }),
    [
      initialFrontPad,
      initialFrontTireSize,
      initialMileage,
      initialOilCapacity,
      initialRearMatchesFront,
      initialRearPad,
      initialRearTireSize,
      passportData,
      prefillData,
    ]
  );

  const currentSnapshot = JSON.stringify({
    mileage,
    tireBrand,
    frontTireSize,
    rearMatchesFront,
    rearTireSize,
    frontCondition,
    rearCondition,
    frontPadMm,
    rearPadMm,
    rotorCondition,
    oilViscosity,
    oilCapacity,
    oilType,
    coolantType,
    brakeFluidType,
    transmissionFluidType,
    inspectionLooksCurrent,
    inspectionExpiresAt,
    modificationsStatus,
    modificationNotes,
    flaggedVehicleSpecs,
    nextMechanicTip,
  });
  const hasUnsavedChanges = currentSnapshot !== initialSnapshot;

  function buildPayload(): PreJobSurveyPayload {
    const parsedMileage = mileage.trim() === "" ? null : Number(mileage);
    const normalizedFrontTireSize = normalizeTireSizeValue(frontTireSize);
    const normalizedRearTireSize = rearMatchesFront
      ? normalizedFrontTireSize
      : normalizeTireSizeValue(rearTireSize);
    const parsedOilCapacity =
      oilCapacity.trim() === "" ? null : Number(oilCapacity);

    return {
      mileage:
        typeof parsedMileage === "number" && Number.isFinite(parsedMileage)
          ? parsedMileage
          : null,
      tire_brand: tireBrand.trim() || null,
      tire_size_front: normalizedFrontTireSize || null,
      tire_size_rear: normalizedRearTireSize || null,
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
      fluids_match_oem: false,
      fluid_overrides: {
        oil_viscosity: oilViscosity.trim() || null,
        oil_capacity_qts:
          typeof parsedOilCapacity === "number" && Number.isFinite(parsedOilCapacity)
            ? parsedOilCapacity
            : null,
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
      flagged_vehicle_specs: flaggedVehicleSpecs,
      next_mechanic_tip: nextMechanicTip.trim() || null,
    };
  }

  function validateStartPayload(payload: PreJobSurveyPayload) {
    if (payload.mileage == null || !Number.isFinite(payload.mileage)) {
      throw new Error("Mileage is required.");
    }
    if (!payload.tire_brand?.trim()) {
      throw new Error("Tire brand is required.");
    }
    if (!payload.tire_size_front?.trim()) {
      throw new Error("Front tire size is required.");
    }
    if (!isValidTireSize(payload.tire_size_front)) {
      throw new Error("Front tire size must use the format 275/45R20.");
    }
    if (!payload.tire_size_rear?.trim()) {
      throw new Error("Rear tire size is required.");
    }
    if (!isValidTireSize(payload.tire_size_rear)) {
      throw new Error("Rear tire size must use the format 275/45R20.");
    }
    if (!payload.front_tire_condition || !payload.rear_tire_condition) {
      throw new Error("Front and rear tire conditions are required.");
    }
    if (serviceFlags.hasBrakeWork) {
      if (
        typeof payload.brakes?.front_pad_mm !== "number" ||
        !Number.isFinite(payload.brakes.front_pad_mm)
      ) {
        throw new Error("Front pad thickness is required for brake-related work.");
      }
      if (
        typeof payload.brakes?.rear_pad_mm !== "number" ||
        !Number.isFinite(payload.brakes.rear_pad_mm)
      ) {
        throw new Error("Rear pad thickness is required for brake-related work.");
      }
      if (!payload.brakes?.rotor_condition) {
        throw new Error("Rotor condition is required for brake-related work.");
      }
    }
    if (serviceFlags.hasOilChange) {
      if (!payload.fluid_overrides?.oil_viscosity?.trim()) {
        throw new Error("Oil viscosity is required for an oil change.");
      }
      if (!payload.fluid_overrides?.oil_type?.trim()) {
        throw new Error("Oil type is required for an oil change.");
      }
    }
  }

  function validateDraftPayload(payload: PreJobSurveyPayload) {
    if (payload.tire_size_front && !isValidTireSize(payload.tire_size_front)) {
      throw new Error("Front tire size must use the format 275/45R20.");
    }
    if (payload.tire_size_rear && !isValidTireSize(payload.tire_size_rear)) {
      throw new Error("Rear tire size must use the format 275/45R20.");
    }
  }

  async function handleSubmit(action: SubmitIntent) {
    const payload = buildPayload();

    try {
      if (action === "start") {
        validateStartPayload(payload);
      } else {
        validateDraftPayload(payload);
      }

      setError("");
      setActiveSubmitAction(action);
      await onSubmit(payload, action);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not save the pre-job vehicle check.";
      setError(message);
    } finally {
      setActiveSubmitAction(null);
    }
  }

  function requestClose() {
    if (isSubmitting) {
      return;
    }
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }

  const mileageError = mileage.trim() === "" && error !== "";

  return (
    <>
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
        onClose={requestClose}
        maxWidthClassName="max-w-lg"
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {error ? (
              <p className="text-[11px] font-medium text-destructive sm:mr-auto">{error}</p>
            ) : null}
            <button
              type="button"
              onClick={requestClose}
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
              onClick={() => void handleSubmit("close")}
              disabled={isSubmitting}
              className={cn(
                drawerSecondaryButtonClassName,
                "h-9 rounded-lg border-primary/10 text-[12px]"
              )}
            >
              {isSubmitting && activeSubmitAction === "close" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save and close
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit("start")}
              disabled={isSubmitting}
              className={cn(drawerPrimaryButtonClassName, "h-9 rounded-lg text-[12px]")}
            >
              {isSubmitting && activeSubmitAction === "start" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save and start job
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <VehicleSummaryCard label={bookingLabel} subLabel={bookingSubLabel} />

          {isFirstVisit ? (
            <FirstVisitNotice>
              <>
                <span className="font-semibold text-foreground">First time on Otopair.</span>{" "}
                The data you confirm here builds this vehicle&apos;s passport for the next
                mechanic.
              </>
            </FirstVisitNotice>
          ) : null}

          <div className="divide-y divide-primary/10">
            <SectionBlock eyebrow="Mileage">
              <FieldRow
                label={
                  <FieldLabelWithSource
                    text="Odometer reading"
                    required
                    source={passportData?.sources.mileage}
                    showSource={hasPrefilledNumber(passportData?.passport.mileage)}
                  />
                }
              >
                <input
                  value={mileage}
                  onChange={(event) => setMileage(keepDigitsOnly(event.target.value))}
                  inputMode="numeric"
                  placeholder="Enter mileage"
                  className={narrowField(mileageError)}
                />
              </FieldRow>
            </SectionBlock>

            <SectionBlock eyebrow="Tire condition" badge="Required" accent="required">
              <div className="space-y-2">
                <div className="rounded-lg border border-primary/10 bg-muted/40 px-3 py-2.5">
                  <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                    <button
                      type="button"
                      aria-pressed={rearMatchesFront}
                      onClick={() => {
                        const checked = !rearMatchesFront;
                        if (checked) {
                          setRearTireSize(frontTireSize);
                        }
                        setRearMatchesFront(checked);
                      }}
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                        rearMatchesFront
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-primary/25 bg-background text-transparent"
                      )}
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </button>
                    <span>Rear size is same as front</span>
                  </label>
                </div>
                <FieldRow
                  label={
                    <FieldLabelWithSource
                      text="Tire size (e.g. 275/45R20)"
                      required
                      source={frontSizeSource}
                      showSource={hasPrefilledText(passportData?.passport.tires.size_front)}
                    />
                  }
                >
                  <input
                    value={frontTireSize}
                    onChange={(event) =>
                      setFrontTireSize(normalizeTireSizeValue(event.target.value))
                    }
                    placeholder="275/45R20"
                    className={cn(baseField(), "w-full text-right sm:w-[160px]")}
                  />
                </FieldRow>
                {!rearMatchesFront ? (
                  <FieldRow
                    label={
                      <FieldLabelWithSource
                        text="Rear tire size (e.g. 275/45R20)"
                        required
                        source={rearSizeSource}
                        showSource={hasPrefilledText(passportData?.passport.tires.size_rear)}
                      />
                    }
                  >
                    <input
                      value={rearTireSize}
                      onChange={(event) =>
                        setRearTireSize(normalizeTireSizeValue(event.target.value))
                      }
                      placeholder="275/45R20"
                      className={cn(baseField(), "w-full text-right sm:w-[160px]")}
                    />
                  </FieldRow>
                ) : null}
                <TireConditionRow
                  label={<RequiredLabel text="Front" />}
                  value={frontCondition}
                  onChange={setFrontCondition}
                />
                <TireConditionRow
                  label={<RequiredLabel text="Rear" />}
                  value={rearCondition}
                  onChange={setRearCondition}
                />
                <FieldRow
                  label={
                    <FieldLabelWithSource
                      text="Tire brand"
                      required
                      source={passportData?.sources["tires.brand"]}
                      showSource={hasPrefilledText(passportData?.passport.tires.brand)}
                    />
                  }
                >
                  <input
                    value={tireBrand}
                    onChange={(event) => setTireBrand(event.target.value)}
                    placeholder="e.g. Goodyear Wrangler"
                    className={cn(baseField(), "w-full text-right sm:w-[160px]")}
                  />
                </FieldRow>
              </div>
            </SectionBlock>

            <SectionBlock
              eyebrow="Brakes"
              badge={serviceFlags.hasBrakeWork ? "Required" : "Optional"}
              accent={serviceFlags.hasBrakeWork ? "required" : "muted"}
            >
              <FieldRow
                label={
                  serviceFlags.hasBrakeWork ? (
                    <RequiredLabel text="Front pad thickness" />
                  ) : (
                    "Front pad thickness"
                  )
                }
              >
                <input
                  value={frontPadMm}
                  onChange={(event) => setFrontPadMm(keepNumericInput(event.target.value))}
                  placeholder="mm"
                  inputMode="decimal"
                  className={cn(baseField(), "w-[90px] text-right")}
                />
              </FieldRow>
              <FieldRow
                label={
                  serviceFlags.hasBrakeWork ? (
                    <RequiredLabel text="Rear pad thickness" />
                  ) : (
                    "Rear pad thickness"
                  )
                }
              >
                <input
                  value={rearPadMm}
                  onChange={(event) => setRearPadMm(keepNumericInput(event.target.value))}
                  placeholder="mm"
                  inputMode="decimal"
                  className={cn(baseField(), "w-[90px] text-right")}
                />
              </FieldRow>
              <FieldRow
                label={
                  serviceFlags.hasBrakeWork ? (
                    <RequiredLabel text="Rotor condition" />
                  ) : (
                    "Rotor condition"
                  )
                }
              >
                <Select
                  selectedKey={rotorCondition || "none"}
                  onSelectionChange={(key) =>
                    setRotorCondition(key === "none" ? "" : (String(key) as RotorCondition))
                  }
                >
                  <SelectTrigger className={cn(selectTriggerClassName, "w-[140px] justify-end")}>
                    <SelectValue>{rotorConditionLabel(rotorCondition)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopover className={selectPopoverClassName}>
                    <SelectListBox shouldFocusWrap className={selectListBoxClassName}>
                      <SelectItem id="none" textValue="Select..." className={selectItemClassName}>
                        Select...
                      </SelectItem>
                      <SelectItem id="good" textValue="Good" className={selectItemClassName}>
                        Good
                      </SelectItem>
                      <SelectItem id="scored" textValue="Scored" className={selectItemClassName}>
                        Scored
                      </SelectItem>
                      <SelectItem
                        id="needs_attention"
                        textValue="Needs attention"
                        className={selectItemClassName}
                      >
                        Needs attention
                      </SelectItem>
                    </SelectListBox>
                  </SelectPopover>
                </Select>
              </FieldRow>
            </SectionBlock>

            <SectionBlock eyebrow="Fluids" badge="Optional" accent="muted">
              <div className="grid gap-2 sm:grid-cols-2">
                <EditableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Oil viscosity"
                      required={serviceFlags.hasOilChange}
                      source={passportData?.sources["fluids.oil_viscosity"]}
                      showSource={hasPrefilledText(passportData?.passport.fluids.oil_viscosity)}
                    />
                  }
                  value={oilViscosity}
                  onChange={setOilViscosity}
                  placeholder="Oil viscosity"
                />
                <EditableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Oil capacity (qts)"
                      source={passportData?.sources["fluids.oil_capacity_qts"]}
                      showSource={hasPrefilledNumber(
                        passportData?.passport.fluids.oil_capacity_qts
                      )}
                    />
                  }
                  value={oilCapacity}
                  onChange={(value) => setOilCapacity(keepNumericInput(value))}
                  placeholder="Oil capacity"
                  inputMode="decimal"
                />
                <EditableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Oil type"
                      required={serviceFlags.hasOilChange}
                      source={passportData?.sources["fluids.oil_type"]}
                      showSource={hasPrefilledText(passportData?.passport.fluids.oil_type)}
                    />
                  }
                  value={oilType}
                  onChange={setOilType}
                  placeholder="Oil type"
                />
                <EditableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Coolant type"
                      source={passportData?.sources["fluids.coolant_type"]}
                      showSource={hasPrefilledText(passportData?.passport.fluids.coolant_type)}
                    />
                  }
                  value={coolantType}
                  onChange={setCoolantType}
                  placeholder="Coolant type"
                />
                <EditableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Brake fluid type"
                      source={passportData?.sources["fluids.brake_fluid_type"]}
                      showSource={hasPrefilledText(
                        passportData?.passport.fluids.brake_fluid_type
                      )}
                    />
                  }
                  value={brakeFluidType}
                  onChange={setBrakeFluidType}
                  placeholder="Brake fluid type"
                />
                <EditableFieldCard
                  label={
                    <FieldLabelWithSource
                      text="Transmission fluid type"
                      source={passportData?.sources["fluids.transmission_fluid_type"]}
                      showSource={hasPrefilledText(
                        passportData?.passport.fluids.transmission_fluid_type
                      )}
                    />
                  }
                  value={transmissionFluidType}
                  onChange={setTransmissionFluidType}
                  placeholder="Transmission fluid type"
                />
              </div>
            </SectionBlock>

            <SectionBlock eyebrow="Inspection" badge="Optional" accent="muted">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[12px] text-muted-foreground">Sticker looks current?</span>
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

            <SectionBlock eyebrow="Modifications" badge="Optional" accent="muted">
              <FieldRow label="Any aftermarket parts?">
                <Select
                  selectedKey={modificationsStatus || "none"}
                  onSelectionChange={(key) =>
                    setModificationsStatus(
                      key === "none"
                        ? ""
                        : (String(key) as "" | "none_observed" | "aftermarket_observed")
                    )
                  }
                >
                  <SelectTrigger className={cn(selectTriggerClassName, "w-[160px] justify-end")}>
                    <SelectValue>{modificationStatusLabel(modificationsStatus)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopover className={selectPopoverClassName}>
                    <SelectListBox shouldFocusWrap className={selectListBoxClassName}>
                      <SelectItem id="none" textValue="Select..." className={selectItemClassName}>
                        Select...
                      </SelectItem>
                      <SelectItem
                        id="none_observed"
                        textValue="None observed"
                        className={selectItemClassName}
                      >
                        None observed
                      </SelectItem>
                      <SelectItem
                        id="aftermarket_observed"
                        textValue="Yes - see notes"
                        className={selectItemClassName}
                      >
                        Yes - see notes
                      </SelectItem>
                    </SelectListBox>
                  </SelectPopover>
                </Select>
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

            <SectionBlock eyebrow="Review" badge="Optional" accent="muted">
              <label className="flex items-start gap-2 text-[12px] text-foreground">
                <button
                  type="button"
                  aria-pressed={flaggedVehicleSpecs}
                  onClick={() => setFlaggedVehicleSpecs((current) => !current)}
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                    flaggedVehicleSpecs
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-primary/25 bg-background text-transparent"
                  )}
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </button>
                <span>Something looks wrong with this vehicle&apos;s specs</span>
              </label>
              <textarea
                value={nextMechanicTip}
                onChange={(event) => setNextMechanicTip(event.target.value)}
                rows={2}
                placeholder="e.g., Drain plug stripped - use oversized gasket"
                className={cn(baseField(), "mt-3 min-h-[64px] w-full resize-y py-2 text-left")}
              />
            </SectionBlock>
          </div>
        </div>
      </SurveyDialogShell>

      <ConfirmationDialog
        open={showDiscardConfirm}
        title="Discard your changes?"
        onClose={() => setShowDiscardConfirm(false)}
        secondaryAction={{
          label: "Keep editing",
          onAction: () => setShowDiscardConfirm(false),
          variant: "outline",
        }}
        primaryAction={{
          label: "Discard",
          onAction: () => {
            setShowDiscardConfirm(false);
            onClose();
          },
          variant: "destructive",
        }}
      />
    </>
  );
}

const selectTriggerClassName =
  "bg-white h-8 rounded-md border-primary/15 px-2.5 text-[12px] text-foreground";
const selectPopoverClassName = "rounded-md";
const selectListBoxClassName = "p-1 text-[12px]";
const selectItemClassName = "min-h-0 rounded-sm px-2.5 py-1.5 text-[12px]";

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
  badge?: string;
  accent?: "required" | "muted";
  children: ReactNode;
}) {
  const badgeClassName =
    accent === "required"
      ? "border-primary/25 bg-primary/10 text-primary"
      : "border border-border bg-card text-muted-foreground";

  return (
    <section className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
          {eyebrow}
        </p>
        {badge ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
              badgeClassName
            )}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: ReactNode;
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
  label: ReactNode;
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

function RequiredLabel({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-destructive">*</span>
      <span>{text}</span>
    </span>
  );
}

function FieldLabelWithSource({
  text,
  required = false,
  source,
  showSource = false,
}: {
  text: string;
  required?: boolean;
  source?: PassportSource;
  showSource?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {required ? <span className="text-destructive">*</span> : null}
      <span>{text}</span>
      {showSource && shouldRenderSourceBadge(source) ? <SourceBadge source={source!} /> : null}
    </span>
  );
}

function EditableFieldCard({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <div className="rounded-lg border border-primary/10 bg-muted/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className={cn(baseField(), "w-full text-left")}
      />
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
