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
    const out: LedgerRow[] = [];
    let mismatches = 0;
    for (const t of rows) {
      const uid = String(t.user_id);
      if (!userName.has(uid)) {
        const u = await ctx.db.get(t.user_id);
        const uo = u as { name?: string; firstName?: string; email?: string } | null;
        userName.set(uid, uo?.name ?? uo?.firstName ?? uo?.email ?? null);
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
