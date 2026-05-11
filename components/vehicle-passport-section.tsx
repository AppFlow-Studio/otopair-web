"use client";

import { useId, useState, type ReactNode } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Info } from "lucide-react";
import {
  formatDateLabel,
  formatMileage,
  formatMonthMileage,
  modificationStatusLabel,
  passportSourceLabel,
  rotorConditionLabel,
  shouldShowPassportSourceBadge,
  tireConditionLabel,
  type PassportSource,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import {
  getBookingServiceFlags,
  serviceListsOverlap,
} from "@/lib/vehicle-service-relevance";
import { cn } from "@/lib/utils";

const EMPTY_SECTION_COPY =
  "Not yet recorded - will appear after first verification.";
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type SectionRow = {
  label: string;
  value: string;
  source?: PassportSource;
};

export function sourceBadgeClassName(source?: PassportSource) {
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

function isMeaningfulValue(value?: string | null) {
  return typeof value === "string" && value.trim().length > 0 && value !== "Unknown";
}

function isVisibleRow(row: SectionRow) {
  if (row.source === "empty") {
    return false;
  }
  return isMeaningfulValue(row.value);
}

function getSectionRows(rows: SectionRow[]) {
  return rows.filter(isVisibleRow);
}

function formatNumberValue(value?: number | null, unit?: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Unknown";
  }
  const formatted = Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return unit ? `${formatted} ${unit}` : formatted;
}

function buildTireSizeValue(data: VehiclePassportData) {
  const frontSize = data.passport.tires.size_front ?? "Unknown";
  const rearSize = data.passport.tires.size_rear;
  if (rearSize && rearSize !== data.passport.tires.size_front) {
    return `${frontSize} / ${rearSize}`;
  }
  return frontSize;
}

export default function VehiclePassportSection({
  data,
  bookingServices = [],
}: {
  data: VehiclePassportData | null | undefined;
  bookingServices?: string[];
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
      key={`${data.vin}-${data.is_complete}-${bookingServices.join("|")}`}
      data={data}
      bookingServices={bookingServices}
    />
  );
}

function VehiclePassportSectionBody({
  data,
  bookingServices,
}: {
  data: VehiclePassportData;
  bookingServices: string[];
}) {
  const [isOpen, setIsOpen] = useState(!data.is_complete);
  const [renderedAt] = useState(() => Date.now());
  const contentId = useId();
  const serviceFlags = getBookingServiceFlags(bookingServices);
  const riskBannerEntry = [...data.recent_services]
    .filter((entry) => {
      if (typeof entry.sort_ms !== "number") {
        return false;
      }
      if (renderedAt - entry.sort_ms > NINETY_DAYS_MS) {
        return false;
      }
      return serviceListsOverlap(
        entry.service_names ?? [entry.service_name],
        bookingServices
      );
    })
    .sort((left, right) => (right.sort_ms ?? 0) - (left.sort_ms ?? 0))[0];

  const riskWeeks =
    riskBannerEntry && typeof riskBannerEntry.sort_ms === "number"
      ? Math.max(1, Math.round((renderedAt - riskBannerEntry.sort_ms) / WEEK_MS))
      : null;

  const tireRows = getSectionRows([
    {
      label: "Brand",
      value: data.passport.tires.brand ?? "Unknown",
      source: data.sources["tires.brand"],
    },
    {
      label: "Model",
      value: data.passport.tires.model ?? "Unknown",
      source: data.sources["tires.model"],
    },
    {
      label: "Size",
      value: buildTireSizeValue(data),
      source: data.sources["tires.size_front"],
    },
    {
      label: "Condition",
      value: tireConditionLabel(data.passport.tires.overall_condition),
      source: data.sources["tires.overall_condition"],
    },
    {
      label: "Run-flat",
      value:
        data.passport.tires.run_flat == null
          ? "Unknown"
          : data.passport.tires.run_flat
            ? "Yes"
            : "No",
      source: data.sources["tires.run_flat"],
    },
  ]);

  const brakeRows = getSectionRows([
    {
      label: "Front pad thickness",
      value: formatNumberValue(data.passport.brakes.front_pad_mm, "mm"),
    },
    {
      label: "Rear pad thickness",
      value: formatNumberValue(data.passport.brakes.rear_pad_mm, "mm"),
    },
    {
      label: "Rotor condition",
      value: rotorConditionLabel(data.passport.brakes.rotor_condition),
    },
  ]);

  const fluidRows = getSectionRows([
    {
      label: "Oil viscosity",
      value: data.passport.fluids.oil_viscosity ?? "Unknown",
      source: data.sources["fluids.oil_viscosity"],
    },
    {
      label: "Oil capacity",
      value: formatNumberValue(data.passport.fluids.oil_capacity_qts, "qts"),
      source: data.sources["fluids.oil_capacity_qts"],
    },
    {
      label: "Oil type",
      value: data.passport.fluids.oil_type ?? "Unknown",
      source: data.sources["fluids.oil_type"],
    },
    {
      label: "Coolant",
      value: data.passport.fluids.coolant_type ?? "Unknown",
      source: data.sources["fluids.coolant_type"],
    },
    {
      label: "Brake fluid",
      value: data.passport.fluids.brake_fluid_type ?? "Unknown",
      source: data.sources["fluids.brake_fluid_type"],
    },
    {
      label: "Transmission fluid",
      value: data.passport.fluids.transmission_fluid_type ?? "Unknown",
      source: data.sources["fluids.transmission_fluid_type"],
    },
  ]);

  const mileageRows = getSectionRows([
    {
      label: "Current",
      value: formatMileage(data.passport.mileage),
      source: data.sources.mileage,
    },
    {
      label: "Velocity",
      value: formatMonthMileage(data.passport.mileage_velocity),
    },
    {
      label: "Last updated",
      value: formatDateLabel(data.passport.last_reported_at),
    },
  ]);

  const usageRows = getSectionRows([
    { label: "Driving type", value: data.usage.driving_type ?? "Unknown" },
    { label: "Ownership", value: data.usage.ownership ?? "Unknown" },
    {
      label: "Modifications",
      value: data.passport.modifications.status
        ? modificationStatusLabel(data.passport.modifications.status)
        : "Unknown",
    },
  ]);

  const sections = [
    {
      key: "tires",
      title: "Tires",
      badge: serviceFlags.hasTireWork ? "Relevant today" : undefined,
      content: <DisplayRows rows={tireRows} sectionTitle="Tires" />,
    },
    {
      key: "brakes",
      title: "Brakes",
      badge: serviceFlags.hasBrakeWork ? "Relevant today" : undefined,
      content: <DisplayRows rows={brakeRows} sectionTitle="Brakes" />,
    },
    {
      key: "fluids",
      title: "Fluids",
      badge: serviceFlags.hasFluidWork ? "Relevant today" : undefined,
      content: <DisplayRows rows={fluidRows} sectionTitle="Fluids" />,
    },
    {
      key: "mileage",
      title: "Mileage",
      content: <DisplayRows rows={mileageRows} sectionTitle="Mileage" />,
    },
    {
      key: "usage",
      title: "Usage",
      content: <DisplayRows rows={usageRows} sectionTitle="Usage" />,
    },
    {
      key: "recent-services",
      title: "Recent services",
      badge: riskBannerEntry ? "Review" : undefined,
      content: (
        <RecentServicesSection
          services={data.recent_services}
          riskBanner={
            riskBannerEntry && riskWeeks ? (
              <RiskBanner
                serviceName={riskBannerEntry.service_name}
                weeksAgo={riskWeeks}
              />
            ) : null
          }
        />
      ),
    },
    {
      key: "mechanic-notes",
      title: "Mechanic notes",
      content: <MechanicNotesSection notes={data.mechanic_notes} />,
    },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-primary/10 bg-card shadow-[0_4px_14px_-6px_rgba(15,23,42,0.08)]">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        aria-controls={contentId}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        <div id={contentId} className="space-y-3 bg-muted/40 p-3 sm:p-4">
          {!data.is_complete ? (
            <FirstVisitNotice />
          ) : (
            <>
              {sections.map((section) => (
                <PanelSection
                  key={section.key}
                  title={section.title}
                  badge={section.badge}
                >
                  {section.content}
                </PanelSection>
              ))}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function FirstVisitNotice({
  children,
}: {
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-primary/15 bg-card px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/5 text-primary">
          <Info className="h-3.5 w-3.5" />
        </div>
        <p className="text-[13px] leading-7 text-foreground/85">
          {children ?? (
            <>
              <span className="font-semibold text-foreground">
                First time this vehicle is visiting a shop on Otopair.
              </span>{" "}
              Please confirm or fill in the vehicle specs below. This data will be
              saved to the vehicle&apos;s profile and will be available on future
              visits.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function RiskBanner({
  serviceName,
  weeksAgo,
}: {
  serviceName: string;
  weeksAgo: number;
}) {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/15 bg-primary/5 px-3 py-2 text-[11px] text-foreground/85">
      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span>
        {serviceName} was performed {weeksAgo} week{weeksAgo === 1 ? "" : "s"} ago.
        Verify the work before proceeding.
      </span>
    </div>
  );
}

function PanelSection({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-primary/10 bg-card px-3 py-2.5 sm:px-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-primary">
          {title}
        </p>
        {badge ? (
          <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-primary">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="mt-1 divide-y divide-primary/10">{children}</div>
    </section>
  );
}

function DisplayRows({
  rows,
  sectionTitle,
}: {
  rows: SectionRow[];
  sectionTitle: string;
}) {
  if (rows.length === 0) {
    return <EmptySectionRow />;
  }

  return (
    <>
      {rows.map((row, index) => (
        <DisplayRow
          key={`${sectionTitle}-${row.label}-${row.value}-${index}`}
          label={row.label}
          value={row.value}
          source={row.source}
        />
      ))}
    </>
  );
}

function EmptySectionRow() {
  return (
    <p className="py-2 text-[11px] text-muted-foreground">
      {EMPTY_SECTION_COPY}
    </p>
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

function RecentServicesSection({
  services,
  riskBanner,
}: {
  services: VehiclePassportData["recent_services"];
  riskBanner?: ReactNode;
}) {
  return (
    <>
      {riskBanner}
      {services.length === 0 ? (
        <p className="py-2 text-center text-[11px] italic text-muted-foreground">
          No previous services on Otopair
        </p>
      ) : (
        services.map((entry, index) => (
          <div
            key={`${entry.date_label}-${entry.service_name}-${index}`}
            className="flex items-center justify-between gap-3 py-2 text-[12px]"
          >
            <span className="text-muted-foreground">{entry.date_label}</span>
            <span className="font-medium text-foreground">{entry.service_name}</span>
          </div>
        ))
      )}
    </>
  );
}

function MechanicNotesSection({
  notes,
}: {
  notes: VehiclePassportData["mechanic_notes"];
}) {
  if (notes.length === 0) {
    return (
      <p className="py-2 text-center text-[11px] italic text-muted-foreground">
        No mechanic notes recorded yet
      </p>
    );
  }

  return (
    <div className="space-y-2 py-2">
      {notes.map((entry, index) => (
        <div
          key={`${entry.author}-${entry.date_label}-${entry.note}-${index}`}
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
  );
}

export function SourceBadge({
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
