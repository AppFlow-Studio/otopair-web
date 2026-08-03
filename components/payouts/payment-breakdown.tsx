"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoneyCents } from "./shared";
import type { ShopPaymentDetail } from "./types";

function Line({
  label,
  value,
  strong,
  negative,
}: {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span
        className={cn(
          "text-sm",
          strong ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "text-sm tabular-nums",
          strong
            ? "font-semibold text-foreground"
            : negative
              ? "text-destructive"
              : "text-foreground/75",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * What the shop actually keeps.
 *
 * The Otopair fee comes from the stored figure, never from `total × 7%`: the
 * fee has a $4.99 floor, so on small tickets the percentage is simply wrong.
 * When we can't establish which of the repo's three fee formulas applies, the
 * line says so instead of showing a plausible-looking number.
 */
export function PaymentBreakdown({ detail }: { detail: ShopPaymentDetail }) {
  const b = detail.breakdown;
  const captured = detail.payment.capturedCents;
  const feeUnknown = b.feeBasis === "unknown" || b.platformFeeCents == null;

  const subtotal =
    b.partsCents != null && b.laborCents != null
      ? b.partsCents + b.laborCents
      : null;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Breakdown
      </p>

      {subtotal != null ? (
        <>
          <Line label="Parts" value={formatMoneyCents(b.partsCents)} />
          <Line label="Labor" value={formatMoneyCents(b.laborCents)} />
          {b.taxCents ? (
            <Line label="Tax" value={formatMoneyCents(b.taxCents)} />
          ) : null}
          <div className="my-1 border-t border-border/50" />
        </>
      ) : null}

      <Line
        label="Customer paid"
        value={captured == null ? "Not captured" : formatMoneyCents(captured)}
        strong
      />
      <Line
        label="Otopair fee"
        value={feeUnknown ? "—" : `−${formatMoneyCents(b.platformFeeCents)}`}
        negative={!feeUnknown}
      />
      {b.refundedCents > 0 ? (
        <Line
          label="Refunded"
          value={`−${formatMoneyCents(b.refundedCents)}`}
          negative
        />
      ) : null}

      <div className="my-1 border-t border-border/50" />
      <Line
        label="Your net"
        value={
          detail.payment.netToShopCents == null
            ? "—"
            : formatMoneyCents(detail.payment.netToShopCents)
        }
        strong
      />

      {feeUnknown ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          We couldn&apos;t confirm the platform fee for this booking, so the net
          is left blank rather than estimated.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        Stripe&apos;s processing fee is deducted from your Stripe balance and
        isn&apos;t shown per payment.
      </p>
    </section>
  );
}
