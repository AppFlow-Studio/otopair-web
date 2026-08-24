"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface MonthPickerProps {
  value: string; // YYYY-MM; empty string allowed
  onChange: (next: string) => void;
  min?: string; // YYYY-MM
  max?: string; // YYYY-MM
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Parse "YYYY-MM" into {year, month(0-based)} or null. */
function parseYM(s: string): { year: number; month: number } | null {
  if (!s) return null;
  const [y, m] = s.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return { year: y, month: m - 1 };
}

/** Serialize {year, month(0-based)} to "YYYY-MM". */
function toYM(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Compare two YYYY-MM values numerically (year*12 + month). */
function ordinal(ym: { year: number; month: number }): number {
  return ym.year * 12 + ym.month;
}

export default function MonthPicker({
  value,
  onChange,
  min,
  max,
  placeholder = "Select month",
  className,
  disabled,
  "aria-label": ariaLabel,
}: MonthPickerProps) {
  const selected = useMemo(() => parseYM(value), [value]);
  const minYM = useMemo(() => parseYM(min ?? ""), [min]);
  const maxYM = useMemo(() => parseYM(max ?? ""), [max]);

  const now = useMemo(() => new Date(), []);
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(
    () => selected?.year ?? now.getFullYear(),
  );
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Fixed (viewport) coordinates for the portaled popover. Null until measured
  // so the first paint doesn't flash at the wrong spot.
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  // Re-center on the selected year whenever the value changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selected) setViewYear(selected.year);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      // The popover is portaled to <body>, so it's outside wrapperRef — check
      // both before treating a click as "outside" (else selecting a month via
      // mousedown would close the picker before the click lands).
      if (wrapperRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
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

  // Position the portaled popover against the trigger in viewport coordinates,
  // flipping above when there isn't room below. Because it lives on <body> with
  // position:fixed it can't add to the dialog's scroll height or be clipped by
  // the dialog's overflow-y-auto — which is what made the box scrollable.
  useLayoutEffect(() => {
    if (!open) return;
    const GAP = 8;
    const MARGIN = 8;
    function place() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const popH = popoverRef.current?.offsetHeight ?? 240;
      const popW = popoverRef.current?.offsetWidth ?? 260;
      const spaceBelow = window.innerHeight - r.bottom;
      const placeAbove = spaceBelow < popH + GAP && r.top > spaceBelow;
      let top = placeAbove ? r.top - popH - GAP : r.bottom + GAP;
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - popH - MARGIN));
      let left = r.left;
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - popW - MARGIN));
      setCoords({ top, left });
    }
    place();
    // Re-place on scroll (capture: catches the dialog's inner scroll too) and resize.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, viewYear]);

  function isMonthDisabled(month: number): boolean {
    const ord = ordinal({ year: viewYear, month });
    if (minYM && ord < ordinal(minYM)) return true;
    if (maxYM && ord > ordinal(maxYM)) return true;
    return false;
  }

  const display = selected
    ? `${MONTHS[selected.month]} ${selected.year}`
    : "";

  const thisMonthDisabled =
    (minYM && ordinal({ year: now.getFullYear(), month: now.getMonth() }) < ordinal(minYM)) ||
    (maxYM && ordinal({ year: now.getFullYear(), month: now.getMonth() }) > ordinal(maxYM));

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-primary/20 bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20",
          disabled && "cursor-not-allowed opacity-50",
          !display && "text-muted-foreground",
        )}
      >
        <span className="truncate">{display || placeholder}</span>
        <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
        <div
          ref={popoverRef}
          style={{
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            visibility: coords ? "visible" : "hidden",
          }}
          className="fixed z-[9999] w-[260px] rounded-xl border border-border bg-card p-3 shadow-lg"
        >
          {/* Year navigation */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewYear((y) => y - 1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Previous year"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {viewYear}
            </span>
            <button
              type="button"
              onClick={() => setViewYear((y) => y + 1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Next year"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Month grid */}
          <div className="grid grid-cols-4 gap-1.5">
            {MONTHS.map((label, month) => {
              const isSelected =
                selected?.year === viewYear && selected?.month === month;
              const isThisMonth =
                now.getFullYear() === viewYear && now.getMonth() === month;
              const monthDisabled = isMonthDisabled(month);
              return (
                <button
                  key={label}
                  type="button"
                  disabled={monthDisabled}
                  title={`${MONTHS_LONG[month]} ${viewYear}`}
                  onClick={() => {
                    onChange(toYM(viewYear, month));
                    setOpen(false);
                  }}
                  className={cn(
                    "rounded-lg py-2 text-xs font-medium transition-colors",
                    isSelected && "bg-primary font-semibold text-primary-foreground",
                    !isSelected && "text-foreground",
                    !isSelected && isThisMonth && "ring-1 ring-primary/40",
                    !isSelected && !monthDisabled && "hover:bg-muted",
                    monthDisabled && "cursor-not-allowed opacity-30",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={!!thisMonthDisabled}
              onClick={() => {
                if (thisMonthDisabled) return;
                onChange(toYM(now.getFullYear(), now.getMonth()));
                setOpen(false);
              }}
              className={cn(
                "text-xs font-semibold text-primary transition-colors hover:underline",
                thisMonthDisabled && "cursor-not-allowed opacity-40 hover:no-underline",
              )}
            >
              This month
            </button>
          </div>
        </div>,
          document.body,
        )}
    </div>
  );
}
