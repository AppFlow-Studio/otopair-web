"use client";

// Ops · Transactions Ledger — /ops/transactions (Ops spec p.10).
// Signed-amount ledger + Reconciliation mode toggle: mismatch rows amber
// with reason chip, orphan payments listed, summary bar green at zero.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();
const fmtAmt = (n: number, cur: string) =>
  `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)} ${cur.toUpperCase()}`;

type LedgerRow = {
  id: string;
  user: string | null;
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

const MISMATCH_LABEL: Record<string, string> = {
  amount: "amount ≠ payment",
  orphan_transaction: "orphan transaction",
};

export default function OpsTransactionsPage() {
  const { token } = usePortalSession();
  const [reconcile, setReconcile] = useState(false);
  const data = useQuery(api.opsTransactions.ledger, { token, reconcile });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Transactions Ledger</h1>
        <label className="ml-auto flex items-center gap-2 text-[13px] font-medium text-slate-600">
          <input
            type="checkbox"
            checked={reconcile}
            onChange={(e) => setReconcile(e.target.checked)}
          />
          Reconciliation mode
        </label>
      </div>

      {reconcile && data && (
        <div
          className={`rounded-lg border px-4 py-2 text-[13px] font-semibold ${
            data.mismatches === 0
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-300 bg-amber-50 text-amber-800"
          }`}
        >
          {data.mismatches === 0
            ? "0 mismatches — ledger reconciles clean against payments."
            : `${data.mismatches} mismatch${data.mismatches === 1 ? "" : "es"} need eyes.`}
        </div>
      )}

      {data === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No transactions on this deployment.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">When</th>
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2 text-right">Amount</th>
                {reconcile && <th className="px-2 py-2">Check</th>}
              </tr>
            </thead>
            <tbody>
              {(data.rows as LedgerRow[]).map((t) => (
                <tr
                  key={t.id}
                  className={`border-b border-slate-50 ${t.mismatch ? "bg-amber-50/60" : ""}`}
                >
                  <td className="px-4 py-2 text-slate-500">{fmtDate(t.at)}</td>
                  <td className="px-2 py-2 text-slate-600">{t.user ?? "—"}</td>
                  <td className="px-2 py-2 text-slate-800">
                    {t.description}
                    {t.sub_description && (
                      <span className="ml-1 text-[12px] text-slate-400">
                        · {t.sub_description}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <span className={`${pill} bg-slate-100 text-slate-600`}>
                      {t.transaction_type}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-slate-600">{t.status}</td>
                  <td
                    className={`px-2 py-2 text-right font-mono text-[12px] font-semibold ${
                      t.amount < 0 ? "text-red-600" : "text-emerald-700"
                    }`}
                  >
                    {fmtAmt(t.amount, t.currency)}
                  </td>
                  {reconcile && (
                    <td className="px-2 py-2">
                      {t.mismatch ? (
                        <span
                          className={`${pill} bg-amber-100 text-amber-800`}
                          title={
                            t.mismatch === "amount"
                              ? `ledger ${t.amount} vs payment ${t.payment_amount}`
                              : "payment_id points at a missing payment"
                          }
                        >
                          {MISMATCH_LABEL[t.mismatch]}
                        </span>
                      ) : t.payment_id ? (
                        <span className={`${pill} bg-emerald-50 text-emerald-700`}>✓</span>
                      ) : (
                        <span className={`${pill} bg-slate-100 text-slate-400`}>no payment</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {data.truncated && (
            <div className="px-4 py-2 text-[11px] text-amber-600">
              window truncated at 300 rows
            </div>
          )}
        </div>
      )}

      {reconcile && data && data.orphan_payments.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-white p-4">
          <h2 className="text-sm font-semibold text-amber-800">
            Orphan payments (succeeded, 14d, no ledger row)
          </h2>
          <div className="mt-2 space-y-1.5">
            {data.orphan_payments.map(
              (p: { id: string; amount: number; status: string; at: number }) => (
                <div key={p.id} className="flex items-center gap-3 text-[13px] text-slate-600">
                  <span className="font-mono text-[12px]">{p.id.slice(0, 12)}…</span>
                  <span className="font-semibold text-slate-800">${p.amount.toFixed(2)}</span>
                  <span>{fmtDate(p.at)}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
