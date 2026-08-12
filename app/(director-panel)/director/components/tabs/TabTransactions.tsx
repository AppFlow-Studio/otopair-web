'use client'

// Director · Transactions Ledger — hash tab #transactions.
// Faithful port of /ops/transactions: the signed-amount ledger the user's app
// shows (a record, not a lever) + Reconciliation mode. In reconcile mode,
// mismatch rows are amber with a reason chip, orphan payments are listed, and a
// summary bar turns green at zero. Read-only.

import { useState, useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Badge, Card, Toggle, tableStyles, MicroH } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import { StatCard, DailyBars, Sparkline, money, fmtNumber } from '../Charts'

// ---------------------------------------------------------------------------
// Local helpers — no director equivalent
// ---------------------------------------------------------------------------

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

// Signed +/- amount, e.g. "−$42.00 USD" / "+$118.00 USD".
const fmtAmt = (n: number, cur: string) =>
  `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)} ${(cur ?? 'usd').toUpperCase()}`

type LedgerRow = {
  id: string
  user: string | null
  user_id: string | null
  description: string
  sub_description: string | null
  amount: number
  currency: string
  status: string
  transaction_type: string
  icon_type: string | null
  shop: string | null
  shop_id: string | null
  service: string | null
  vehicleYmm: string | null
  payment_id: string | null
  booking_id: string | null
  mismatch: 'amount' | 'orphan_transaction' | null
  payment_amount: number | null
  at: number
}

const MISMATCH_LABEL: Record<string, string> = {
  amount: 'amount ≠ payment',
  orphan_transaction: 'orphan transaction',
}

// A subtle mono link that reads like a table cell, used for the trace column.
const TraceLink = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button
    onClick={onClick}
    style={{
      border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
      fontSize: 12, fontWeight: 500, color: 'var(--blue-600)', fontFamily: 'inherit',
    }}
    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'underline' }}
    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'none' }}>
    {children}
  </button>
)

// ---------------------------------------------------------------------------
// Analytics zone — ledger volume $/day (emerald area) + rows/day (blue bars),
// from portalSeries.transactionsDaily. Mirrors the two stacked ops panels.
// ---------------------------------------------------------------------------

