"use client";

import { useEffect, useState } from "react";
import { Car, Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function formatCurrencyCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format((cents ?? 0) / 100);
}

export function formatMileage(miles: number | null): string {
  if (miles === null || miles === undefined) return "—";
  return `${new Intl.NumberFormat("en-US").format(miles)} mi`;
}

export function formatRelativeLastVisit(ms: number | null): string {
  if (!ms) return "Never";
  const diff = Date.now() - ms;
  if (diff < 0) return formatAbsoluteDate(ms);
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function formatAbsoluteDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const AVATAR_HUES = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700",
  "bg-violet-100 text-violet-700",
  "bg-sky-100 text-sky-700",
  "bg-teal-100 text-teal-700",
  "bg-fuchsia-100 text-fuchsia-700",
];

function hueForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function CustomerAvatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const sizing =
    size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        hueForName(name || "?"),
        sizing,
        className,
      )}
      aria-hidden="true"
    >
      {initialsFromName(name || "?")}
    </span>
  );
}

export function VehicleThumb({
  imageUrl,
  alt,
  className,
}: {
  imageUrl: string | null;
  alt: string;
  className?: string;
}) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={alt}
        className={cn(
          "h-10 w-14 shrink-0 rounded-md object-cover ring-1 ring-gray-200",
          className,
        )}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-md bg-gray-50 text-gray-400 ring-1 ring-gray-200",
        className,
      )}
      aria-hidden="true"
    >
      <Car className="h-5 w-5" />
    </span>
  );
}

export function VinCopyPill({ vin }: { vin: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!vin) return <span className="text-xs text-gray-400">—</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(vin)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
      className="inline-flex items-center gap-1 rounded-md bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-700 ring-1 ring-inset ring-gray-200 transition-colors hover:bg-gray-100"
      title={copied ? "Copied" : "Copy VIN"}
    >
      <span className="max-w-[120px] truncate">{vin}</span>
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3 text-gray-400" />
      )}
    </button>
  );
}

export function TableSkeleton({
  rows = 6,
  cols = 6,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-gray-50 last:border-0">
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c} className="px-5 py-3">
              <div
                className={cn(
                  "h-3 animate-pulse rounded bg-gray-100",
                  c === 0 ? "w-32" : c === cols - 1 ? "w-16" : "w-24",
                )}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-yellow-100 px-0.5 text-yellow-900">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}
