/**
 * invoices.ts — invoice data assembly, storage-id bookkeeping, and the
 * customer-facing `getInvoiceUrl` query. PDF rendering + email send live in
 * `invoices_node.ts` (Node action) so this file stays in the Convex V8
 * runtime and can be safely imported from regular queries/mutations.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  detectTier,
  resolveVehicleConfigFromVin,
} from "./lib/quoteEngine";
import { resolveLaborRate, type VehicleTier } from "./lib/vehicleTiers";

const PLATFORM_FEE_BPS = 700;
const DEFAULT_LABOR_RATE = 120;

/**
 * URL-safe random token used as capability auth for /receipts/[bookingId]?t=…
 * Walk-in customers who don't have a Clerk account open the deep-link from
 * email and the token alone authorizes the read. 32 bytes ≈ 43 base64url
 * chars = ~256 bits of entropy.
 */
function generateReceiptToken(): string {
  // Convex V8 runtime exposes WebCrypto on globalThis.crypto.
  const bytes = new Uint8Array(32);
  (globalThis as any).crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export type AssembledInvoicePart = {
  name: string;
  oemNumber: string | null;
  brand: string | null;
  qty: number;
  unitCents: number;
  lineCents: number;
};

export type AssembledInvoiceData = {
  bookingId: Id<"bookings">;
  paymentId: Id<"payments">;
  status: "paid" | "refunded";
  invoiceNumber: string | null;
  invoiceStorageId: Id<"_storage"> | null;
  invoiceGeneratedAtMs: number | null;
  invoiceEmailedAtMs: number | null;

  customer: { name: string; email: string };
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    trim: string | null;
    vin: string | null;
  };
  shop: { name: string; address: string | null; phone: string | null };
  mechanicName: string | null;

  services: string[];
  parts: AssembledInvoicePart[];

  laborMinutes: number;
  laborCents: number;
  partsTotalCents: number;
  subtotalCents: number;
  taxCents: number;
  platformFeeCents: number;
  totalCents: number;
  refundedCents: number;
  refundedAtMs: number | null;

  stripeChargeId: string | null;
  stripePaymentIntentId: string | null;

  issuedAtMs: number;
};

function pickVehicleTitle(metadata: any): {
  make: string | null;
  model: string | null;
  trim: string | null;
} {
  if (!metadata || typeof metadata !== "object") {
    return { make: null, model: null, trim: null };
  }
  return {
    make: metadata.make ?? metadata.Make ?? null,
    model: metadata.model ?? metadata.Model ?? null,
    trim: metadata.trim ?? metadata.Trim ?? null,
  };
}

