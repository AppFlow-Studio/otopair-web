"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

function parseTireSizeParts(value: string) {
  const normalized = value
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^0-9R/]/g, "");
  const match = normalized.match(/^(\d{0,3})(?:\/(\d{0,2}))?(?:R(\d{0,2}))?$/i);
  return {
    width: match?.[1] ?? "",
    aspect: match?.[2] ?? "",
    wheel: match?.[3] ?? "",
  };
}

export function TireSizeInput({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const parts = parseTireSizeParts(value);
  const aspectRef = useRef<HTMLInputElement | null>(null);
  const wheelRef = useRef<HTMLInputElement | null>(null);
  const sanitize = (input: string, max: number) =>
    input.replace(/[^0-9]/g, "").slice(0, max);
  const emit = (width: string, aspect: string, wheel: string) =>
    onChange(width || aspect || wheel ? `${width}/${aspect}R${wheel}` : "");

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-sm",
        "focus-within:ring-2 focus-within:ring-ring focus-within:border-ring",
        className,
      )}
      aria-label="Tire size"
    >
      <input
        inputMode="numeric"
        maxLength={3}
        value={parts.width}
        placeholder="225"
        aria-label="Section width"
        onChange={(event) => {
          const next = sanitize(event.target.value, 3);
          emit(next, parts.aspect, parts.wheel);
          if (next.length === 3) aspectRef.current?.focus();
        }}
        className="w-9 bg-transparent text-center outline-none"
      />
      <span className="text-muted-foreground">/</span>
      <input
        ref={aspectRef}
        inputMode="numeric"
        maxLength={2}
        value={parts.aspect}
        placeholder="65"
        aria-label="Aspect ratio"
        onChange={(event) => {
          const next = sanitize(event.target.value, 2);
          emit(parts.width, next, parts.wheel);
          if (next.length === 2) wheelRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === "Backspace" && !parts.aspect) {
            event.preventDefault();
            emit(parts.width.slice(0, -1), parts.aspect, parts.wheel);
          }
        }}
        className="w-7 bg-transparent text-center outline-none"
      />
      <span className="text-muted-foreground">R</span>
      <input
        ref={wheelRef}
        inputMode="numeric"
        maxLength={2}
        value={parts.wheel}
        placeholder="17"
        aria-label="Wheel diameter"
        onChange={(event) => emit(parts.width, parts.aspect, sanitize(event.target.value, 2))}
        onKeyDown={(event) => {
          if (event.key === "Backspace" && !parts.wheel) {
            event.preventDefault();
            emit(parts.width, parts.aspect.slice(0, -1), parts.wheel);
            aspectRef.current?.focus();
          }
        }}
        className="w-7 bg-transparent text-center outline-none"
      />
    </div>
  );
}
