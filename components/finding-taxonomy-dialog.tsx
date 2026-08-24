"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CustomJobTaxonomyPicker,
  isCustomJobTaxonomyComplete,
} from "@/components/custom-job-taxonomy-picker";

/**
 * The taxonomy prompt for promoting a FREEFORM inspection finding into mid-job
 * work.
 *
 * A finding that resolved to a service we already offer carries its own taxonomy
 * (inspectionSlugTaxonomy in lib/inspection-template) and is added in one tap —
 * it never opens this. This is only for off-catalog findings, which have nothing
 * to derive a system / work-type from, so a human still has to say where on the
 * car it is and what was done. Every custom_jobs write is gated on that pair by
 * requireCustomJobTaxonomy; without it the add throws "Pick at least one system".
 *
 * One shared modal so the mechanic overlay and the inspection results screen
 * can't drift, themed on design tokens so it reads right in both the dark
 * overlay and the light dialog.
 */
export function FindingTaxonomyDialog({
  open,
  findingName,
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  findingName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (taxonomy: { systemTags: string[]; workType: string }) => void;
}) {
  const [systemTags, setSystemTags] = useState<string[]>([]);
  const [workType, setWorkType] = useState<string | null>(null);

  // Each finding starts from an empty picker — otherwise the last one's tags
  // carry over onto a different service.
  useEffect(() => {
    if (open) {
      setSystemTags([]);
      setWorkType(null);
    }
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const complete = isCustomJobTaxonomyComplete(systemTags, workType);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={busy ? undefined : onCancel}
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl">
        <p className="text-sm font-semibold text-foreground">
          Add “{findingName}” to this job
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          This isn’t one of our catalog services, so tag it before it goes to the
          customer to confirm.
        </p>
        <div className="mt-4">
          <CustomJobTaxonomyPicker
            systemTags={systemTags}
            workType={workType}
            onSystemTagsChange={setSystemTags}
            onWorkTypeChange={setWorkType}
            dense
          />
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
            disabled={!complete || busy}
            onClick={() =>
              complete &&
              workType &&
              onConfirm({ systemTags, workType })
            }
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
