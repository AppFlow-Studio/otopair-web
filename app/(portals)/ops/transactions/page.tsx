"use client";

// Ops · Transactions Ledger — /ops/transactions (Ops spec p.10).
// Signed-amount ledger + Reconciliation mode toggle: mismatch rows amber
// with reason chip, orphan payments listed, summary bar green at zero.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  CARD_STATIC,
  MICRO_H,
  PageHeader,
  Skeleton,
  StatTile,
  TrendArea,
  TrendBars,
  fmtNum,
  money,
} from "@/components/portal/ChartKit";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();
const fmtAmt = (n: number, cur: string) =>
  `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)} ${cur.toUpperCase()}`;

type LedgerRow = {
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

const MISMATCH_LABEL: Record<string, string> = {
  amount: "amount ≠ payment",
  orphan_transaction: "orphan transaction",
};

// Analytics zone — ledger volume $/day (emerald area) + rows/day (blue bars)
// as two stacked panels from portalSeries.transactionsDaily.
function TransactionsAnalytics({ token }: { token: string }) {
  const days = 30;
  const series = useQuery(api.portalSeries.transactionsDaily, { token, days });

  const volume = series?.reduce((s, d) => s + d.volume_usd, 0);
  const count = series?.reduce((s, d) => s + d.count, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label="Ledger volume (30d)"
          value={series === undefined ? <Skeleton /> : money(volume)}
          spark={series?.map((d) => d.volume_usd)}
          sparkColor="#059669"
        />
        <StatTile
          label="Ledger rows (30d)"
          value={series === undefined ? <Skeleton /> : fmtNum(count)}
          spark={series?.map((d) => d.count)}
          sparkColor="#3b82f6"
        />
      </div>
      <div className={CARD_STATIC}>
        <div className="flex items-baseline justify-between">
          <h2 className={MICRO_H}>Volume per day</h2>
          <span className="text-[11px] text-slate-400">last {days} days</span>
        </div>
        <div className="mt-2">
          <TrendArea
            data={series}
            dataKey="volume_usd"
            name="Volume"
            color="#059669"
            height={150}
            isMoney
          />
        </div>
        <h2 className={`${MICRO_H} mt-5`}>Transactions per day</h2>
        <div className="mt-2">
          <TrendBars data={series} dataKey="count" name="Transactions" color="#93c5fd" height={110} />
        </div>
      </div>
    </div>
  );
}

export default function OpsTransactionsPage() {
  const { token } = usePortalSession();
  const [reconcile, setReconcile] = useState(false);
  const data = useQuery(api.opsTransactions.ledger, { token, reconcile });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions Ledger"
        subtitle="The signed-amount ledger the user's app shows — a record, not a lever."
      >
        <label className="flex items-center gap-2 text-[13px] font-medium text-slate-600">
          <input
            type="checkbox"
            checked={reconcile}
            onChange={(e) => setReconcile(e.target.checked)}
          />
          Reconciliation mode
        </label>
      </PageHeader>

      <TransactionsAnalytics token={token} />

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
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2">When</th>
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2 text-right">Amount</th>
                <th className="px-2 py-2">Trace</th>
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
                  <td className="px-2 py-2 text-slate-600">
                    {t.user && t.user_id ? (
                      <Link href={`/ops/users/${t.user_id}`} className="hover:text-blue-700 hover:underline">
                        {t.user}
                      </Link>
                    ) : (
                      (t.user ?? "—")
                    )}
                  </td>
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
                  <td className="px-2 py-2">
                    <span className="flex items-center gap-2">
                      {t.booking_id ? (
                        <Link
                          href={`/ops/bookings/${t.booking_id}`}
                          className="text-[12px] font-medium text-blue-600 hover:underline"
                        >
                          booking →
                        </Link>
                      ) : null}
                      {t.payment_id ? (
                        <Link
                          href={`/ops/payments/${t.payment_id}`}
                          className="text-[12px] font-medium text-blue-600 hover:underline"
                        >
                          payment →
                        </Link>
                      ) : null}
                      {!t.booking_id && !t.payment_id && (
                        <span className="text-[12px] text-slate-300">—</span>
                      )}
                    </span>
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
                  <Link
                    href={`/ops/payments/${p.id}`}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    payment …{p.id.slice(-6)} →
                  </Link>
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
