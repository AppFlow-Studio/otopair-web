/**
 * SendReceiptCard
 *
 * Shop-portal control for sending (or re-sending) the invoice PDF over
 * email. Surfaces inside BookingDetailPanel for completed bookings — the
 * primary case is walk-in customers who never registered for Otopair, so
 * the automatic post-capture email never had a `to:` address. Mechanics
 * type the customer's email here and we mint a tokenized receipt link the
 * customer can open without signing in.
 *
 * USED IN: components/booking-detail-panel.tsx (completed section).
 */
"use client";

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { CheckCircle2, FileText, Loader2, Mail, Send } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type Props = {
  bookingId: Id<"bookings"> | null | undefined;
};

function formatRelative(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function SendReceiptCard({ bookingId }: Props) {
  const status = useQuery(
    api.invoices.getReceiptStatusForShop,
    bookingId ? { bookingId } : "skip",
  );
  const sendInvoice = useAction(api.invoices_node.sendInvoiceToEmail);

  const [emailInput, setEmailInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Seed the input from the customer's on-file email the first time the
  // status loads. Don't clobber the mechanic's edits on subsequent renders.
  useEffect(() => {
    if (status?.customerEmail && !emailInput) {
      setEmailInput(status.customerEmail);
    }
  }, [status?.customerEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-capture or unauthorized — render nothing.
  if (status === undefined) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading receipt status…
        </div>
      </div>
    );
  }
  if (status === null) return null;

  const isRefunded = status.paymentStatus === "refunded";

  async function handleSend() {
    if (!bookingId) return;
    setError(null);
    setSuccess(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    setIsSending(true);
    try {
      const result = await sendInvoice({
        bookingId,
        toEmail: emailInput.trim(),
      });
      setSuccess(`Sent to ${result.sentTo}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not send the receipt. Try again.",
      );
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">
            Customer receipt
          </h3>
        </div>
        {status.invoiceNumber ? (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {status.invoiceNumber}
          </span>
        ) : null}
      </div>

      {status.invoiceEmailedAtMs ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          Last sent {formatRelative(status.invoiceEmailedAtMs)}
          {status.customerEmail ? ` to ${status.customerEmail}` : ""}
        </p>
      ) : (
        <p className="mb-3 text-xs text-muted-foreground">
          {isRefunded
            ? "This receipt reflects a refund. Send the customer an updated copy."
            : "The customer hasn't received an emailed receipt yet — add their email to send one."}
        </p>
      )}

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
          Send to
        </span>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="email"
              value={emailInput}
              onChange={(event) => setEmailInput(event.target.value)}
              placeholder="customer@example.com"
              disabled={isSending}
              className="block w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={isSending || !emailInput.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {status.invoiceEmailedAtMs ? "Resend" : "Send"}
          </button>
        </div>
      </label>

      {error ? (
        <p className="mt-2 text-xs text-rose-600">{error}</p>
      ) : null}
      {success ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {success} — the link in the email is a one-click open, no sign-in
          required for walk-in customers.
        </p>
      ) : null}
    </div>
  );
}
