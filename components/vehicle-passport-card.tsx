"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import {
  AlertCircle,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  History,
  MessageSquare,
  Settings2,
  Wrench,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import VehiclePassportSection from "@/components/vehicle-passport-section";
import {
  formatMileage,
  type VehiclePassportData,
} from "@/lib/vehicle-passport";
import { StatusPill } from "@/components/status-pill";

interface VinHistoryPart {
  partName: string;
  oemNumber: string | null;
  brand: string | null;
  quantity: number;
  cost: number;
  suppliedBy: "shop" | "customer" | null;
}

interface VinHistoryEntry {
  bookingId: Id<"bookings">;
  serviceNames: string[];
  status: string;
  scheduledDate: string | null;
  completedAtMs: number | null;
  totalCost: number | null;
  laborCost: number | null;
  partsCost: number | null;
  actualLaborMinutes: number | null;
  completionMileage: number | null;
  mechanicName: string | null;
  difficultyRating: number | null;
  mechanicFindings: string | null;
  technicianNotes: string | null;
  postjobReport: unknown;
  flaggedVehicleSpecs: boolean;
  partsUsed: VinHistoryPart[];
}

interface VehiclePassportCardJob {
  _id: Id<"bookings">;
  vin: string;
  vehicle: string;
  serviceNames: string[];
  totalCost: number;
  laborCost: number;
  partsCost: number;
  estimatedLaborMinutes?: number | null;
  quotedBreakdown?: {
    parts_cents: number;
    labor_cents: number;
    tax_cents: number;
    service_fee_cents: number;
  } | null;
  pricedPartsSnapshot?: Array<{
    service_id: string;
    part_id?: string;
    oem_number: string;
    part_name: string;
    brand?: string;
    part_tier?: string;
    quantity: number;
    unit_price_cents: number;
    line_total_cents: number;
  }> | null;
  customerNotes?: string | null;
}

interface VehiclePassportCardProps {
  job: VehiclePassportCardJob;
  passport: VehiclePassportData | null | undefined;
  className?: string;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return formatCurrency(cents / 100);
}

function formatLaborHours(minutes?: number | null): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return "—";
  }
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

function formatLaborMinutes(minutes?: number | null): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return "—";
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes - hours * 60);
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

