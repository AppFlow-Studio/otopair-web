"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock } from "lucide-react";

type TimePickerProps = {
  /** Time in 24-hour "HH:MM" form. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Increment between options, in minutes. Defaults to 30. */
  minuteStep?: number;
  ariaLabel?: string;
  className?: string;
};

function format12h(value: string): string {
  const [hStr, mStr] = value.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return value || "--:--";
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}

function buildOptions(minuteStep: number, current: string): string[] {
  const step = minuteStep > 0 ? minuteStep : 30;
  const options: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += step) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    options.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  // Keep an off-grid saved value (e.g. 09:15 when stepping by 30) selectable.
  if (/^\d{2}:\d{2}$/.test(current) && !options.includes(current)) {
    options.push(current);
    options.sort();
  }
  return options;
}

/**
 * Otopair-styled replacement for `<input type="time">`. Renders a button that
 * mirrors the app's text inputs and opens a scrollable dropdown of times, so
 * the picker matches the rest of the UI instead of the native browser chrome.
 */
export default function TimePicker({
  value,
  onChange,
  disabled,
  minuteStep = 30,
  ariaLabel,
  className,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  const options = useMemo(
    () => buildOptions(minuteStep, value),
    [minuteStep, value],
  );

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      selectedRef.current?.scrollIntoView({ block: "center" });
    }
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-white px-3.5 py-2.5 text-left text-sm text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:cursor-not-allowed disabled:bg-muted disabled:text-gray-400 ${
          open ? "border-transparent ring-2 ring-ring" : ""
        } ${className ?? ""}`}
      >
        <span>{format12h(value)}</span>
        <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && !disabled && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 right-0 top-full z-30 mt-2 max-h-60 overflow-y-auto rounded-xl border border-border bg-white p-1 shadow-lg"
        >
          {options.map((option) => {
            const selected = option === value;
            return (
              <button
                key={option}
                ref={selected ? selectedRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-foreground hover:bg-muted"
                }`}
              >
                {format12h(option)}
                {selected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
