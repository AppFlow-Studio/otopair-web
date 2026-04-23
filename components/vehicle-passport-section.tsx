"use client";

import { useState } from "react";
import { BadgeInfo, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import {
  drawerInfoCardClassName,
  drawerInputClassName,
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
  DrawerFieldLabel,
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

function sourceBadgeClassName(source?: string) {
  if (source === "verified") {
    return "border-primary/20 bg-primary/10 text-primary";
  }
  if (source === "oem_default") {
    return "border-border bg-background text-muted-foreground";
  }
  if (source === "user_reported") {
    return "border-primary/20 bg-primary/5 text-primary";
  }
  return "border-destructive/20 bg-destructive/10 text-destructive";
}

function inlineFieldValueClassName(source?: string, isEmpty?: boolean) {
  if (isEmpty) {
    return "border-destructive/40";
  }
  if (source === "verified") {
    return "border-primary/30";
  }
  return "border-border";
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
      <div className="rounded-2xl bg-muted/20 p-4">
        <div className="animate-pulse space-y-2">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-20 rounded-xl bg-muted/70" />
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

  const title = data.is_complete
    ? `Vehicle Passport - ${data.vehicle_label}`
    : `Vehicle Passport - ${data.vehicle_label}`;

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
    <section className="rounded-2xl bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BadgeInfo className="h-4 w-4 text-primary" />
            <DrawerFieldLabel className="mb-0">{title}</DrawerFieldLabel>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.is_complete
              ? "Shared current-state vehicle info for this VIN across Otopair partner shops."
              : "Complete the required baseline fields once and future visits will start from this passport."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          className={drawerSecondaryButtonClassName}
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
        <div className="mt-4 space-y-4">
          {!data.is_complete ? (
            <>
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">
                <p className="font-medium">
                  First-time or incomplete vehicle data detected.
                </p>
                <p className="mt-1 text-primary/80">
                  Required fields missing: {missingFields.length}. Completion{" "}
                  {getVehiclePassportCompletionPercent(data.passport)}%.
                </p>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className={drawerInfoCardClassName}>
                  <DrawerFieldLabel>Current mileage</DrawerFieldLabel>
                  <input
                    value={mileage}
                    onChange={(event) => setMileage(event.target.value)}
                    inputMode="numeric"
                    placeholder="Enter mileage"
                    className={cn(
                      drawerInputClassName,
                      inlineFieldValueClassName(
                        data.sources.mileage,
                        missingFields.includes("mileage")
                      )
                    )}
                  />
                </div>

                <div className={drawerInfoCardClassName}>
                  <DrawerFieldLabel>Tire brand</DrawerFieldLabel>
                  <input
                    value={tireBrand}
                    onChange={(event) => setTireBrand(event.target.value)}
                    placeholder="e.g. Michelin"
                    className={cn(
                      drawerInputClassName,
                      inlineFieldValueClassName(
                        data.sources["tires.brand"],
                        missingFields.includes("tires.brand")
                      )
                    )}
                  />
                </div>

                <div className={drawerInfoCardClassName}>
                  <DrawerFieldLabel>Tire model</DrawerFieldLabel>
                  <input
                    value={tireModel}
                    onChange={(event) => setTireModel(event.target.value)}
                    placeholder="e.g. Pilot Sport"
                    className={cn(
                      drawerInputClassName,
                      inlineFieldValueClassName(
                        data.sources["tires.model"],
                        missingFields.includes("tires.model")
                      )
                    )}
                  />
                </div>

                <div className={drawerInfoCardClassName}>
                  <DrawerFieldLabel>Condition</DrawerFieldLabel>
                  <select
                    value={overallCondition}
                    onChange={(event) =>
                      setOverallCondition(event.target.value as TireCondition | "")
                    }
                    className={cn(
                      drawerInputClassName,
                      "h-10",
                      inlineFieldValueClassName(
                        data.sources["tires.overall_condition"],
                        missingFields.includes("tires.overall_condition")
                      )
                    )}
                  >
                    <option value="">Select...</option>
                    <option value="good">Good</option>
                    <option value="fair">Fair</option>
                    <option value="replace_soon">Replace soon</option>
                  </select>
                </div>

                <div className={drawerInfoCardClassName}>
                  <DrawerFieldLabel>Tire size</DrawerFieldLabel>
                  <p className="text-[15px] font-medium text-foreground">
                    {data.passport.tires.size_front ?? "Unknown"}
                    {data.passport.tires.size_rear &&
                    data.passport.tires.size_rear !== data.passport.tires.size_front
                      ? ` / ${data.passport.tires.size_rear}`
                      : ""}
                  </p>
                  <div className="mt-2">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                        sourceBadgeClassName(data.sources["tires.size_front"])
                      )}
                    >
                      {passportSourceLabel(data.sources["tires.size_front"])}
                    </span>
                  </div>
                </div>

                <div className={drawerInfoCardClassName}>
                  <DrawerFieldLabel>Run-flat</DrawerFieldLabel>
                  <select
                    value={runFlat}
                    onChange={(event) =>
                      setRunFlat(event.target.value as "" | "yes" | "no")
                    }
                    className={cn(drawerInputClassName, "h-10")}
                  >
                    <option value="">Select...</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </div>
              </div>
            </>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-2xl border border-border bg-background px-4 py-3">
              <p className="text-[11px] font-bold tracking-widest text-primary">
                TIRES
              </p>
              <div className="mt-3 space-y-3 text-sm">
                <PassportRow
                  label="Brand"
                  value={data.passport.tires.brand ?? "Unknown"}
                  source={data.sources["tires.brand"]}
                />
                <PassportRow
                  label="Model"
                  value={data.passport.tires.model ?? "Unknown"}
                  source={data.sources["tires.model"]}
                />
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
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-background px-4 py-3">
              <p className="text-[11px] font-bold tracking-widest text-primary">
                FLUIDS
              </p>
              <div className="mt-3 space-y-3 text-sm">
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
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-background px-4 py-3">
              <p className="text-[11px] font-bold tracking-widest text-primary">
                MILEAGE
              </p>
              <div className="mt-3 space-y-3 text-sm">
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
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-background px-4 py-3">
              <p className="text-[11px] font-bold tracking-widest text-primary">
                NOTES
              </p>
              <div className="mt-3 space-y-3 text-sm text-muted-foreground">
                {data.mechanic_notes.length === 0 ? (
                  <p>No mechanic notes recorded yet.</p>
                ) : (
                  data.mechanic_notes.map((entry) => (
                    <div
                      key={`${entry.author}-${entry.date_label}-${entry.note}`}
                      className="rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-sm text-foreground"
                    >
                      <p className="italic">&quot;{entry.note}&quot;</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {entry.author} - {entry.date_label}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-2xl border border-border bg-background px-4 py-3">
              <p className="text-[11px] font-bold tracking-widest text-primary">
                RECENT SERVICES
              </p>
              <div className="mt-3 space-y-2 text-sm">
                {data.recent_services.length === 0 ? (
                  <p className="text-muted-foreground">No completed Otopair visits yet.</p>
                ) : (
                  data.recent_services.map((entry) => (
                    <div
                      key={`${entry.date_label}-${entry.service_name}`}
                      className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-b-0 last:pb-0"
                    >
                      <span className="text-muted-foreground">{entry.date_label}</span>
                      <span className="text-right font-medium text-foreground">
                        {entry.service_name}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-background px-4 py-3">
              <p className="text-[11px] font-bold tracking-widest text-primary">
                USAGE
              </p>
              <div className="mt-3 space-y-3 text-sm">
                <PassportRow
                  label="Driving type"
                  value={data.usage.driving_type ?? "Unknown"}
                />
                <PassportRow
                  label="Ownership"
                  value={data.usage.ownership ?? "Unknown"}
                />
                {data.passport.modifications.status ? (
                  <PassportRow
                    label="Modifications"
                    value={modificationStatusLabel(data.passport.modifications.status)}
                  />
                ) : null}
              </div>
            </div>
          </div>

          {!data.is_complete ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={isSaving}
                className={drawerPrimaryButtonClassName}
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
    <div className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-b-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">
        {value}
        {source ? (
          <span
            className={cn(
              "ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
              sourceBadgeClassName(source)
            )}
          >
            {passportSourceLabel(source)}
          </span>
        ) : null}
      </span>
    </div>
  );
}
