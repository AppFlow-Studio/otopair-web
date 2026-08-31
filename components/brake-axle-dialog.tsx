"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AxlePosition } from "@/convex/lib/brakeScope";

/**
 * Axle prompt for adding brake/rotor work to a job from the inspection.
 *
 * An originally-booked brake service carries its axle in
 * selected_service_options; a brake line added off-catalog ("Add to this job")
 * has no such option, so the inspection's brake-axle scope
 * (resolveBrakeScopeForBooking) has nothing to read and used to dead-end on
 * "Brake service is missing its required axle selection." This collects that
 * axle at add time. It defaults to "Front and rear" so a mechanic who just taps
 * through is never blocked, and can narrow it to one axle when only that axle is
 * being serviced.
 *
 * One shared modal, themed on design tokens so it reads right in both the dark
 * mechanic overlay and the light inspection dialog — same pattern as
 * FindingTaxonomyDialog.
 */
const AXLE_OPTIONS: { value: AxlePosition; label: string; hint: string }[] = [
  { value: "both", label: "Front and rear", hint: "Both axles" },
  { value: "front", label: "Front", hint: "Front axle only" },
  { value: "rear", label: "Rear", hint: "Rear axle only" },
];

export function BrakeAxleDialog({
  open,
  serviceName,
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  serviceName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (axle: AxlePosition) => void;
}) {
  // Default to "both" so tapping straight through never dead-ends the
  // inspection; reset each time the prompt opens so a prior line's pick doesn't
  // carry onto the next service.
  const [axle, setAxle] = useState<AxlePosition>("both");
  useEffect(() => {
    if (open) setAxle("both");
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={busy ? undefined : onCancel}
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl">
        <p className="text-sm font-semibold text-foreground">
          Which axle for “{serviceName}”?
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Pick the axle this brake work covers so the inspection scopes the right
          corners.
        </p>
        <div className="mt-4 grid gap-2">
          {AXLE_OPTIONS.map((opt) => {
            const selected = axle === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={busy}
                onClick={() => setAxle(opt.value)}
                aria-pressed={selected}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                  selected
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <span className="text-[13px] font-medium text-foreground">
                  {opt.label}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {opt.hint}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/40 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm(axle)}
            className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add to job"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
