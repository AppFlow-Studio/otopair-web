"use client";

// /ops/payments/[id] — payment detail (Ops Atlas §5.5, T3). Read-only for P0:
// full field card → hold lifecycle → status timeline (payment_status_history)
// → linked booking / transactions / disputes. Audit drawer button in header.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { AuditDrawer } from "@/components/portal/AuditDrawer";
import { PageHeader } from "@/components/portal/ChartKit";

// --- helpers ---------------------------------------------------------------

function money(dollars: number | undefined | null): string {
  if (dollars == null) return "—";
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function cents(c: number | undefined | null): string {
  if (c == null) return "—";
  return money(c / 100);
}

function ts(ms: number | undefined | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

const PILL = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

function statusPillClass(status: string): string {
  switch (status) {
    case "succeeded":
    case "captured":
    case "paid":
    case "won":
      return `${PILL} bg-emerald-50 text-emerald-700`;
    case "pending":
    case "processing":
    case "requires_action":
      return `${PILL} bg-amber-50 text-amber-700`;
    case "failed":
    case "disputed":
    case "lost":
    case "canceled":
    case "cancelled":
      return `${PILL} bg-red-50 text-red-700`;
    default:
      return `${PILL} bg-slate-100 text-slate-600`;
  }
}

// A breakdown line that renders "low–high" when a range is present, else a
// single value. Keeps the range-vs-fixed quote honest.
function BreakdownRow({
  label,
  low,
  high,
}: {
  label: string;
  low: number | null;
  high: number | null;
}) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="tabular-nums font-medium text-slate-800">
        {high != null && high !== low ? `${money(low)}–${money(high)}` : money(low)}
      </dd>
    </div>
  );
}

function CopyableMono({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="break-all text-left font-mono text-[12px] text-slate-600 hover:text-slate-900 hover:underline"
    >
      {copied ? "Copied ✓" : value}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 text-[13px] text-slate-800">{children}</div>
    </div>
  );
}

// --- page --------------------------------------------------------------------

