"use client";

// Developers — shared primitives (styles, chips, copy button, helpers) for
// the public API portal: the endpoint Reference and the dashboard quickstart.

import { useState } from "react";
import { LAYER_FORMULA, type LayerLetter } from "@/convex/lib/dataLayers";

export const CARD = "rounded-xl border border-slate-200 bg-white p-5";
export const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
export const MONO = "font-mono text-[12px]";
export const TH =
  "border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400";

export const LAYER_CHIP: Record<string, string> = {
  A: "bg-blue-100 text-blue-700",
  B: "bg-slate-200 text-slate-700",
  C: "bg-amber-100 text-amber-700",
  D: "bg-emerald-100 text-emerald-700",
  E: "bg-purple-100 text-purple-700",
  X: "bg-red-100 text-red-700",
  unknown: "bg-slate-100 text-slate-500",
};

export function LayerChip({ letter }: { letter: LayerLetter | "unknown" }) {
  return (
    <span
      className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold ${LAYER_CHIP[letter]}`}
      title={`Layer ${letter} — ${LAYER_FORMULA}`}
    >
      {letter === "unknown" ? "?" : letter}
    </span>
  );
}

export function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    (process.env.NEXT_PUBLIC_CONVEX_URL ?? "").replace(".convex.cloud", ".convex.site")
  );
}

export function CopyButton({
  text,
  label,
  dark,
}: {
  text: string;
  label?: string;
  dark?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={
        dark
          ? "rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-white/20"
          : "rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
      }
    >
      {copied ? "Copied ✓" : (label ?? "Copy")}
    </button>
  );
}

