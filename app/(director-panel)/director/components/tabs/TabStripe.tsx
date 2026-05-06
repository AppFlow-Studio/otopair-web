'use client'

import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Select, Modal, tableStyles, IconStripe, IconCheck, IconExternal, IconTag } from '../Primitives'
import { SectionAnchor } from '../Shell'

const REFUND_REASONS: Record<string, { label: string; tone: 'red' | 'orange' | 'slate' | 'yellow' }> = {
  service_quality:  { label: 'Service quality',  tone: 'red' },
  customer_no_show: { label: 'Customer no-show', tone: 'orange' },
  shop_no_show:     { label: 'Shop no-show',      tone: 'red' },
  goodwill:         { label: 'Goodwill',          tone: 'slate' },
  duplicate:        { label: 'Duplicate charge',  tone: 'yellow' },
}

const TagRefundModal = ({ bookingId, onClose }: { bookingId: Id<'bookings'> | null; onClose: () => void }) => {
  const [reason, setReason] = useState('')
  const tagRefund = useMutation(api.director.tagRefund)

  const handleSave = async () => {
    if (!bookingId || !reason) return
    await tagRefund({ id: bookingId, reason })
    setReason('')
    onClose()
  }

  return (
    <Modal open={!!bookingId} onClose={onClose} width={480}
      title="Tag refund reason"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={handleSave} disabled={!reason}>Save tag</Button></>}>
      <div style={{ padding:22 }}>
        <div style={{ fontSize:13, color:'var(--slate-600)', marginBottom:14 }}>
          Select a reason for this refund. This will be logged in the audit trail.
        </div>
        <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Reason</label>
        <Select value={reason} onChange={e => setReason(e.target.value)}
          options={[{ value:'', label:'Select a reason…' }, ...Object.entries(REFUND_REASONS).map(([v, r]) => ({ value:v, label:r.label }))]}
          style={{ width:'100%' }} />
        {reason && (
          <div style={{ marginTop:12, padding:'10px 12px', background:'var(--slate-25)', borderRadius:8, border:'1px solid var(--slate-100)', fontSize:12, color:'var(--slate-600)' }}>
            Tagged as <b>{REFUND_REASONS[reason]?.label}</b> — will appear in the refund report.
          </div>
        )}
      </div>
    </Modal>
  )
}