const TransactionsAnalytics = ({ token }: { token: string }) => {
  const days = 30
  const series = useQuery(api.portalSeries.transactionsDaily, { token, days }) as
    | { date: string; count: number; volume_usd: number }[]
    | undefined

  const volume = series?.reduce((s, d) => s + d.volume_usd, 0)
  const count = series?.reduce((s, d) => s + d.count, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StatCard label="Ledger volume (30d)" tone="green"
          value={series === undefined ? '—' : money(volume)}
          spark={series?.map(d => d.volume_usd)} />
        <StatCard label="Ledger rows (30d)" tone="blue"
          value={series === undefined ? '—' : fmtNumber(count)}
          spark={series?.map(d => d.count)} />
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <MicroH>Volume per day</MicroH>
          <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>last {days} days</span>
        </div>
        {series === undefined ? (
          <div style={{ height: 150, background: 'var(--slate-50)', borderRadius: 8 }} />
        ) : (
          <Sparkline
            values={series.map(d => d.volume_usd)}
            height={150}
            color="#059669"
            fill="var(--green-50)"
            style={{ height: 150 }} />
        )}

        <div style={{ marginTop: 18 }}>
          <MicroH>Transactions per day</MicroH>
        </div>
        <div style={{ marginTop: 8 }}>
          <DailyBars
            data={series?.map(d => ({ label: d.date.slice(5), value: d.count }))}
            color="#93c5fd"
            height={110} />
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TabTransactions root
// ---------------------------------------------------------------------------

export const TabTransactions = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const [reconcile, setReconcile] = useState(false)

  const data = useQuery(api.opsTransactions.ledger, { token, reconcile }) as
    | {
        rows: LedgerRow[]
        truncated: boolean
        mismatches: number
        orphan_payments: { id: string; amount: number; status: string; at: number }[]
      }
    | undefined

  return (
    <SectionAnchor id="transactions" title="Transactions Ledger"
      subtitle="The signed-amount ledger the user's app shows — a record, not a lever."
      right={
        <Toggle checked={reconcile} onChange={e => setReconcile(e.target.checked)} label="Reconciliation mode" />
      }>

      <TransactionsAnalytics token={token} />

      {reconcile && data && (
        <div style={{
          borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16,
          border: `1px solid ${data.mismatches === 0 ? '#A7F3D0' : '#FDE68A'}`,
          background: data.mismatches === 0 ? 'var(--green-50)' : 'var(--yellow-50)',
          color: data.mismatches === 0 ? 'var(--green-700)' : 'var(--yellow-800)',
        }}>
          {data.mismatches === 0
            ? '0 mismatches — ledger reconciles clean against payments.'
            : `${data.mismatches} mismatch${data.mismatches === 1 ? '' : 'es'} need eyes.`}
        </div>
      )}

      {data === undefined ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ height: 40, borderRadius: 8, background: 'var(--slate-100)' }} className="animate-pulse" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 32, color: 'var(--slate-500)', fontSize: 13 }}>
          No transactions on this deployment.
        </Card>
      ) : (
        <Card padded={false}>
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>When</th>
              <th style={tableStyles.th}>User</th>
              <th style={tableStyles.th}>Description</th>
              <th style={tableStyles.th}>Shop</th>
              <th style={tableStyles.th}>Type</th>
              <th style={tableStyles.th}>Status</th>
              <th style={{ ...tableStyles.th, textAlign: 'right' }}>Amount</th>
              <th style={tableStyles.th}>Trace</th>
              {reconcile && <th style={tableStyles.th}>Check</th>}
            </tr></thead>
            <tbody>
              {data.rows.map(t => (
                <tr key={t.id} style={t.mismatch ? { background: 'var(--yellow-50)' } : undefined}>
                  <td style={{ ...tableStyles.td, color: 'var(--slate-500)', fontSize: 12 }}>{fmtDate(t.at)}</td>
                  <td style={{ ...tableStyles.td, color: 'var(--slate-600)' }}>
                    {t.user && t.user_id ? (
                      <TraceLink onClick={() => gotoEntity('users', String(t.user_id))}>{t.user}</TraceLink>
                    ) : (
                      (t.user ?? '—')
                    )}
                  </td>
                  <td style={tableStyles.td}>
                    <span style={{ color: 'var(--slate-800)' }}>{t.description}</span>
                    {t.sub_description && (
                      <span style={{ marginLeft: 4, fontSize: 12, color: 'var(--slate-400)' }}>· {t.sub_description}</span>
                    )}
                    {(t.service || t.vehicleYmm) && (
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--slate-400)' }}>
                        {[t.service, t.vehicleYmm].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </td>
                  <td style={{ ...tableStyles.td, color: 'var(--slate-600)' }}>
                    {t.shop_id && t.shop ? (
                      <TraceLink onClick={() => gotoEntity('shops', String(t.shop_id))}>{t.shop}</TraceLink>
                    ) : (
                      <span style={{ color: 'var(--slate-300)' }}>—</span>
                    )}
                  </td>
                  <td style={tableStyles.td}>
                    <Badge tone="slate">{t.transaction_type}</Badge>
                  </td>
                  <td style={{ ...tableStyles.td, color: 'var(--slate-600)' }}>{t.status}</td>
                  <td style={{
                    ...tableStyles.td, textAlign: 'right', fontWeight: 600, fontSize: 12,
                    color: t.amount < 0 ? 'var(--red-600, #DC2626)' : 'var(--green-700)',
                  }} className="mono">
                    {fmtAmt(t.amount, t.currency)}
                  </td>
                  <td style={tableStyles.td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {t.booking_id ? (
                        <TraceLink onClick={() => gotoEntity('bookings', String(t.booking_id))}>booking →</TraceLink>
                      ) : null}
                      {t.payment_id ? (
                        <TraceLink onClick={() => gotoEntity('stripe', String(t.payment_id))}>payment →</TraceLink>
                      ) : null}
                      {!t.booking_id && !t.payment_id && (
                        <span style={{ fontSize: 12, color: 'var(--slate-300)' }}>—</span>
                      )}
                    </span>
                  </td>
                  {reconcile && (
                    <td style={tableStyles.td}>
                      {t.mismatch ? (
                        <span title={
                          t.mismatch === 'amount'
                            ? `ledger ${t.amount} vs payment ${t.payment_amount}`
                            : 'payment_id points at a missing payment'
                        } style={{ cursor: 'help' }}>
                          <Badge tone="yellow">{MISMATCH_LABEL[t.mismatch]}</Badge>
                        </span>
                      ) : t.payment_id ? (
                        <Badge tone="green">✓</Badge>
                      ) : (
                        <Badge tone="slate">no payment</Badge>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {data.truncated && (
            <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--yellow-700)' }}>
              window truncated at 300 rows
            </div>
          )}
        </Card>
      )}

      {reconcile && data && data.orphan_payments.length > 0 && (
        <Card style={{ marginTop: 16, borderColor: '#FDE68A' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--yellow-800)' }}>
            Orphan payments (succeeded, 14d, no ledger row)
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            {data.orphan_payments.map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--slate-600)' }}>
                <TraceLink onClick={() => gotoEntity('stripe', String(p.id))}>
                  payment …{p.id.slice(-6)} →
                </TraceLink>
                <span style={{ fontWeight: 600, color: 'var(--slate-800)' }} className="mono">${p.amount.toFixed(2)}</span>
                <span>{fmtDate(p.at)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </SectionAnchor>
  )
}
