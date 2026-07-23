'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge, tableStyles } from '../../Primitives'
import { H2, Loading, fmtDate, fmtMoney, statusTone, openPayment } from './usersUi'

const Roll = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Card>
    <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>{label}</div>
    <div style={{ marginTop:2, fontSize:18, fontWeight:700, color:'var(--slate-900)' }}>{children}</div>
  </Card>
)

export const UserMoneyTab = ({ userId, onOpenBooking }:
  { userId: Id<'users'>; onOpenBooking: (id: Id<'bookings'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const data = useQuery(api.opsUsers.money, { token: session?.token ?? '', id: userId })

  if (data === undefined) return <Loading label="money" />

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
        <Roll label="Captured (lifetime)">{fmtMoney(data.rollups.capturedTotal)}</Roll>
        <Roll label="Avg ticket">{fmtMoney(data.rollups.avgTicket)}</Roll>
        <Roll label="Payments">{data.rollups.paymentCount}</Roll>
        <Roll label="Refunded">
          {fmtMoney(data.rollups.refundTotal)}
          {data.rollups.refundRate != null && data.rollups.refundRate > 0 && <span style={{ marginLeft:4, fontSize:11, fontWeight:400, color:'var(--red-500, #EF4444)' }}>{Math.round(data.rollups.refundRate * 100)}%</span>}
        </Roll>
      </div>

      <Card padded={false}>
        <div style={{ padding:'16px 18px 8px' }}><H2>Payments</H2></div>
        {data.payments.length === 0
          ? <div style={{ padding:'0 18px 18px', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>No payments for this user yet.</div>
          : (
            <table style={tableStyles.table}>
              <thead><tr>
                <th style={tableStyles.th}>Date</th><th style={tableStyles.th}>Amount</th><th style={tableStyles.th}>Captured</th>
                <th style={tableStyles.th}>Status</th><th style={tableStyles.th}>Method</th><th style={tableStyles.th}>Invoice</th><th style={tableStyles.th}>Links</th>
              </tr></thead>
              <tbody>
                {data.payments.map(p => (
                  <tr key={p.id}>
                    <td style={{ ...tableStyles.td, color:'var(--slate-500)' }}>{fmtDate(p.created)}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-700)' }} className="mono">{fmtMoney(p.amount)}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-500)' }} className="mono">{p.capturedAmountCents != null ? fmtMoney(p.capturedAmountCents / 100) : '—'}</td>
                    <td style={tableStyles.td}><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-500)' }}>{p.origin ?? p.method ?? '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-500)' }} className="mono">{p.invoiceNumber ?? '—'}</td>
                    <td style={{ ...tableStyles.td, whiteSpace:'nowrap', fontSize:12 }}>
                      <span onClick={() => openPayment(p.id)} style={{ fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>Payment</span>
                      <span style={{ margin:'0 4px', color:'var(--slate-300)' }}>·</span>
                      <span onClick={() => onOpenBooking(p.bookingId as Id<'bookings'>)} style={{ fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>Booking</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      <Card>
        <H2>Transactions ledger</H2>
        <p style={{ margin:'2px 0 0', fontSize:12, color:'var(--slate-400)' }}>Exactly what the user sees in-app.</p>
        {data.transactions.length === 0
          ? <div style={{ padding:'20px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>No transactions for this user yet.</div>
          : (
            <div style={{ marginTop:12 }}>
              {data.transactions.map(t => (
                <div key={t.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, borderBottom:'1px solid var(--slate-50)', padding:'10px 0' }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', fontSize:13, fontWeight:500, color:'var(--slate-800)' }}>{t.description}</div>
                    <div style={{ fontSize:12, color:'var(--slate-400)' }}>
                      {fmtDate(t.created)} · {t.type}{t.subDescription ? ` · ${t.subDescription}` : ''}
                      {t.bookingId && <> · <span onClick={() => onOpenBooking(t.bookingId as Id<'bookings'>)} style={{ fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>booking →</span></>}
                    </div>
                  </div>
                  <div className="mono" style={{ flexShrink:0, fontSize:13, fontWeight:600, color: t.amount < 0 ? 'var(--red-600)' : 'var(--green-600)' }}>{t.amount < 0 ? '−' : '+'}{fmtMoney(Math.abs(t.amount))}</div>
                </div>
              ))}
            </div>
          )}
      </Card>

      <Card>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between' }}>
          <H2>Loyalty credits</H2>
          <span style={{ fontSize:13, fontWeight:600, color:'var(--slate-800)' }}>Balance {fmtMoney(data.creditBalance)}</span>
        </div>
        {data.credits.length === 0
          ? <div style={{ padding:'16px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>No credit transactions.</div>
          : (
            <div style={{ marginTop:12 }}>
              {data.credits.map(c => (
                <div key={c.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, borderBottom:'1px solid var(--slate-50)', padding:'8px 0' }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', fontSize:13, color:'var(--slate-800)' }}>{c.description ?? c.type.replace(/_/g, ' ')}</div>
                    <div style={{ fontSize:11, color:'var(--slate-400)' }}>{fmtDate(c.created)} · {c.type.replace(/_/g, ' ')}{c.expiresAt ? ` · expires ${fmtDate(c.expiresAt)}` : ''}</div>
                  </div>
                  <div className="mono" style={{ flexShrink:0, fontSize:13, fontWeight:600, color: c.amount < 0 ? 'var(--red-600)' : 'var(--green-600)' }}>{c.amount < 0 ? '−' : '+'}{fmtMoney(Math.abs(c.amount))}</div>
                </div>
              ))}
            </div>
          )}
      </Card>
    </div>
  )
}
