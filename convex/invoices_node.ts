/**
 * invoices_node.ts — Node-only invoice render + email side. Split out from
 * `invoices.ts` because @react-pdf/renderer and the Resend SDK both require
 * the Node runtime, while the rest of the invoice query surface stays on
 * Convex V8 so plain mutations/queries can import from it freely.
 */
"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { sendInvoiceEmail } from "../email/send";
import {
  renderInvoiceToBuffer,
  type InvoiceData,
} from "./invoices/template";

export const generateAndEmail = internalAction({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }) => {
    const assembled: any = await ctx.runQuery(
      (internal as any).invoices._assembleInvoiceData,
      { bookingId },
    );
    if (!assembled) return { ok: false, reason: "no_payment" };

    // Idempotency: if we already have a stored PDF and an emailed-at stamp,
    // and the booking hasn't been refunded since, skip the regen pass.
    if (
      assembled.invoiceStorageId &&
      assembled.invoiceEmailedAtMs &&
      assembled.status === "paid"
    ) {
      return { ok: true, reason: "already_generated" };
    }

    // Always run the allocation mutation — it's idempotent on both the
    // invoice number and the receipt token (returns existing values if
    // already set) and gives us the token for the email link in one hop.
    const allocation: { invoiceNumber: string; receiptToken: string } =
      await ctx.runMutation(
        (internal as any).invoices._allocateInvoiceNumber,
        { paymentId: assembled.paymentId },
      );
    const invoiceNumber = allocation.invoiceNumber;
    const receiptToken = allocation.receiptToken;

    const data: InvoiceData = {
      invoiceNumber,
      issuedAtMs: Date.now(),
      status: assembled.status,
      customer: assembled.customer,
      vehicle: assembled.vehicle,
      shop: assembled.shop,
      mechanicName: assembled.mechanicName,
      services: assembled.services,
      parts: assembled.parts,
      laborMinutes: assembled.laborMinutes,
      laborCents: assembled.laborCents,
      partsTotalCents: assembled.partsTotalCents,
      subtotalCents: assembled.subtotalCents,
      taxCents: assembled.taxCents,
      platformFeeCents: assembled.platformFeeCents,
      totalCents: assembled.totalCents,
      refundedCents: assembled.refundedCents,
      refundedAtMs: assembled.refundedAtMs,
      stripeChargeId: assembled.stripePaymentIntentId,
    };

    const buffer = await renderInvoiceToBuffer(data);
    const blob = new Blob([new Uint8Array(buffer)], {
      type: "application/pdf",
    });
    const storageId = await ctx.storage.store(blob);

    const generatedAtMs = Date.now();
    await ctx.runMutation((internal as any).invoices._patchInvoiceMeta, {
      paymentId: assembled.paymentId,
      invoiceStorageId: storageId,
      invoiceGeneratedAtMs: generatedAtMs,
      invoiceQuoteFlags: assembled.quoteFlags ?? [],
    });

    let emailedAtMs: number | null = null;
    const to = assembled.customer.email;
    if (to) {
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ??
        process.env.APP_URL ??
        "https://otopair.com";
      const receiptUrl = `${appUrl.replace(/\/$/, "")}/receipts/${bookingId}?t=${encodeURIComponent(receiptToken)}`;
      const result = await sendInvoiceEmail({
        to,
        invoiceNumber,
        customerFirstName: (assembled.customer.name ?? "").split(" ")[0] ?? null,
        shopName: assembled.shop.name,
        totalCents: assembled.totalCents,
        status: assembled.status,
        pdfBase64: buffer.toString("base64"),
        pdfFilename: `${invoiceNumber}.pdf`,
        receiptUrl,
      });
      if (result.success) {
        emailedAtMs = Date.now();
        await ctx.runMutation((internal as any).invoices._patchInvoiceMeta, {
          paymentId: assembled.paymentId,
          invoiceEmailedAtMs: emailedAtMs,
        });
      } else {
        console.error("[invoices] email send failed", result.error);
      }
    }

    return {
      ok: true,
      invoiceNumber,
      storageId,
      generatedAtMs,
      emailedAtMs,
    };
  },
});

