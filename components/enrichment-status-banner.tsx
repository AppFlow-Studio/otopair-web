"use client";

import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

type Props = {
  status?: string | null;
  fillRate?: number | null;
};

export default function EnrichmentStatusBanner({ status, fillRate }: Props) {
  if (!status || status === "complete") return null;

  if (status === "pending" || status === "running") {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-primary">
            Building vehicle profile
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {fillRate != null && fillRate > 0
              ? `${fillRate}% of specs resolved — engine, fluids, and chassis data incoming.`
              : "First time we're seeing this VIN — fetching engine, fluids, and chassis data."}
          </p>
        </div>
      </div>
    );
  }

  if (status === "failed" || status === "manual_review") {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-amber-900">
            Specs need review
          </p>
          <p className="mt-0.5 text-[11px] text-amber-700">
            Some vehicle data couldn&apos;t be confirmed automatically. Verify specs before starting the job.
          </p>
        </div>
      </div>
    );
  }

  if (status === "enriched") {
    if (fillRate != null && fillRate < 70) {
      return (
        <div className="flex items-start gap-2.5 rounded-lg border border-primary/15 bg-muted/50 px-3 py-2.5">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/60" />
          <p className="text-[11px] text-muted-foreground">
            Vehicle profile {fillRate}% complete — some specs may still be missing.
          </p>
        </div>
      );
    }
    return null;
  }

  return null;
}