async function assembleInvoiceData(
  ctx: { db: any; storage: any },
  bookingId: Id<"bookings">,
): Promise<AssembledInvoiceData | null> {
    const booking = await ctx.db.get(bookingId);
    if (!booking) return null;

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .unique();
    if (!payment) return null;

    const user = await ctx.db.get(booking.user_id);
    const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
    const mechanic = booking.mechanic_id
      ? await ctx.db.get(booking.mechanic_id)
      : null;

    const vehicleRow = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first();
    const titleFromMeta = pickVehicleTitle(vehicleRow?.metadata);

    const services = await Promise.all(
      (booking.service_ids ?? []).map((sid: Id<"services">) => ctx.db.get(sid)),
    );

    const ja = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .order("desc")
      .first();

    const allSnaps = await ctx.db
      .query("part_snapshots")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", bookingId))
      .collect();
    const liveSnaps = allSnaps.filter(
      (s: any) => !s.superseded_by_id && !s.not_used,
    );

    const parts: AssembledInvoicePart[] = liveSnaps.map((s: any) => {
      const qty = Number(s.quantity ?? 0);
      const unit = Number(s.unit_cost ?? 0);
      const line = Number(s.total_cost ?? qty * unit);
      return {
        name: s.part_name,
        oemNumber: s.oem_part_number ?? null,
        brand: s.brand ?? null,
        qty,
        unitCents: Math.round(unit * 100),
        lineCents: Math.round(line * 100),
      };
    });

    const partsTotalCents = parts.reduce((sum, p) => sum + p.lineCents, 0);

    const laborMinutes = Number(ja?.actual_labor_minutes ?? 0);

    // Tier-aware labor rate (Pricing v2). Falls back to flat shop.labor_rate
    // and then DEFAULT_LABOR_RATE so invoice generation never breaks on an
    // unenriched vehicle — the deep fallback is logged for finance to audit.
    let resolvedLaborRate: number | null = null;
    if (shop && booking.vin) {
      const cfg = await resolveVehicleConfigFromVin(ctx as any, booking.vin);
      const tier =
        (cfg?.pricing_tier as VehicleTier | undefined) ??
        (cfg ? await detectTier(ctx as any, cfg) : null);
      if (tier) {
        const rateRes = resolveLaborRate(shop as any, tier);
        if (rateRes.rate != null) resolvedLaborRate = rateRes.rate;
      }
    }
    let laborRate: number;
    if (resolvedLaborRate != null) {
      laborRate = resolvedLaborRate;
    } else if (typeof shop?.labor_rate === "number") {
      laborRate = shop.labor_rate;
    } else {
      laborRate = DEFAULT_LABOR_RATE;
      console.warn(
        `[assembleInvoiceData] using DEFAULT_LABOR_RATE=${DEFAULT_LABOR_RATE} ` +
          `for booking=${bookingId} shop=${booking.shop_id ?? "?"} vin=${booking.vin ?? "?"}`,
      );
    }
    const laborCents = Math.round((laborMinutes / 60) * laborRate * 100);

    const capturedCents = Number(payment.captured_amount_cents ?? 0);
    const totalCents =
      capturedCents > 0
        ? capturedCents
        : Math.round(Number(payment.amount ?? 0) * 100);

    const subtotalCents = partsTotalCents + laborCents;
    const platformFeeCents = Math.max(
      0,
      Math.round((totalCents * PLATFORM_FEE_BPS) / 10000),
    );
    const taxCents = Math.max(0, totalCents - subtotalCents - platformFeeCents);

    const customerName =
      [user?.first_name, user?.last_name]
        .filter((x): x is string => Boolean(x))
        .join(" ")
        .trim() ||
      user?.username ||
      user?.email ||
      "Customer";

    const customerEmail = user?.email ?? "";

    const mechanicName = mechanic
      ? `${mechanic.first_name ?? ""} ${mechanic.last_name ?? ""}`.trim() ||
        null
      : null;

    const shopAddress = shop
      ? [shop.address, shop.city, shop.state, shop.zip]
          .filter((x): x is string => Boolean(x))
          .join(", ")
      : null;

    const status: "paid" | "refunded" =
      payment.status === "refunded" ? "refunded" : "paid";

    const refundedAtMs =
      status === "refunded" ? (payment.updated_at ?? null) : null;
    const refundedCents = status === "refunded" ? totalCents : 0;

    return {
      bookingId,
      paymentId: payment._id,
      status,
      invoiceNumber: payment.invoice_number ?? null,
      invoiceStorageId: payment.invoice_storage_id ?? null,
      invoiceGeneratedAtMs: payment.invoice_generated_at_ms ?? null,
      invoiceEmailedAtMs: payment.invoice_emailed_at_ms ?? null,

      customer: { name: customerName, email: customerEmail },
      vehicle: {
        year: vehicleRow?.year ?? null,
        make: titleFromMeta.make,
        model: titleFromMeta.model,
        trim: titleFromMeta.trim,
        vin: booking.vin ?? null,
      },
      shop: {
        name: shop?.name ?? "Repair shop",
        address: shopAddress,
        phone: shop?.phone ?? null,
      },
      mechanicName,
      services: services
        .map((s): string | null => (s ? (s as Doc<"services">).name : null))
        .filter((x): x is string => Boolean(x)),
      parts,

      laborMinutes,
      laborCents,
      partsTotalCents,
      subtotalCents,
      taxCents,
      platformFeeCents,
      totalCents,
      refundedCents,
      refundedAtMs,

      stripeChargeId: null,
      stripePaymentIntentId: payment.stripe_payment_intent_id ?? null,

      issuedAtMs:
        payment.invoice_generated_at_ms ??
        payment.updated_at ??
        payment.created_at ??
        Date.now(),
    };
}

/**
 * Internal wrapper around `assembleInvoiceData` so the Node action can reach
 * the assembled view through Convex's runQuery boundary.
 */
export const _assembleInvoiceData = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }) => assembleInvoiceData(ctx, bookingId),
});

