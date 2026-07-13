"use client";

// Data · API console — shared primitives (styles, chips, copy button, helpers)
// used across the console sections. Colocated with the page; not exported
// outside app/(portals)/data/api-sandbox/.

import { useState } from "react";
import { LAYER_FORMULA, type LayerLetter } from "@/convex/lib/dataLayers";

export const CARD = "rounded-xl border border-slate-200 bg-white p-5";
export const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
export const MONO = "font-mono text-[12px]";
export const INPUT =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] outline-none focus:border-blue-500";
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

export function ago(ms: number | null): string {
  if (ms == null) return "never";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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

export function StatusPill({ status }: { status: number }) {
  const ok = status >= 200 && status < 300;
  return (
    <span className={`${PILL} ${ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
      {status === 0 ? "network error" : status}
    </span>
  );
}

/** Shown-once plaintext key reveal, shared by the hero banner and the admin
 *  create-key panel. */
export function KeyReveal({
  plaintext,
  note,
  onDismiss,
}: {
  plaintext: string;
  note: string;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4">
      <div className="text-sm font-semibold text-emerald-900">Copy this key now — it is shown once</div>
      <p className="mt-1 text-[12px] text-emerald-800">{note}</p>
      <div className="mt-3 flex items-center gap-2">
        <code
          className={`${MONO} flex-1 overflow-x-auto rounded-lg border border-emerald-200 bg-white px-3 py-2 text-slate-800`}
        >
          {plaintext}
        </code>
        <CopyButton text={plaintext} />
      </div>
      <button
        onClick={onDismiss}
        className="mt-3 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700"
      >
        I&apos;ve stored it safely
      </button>
    </div>
  );
}
