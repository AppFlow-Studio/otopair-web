"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";

type JobActualPart = {
  part_name: string;
  oem_number: string;
  cost: number;
};

type JobActualDetails = {
  status: "draft" | "finalized";
  startedAt?: number | null;
  completedAtMs?: number | null;
  actualLaborMinutes?: number | null;
  actualPartsCost?: number | null;
  difficultyRating?: number | null;
  technicianNotes?: string;
  partsUsed?: JobActualPart[];
} | null;

type PrefillData = {
  vehicleLabel: string;
  serviceName: string;
  suggestedParts: JobActualPart[];
} | null | undefined;

export type JobActualsPayload = {
  actual_labor_minutes?: number | null;
  actual_parts_cost?: number | null;
  difficulty_rating?: number | null;
  technician_notes?: string | null;
  parts_used?: JobActualPart[] | null;
};

type PartRowState = {
  part_name: string;
  oem_number: string;
  cost: string;
};

function toNumberString(value?: number | null) {
  return value == null ? "" : String(value);
}

function buildPartRows(parts?: JobActualPart[]) {
  if (!parts || parts.length === 0) return [];
  return parts.map((part) => ({
    part_name: part.part_name,
    oem_number: part.oem_number,
    cost: toNumberString(part.cost),
  }));
}

function getDefaultLaborMinutes(
  jobActuals: JobActualDetails,
  estimatedLaborMinutes?: number | null
) {
  if (jobActuals?.actualLaborMinutes != null) {
    return jobActuals.actualLaborMinutes;
  }

  if (jobActuals?.startedAt != null) {
    const endedAt = jobActuals.completedAtMs ?? Date.now();
    return Math.max(0, Math.round((endedAt - jobActuals.startedAt) / 60000));
  }

  return estimatedLaborMinutes ?? null;
}

function toPayload(parts: PartRowState[], values: {
  laborMinutes: string;
  partsCost: string;
  difficultyRating: string;
  technicianNotes: string;
}): JobActualsPayload {
  const normalizedParts = parts
    .filter((part) => part.part_name.trim() || part.oem_number.trim() || part.cost.trim())
    .map((part) => ({
      part_name: part.part_name.trim(),
      oem_number: part.oem_number.trim(),
      cost: Number(part.cost || 0),
    }));

  return {
    actual_labor_minutes:
      values.laborMinutes.trim() === "" ? null : Number(values.laborMinutes),
    actual_parts_cost:
      values.partsCost.trim() === "" ? null : Number(values.partsCost),
    difficulty_rating:
      values.difficultyRating.trim() === "" ? null : Number(values.difficultyRating),
    technician_notes: values.technicianNotes,
    parts_used: normalizedParts,
  };
}