/**
 * Auth gate for the mechanic-side `sendInvoiceToEmail` action. Returns true
 * when the calling Clerk user is a shop-side staff member (owner / admin /
 * front desk / mechanic) attached to the booking's shop. Used to authorize
 * walk-in receipt sends without trusting client-side role claims.
 */
const SHOP_STAFF_ROLES = [
  "shop_owner",
  "shop_mechanic",
  "mechanic",
  "front_desk",
  "admin",
];

export const _isCallerAuthorizedShopUser = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }): Promise<boolean> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!me) return false;
    if (me.role === "admin") return true;
    if (!me.role || !SHOP_STAFF_ROLES.includes(me.role)) return false;
    const booking = await ctx.db.get(bookingId);
    if (!booking || !booking.shop_id) return false;
    const link = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", me._id).eq("shop_id", booking.shop_id),
      )
      .unique();
    return !!link;
  },
});

/**
 * Lightweight status query for the mechanic-side Send Receipt card. Returns
 * just enough metadata to render the button label + last-sent caption
 * without pulling the full breakdown. Authorized via the same shop-staff
 * check as the send action.
 */
export const getReceiptStatusForShop = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!me) return null;
    const booking = await ctx.db.get(bookingId);
    if (!booking || !booking.shop_id) return null;
    if (me.role !== "admin") {
      if (!me.role || !SHOP_STAFF_ROLES.includes(me.role)) return null;
      const link = await ctx.db
        .query("shop_users")
        .withIndex("by_user_and_shop", (q: any) =>
          q.eq("user_id", me._id).eq("shop_id", booking.shop_id),
        )
        .unique();
      if (!link) return null;
    }
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .unique();
    if (!payment) return null;
    if (payment.status !== "completed" && payment.status !== "refunded")
      return null;
    const customer = await ctx.db.get(booking.user_id);
    return {
      invoiceNumber: payment.invoice_number ?? null,
      invoiceGeneratedAtMs: payment.invoice_generated_at_ms ?? null,
      invoiceEmailedAtMs: payment.invoice_emailed_at_ms ?? null,
      customerEmail: customer?.email ?? null,
      paymentStatus: payment.status,
    };
  },
});

/**
 * Atomically allocate the next sequential invoice number for the current
 * calendar year AND mint a receipt token on first call. Counter is
 * single-row-per-year; we read-then-patch in the same mutation so Convex's
 * transactional semantics give us race-safety. Returning both lets the
 * Node action embed the token in the email link without a second roundtrip.
 */
export const _allocateInvoiceNumber = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (
    ctx,
    { paymentId },
  ): Promise<{ invoiceNumber: string; receiptToken: string }> => {
    const payment = await ctx.db.get(paymentId);
    if (!payment) throw new Error("payment not found");
    if (payment.invoice_number && payment.receipt_token) {
      return {
        invoiceNumber: payment.invoice_number,
        receiptToken: payment.receipt_token,
      };
    }

    let invoiceNumber = payment.invoice_number ?? null;
    if (!invoiceNumber) {
      const year = new Date().getUTCFullYear();
      const counter = await ctx.db
        .query("invoice_counters")
        .withIndex("by_year", (q: any) => q.eq("year", year))
        .unique();

      let next: number;
      if (counter) {
        next = counter.next_value;
        await ctx.db.patch(counter._id, { next_value: next + 1 });
      } else {
        next = 1;
        await ctx.db.insert("invoice_counters", { year, next_value: 2 });
      }
      invoiceNumber = `INV-${year}-${String(next).padStart(6, "0")}`;
    }

    const receiptToken = payment.receipt_token ?? generateReceiptToken();

    await ctx.db.patch(paymentId, {
      invoice_number: invoiceNumber,
      receipt_token: receiptToken,
    });
    return { invoiceNumber, receiptToken };
  },
});

export const _patchInvoiceMeta = internalMutation({
  args: {
    paymentId: v.id("payments"),
    invoiceStorageId: v.optional(v.id("_storage")),
    invoiceGeneratedAtMs: v.optional(v.number()),
    invoiceEmailedAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.invoiceStorageId !== undefined)
      patch.invoice_storage_id = args.invoiceStorageId;
    if (args.invoiceGeneratedAtMs !== undefined)
      patch.invoice_generated_at_ms = args.invoiceGeneratedAtMs;
    if (args.invoiceEmailedAtMs !== undefined)
      patch.invoice_emailed_at_ms = args.invoiceEmailedAtMs;
    if (Object.keys(patch).length === 0) return;
    await ctx.db.patch(args.paymentId, patch);
  },
});

