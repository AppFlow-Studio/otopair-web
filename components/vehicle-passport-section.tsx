"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Info, Loader2 } from "lucide-react";
import {
  formatDateLabel,
  formatMileage,
  formatMonthMileage,
  getVehiclePassportCompletionPercent,
  getMissingRequiredPassportFields,
  modificationStatusLabel,
  passportSourceLabel,
  shouldShowPassportSourceBadge,
  tireConditionLabel,
  type PassportSource,
  type TireCondition,
  type VehiclePassportData,
  type VehiclePassportUpdatePayload,
} from "@/lib/vehicle-passport";
import { cn } from "@/lib/utils";

function sourceBadgeClassName(source?: PassportSource) {
  if (source === "verified") {
    return "border-success/25 bg-success/10 text-success";
  }
  if (source === "oem_default") {
    return "border-primary/10 bg-muted text-muted-foreground";
  }
  if (source === "user_reported") {
    return "border-primary/20 bg-primary/10 text-primary";
  }
  return "border-destructive/25 bg-destructive/10 text-destructive";
}

function baseInput(isError?: boolean) {
  return cn(
    "h-8 rounded-md border bg-background px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-all focus:border-primary/40 focus:ring-2 focus:ring-primary/15",
    isError ? "border-destructive/50" : "border-primary/15"
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
      <div className="rounded-xl border border-primary/10 bg-card p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-40 rounded-lg bg-muted/80" />
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
    <section className="overflow-hidden rounded-xl border border-primary/10 bg-card shadow-[0_4px_14px_-6px_rgba(15,23,42,0.08)]">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
          isOpen
            ? "border-b border-primary/10 bg-primary/5"
            : "bg-primary/[0.035] hover:bg-primary/5"
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
          ID
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-primary">
            Vehicle ID
          </p>
          <p className="mt-0.5 truncate text-[13px] font-semibold text-foreground">
            {data.vehicle_label}
          </p>
        </div>
        {!data.is_complete ? (
          <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-primary">
            First visit
          </span>
        ) : null}
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {isOpen ? (
        <div className="space-y-3 bg-muted/40 p-3 sm:p-4">
          {!data.is_complete ? (
            <>
              <div className="flex gap-2.5 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2.5">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <div className="min-w-0 text-[11px] leading-5 text-foreground/80">
                  <span className="font-semibold text-foreground">
                    First time this vehicle is visiting a shop on Otopair.
                  </span>{" "}
                  Please confirm or fill in the vehicle specs below. This data
                  will be saved to the vehicle&apos;s profile and will be available
                  on future visits to any Otopair partner shop.
                </div>
              </div>

              <div>
                <div className="h-1.5 overflow-hidden rounded-full bg-primary/10">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${completionPercent}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] font-medium text-muted-foreground">
                  Vehicle ID {completionPercent}% complete — help us fill in the gaps
                </p>
              </div>

              <PanelSection title="Mileage">
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
                    className={cn(baseInput(missingFields.includes("mileage")), "w-[150px] text-right")}
                  />
                </EditableRow>
              </PanelSection>

              <PanelSection title="Tires">
                <EditableRow
                  label="Brand"
                  source={data.sources["tires.brand"]}
                  missing={missingFields.includes("tires.brand")}
                >
                  <input
                    value={tireBrand}
                    onChange={(event) => setTireBrand(event.target.value)}
                    placeholder="e.g. Michelin"
                    className={cn(baseInput(missingFields.includes("tires.brand")), "w-[150px] text-right")}
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
                    className={cn(baseInput(missingFields.includes("tires.model")), "w-[150px] text-right")}
                  />
                </EditableRow>
                <DisplayRow
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
                      baseInput(missingFields.includes("tires.overall_condition")),
                      "w-[150px] pr-7"
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
                    className={cn(baseInput(), "w-[120px] pr-7")}
                  >
                    <option value="">Select...</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </EditableRow>
              </PanelSection>
            </>
          ) : (
            <PanelSection title="Tires">
              <DisplayRow
                label="Brand"
                value={data.passport.tires.brand ?? "Unknown"}
                source={data.sources["tires.brand"]}
              />
              {data.passport.tires.model ? (
                <DisplayRow
                  label="Model"
                  value={data.passport.tires.model}
                  source={data.sources["tires.model"]}
                />
              ) : null}
              <DisplayRow
                label="Size"
                value={
                  data.passport.tires.size_rear &&
                  data.passport.tires.size_rear !== data.passport.tires.size_front
                    ? `${data.passport.tires.size_front ?? "Unknown"} / ${data.passport.tires.size_rear}`
                    : data.passport.tires.size_front ?? "Unknown"
                }
                source={data.sources["tires.size_front"]}
              />
              <DisplayRow
                label="Condition"
                value={tireConditionLabel(data.passport.tires.overall_condition)}
                source={data.sources["tires.overall_condition"]}
              />
              <DisplayRow
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
            </PanelSection>
          )}

          <PanelSection title="Fluids">
            <DisplayRow
              label="Oil viscosity"
              value={data.passport.fluids.oil_viscosity ?? "Unknown"}
              source={data.sources["fluids.oil_viscosity"]}
            />
            <DisplayRow
              label="Oil type"
              value={data.passport.fluids.oil_type ?? "Unknown"}
              source={data.sources["fluids.oil_type"]}
            />
            <DisplayRow
              label="Coolant"
              value={data.passport.fluids.coolant_type ?? "Unknown"}
              source={data.sources["fluids.coolant_type"]}
            />
            <DisplayRow
              label="Brake fluid"
              value={data.passport.fluids.brake_fluid_type ?? "Unknown"}
              source={data.sources["fluids.brake_fluid_type"]}
            />
            {data.passport.fluids.transmission_fluid_type ? (
              <DisplayRow
                label="Transmission fluid"
                value={data.passport.fluids.transmission_fluid_type}
                source={data.sources["fluids.transmission_fluid_type"]}
              />
            ) : null}
          </PanelSection>

          <PanelSection title="Mileage">
            <DisplayRow
              label="Current"
              value={formatMileage(data.passport.mileage)}
              source={data.sources.mileage}
            />
            <DisplayRow
              label="Velocity"
              value={formatMonthMileage(data.passport.mileage_velocity)}
            />
            <DisplayRow
              label="Last updated"
              value={formatDateLabel(data.passport.last_reported_at)}
            />
          </PanelSection>

          <PanelSection title="Usage">
            <DisplayRow label="Driving type" value={data.usage.driving_type ?? "Unknown"} />
            <DisplayRow label="Ownership" value={data.usage.ownership ?? "Unknown"} />
            {data.passport.modifications.status ? (
              <DisplayRow
                label="Modifications"
                value={modificationStatusLabel(data.passport.modifications.status)}
              />
            ) : null}
          </PanelSection>

          <PanelSection title="Recent services">
            {data.recent_services.length === 0 ? (
              <p className="py-2 text-center text-[11px] italic text-muted-foreground">
                No previous services on Otopair
              </p>
            ) : (
              data.recent_services.map((entry) => (
                <div
                  key={`${entry.date_label}-${entry.service_name}`}
                  className="flex items-center justify-between gap-3 border-b border-primary/10 py-1.5 text-[12px] last:border-b-0"
                >
                  <span className="text-muted-foreground">{entry.date_label}</span>
                  <span className="font-medium text-foreground">
                    {entry.service_name}
                  </span>
                </div>
              ))
            )}
          </PanelSection>

          <PanelSection title="Mechanic notes">
            {data.mechanic_notes.length === 0 ? (
              <p className="py-2 text-center text-[11px] italic text-muted-foreground">
                No mechanic notes recorded yet
              </p>
            ) : (
              <div className="space-y-2">
                {data.mechanic_notes.map((entry) => (
                  <div
                    key={`${entry.author}-${entry.date_label}-${entry.note}`}
                    className="rounded-md border-l-2 border-primary bg-primary/5 px-3 py-2"
                  >
                    <p className="text-[11px] italic leading-5 text-foreground/85">
                      &quot;{entry.note}&quot;
                    </p>
                    <p className="mt-1 text-[10px] font-medium text-muted-foreground">
                      — {entry.author}, {entry.date_label}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </PanelSection>

          {!data.is_complete ? (
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={isSaving}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-foreground text-[12px] font-semibold text-background transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-40"
            >
              {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Confirm vehicle specs &amp; start job
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-primary/10 bg-card px-3 py-2.5 sm:px-3.5">
      <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-primary">
        {title}
      </p>
      <div className="mt-1 divide-y divide-primary/10">{children}</div>
    </section>
  );
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
    <div className="flex flex-col gap-1.5 py-2 text-[12px] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{label}</span>
        {required ? (
          <span className="rounded-full border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-destructive">
            Required
          </span>
        ) : null}
        {!required && source ? <SourceBadge source={source} /> : null}
        {!required && missing ? (
          <span className="rounded-full border border-destructive/25 bg-destructive/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-destructive">
            Empty
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

function DisplayRow({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source?: PassportSource;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 text-right font-medium text-foreground">
        {value}
        {source ? <SourceBadge source={source} /> : null}
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
  if (!shouldShowPassportSourceBadge(source)) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]",
        sourceBadgeClassName(source),
        className
      )}
    >
      {passportSourceLabel(source)}
    </span>
  );
}
