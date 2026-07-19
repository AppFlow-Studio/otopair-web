// =============================================================================
// Ops portal · Transactions Ledger — /ops/transactions (Ops spec p.10).
// Global ledger (new transactions.by_created_at index) + Reconciliation mode:
// amount≠payment, orphan transaction (payment_id → missing payment), orphan
// payment (recent succeeded payment with no ledger row). All windows bounded.
// Read-only — the ledger is a record, not a lever.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import {
  resolveVehicleDisplay,
  resolveServiceNames,
  userDisplayName,
} from "./lib/bookingEnrichment";

const DAY = 24 * 60 * 60 * 1000;

// --- Authored return types (see dataOverview.ts header) -----------------------

export type LedgerRow = {
  id: string;
  user: string | null;
  user_id: string | null;
  description: string;
  sub_description: string | null;
  amount: number;
  currency: string;
  status: string;
  transaction_type: string;
  icon_type: string | null;
  shop: string | null;
  shop_id: string | null;
  service: string | null;
  vehicleYmm: string | null;
  payment_id: string | null;
  booking_id: string | null;
  mismatch: "amount" | "orphan_transaction" | null;
  payment_amount: number | null;
  at: number;
};
export type LedgerResult = {
  rows: LedgerRow[];
  truncated: boolean;
  mismatches: number;
  orphan_payments: { id: string; amount: number; status: string; at: number }[];
};

export const ledger = query({
  args: { token: v.string(), reconcile: v.optional(v.boolean()) },
  handler: async (ctx, { token, reconcile }): Promise<LedgerResult> => {
    await requireDirector(ctx, token);
    // 43 rows measured — window with deep headroom, newest first.
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_created_at")
      .order("desc")
      .take(300);
    const userName = new Map<string, string | null>();
    const shopName = new Map<string, string | null>();
    // Cache booking-derived context (service + vehicle) per booking_id — many
    // ledger rows (auth, capture, refund) can share one booking.
    const bookingCtx = new Map<string, { service: string | null; vehicleYmm: string | null }>();
    const out: LedgerRow[] = [];
    let mismatches = 0;
    for (const t of rows) {
      const uid = String(t.user_id);
      if (!userName.has(uid)) {
        // first_name/last_name via the shared helper (old name?/firstName? guess
        // silently returned null for every real user row).
        userName.set(uid, userDisplayName(await ctx.db.get(t.user_id)));
      }
      let shop: string | null = null;
      if (t.shop_id) {
        const sid = String(t.shop_id);
        if (!shopName.has(sid)) {
          const s = await ctx.db.get(t.shop_id);
          shopName.set(sid, (s as { name?: string } | null)?.name ?? null);
        }
        shop = shopName.get(sid) ?? null;
      }
      let service: string | null = null;
      let vehicleYmm: string | null = null;
      if (t.booking_id) {
        const bid = String(t.booking_id);
        if (!bookingCtx.has(bid)) {
          const booking = await ctx.db.get(t.booking_id);
          if (booking) {
            const [names, vehicle] = await Promise.all([
              resolveServiceNames(ctx, booking.service_ids),
              resolveVehicleDisplay(ctx, booking.vin),
            ]);
            const clean = names.filter((n) => n && n !== "—");
            bookingCtx.set(bid, {
              service:
                clean.length === 0
                  ? null
                  : clean.length === 1
                    ? clean[0]
                    : `${clean[0]} +${clean.length - 1}`,
              vehicleYmm: vehicle.ymm,
            });
          } else {
            bookingCtx.set(bid, { service: null, vehicleYmm: null });
          }
        }
        const bctx = bookingCtx.get(bid)!;
        service = bctx.service;
        vehicleYmm = bctx.vehicleYmm;
      }
      let mismatch: LedgerRow["mismatch"] = null;
      let paymentAmount: number | null = null;
      if (reconcile && t.payment_id) {
        const p = await ctx.db.get(t.payment_id);
        if (!p) {
          mismatch = "orphan_transaction";
        } else {
          paymentAmount = (p as { amount?: number }).amount ?? null;
          if (paymentAmount != null && Math.abs(Math.abs(t.amount) - Math.abs(paymentAmount)) > 0.009) {
            mismatch = "amount";
          }
        }
        if (mismatch) mismatches++;
      }
      out.push({
        id: String(t._id),
        user: userName.get(uid) ?? null,
        user_id: uid,
        description: t.description,
        sub_description: t.sub_description ?? null,
        amount: t.amount,
        currency: t.currency ?? "usd",
        status: t.status,
        transaction_type: t.transaction_type,
        icon_type: t.icon_type ?? null,
        shop,
        shop_id: t.shop_id ? String(t.shop_id) : null,
        service,
        vehicleYmm,
        payment_id: t.payment_id ? String(t.payment_id) : null,
        booking_id: t.booking_id ? String(t.booking_id) : null,
        mismatch,
        payment_amount: paymentAmount,
        at: t.created_at,
      });
    }

    // Orphan payments: succeeded payments (14d window) with no ledger row.
    const orphanPayments: LedgerResult["orphan_payments"] = [];
    if (reconcile) {
      const recentPayments = await ctx.db
        .query("payments")
        .withIndex("by_created_at", (q) => q.gte("created_at", Date.now() - 14 * DAY))
        .take(200);
      for (const p of recentPayments) {
        if (p.status !== "succeeded") continue;
        const linked = await ctx.db
          .query("transactions")
          .withIndex("by_payment_id", (q) => q.eq("payment_id", p._id))
          .first();
        if (!linked) {
          orphanPayments.push({
            id: String(p._id),
            amount: (p as { amount?: number }).amount ?? 0,
            status: p.status,
            at: p.created_at ?? p._creationTime,
          });
        }
      }
      mismatches += orphanPayments.length;
    }

    return { rows: out, truncated: rows.length === 300, mismatches, orphan_payments: orphanPayments };
  },
});