/**
 * Drop the cached invoice so the next `generateAndEmail` run re-renders.
 * Used after a refund changes the totals — we keep the same invoice number
 * (audit trail) but replace the stored PDF.
 */
export const regenerateInvoice = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }) => {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .unique();
    if (!payment) return;
    const oldId = payment.invoice_storage_id;
    await ctx.db.patch(payment._id, {
      invoice_storage_id: undefined,
      invoice_generated_at_ms: undefined,
      invoice_emailed_at_ms: undefined,
    });
    if (oldId) {
      await ctx.storage.delete(oldId);
    }
  },
});

/**
 * Customer-facing query: returns the full receipt breakdown plus a signed
 * URL for the booking's invoice PDF.
 *
 * Auth — two paths:
 *   1. Clerk-authed user that owns the booking (mobile app + registered web
 *      customers).
 *   2. Capability token (?t=<receipt_token>). Lets walk-in customers who
 *      never created a Clerk account open the receipt straight from the
 *      email deep-link. Token IS the auth; token validity is verified
 *      against payments.receipt_token via the by_receipt_token index.
 *
 * Returns `null` when neither path checks out, or when the booking's
 * payment isn't captured/refunded yet.
 */
export const getReceiptForBooking = query({
  args: {
    bookingId: v.id("bookings"),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { bookingId, token }) => {
    const booking = await ctx.db.get(bookingId);
    if (!booking) return null;

    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .unique();
    if (!payment) return null;
    if (payment.status !== "completed" && payment.status !== "refunded")
      return null;

    // Token path — short-circuits the Clerk lookup. We compare against the
    // stored token rather than trusting the indexed lookup alone, so an
    // empty/null stored token can never match a query-supplied empty value.
    const tokenOk =
      !!token && !!payment.receipt_token && payment.receipt_token === token;

    if (!tokenOk) {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) return null;
      const me = await ctx.db
        .query("users")
        .withIndex("by_clerkUserId", (q: any) =>
          q.eq("clerkUserId", identity.subject),
        )
        .unique();
      if (!me || booking.user_id !== me._id) return null;
    }

    const data = await assembleInvoiceData(ctx, bookingId);
    if (!data) return null;

    const url = data.invoiceStorageId
      ? await ctx.storage.getUrl(data.invoiceStorageId)
      : null;

    // Strip PII not needed by mobile (customer name/email already in the
    // app's user record, vehicle title resolved locally from store).
    return {
      bookingId,
      paymentId: data.paymentId,
      status: data.status,
      invoiceNumber: data.invoiceNumber,
      url,
      generatedAtMs: data.invoiceGeneratedAtMs,
      emailedAtMs: data.invoiceEmailedAtMs,
      breakdown: {
        parts: data.parts,
        laborMinutes: data.laborMinutes,
        laborCents: data.laborCents,
        partsTotalCents: data.partsTotalCents,
        subtotalCents: data.subtotalCents,
        taxCents: data.taxCents,
        platformFeeCents: data.platformFeeCents,
        totalCents: data.totalCents,
        refundedCents: data.refundedCents,
        refundedAtMs: data.refundedAtMs,
      },
    };
  },
});

/**
 * Convenience mutation used by mobile if the user opens "View Receipt"
 * before the auto-trigger from the webhook has landed. Schedules a fresh
 * generation pass; safe to call multiple times (idempotent via storage-id
 * check inside the action).
 */
export const requestInvoiceGeneration = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    const me = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!me) throw new Error("no user");
    const booking = await ctx.db.get(bookingId);
    if (!booking || booking.user_id !== me._id) throw new Error("forbidden");
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", bookingId))
      .unique();
    if (!payment) throw new Error("no payment");
    if (payment.status !== "completed" && payment.status !== "refunded")
      throw new Error("payment not finalized");
    if (payment.invoice_storage_id) return { scheduled: false };
    await ctx.scheduler.runAfter(
      0,
      (internal as any).invoices_node.generateAndEmail,
      { bookingId },
    );
    return { scheduled: true };
  },
});
