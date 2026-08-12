'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge, tableStyles } from '../../Primitives'
import { Loading, fmtMoney, statusTone, openShop } from './usersUi'
import { fmtDate } from '../../Charts'

export const UserBookingsTab = ({ userId, onOpenBooking }:
  { userId: Id<'users'>; onOpenBooking: (id: Id<'bookings'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const rows = useQuery(api.opsUsers.bookings, { token: session?.token ?? '', id: userId })

  if (rows === undefined) return <Loading label="bookings" />

  return (
    <Card padded={false}>
      {rows.length === 0
        ? <div style={{ padding:'20px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>No bookings for this user yet.</div>
        : (
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Status</th><th style={tableStyles.th}>Shop</th><th style={tableStyles.th}>Vehicle</th>
              <th style={tableStyles.th}>Services</th><th style={tableStyles.th}>Scheduled</th><th style={tableStyles.th}>Created</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Total</th><th style={tableStyles.th}></th>
            </tr></thead>
            <tbody>
              {rows.map(b => (
                <tr key={b.id}>
                  <td style={tableStyles.td}><span onClick={() => onOpenBooking(b.id as Id<'bookings'>)} style={{ cursor:'pointer' }}><Badge tone={statusTone(b.status)}>{b.status}</Badge></span></td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-700)' }}>{b.shop_id ? <a onClick={() => openShop(b.shop_id!)} style={{ cursor:'pointer' }}>{b.shop}</a> : b.shop}</td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.vehicleYmm ?? '—'}</td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.services.length > 0 ? b.services.join(', ') : '—'}</td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-500)' }}>{fmtDate(b.scheduledDate)}</td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-500)' }}>{fmtDate(b.created)}</td>
                  <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-700)' }} className="mono">
                    {fmtMoney(b.total)}
                    {(b.laborCost != null || b.partsCost != null) && (
                      <div style={{ fontSize:11, fontWeight:400, color:'var(--slate-400)' }}>
                        {[b.laborCost != null ? `Labor ${fmtMoney(b.laborCost)}` : null, b.partsCost != null ? `Parts ${fmtMoney(b.partsCost)}` : null].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td style={{ ...tableStyles.td, textAlign:'right' }}>
                    <span onClick={() => onOpenBooking(b.id as Id<'bookings'>)} style={{ fontSize:12, fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>Open →</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Card>
  )
}
