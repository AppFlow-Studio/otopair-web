"use client";

// Pinned vehicle-detail panel for the shop quote-submission dialogs
// (tire + rotor). The data half of a quote is locked (VIN mandatory); this is
// the UI half — the mechanic needs the vehicle's spec persistently visible
// while building the quote, plus one-tap copy so they can paste the VIN / size
// straight into their parts-sourcing system.

import { useState } from "react";
import { Car, Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export type QuoteVehicle = {
  year: number | null;
  make: string | null;
  model: string | null;
  trim?: string | null;
  /** engine · trim · chassis, resolved server-side (may be null) */
  spec_label?: string | null;
  image_url?: string | null;
} | null;

/** One job-spec row (tire size, axle, tier…) shown under the vehicle. */
export type QuoteSpecItem = {
  label: string;
  value: string;
  /** Render an inline copy button for this value. */
  copyable?: boolean;
  /** Include this row as `label: value` in the "Copy details" text block. */
  includeInCopyAll?: boolean;
};

function vehicleTitle(v: QuoteVehicle): string {
  if (!v) return "Unknown vehicle";
  const parts = [v.year, v.make, v.model].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown vehicle";
}

function CopyButton({
  value,
  ariaLabel,
  className,
}: {
  value: string;
  ariaLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — ignore */
        }
      }}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
      aria-label={copied ? "Copied" : ariaLabel}
      title={copied ? "Copied" : ariaLabel}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

export function QuoteVehiclePanel({
  vehicle,
  vin,
  specItems = [],
  className,
}: {
  vehicle: QuoteVehicle;
  vin: string;
  specItems?: QuoteSpecItem[];
  className?: string;
}) {
  const [justCopiedAll, setJustCopiedAll] = useState(false);
  const title = vehicleTitle(vehicle);
  const detailLine =
    vehicle?.spec_label ?? (vehicle?.trim ? `${vehicle.trim} trim` : null);

  // One paste-able block the mechanic can drop into their parts system.
  const copyAllText = [
    vehicle?.trim && !vehicle.spec_label ? `${title} ${vehicle.trim}` : title,
    `VIN: ${vin}`,
    ...(vehicle?.spec_label ? [vehicle.spec_label] : []),
    ...specItems
      .filter((s) => s.includeInCopyAll !== false)
      .map((s) => `${s.label}: ${s.value}`),
  ].join("\n");

  return (
    <div
      className={cn(
        "shrink-0 border-b border-border bg-card px-5 py-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {/* Vehicle photo (or fallback) */}
        {vehicle?.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={vehicle.image_url}
            alt={title}
            className="h-14 w-20 shrink-0 rounded-md object-cover ring-1 ring-border"
          />
        ) : (
          <span
            className="inline-flex h-14 w-20 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-border"
            aria-hidden="true"
          >
            <Car className="h-6 w-6" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold leading-tight text-foreground">
              {title}
              {vehicle?.trim && !vehicle.spec_label ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  {vehicle.trim}
                </span>
              ) : null}
            </p>
            <button
              type="button"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(copyAllText);
                  setJustCopiedAll(true);
                  window.setTimeout(() => setJustCopiedAll(false), 1500);
                } catch {
                  /* ignore */
                }
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Copy vehicle details"
            >
              {justCopiedAll ? (
                <>
                  <Check className="h-3 w-3 text-emerald-600" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" /> Copy details
                </>
              )}
            </button>
          </div>

          {detailLine ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {detailLine}
            </p>
          ) : null}

          {/* VIN — the mechanic's primary parts-search key */}
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              VIN
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {vin}
            </span>
            <CopyButton value={vin} ariaLabel="Copy VIN" />
          </div>
        </div>
      </div>

      {/* Job-spec rows (tire size / axle / tier…) */}
      {specItems.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-1 rounded-md border border-border bg-muted/30 px-3 py-2">
          {specItems.map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="text-muted-foreground">{item.label}</span>
              <span className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">{item.value}</span>
                {item.copyable ? (
                  <CopyButton
                    value={item.value}
                    ariaLabel={`Copy ${item.label.toLowerCase()}`}
                  />
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
