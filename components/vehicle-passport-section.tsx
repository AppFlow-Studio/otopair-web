"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import {
  formatDateLabel,
  formatMileage,
  formatMonthMileage,
  modificationStatusLabel,
  passportSourceLabel,
  shouldShowPassportSourceBadge,
  tireConditionLabel,
  type PassportSource,
  type VehiclePassportData,
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

export default function VehiclePassportSection({
  data,
}: {
  data: VehiclePassportData | null | undefined;
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
      key={`${data.vin}-${data.is_complete}`}
      data={data}
    />
  );
}

function VehiclePassportSectionBody({
  data,
}: {
  data: VehiclePassportData;
}) {
  const [isOpen, setIsOpen] = useState(!data.is_complete);

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
            <FirstVisitNotice />
          ) : (
            <>
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
                          -- {entry.author}, {entry.date_label}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </PanelSection>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function FirstVisitNotice() {
  return (
    <div className="rounded-lg border border-primary/15 bg-card px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/5 text-primary">
          <Info className="h-3.5 w-3.5" />
        </div>
        <p className="text-[13px] leading-7 text-foreground/85">
          <span className="font-semibold text-foreground">
            First time this vehicle is visiting a shop on Otopair.
          </span>{" "}
          Please confirm or fill in the vehicle specs below. This data will be saved to the
          vehicle&apos;s profile and will be available on future visits.
        </p>
      </div>
    </div>
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
