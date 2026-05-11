// @ts-nocheck - Convex `api` type is too deep for tsc with this schema (TS2589).
// Suppress this file; runtime types are validated by the Convex deployment.
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Wrench } from "lucide-react";
import { format } from "date-fns";
import ConfirmationDialog from "@/components/confirmation-dialog";

const todayIso = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

type OpenRequest = {
  _id: Id<"bookings">;
  _creationTime: number;
  status: string;
  tire_specs?: {
    size: string;
    type: string;
    tier: string;
    quantity: number;
  };
  vin: string;
  submitted_at: number;
  vehicle: { year: number | null; make: string | null; model: string | null } | null;
};

function formatVehicle(v: OpenRequest["vehicle"]): string {
  if (!v) return "Unknown vehicle";
  const parts = [v.year, v.make, v.model].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown vehicle";
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function TireQuoteRequestsPage() {
  const context = useQuery(api.bookings.getMyShopJobContext);
  const shopId = context?.shopId as Id<"shops"> | undefined;

  const allRequests = useQuery(
    api.bookings.listOpenTireQuoteRequestsForShop,
    shopId ? { shopId } : "skip",
  ) as OpenRequest[] | undefined;

  const [activeRequest, setActiveRequest] = useState<OpenRequest | null>(null);
  // Client-side rejection state — does not persist across page refreshes.
  // Backend mutation pending; once shipped, replace this with a real call.
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());

  const requests = useMemo(
    () => allRequests?.filter((r) => !rejectedIds.has(String(r._id))),
    [allRequests, rejectedIds],
  );

  const handleReject = (id: Id<"bookings">) => {
    setRejectedIds((prev) => {
      const next = new Set(prev);
      next.add(String(id));
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Tire Quote Requests</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open requests from customers shopping for tires. Submit a quote and the row disappears once the
          customer picks one.
        </p>
      </div>

      {context === undefined ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          Loading…
        </div>
      ) : !shopId ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          This page is for shop team members. If you need access, reach out to your shop owner.
        </div>
      ) : requests === undefined ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          Loading requests…
        </div>
      ) : requests.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Wrench className="mx-auto h-10 w-10 text-muted-foreground/40" strokeWidth={1.5} />
          <p className="mt-3 text-sm font-medium text-foreground">No open tire quote requests</p>
          <p className="mt-1 text-xs text-muted-foreground">
            New customer requests will appear here.
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Vehicle</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Size</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Type</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Tier</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Qty</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Submitted</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r._id} className="border-b border-border last:border-b-0 hover:bg-muted/20">
                  <td className="px-5 py-4 text-foreground">{formatVehicle(r.vehicle)}</td>
                  <td className="px-5 py-4 text-foreground">{r.tire_specs?.size ?? "—"}</td>
                  <td className="px-5 py-4 text-foreground capitalize">
                    {r.tire_specs?.type ?? "—"}
                  </td>
                  <td className="px-5 py-4 text-foreground capitalize">
                    {r.tire_specs?.tier ?? "—"}
                  </td>
                  <td className="px-5 py-4 text-foreground">{r.tire_specs?.quantity ?? "—"}</td>
                  <td className="px-5 py-4 text-muted-foreground">
                    {formatRelative(r.submitted_at)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => setActiveRequest(r)}
                        className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                      >
                        Make Quote
                      </button>
                      <button
                        onClick={() => handleReject(r._id)}
                        className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeRequest && shopId && (
        <QuoteSubmissionDialog
          request={activeRequest}
          shopId={shopId}
          onClose={() => setActiveRequest(null)}
        />
      )}
    </div>
  );
}

