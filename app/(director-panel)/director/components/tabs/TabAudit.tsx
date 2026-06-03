'use client'

import { useState, type ReactNode } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import type { AuditEntry } from '../../data'
import { Badge, Button, Input, Select, Modal, Avatar, StatusBadge, GlobalAuditTable, auditMeta, IconSearch, IconExternal, IconBolt } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'

const ACTION_LABELS: Record<string, string> = {
  refund_issued:    'Refund issued',
  refund_tagged:    'Refund tagged',
  payment_captured: 'Payment captured',
  note_added:       'Note added',
  status_change:    'Status change',
  assignee_change:  'Assignee change',
  field_edit:       'Field edit',
  email_sent:       'Email sent',
  flag_raised:      'Flag raised',
  viewed:           'Viewed (PII)',
  view:             'Viewed',
  login:            'Login',
  logout:           'Logout',
  login_failed:     'Login failed',
}

const ENTITY_TAB: Record<string, string> = {
  bug:      'bugs',
  feedback: 'feedback',
  shop:     'shops',
  user:     'users',
  booking:  'bookings',
}

const ENTITY_LABEL: Record<string, string> = {
  bug:      'Bug',
  feedback: 'Feedback',
  shop:     'Shop',
  user:     'User',
  booking:  'Booking',
}