export default function OpsPaymentDetailPage() {
  const { token } = usePortalSession();
  const params = useParams<{ id: string }>();
  const id = params?.id as Id<"payments"> | undefined;
  const [auditOpen, setAuditOpen] = useState(false);

  const data = useQuery(api.opsPayments.detail, id ? { token, id } : "skip") as
    | FunctionReturnType<typeof api.opsPayments.detail>
    | undefined;

  if (!id || data === undefined) {
    return <div className="py-10 text-center text-sm text-slate-400">Loading payment…</div>;
  }

  if (data === null) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm text-slate-500">
          Payment not found — it may have been removed or the link is stale.
        </p>
        <Link
          href="/ops/payments"
          className="mt-3 inline-block text-sm font-semibold text-slate-900 hover:underline"
        >
          ← Back to payments
        </Link>
      </div>
    );
  }

  const { payment: p, user, shop, booking, history, transactions, disputes, refunds } = data;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="text-xs text-slate-400">
          <Link href="/ops/payments" className="hover:underline">
            ← Payments
          </Link>{" "}
          / <span className="font-mono">{p.id}</span>
        </div>
        <div className="mt-1">
          <PageHeader
            title={`Payment · ${money(p.amount)}`}
            subtitle={`Created ${ts(p.createdAt)}${
              user ? ` · ${user.name}` : ""
            }${shop ? ` at ${shop.name}` : ""}`}
          >
            <div className="flex items-center gap-2">
              <span className={statusPillClass(p.status)}>{p.status}</span>
              {p.backfilledAtMs != null && (
                <span className={`${PILL} bg-slate-100 text-slate-500`}>backfilled</span>
              )}
              <button
                type="button"
                onClick={() => setAuditOpen(true)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Audit
              </button>
            </div>
          </PageHeader>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Field card */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-900">Payment</h2>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4">
            <Field label="Amount">{money(p.amount)}</Field>
            <Field label="Card">
              {p.cardLast4 ? (
                <span>
                  <span className="capitalize">{p.cardBrand ?? "card"}</span>
                  <span className="ml-1 font-mono text-slate-500">···· {p.cardLast4}</span>
                  {p.paymentOrigin && p.paymentOrigin !== "card" && (
                    <span className="ml-1 text-[11px] text-slate-400">
                      via {p.paymentOrigin.replace(/_/g, " ")}
                    </span>
                  )}
                </span>
              ) : (
                p.paymentOrigin ?? p.paymentMethod ?? "—"
              )}
            </Field>
            <Field label="Created">{ts(p.createdAt)}</Field>
            <Field label="Updated">{ts(p.updatedAt)}</Field>
            <Field label="Stripe payment intent">
              {p.stripePaymentIntentId ? (
                <CopyableMono value={p.stripePaymentIntentId} />
              ) : (
                "—"
              )}
            </Field>
            <Field label="Reauth payment intent">
              {p.reauthPaymentIntentId ? (
                <CopyableMono value={p.reauthPaymentIntentId} />
              ) : (
                "—"
              )}
            </Field>
            <Field label="Transaction id">
              {p.transactionId ? <CopyableMono value={p.transactionId} /> : "—"}
            </Field>
            <Field label="Idempotency key">
              {p.idempotencyKey ? <CopyableMono value={p.idempotencyKey} /> : "—"}
            </Field>
            <Field label="Invoice">
              {p.invoiceNumber ?? "—"}
              {p.invoiceGeneratedAtMs != null && (
                <span className="ml-1 text-[11px] text-slate-400">
                  generated {ts(p.invoiceGeneratedAtMs)}
                </span>
              )}
              {p.invoiceEmailedAtMs != null && (
                <span className="ml-1 text-[11px] text-slate-400">
                  · emailed {ts(p.invoiceEmailedAtMs)}
                </span>
              )}
            </Field>
            <Field label="Invoice quote flags">
              {p.invoiceQuoteFlags && p.invoiceQuoteFlags.length > 0 ? (
                <span className={`${PILL} bg-amber-50 text-amber-700`}>
                  {p.invoiceQuoteFlags.join(", ")}
                </span>
              ) : (
                "none"
              )}
            </Field>
          </div>

          {/* Hold lifecycle */}
          <h2 className="mt-6 text-sm font-semibold text-slate-900">Hold lifecycle</h2>
          <div className="mt-3 grid grid-cols-3 gap-4">
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-500">Hold (authorized)</div>
              <div className="text-2xl font-bold text-slate-900">
                {cents(p.holdAmountCents)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-500">Incremented total</div>
              <div className="text-2xl font-bold text-slate-900">
                {cents(p.incrementedTotalCents)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-500">Captured</div>
              <div className="text-2xl font-bold text-slate-900">
                {cents(p.capturedAmountCents)}
              </div>
            </div>
          </div>
          {p.holdAmountCents == null &&
            p.incrementedTotalCents == null &&
            p.capturedAmountCents == null && (
              <p className="mt-2 text-[12px] text-slate-400">
                No hold lifecycle recorded — legacy or backfilled payment (amount field is
                canonical).
              </p>
            )}
        </div>

        {/* Linked entities */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Linked</h2>
            <div className="mt-3 space-y-3">
              <Field label="User">
                {user ? (
                  <Link href={`/ops/users/${user.id}`} className="hover:underline">
                    {user.name}
                    {user.email && (
                      <span className="ml-1 text-[11px] text-slate-400">{user.email}</span>
                    )}
                  </Link>
                ) : (
                  "Unknown"
                )}
              </Field>
              <Field label="Shop">
                {shop ? (
                  <Link href={`/shops/all/${shop.id}`} className="hover:underline">
                    {shop.name}
                  </Link>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="Booking">
                {booking ? (
                  <div>
                    <Link href={`/ops/bookings/${booking.id}`} className="hover:underline">
                      {booking.scheduledDate ?? "booking"} ·{" "}
                      <span className={statusPillClass(booking.status)}>{booking.status}</span>
                      {booking.totalCost != null && (
                        <span className="ml-1 text-[11px] text-slate-400">
                          {money(booking.totalCost)}
                        </span>
                      )}
                    </Link>
                    {(booking.services?.length > 0 || booking.vehicleYmm) && (
                      <div className="mt-0.5 text-[12px] text-slate-500">
                        {[
                          booking.services
                            ?.filter((s: string) => s && s !== "—")
                            .join(", ") || null,
                          booking.vehicleYmm,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </div>
                ) : (
                  "—"
                )}
              </Field>
            </div>
          </div>

          {/* Price breakdown — lives on the booking (parts/labor/tax/fee) */}
          {booking?.breakdown && (
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold text-slate-900">
                Price breakdown
                {booking.breakdown.isRange && (
                  <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                    quoted range
                  </span>
                )}
              </h2>
              <dl className="mt-3 space-y-1.5 text-[13px]">
                <BreakdownRow
                  label="Parts"
                  low={booking.breakdown.parts}
                  high={booking.breakdown.partsHigh}
                />
                <div className="flex justify-between">
                  <dt className="text-slate-500">Labor</dt>
                  <dd className="tabular-nums font-medium text-slate-800">
                    {money(booking.breakdown.labor)}
                  </dd>
                </div>
                <BreakdownRow
                  label="Tax"
                  low={booking.breakdown.tax}
                  high={booking.breakdown.taxHigh}
                />
                <BreakdownRow
                  label="Service fee"
                  low={booking.breakdown.serviceFee}
                  high={booking.breakdown.serviceFeeHigh}
                />
                <div className="flex justify-between border-t border-slate-100 pt-1.5">
                  <dt className="font-semibold text-slate-700">Booking total</dt>
                  <dd className="tabular-nums font-bold text-slate-900">
                    {money(booking.totalCost)}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {/* Disputes */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Disputes</h2>
            {disputes.length === 0 ? (
              <p className="mt-2 text-[12px] text-slate-400">No disputes on this payment.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {disputes.map((d) => (
                  <div key={d.id} className="rounded-lg border border-red-100 bg-red-50/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className={statusPillClass("disputed")}>{d.status}</span>
                      <span className="text-[12px] font-semibold text-slate-800">
                        {cents(d.amountCents)}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-slate-600">
                      {d.reason ?? "no reason"} · opened {ts(d.openedAtMs)}
                      {d.closedAtMs != null && <> · closed {ts(d.closedAtMs)}</>}
                      {d.evidenceDueByMs != null && d.closedAtMs == null && (
                        <> · evidence due {ts(d.evidenceDueByMs)}</>
                      )}
                    </div>
                    <div className="mt-1">
                      <CopyableMono value={d.stripeDisputeId} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Refunds & capture reconciliation */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Refunds & capture</h2>
            {(() => {
              const hasAny =
                refunds.bookingRefundReason != null ||
                refunds.authVoidedAtMs != null ||
                refunds.disputeRefunds.length > 0 ||
                refunds.ledgerRefunds.length > 0 ||
                (refunds.finalCaptureAmountCents != null &&
                  refunds.finalTotalCents != null &&
                  refunds.finalCaptureAmountCents < refunds.finalTotalCents);
              if (!hasAny)
                return (
                  <p className="mt-2 text-[12px] text-slate-400">
                    No refunds or capture shortfall on this payment.
                  </p>
                );
              return (
                <div className="mt-3 space-y-2 text-[12px]">
                  {refunds.finalTotalCents != null &&
                    refunds.finalCaptureAmountCents != null &&
                    refunds.finalCaptureAmountCents < refunds.finalTotalCents && (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
                        Captured {cents(refunds.finalCaptureAmountCents)} of a{" "}
                        {cents(refunds.finalTotalCents)} final total —{" "}
                        {cents(refunds.finalTotalCents - refunds.finalCaptureAmountCents)} not
                        captured (deposit forfeit, partial capture, or refund).
                      </p>
                    )}
                  {refunds.authVoidedAtMs != null && (
                    <div className="text-slate-600">
                      Authorization voided · {ts(refunds.authVoidedAtMs)}
                    </div>
                  )}
                  {refunds.bookingRefundReason && (
                    <div className="text-slate-600">
                      <span className="font-medium text-slate-800">Refund reason:</span>{" "}
                      {refunds.bookingRefundReason}
                    </div>
                  )}
                  {refunds.disputeRefunds.map((r, i) => (
                    <div key={i} className="flex justify-between text-slate-600">
                      <span>
                        Dispute refund{r.resolution ? ` (${r.resolution.replace(/_/g, " ")})` : ""}
                        {r.resolvedAtMs ? ` · ${ts(r.resolvedAtMs)}` : ""}
                      </span>
                      <span className="font-semibold text-red-600">−{cents(r.amountCents)}</span>
                    </div>
                  ))}
                  {refunds.ledgerRefunds.map((r, i) => (
                    <div key={i} className="flex justify-between text-slate-600">
                      <span>{r.description} · {ts(r.createdAt)}</span>
                      <span className="font-semibold text-red-600">{money(r.amount)}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Status timeline */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">Status timeline</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-[12px] text-slate-400">
            No status history recorded for this payment yet.
          </p>
        ) : (
          <ol className="mt-3 space-y-0">
            {history.map((h) => (
              <li key={h.id} className="flex items-baseline gap-3 border-b border-slate-50 py-2.5 last:border-0">
                <span className="w-40 shrink-0 text-[12px] text-slate-400">
                  {ts(h.changedAt)}
                </span>
                <span className="text-[13px] text-slate-700">
                  {h.oldStatus ? (
                    <>
                      <span className={statusPillClass(h.oldStatus)}>{h.oldStatus}</span>
                      <span className="mx-1.5 text-slate-400">→</span>
                    </>
                  ) : null}
                  <span className={statusPillClass(h.newStatus)}>{h.newStatus}</span>
                </span>
                {(h.errorCode || h.errorMessage) && (
                  <span className="text-[12px] text-red-600">
                    {h.errorCode}
                    {h.errorCode && h.errorMessage ? " — " : ""}
                    {h.errorMessage}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Linked transactions */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Linked transactions (what the user&apos;s app shows)
        </h2>
        {transactions.length === 0 ? (
          <p className="mt-2 text-[12px] text-slate-400">
            No transactions ledger rows link to this payment.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Created</th>
                  <th className="pb-2 pr-4">Description</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4">Amount</th>
                  <th className="pb-2 pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2.5 pr-4 whitespace-nowrap text-slate-500">
                      {ts(t.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {t.description}
                      {t.subDescription && (
                        <span className="ml-1 text-[11px] text-slate-400">
                          {t.subDescription}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-600">{t.type}</td>
                    <td
                      className={`py-2.5 pr-4 font-semibold ${
                        t.amount < 0 ? "text-red-600" : "text-emerald-700"
                      }`}
                    >
                      {money(t.amount)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={statusPillClass(t.status)}>{t.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AuditDrawer
        open={auditOpen}
        onOpenChange={setAuditOpen}
        entityType="payment"
        entityId={String(p.id)}
        title="Payment audit trail"
      />
    </div>
  );
}
