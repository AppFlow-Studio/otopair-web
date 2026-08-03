"use client";

import { AlertTriangle, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateShort, formatMoneyCents } from "./shared";
import type { ShopDisputeBrief } from "./types";

function deadlineCopy(hoursLeft: number | null): {
  text: string;
  tone: "urgent" | "soon" | "normal" | "passed";
} {
  if (hoursLeft == null) return { text: "No deadline set", tone: "normal" };
  if (hoursLeft <= 0) return { text: "Deadline passed", tone: "passed" };
  const days = Math.floor(hoursLeft / 24);
  if (days < 1) {
    return { text: `${Math.max(1, Math.round(hoursLeft))}h left to respond`, tone: "urgent" };
  }
  if (days < 3) return { text: `${days} day${days === 1 ? "" : "s"} left to respond`, tone: "urgent" };
  return { text: `${days} days left to respond`, tone: days < 7 ? "soon" : "normal" };
}

/**
 * Disputes are READ-ONLY here by design.
 *
 * Evidence submission stays in Stripe Express, which already has the whole
 * flow — per-reason evidence fields, file uploads, Stripe's own deadline
 * handling. Rebuilding a worse version of it in-app would mean a shop owner
 * losing a chargeback because our form was missing a field.
 */
export function DisputeCard({
  dispute,
  onOpenStripe,
}: {
  dispute: ShopDisputeBrief;
  onOpenStripe: () => void;
}) {
  const hoursLeft =
    dispute.evidenceDueByMs != null
      ? (dispute.evidenceDueByMs - Date.now()) / 3_600_000
      : null;
  const deadline = deadlineCopy(dispute.isOpen ? hoursLeft : null);

  return (
    <section
      className={cn(
        "rounded-xl border p-5",
        dispute.isOpen
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-card",
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className={cn(
            "mt-0.5 size-4 shrink-0",
            dispute.isOpen ? "text-destructive" : "text-muted-foreground",
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {dispute.isOpen ? "Open dispute" : "Dispute closed"} ·{" "}
            {dispute.reasonLabel}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatMoneyCents(dispute.amountCents)} disputed on{" "}
            {formatDateShort(dispute.openedAtMs)}
          </p>

          {dispute.isOpen ? (
            <p
              className={cn(
                "mt-2 text-sm font-medium",
                deadline.tone === "urgent" || deadline.tone === "passed"
                  ? "text-destructive"
                  : deadline.tone === "soon"
                    ? "text-amber-700"
                    : "text-muted-foreground",
              )}
            >
              {deadline.text}
              {dispute.evidenceDueByMs
                ? ` · due ${formatDateShort(dispute.evidenceDueByMs)}`
                : ""}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Outcome: {dispute.status.replace(/_/g, " ")}
              {dispute.closedAtMs
                ? ` · ${formatDateShort(dispute.closedAtMs)}`
                : ""}
            </p>
          )}

          {dispute.isOpen ? (
            <>
              <button
                type="button"
                onClick={onOpenStripe}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Respond in Stripe
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </button>
              <p className="mt-2 text-xs text-muted-foreground">
                Evidence is submitted in your Stripe dashboard, where you can
                attach photos, the invoice, and your notes.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