interface SectionShellProps {
  icon: typeof Car;
  title: string;
  rightSlot?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({
  icon: Icon,
  title,
  rightSlot,
  defaultOpen = false,
  children,
}: SectionShellProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2.5">
          <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </span>
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          {rightSlot}
          {open ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-border bg-background px-4 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

function JobScopeSection({ job }: { job: VehiclePassportCardJob }) {
  // The effective AGREED quote — the latest customer-approved mechanic
  // adjustment, if any. When present its frozen breakdown (which reconciles to
  // its total) replaces the original so the scope reflects what the customer
  // actually agreed to, with original → adjusted on the total.
  const effectiveQuote = useQuery(
    (api as any).booking_approvals.getEffectiveQuoteForBooking,
    { bookingId: job._id },
  ) as
    | {
        totalCents: number;
        partsCents: number;
        laborCents: number;
        taxCents: number;
        feeCents: number;
        partsSnapshot: Array<{
          part_name: string;
          brand?: string | null;
          oem_number: string;
          cost: number;
          quantity?: number;
        }>;
      }
    | null
    | undefined;

  const partsRows = effectiveQuote
    ? effectiveQuote.partsSnapshot.map((p) => ({
        part_name: p.part_name,
        oem_number: p.oem_number,
        brand: p.brand ?? null,
        quantity: p.quantity ?? 1,
        lineCents: Math.round((p.cost ?? 0) * (p.quantity ?? 1) * 100),
      }))
    : (job.pricedPartsSnapshot ?? []).map((p) => ({
        part_name: p.part_name,
        oem_number: p.oem_number,
        brand: p.brand ?? null,
        quantity: p.quantity,
        lineCents: p.line_total_cents,
      }));

  const partsCents = effectiveQuote
    ? effectiveQuote.partsCents
    : Math.round(job.partsCost * 100);
  const laborCents = effectiveQuote
    ? effectiveQuote.laborCents
    : Math.round(job.laborCost * 100);
  const taxCents = effectiveQuote
    ? effectiveQuote.taxCents
    : (job.quotedBreakdown?.tax_cents ?? null);
  const feeCents = effectiveQuote
    ? effectiveQuote.feeCents
    : (job.quotedBreakdown?.service_fee_cents ?? null);
  const totalCents = effectiveQuote
    ? effectiveQuote.totalCents
    : Math.round(job.totalCost * 100);
  const originalTotalCents = Math.round(job.totalCost * 100);
  const wasAdjusted =
    effectiveQuote != null && originalTotalCents !== totalCents;

  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
          SERVICES
        </p>
        <ul className="mt-1 space-y-0.5">
          {job.serviceNames.length === 0 ? (
            <li className="text-muted-foreground">No services on file.</li>
          ) : (
            job.serviceNames.map((name, i) => (
              <li key={`${name}-${i}`} className="text-foreground">
                {name}
              </li>
            ))
          )}
        </ul>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
            PARTS
          </p>
          {wasAdjusted ? (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              Quote adjusted
            </span>
          ) : null}
        </div>
        {partsRows.length === 0 ? (
          <p className="mt-1 text-muted-foreground">No parts on this quote.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {partsRows.map((p, i) => (
              <li
                key={`${p.oem_number}-${i}`}
                className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {p.part_name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.oem_number}
                    {p.brand ? ` · ${p.brand}` : ""}
                    {p.quantity > 1 ? ` · ×${p.quantity}` : ""}
                  </p>
                </div>
                <p className="shrink-0 tabular-nums text-foreground">
                  {formatCents(p.lineCents)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Parts subtotal</span>
          <span className="tabular-nums text-foreground">
            {formatCents(partsCents)}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Labor ({formatLaborHours(job.estimatedLaborMinutes)})
          </span>
          <span className="tabular-nums text-foreground">
            {formatCents(laborCents)}
          </span>
        </div>
        {taxCents != null ? (
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Tax</span>
            <span className="tabular-nums text-foreground">
              {formatCents(taxCents)}
            </span>
          </div>
        ) : null}
        {feeCents != null ? (
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Otopair service fee</span>
            <span className="tabular-nums text-foreground">
              {formatCents(feeCents)}
            </span>
          </div>
        ) : null}
        <div className="mt-2 flex items-center justify-between text-sm font-semibold">
          <span className="text-foreground">Total</span>
          <span className="flex items-baseline gap-2">
            {wasAdjusted ? (
              <span className="text-xs font-medium tabular-nums text-muted-foreground line-through">
                {formatCents(originalTotalCents)}
              </span>
            ) : null}
            <span className="tabular-nums text-foreground">
              {formatCents(totalCents)}
            </span>
          </span>
        </div>
        {wasAdjusted ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Customer approved an adjustment from the original quote.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function HistoryEntryRow({ entry }: { entry: VinHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const when = entry.completedAtMs
    ? new Date(entry.completedAtMs).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : entry.scheduledDate ?? "—";

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 py-2.5 text-left transition-colors hover:opacity-80"
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-start gap-2">
          {open ? (
            <ChevronDown
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {entry.serviceNames.join(", ") || "Service"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {when}
              {entry.mechanicName ? ` · ${entry.mechanicName}` : ""}
              {entry.partsUsed.length > 0
                ? ` · ${entry.partsUsed.length} part${entry.partsUsed.length === 1 ? "" : "s"}`
                : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusPill status={entry.status} />
          {entry.totalCost != null ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatCurrency(entry.totalCost)}
            </span>
          ) : null}
        </div>
      </button>

      {open && (
        <div className="space-y-3 pb-3 pl-6 pt-1">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
                LABOR
              </p>
              <p className="mt-0.5 text-foreground">
                {formatLaborMinutes(entry.actualLaborMinutes)}
                {entry.laborCost != null
                  ? ` · ${formatCurrency(entry.laborCost)}`
                  : ""}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
                MILEAGE
              </p>
              <p className="mt-0.5 text-foreground">
                {entry.completionMileage != null
                  ? formatMileage(entry.completionMileage)
                  : "—"}
              </p>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
              PARTS USED
            </p>
            {entry.partsUsed.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                No parts recorded on this visit.
              </p>
            ) : (
              <ul className="mt-1 divide-y divide-border">
                {entry.partsUsed.map((part, idx) => {
                  const qty = part.quantity > 1 ? ` · ×${part.quantity}` : "";
                  const supplier =
                    part.suppliedBy === "customer" ? " · Customer-supplied" : "";
                  const lineCost =
                    part.suppliedBy === "customer"
                      ? "—"
                      : formatCurrency(part.cost * (part.quantity || 1));
                  return (
                    <li
                      key={`${part.oemNumber ?? part.partName}-${idx}`}
                      className="flex items-start justify-between gap-3 py-2 text-xs first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {part.partName}
                        </p>
                        <p className="truncate text-muted-foreground">
                          {part.oemNumber ?? "No OEM #"}
                          {part.brand ? ` · ${part.brand}` : ""}
                          {qty}
                          {supplier}
                        </p>
                      </div>
                      <span className="shrink-0 tabular-nums text-foreground">
                        {lineCost}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {entry.mechanicFindings ? (
            <div>
              <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
                MECHANIC FINDINGS
              </p>
              <p className="mt-1 text-xs leading-relaxed text-foreground">
                {entry.mechanicFindings}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}

function ServiceHistorySection({
  history,
}: {
  history: VinHistoryEntry[] | undefined;
}) {
  if (history === undefined) {
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  }
  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No prior visits for this VIN at your shop.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {history.map((entry: VinHistoryEntry) => (
        <HistoryEntryRow key={String(entry.bookingId)} entry={entry} />
      ))}
    </ul>
  );
}

function PreviousMechanicFeedbackSection({
  history,
}: {
  history: VinHistoryEntry[] | undefined;
}) {
  if (history === undefined) {
    return <p className="text-sm text-muted-foreground">Loading feedback…</p>;
  }
  const withFeedback = history.filter(
    (h) => h.mechanicFindings || h.technicianNotes || h.difficultyRating != null,
  );
  if (withFeedback.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No previous mechanic feedback recorded for this vehicle.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {withFeedback.map((entry: VinHistoryEntry) => {
        const when = entry.completedAtMs
          ? new Date(entry.completedAtMs).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : entry.scheduledDate ?? "—";
        return (
          <li key={String(entry.bookingId)} className="py-2.5 first:pt-0 last:pb-0">
            <div className="mb-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                {when}
                {entry.mechanicName ? ` · ${entry.mechanicName}` : ""}
              </span>
              {entry.difficultyRating != null && (
                <span className="text-[11px] font-medium text-foreground">
                  Difficulty {entry.difficultyRating}/5
                </span>
              )}
            </div>
            {entry.mechanicFindings ? (
              <p className="text-sm text-foreground">
                {entry.mechanicFindings}
              </p>
            ) : null}
            {entry.technicianNotes ? (
              <p className="mt-1 text-xs italic text-muted-foreground">
                Internal note: {entry.technicianNotes}
              </p>
            ) : null}
            {entry.flaggedVehicleSpecs ? (
              <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                Mechanic flagged vehicle specs on this visit
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function NotesSection({
  job,
  passport,
}: {
  job: VehiclePassportCardJob;
  passport: VehiclePassportData | null | undefined;
}) {
  const mods = passport?.passport.modifications;
  const customerNotes = job.customerNotes?.trim();
  const hasMods = mods?.status === "aftermarket_observed" || mods?.notes;
  if (!customerNotes && !hasMods) {
    return (
      <p className="text-sm text-muted-foreground">
        No customer notes or vehicle modifications recorded.
      </p>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      {customerNotes && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
            CUSTOMER NOTES
          </p>
          <p className="mt-1 whitespace-pre-wrap text-foreground">
            {customerNotes}
          </p>
        </div>
      )}
      {hasMods && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
            MODIFICATIONS
          </p>
          <p className="mt-1 text-foreground">
            {mods?.status === "aftermarket_observed"
              ? "Aftermarket observed"
              : "None observed"}
          </p>
          {mods?.notes && (
            <p className="mt-1 text-xs text-muted-foreground">{mods.notes}</p>
          )}
        </div>
      )}
    </div>
  );
}

function VinCopyButton({ vin }: { vin: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(vin);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={copied ? "VIN copied" : "Copy VIN"}
      title={copied ? "Copied" : "Copy VIN"}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

export function VehiclePassportCard({
  job,
  passport,
  className,
}: VehiclePassportCardProps) {
  const partsCount = job.pricedPartsSnapshot?.length ?? 0;
  const mileage = passport?.passport.mileage;

  const history = useQuery(api.vehicle_history.getServiceHistoryForVin, {
    vin: job.vin,
    excludeBookingId: job._id,
    limit: 10,
  }) as VinHistoryEntry[] | undefined;
  const hasPriorVisits = (history?.length ?? 0) > 0;

  return (
    <div className={cn("space-y-2.5", className)}>
      {/* Always-visible header */}
      <div className="rounded-2xl border border-border bg-card px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Car className="h-4 w-4 text-primary" aria-hidden="true" />
              <p className="truncate text-sm font-semibold text-foreground">
                {job.vehicle}
              </p>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <p
                className="break-all font-mono text-[11px] text-muted-foreground"
                title={job.vin}
              >
                {job.vin || "—"}
              </p>
              {job.vin ? <VinCopyButton vin={job.vin} /> : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {typeof mileage === "number"
                ? formatMileage(mileage)
                : "Mileage unknown"}
              {hasPriorVisits
                ? ` · ${history?.length ?? 0} prior visit${(history?.length ?? 0) === 1 ? "" : "s"}`
                : ""}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {formatCurrency(job.totalCost)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {partsCount} part{partsCount === 1 ? "" : "s"} ·{" "}
              {formatLaborHours(job.estimatedLaborMinutes)}
            </p>
          </div>
        </div>
      </div>

      <Section
        icon={ClipboardList}
        title="This job's scope"
        rightSlot={
          <span className="text-[11px] text-muted-foreground">
            {job.serviceNames.length} service
            {job.serviceNames.length === 1 ? "" : "s"} · {partsCount} part
            {partsCount === 1 ? "" : "s"}
          </span>
        }
        defaultOpen
      >
        <JobScopeSection job={job} />
      </Section>

      <div className="px-1">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground">
            VEHICLE CONDITION
          </p>
          {passport ? (
            <p className="text-[10px] text-muted-foreground">
              {passport.completion_percent}% complete
            </p>
          ) : null}
        </div>
        <VehiclePassportSection
          data={passport}
          bookingServices={job.serviceNames}
          hasPriorVisits={hasPriorVisits}
          inline
        />
      </div>

      <Section icon={History} title="Service history for this VIN">
        <ServiceHistorySection history={history} />
      </Section>

      <Section
        icon={MessageSquare}
        title="Previous mechanic feedback"
      >
        <PreviousMechanicFeedbackSection history={history} />
      </Section>

      <Section icon={Settings2} title="Modifications & customer notes">
        <NotesSection job={job} passport={passport} />
      </Section>
    </div>
  );
}

export default VehiclePassportCard;
