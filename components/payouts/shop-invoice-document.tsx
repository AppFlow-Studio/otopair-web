"use client";

/**
 * shop-invoice-document.tsx — the merchant's itemized invoice.
 *
 * Dual-branded on purpose: the shop is the one who did the work and is the
 * name the customer knows, so it leads. Otopair is the platform that processed
 * the payment and took a fee, so it appears as the processor in the footer and
 * on the fee line. A merchant handing this to an accountant needs both.
 *
 * Money lines carry their provenance. Anything Stripe told us is labelled as
 * such; anything we computed is not presented as if Stripe confirmed it.
 *
 * Print CSS lives at the bottom of this file so "Download PDF" is the
 * browser's own print-to-PDF — no second PDF pipeline, no stored artifact to
 * keep in sync with the payment it describes.
 */

import Image from "next/image";
import { ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateShort, formatDateTime, formatMoneyCents } from "./shared";
// Type-only import, fully erased at build — no Convex server code reaches the
// bundle. Imported rather than duplicated because this type is large and
// money-bearing, and a drifting copy is how a wrong figure gets onto a
// document a merchant hands to an accountant.
import type { ShopInvoice } from "@/convex/shopInvoices";

const STATUS_COPY: Record<ShopInvoice["status"], { label: string; cls: string }> = {
  paid: {
    label: "Paid",
    cls: "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]",
  },
  partially_refunded: {
    label: "Partially refunded",
    cls: "bg-indigo-50 text-indigo-700",
  },
  refunded: { label: "Refunded", cls: "bg-muted text-muted-foreground" },
  uncaptured: { label: "Not captured", cls: "bg-amber-50 text-amber-700" },
  other: { label: "See details", cls: "bg-muted text-muted-foreground" },
};

