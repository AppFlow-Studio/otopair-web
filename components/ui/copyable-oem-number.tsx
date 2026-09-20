"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Part numbers are what a mechanic actually types into a supplier / parts
 * catalog to order or look up a part, so make them one-tap copyable instead of
 * hand-transcribing an OEM string like "17220-5LA-A00". Renders the number with
 * a small trailing copy icon that flips to a check for ~1.2s on success.
 *
 * Falls back to a plain "—" when there's no number. Copy failures (blocked
 * clipboard / insecure context) degrade silently — the text stays selectable.
 *
 * Shared across every surface that shows a part number (booking detail panel,
 * post-job survey, inspection dialog, job actuals, timeline, extra-work status)
 * so the affordance never drifts. Originally lived in post-job-survey-dialog.
 */
export function CopyableOemNumber({
  value,
  className,
  emptyFallback = "—",
}: {
  value: string | null | undefined;
  className?: string;
  /** What to show when there's no part number. Defaults to an em dash. */
  emptyFallback?: string;
}) {
  const [copied, setCopied] = useState(false);
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0)
    return <span className={className}>{emptyFallback}</span>;
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(trimmed);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable — leave the text selectable */
        }
      }}
      title={copied ? "Copied!" : "Copy part number"}
      aria-label={`Copy part number ${trimmed}`}
      className={cn(
        "group inline-flex max-w-full items-center gap-1 text-left font-mono tabular-nums transition-colors hover:text-primary",
        className,
      )}
    >
      <span className="truncate">{trimmed}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-opacity group-hover:text-primary" />
      )}
    </button>
  );
}

export default CopyableOemNumber;
