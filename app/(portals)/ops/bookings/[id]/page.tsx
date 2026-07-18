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

const TABS = ["Overview", "Completion report", "Money & approvals", "Audit timeline"] as const;
type Tab = (typeof TABS)[number];

function fmtDur(min: number | null | undefined): string {
  if (min == null) return "—";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

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
  const [tab, setTab] = useState<Tab>("Overview");

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

      {/* Tab strip */}
      <div className="flex flex-wrap gap-1 border-b border-slate-100">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${
              tab === t
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Completion report" && <CompletionTab token={token} id={id} />}
      {tab === "Money & approvals" && <MoneyApprovalsTab token={token} id={id} />}
      {tab === "Audit timeline" && <AuditTimelineTab token={token} id={id} />}

      {tab === "Overview" && (
      <div className="space-y-4">
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
      </div>
      )}

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

// ===========================================================================
// Completion report tab — job_actuals + diagnostics + arrival/completion.
// ===========================================================================
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-[13px] text-slate-800">{value ?? "—"}</div>
    </div>
  );
}

function CompletionTab({ token, id }: { token: string; id: Id<"bookings"> }) {
  const data = useQuery(api.opsBookings.completion, { token, id });
  if (data === undefined) return <div className="py-10 text-center text-sm text-slate-400">Loading completion report…</div>;
  if (data === null) return <div className="py-10 text-center text-sm text-slate-400">Booking not found.</div>;
  const ja = data.jobActual;

  return (
    <div className="space-y-4">
      {/* Arrival → completion */}
      <Card title="Arrival → completion">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Vehicle arrived" value={data.arrivedAtMs ? ts(data.arrivedAtMs) : "—"} />
          <Field label="Job started" value={ja?.startedAt ? ts(ja.startedAt) : "—"} />
          <Field label="Completed" value={(ja?.completedAtMs ?? data.completedAtMs) ? ts(ja?.completedAtMs ?? data.completedAtMs!) : "—"} />
          <Field label="Finalized" value={ja?.finalizedAtMs ? `${ts(ja.finalizedAtMs)}${ja.finalizedBy ? ` · ${ja.finalizedBy}` : ""}` : "—"} />
        </div>
      </Card>

      {ja ? (
        <Card title="Job actuals">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field
              label="Labor (actual vs est.)"
              value={
                <span>
                  {fmtDur(ja.actualLaborMinutes)}
                  {data.estimatedLaborMinutes != null && (
                    <span className="ml-1 text-[11px] text-slate-400">est {fmtDur(data.estimatedLaborMinutes)}</span>
                  )}
                </span>
              }
            />
            <Field label="Parts (actual)" value={money(ja.actualPartsCost)} />
            <Field label="Difficulty" value={ja.difficultyRating != null ? `${ja.difficultyRating}/5` : "—"} />
            <Field label="Odometer in" value={ja.odometerIn != null ? `${ja.odometerIn.toLocaleString()} mi` : "—"} />
            <Field label="Odometer out" value={ja.completionMileage != null ? `${ja.completionMileage.toLocaleString()} mi` : "—"} />
            <Field
              label="Reports"
              value={
                <span className="flex gap-1">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${ja.hasPrejobReport ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>pre-job</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${ja.hasPostjobReport ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>post-job</span>
                </span>
              }
            />
          </div>
          {(ja.mechanicFindings || ja.technicianNotes || ja.additionalObservations || ja.inProgressNotes) && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
              {ja.mechanicFindings && <Field label="Mechanic findings (customer-facing)" value={ja.mechanicFindings} />}
              {ja.technicianNotes && <Field label="Technician notes (internal)" value={ja.technicianNotes} />}
              {ja.additionalObservations && <Field label="Additional observations" value={ja.additionalObservations} />}
              {ja.inProgressNotes && <Field label="In-progress notes" value={ja.inProgressNotes} />}
            </div>
          )}
          {ja.inProgressPhotos.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                In-progress photos ({ja.inProgressPhotos.length})
              </div>
              <div className="flex flex-wrap gap-2">
                {ja.inProgressPhotos.map((p, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" title={p.caption ?? undefined}>
                    <img src={p.url} alt={p.caption ?? "in-progress"} className="h-20 w-28 rounded-lg object-cover ring-1 ring-slate-200 hover:ring-slate-400" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Card title="Job actuals">
          <p className="text-[12px] text-slate-400">
            No job-actuals recorded yet — the completion report fills once the mechanic starts and finalizes the job.
          </p>
        </Card>
      )}

      {/* Diagnostics */}
      <Card title="Diagnostics">
        <div className="mb-3 flex flex-wrap gap-4">
          <Field label="System" value={data.diagnosticSystem ?? "—"} />
          <Field label="Checklist completed" value={data.diagnosticChecklistCompletedAtMs ? ts(data.diagnosticChecklistCompletedAtMs) : "—"} />
          {data.recommendationState && data.recommendationState !== "none" && (
            <Field label="Recommendation" value={`${data.recommendedServiceName ?? "service"} · ${data.recommendationState.replace(/_/g, " ")}`} />
          )}
        </div>
        {data.diagnosticFindingsNote && <p className="mb-3 text-[12px] text-slate-600">{data.diagnosticFindingsNote}</p>}
        {data.diagnosticChecklist.length === 0 ? (
          <p className="text-[12px] text-slate-400">No diagnostic checklist on this booking.</p>
        ) : (
          <ul className="space-y-1">
            {data.diagnosticChecklist.map((c, i) => (
              <li key={i} className="flex items-start justify-between gap-3 text-[12px]">
                <span className="text-slate-700">
                  {c.label}
                  {c.mechanicNote && <span className="ml-1 text-slate-400">— {c.mechanicNote}</span>}
                  {c.skipReason && <span className="ml-1 text-slate-400">({c.skipReason.replace(/_/g, " ")})</span>}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    c.status === "checked"
                      ? "bg-emerald-50 text-emerald-700"
                      : c.status === "flagged"
                        ? "bg-red-50 text-red-700"
                        : c.status === "skipped"
                          ? "bg-slate-100 text-slate-500"
                          : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {c.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ===========================================================================
// Money & approvals tab — quote/approval ceiling trail + disputes.
// ===========================================================================
function MoneyApprovalsTab({ token, id }: { token: string; id: Id<"bookings"> }) {
  const data = useQuery(api.opsBookings.moneyDetail, { token, id });
  if (data === undefined) return <div className="py-10 text-center text-sm text-slate-400">Loading money trail…</div>;
  if (data === null) return <div className="py-10 text-center text-sm text-slate-400">Booking not found.</div>;

  return (
    <div className="space-y-4">
      {/* Capture reconciliation */}
      <Card title="Approval & capture state">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Approval state" value={data.approvalState ? data.approvalState.replace(/_/g, " ") : "—"} />
          <Field label="Running ceiling" value={money(data.runningApprovedCeiling)} />
          <Field label="Final total" value={money(data.finalTotal)} />
          <Field label="Final captured" value={money(data.finalCaptureAmount)} />
        </div>
        {data.finalTotal != null && data.finalCaptureAmount != null && data.finalCaptureAmount < data.finalTotal && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            Captured {money(data.finalCaptureAmount)} of a {money(data.finalTotal)} final total — {money(data.finalTotal - data.finalCaptureAmount)} not captured (deposit forfeit, partial capture, or refund).
          </p>
        )}
        {(data.quoteFlags.length > 0 || data.lowConfidenceParts || data.serviceQuoteFlagCount > 0) && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
            {data.lowConfidenceParts && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">low-confidence parts</span>}
            {data.serviceQuoteFlagCount > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">{data.serviceQuoteFlagCount} service quote flags</span>}
            {data.quoteFlags.map((f: string) => (
              <span key={f} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{f}</span>
            ))}
          </div>
        )}
      </Card>

      {/* Mechanic vs catalog quote */}
      {(data.mechanicQuotedPrice != null || data.catalogQuotedPrice != null) && (
        <Card title="Mechanic vs catalog quote">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Mechanic quote" value={data.mechanicQuotedPrice != null ? money(data.mechanicQuotedPrice) : "—"} />
            <Field label="Catalog quote" value={data.catalogQuotedPrice != null ? money(data.catalogQuotedPrice) : "—"} />
            <Field label="Mechanic est." value={fmtDur(data.mechanicEstimatedMinutes)} />
            <Field label="Catalog est." value={fmtDur(data.catalogEstimatedMinutes)} />
          </div>
        </Card>
      )}

      {/* Approval cycles */}
      <Card title={`Approval cycles (${data.approvals.length})`}>
        {data.approvals.length === 0 ? (
          <p className="text-[12px] text-slate-400">
            No approval cycles — this booking hasn’t gone through mechanic-set-price approval.
          </p>
        ) : (
          <div className="space-y-3">
            {data.approvals.map((a, i: number) => (
              <div key={i} className="rounded-lg border border-slate-100 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-slate-800">
                    {a.cycle.replace(/_/g, " ")} · {money(a.mechanicSetPrice)}
                    {a.over && <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[9px] text-red-700">over ceiling</span>}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      a.decision === "approved" || a.decision === "auto_approved_within_range"
                        ? "bg-emerald-50 text-emerald-700"
                        : a.decision === "declined" || a.decision === "sla_expired"
                          ? "bg-red-50 text-red-700"
                          : a.decision
                            ? "bg-slate-100 text-slate-600"
                            : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {a.decision ? a.decision.replace(/_/g, " ") : "open"}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-slate-500 sm:grid-cols-4">
                  {a.parts != null && <span>Parts {money(a.parts)}</span>}
                  {a.labor != null && <span>Labor {money(a.labor)}</span>}
                  {a.tax != null && <span>Tax {money(a.tax)}</span>}
                  {a.serviceFee != null && <span>Fee {money(a.serviceFee)}</span>}
                </div>
                <div className="mt-1.5 text-[11px] text-slate-400">
                  submitted {ts(a.submittedAtMs)}{a.submittedBy ? ` by ${a.submittedBy}` : ""} · prior ceiling {money(a.priorCeiling)}
                  {a.decidedAtMs && ` · decided ${ts(a.decidedAtMs)}${a.decidedBy ? ` by ${a.decidedBy}` : ""}`}
                  {a.ceilingAfter != null && ` · new ceiling ${money(a.ceilingAfter)}`}
                  {a.stripeAction && ` · ${a.stripeAction.replace(/_/g, " ")}`}
                </div>
                {a.notes && <p className="mt-1 text-[12px] text-slate-600">{a.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Disputes */}
      {(data.bookingDisputes.length > 0 || data.paymentDisputes.length > 0) && (
        <Card title="Disputes & refunds">
          <div className="space-y-2">
            {data.bookingDisputes.map((d) => (
              <div key={d.id} className="rounded-lg border border-red-100 bg-red-50/40 p-3 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">Customer dispute — {d.reason.replace(/_/g, " ")}</span>
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">{d.status.replace(/_/g, " ")}</span>
                </div>
                {d.notes && <p className="mt-1 text-slate-600">{d.notes}</p>}
                <div className="mt-1 text-[11px] text-slate-400">
                  filed {ts(d.filedAtMs)}
                  {d.resolvedAtMs && ` · resolved ${ts(d.resolvedAtMs)}`}
                  {d.resolution && ` · ${d.resolution.replace(/_/g, " ")}`}
                  {d.resolutionRefund != null && ` · refund ${money(d.resolutionRefund)}`}
                </div>
              </div>
            ))}
            {data.paymentDisputes.map((d) => (
              <div key={d.id} className="rounded-lg border border-red-100 bg-red-50/40 p-3 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">Stripe dispute {d.reason ? `— ${d.reason}` : ""}</span>
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">{d.status}</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {money(d.amount)} · opened {ts(d.openedAtMs)}
                  {d.closedAtMs && ` · closed ${ts(d.closedAtMs)}`}
                  {d.evidenceDueByMs && ` · evidence due ${ts(d.evidenceDueByMs)}`}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ===========================================================================
// Audit timeline tab — the fully-merged actor-resolved lifecycle feed.
// ===========================================================================
const AUDIT_KIND_STYLE: Record<string, string> = {
  status: "bg-slate-100 text-slate-600",
  estimate_submitted: "bg-blue-50 text-blue-700",
  estimate_decision: "bg-indigo-50 text-indigo-700",
  part_edit: "bg-violet-50 text-violet-700",
  labor_edit: "bg-violet-50 text-violet-700",
  payment_status: "bg-emerald-50 text-emerald-700",
  dispute_filed: "bg-red-50 text-red-700",
  dispute_resolved: "bg-red-50 text-red-700",
  payment_dispute: "bg-red-50 text-red-700",
  audit: "bg-amber-50 text-amber-700",
};

function AuditTimelineTab({ token, id }: { token: string; id: Id<"bookings"> }) {
  const data = useQuery(api.opsBookings.auditTimeline, { token, id });
  if (data === undefined) return <div className="py-10 text-center text-sm text-slate-400">Loading audit timeline…</div>;
  if (data === null) return <div className="py-10 text-center text-sm text-slate-400">Booking not found.</div>;

  return (
    <Card title={`Audit timeline (${data.events.length} events)`}>
      {data.events.length === 0 ? (
        <p className="text-[12px] text-slate-400">No lifecycle events recorded for this booking yet.</p>
      ) : (
        <ol className="space-y-3">
          {data.events.map((e, i: number) => (
            <li key={i} className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${AUDIT_KIND_STYLE[e.kind] ?? "bg-slate-100 text-slate-600"}`}>
                    {e.kind.replace(/_/g, " ")}
                  </span>
                  <span className="text-[13px] font-medium text-slate-800">{e.title}</span>
                  {e.actor && <span className="text-[11px] text-slate-400">by {e.actor}</span>}
                </div>
                <div className="text-[11px] text-slate-400" title={new Date(e.at).toLocaleString()}>
                  {ts(e.at)}
                </div>
                {e.detail && <div className="mt-0.5 text-[12px] text-slate-500">{e.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
