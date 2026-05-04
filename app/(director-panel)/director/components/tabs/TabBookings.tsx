'use client'

import { useState } from 'react'
import { Button, Card, Input, Select, Toggle, StatusBadge, NotesPanel, Modal, AuditButton, Avatar, IconStar, tableStyles, IconCalendar, IconShop, IconExternal, IconCheck } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { BOOKINGS, BOOKING_AUDIT, BOOKING_HISTORY } from '../../data'
import type { Booking } from '../../data'

const BookingTimeline = ({ history }: { history: typeof BOOKING_HISTORY }) => {
  const stages = ['pending','confirmed','in_progress','completed']
  const reached = history.map(h => h.stage)
  return (
    <div style={{ display:'flex', alignItems:'center', gap:0, padding:'16px 0' }}>
      {stages.map((s, i) => {
        const done = reached.includes(s)
        const event = history.find(h => h.stage === s)
        const color = done ? (s === 'completed' ? 'var(--green-600)' : 'var(--blue-600)') : 'var(--slate-300)'
        return (
          <div key={s} style={{ display:'contents' }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, minWidth:120 }}>
              <div style={{ width:28, height:28, borderRadius:999, background:done ? color : '#fff', border:`2px solid ${color}`, display:'inline-flex', alignItems:'center', justifyContent:'center', color:done ? '#fff' : 'var(--slate-300)' }}>
                {done ? <IconCheck size={14} /> : <span style={{ fontSize:11, fontWeight:600 }}>{i+1}</span>}
              </div>
              <div style={{ fontSize:12, fontWeight:500, color:'var(--slate-800)', textTransform:'capitalize' }}>{s.replace('_',' ')}</div>
              {event && <div style={{ fontSize:11, color:'var(--slate-500)', textAlign:'center' }}>{event.time}<br/>{event.by}</div>}
            </div>
            {i < stages.length - 1 && <div style={{ flex:1, height:2, background:reached.includes(stages[i+1]) ? 'var(--blue-600)' : 'var(--slate-200)', marginTop:-32 }} />}
          </div>
        )
      })}
    </div>
  )
}

