"use client";

import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
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
import {
  passportSourceLabel,
  shouldShowPassportSourceBadge,
  type PassportSource,
  type RotorCondition,
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

function keepDigitsOnly(value: string) {
  return value.replace(/\D+/g, "");
}

function keepNumericInput(value: string) {
  const normalized = value.replace(/[^0-9.]+/g, "");
  const [whole, ...rest] = normalized.split(".");
  return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

function parseTireSize(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return { width: "", aspect: "", diameter: "" };
  }

  const match = raw.match(/(\d{3})\D*(\d{2})\D*R?\D*(\d{2})/i);
  if (!match) {
    return { width: "", aspect: "", diameter: "" };
  }

  return {
    width: match[1] ?? "",
    aspect: match[2] ?? "",
    diameter: match[3] ?? "",
  };
}

function formatTireSize(width: string, aspect: string, diameter: string) {
  if (!width.trim() || !aspect.trim() || !diameter.trim()) {
    return null;
  }
  return `${width.trim()}/${aspect.trim()}R${diameter.trim()}`;
}

const selectTriggerClassName =
  "bg-white h-8 rounded-md border-primary/15 px-2.5 text-[12px] text-foreground";
const selectPopoverClassName = "rounded-md";
const selectListBoxClassName = "p-1 text-[12px]";
const selectItemClassName = "min-h-0 rounded-sm px-2.5 py-1.5 text-[12px]";

function rotorConditionLabel(value: string) {
  if (value === "good") return "Good";
  if (value === "scored") return "Scored";
  if (value === "needs_attention") return "Needs attention";
  return "Select...";
}

function modificationStatusLabel(value: string) {
  if (value === "none_observed") return "None observed";
  if (value === "aftermarket_observed") return "Yes - see notes";
  return "No selection";
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
  const initialFrontSize = parseTireSize(passportData?.passport.tires.size_front);
  const initialRearSize = parseTireSize(
    passportData?.passport.tires.size_rear ?? passportData?.passport.tires.size_front
  );
  const initialRearMatchesFront =
    !passportData?.passport.tires.size_rear ||
    passportData.passport.tires.size_rear === passportData.passport.tires.size_front;

  const [mileage, setMileage] = useState(
    typeof passportData?.passport.mileage === "number"
      ? String(Math.round(passportData.passport.mileage))
      : ""
  );
  const [tireBrand, setTireBrand] = useState(passportData?.passport.tires.brand ?? "");
  const [frontSizeWidth, setFrontSizeWidth] = useState(initialFrontSize.width);
  const [frontSizeAspect, setFrontSizeAspect] = useState(initialFrontSize.aspect);
  const [frontSizeDiameter, setFrontSizeDiameter] = useState(initialFrontSize.diameter);
  const [rearMatchesFront, setRearMatchesFront] = useState(initialRearMatchesFront);
  const [rearSizeWidth, setRearSizeWidth] = useState(initialRearSize.width);
  const [rearSizeAspect, setRearSizeAspect] = useState(initialRearSize.aspect);
  const [rearSizeDiameter, setRearSizeDiameter] = useState(initialRearSize.diameter);
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
  const [rotorCondition, setRotorCondition] = useState<"" | RotorCondition>(
    passportData?.passport.brakes.rotor_condition ?? ""
  );
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
    const frontTireSize = formatTireSize(
      frontSizeWidth,
      frontSizeAspect,
      frontSizeDiameter
    );
    const rearTireSize = rearMatchesFront
      ? frontTireSize
      : formatTireSize(rearSizeWidth, rearSizeAspect, rearSizeDiameter);

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
      tire_size_front: frontTireSize,
      tire_size_rear: rearTireSize,
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
            First visit - confirm what you see. Takes under 90 seconds.
          </div>
        ) : null}

        <div className="divide-y divide-primary/10">
          <SectionBlock eyebrow="Mileage">
            <FieldRow label={<RequiredLabel text="Odometer reading" />}>
              <input
                value={mileage}
                onChange={(event) => setMileage(keepDigitsOnly(event.target.value))}
                inputMode="numeric"
                placeholder="Enter mileage"
                className={narrowField(mileageError)}
              />
            </FieldRow>
          </SectionBlock>

          <SectionBlock eyebrow="Tire condition">
            <div className="space-y-2">
              <div className="rounded-lg border border-primary/10 bg-muted/40 px-3 py-2.5">
                <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                  <button
                    type="button"
                    aria-pressed={rearMatchesFront}
                    onClick={() => {
                      const checked = !rearMatchesFront;
                      if (!checked) {
                        setRearSizeWidth(frontSizeWidth);
                        setRearSizeAspect(frontSizeAspect);
                        setRearSizeDiameter(frontSizeDiameter);
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
                  <RequiredLabel
                    text={
                      shouldShowPassportSourceBadge(tireSizeSource) && tireSizeSource !== "empty"
                        ? `Front size (${passportSourceLabel(tireSizeSource)})`
                        : "Front size"
                    }
                  />
                }
              >
                <TireSizeInputs
                  width={frontSizeWidth}
                  aspect={frontSizeAspect}
                  diameter={frontSizeDiameter}
                  onWidthChange={setFrontSizeWidth}
                  onAspectChange={setFrontSizeAspect}
                  onDiameterChange={setFrontSizeDiameter}
                />
              </FieldRow>
              {!rearMatchesFront ? (
                <FieldRow label={<RequiredLabel text="Rear size" />}>
                  <TireSizeInputs
                    width={rearSizeWidth}
                    aspect={rearSizeAspect}
                    diameter={rearSizeDiameter}
                    onWidthChange={setRearSizeWidth}
                    onAspectChange={setRearSizeAspect}
                    onDiameterChange={setRearSizeDiameter}
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
              <div className="pt-1">
              <FieldRow label={<RequiredLabel text="Tire brand" />}>
                <input
                  value={tireBrand}
                  onChange={(event) => setTireBrand(event.target.value)}
                  placeholder="e.g. Goodyear Wrangler"
                  className={cn(baseField(), "w-full text-right sm:w-[140px]")}
                />
              </FieldRow>
              </div>
            </div>
          </SectionBlock>

          <SectionBlock eyebrow="Brakes" badge="Optional" accent="muted">
            <FieldRow label="Front pad thickness">
              <input
                value={frontPadMm}
                onChange={(event) => setFrontPadMm(keepNumericInput(event.target.value))}
                placeholder="mm"
                inputMode="decimal"
                className={cn(baseField(), "w-[90px] text-right")}
              />
            </FieldRow>
            <FieldRow label="Rear pad thickness">
              <input
                value={rearPadMm}
                onChange={(event) => setRearPadMm(keepNumericInput(event.target.value))}
                placeholder="mm"
                inputMode="decimal"
                className={cn(baseField(), "w-[90px] text-right")}
              />
            </FieldRow>
            <FieldRow label="Rotors overall">
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
                    <SelectItem id="none" textValue="Select..." className={selectItemClassName}>Select...</SelectItem>
                    <SelectItem id="good" textValue="Good" className={selectItemClassName}>Good</SelectItem>
                    <SelectItem id="scored" textValue="Scored" className={selectItemClassName}>Scored</SelectItem>
                    <SelectItem id="needs_attention" textValue="Needs attention" className={selectItemClassName}>
                      Needs attention
                    </SelectItem>
                  </SelectListBox>
                </SelectPopover>
              </Select>
            </FieldRow>
          </SectionBlock>

          <SectionBlock eyebrow="Fluids">
            <div className="grid gap-2 sm:grid-cols-2">
              <EditableFluidField
                label="Oil viscosity"
                value={oilViscosity}
                onChange={setOilViscosity}
                placeholder="Oil viscosity"
                source={passportData?.sources["fluids.oil_viscosity"]}
              />
              <EditableFluidField
                label="Oil type"
                value={oilType}
                onChange={setOilType}
                placeholder="Oil type"
                source={passportData?.sources["fluids.oil_type"]}
              />
              <EditableFluidField
                label="Coolant type"
                value={coolantType}
                onChange={setCoolantType}
                placeholder="Coolant type"
                source={passportData?.sources["fluids.coolant_type"]}
              />
              <EditableFluidField
                label="Brake fluid"
                value={brakeFluidType}
                onChange={setBrakeFluidType}
                placeholder="Brake fluid"
                source={passportData?.sources["fluids.brake_fluid_type"]}
              />
              <EditableFluidField
                label="Transmission fluid"
                value={transmissionFluidType}
                onChange={setTransmissionFluidType}
                placeholder="Transmission fluid"
                source={passportData?.sources["fluids.transmission_fluid_type"]}
                className="sm:col-span-2"
              />
            </div>
          </SectionBlock>

          <SectionBlock eyebrow="Inspection" badge="Optional" accent="muted">
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

          <SectionBlock eyebrow="Modifications" badge="Optional" accent="muted">
            <FieldRow label="Aftermarket observed?">
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
                <SelectTrigger className={cn(selectTriggerClassName, "w-[140px] justify-end")}>
                  <SelectValue>{modificationStatusLabel(modificationsStatus)}</SelectValue>
                </SelectTrigger>
                <SelectPopover className={selectPopoverClassName}>
                  <SelectListBox shouldFocusWrap className={selectListBoxClassName}>
                    <SelectItem id="none" textValue="No selection" className={selectItemClassName}>No selection</SelectItem>
                    <SelectItem id="none_observed" textValue="None observed" className={selectItemClassName}>
                      None observed
                    </SelectItem>
                    <SelectItem id="aftermarket_observed" textValue="Yes - see notes" className={selectItemClassName}>
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
  badge?: string;
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
        {badge ? (
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]",
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

function TireSizeInputs({
  width,
  aspect,
  diameter,
  onWidthChange,
  onAspectChange,
  onDiameterChange,
}: {
  width: string;
  aspect: string;
  diameter: string;
  onWidthChange: (value: string) => void;
  onAspectChange: (value: string) => void;
  onDiameterChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={width}
        onChange={(event) => onWidthChange(keepDigitsOnly(event.target.value).slice(0, 3))}
        inputMode="numeric"
        placeholder="225"
        className={cn(baseField(), "w-[54px] text-right")}
      />
      <span className="text-[12px] text-muted-foreground">/</span>
      <input
        value={aspect}
        onChange={(event) => onAspectChange(keepDigitsOnly(event.target.value).slice(0, 2))}
        inputMode="numeric"
        placeholder="65"
        className={cn(baseField(), "w-[46px] text-right")}
      />
      <span className="text-[12px] font-medium text-muted-foreground">R</span>
      <input
        value={diameter}
        onChange={(event) => onDiameterChange(keepDigitsOnly(event.target.value).slice(0, 2))}
        inputMode="numeric"
        placeholder="17"
        className={cn(baseField(), "w-[46px] text-right")}
      />
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

function EditableFluidField({
  label,
  value,
  onChange,
  placeholder,
  source,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  source?: PassportSource;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-primary/10 bg-muted/40 p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        {shouldShowPassportSourceBadge(source) && source !== "empty" ? (
          <span className="rounded-full border border-primary/10 bg-background px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {passportSourceLabel(source)}
          </span>
        ) : null}
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
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
