"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { AlertTriangle, Undo2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import FixedCentCurrencyInput from "@/components/ui/fixed-cent-currency-input";
import { fixedCentCurrencyCents } from "@/lib/fixed-cent-currency";
import ConfirmationDialog from "@/components/confirmation-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatMoneyCents } from "./shared";
import type { ShopPaymentDetail } from "./types";

const REASONS = [
  { value: "requested_by_customer", label: "Customer asked for it" },
  { value: "service_issue", label: "Problem with the work" },
  { value: "shop_error", label: "We made a mistake" },
  { value: "goodwill", label: "Goodwill" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "fraudulent", label: "Fraudulent" },
] as const;

type Reason = (typeof REASONS)[number]["value"];

const MIN_NOTE = 4;

export function PaymentRefundForm({
  detail,
  onDone,
}: {
  detail: ShopPaymentDetail;
  onDone: () => void;
}) {
  const refundPayment = useAction(api.shopPaymentRefunds.refundPayment);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [amountText, setAmountText] = useState("$0.00");
  const [reason, setReason] = useState<Reason>("requested_by_customer");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Guards against click-through momentum on the confirm dialog.
  const [armed, setArmed] = useState(false);

  /**
   * Minted ONCE when the confirm dialog opens, not per submit. This is the
   * thing that actually prevents a double refund: if the request times out and
   * the user clicks again, Stripe sees the same idempotency key and returns
   * the original refund instead of creating a second one. A busy flag alone
   * cannot survive a page reload mid-request.
   */
  const requestIdRef = useRef<string | null>(null);

  const max = detail.refundability.refundableCents;
  const requestedCents = useMemo(
    () => (mode === "full" ? max : fixedCentCurrencyCents(amountText)),
    [mode, max, amountText],
  );
  const remainingAfter = Math.max(0, max - requestedCents);

  const feeBack =
    detail.payment.platformFeeCents != null && detail.payment.capturedCents
      ? Math.round(
          (detail.payment.platformFeeCents * requestedCents) /
            detail.payment.capturedCents,
        )
      : null;

  const noteOk = note.trim().length >= MIN_NOTE;
  const amountOk = requestedCents >= 1 && requestedCents <= max;
  const canSubmit = noteOk && amountOk && !busy;

  useEffect(() => {
    if (!confirming) {
      setArmed(false);
      return;
    }
    const id = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(id);
  }, [confirming]);

  function beginConfirm() {
    if (!canSubmit) return;
    requestIdRef.current =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setError(null);
    setConfirming(true);
  }

  async function submit() {
    if (!requestIdRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await refundPayment({
        paymentId: detail.payment.id as Id<"payments">,
        // Full refunds omit the amount so the server takes the remainder it
        // computes itself — the client's idea of "everything" is never trusted.
        ...(mode === "partial" ? { amountCents: requestedCents } : {}),
        reason,
        note: note.trim(),
        requestId: requestIdRef.current,
      });
      setConfirming(false);
      setOpen(false);
      setSuccess(
        `Refunded ${formatMoneyCents(requestedCents)}${
          res.stripeRefundId ? ` · ${res.stripeRefundId}` : ""
        }`,
      );
      setNote("");
      setAmountText("$0.00");
      onDone();
    } catch (err) {
      // Dialog stays open on failure — closing it would leave the user unsure
      // whether anything happened.
      setError(err instanceof Error ? err.message : "Refund failed.");
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div
        role="status"
        className="rounded-xl border border-[color-mix(in_srgb,var(--success)_30%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] px-4 py-3 text-sm text-[var(--success)]"
      >
        {success}
      </div>
    );
  }

  if (!detail.refundability.canRefund) {
    return detail.refundability.blockedReason ? (
      <p className="flex items-start gap-2 rounded-xl border border-border bg-muted px-4 py-3 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {detail.refundability.blockedReason}
      </p>
    ) : null;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-card py-2.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Undo2 className="size-4" aria-hidden="true" />
        Refund this payment
      </button>
    );
  }

  const reasonLabel =
    REASONS.find((r) => r.value === reason)?.label ?? "Select a reason";

  return (
    <>
      <section className="rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Refund
        </p>

        {/* Full vs partial */}
        <div className="mt-3 flex rounded-lg bg-muted p-1">
          {(["full", "partial"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mode === m
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
            >
              {m === "full" ? `Full · ${formatMoneyCents(max)}` : "Partial"}
            </button>
          ))}
        </div>

        {mode === "partial" ? (
          <div className="mt-3">
            <label
              htmlFor="refund-amount"
              className="text-xs font-medium text-muted-foreground"
            >
              Amount to refund
            </label>
            <FixedCentCurrencyInput
              id="refund-amount"
              value={amountText}
              onValueChange={setAmountText}
              className="mt-1 h-10 w-full rounded-lg border border-border bg-card px-3 text-sm tabular-nums text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            <p
              className={cn(
                "mt-1 text-xs",
                requestedCents > max ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {requestedCents > max
                ? `You can refund at most ${formatMoneyCents(max)}.`
                : `Remaining after this refund: ${formatMoneyCents(remainingAfter)}`}
            </p>
          </div>
        ) : null}

        {/* Reason */}
        <div className="mt-3">
          <span className="text-xs font-medium text-muted-foreground">Reason</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="mt-1 flex h-10 w-full items-center justify-between rounded-lg border border-border bg-card px-3 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {reasonLabel}
                <svg
                  className="size-4 text-muted-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[240px]">
              <DropdownMenuRadioGroup
                value={reason}
                onValueChange={(v) => setReason(v as Reason)}
              >
                {REASONS.map((r) => (
                  <DropdownMenuRadioItem key={r.value} value={r.value}>
                    {r.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Note */}
        <div className="mt-3">
          <label
            htmlFor="refund-note"
            className="text-xs font-medium text-muted-foreground"
          >
            What happened? <span className="text-muted-foreground">(required)</span>
          </label>
          <textarea
            id="refund-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Kept with the payment record so anyone can see why."
            className="mt-1 w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>

        {/* What this actually costs. Not obvious, so state it. */}
        <div className="mt-3 rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">
            {formatMoneyCents(requestedCents)}
          </strong>{" "}
          goes back to {detail.customer?.name ?? "the customer"}.
          {feeBack != null ? (
            <>
              {" "}
              Your Otopair fee of {formatMoneyCents(feeBack)} comes back to you.
            </>
          ) : null}{" "}
          Stripe&apos;s processing fee is not returned.
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            className="flex-1 rounded-lg border border-border bg-card py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={beginConfirm}
            disabled={!canSubmit}
            className="flex-1 rounded-lg bg-destructive py-2.5 text-sm font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Continue
          </button>
        </div>

        {!noteOk && note.length > 0 ? (
          <p className="mt-2 text-xs text-destructive">
            Add a few more words so the reason is clear later.
          </p>
        ) : null}
      </section>

      <ConfirmationDialog
        open={confirming}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
        zIndexClassName="z-[80]"
        title="Refund this payment?"
        description={
          <>
            {formatMoneyCents(requestedCents)} will be returned to{" "}
            <strong>{detail.customer?.name ?? "the customer"}</strong>. This
            can&apos;t be undone.
          </>
        }
        secondaryAction={{
          label: "Cancel",
          onAction: () => setConfirming(false),
          disabled: busy,
          variant: "outline",
        }}
        primaryAction={{
          // The amount IS the ceremony — you cannot confirm without reading it.
          label: busy ? "Refunding…" : `Refund ${formatMoneyCents(requestedCents)}`,
          onAction: () => void submit(),
          disabled: busy || !armed,
          variant: "destructive",
        }}
      >
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
      </ConfirmationDialog>
    </>
  );
}