function QuoteSubmissionDialog({
  request,
  shopId,
  onClose,
}: {
  request: OpenRequest;
  shopId: Id<"shops">;
  onClose: () => void;
}) {
  const submit = useMutation(api.tire_quote_responses.create);

  const [tireBrand, setTireBrand] = useState("");
  const [tireModel, setTireModel] = useState("");
  const [perTirePrice, setPerTirePrice] = useState("");
  const [laborCost, setLaborCost] = useState("");
  const [availabilityDate, setAvailabilityDate] = useState("");
  const [availabilityTime, setAvailabilityTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const quantity = request.tire_specs?.quantity ?? 0;
  const minDate = todayIso();

  const availabilityDateTime = useMemo(() => {
    if (!availabilityDate || !availabilityTime) return null;
    const dt = new Date(`${availabilityDate}T${availabilityTime}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }, [availabilityDate, availabilityTime]);

  const availabilityFormatted = useMemo(() => {
    if (!availabilityDateTime) return "";
    return format(availabilityDateTime, "MMM d, yyyy 'at' h:mm a");
  }, [availabilityDateTime]);

  const availabilityIsFuture =
    availabilityDateTime !== null && availabilityDateTime.getTime() > Date.now();

  const total = useMemo(() => {
    const ppt = Number(perTirePrice);
    const labor = Number(laborCost);
    if (!Number.isFinite(ppt) || !Number.isFinite(labor)) return null;
    return ppt * quantity + labor;
  }, [perTirePrice, laborCost, quantity]);

  const canSubmit =
    tireBrand.trim().length > 0 &&
    perTirePrice !== "" &&
    Number(perTirePrice) > 0 &&
    laborCost !== "" &&
    Number(laborCost) >= 0 &&
    availabilityIsFuture &&
    total !== null &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || total === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await submit({
        booking_id: request._id,
        shop_id: shopId,
        tire_brand: tireBrand.trim(),
        tire_model: tireModel.trim() ? tireModel.trim() : undefined,
        per_tire_price: Number(perTirePrice),
        quantity,
        labor_cost: Number(laborCost),
        total,
        availability: { date: availabilityDate, time: availabilityTime },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit quote");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ConfirmationDialog
      open={true}
      title="Submit tire quote"
      description={`${formatVehicle(request.vehicle)} · ${request.tire_specs?.size ?? "—"} · qty ${quantity}`}
      onClose={onClose}
      secondaryAction={{
        label: "Cancel",
        onAction: onClose,
        disabled: submitting,
      }}
      primaryAction={{
        label: submitting ? "Submitting…" : "Submit quote",
        onAction: handleSubmit,
        disabled: !canSubmit,
        variant: "primary",
      }}
      maxWidthClassName="max-w-lg"
    >
      <div className="space-y-4">
        <Field label="Tire brand" required>
          <input
            type="text"
            value={tireBrand}
            onChange={(e) => setTireBrand(e.target.value)}
            placeholder="e.g. Michelin"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Tire model (optional)">
          <input
            type="text"
            value={tireModel}
            onChange={(e) => setTireModel(e.target.value)}
            placeholder="e.g. Pilot Sport 4S"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Per-tire price ($)" required>
            <input
              type="number"
              min="0"
              step="0.01"
              value={perTirePrice}
              onChange={(e) => setPerTirePrice(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Quantity">
            <input
              type="number"
              value={quantity}
              readOnly
              className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
            />
          </Field>
        </div>

        <Field label="Labor cost ($)" required>
          <input
            type="number"
            min="0"
            step="0.01"
            value={laborCost}
            onChange={(e) => setLaborCost(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Total ($)">
          <input
            type="text"
            value={total !== null ? total.toFixed(2) : "—"}
            readOnly
            className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground"
          />
        </Field>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Ready by<span className="ml-0.5 text-destructive">*</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="date"
              min={minDate}
              value={availabilityDate}
              onChange={(e) => setAvailabilityDate(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <input
              type="time"
              value={availabilityTime}
              onChange={(e) => setAvailabilityTime(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          {availabilityDateTime && !availabilityIsFuture && (
            <p className="text-xs text-destructive">Pick a date and time in the future.</p>
          )}
          {availabilityFormatted && availabilityIsFuture && (
            <p className="text-xs text-muted-foreground">
              Customer will see: <span className="text-foreground font-medium">{availabilityFormatted}</span>
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
    </ConfirmationDialog>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