const BookingModal = ({ booking, onClose }: { booking: Booking | undefined; onClose: () => void }) => {
  const [auditOpen, setAuditOpen] = useState(false)
  return (
    <Modal open={!!booking} onClose={onClose} width={920}
      eyebrow={<span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{booking?.id}</span>}
      statusBadge={booking && <StatusBadge status={booking.status} />}
      title={booking?.service ?? ''}
      headerRight={<>
        <AuditButton onClick={() => setAuditOpen(o => !o)} count={BOOKING_AUDIT.length} />
        <Button iconRight={<IconExternal size={13} />}>View on Stripe</Button>
        <Button variant="primary">Open Booking</Button>
      </>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Booking audit log', subtitle:booking ? `${booking.id} · ${booking.service}` : '', entries:BOOKING_AUDIT }}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary">Save changes</Button></>}>
      {booking && <>
        <div style={{ padding:'4px 24px 12px', background:'#fff' }}>
          <div style={{ fontSize:13, color:'var(--slate-600)' }}>{booking.user} · {booking.shop}</div>
        </div>
        <div style={{ padding:'8px 24px 16px', borderBottom:'1px solid var(--slate-200)' }}>
          <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Status timeline</div>
          <BookingTimeline history={BOOKING_HISTORY} />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Payment</div>
            {[['Total charged',`$${booking.total.toFixed(2)}`],['Stripe payment ID','pi_3QkR…7Lb'],['Card','Visa ····4242'],['Platform fee','$12.45']].map(([l,v]) => (
              <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:12 }}>
                <span style={{ color:'var(--slate-500)' }}>{l}</span>
                <span className={l === 'Total charged' || l === 'Platform fee' ? 'mono' : ''} style={{ fontWeight:l === 'Total charged' ? 600 : undefined, color:l === 'Stripe payment ID' ? 'var(--blue-700)' : undefined }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Mechanic assigned</div>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <Avatar name={booking.mechanic || 'Unassigned'} size={36} />
              <div><div style={{ fontSize:13, fontWeight:500 }}>{booking.mechanic || 'Unassigned'}</div><div style={{ fontSize:12, color:'var(--slate-500)' }}>{booking.shop}</div></div>
            </div>
          </div>
          <div style={{ padding:18 }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>User rating</div>
            <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:6 }}>
              {[1,2,3,4,5].map(i => <IconStar key={i} size={16} style={{ color:i <= 4 ? '#F59E0B' : 'var(--slate-200)' }} />)}
              <span style={{ marginLeft:6, fontSize:13, fontWeight:500 }}>4.0</span>
            </div>
            <div style={{ fontSize:12, color:'var(--slate-600)', fontStyle:'italic' }}>"Quick service, fair price. Mechanic explained everything before starting."</div>
          </div>
        </div>
        <div style={{ padding:22, background:'var(--slate-25)' }}>
          <NotesPanel placeholder="Add an internal note about this booking…" initialNotes={[
            { author:'Temur AB', when:'2h ago', text:'Mechanic confirmed parts arrived. Customer notified via SMS.' },
            { author:'System', system:true, when:'Apr 28, 9:14 AM', text:'Reminder SMS auto-sent to customer (24h before appointment).' },
            { author:'Daniel Chelala', when:'Apr 28', text:'Flagged for follow-up — customer asked about extended warranty option.' },
            { author:'System', system:true, when:'Apr 27, 4:02 PM', text:'Booking auto-rescheduled by shop calendar sync (12:30 PM → 2:00 PM).' },
          ]} />
        </div>
      </>}
    </Modal>
  )
}

export const TabBookings = () => {
  const [openId, setOpenId] = useState<string | null>(null)
  const [untaggedOnly, setUntaggedOnly] = useState(false)
  const list = untaggedOnly ? BOOKINGS.filter(b => b.status === 'refunded') : BOOKINGS
  const open = BOOKINGS.find(b => b.id === openId)

  return (
    <SectionAnchor id="bookings" title="Bookings" subtitle="All bookings across the marketplace, with full payment + status timeline."
      right={<Button variant="dark" iconRight={<IconExternal size={13} />}>Export CSV</Button>}>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Select value="all" onChange={() => {}} options={[{ value:'all', label:'All statuses' },{ value:'pending', label:'Pending' },{ value:'confirmed', label:'Confirmed' },{ value:'in_progress', label:'In progress' },{ value:'completed', label:'Completed' },{ value:'cancelled', label:'Cancelled' },{ value:'refunded', label:'Refunded' }]} />
        <Input icon={<IconCalendar size={14} />} value="Apr 1 — Apr 30, 2026" onChange={() => {}} style={{ width:220 }} />
        <Input icon={<IconShop size={14} />} value="" onChange={() => {}} placeholder="Filter by shop…" style={{ width:220 }} />
        <span style={{ width:1, height:22, background:'var(--slate-200)' }} />
        <Toggle checked={untaggedOnly} onChange={e => setUntaggedOnly(e.target.checked)} label="Show untagged refunds only" />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>Showing {list.length} of 8,429</span>
      </div>
      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Booking</th><th style={tableStyles.th}>User</th><th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>Service(s)</th><th style={tableStyles.th}>Scheduled</th><th style={tableStyles.th}>Status</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Total</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {list.map(b => (
              <tr key={b.id} onClick={() => setOpenId(b.id)} style={{ cursor:'pointer' }}>
                <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)', fontWeight:500 }}>{b.id}</span></td>
                <td style={tableStyles.td}>{b.user}</td>
                <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.shop}</td>
                <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>{b.service}</td>
                <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.scheduled}{b.time && b.time !== '—' ? ` · ${b.time}` : ''}</td>
                <td style={tableStyles.td}><StatusBadge status={b.status} /></td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                  <span style={{ display:'inline-flex', gap:6 }}>
                    <Button size="sm" variant="primary" onClick={() => setOpenId(b.id)}>View</Button>
                    <Button size="sm" variant="ghost" iconRight={<IconExternal size={11} />}>Stripe</Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <BookingModal booking={open} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
