"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarRange, Check } from "lucide-react";
import DatePicker from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";
import {
  MAX_CUSTOM_DAYS,
  MAX_INSIGHT_DAYS,
  RANGE_DAYS,
  type RangeKey,
} from "./types";
import { formatWindowLabel, startOfDayMs, todayYmd, ymdOffset } from "./shared";

const PRESETS: Exclude<RangeKey, "custom">[] = ["7d", "30d", "90d"];

/** Common accounting windows, so the usual cases don't need two calendars. */
const QUICK: { label: string; from: () => string; to: () => string }[] = [
  { label: "This month", from: monthStart, to: todayYmd },
  { label: "Last month", from: lastMonthStart, to: lastMonthEnd },
  { label: "Last 6 months", from: () => ymdOffset(-182), to: todayYmd },
  { label: "Year to date", from: yearStart, to: todayYmd },
];

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function lastMonthStart(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function lastMonthEnd(): string {
  const d = new Date();
  d.setDate(0); // last day of previous month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
function yearStart(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function daysBetween(from: string, to: string): number | null {
  const a = startOfDayMs(from);
  const b = startOfDayMs(to);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function DateRangePicker({
  range,
  custom,
  onChange,
}: {
  range: RangeKey;
  custom: { from: string; to: string };
  onChange: (range: RangeKey, custom: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(custom);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(custom), [custom.from, custom.to]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const span = draft.from && draft.to ? daysBetween(draft.from, draft.to) : null;
  const invalid = span != null && span <= 0;
  const tooWide = span != null && span > MAX_CUSTOM_DAYS;
  const beyondInsights = span != null && span > MAX_INSIGHT_DAYS && !tooWide;
  const canApply = !!draft.from && !!draft.to && !invalid && !tooWide;

  function apply() {
    if (!canApply) return;
    onChange("custom", draft);
    setOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className="flex rounded-full bg-muted p-1"
        role="group"
        aria-label="Date range"
      >
        {PRESETS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r, custom)}
            aria-pressed={range === r}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              range === r
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r}
          </button>
        ))}

        <div className="relative" ref={wrapRef}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-pressed={range === "custom"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              range === "custom"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <CalendarRange className="size-3.5" aria-hidden="true" />
            {range === "custom" ? formatWindowLabel(range, custom) : "Custom"}
          </button>

          {open ? (
            <div
              role="dialog"
              aria-label="Choose a custom date range"
              className="absolute right-0 z-50 mt-2 w-[300px] rounded-xl border border-border bg-popover p-4 shadow-lg"
            >
              <div className="flex flex-wrap gap-1.5">
                {QUICK.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => setDraft({ from: q.from(), to: q.to() })}
                    className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-foreground/75 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {q.label}
                  </button>
                ))}
              </div>

              <div className="mt-3 space-y-2">
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    From
                  </span>
                  <DatePicker
                    value={draft.from}
                    onChange={(v) => setDraft((d) => ({ ...d, from: v }))}
                    max={draft.to || todayYmd()}
                    placeholder="Start date"
                    className="mt-1"
                  />
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    To
                  </span>
                  <DatePicker
                    value={draft.to}
                    onChange={(v) => setDraft((d) => ({ ...d, to: v }))}
                    min={draft.from}
                    max={todayYmd()}
                    placeholder="End date"
                    className="mt-1"
                  />
                </div>
              </div>

              {/* Say what the choice costs before it's made, not after. */}
              {invalid ? (
                <p className="mt-3 text-xs text-destructive">
                  The end date has to be on or after the start date.
                </p>
              ) : tooWide ? (
                <p className="mt-3 text-xs text-destructive">
                  Ranges are capped at {MAX_CUSTOM_DAYS} days. You picked {span}.
                </p>
              ) : beyondInsights ? (
                <p className="mt-3 text-xs text-amber-700">
                  {span} days. The transaction list and exports cover the whole
                  range; the revenue-source charts only go back{" "}
                  {MAX_INSIGHT_DAYS} days.
                </p>
              ) : span ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {span} day{span === 1 ? "" : "s"} selected.
                </p>
              ) : null}

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-lg border border-border bg-card py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={!canApply}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Check className="size-3.5" aria-hidden="true" />
                  Apply
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {range === "custom" ? (
        <button
          type="button"
          onClick={() => onChange("30d", custom)}
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Reset to {RANGE_DAYS["30d"]} days
        </button>
      ) : null}
    </div>
  );
}
