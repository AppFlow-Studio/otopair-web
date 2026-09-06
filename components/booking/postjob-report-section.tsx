"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  Gauge,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  drawerPrimaryButtonClassName,
  drawerSecondaryButtonClassName,
  DrawerFieldLabel,
} from "@/components/drawer-panel-styles";
import type { PostJobSurveyPayload } from "@/lib/vehicle-passport";
import { formatPartIdentity } from "@/lib/vehicle-passport";
import { formatHoursValue } from "@/lib/labor-units";
import {
  buildPartRows,
  getDefaultLaborMinutes,
  toNumberString,
  toPayload,
  type JobActualDetails,
  type JobActualPart,
  type JobActualsPayload,
  type PartRowState,
} from "@/lib/job-actuals";

type Mode = "view" | "edit";

const TIME_VARIANCE_LABEL: Record<string, string> = {
  faster: "Faster than estimated",
  on_time: "On time",
  slower: "Slower than estimated",
};

const TIME_VARIANCE_REASON_LABEL: Record<string, string> = {
  vehicle_quirk: "Vehicle quirk",
  parts_issue: "Parts issue",
  customer_info_wrong: "Customer info was wrong",
  unexpected_complication: "Unexpected complication",
  easier_than_expected: "Easier than expected",
  experienced_with_platform: "Experienced with platform",
  customer_info_accurate: "Customer info was accurate",
  well_prepped: "Well prepped",
  other: "Other",
};

const PARTS_ACCURACY_LABEL: Record<string, string> = {
  accurate: "Accurate",
  partial: "Partially accurate",
  inaccurate: "Inaccurate",
};

const URGENCY_LABEL: Record<string, string> = {
  next_visit: "Next visit",
  within_3_months: "Within 3 months",
  soon: "Soon",
};

function formatNumber(n: number | null | undefined) {
  if (n == null) return null;
  return new Intl.NumberFormat("en-US").format(n);
}

