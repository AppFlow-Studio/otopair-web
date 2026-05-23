'use client'

import { useState, useEffect } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Card, Input, Select, Toggle, StatusBadge, tableStyles, IconShop } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { consumeGoto } from '../directorNav'
import { BookingDetailModal } from '../BookingDetailModal'

export const TabBookings = () => {
  const [statusFilter, setStatusFilter] = useState('all')
  const [shopFilter, setShopFilter]     = useState('')
  const [untaggedOnly, setUntaggedOnly] = useState(false)
  const [openId, setOpenId]             = useState<Id<'bookings'> | null>(null)

  useEffect(() => {
    const goto = consumeGoto()
    if (goto) setOpenId(goto.entityId as Id<'bookings'>)
  }, [])

  const bookings = useQuery(api.director.recentBookingsList)

  const filtered = (bookings ?? []).filter(b => {
    if (statusFilter !== 'all' && b.status !== statusFilter) return false
    if (shopFilter && !b.shop.toLowerCase().includes(shopFilter.toLowerCase())) return false
    if (untaggedOnly && b.status !== 'refunded') return false
    return true
  })

  return (
    <SectionAnchor id="bookings" title="Bookings" subtitle="Most recent 50 bookings across the marketplace."
>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          options={[{ value:'all', label:'All statuses' },{ value:'pending', label:'Pending' },{ value:'confirmed', label:'Confirmed' },{ value:'in_progress', label:'In progress' },{ value:'completed', label:'Completed' },{ value:'cancelled', label:'Cancelled' },{ value:'refunded', label:'Refunded' }]} />
        <Input icon={<IconShop size={14} />} value={shopFilter} onChange={e => setShopFilter(e.target.value)} placeholder="Filter by shop…" style={{ width:220 }} />
        <span style={{ width:1, height:22, background:'var(--slate-200)' }} />
        <Toggle checked={untaggedOnly} onChange={e => setUntaggedOnly(e.target.checked)} label="Show refunds only" />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {bookings === undefined ? 'Loading…' : `Showing ${filtered.length} of ${bookings.length}`}
        </span>
      </div>
      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Booking</th>
            <th style={tableStyles.th}>User</th>
            <th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>Service(s)</th>
            <th style={tableStyles.th}>Scheduled</th>
            <th style={tableStyles.th}>Status</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Total</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {bookings === undefined
              ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No bookings found.</td></tr>
                : filtered.map(b => (
                  <tr key={b.id} onClick={() => setOpenId(b.id)} style={{ cursor:'pointer' }}>
                    <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)', fontWeight:500 }}>{String(b.id).slice(-8)}</span></td>
                    <td style={tableStyles.td}>{b.user}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.shop}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>{b.services.join(', ') || '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.scheduled}{b.time !== '—' ? ` · ${b.time}` : ''}</td>
                    <td style={tableStyles.td}><StatusBadge status={b.status} /></td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                      <Button size="sm" onClick={() => setOpenId(b.id)}>View</Button>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>
      <BookingDetailModal bookingId={openId} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