function Row({
  label,
  value,
  hint,
  strong,
  negative,
}: {
  label: string;
  value: string;
  hint?: string | null;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <span
          className={cn(
            "text-sm",
            strong ? "font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {hint ? (
          <p className="text-xs text-muted-foreground/80">{hint}</p>
        ) : null}
      </div>
      <span
        className={cn(
          "shrink-0 text-sm tabular-nums",
          strong
            ? "font-semibold text-foreground"
            : negative
              ? "text-destructive"
              : "text-foreground/80",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function ShopInvoiceDocument({
  invoice,
  onSync,
  syncing,
  syncError,
}: {
  invoice: ShopInvoice;
  onSync: () => void;
  syncing: boolean;
  syncError: string | null;
}) {
  const s = invoice.settlement;
  const status = STATUS_COPY[invoice.status];
  const fromStripe = s.source === "stripe";

  return (
    <article className="invoice-sheet mx-auto max-w-3xl rounded-2xl border border-border bg-card shadow-sm">
      {/* ---- Header: shop leads, Otopair as processor ---- */}
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-border p-8">
        <div className="flex min-w-0 items-start gap-4">
          {invoice.shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={invoice.shop.logoUrl}
              alt=""
              className="size-14 shrink-0 rounded-xl object-cover ring-1 ring-border"
            />
          ) : (
            <span
              className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-xl font-bold text-primary"
              aria-hidden="true"
            >
              {invoice.shop.name.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">
              {invoice.shop.name}
            </h1>
            {invoice.shop.address ? (
              <p className="text-sm text-muted-foreground">{invoice.shop.address}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {[invoice.shop.phone, invoice.shop.email]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>

        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Invoice
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight text-foreground">
            {invoice.invoiceNumber ?? "—"}
          </p>
          <span
            className={cn(
              "mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
              status.cls,
            )}
          >
            {status.label}
          </span>
          <p className="mt-2 text-xs text-muted-foreground">
            {formatDateShort(invoice.issuedAtMs)}
          </p>
        </div>
      </header>

      {/* ---- Parties ---- */}
      <section className="grid grid-cols-1 gap-6 border-b border-border p-8 sm:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Billed to
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {invoice.customer.name}
          </p>
          {invoice.customer.email ? (
            <p className="text-xs text-muted-foreground">{invoice.customer.email}</p>
          ) : null}
          {invoice.customer.phone ? (
            <p className="text-xs text-muted-foreground">{invoice.customer.phone}</p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Vehicle
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {invoice.vehicle.ymm ?? "—"}
          </p>
          {invoice.vehicle.vin ? (
            <p className="font-mono text-xs text-muted-foreground">
              VIN {invoice.vehicle.vin}
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Service
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {invoice.scheduledDate ?? "—"}
          </p>
          {invoice.mechanicName ? (
            <p className="text-xs text-muted-foreground">
              Performed by {invoice.mechanicName}
            </p>
          ) : null}
        </div>
      </section>

      {/* ---- Line items ---- */}
      <section className="p-8">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            Itemized parts and labor for this job
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Description
              </th>
              <th
                scope="col"
                className="pb-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Qty
              </th>
              <th
                scope="col"
                className="pb-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Unit
              </th>
              <th
                scope="col"
                className="pb-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  No itemized parts or labor were recorded for this job.
                </td>
              </tr>
            ) : (
              invoice.lineItems.map((l, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-3 pr-4">
                    <p className="text-sm font-medium text-foreground">{l.name}</p>
                    {l.detail ? (
                      <p className="text-xs text-muted-foreground">{l.detail}</p>
                    ) : null}
                  </td>
                  <td className="py-3 text-right text-sm tabular-nums text-muted-foreground">
                    {l.qty ?? "—"}
                  </td>
                  <td className="py-3 text-right text-sm tabular-nums text-muted-foreground">
                    {l.unitCents != null ? formatMoneyCents(l.unitCents) : "—"}
                  </td>
                  <td className="py-3 text-right text-sm font-medium tabular-nums text-foreground">
                    {formatMoneyCents(l.lineCents)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* ---- Money. Everything here is Stripe's unless stated. ---- */}
        <div className="mt-6 ml-auto max-w-sm">
          {invoice.itemizedSubtotalCents > 0 ? (
            <Row
              label="Itemized subtotal"
              value={formatMoneyCents(invoice.itemizedSubtotalCents)}
            />
          ) : null}

          {/* The customer receipt fabricates a tax line here by taking the
              remainder. This shows the remainder as what it is. */}
          {invoice.reconciliationCents != null &&
          invoice.reconciliationCents !== 0 ? (
            <Row
              label="Tax and adjustments"
              hint="Difference between the itemized lines and the amount charged"
              value={formatMoneyCents(invoice.reconciliationCents)}
            />
          ) : null}

          <div className="my-2 border-t border-border" />

          <Row
            label="Total charged to customer"
            value={
              s.capturedCents == null ? "Not captured" : formatMoneyCents(s.capturedCents)
            }
            strong
          />

          {s.refundedCents > 0 ? (
            <Row
              label="Refunded"
              value={`−${formatMoneyCents(s.refundedCents)}`}
              negative
            />
          ) : null}

          <Row
            label="Otopair platform fee"
            hint={fromStripe ? "As charged by Stripe" : "Not yet confirmed with Stripe"}
            value={
              s.applicationFeeCents == null
                ? "—"
                : `−${formatMoneyCents(s.applicationFeeCents)}`
            }
            negative={s.applicationFeeCents != null}
          />

          {/* Called out because it is a common and expensive misconception:
              on a destination charge Stripe's fee comes off the platform, not
              the shop. Showing it without saying so would imply otherwise. */}
          {s.processingFeeCents != null ? (
            <Row
              label="Stripe processing fee"
              hint="Paid by Otopair — not deducted from your payout"
              value={formatMoneyCents(s.processingFeeCents)}
            />
          ) : null}

          <div className="my-2 border-t border-border" />

          <Row
            label="Net to your account"
            hint={
              s.netIsExact
                ? "Stripe transfer amount"
                : s.netToShopCents != null
                  ? "Derived — sync with Stripe to confirm"
                  : null
            }
            value={
              s.netToShopCents == null ? "—" : formatMoneyCents(s.netToShopCents)
            }
            strong
          />
        </div>

        {invoice.refunds.length > 0 ? (
          <div className="mt-6 rounded-xl border border-border bg-muted/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Refund history
            </p>
            <ul className="mt-2 space-y-1.5">
              {invoice.refunds.map((r, i) => (
                <li key={i} className="flex justify-between gap-4 text-sm">
                  <span className="min-w-0 text-muted-foreground">
                    {formatDateShort(r.settledAtMs)}
                    {r.note ? ` · ${r.note}` : r.reason ? ` · ${r.reason}` : ""}
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground">
                    −{formatMoneyCents(r.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* ---- Payment + provenance ---- */}
      <footer className="space-y-3 border-t border-border bg-muted/30 p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Payment
            </p>
            <p className="mt-1 text-sm text-foreground">
              {s.cardBrand && s.cardLast4
                ? `${s.cardBrand} ···· ${s.cardLast4}`
                : s.method === "cash"
                  ? "Cash"
                  : "Card"}
            </p>
            {s.chargeId ? (
              <p className="font-mono text-xs text-muted-foreground">{s.chargeId}</p>
            ) : null}
          </div>

          <div className="text-right">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Processed by
            </p>
            <div className="mt-1.5 flex items-center justify-end gap-2">
              {/* unoptimized: the print/PDF path renders outside the Next image
                  optimizer, and a broken logo on an invoice is worse than an
                  unoptimized 32px asset. */}
              <Image
                src="/logo.png"
                alt="Otopair"
                width={24}
                height={24}
                unoptimized
                className="size-6 object-contain"
              />
              <span className="text-sm font-semibold text-foreground">Otopair</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Payments handled by Stripe
            </p>
          </div>
        </div>

        {/* Provenance, stated rather than implied. */}
        <div className="no-print flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            {fromStripe
              ? `Amounts confirmed with Stripe ${formatDateTime(s.syncedAtMs)}.`
              : "Amounts have not been confirmed with Stripe yet — the fee and net figures are derived from our own records."}
          </p>
          <div className="flex items-center gap-2">
            {s.receiptUrl ? (
              <a
                href={s.receiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                Stripe receipt
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
            <button
              type="button"
              onClick={onSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RefreshCw
                className={cn("size-3", syncing && "animate-spin")}
                aria-hidden="true"
              />
              {syncing ? "Syncing…" : "Sync with Stripe"}
            </button>
          </div>
        </div>
        {syncError ? (
          <p role="alert" className="no-print text-xs text-destructive">
            {syncError}
          </p>
        ) : null}

        <p className="hidden text-center text-xs text-muted-foreground print:block">
          Generated by Otopair on behalf of {invoice.shop.name}.
        </p>
      </footer>

    </article>
  );
}