export const TabStripe = () => {
  const [view, setView]           = useState<'accounts' | 'refunds'>('accounts')
  const [tagTarget, setTagTarget] = useState<Id<'bookings'> | null>(null)
  const [stripeFilter, setStripeFilter] = useState('all')

  const shops   = useQuery(api.director.shopsList)
  const refunds = useQuery(api.director.refundedBookingsList)

  const connected    = (shops ?? []).filter(s => s.stripe)
  const notConnected = (shops ?? []).filter(s => !s.stripe)
  const untagged     = (refunds ?? []).filter(r => !r.refundReason)

  const filteredShops = (shops ?? []).filter(s => {
    if (stripeFilter === 'connected')     return s.stripe
    if (stripeFilter === 'not_connected') return !s.stripe
    return true
  })

  return (
    <SectionAnchor id="stripe" title="Stripe Connect" subtitle="Manage connected shop accounts and flag untagged refunds."
      right={
        <div style={{ display:'flex', gap:8 }}>
          <Button onClick={() => setView(v => v === 'accounts' ? 'refunds' : 'accounts')}>
            {view === 'accounts'
              ? `Refunds (${refunds === undefined ? '…' : refunds.length})`
              : 'Accounts'}
          </Button>
          <a href="https://dashboard.stripe.com/" target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
            <Button variant="dark" iconRight={<IconExternal size={13} />}>Open Stripe Dashboard</Button>
          </a>
        </div>
      }>

      {view === 'accounts' && <>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:20 }}>
          {[
            { label:'Connected accounts', value: shops === undefined ? '…' : String(connected.length),    tone:'green' },
            { label:'Not connected',      value: shops === undefined ? '…' : String(notConnected.length), tone:'yellow' },
            { label:'Payouts this week',  value: '—', tone:'blue' },
            { label:'Pending payouts',    value: '—', tone:'slate' },
          ].map(s => (
            <div key={s.label} style={{ padding:'14px 16px', background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10 }}>
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>{s.label}</div>
              <div style={{ fontSize:22, fontWeight:700, color:'var(--slate-900)' }} className="mono">{s.value}</div>
            </div>
          ))}
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12 }}>
          <Select value={stripeFilter} onChange={e => setStripeFilter(e.target.value)}
            options={[{ value:'all', label:'All accounts' },{ value:'connected', label:'Connected' },{ value:'not_connected', label:'Not connected' }]} />
          <span style={{ flex:1 }} />
          <span style={{ fontSize:12, color:'var(--slate-500)' }}>
            {shops === undefined ? 'Loading…' : `${filteredShops.length} shops`}
          </span>
        </div>

        <Card padded={false}>
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Shop</th>
              <th style={tableStyles.th}>Status</th>
              <th style={tableStyles.th}>Payouts</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Pending</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Last payout</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
            </tr></thead>
            <tbody>
              {shops === undefined
                ? <tr><td colSpan={6} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
                : filteredShops.length === 0
                  ? <tr><td colSpan={6} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No shops found.</td></tr>
                  : filteredShops.map(s => (
                    <tr key={s.id}>
                      <td style={tableStyles.td}>
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <span style={{ width:28, height:28, borderRadius:6, background:s.stripe ? '#635BFF' : 'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:s.stripe ? '#fff' : 'var(--slate-400)' }}>
                            <IconStripe size={14} />
                          </span>
                          <div>
                            <div style={{ fontWeight:500 }}>{s.name}</div>
                            <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{String(s.id).slice(-8)}</div>
                          </div>
                        </div>
                      </td>
                      <td style={tableStyles.td}>
                        {s.stripe
                          ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, color:'var(--green-700)', fontWeight:500, fontSize:13 }}><IconCheck size={13} />Connected</span>
                          : <span style={{ color:'var(--slate-400)', fontSize:13 }}>Not connected</span>}
                      </td>
                      <td style={tableStyles.td}>
                        {s.stripe
                          ? s.stripePayoutsEnabled
                            ? <Badge tone="green">Enabled</Badge>
                            : <Badge tone="yellow">Paused</Badge>
                          : <span style={{ color:'var(--slate-400)' }}>—</span>}
                      </td>
                      <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-400)' }}>—</td>
                      <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-400)', fontSize:12 }}>—</td>
                      <td style={{ ...tableStyles.td, textAlign:'right' }}>
                        {s.stripe && s.stripeAccountId
                          ? <a href={`https://dashboard.stripe.com/connect/accounts/${s.stripeAccountId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
                              <Button size="sm" iconRight={<IconExternal size={11} />}>Stripe</Button>
                            </a>
                          : <Button size="sm" variant="primary">Send invite</Button>}
                      </td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </Card>
      </>}

      {view === 'refunds' && <>
        {untagged.length > 0 && (
          <div style={{ padding:'10px 14px', background:'var(--yellow-50)', border:'1px solid var(--yellow-200)', borderRadius:8, marginBottom:16, fontSize:13, color:'var(--yellow-800)', display:'flex', alignItems:'center', gap:8 }}>
            <IconTag size={14} />
            <span><b>{untagged.length} refund{untagged.length !== 1 ? 's' : ''}</b> have no reason tagged. Tag them to keep the refund report clean.</span>
          </div>
        )}
        <Card padded={false}>
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Booking</th>
              <th style={tableStyles.th}>User</th>
              <th style={tableStyles.th}>Shop</th>
              <th style={tableStyles.th}>Date</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Amount</th>
              <th style={tableStyles.th}>Reason</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
            </tr></thead>
            <tbody>
              {refunds === undefined
                ? <tr><td colSpan={7} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
                : refunds.length === 0
                  ? <tr><td colSpan={7} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No refunded bookings.</td></tr>
                  : refunds.map(b => {
                    const r = b.refundReason ? REFUND_REASONS[b.refundReason] : null
                    return (
                      <tr key={b.id}>
                        <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)', fontWeight:500 }}>{String(b.id).slice(-8)}</span></td>
                        <td style={tableStyles.td}>{b.user}</td>
                        <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.shop}</td>
                        <td style={{ ...tableStyles.td, color:'var(--slate-500)', fontSize:12 }}>{b.scheduled}</td>
                        <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                        <td style={tableStyles.td}>
                          {r
                            ? <Badge tone={r.tone}>{r.label}</Badge>
                            : <span style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>Untagged</span>}
                        </td>
                        <td style={{ ...tableStyles.td, textAlign:'right' }}>
                          <Button size="sm" iconRight={<IconTag size={11} />} onClick={() => setTagTarget(b.id)}>Tag</Button>
                        </td>
                      </tr>
                    )
                  })
              }
            </tbody>
          </table>
        </Card>
      </>}

      <TagRefundModal bookingId={tagTarget} onClose={() => setTagTarget(null)} />
    </SectionAnchor>
  )
}