function formatCurrency(n: number | null | undefined) {
  if (n == null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function formatRelative(ms: number | null | undefined) {
  if (!ms) return null;
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-start gap-3 text-sm">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

function ReportView({ report }: { report: PostJobSurveyPayload }) {
  const tv = report.time_variance ? TIME_VARIANCE_LABEL[report.time_variance] : null;
  const tvReason = report.time_variance_reason
    ? TIME_VARIANCE_REASON_LABEL[report.time_variance_reason]
    : null;
  const accuracy = report.parts_accuracy_status
    ? PARTS_ACCURACY_LABEL[report.parts_accuracy_status]
    : null;

  return (
    <div className="space-y-3">
      {report.completion_mileage != null && (
        <Row label="Mileage">
          <span className="inline-flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {formatNumber(report.completion_mileage)} mi
          </span>
        </Row>
      )}

      {(tv || report.actual_labor_minutes != null) && (
        <Row label="Time">
          <div className="space-y-1">
            {tv && (
              <p>
                {tv}
                {tvReason ? ` · ${tvReason}` : ""}
              </p>
            )}
            {report.actual_labor_minutes != null && (
              <p className="text-muted-foreground">
                Logged: {report.actual_labor_minutes} min
              </p>
            )}
            {report.time_variance_note && (
              <p className="whitespace-pre-wrap text-muted-foreground">
                {report.time_variance_note}
              </p>
            )}
          </div>
        </Row>
      )}

      {(report.difficulty_rating != null || accuracy) && (
        <Row label="Quality">
          <div className="space-y-1">
            {report.difficulty_rating != null && (
              <p>Difficulty: {report.difficulty_rating}/5</p>
            )}
            {accuracy && (
              <p>
                Parts accuracy:{" "}
                <span className="font-medium">{accuracy}</span>
              </p>
            )}
            {report.parts_accuracy_feedback && (
              <p className="whitespace-pre-wrap text-muted-foreground">
                {report.parts_accuracy_feedback}
              </p>
            )}
          </div>
        </Row>
      )}

      {report.parts_used && report.parts_used.length > 0 && (
        <Row label="Parts">
          <div className="space-y-1.5">
            {report.parts_used.map((part, i) => (
              <div
                key={`${i}-${part.oem_number}`}
                className="flex items-start justify-between gap-3 rounded-lg bg-background px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{part.part_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatPartIdentity(part)}
                  </p>
                </div>
                <span className="shrink-0 text-sm">
                  {formatCurrency(part.cost)}
                </span>
              </div>
            ))}
            {report.actual_parts_cost != null && (
              <p className="pt-1 text-right text-xs text-muted-foreground">
                Parts total: {formatCurrency(report.actual_parts_cost)}
              </p>
            )}
          </div>
        </Row>
      )}

      {report.flagged_vehicle_specs && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Vehicle specs flagged</p>
          {report.flagged_vehicle_specs_reason && (
            <p className="mt-1 whitespace-pre-wrap">
              {report.flagged_vehicle_specs_reason}
            </p>
          )}
        </div>
      )}

      {report.technician_notes && (
        <Row label="Tech notes">
          <p className="whitespace-pre-wrap">{report.technician_notes}</p>
        </Row>
      )}

      {report.additional_observations && (
        <Row label="Observations">
          <p className="whitespace-pre-wrap">{report.additional_observations}</p>
        </Row>
      )}

      {report.recommendations && report.recommendations.length > 0 && (
        <Row label="Recommended">
          <ul className="space-y-1">
            {report.recommendations.map((rec, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                <span>
                  {rec.freeform_service_name ?? "Service"}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({URGENCY_LABEL[rec.urgency] ?? rec.urgency})
                  </span>
                  {rec.reason ? (
                    <span className="block text-xs text-muted-foreground">
                      {rec.reason}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Row>
      )}

      {report.postjob_photos && report.postjob_photos.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {report.postjob_photos.length} photo
          {report.postjob_photos.length === 1 ? "" : "s"} attached
        </p>
      )}
    </div>
  );
}

function ReportEditor({
  jobActuals,
  estimatedLaborMinutes,
  suggestedParts,
  isSubmitting,
  onCancel,
  onSaveDraft,
  onFinalize,
}: {
  jobActuals: JobActualDetails;
  estimatedLaborMinutes?: number | null;
  suggestedParts: JobActualPart[];
  isSubmitting: boolean;
  onCancel: () => void;
  onSaveDraft?: (payload: JobActualsPayload) => Promise<void>;
  onFinalize: (payload: JobActualsPayload) => Promise<void>;
}) {
  const [laborHoursText, setLaborHoursText] = useState("");
  const [partsCost, setPartsCost] = useState("");
  const [difficultyRating, setDifficultyRating] = useState("");
  const [technicianNotes, setTechnicianNotes] = useState("");
  const [parts, setParts] = useState<PartRowState[]>([]);
  const [activeAction, setActiveAction] = useState<"draft" | "finalize" | null>(
    null,
  );

  useEffect(() => {
    const defaultLaborMinutes = getDefaultLaborMinutes(
      jobActuals,
      estimatedLaborMinutes,
    );
    setLaborHoursText(
      defaultLaborMinutes != null ? formatHoursValue(defaultLaborMinutes) : "",
    );
    setPartsCost(toNumberString(jobActuals?.actualPartsCost ?? null));
    setDifficultyRating(toNumberString(jobActuals?.difficultyRating ?? null));
    setTechnicianNotes(jobActuals?.technicianNotes ?? "");
    setParts(buildPartRows(jobActuals?.partsUsed));
  }, [jobActuals, estimatedLaborMinutes]);

  function updatePart(index: number, next: Partial<PartRowState>) {
    setParts((current) =>
      current.map((part, i) => (i === index ? { ...part, ...next } : part)),
    );
  }

  async function runAction(
    action: "draft" | "finalize",
    fn: ((payload: JobActualsPayload) => Promise<void>) | undefined,
  ) {
    if (!fn) return;
    setActiveAction(action);
    try {
      await fn(
        toPayload(parts, {
          laborHours: laborHoursText,
          partsCost,
          difficultyRating,
          technicianNotes,
        }),
      );
    } finally {
      setActiveAction(null);
    }
  }

  const disabled = isSubmitting || activeAction !== null;
  const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Labor time (hours)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={laborHoursText}
            onChange={(e) =>
              setLaborHoursText(e.target.value.replace(/[^0-9.]/g, ""))
            }
            className={inputClass}
            placeholder={
              estimatedLaborMinutes != null
                ? formatHoursValue(estimatedLaborMinutes)
                : "Auto"
            }
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Parts cost
          </span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={partsCost}
            onChange={(e) => setPartsCost(e.target.value)}
            className={inputClass}
            placeholder="Optional"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Difficulty
          </span>
          <select
            value={difficultyRating}
            onChange={(e) => setDifficultyRating(e.target.value)}
            className={inputClass}
          >
            <option value="">Not set</option>
            <option value="1">1 — Easy</option>
            <option value="2">2</option>
            <option value="3">3 — Typical</option>
            <option value="4">4</option>
            <option value="5">5 — Hard</option>
          </select>
        </label>

        <label className="space-y-1.5 md:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Technician notes
          </span>
          <textarea
            value={technicianNotes}
            onChange={(e) => setTechnicianNotes(e.target.value)}
            rows={3}
            className={inputClass}
            placeholder="Optional notes about the job outcome"
          />
        </label>
      </div>

      <div className="rounded-xl border border-border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">Parts used</p>
            <p className="text-xs text-muted-foreground">
              Leave blank to skip itemized parts.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {suggestedParts.length > 0 && (
              <button
                type="button"
                onClick={() => setParts(buildPartRows(suggestedParts))}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Load suggested
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                setParts((current) => [
                  ...current,
                  { part_name: "", brand: "", oem_number: "", cost: "" },
                ])
              }
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
              Add part
            </button>
          </div>
        </div>

        {parts.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No parts recorded.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {parts.map((part, index) => (
              <div
                key={index}
                className="grid gap-2 rounded-lg bg-card p-2 md:grid-cols-[1.3fr_1fr_1.1fr_0.8fr_auto]"
              >
                <input
                  type="text"
                  value={part.part_name}
                  onChange={(e) =>
                    updatePart(index, { part_name: e.target.value })
                  }
                  className={inputClass}
                  placeholder="Part name"
                />
                <input
                  type="text"
                  value={part.brand}
                  onChange={(e) => updatePart(index, { brand: e.target.value })}
                  className={inputClass}
                  placeholder="Brand"
                />
                <input
                  type="text"
                  value={part.oem_number}
                  onChange={(e) =>
                    updatePart(index, { oem_number: e.target.value })
                  }
                  className={inputClass}
                  placeholder="OEM / SKU"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={part.cost}
                  onChange={(e) => updatePart(index, { cost: e.target.value })}
                  className={inputClass}
                  placeholder="Cost"
                />
                <button
                  type="button"
                  onClick={() =>
                    setParts((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                  className="inline-flex items-center justify-center rounded-md border border-border px-2 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Remove part"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className={drawerSecondaryButtonClassName}
        >
          Cancel
        </button>
        {onSaveDraft && (
          <button
            type="button"
            onClick={() => void runAction("draft", onSaveDraft)}
            disabled={disabled}
            className={drawerSecondaryButtonClassName}
          >
            {activeAction === "draft" && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            Save draft
          </button>
        )}
        <button
          type="button"
          onClick={() => void runAction("finalize", onFinalize)}
          disabled={disabled}
          className={drawerPrimaryButtonClassName}
        >
          {activeAction === "finalize" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
          Finalize
        </button>
      </div>
    </div>
  );
}

export interface PostjobReportSectionProps {
  report: PostJobSurveyPayload | null | undefined;
  submittedAt: number | null | undefined;
  jobStatus: string | null | undefined;
  jobActuals: JobActualDetails;
  estimatedLaborMinutes?: number | null;
  suggestedParts?: JobActualPart[];
  canEdit: boolean;
  isFinalized: boolean;
  isReopening: boolean;
  isEditing: boolean;
  onRequestEdit: () => void;
  onRequestReopen: () => void;
  onCancelEdit: () => void;
  onSaveDraft?: (payload: JobActualsPayload) => Promise<void>;
  onFinalize: (payload: JobActualsPayload) => Promise<void>;
}

export function PostjobReportSection({
  report,
  submittedAt,
  jobStatus,
  jobActuals,
  estimatedLaborMinutes,
  suggestedParts = [],
  canEdit,
  isFinalized,
  isReopening,
  isEditing,
  onRequestEdit,
  onRequestReopen,
  onCancelEdit,
  onSaveDraft,
  onFinalize,
}: PostjobReportSectionProps) {
  const mode: Mode = isEditing ? "edit" : "view";

  const hasAnything = useMemo(
    () => Boolean(report) || Boolean(jobActuals),
    [report, jobActuals],
  );

  if (!hasAnything && jobStatus !== "completed" && jobStatus !== "in_progress") {
    return null;
  }

  const submittedLabel = formatRelative(submittedAt);

  return (
    <div className="rounded-2xl border border-border bg-muted/20 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <ClipboardCheck
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden
          />
          <DrawerFieldLabel className="mb-0">Post-job report</DrawerFieldLabel>
          {submittedLabel && mode === "view" && (
            <span className="text-xs text-muted-foreground">
              · {submittedLabel}
            </span>
          )}
        </div>
        {canEdit && mode === "view" && (
          isFinalized ? (
            <button
              type="button"
              onClick={onRequestReopen}
              disabled={isReopening}
              className={drawerSecondaryButtonClassName}
            >
              {isReopening && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Reopen
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequestEdit}
              className={drawerSecondaryButtonClassName}
            >
              <Wrench className="h-3.5 w-3.5" />
              Edit details
            </button>
          )
        )}
      </div>

      {mode === "view" ? (
        report ? (
          <ReportView report={report} />
        ) : jobActuals ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Labor:{" "}
              <span className="text-foreground">
                {jobActuals.actualLaborMinutes ?? "TBD"} min
              </span>
            </p>
            <p>
              Parts cost:{" "}
              <span className="text-foreground">
                {jobActuals.actualPartsCost != null
                  ? formatCurrency(jobActuals.actualPartsCost)
                  : "TBD"}
              </span>
            </p>
            {jobActuals.technicianNotes && (
              <p className="whitespace-pre-wrap text-foreground">
                {jobActuals.technicianNotes}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No post-job details recorded yet.
          </p>
        )
      ) : (
        <ReportEditor
          jobActuals={jobActuals}
          estimatedLaborMinutes={estimatedLaborMinutes}
          suggestedParts={suggestedParts}
          isSubmitting={false}
          onCancel={onCancelEdit}
          onSaveDraft={onSaveDraft}
          onFinalize={onFinalize}
        />
      )}
    </div>
  );
}

export default PostjobReportSection;
