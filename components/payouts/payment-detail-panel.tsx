"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  Car,
  CreditCard,
  ExternalLink,
  FileText,
  Mail,
  Phone,
  Wrench,
  X,
} from "lucide-react";
import { CustomerAvatar } from "@/components/customers/shared";
import { cn } from "@/lib/utils";
import { StatusChip } from "./status-chip";
import { PaymentTimeline } from "./payment-timeline";
import { PaymentBreakdown } from "./payment-breakdown";
import { DisputeCard } from "./dispute-card";
import { PaymentRefundForm } from "./payment-refund-form";
import {
  Skeleton,
  formatDateShort,
  formatDateTime,
  formatMoneyCents,
} from "./shared";
import { PAYMENT_METHOD_LABEL } from "./method-labels";
import type { ShopPaymentDetail } from "./types";

function InfoCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </section>
  );
}

export function PaymentDetailPanel({
  detail,
  loading,
  onClose,
  onOpenStripe,
  onRefunded,
}: {
  detail: ShopPaymentDetail | null | undefined;
  loading: boolean;
  onClose: () => void;
  onOpenStripe: () => void;
  onRefunded: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the panel when it opens so keyboard users land inside it,
  // and let Escape close it.
  useEffect(() => {
    if (detail) headingRef.current?.focus();
  }, [detail?.payment.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (loading || !detail) {
    return (
      <div className="space-y-4 p-5">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-6 w-28 rounded-full" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  const p = detail.payment;
  // The merchant invoice, not /receipts/[bookingId] — that one is the
  // customer's copy and computes its own fee figures. This is itemized,
  // dual-branded, printable, and its money comes off the Stripe charge.
  const invoiceHref = `/payouts/invoice/${String(p.id)}`;
  const customerReceiptHref = p.receiptToken
    ? `/receipts/${String(p.bookingId)}?t=${p.receiptToken}`
    : `/receipts/${String(p.bookingId)}`;

  return (
    <div className="flex min-h-full flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/50 bg-card/95 px-5 py-4 backdrop-blur">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-semibold text-foreground outline-none"
        >
          Payment detail
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close payment detail"
          className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col gap-4 px-5 py-5">
        {/* Amount hero */}
        <div className="flex flex-col items-start gap-3">
          <p className="text-4xl font-semibold tracking-tight text-foreground">
            {p.capturedCents == null
              ? formatMoneyCents(p.authorizedCents)
              : formatMoneyCents(p.capturedCents)}
          </p>
          <StatusChip status={p.displayStatus} size="lg" />
          <p className="text-sm text-muted-foreground">
            {p.invoiceNumber ? `${p.invoiceNumber} · ` : ""}
            {formatDateTime(p.createdAtMs)}
          </p>
          {p.capturedCents == null ? (
            <p className="text-xs text-muted-foreground">
              This is the authorized hold. Nothing has been captured yet.
            </p>
          ) : null}
        </div>

        {/* Dispute pins to the top when there is one. */}
        {detail.dispute ? (
          <DisputeCard dispute={detail.dispute} onOpenStripe={onOpenStripe} />
        ) : null}

        {/* Primary actions */}
        <div className="flex gap-2">
          <Link
            href={invoiceHref}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileText className="size-4" aria-hidden="true" />
            View invoice
          </Link>
          <Link
            href={`/bookings?id=${String(p.bookingId)}`}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-card text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            View booking
          </Link>
        </div>
        <Link
          href={customerReceiptHref}
          target="_blank"
          rel="noopener noreferrer"
          className="-mt-1 text-center text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          See the customer&apos;s copy
        </Link>

        <PaymentTimeline steps={detail.timeline} />
        <PaymentBreakdown detail={detail} />

        {/* Refund history */}
        {detail.refunds.length > 0 ? (
          <InfoCard title="Refunds">
            <ul className="space-y-2.5">
              {detail.refunds.map((r) => (
                <li key={String(r.id)} className="text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-foreground">
                      {formatMoneyCents(r.amountCents)}
                    </span>
                    <span
                      className={cn(
                        "text-xs",
                        r.status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {r.status} · {formatDateShort(r.settledAtMs ?? r.requestedAtMs)}
                    </span>
                  </div>
                  {r.note ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.note}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {r.requestedByName
                      ? `By ${r.requestedByName}`
                      : "Issued in Stripe"}
                    {r.failureReason ? ` · ${r.failureReason}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </InfoCard>
        ) : null}

        <PaymentRefundForm detail={detail} onDone={onRefunded} />

        {/* Customer */}
        {detail.customer ? (
          <InfoCard title="Customer">
            <div className="flex items-center gap-3">
              <CustomerAvatar name={detail.customer.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {detail.customer.name}
                </p>
                {detail.customer.phone ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Phone className="size-3" aria-hidden="true" />
                    {detail.customer.phone}
                  </p>
                ) : null}
                {detail.customer.email ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Mail className="size-3" aria-hidden="true" />
                    {detail.customer.email}
                  </p>
                ) : null}
              </div>
            </div>
            <p className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground">
              {detail.customer.isReturning
                ? `Returning customer · ${detail.customer.priorVisitsAtShop} previous payment${
                    detail.customer.priorVisitsAtShop === 1 ? "" : "s"
                  } here`
                : "First payment at your shop"}
            </p>
          </InfoCard>
        ) : null}

        {/* Service & vehicle */}
        <InfoCard title="Service & vehicle">
          {detail.booking?.services.length ? (
            <ul className="space-y-1">
              {detail.booking.services.map((s) => (
                <li key={s} className="text-sm font-medium text-foreground">
                  {s}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No services recorded.</p>
          )}
          <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3">
            <Car className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm text-foreground/75">
              {detail.vehicle?.ymm ?? "Vehicle unknown"}
            </span>
          </div>
        </InfoCard>

        {/* Mechanic */}
        <InfoCard title="Mechanic">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
              <Wrench className="size-4 text-foreground/75" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">
                {detail.mechanic?.name ?? "Unassigned"}
              </p>
              {detail.mechanic?.title ? (
                <p className="text-xs text-muted-foreground">
                  {detail.mechanic.title}
                </p>
              ) : null}
            </div>
          </div>
        </InfoCard>

        {/* Payment method */}
        <InfoCard title="Payment method">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
              <CreditCard className="size-4 text-foreground/75" aria-hidden="true" />
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {p.cardBrand ? `${p.cardBrand} ` : ""}
                {p.cardLast4 ? `···· ${p.cardLast4}` : PAYMENT_METHOD_LABEL[p.method]}
              </span>
              {p.method !== "card" && p.method !== "unknown" ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground/75">
                  {PAYMENT_METHOD_LABEL[p.method]}
                </span>
              ) : null}
            </div>
          </div>
          {p.isBackfilled ? (
            <p className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground">
              Imported from Stripe during reconciliation, not created by a live
              booking.
            </p>
          ) : null}
        </InfoCard>
      </div>
    </div>
  );
}
