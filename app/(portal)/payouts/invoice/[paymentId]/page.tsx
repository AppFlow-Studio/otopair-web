"use client";

/**
 * Merchant invoice viewer.
 *
 * Distinct from /receipts/[bookingId], which is the CUSTOMER's receipt: that
 * one is customer-scoped, and its money is computed by invoices.ts rather than
 * read from Stripe. This page is owner-scoped and its figures come off the
 * Charge — see the header of convex/shopInvoices.ts for why that matters.
 *
 * Lives under (portal) so it inherits the owner-only middleware gate on
 * /payouts(.*) — no separate route matcher to keep in sync.
 */

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { ArrowLeft, Loader2, Printer, ShieldX } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ShopInvoiceDocument } from "@/components/payouts/shop-invoice-document";
import { Skeleton } from "@/components/payouts/shared";

export default function ShopInvoicePage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const { paymentId } = use(params);
  const invoice = useQuery(api.shopInvoices.getShopInvoice, {
    paymentId: paymentId as Id<"payments">,
  });
  const syncSettlement = useAction(api.shopInvoices.syncStripeSettlement);

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // The print rules in globals.css hide everything but the invoice sheet, so
  // they're scoped to this class — without it, printing any other page in the
  // portal would come out blank.
  useEffect(() => {
    document.body.classList.add("invoice-printing");
    return () => document.body.classList.remove("invoice-printing");
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await syncSettlement({ paymentId: paymentId as Id<"payments"> });
      if (!res.ok) setSyncError(res.reason ?? "Couldn't sync with Stripe.");
      // On success the query re-runs on its own — Convex reactivity.
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Couldn't sync with Stripe.");
    } finally {
      setSyncing(false);
    }
  }, [paymentId, syncSettlement]);

  if (invoice === undefined) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 pb-16">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[600px] w-full rounded-2xl" />
      </div>
    );
  }

  if (invoice === null) {
    return (
      <div className="mx-auto max-w-2xl pb-16">
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <ShieldX
            className="mx-auto mb-3 size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <h1 className="text-lg font-semibold text-foreground">
            Invoice not available
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            This payment either doesn&apos;t exist or belongs to another shop.
          </p>
          <Link
            href="/payouts?tab=payments"
            className="mt-6 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to payments
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-16">
      {/* Toolbar is excluded from print by .no-print in the document's styles. */}
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/payouts?tab=payments"
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to payments
        </Link>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Printer className="size-4" aria-hidden="true" />
          Download / print
        </button>
      </div>

      <ShopInvoiceDocument
        invoice={invoice}
        onSync={() => void handleSync()}
        syncing={syncing}
        syncError={syncError}
      />

      {syncing ? (
        <p className="no-print mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          Reading the charge from Stripe…
        </p>
      ) : null}
    </div>
  );
}
