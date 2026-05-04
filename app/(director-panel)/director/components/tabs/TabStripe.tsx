'use client'

import { useState } from 'react'
import { Badge, Button, Card, Select, Toggle, StatusBadge, Modal, AuditButton, tableStyles, IconStripe, IconCheck, IconExternal, IconRefresh, IconTag, IconX } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { SHOPS, REFUNDS, STRIPE_ACCOUNTS, BOOKINGS, SHOP_AUDIT } from '../../data'

const payoutBadge = (schedule: string) => {
  if (schedule === 'Daily') return <Badge tone="green">{schedule}</Badge>
  if (schedule === '—' || schedule === 'Paused') return <Badge tone="slate">{schedule}</Badge>
  return <Badge tone="indigo">{schedule}</Badge>
}

const REFUND_REASONS: Record<string, { label: string; tone: 'red' | 'orange' | 'slate' | 'yellow' }> = {
  service_quality: { label: 'Service quality',   tone: 'red' },
  customer_no_show:{ label: 'Customer no-show',  tone: 'orange' },
  shop_no_show:    { label: 'Shop no-show',       tone: 'red' },
  goodwill:        { label: 'Goodwill',           tone: 'slate' },
  duplicate:       { label: 'Duplicate charge',   tone: 'yellow' },
}

const TagRefundModal = ({ bookingId, onClose }: { bookingId: string | null; onClose: () => void }) => {
  const [reason, setReason] = useState('')
  return (
    <Modal open={!!bookingId} onClose={onClose} width={480}
      title="Tag refund reason"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onClose}>Save tag</Button></>}>
      <div style={{ padding:22 }}>
        <div style={{ fontSize:13, color:'var(--slate-600)', marginBottom:14 }}>
          Select a reason for the refund on <span className="mono" style={{ color:'var(--blue-700)', fontWeight:600 }}>{bookingId}</span>.
          This will be logged in the audit trail.
        </div>
        <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Reason</label>
        <Select value={reason} onChange={e => setReason(e.target.value)}
          options={[{ value:'', label:'Select a reason…' }, ...Object.entries(REFUND_REASONS).map(([v, r]) => ({ value: v, label: r.label }))]}
          style={{ width:'100%' }} />
        {reason && (
          <div style={{ marginTop:12, padding:'10px 12px', background:'var(--slate-25)', borderRadius:8, border:'1px solid var(--slate-100)', fontSize:12, color:'var(--slate-600)' }}>
            This refund will be tagged as <b>{REFUND_REASONS[reason]?.label}</b> and surfaced in the refund report.
          </div>
        )}
      </div>
    </Modal>
  )
}

export const TabStripe = () => {
  const [view, setView] = useState<'accounts' | 'refunds'>('accounts')
  const [tagTarget, setTagTarget] = useState<string | null>(null)
  const [stripeFilter, setStripeFilter] = useState('all')

  const refunds = BOOKINGS.filter(b => b.status === 'refunded')
  const connected = SHOPS.filter(s => s.stripe)
  const notConnected = SHOPS.filter(s => !s.stripe)

  return (
    <SectionAnchor id="stripe" title="Stripe Connect" subtitle="Manage connected shop accounts, payouts, and flag untagged refunds."
      right={
        <div style={{ display:'flex', gap:8 }}>
          <Button onClick={() => setView(v => v === 'accounts' ? 'refunds' : 'accounts')}>
            {view === 'accounts' ? `Refunds (${refunds.length})` : 'Accounts'}
          </Button>
          <Button variant="dark" iconRight={<IconExternal size={13} />}>Open Stripe Dashboard</Button>
        </div>
      }>

      {view === 'accounts' && <>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:20 }}>
          {[
            { label:'Connected accounts', value: connected.length, tone:'green' },
            { label:'Not connected',       value: notConnected.length, tone:'yellow' },
            { label:'Payouts this week',   value: '$14,821', tone:'blue' },
            { label:'Pending payouts',     value: '$6,204', tone:'slate' },
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
        </div>

        <Card padded={false}>
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Shop</th>
              <th style={tableStyles.th}>Status</th>
              <th style={tableStyles.th}>Payout schedule</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Pending</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Last payout</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
            </tr></thead>
            <tbody>
              {SHOPS.filter(s => {
                if (stripeFilter === 'connected') return s.stripe
                if (stripeFilter === 'not_connected') return !s.stripe
                return true
              }).map(s => (
                <tr key={s.id}>
                  <td style={tableStyles.td}>
                    <div>
                      <div style={{ fontWeight:500 }}>{s.name}</div>
                      <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{s.id}</div>
                    </div>
                  </td>
                  <td style={tableStyles.td}>
                    {s.stripe
                      ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, color:'var(--green-700)', fontWeight:500, fontSize:13 }}><IconCheck size={13} />Connected</span>
                      : <span style={{ color:'var(--slate-400)', fontSize:13 }}>Not connected</span>}
                  </td>
                  <td style={tableStyles.td}>{payoutBadge(s.payoutSchedule)}</td>
                  <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">
                    {s.stripe ? `$${(Math.random() * 3000 + 200).toFixed(2)}` : '—'}
                  </td>
                  <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-500)', fontSize:12 }}>
                    {s.stripe ? 'Apr 28' : '—'}
                  </td>
                  <td style={{ ...tableStyles.td, textAlign:'right' }}>
                    {s.stripe
                      ? <Button size="sm" iconRight={<IconExternal size={11} />}>Stripe</Button>
                      : <Button size="sm" variant="primary">Send invite</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </>}

      {view === 'refunds' && <>
        <div style={{ padding:'10px 14px', background:'var(--yellow-50)', border:'1px solid var(--yellow-200)', borderRadius:8, marginBottom:16, fontSize:13, color:'var(--yellow-800)', display:'flex', alignItems:'center', gap:8 }}>
          <IconTag size={14} />
          <span><b>{refunds.filter(b => !b.refundReason).length} refund{refunds.filter(b => !b.refundReason).length !== 1 ? 's' : ''}</b> have no reason tagged. Tag them to keep the refund report clean.</span>
        </div>
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
              {refunds.map(b => {
                const r = b.refundReason ? REFUND_REASONS[b.refundReason] : null
                return (
                  <tr key={b.id}>
                    <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)', fontWeight:500 }}>{b.id}</span></td>
                    <td style={tableStyles.td}>{b.user}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.shop}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-500)', fontSize:12 }}>{b.scheduled}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                    <td style={tableStyles.td}>
                      {r ? <Badge tone={r.tone}>{r.label}</Badge> : <span style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>Untagged</span>}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }}>
                      <Button size="sm" iconRight={<IconTag size={11} />} onClick={() => setTagTarget(b.id)}>Tag</Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      </>}

      <TagRefundModal bookingId={tagTarget} onClose={() => setTagTarget(null)} />
    </SectionAnchor>
  )
}
