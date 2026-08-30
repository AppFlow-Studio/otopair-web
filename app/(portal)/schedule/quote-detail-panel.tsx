"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CalendarDays, Car, DollarSign, UserRound, Wrench, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import ConfirmationDialog from "@/components/confirmation-dialog";
import { TireQuoteSubmissionDialog } from "@/app/(portal)/bookings/tire-quote-requests/page";
import { RotorQuoteSubmissionDialog } from "@/app/(portal)/bookings/rotor-quote-requests/page";

type QuoteType = "tire" | "rotor";

function money(value: number | null | undefined) {
  return typeof value === "number"
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)
    : "—";
}

function vehicleLabel(vehicle: { year?: number | null; make?: string | null; model?: string | null } | null) {
  return [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || "Unknown vehicle";
}

function dateTimeLabel(date?: string, time?: string) {
  if (!date || !time) return "—";
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime())
    ? `${date} · ${time}`
    : value.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[65%] text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Car; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-background px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

export default function QuoteDetailPanel({
  quoteType,
  responseId,
  onClose,
}: {
  quoteType: QuoteType;
  responseId: string;
  onClose: () => void;
}) {
  const context = useQuery(api.bookings.getMyShopJobContext);
  const tireDetail = useQuery(
    api.tire_quote_responses.getShopDetail,
    quoteType === "tire" ? { response_id: responseId as Id<"tire_quote_responses"> } : "skip",
  );
  const rotorDetail = useQuery(
    api.rotor_quote_responses.getShopDetail,
    quoteType === "rotor" ? { response_id: responseId as Id<"rotor_quote_responses"> } : "skip",
  );
  const cancelTire = useMutation(api.tire_quote_responses.cancel);
  const cancelRotor = useMutation(api.rotor_quote_responses.cancel);
  const detail = quoteType === "tire" ? tireDetail : rotorDetail;
  const [now, setNow] = useState(() => Date.now());
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [requoteOpen, setRequoteOpen] = useState(false);
  const [heldNoticeOpen, setHeldNoticeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expiresAt = detail?.response?.expires_at ?? detail?.response?.created_at + 10 * 60_000;
  useEffect(() => {
    const nextBoundary = [expiresAt, detail?.checkout_hold_expires_at]
      .filter((value): value is number => value != null && value > now)
      .sort((a, b) => a - b)[0];
    if (nextBoundary == null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), nextBoundary - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [detail?.checkout_hold_expires_at, expiresAt, now]);

  const activeCheckoutHold =
    detail?.checkout_held === true &&
    detail.checkout_hold_expires_at != null &&
    detail.checkout_hold_expires_at > now;
  const serverStatus: "pending" | "expired" | "cancelled" =
    detail?.quote_status === "expired" || detail?.quote_status === "cancelled"
      ? detail.quote_status
      : "pending";
  const status: "pending" | "expired" | "cancelled" = detail?.response?.cancelled_at
    ? "cancelled"
    : activeCheckoutHold
      ? "pending"
      : expiresAt && expiresAt <= now
      ? "expired"
      : serverStatus;
  const response = detail?.response;
  const request = useMemo(() => detail ? {
    _id: detail.booking._id,
    _creationTime: detail.booking.submitted_at,
    status: detail.booking.status,
    submitted_at: detail.booking.submitted_at,
    vin: detail.booking.vin,
    vehicle: detail.vehicle,
    tire_specs: detail.booking.tire_specs ?? undefined,
    rotor_specs: detail.booking.rotor_specs ?? undefined,
    quote_status: status,
    quote_response: detail.response,
    checkout_held: detail.checkout_held,
    checkout_hold_expires_at: detail.checkout_hold_expires_at,
  } : null, [detail, status]);

  const showHeldNotice = () => {
    setRequoteOpen(false);
    setConfirmCancel(false);
    setHeldNoticeOpen(true);
  };

  const handleCancel = async () => {
    setError(null);
    try {
      if (quoteType === "tire") {
        await cancelTire({ response_id: responseId as Id<"tire_quote_responses"> });
      } else {
        await cancelRotor({ response_id: responseId as Id<"rotor_quote_responses"> });
      }
      setConfirmCancel(false);
    } catch (caught) {
      const data = (caught as { data?: { code?: string } })?.data;
      if (data?.code === "QUOTE_HELD") {
        showHeldNotice();
        return;
      }
      setConfirmCancel(false);
      setError(caught instanceof Error ? caught.message : "Couldn't cancel this quote.");
    }
  };

  if (detail === undefined || context === undefined) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading quote…</div>;
  }
  if (!detail || !response || !request || !context?.shopId) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Quote not found.</div>;
  }

  const held = activeCheckoutHold;
  const mutable = status === "pending";
  const disabledTitle = held ? "The customer has this quote held. Changes are unavailable." : undefined;
  const mechanicName = detail.mechanic?.name || "Unassigned";

  return (
    <>
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {status === "pending" ? "Pending Quote" : status === "expired" ? "Expired Quote" : "Cancelled Quote"}
            </p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">{vehicleLabel(detail.vehicle)}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{detail.booking.vin}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close quote details">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Section title="Request" icon={Car}>
            {quoteType === "tire" ? (
              <>
                <DetailRow label="Tire size" value={detail.booking.tire_specs?.size ?? "—"} />
                <DetailRow label="Tire type" value={detail.booking.tire_specs?.type ?? "—"} />
                <DetailRow label="Tier" value={detail.booking.tire_specs?.tier ?? "—"} />
                <DetailRow label="Quantity" value={detail.booking.tire_specs?.quantity ?? response.quantity} />
              </>
            ) : (
              <>
                <DetailRow label="Brake system" value={detail.booking.rotor_specs?.brake_system_type?.replaceAll("_", " ") ?? "—"} />
                <DetailRow label="Axle" value={detail.booking.rotor_specs?.axle ?? "—"} />
                <DetailRow label="Brake pads" value={detail.booking.rotor_specs?.include_pads ? detail.booking.rotor_specs?.pad_type?.replaceAll("_", " ") ?? "Included" : "Not requested"} />
              </>
            )}
          </Section>

          <Section title="Quote" icon={Wrench}>
            <DetailRow label={quoteType === "tire" ? "Tire" : "Rotor"} value={`${response[quoteType === "tire" ? "tire_brand" : "rotor_brand"]}${response[quoteType === "tire" ? "tire_model" : "rotor_model"] ? ` · ${response[quoteType === "tire" ? "tire_model" : "rotor_model"]}` : ""}`} />
            {quoteType === "rotor" && response.pad_brand ? <DetailRow label="Brake pads" value={`${response.pad_brand}${response.pad_type ? ` · ${response.pad_type.replaceAll("_", " ")}` : ""}`} /> : null}
            <DetailRow label="Duration" value={`${response.estimated_duration_minutes ?? 30} min`} />
          </Section>

          <Section title="Schedule" icon={CalendarDays}>
            <DetailRow label="Date & time" value={dateTimeLabel(response.availability?.date, response.availability?.time)} />
            <DetailRow label="Mechanic" value={<span className="inline-flex items-center gap-1.5"><UserRound className="h-4 w-4" />{mechanicName}</span>} />
            <DetailRow
              label={held ? "Customer hold ends" : "Quote expires"}
              value={new Date(
                held && detail.checkout_hold_expires_at != null
                  ? detail.checkout_hold_expires_at
                  : expiresAt,
              ).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            />
          </Section>

          <Section title="Pricing" icon={DollarSign}>
            <DetailRow label={`${quoteType === "tire" ? "Tires" : "Rotors"} (${response.quantity} × ${money(response[quoteType === "tire" ? "per_tire_price" : "per_rotor_price"])})`} value={money((response[quoteType === "tire" ? "per_tire_price" : "per_rotor_price"] ?? 0) * response.quantity)} />
            {quoteType === "rotor" && response.pad_price != null ? <DetailRow label={`Brake pads (${response.pad_quantity ?? 1} × ${money(response.pad_price)})`} value={money(response.pad_price * (response.pad_quantity ?? 1))} /> : null}
            <DetailRow label="Labor" value={money(response.labor_cost)} />
            <DetailRow label="Total" value={money(response.total)} />
          </Section>

          {held ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The customer has this slot and quote held on Review & Pay. Changes are unavailable until their hold ends.
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        {mutable ? (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <button type="button" onClick={() => setConfirmCancel(true)} disabled={held} title={disabledTitle} className="rounded-lg border border-destructive/40 px-3.5 py-2 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-40">Cancel quote</button>
            <button type="button" onClick={() => setRequoteOpen(true)} disabled={held} title={disabledTitle} className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">Requote</button>
          </footer>
        ) : null}
      </div>

      <ConfirmationDialog open={confirmCancel} title="Cancel this quote?" description="The customer will no longer be able to accept this shop's quote." onClose={() => setConfirmCancel(false)} secondaryAction={{ label: "Keep quote", onAction: () => setConfirmCancel(false) }} primaryAction={{ label: "Cancel quote", onAction: () => void handleCancel(), variant: "destructive" }} />
      <ConfirmationDialog open={heldNoticeOpen} title="Quote changes unavailable" description="The customer now has this slot and quote held." onClose={() => setHeldNoticeOpen(false)} primaryAction={{ label: "Got it", onAction: () => setHeldNoticeOpen(false) }} />

      {requoteOpen && quoteType === "tire" ? <TireQuoteSubmissionDialog request={request} shopId={context.shopId} shopMechanics={context.mechanics ?? []} shopHours={context.hours ?? []} onClose={() => setRequoteOpen(false)} onHeld={showHeldNotice} /> : null}
      {requoteOpen && quoteType === "rotor" ? <RotorQuoteSubmissionDialog request={request} shopId={context.shopId} shopMechanics={context.mechanics ?? []} shopHours={context.hours ?? []} onClose={() => setRequoteOpen(false)} onHeld={showHeldNotice} /> : null}
    </>
  );
}
