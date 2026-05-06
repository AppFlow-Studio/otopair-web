'use client'

import { useState, useEffect } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Card, Input, Select, Toggle, StatusBadge, Modal, AuditButton, Avatar, IconStar, tableStyles, IconShop, IconExternal, IconCheck } from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto } from '../directorNav'

const TIMELINE_STAGES = ['pending', 'confirmed', 'in_progress', 'completed'] as const

type HistoryEntry = { status: string; changedAt: number; changedBy?: string }

const BookingTimeline = ({ history, currentStatus }: { history: HistoryEntry[]; currentStatus: string }) => {
  const reachedStatuses = new Set([...history.map(h => h.status), currentStatus])
  return (
    <div style={{ display:'flex', alignItems:'center', gap:0, padding:'16px 0' }}>
      {TIMELINE_STAGES.map((stage, i) => {
        const done = reachedStatuses.has(stage)
        const event = history.find(h => h.status === stage)
        const color = done ? (stage === 'completed' ? 'var(--green-600)' : 'var(--blue-600)') : 'var(--slate-300)'
        const timeStr = event
          ? new Date(event.changedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
          : null
        return (
          <div key={stage} style={{ display:'contents' }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, minWidth:120 }}>
              <div style={{ width:28, height:28, borderRadius:999, background:done ? color : '#fff', border:`2px solid ${color}`, display:'inline-flex', alignItems:'center', justifyContent:'center', color:done ? '#fff' : 'var(--slate-300)' }}>
                {done ? <IconCheck size={14} /> : <span style={{ fontSize:11, fontWeight:600 }}>{i+1}</span>}
              </div>
              <div style={{ fontSize:12, fontWeight:500, color:'var(--slate-800)', textTransform:'capitalize' }}>{stage.replace('_',' ')}</div>
              {timeStr && (
                <div style={{ fontSize:11, color:'var(--slate-500)', textAlign:'center' }}>
                  {timeStr}{event?.changedBy ? <><br/>{event.changedBy}</> : null}
                </div>
              )}
            </div>
            {i < TIMELINE_STAGES.length - 1 && (
              <div style={{ flex:1, height:2, background:reachedStatuses.has(TIMELINE_STAGES[i+1]) ? 'var(--blue-600)' : 'var(--slate-200)', marginTop:-32 }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

const BookingModal = ({ bookingId, onClose }: { bookingId: Id<'bookings'> | null; onClose: () => void }) => {
  const [auditOpen, setAuditOpen] = useState(false)
  const detail = useQuery(api.director.bookingDetail, bookingId ? { id: bookingId } : 'skip')
  const rawAudit = useQuery(api.audit_log.listByEntity, bookingId ? { entity_type: 'booking', entity_id: bookingId } : 'skip')
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  return (
    <Modal open={!!bookingId} onClose={onClose} width={920}
      eyebrow={detail && <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{String(detail.id).slice(-8)}</span>}
      statusBadge={detail && <StatusBadge status={detail.status} />}
      title={detail?.services.join(', ') ?? ''}
      headerRight={<>
        <AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />
        <Button iconRight={<IconExternal size={13} />}>View on Stripe</Button>
        <Button variant="primary">Open Booking</Button>
      </>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Booking audit log', subtitle:detail ? `${String(detail.id).slice(-8)} · ${detail.services.join(', ')}` : '', entries:auditEntries }}
      footer={<><Button onClick={onClose}>Close</Button></>}>
      {!detail ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : <>
        <div style={{ padding:'4px 24px 12px', background:'#fff' }}>
          <div style={{ fontSize:13, color:'var(--slate-600)' }}>
            {detail.user} · {detail.shop}{detail.scheduled !== '—' ? ` · ${detail.scheduled}` : ''}{detail.time !== '—' ? ` at ${detail.time}` : ''}
          </div>
        </div>
        <div style={{ padding:'8px 24px 16px', borderBottom:'1px solid var(--slate-200)' }}>
          <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Status timeline</div>
          <BookingTimeline history={detail.statusHistory} currentStatus={detail.status} />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Payment</div>
            {([
              ['Total charged', `$${detail.total.toFixed(2)}`],
              ['Stripe payment ID', detail.payment?.stripePaymentIntentId ?? '—'],
              ['Card', detail.payment?.paymentMethod ?? '—'],
            ] as [string, string][]).map(([l, v]) => (
              <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:12, gap:8 }}>
                <span style={{ color:'var(--slate-500)', flexShrink:0 }}>{l}</span>
                <span className={l === 'Total charged' ? 'mono' : ''} style={{ fontWeight:l === 'Total charged' ? 600 : undefined, color:l === 'Stripe payment ID' && v !== '—' ? 'var(--blue-700)' : undefined, textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Mechanic assigned</div>
            {detail.mechanic ? (
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <Avatar name={detail.mechanic.name} size={36} />
                <div>
                  <div style={{ fontSize:13, fontWeight:500 }}>{detail.mechanic.name}</div>
                  <div style={{ fontSize:12, color:'var(--slate-500)' }}>{detail.mechanic.title ?? detail.shop}</div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize:13, color:'var(--slate-400)' }}>No mechanic assigned.</div>
            )}
          </div>
          <div style={{ padding:18 }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>User rating</div>
            {detail.review ? (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:6 }}>
                  {[1,2,3,4,5].map(i => <IconStar key={i} size={16} style={{ color:i <= detail.review!.rating ? '#F59E0B' : 'var(--slate-200)' }} />)}
                  <span style={{ marginLeft:6, fontSize:13, fontWeight:500 }}>{detail.review.rating.toFixed(1)}</span>
                </div>
                {detail.review.comment && (
                  <div style={{ fontSize:12, color:'var(--slate-600)', fontStyle:'italic' }}>"{detail.review.comment}"</div>
                )}
              </>
            ) : (
              <div style={{ fontSize:13, color:'var(--slate-400)' }}>No review yet.</div>
            )}
          </div>
        </div>
        <div style={{ padding:22, background:'var(--slate-25)' }}>
          {bookingId && <DirectorNotesPanel entityType="booking" entityId={bookingId} placeholder="Add an internal note about this booking…" />}
        </div>
      </>}
    </Modal>
  )
}

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
      right={<Button variant="dark" iconRight={<IconExternal size={13} />}>Export CSV</Button>}>
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
      <BookingModal bookingId={openId} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
