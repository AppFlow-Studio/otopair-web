"use client";

import { useState, type ReactNode } from "react";
import { BadgeInfo, ChevronDown, ChevronUp, CircleAlert, Loader2 } from "lucide-react";
import {
  drawerInputClassName,
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import {
  formatDateLabel,
  formatMileage,
  formatMonthMileage,
  getVehiclePassportCompletionPercent,
  getMissingRequiredPassportFields,
  modificationStatusLabel,
  passportSourceLabel,
  tireConditionLabel,
  type PassportSource,
  type TireCondition,
  type VehiclePassportData,
  type VehiclePassportUpdatePayload,
} from "@/lib/vehicle-passport";
import { cn } from "@/lib/utils";

const surfaceClassName =
  "rounded-[28px] border border-primary/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,244,238,0.98))] shadow-[0_12px_34px_rgba(15,23,42,0.06)]";
const sectionClassName =
  "rounded-[22px] border border-primary/10 bg-[rgba(255,255,255,0.7)] px-4 py-4 sm:px-5";

function sourceBadgeClassName(source?: PassportSource) {
  if (source === "verified") {
    return "border-success/20 bg-success/10 text-success";
  }
  if (source === "oem_default") {
    return "border-border bg-white/90 text-muted-foreground";
  }
  if (source === "user_reported") {
    return "border-primary/15 bg-primary/10 text-primary";
  }
  return "border-destructive/20 bg-destructive/10 text-destructive";
}

function inputClassName(isEmpty?: boolean) {
  return cn(
    drawerInputClassName,
    "h-11 rounded-xl border bg-white/92 shadow-none",
    isEmpty ? "border-destructive/40" : "border-primary/10"
  );
}

export default function VehiclePassportSection({
  data,
  onConfirm,
  isSaving,
}: {
  data: VehiclePassportData | null | undefined;
  onConfirm: (payload: VehiclePassportUpdatePayload) => Promise<void>;
  isSaving: boolean;
}) {
  if (!data) {
    return (
      <div className={cn(surfaceClassName, "p-4")}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-48 rounded-[22px] bg-muted/80" />
        </div>
      </div>
    );
  }

  return (
    <VehiclePassportSectionBody
      key={`${data.vin}-${data.completion_percent}-${data.passport.last_reported_at ?? "none"}`}
      data={data}
      onConfirm={onConfirm}
      isSaving={isSaving}
    />
  );
}

function VehiclePassportSectionBody({
  data,
  onConfirm,
  isSaving,
}: {
  data: VehiclePassportData;
  onConfirm: (payload: VehiclePassportUpdatePayload) => Promise<void>;
  isSaving: boolean;
}) {
  const [isOpen, setIsOpen] = useState(!data.is_complete);
  const [mileage, setMileage] = useState(
    typeof data.passport.mileage === "number"
      ? String(Math.round(data.passport.mileage))
      : ""
  );
  const [tireBrand, setTireBrand] = useState(data.passport.tires.brand ?? "");
  const [tireModel, setTireModel] = useState(data.passport.tires.model ?? "");
  const [overallCondition, setOverallCondition] = useState<TireCondition | "">(
    data.passport.tires.overall_condition ?? ""
  );
  const [runFlat, setRunFlat] = useState<"" | "yes" | "no">(
    typeof data.passport.tires.run_flat === "boolean"
      ? data.passport.tires.run_flat
        ? "yes"
        : "no"
      : ""
  );
  const missingFields = getMissingRequiredPassportFields(data.passport);
  const completionPercent = getVehiclePassportCompletionPercent(data.passport);

  async function handleConfirm() {
    const parsedMileage = Number(mileage);
    await onConfirm({
      mileage: Number.isFinite(parsedMileage) ? parsedMileage : null,
      tires: {
        brand: tireBrand.trim() || null,
        model: tireModel.trim() || null,
        overall_condition: overallCondition || null,
        run_flat:
          runFlat === ""
            ? null
            : runFlat === "yes"
              ? true
              : false,
      },
    });
  }

  return (
    <section className={cn(surfaceClassName, "overflow-hidden p-4 sm:p-5")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <BadgeInfo className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[0.72rem] font-semibold uppercase tracking-[0.24em] text-primary/80">
                Vehicle Passport
              </p>
              <h3 className="mt-1 text-base font-semibold text-foreground">
                {data.vehicle_label}
              </h3>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            {data.is_complete
              ? "Current verified vehicle details for this VIN across Otopair partner shops."
              : "This vehicle needs a one-time baseline confirm before future visits can reuse its shared passport."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          className={cn(
            drawerSecondaryButtonClassName,
            "rounded-full border-primary/10 bg-white/75 px-4"
          )}
        >
          {isOpen ? (
            <>
              Collapse
              <ChevronUp className="h-4 w-4" />
            </>
          ) : (
            <>
              Expand
              <ChevronDown className="h-4 w-4" />
            </>
          )}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-5 space-y-4">
          {!data.is_complete ? (
            <div className="rounded-[22px] border border-primary/15 bg-primary/5 px-4 py-4 sm:px-5">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 h-5 w-5 text-primary" />
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">
                    First time this vehicle is visiting an Otopair shop.
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Confirm or fill in the vehicle specs below. This data will be saved
                    to the vehicle&apos;s profile and will be available on future visits.
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <div className="h-2 rounded-full bg-primary/10">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${completionPercent}%` }}
                  />
                </div>
                <p className="mt-2 text-xs font-medium text-muted-foreground">
                  Vehicle ID {completionPercent}% complete - help us fill in the gaps
                </p>
              </div>
            </div>
          ) : null}

          {!data.is_complete ? (
            <>
              <PassportEditableSection title="Mileage">
                <EditableRow
                  label="Current mileage"
                  required
                  source={data.sources.mileage}
                  missing={missingFields.includes("mileage")}
                >
                  <input
                    value={mileage}
                    onChange={(event) => setMileage(event.target.value)}
                    inputMode="numeric"
                    placeholder="Enter mileage"
                    className={inputClassName(missingFields.includes("mileage"))}
                  />
                </EditableRow>
              </PassportEditableSection>

              <PassportEditableSection title="Tires">
                <EditableRow
                  label="Brand"
                  source={data.sources["tires.brand"]}
                  missing={missingFields.includes("tires.brand")}
                >
                  <input
                    value={tireBrand}
                    onChange={(event) => setTireBrand(event.target.value)}
                    placeholder="e.g. Michelin"
                    className={inputClassName(missingFields.includes("tires.brand"))}
                  />
                </EditableRow>
                <EditableRow
                  label="Model"
                  source={data.sources["tires.model"]}
                  missing={missingFields.includes("tires.model")}
                >
                  <input
                    value={tireModel}
                    onChange={(event) => setTireModel(event.target.value)}
                    placeholder="e.g. Pilot Sport"
                    className={inputClassName(missingFields.includes("tires.model"))}
                  />
                </EditableRow>
                <EditableDisplayRow
                  label="Size"
                  value={
                    data.passport.tires.size_rear &&
                    data.passport.tires.size_rear !== data.passport.tires.size_front
                      ? `${data.passport.tires.size_front ?? "Unknown"} / ${data.passport.tires.size_rear}`
                      : data.passport.tires.size_front ?? "Unknown"
                  }
                  source={data.sources["tires.size_front"]}
                />
                <EditableRow
                  label="Condition"
                  source={data.sources["tires.overall_condition"]}
                  missing={missingFields.includes("tires.overall_condition")}
                >
                  <select
                    value={overallCondition}
                    onChange={(event) =>
                      setOverallCondition(event.target.value as TireCondition | "")
                    }
                    className={cn(
                      inputClassName(missingFields.includes("tires.overall_condition")),
                      "pr-10"
                    )}
                  >
                    <option value="">Select...</option>
                    <option value="good">Good</option>
                    <option value="fair">Fair</option>
                    <option value="replace_soon">Replace soon</option>
                  </select>
                </EditableRow>
                <EditableRow label="Run-flat" source={data.sources["tires.run_flat"]}>
                  <select
                    value={runFlat}
                    onChange={(event) =>
                      setRunFlat(event.target.value as "" | "yes" | "no")
                    }
                    className={cn(inputClassName(), "pr-10")}
                  >
                    <option value="">Select...</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </EditableRow>
              </PassportEditableSection>
            </>
          ) : null}

          <PassportDisplaySection title="Tires">
            <PassportRow
              label="Brand"
              value={data.passport.tires.brand ?? "Unknown"}
              source={data.sources["tires.brand"]}
            />
            {data.passport.tires.model ? (
              <PassportRow
                label="Model"
                value={data.passport.tires.model}
                source={data.sources["tires.model"]}
              />
            ) : null}
            <PassportRow
              label="Size"
              value={
                data.passport.tires.size_rear &&
                data.passport.tires.size_rear !== data.passport.tires.size_front
                  ? `${data.passport.tires.size_front ?? "Unknown"} / ${data.passport.tires.size_rear}`
                  : data.passport.tires.size_front ?? "Unknown"
              }
              source={data.sources["tires.size_front"]}
            />
            <PassportRow
              label="Condition"
              value={tireConditionLabel(data.passport.tires.overall_condition)}
              source={data.sources["tires.overall_condition"]}
            />
            <PassportRow
              label="Run-flat"
              value={
                data.passport.tires.run_flat == null
                  ? "Unknown"
                  : data.passport.tires.run_flat
                    ? "Yes"
                    : "No"
              }
              source={data.sources["tires.run_flat"]}
            />
          </PassportDisplaySection>

          <PassportDisplaySection title="Fluids">
            <PassportRow
              label="Oil viscosity"
              value={data.passport.fluids.oil_viscosity ?? "Unknown"}
              source={data.sources["fluids.oil_viscosity"]}
            />
            <PassportRow
              label="Oil type"
              value={data.passport.fluids.oil_type ?? "Unknown"}
              source={data.sources["fluids.oil_type"]}
            />
            <PassportRow
              label="Coolant"
              value={data.passport.fluids.coolant_type ?? "Unknown"}
              source={data.sources["fluids.coolant_type"]}
            />
            <PassportRow
              label="Brake fluid"
              value={data.passport.fluids.brake_fluid_type ?? "Unknown"}
              source={data.sources["fluids.brake_fluid_type"]}
            />
            {data.passport.fluids.transmission_fluid_type ? (
              <PassportRow
                label="Transmission fluid"
                value={data.passport.fluids.transmission_fluid_type}
                source={data.sources["fluids.transmission_fluid_type"]}
              />
            ) : null}
          </PassportDisplaySection>

          <PassportDisplaySection title="Mileage">
            <PassportRow
              label="Current"
              value={formatMileage(data.passport.mileage)}
              source={data.sources.mileage}
            />
            <PassportRow
              label="Velocity"
              value={formatMonthMileage(data.passport.mileage_velocity)}
            />
            <PassportRow
              label="Last updated"
              value={formatDateLabel(data.passport.last_reported_at)}
            />
          </PassportDisplaySection>

          <PassportDisplaySection title="Usage">
            <PassportRow label="Driving type" value={data.usage.driving_type ?? "Unknown"} />
            <PassportRow label="Ownership" value={data.usage.ownership ?? "Unknown"} />
            {data.passport.modifications.status ? (
              <PassportRow
                label="Modifications"
                value={modificationStatusLabel(data.passport.modifications.status)}
              />
            ) : null}
          </PassportDisplaySection>

          <PassportDisplaySection title="Recent Services">
            {data.recent_services.length === 0 ? (
              <p className="py-3 text-center text-sm italic text-muted-foreground">
                No previous services on Otopair
              </p>
            ) : (
              data.recent_services.map((entry) => (
                <div
                  key={`${entry.date_label}-${entry.service_name}`}
                  className="flex items-center justify-between gap-3 border-b border-primary/10 py-2.5 last:border-b-0 last:pb-0"
                >
                  <span className="text-sm text-muted-foreground">{entry.date_label}</span>
                  <span className="text-right text-sm font-semibold text-foreground">
                    {entry.service_name}
                  </span>
                </div>
              ))
            )}
          </PassportDisplaySection>

          <PassportDisplaySection title="Mechanic Notes">
            {data.mechanic_notes.length === 0 ? (
              <p className="py-3 text-center text-sm italic text-muted-foreground">
                No mechanic notes recorded yet
              </p>
            ) : (
              data.mechanic_notes.map((entry) => (
                <div
                  key={`${entry.author}-${entry.date_label}-${entry.note}`}
                  className="rounded-2xl border border-primary/10 bg-[rgba(255,250,240,0.9)] px-4 py-3"
                >
                  <p className="text-sm italic leading-6 text-foreground">
                    &quot;{entry.note}&quot;
                  </p>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">
                    {entry.author}, {entry.date_label}
                  </p>
                </div>
              ))
            )}
          </PassportDisplaySection>

          {!data.is_complete ? (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={isSaving}
                className={cn(
                  drawerPrimaryButtonClassName,
                  "h-12 w-full rounded-2xl border border-primary/15 bg-white text-foreground shadow-none hover:bg-primary/5"
                )}
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Confirm specs
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PassportEditableSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={sectionClassName}>
      <SectionEyebrow>{title}</SectionEyebrow>
      <div className="mt-2 divide-y divide-primary/10">{children}</div>
    </section>
  );
}

function PassportDisplaySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={sectionClassName}>
      <SectionEyebrow>{title}</SectionEyebrow>
      <div className="mt-2 divide-y divide-primary/10">{children}</div>
    </section>
  );
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-primary/80">{children}</p>;
}

function EditableRow({
  label,
  children,
  source,
  missing = false,
  required = false,
}: {
  label: string;
  children: ReactNode;
  source?: PassportSource;
  missing?: boolean;
  required?: boolean;
}) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[minmax(120px,0.8fr)_minmax(0,1.2fr)] sm:items-center">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {required ? (
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
            Required
          </span>
        ) : null}
        {!required && source ? <SourceBadge source={source} /> : null}
        {!required && missing ? (
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
            Empty
          </span>
        ) : null}
      </div>
      <div className="sm:justify-self-end sm:w-full sm:max-w-[240px]">{children}</div>
    </div>
  );
}

function EditableDisplayRow({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source?: PassportSource;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-2 text-right">
        <span className="text-sm font-semibold text-foreground">{value}</span>
        {source ? <SourceBadge source={source} /> : null}
      </div>
    </div>
  );
}

function PassportRow({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source?: PassportSource;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="text-sm text-foreground/80">{label}</span>
      <span className="text-right text-sm font-semibold text-foreground">
        {value}
        {source ? <SourceBadge source={source} className="ml-2" /> : null}
      </span>
    </div>
  );
}

function SourceBadge({
  source,
  className,
}: {
  source: PassportSource;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        sourceBadgeClassName(source),
        className
      )}
    >
      {passportSourceLabel(source)}
    </span>
  );
}
