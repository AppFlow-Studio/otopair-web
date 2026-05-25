/**
 * Receipts/[bookingId] — customer-facing invoice viewer. Mirrors the mobile
 * BookingDetailsSheet's ReceiptViewer (same `api.invoices.getReceiptForBooking`
 * query, same line items) so the experience is identical between surfaces.
 * Customers usually arrive here from the "View online" button in the invoice
 * email. The page is auth-gated via Clerk middleware and authorized via the
 * Convex query (ownership check on the booking).
 */
"use client";

import { use } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, FileDown, Loader2, ShieldX } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatLabor(minutes: number): string {
  if (!minutes || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatEmailedAt(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function ReceiptPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = use(params);
  const searchParams = useSearchParams();
  const token = searchParams.get("t");
  const receipt = useQuery(api.invoices.getReceiptForBooking, {
    bookingId: bookingId as Id<"bookings">,
    ...(token ? { token } : {}),
  });
  const requestGeneration = useMutation(api.invoices.requestInvoiceGeneration);

  if (receipt === undefined) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center">
        <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-[#0d72ff]" />
        <p className="text-sm text-slate-500">Loading your receipt…</p>
      </div>
    );
  }

  if (receipt === null) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
        <ShieldX className="mx-auto mb-3 h-8 w-8 text-slate-400" />
        <h1 className="mb-2 text-lg font-semibold text-slate-900">
          Receipt not available
        </h1>
        <p className="mx-auto max-w-md text-sm text-slate-500">
          This receipt is either still being processed, has been removed, or
          belongs to a different account. Sign in with the email used for the
          booking, then refresh this page.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Otopair
        </Link>
      </div>
    );
  }

  const { invoiceNumber, status, breakdown, emailedAtMs, url } = receipt;
  const isRefunded = status === "refunded";

  async function handleGenerate() {
    try {
      await requestGeneration({ bookingId: bookingId as Id<"bookings"> });
    } catch (err) {
      console.error("requestInvoiceGeneration failed", err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 bg-gradient-to-br from-[#0d72ff] to-[#3b82f6] px-8 py-7 text-white">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/80">
              Invoice
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">
              {invoiceNumber ?? "Pending"}
            </h1>
          </div>
          <span
            className={`mt-1 inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
              isRefunded
                ? "bg-amber-100 text-amber-900"
                : "bg-emerald-100 text-emerald-900"
            }`}
          >
            {isRefunded ? "Refunded" : "Paid"}
          </span>
        </div>

        <div className="space-y-6 px-8 py-7">
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              Parts & labor
            </h2>
            {breakdown.parts.length === 0 ? (
              <p className="text-sm text-slate-500">No parts on this job.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {breakdown.parts.map((p: typeof breakdown.parts[number], i: number) => (
                  <li
                    key={i}
                    className="flex items-start justify-between gap-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {p.name}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {p.brand ? `${p.brand} · ` : ""}
                        {p.oemNumber ?? "—"} · Qty {p.qty} ·{" "}
                        {formatCents(p.unitCents)} ea
                      </p>
                    </div>
                    <p className="whitespace-nowrap text-sm font-semibold text-slate-900">
                      {formatCents(p.lineCents)}
                    </p>
                  </li>
                ))}
                <li className="flex items-start justify-between gap-4 py-3">
                  <p className="text-sm font-medium text-slate-900">
                    Labor · {formatLabor(breakdown.laborMinutes)}
                  </p>
                  <p className="text-sm font-semibold text-slate-900">
                    {formatCents(breakdown.laborCents)}
                  </p>
                </li>
              </ul>
            )}
          </section>

          <section className="rounded-xl bg-slate-50 px-5 py-4">
            <TotalsRow
              label="Parts subtotal"
              value={formatCents(breakdown.partsTotalCents)}
            />
            <TotalsRow
              label="Labor"
              value={formatCents(breakdown.laborCents)}
            />
            <TotalsRow
              label="Subtotal"
              value={formatCents(breakdown.subtotalCents)}
            />
            {breakdown.taxCents > 0 ? (
              <TotalsRow label="Tax" value={formatCents(breakdown.taxCents)} />
            ) : null}
            {breakdown.platformFeeCents > 0 ? (
              <TotalsRow
                label="Service fee"
                value={formatCents(breakdown.platformFeeCents)}
              />
            ) : null}
            <div className="mt-3 flex items-center justify-between border-t border-slate-300 pt-3">
              <p className="text-base font-bold text-slate-900">
                Total charged
              </p>
              <p className="text-lg font-bold text-slate-900">
                {formatCents(breakdown.totalCents)}
              </p>
            </div>
            {isRefunded && breakdown.refundedCents > 0 ? (
              <div className="mt-2 flex items-center justify-between text-amber-700">
                <p className="text-sm font-semibold">Refunded</p>
                <p className="text-sm font-bold">
                  −{formatCents(breakdown.refundedCents)}
                </p>
              </div>
            ) : null}
          </section>
        </div>

        <div className="border-t border-slate-100 bg-slate-50 px-8 py-5">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800"
            >
              <FileDown className="h-4 w-4" />
              Download PDF
            </a>
          ) : (
            <button
              type="button"
              onClick={() => void handleGenerate()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-700 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing PDF…
            </button>
          )}
          {emailedAtMs ? (
            <p className="mt-3 text-center text-xs text-slate-500">
              Emailed to you on {formatEmailedAt(emailedAtMs)}
            </p>
          ) : null}
        </div>
      </div>

      <p className="text-center text-xs text-slate-400">
        Questions about this charge? Reply to the invoice email and the
        Otopair team will help.
      </p>
    </div>
  );
}

function TotalsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <p className="text-slate-600">{label}</p>
      <p className="font-medium text-slate-900">{value}</p>
    </div>
  );
}