export default function JobActualsDialog({
  open,
  mode,
  estimatedLaborMinutes,
  jobActuals,
  prefillData,
  onClose,
  onCompleteOnly,
  onSaveDraft,
  onFinalize,
}: {
  open: boolean;
  mode: "complete" | "edit";
  estimatedLaborMinutes?: number | null;
  jobActuals: JobActualDetails;
  prefillData: PrefillData;
  onClose: () => void;
  onCompleteOnly?: (payload: JobActualsPayload) => Promise<void>;
  onSaveDraft?: (payload: JobActualsPayload) => Promise<void>;
  onFinalize: (payload: JobActualsPayload) => Promise<void>;
}) {
  const [laborMinutes, setLaborMinutes] = useState("");
  const [partsCost, setPartsCost] = useState("");
  const [difficultyRating, setDifficultyRating] = useState("");
  const [technicianNotes, setTechnicianNotes] = useState("");
  const [parts, setParts] = useState<PartRowState[]>([]);
  const [activeAction, setActiveAction] = useState<"complete" | "draft" | "finalize" | null>(null);

  useEffect(() => {
    if (!open) return;

    setLaborMinutes(
      toNumberString(getDefaultLaborMinutes(jobActuals, estimatedLaborMinutes))
    );
    setPartsCost(toNumberString(jobActuals?.actualPartsCost ?? null));
    setDifficultyRating(toNumberString(jobActuals?.difficultyRating ?? null));
    setTechnicianNotes(jobActuals?.technicianNotes ?? "");
    setParts(buildPartRows(jobActuals?.partsUsed));
    setActiveAction(null);
  }, [estimatedLaborMinutes, jobActuals, open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const suggestedParts = prefillData?.suggestedParts ?? [];
  const title =
    mode === "complete" ? "Complete booking and capture details" : "Finalize booking details";
  const description =
    mode === "complete"
      ? "You can complete now and keep details as a draft, or finalize them immediately."
      : "Update or finalize the booking details recorded for this booking.";

  const actionDisabled = activeAction !== null;

  const vehicleSummary = useMemo(() => {
    const serviceName = prefillData?.serviceName;
    const vehicleLabel = prefillData?.vehicleLabel;
    return [serviceName, vehicleLabel].filter(Boolean).join(" - ");
  }, [prefillData?.serviceName, prefillData?.vehicleLabel]);

  async function runAction(
    action: "complete" | "draft" | "finalize",
    fn: ((payload: JobActualsPayload) => Promise<void>) | undefined
  ) {
    if (!fn) return;
    setActiveAction(action);
    try {
      await fn(
        toPayload(parts, {
          laborMinutes,
          partsCost,
          difficultyRating,
          technicianNotes,
        })
      );
      onClose();
    } finally {
      setActiveAction(null);
    }
  }

  function updatePart(index: number, next: Partial<PartRowState>) {
    setParts((current) =>
      current.map((part, partIndex) =>
        partIndex === index
          ? {
              ...part,
              ...next,
            }
          : part
      )
    );
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            {vehicleSummary ? (
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-primary/80">
                {vehicleSummary}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Labor minutes</span>
            <input
              type="number"
              min="0"
              step="1"
              value={laborMinutes}
              onChange={(event) => setLaborMinutes(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
              placeholder={estimatedLaborMinutes != null ? String(estimatedLaborMinutes) : "Auto"}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Parts cost</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={partsCost}
              onChange={(event) => setPartsCost(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
              placeholder="Optional"
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Difficulty rating</span>
            <select
              value={difficultyRating}
              onChange={(event) => setDifficultyRating(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
            >
              <option value="">Not set</option>
              <option value="1">1 - Easy</option>
              <option value="2">2</option>
              <option value="3">3 - Typical</option>
              <option value="4">4</option>
              <option value="5">5 - Hard</option>
            </select>
          </label>

          <label className="space-y-1.5 md:col-span-2">
            <span className="text-sm font-medium text-foreground">Technician notes</span>
            <textarea
              value={technicianNotes}
              onChange={(event) => setTechnicianNotes(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
              placeholder="Optional notes about the job outcome"
            />
          </label>
        </div>

        <div className="mt-6 rounded-xl border border-border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">Parts used</p>
              <p className="text-xs text-muted-foreground">
                Leave blank if you do not want to record itemized parts yet.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {suggestedParts.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setParts(buildPartRows(suggestedParts))}
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Load suggested parts
                </button>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  setParts((current) => [
                    ...current,
                    { part_name: "", oem_number: "", cost: "" },
                  ])
                }
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" />
                Add part
              </button>
            </div>
          </div>

          {parts.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No parts recorded yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {parts.map((part, index) => (
                <div
                  key={`${index}-${part.part_name}-${part.oem_number}`}
                  className="grid gap-2 rounded-lg border border-border bg-background p-3 md:grid-cols-[1.5fr_1.2fr_0.8fr_auto]"
                >
                  <input
                    type="text"
                    value={part.part_name}
                    onChange={(event) => updatePart(index, { part_name: event.target.value })}
                    className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
                    placeholder="Part name"
                  />
                  <input
                    type="text"
                    value={part.oem_number}
                    onChange={(event) => updatePart(index, { oem_number: event.target.value })}
                    className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
                    placeholder="OEM / SKU"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={part.cost}
                    onChange={(event) => updatePart(index, { cost: event.target.value })}
                    className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
                    placeholder="Cost"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setParts((current) => current.filter((_, partIndex) => partIndex !== index))
                    }
                    className="inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={actionDisabled}
            className="rounded-lg border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          {mode === "complete" ? (
            <button
              type="button"
              onClick={() => void runAction("complete", onCompleteOnly)}
              disabled={actionDisabled}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {activeAction === "complete" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Complete only
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runAction("draft", onSaveDraft)}
              disabled={actionDisabled}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {activeAction === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save draft
            </button>
          )}
          <button
            type="button"
            onClick={() => void runAction("finalize", onFinalize)}
            disabled={actionDisabled}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {activeAction === "finalize" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {mode === "complete" ? "Complete & save details" : "Finalize details"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
