"use client";

// Ops · Booking Detail — read-only for P0. Header (status + chips) →
// timeline (created → scheduled → completed, from booking_status_history) →
// services & money → payments → around-this-booking. Audit drawer button
// (entity_type "booking"). No status mutations yet; Stripe owns refunds.

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession } from "../../../portal-session";
import { AuditDrawer } from "@/components/portal/AuditDrawer";
import { PageHeader } from "@/components/portal/ChartKit";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  pending_quote: "Pending quote",
  quotes_ready: "Quotes ready",
  vehicle_at_shop: "Vehicle at shop",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

// Shapes returned by opsBookings.detail (annotated locally because the
// generated api types collapse in this tree).
type HistoryEntry = {
  status: string;
  changedAt: number;
  changedBy: string | undefined;
  reason: string | null;
};
type ServiceLine = { id: string; name: string; slug: string | null };
type PricedPart = {
  serviceName: string;
  partName: string;
  oemNumber: string;
  brand: string | null;
  tier: string | null;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
  priceUnknown: boolean;
  priceStale: boolean;
};
type PaymentRow = {
  id: string;
  amount: number;
  capturedAmountCents: number | null;
  holdAmountCents: number | null;
  status: string;
  paymentMethod: string | null;
  stripePaymentIntentId: string | null;
  createdAt: number;
};

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "bg-emerald-50 text-emerald-700"
      : status === "cancelled" || status === "no_show"
        ? "bg-red-50 text-red-700"
        : status === "pending" || status === "pending_quote"
          ? "bg-amber-50 text-amber-700"
          : status === "quotes_ready"
            ? "bg-sky-50 text-sky-700"
            : status === "vehicle_at_shop"
              ? "bg-indigo-50 text-indigo-700"
              : "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ts(ms: number): string {
  return new Date(ms).toLocaleString();
}

