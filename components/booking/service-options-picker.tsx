"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { Loader2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
} from "@/components/drawer-panel-styles";
import { cn } from "@/lib/utils";

export type SelectedServiceOption = {
  service_id: Id<"services">;
  option_id: Id<"service_options">;
  option_label: string;
  option_type?: string;
};

export interface ServiceOptionsPickerProps {
  open: boolean;
  serviceIds: Id<"services">[];
  initialSelections?: SelectedServiceOption[];
  laborRate?: number | null;
  onCancel: () => void;
  onConfirm: (selections: SelectedServiceOption[]) => void;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function quoteFor(
  option: {
    labor_hours?: number | null;
    parts_cost_low?: number | null;
    parts_cost_high?: number | null;
    state_fee?: number | null;
  },
  laborRate: number,
): { low: number; high: number } | null {
  const labor = (option.labor_hours ?? 0) * laborRate;
  const partsLow = option.parts_cost_low ?? 0;
  const partsHigh = option.parts_cost_high ?? option.parts_cost_low ?? 0;
  const fee = option.state_fee ?? 0;
  const low = labor + partsLow + fee;
  const high = labor + partsHigh + fee;
  if (low <= 0 && high <= 0) return null;
  return { low, high };
}

function humanizeOptionType(type?: string | null) {
  if (!type) return "Pick an option";
  return `Pick ${type.replace(/_/g, " ")}`;
}

export default function ServiceOptionsPicker({
  open,
  serviceIds,
  initialSelections = [],
  laborRate,
  onCancel,
  onConfirm,
}: ServiceOptionsPickerProps) {
  const groups = useQuery(
    api.service_options.getByServiceIds,
    open ? { serviceIds } : "skip",
  );

  const [selections, setSelections] = useState<Map<string, SelectedServiceOption>>(
    new Map(),
  );

  useEffect(() => {
    if (!open) return;
    const next = new Map<string, SelectedServiceOption>();
    for (const sel of initialSelections) next.set(String(sel.service_id), sel);
    setSelections(next);
  }, [open, initialSelections]);

  const rate = laborRate && laborRate > 0 ? laborRate : 120;

  const allPicked = useMemo(() => {
    if (!groups) return false;
    if (groups.length === 0) return true;
    return groups.every((g: any) => selections.has(String(g.serviceId)));
  }, [groups, selections]);

  // If the server reports none of these services actually require an option
  // pick (no rows in service_options), auto-close so the booking flow can
  // proceed. Prevents the "None of the selected services need extra options"
  // dead end when has_options is true but the table is empty.
  useEffect(() => {
    if (!open || groups === undefined) return;
    if (groups.length === 0) onConfirm([]);
  }, [open, groups, onConfirm]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-card shadow-xl max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h3 className="text-base font-semibold">Pick service options</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each option-based service needs a pick before booking.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {groups === undefined ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None of the selected services need extra options.
            </p>
          ) : (
            <div className="space-y-5">
              {groups.map((group: any) => {
                const picked = selections.get(String(group.serviceId));
                const optionType = group.options[0]?.option_type ?? null;
                const serviceName = group.serviceName ?? "Service";
                return (
                  <div key={group.serviceId} className="space-y-2">
                    <div>
                      <p className="text-sm font-semibold">{serviceName}</p>
                      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        {humanizeOptionType(optionType)}
                      </p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.options.map((opt: any) => {
                        const isActive = picked?.option_id === opt._id;
                        const quote = quoteFor(opt, rate);
                        return (
                          <button
                            key={opt._id}
                            type="button"
                            onClick={() =>
                              setSelections((current) => {
                                const next = new Map(current);
                                next.set(String(group.serviceId), {
                                  service_id: group.serviceId,
                                  option_id: opt._id,
                                  option_label: opt.option_label,
                                  option_type: opt.option_type ?? undefined,
                                });
                                return next;
                              })
                            }
                            className={cn(
                              "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors",
                              isActive
                                ? "border-primary bg-primary/5"
                                : "border-border bg-background hover:bg-muted",
                            )}
                          >
                            <span className="text-sm font-medium">
                              {opt.option_label}
                            </span>
                            {quote ? (
                              <span className="text-xs text-muted-foreground">
                                {quote.low === quote.high
                                  ? formatCurrency(quote.low)
                                  : `${formatCurrency(quote.low)} – ${formatCurrency(quote.high)}`}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <span className="text-xs text-muted-foreground">
            {groups
              ? `${selections.size}/${groups.length} picked`
              : ""}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className={drawerSecondaryButtonClassName}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(Array.from(selections.values()))}
              disabled={!allPicked}
              className={drawerPrimaryButtonClassName}
            >
              Confirm options
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