const EntityPreview = ({ entityType, entityId }: { entityType: string; entityId: string }) => {
  const shop     = useQuery(api.director.shopDetail,          entityType === 'shop'     ? { id: entityId as Id<'shops'> }           : 'skip')
  const user     = useQuery(api.director.userDetail,          entityType === 'user'     ? { id: entityId as Id<'users'> }           : 'skip')
  const booking  = useQuery(api.director.bookingDetail,       entityType === 'booking'  ? { id: entityId as Id<'bookings'> }        : 'skip')
  const bug      = useQuery(api.bugs.getById,                 entityType === 'bug'      ? { id: entityId as Id<'bugs'> }            : 'skip')
  const feedback = useQuery(api.app_feedback.getById,         entityType === 'feedback' ? { id: entityId as Id<'app_feedback'> }    : 'skip')
  const director = useQuery(api.director_auth.getUserPreview, entityType === 'director' ? { id: entityId as Id<'director_users'> }  : 'skip')

  const row = (label: string, value: string | undefined | null, mono?: boolean) => value ? (
    <div style={{ display:'flex', gap:8, fontSize:12, lineHeight:1.5, padding:'3px 0', borderBottom:'1px solid var(--slate-100)' }}>
      <span style={{ width:96, flexShrink:0, color:'var(--slate-500)', fontWeight:500 }}>{label}</span>
      <span style={{ color:'var(--slate-800)', wordBreak:'break-all', ...(mono ? { fontFamily:'monospace', color:'var(--blue-700)' } : {}) }}>{value}</span>
    </div>
  ) : null

  const wrap = (label: string, content: ReactNode) => (
    <div style={{ marginBottom:18 }}>
      <div style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>
        {label} preview
      </div>
      <div style={{ background:'var(--slate-25)', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
        {content}
      </div>
    </div>
  )

  if (entityType === 'shop') {
    if (shop === undefined) return wrap('Shop', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Loading…</span>)
    if (!shop) return wrap('Shop', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Deleted or not found</span>)
    return wrap('Shop', <>{row('Name', shop.name)}{row('Status', `${shop.isActive ? 'Active' : 'Inactive'}${shop.isVerified ? ' · Verified' : ''}`)}{row('City', shop.city)}{row('Phone', shop.phone)}</>)
  }
  if (entityType === 'user') {
    if (user === undefined) return wrap('User', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Loading…</span>)
    if (!user) return wrap('User', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Deleted or not found</span>)
    return wrap('User', <>{row('Name', user.name)}{row('Email', user.email)}{row('Phone', user.phone)}{row('Joined', user.joined)}{row('Bookings', String(user.bookings))}</>)
  }
  if (entityType === 'booking') {
    if (booking === undefined) return wrap('Booking', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Loading…</span>)
    if (!booking) return wrap('Booking', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Deleted or not found</span>)
    return wrap('Booking', <>{row('Services', booking.services.join(', '))}{row('Shop', booking.shop)}{row('User', booking.user)}{row('Date', `${booking.scheduled} ${booking.time}`.trim())}{row('Status', booking.status)}{row('Total', booking.total ? `$${booking.total.toFixed(2)}` : undefined)}</>)
  }
  if (entityType === 'bug') {
    if (bug === undefined) return wrap('Bug', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Loading…</span>)
    if (!bug) return wrap('Bug', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Deleted or not found</span>)
    return wrap('Bug', <>{row('Title', bug.title)}{row('Source', bug.source)}{row('Status', bug.status)}{row('Version', bug.version)}</>)
  }
  if (entityType === 'feedback') {
    if (feedback === undefined) return wrap('Feedback', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Loading…</span>)
    if (!feedback) return wrap('Feedback', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Deleted or not found</span>)
    return wrap('Feedback', <>{row('Title', feedback.title)}{row('Category', feedback.category)}{row('Sentiment', feedback.sentiment)}{row('Source', feedback.source)}</>)
  }
  if (entityType === 'director') {
    if (director === undefined) return wrap('Director account', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Loading…</span>)
    if (!director) return wrap('Director account', <span style={{ fontSize:12, color:'var(--slate-400)' }}>Deleted or not found</span>)
    return wrap('Director account', <>{row('Name', director.name)}{row('Role', director.role)}</>)
  }
  return null
}

const AuditDetailModal = ({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) => {
  if (!entry) return null
  const m    = auditMeta(entry.action)
  const Ic   = m.Icon
  const tab  = entry.entityType ? ENTITY_TAB[entry.entityType] : null
  const elbl = entry.entityType ? (ENTITY_LABEL[entry.entityType] ?? entry.entityType) : null
  const isSystem = entry.actor === 'system'

  const handleGoto = () => {
    if (!tab || !entry.entityId) return
    gotoEntity(tab, entry.entityId)
    onClose()
  }

  const fields: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Timestamp', value: entry.timestamp, mono: true },
    { label: 'Actor',     value: entry.actor },
    { label: 'Detail',    value: entry.detail || '—' },
  ]

  return (
    <Modal open={!!entry} onClose={onClose} width={560}
      title="Audit entry"
      footer={<>
        <Button onClick={onClose}>Close</Button>
        {tab && entry.entityId && (
          <Button variant="primary" iconRight={<IconExternal size={13} />} onClick={handleGoto}>
            Go to {elbl}
          </Button>
        )}
      </>}>
      <div style={{ padding:22 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:22,
          padding:'14px 16px', background:`var(--${m.tone}-50, var(--slate-50))`,
          border:`1px solid var(--${m.tone}-100, var(--slate-200))`, borderRadius:10 }}>
          <span style={{ width:36, height:36, borderRadius:10, background:`var(--${m.tone}-100, var(--slate-100))`,
            color:`var(--${m.tone}-700)`, display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <Ic size={17} />
          </span>
          <div>
            <Badge tone={m.tone}>{m.label}</Badge>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
              {isSystem
                ? <><span style={{ width:18, height:18, borderRadius:4, background:'var(--slate-900)', color:'#fff', display:'inline-flex', alignItems:'center', justifyContent:'center' }}><IconBolt size={10} /></span><span style={{ fontSize:12, color:'var(--slate-600)' }}>System</span></>
                : <><Avatar name={entry.actor} size={18} /><span style={{ fontSize:12, color:'var(--slate-600)' }}>{entry.actor}</span></>}
            </div>
          </div>
        </div>

        {entry.entityType && entry.entityId && (
          <EntityPreview entityType={entry.entityType} entityId={entry.entityId} />
        )}

        {fields.map(f => (
          <div key={f.label} style={{ marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>{f.label}</div>
            <div style={{ fontSize:13, color:'var(--slate-800)', lineHeight:1.5, wordBreak:'break-all',
              ...(f.mono ? { fontFamily:'monospace', fontSize:12, color:'var(--blue-700)' } : {}) }}>
              {f.value}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

export const TabAudit = () => {
  const [q,            setQ]            = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [actorFilter,  setActorFilter]  = useState('all')
  const [selected,     setSelected]     = useState<AuditEntry | null>(null)

  const raw = useQuery(api.audit_log.listRecent)
  const entries = raw?.map(e => ({
    timestamp:  new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action:     e.action,
    actor:      e.actor,
    detail:     e.detail ?? '',
    entity:     `${e.entity_type} · ${e.entity_id.slice(-8)}`,
    entityType: e.entity_type,
    entityId:   e.entity_id,
  }))

  const actors = Array.from(new Set((entries ?? []).map(e => e.actor))).sort()

  const filtered = (entries ?? []).filter(e => {
    if (actionFilter !== 'all' && e.action !== actionFilter) return false
    if (actorFilter  !== 'all' && e.actor  !== actorFilter)  return false
    if (q) {
      const lq = q.toLowerCase()
      if (!e.detail.toLowerCase().includes(lq) && !(e.entity || '').toLowerCase().includes(lq) && !e.actor.toLowerCase().includes(lq)) return false
    }
    return true
  })

  return (
    <SectionAnchor id="audit" title="Audit log" subtitle="Every admin action, system event, and PII access across the platform — immutable."
>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)} placeholder="Search actions, entities, actors…" style={{ width:320 }} />
        <Select value={actionFilter} onChange={e => setActionFilter(e.target.value)}
          options={[{ value:'all', label:'All actions' }, ...Object.entries(ACTION_LABELS).map(([v, l]) => ({ value:v, label:l }))]} />
        <Select value={actorFilter} onChange={e => setActorFilter(e.target.value)}
          options={[{ value:'all', label:'All actors' }, ...actors.map(a => ({ value:a, label:a }))]} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {entries === undefined ? 'Loading…' : `Showing ${filtered.length} of ${entries.length} entries`}
        </span>
      </div>
      <GlobalAuditTable entries={filtered} loading={entries === undefined} onRowClick={e => setSelected(e)} />
      <AuditDetailModal entry={selected} onClose={() => setSelected(null)} />
    </SectionAnchor>
  )
}