function Chip({ href, label, value }: { href?: string; label: string; value: string }) {
  const inner = (
    <>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-[12px] font-medium text-slate-700">{value}</span>
    </>
  );
  const cls =
    "inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1";
  return href ? (
    <Link href={href} className={`${cls} hover:border-slate-400 hover:bg-slate-50`}>
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}

export default function OpsBookingDetailPage() {
  const { token } = usePortalSession();
  const params = useParams<{ id: string }>();
  const id = params.id as Id<"bookings">;
  const [auditOpen, setAuditOpen] = useState(false);

  const booking = useQuery(api.opsBookings.detail, { token, id });

  if (booking === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-48 animate-pulse rounded bg-slate-100" />
        <div className="h-40 animate-pulse rounded-xl bg-slate-50" />
        <div className="h-40 animate-pulse rounded-xl bg-slate-50" />
      </div>
    );
  }

  if (booking === null) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm text-slate-500">Booking not found. It may have been deleted.</p>
        <Link href="/ops/bookings" className="mt-2 inline-block text-[13px] font-medium text-slate-700 hover:underline">
          ← Back to bookings
        </Link>
      </div>
    );
  }

  // Synthesized coarse timeline (created → scheduled → completed) merged with
  // the full status history when present.
  const completedEntry = booking.statusHistory.find(
    (h: HistoryEntry) => h.status === "completed",
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <Link href="/ops/bookings" className="text-[13px] text-slate-400 hover:text-slate-600">
          ← Bookings
        </Link>
        <div className="mt-1">
          <PageHeader
            title={`Booking ${booking.invoiceNumber ?? `…${String(booking.id).slice(-6)}`}`}
            subtitle={`Created ${ts(booking.createdAt)}${
              booking.scheduledDate
                ? ` · Scheduled ${booking.scheduledDate}${
                    booking.scheduledTime ? ` ${booking.scheduledTime}` : ""
                  }`
                : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <StatusPill status={booking.status} />
              {booking.liveStage && (
                <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {booking.liveStage}
                </span>
              )}
              <button
                onClick={() => setAuditOpen(true)}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
              >
                Audit
              </button>
            </div>
          </PageHeader>
        </div>
      </div>

      {/* Entity chips */}
      <div className="flex flex-wrap gap-2">
        <Chip href={`/ops/users/${booking.user.id}`} label="User" value={booking.user.name} />
        <Chip label="VIN" value={booking.vehicleYmm ?? booking.vin ?? "—"} />
        {booking.shop && (
          <Chip href={`/shops/all/${booking.shop.id}`} label="Shop" value={booking.shop.name} />
        )}
        {booking.mechanic && (
          <Chip
            label="Mechanic"
            value={booking.mechanic.title ? `${booking.mechanic.name} · ${booking.mechanic.title}` : booking.mechanic.name}
          />
        )}
        {booking.timeSlot && (
          <Chip
            label="Slot"
            value={`${booking.timeSlot.date} ${booking.timeSlot.startTime}–${booking.timeSlot.endTime}`}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Timeline */}
        <Card title="Timeline">
          <ol className="space-y-3">
            <li className="flex gap-3">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
              <div>
                <div className="text-[13px] font-medium text-slate-800">Created</div>
                <div className="text-[11px] text-slate-400">{ts(booking.createdAt)}</div>
              </div>
            </li>
            {booking.scheduledDate && (
              <li className="flex gap-3">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-sky-400" />
                <div>
                  <div className="text-[13px] font-medium text-slate-800">Scheduled</div>
                  <div className="text-[11px] text-slate-400">
                    {booking.scheduledDate}
                    {booking.scheduledTime ? ` ${booking.scheduledTime}` : ""}
                  </div>
                </div>
              </li>
            )}
            {booking.statusHistory.map((h: HistoryEntry, i: number) => (
              <li key={i} className="flex gap-3">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    h.status === "completed"
                      ? "bg-emerald-500"
                      : h.status === "cancelled" || h.status === "no_show"
                        ? "bg-red-400"
                        : "bg-slate-300"
                  }`}
                />
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-slate-800">
                      {STATUS_LABEL[h.status] ?? h.status}
                    </span>
                    <span className="text-[11px] text-slate-400">by {h.changedBy ?? "system"}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">{ts(h.changedAt)}</div>
                  {h.reason && <div className="mt-0.5 text-[12px] text-slate-500">{h.reason}</div>}
                </div>
              </li>
            ))}
            {booking.statusHistory.length === 0 && !completedEntry && (
              <li className="text-[12px] text-slate-400">
                No status transitions recorded yet — the history starts when the shop or app moves this booking.
              </li>
            )}
          </ol>
        </Card>

        {/* Services & money */}
        <Card title="Services & money">
          {booking.services.length === 0 ? (
            <p className="text-[12px] text-slate-400">No services on this booking.</p>
          ) : (
            <ul className="mb-4 space-y-1.5">
              {booking.services.map((s: ServiceLine) => (
                <li key={s.id} className="text-[13px] text-slate-700">
                  {s.name}
                </li>
              ))}
            </ul>
          )}

          {/* Disclosed quote band the customer was shown (pre-payment) */}
          {(booking.disclosedLow != null || booking.disclosedHigh != null) && (
            <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Quoted range
                  {booking.isFixedPrice && (
                    <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[9px] text-emerald-700">
                      fixed price
                    </span>
                  )}
                </span>
                <span className="text-[13px] font-semibold text-slate-800">
                  {booking.disclosedLow != null && booking.disclosedHigh != null
                    ? `${money(booking.disclosedLow)}–${money(booking.disclosedHigh)}`
                    : money(booking.disclosedHigh ?? booking.disclosedLow)}
                </span>
              </div>
              {booking.disclosedBreakdown && (
                <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-slate-500">
                  <span>Parts</span>
                  <span className="text-right tabular-nums">
                    {money(booking.disclosedBreakdown.partsLow)}–{money(booking.disclosedBreakdown.partsHigh)}
                  </span>
                  <span>Labor</span>
                  <span className="text-right tabular-nums">{money(booking.disclosedBreakdown.labor)}</span>
                  <span>Tax</span>
                  <span className="text-right tabular-nums">
                    {money(booking.disclosedBreakdown.taxLow)}–{money(booking.disclosedBreakdown.taxHigh)}
                  </span>
                  <span>Service fee</span>
                  <span className="text-right tabular-nums">
                    {money(booking.disclosedBreakdown.serviceFeeLow)}–{money(booking.disclosedBreakdown.serviceFeeHigh)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Itemized parts snapshot — what the customer saw on Review & Pay */}
          {Array.isArray(booking.pricedParts) && booking.pricedParts.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Parts (as quoted)
              </div>
              <ul className="space-y-1">
                {booking.pricedParts.map((p: PricedPart, i: number) => (
                  <li key={i} className="flex items-start justify-between gap-3 text-[12px]">
                    <span className="min-w-0 text-slate-600">
                      <span className="text-slate-800">{p.partName}</span>
                      {p.brand ? ` · ${p.brand}` : ""}
                      {p.quantity > 1 ? ` ×${p.quantity}` : ""}
                      <span className="ml-1 text-slate-400">— {p.serviceName}</span>
                      {p.priceUnknown && (
                        <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] text-amber-700">price at job</span>
                      )}
                      {p.priceStale && (
                        <span className="ml-1 rounded bg-slate-200 px-1 text-[9px] text-slate-600">stale</span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-700">{money(p.lineTotal)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <dl className="space-y-1.5 border-t border-slate-100 pt-3 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-slate-500">Labor</dt>
              <dd className="font-medium text-slate-800">{money(booking.laborCost)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Parts</dt>
              <dd className="font-medium text-slate-800">{money(booking.partsCost)}</dd>
            </div>
            {booking.estimatedLaborMinutes != null && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Est. labor minutes</dt>
                <dd className="font-medium text-slate-800">{booking.estimatedLaborMinutes}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-slate-100 pt-1.5">
              <dt className="font-semibold text-slate-700">Total</dt>
              <dd className="text-base font-bold text-slate-900">
                {money(booking.totalCost ?? booking.quotedSetPrice)}
                {booking.totalCost == null && booking.quotedSetPrice != null && (
                  <span className="ml-1 text-[10px] font-normal text-slate-400">quoted</span>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-slate-400">
            Internal breakdown — never customer-facing beyond the fee line in the app.
          </p>
        </Card>
      </div>

      {/* Payments */}
      <Card title={`Payments (${booking.payments.length})`}>
        {booking.payments.length === 0 ? (
          <p className="text-[12px] text-slate-400">
            No payments for this booking yet — quote-stage bookings have none until the user pays.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Created</th>
                  <th className="pb-2 pr-4">Amount</th>
                  <th className="pb-2 pr-4">Captured</th>
                  <th className="pb-2 pr-4">Method</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Stripe intent</th>
                </tr>
              </thead>
              <tbody>
                {booking.payments.map((p: PaymentRow) => (
                  <tr key={p.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2.5 pr-4 text-slate-500">
                      <Link href={`/ops/payments/${p.id}`} className="hover:underline">
                        {ts(p.createdAt)}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 font-medium">
                      <Link
                        href={`/ops/payments/${p.id}`}
                        className="text-slate-900 hover:underline"
                      >
                        {money(p.amount)}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4">
                      {p.capturedAmountCents != null ? money(p.capturedAmountCents / 100) : "—"}
                    </td>
                    <td className="py-2.5 pr-4">{p.paymentMethod ?? "—"}</td>
                    <td className="py-2.5 pr-4">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          p.status === "succeeded" || p.status === "captured" || p.status === "paid"
                            ? "bg-emerald-50 text-emerald-700"
                            : p.status === "failed"
                              ? "bg-red-50 text-red-700"
                              : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[11px] text-slate-500">
                      {p.stripePaymentIntentId ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Around this booking */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Contact">
          <dl className="space-y-1.5 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">User</dt>
              <dd className="text-right">
                <Link href={`/ops/users/${booking.user.id}`} className="font-medium text-slate-800 hover:underline">
                  {booking.user.name}
                </Link>
                <div className="text-[11px] text-slate-400">
                  {[booking.user.email, booking.user.phone].filter(Boolean).join(" · ") || "no contact info"}
                </div>
              </dd>
            </div>
            {booking.shop && (
              <div className="flex justify-between gap-4 border-t border-slate-100 pt-1.5">
                <dt className="text-slate-500">Shop</dt>
                <dd className="text-right">
                  <Link
                    href={`/shops/all/${booking.shop.id}`}
                    className="font-medium text-slate-800 hover:underline"
                  >
                    {booking.shop.name}
                  </Link>
                  <div className="text-[11px] text-slate-400">
                    {[booking.shop.address, booking.shop.phone].filter(Boolean).join(" · ") || "—"}
                  </div>
                </dd>
              </div>
            )}
          </dl>
        </Card>

        <Card title="Around this booking">
          {booking.review ? (
            <div className="mb-3">
              <div className="text-[13px] font-medium text-slate-800">
                Review · {"★".repeat(Math.max(0, Math.min(5, booking.review.rating)))}
                <span className="text-slate-300">
                  {"★".repeat(Math.max(0, 5 - Math.max(0, Math.min(5, booking.review.rating))))}
                </span>
              </div>
              {booking.review.comment && (
                <p className="mt-1 text-[12px] text-slate-600">{booking.review.comment}</p>
              )}
            </div>
          ) : (
            <p className="mb-3 text-[12px] text-slate-400">No review posted for this booking.</p>
          )}
          {booking.customerNotes && (
            <div className="border-t border-slate-100 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Customer notes
              </div>
              <p className="mt-1 text-[12px] text-slate-600">{booking.customerNotes}</p>
            </div>
          )}
          {booking.refundReason && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-red-500">
                Refund reason
              </div>
              <p className="mt-1 text-[12px] text-slate-600">{booking.refundReason}</p>
            </div>
          )}
        </Card>
      </div>

      <AuditDrawer
        open={auditOpen}
        onOpenChange={setAuditOpen}
        entityType="booking"
        entityId={String(booking.id)}
        title="Booking audit trail"
      />
    </div>
  );
}