/**
 * Mechanic-triggered send. Used by the shop portal "Send receipt" control
 * for walk-ins (no Clerk customer to email automatically) and as a manual
 * resend channel for registered customers. Authorizes via Clerk role on the
 * server side: the caller must be a shop_owner/admin/front_desk/mechanic
 * attached to the booking's shop. Re-renders the PDF from current state so
 * mid-flight edits to job_actuals / part_snapshots are reflected.
 */
export const sendInvoiceToEmail = action({
  args: {
    bookingId: v.id("bookings"),
    toEmail: v.string(),
  },
  handler: async (ctx, { bookingId, toEmail }) => {
    const allowed: boolean = await ctx.runQuery(
      (internal as any).invoices._isCallerAuthorizedShopUser,
      { bookingId },
    );
    if (!allowed) throw new Error("forbidden");

    const cleanEmail = toEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new Error("invalid email");
    }

    const assembled: any = await ctx.runQuery(
      (internal as any).invoices._assembleInvoiceData,
      { bookingId },
    );
    if (!assembled) throw new Error("no payment");
    if (assembled.status !== "paid" && assembled.status !== "refunded") {
      throw new Error("payment not finalized");
    }

    const allocation: { invoiceNumber: string; receiptToken: string } =
      await ctx.runMutation(
        (internal as any).invoices._allocateInvoiceNumber,
        { paymentId: assembled.paymentId },
      );

    const data: InvoiceData = {
      invoiceNumber: allocation.invoiceNumber,
      issuedAtMs: assembled.invoiceGeneratedAtMs ?? Date.now(),
      status: assembled.status,
      customer: assembled.customer,
      vehicle: assembled.vehicle,
      shop: assembled.shop,
      mechanicName: assembled.mechanicName,
      services: assembled.services,
      parts: assembled.parts,
      laborMinutes: assembled.laborMinutes,
      laborCents: assembled.laborCents,
      partsTotalCents: assembled.partsTotalCents,
      subtotalCents: assembled.subtotalCents,
      taxCents: assembled.taxCents,
      platformFeeCents: assembled.platformFeeCents,
      totalCents: assembled.totalCents,
      refundedCents: assembled.refundedCents,
      refundedAtMs: assembled.refundedAtMs,
      stripeChargeId: assembled.stripePaymentIntentId,
    };

    const buffer = await renderInvoiceToBuffer(data);
    // Refresh the stored copy too so the deep-link in the email matches the
    // PDF the customer downloads. Idempotent if the storage id is still the
    // same.
    if (!assembled.invoiceStorageId) {
      const blob = new Blob([new Uint8Array(buffer)], {
        type: "application/pdf",
      });
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation((internal as any).invoices._patchInvoiceMeta, {
        paymentId: assembled.paymentId,
        invoiceStorageId: storageId,
        invoiceGeneratedAtMs: Date.now(),
        invoiceQuoteFlags: assembled.quoteFlags ?? [],
      });
    }

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.APP_URL ??
      "https://otopair.com";
    const receiptUrl = `${appUrl.replace(/\/$/, "")}/receipts/${bookingId}?t=${encodeURIComponent(allocation.receiptToken)}`;

    const result = await sendInvoiceEmail({
      to: cleanEmail,
      invoiceNumber: allocation.invoiceNumber,
      customerFirstName: (assembled.customer.name ?? "").split(" ")[0] ?? null,
      shopName: assembled.shop.name,
      totalCents: assembled.totalCents,
      status: assembled.status,
      pdfBase64: buffer.toString("base64"),
      pdfFilename: `${allocation.invoiceNumber}.pdf`,
      receiptUrl,
    });
    if (!result.success) {
      throw new Error(
        result.error instanceof Error
          ? result.error.message
          : String(result.error ?? "send failed"),
      );
    }

    const emailedAtMs = Date.now();
    await ctx.runMutation((internal as any).invoices._patchInvoiceMeta, {
      paymentId: assembled.paymentId,
      invoiceEmailedAtMs: emailedAtMs,
    });

    return { ok: true, emailedAtMs, sentTo: cleanEmail };
  },
});
