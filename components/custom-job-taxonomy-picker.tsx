"use client";

import {
  CUSTOM_JOB_SYSTEMS,
  CUSTOM_JOB_SYSTEM_MAX,
  CUSTOM_JOB_WORK_TYPES,
  type CustomJobSystem,
  type CustomJobWorkType,
} from "@/lib/custom-job-taxonomy";

/**
 * The two-axis picker for off-catalog work: where on the car, and what was done
 * to it.
 *
 * Shared by every surface that creates a custom job — the booking drawer, the
 * mid-job "what did you find" step, and the shortcut manager — because this
 * codebase has already been bitten once by two copies of the same form drifting
 * apart (see the note above PostJobSurveyDialog's locked-quote props).
 *
 * Chips rather than a select: the whole value proposition is two taps at 11am
 * with dirty hands, and a native select on an iPad is a modal sheet plus a
 * scroll plus a confirm. The `covers` text rides along as a title attribute so
 * "which one is a wheel bearing" is answerable without leaving the form.
 */
export function CustomJobTaxonomyPicker({
  systemTags,
  workType,
  onSystemTagsChange,
  onWorkTypeChange,
  /** Compact spacing for the mid-job sheet, which is tighter than the drawer. */
  dense = false,
}: {
  systemTags: string[];
  workType: string | null;
  onSystemTagsChange: (next: string[]) => void;
  onWorkTypeChange: (next: string) => void;
  dense?: boolean;
}) {
  const atCap = systemTags.length >= CUSTOM_JOB_SYSTEM_MAX;

  function toggleSystem(slug: CustomJobSystem) {
    if (systemTags.includes(slug)) {
      onSystemTagsChange(systemTags.filter((s) => s !== slug));
      return;
    }
    // Silently ignoring the tap at the cap reads as a broken button, so the
    // chip is visibly disabled instead and this is just a backstop.
    if (atCap) return;
    onSystemTagsChange([...systemTags, slug]);
  }

  return (
    <div className={dense ? "space-y-2.5" : "space-y-3"}>
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Where on the car{" "}
            <span className="font-normal normal-case tracking-normal text-destructive">
              *
            </span>
          </p>
          <p className="text-[10px] text-muted-foreground">
            {systemTags.length === 0
              ? `pick 1–${CUSTOM_JOB_SYSTEM_MAX}`
              : `${systemTags.length}/${CUSTOM_JOB_SYSTEM_MAX}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CUSTOM_JOB_SYSTEMS.map((system) => {
            const selected = systemTags.includes(system.slug);
            const disabled = !selected && atCap;
            return (
              <button
                key={system.slug}
                type="button"
                title={system.covers}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => toggleSystem(system.slug)}
                className={[
                  "rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                  selected
                    ? "border-primary bg-primary/10 text-primary"
                    : disabled
                      ? "cursor-not-allowed border-border bg-muted/20 text-muted-foreground/40"
                      : "border-border bg-muted/30 text-foreground hover:border-primary/40 hover:bg-primary/5",
                ].join(" ")}
              >
                {system.label}
              </button>
            );
          })}
        </div>
        {/* The first pick is what the gap-clustering read groups on, so it's
            worth saying out loud rather than leaving as invisible ordering. */}
        {systemTags.length > 1 ? (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Primary:{" "}
            {CUSTOM_JOB_SYSTEMS.find((s) => s.slug === systemTags[0])?.label}
          </p>
        ) : null}
      </div>

      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          What kind of work{" "}
          <span className="font-normal normal-case tracking-normal text-destructive">
            *
          </span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {CUSTOM_JOB_WORK_TYPES.map((type) => {
            const selected = workType === type.slug;
            return (
              <button
                key={type.slug}
                type="button"
                title={type.covers}
                aria-pressed={selected}
                onClick={() => onWorkTypeChange(type.slug)}
                className={[
                  "rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                  selected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-muted/30 text-foreground hover:border-primary/40 hover:bg-primary/5",
                ].join(" ")}
              >
                {type.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Both axes answered — the gate every Add / Save button shares. */
export function isCustomJobTaxonomyComplete(
  systemTags: string[],
  workType: string | null,
): workType is CustomJobWorkType {
  return systemTags.length > 0 && !!workType;
}
