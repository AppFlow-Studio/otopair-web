'use client'

import { useState, useEffect, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Badge, Button, Input, Select, Modal, AuditButton, IconDot, IconBolt, IconSearch, IconChevronDown, IconDrag, IconX } from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto } from '../directorNav'

const FB_COLUMNS = [
  { id:'new',       label:'New',        tone:'blue' },
  { id:'reviewed',  label:'Reviewed',   tone:'indigo' },
  { id:'triaged',   label:'Triaged',    tone:'purple' },
  { id:'planned',   label:'Planned',    tone:'yellow' },
  { id:'done',      label:'Done',       tone:'green' },
  { id:'wontfix',   label:"Won't fix",  tone:'slate' },
  { id:'duplicate', label:'Duplicate',  tone:'slate' },
]

const categoryChip = (c: string) => {
  const m: Record<string, { tone: 'indigo'|'teal'|'orange'|'slate'|'green'; label: string }> = {
    feature_request:{ tone:'indigo',  label:'Feature' },
    ux:             { tone:'teal',    label:'UX' },
    shop_quality:   { tone:'orange',  label:'Shop quality' },
    general:        { tone:'slate',   label:'General' },
    praise:         { tone:'green',   label:'Praise' },
  }
  const v = m[c] || { tone:'slate' as const, label:c }
  return <Badge tone={v.tone}>{v.label}</Badge>
}

const sentimentDot = (s: string) => {
  const color = s === 'positive' ? 'var(--green-600)' : s === 'negative' ? 'var(--red-600)' : 'var(--slate-400)'
  return <IconDot color={color} size={8} />
}

const fbSrcChip = (s: string) => {
  const m: Record<string, { tone: string; label: string }> = {
    consumer_ios:    { tone:'blue',   label:'iOS' },
    rating_comment:  { tone:'orange', label:'Rating' },
    email:           { tone:'slate',  label:'Email' },
    manual:          { tone:'slate',  label:'Manual' },
    consumer_android:{ tone:'green',  label:'Android' },
  }
  const v = m[s] || { tone:'slate', label:s }
  return <span style={{ fontSize:10, fontWeight:500, color:`var(--${v.tone}-700)`, background:`var(--${v.tone}-50)`, padding:'1px 6px', borderRadius:4, border:`1px solid var(--${v.tone}-100)` }}>{v.label}</span>
}

function ageLabel(created_at: number): string {
  const diff = Date.now() - created_at
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

type Feedback = {
  _id: Id<'app_feedback'>
  title: string
  category: string
  sentiment: string
  source: string
  status: string
  auto_ingested?: boolean
  rating_shop?: string
  archived?: boolean
  created_at: number
}

const FBCard = ({ fb, expanded, onClick, onDragStart, onDragEnd }: {
  fb: Feedback; expanded: boolean; onClick: () => void
  onDragStart: (id: string) => void; onDragEnd: () => void
}) => {
  const [hover, setHover] = useState(false)
  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(fb._id) }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background:'#fff', border:`1px solid ${expanded ? 'var(--blue-500)' : 'var(--slate-200)'}`,
        borderRadius:8, padding:12, marginBottom:8, cursor:'grab',
        boxShadow:hover ? '0 1px 4px rgba(15,23,42,0.06)' : 'none',
        position:'relative', userSelect:'none' }}>
      {fb.auto_ingested && (
        <div style={{ background:'var(--red-50)', border:'1px solid var(--red-100)', borderRadius:6, padding:'4px 8px', marginBottom:8, display:'flex', alignItems:'center', gap:6, fontSize:11, color:'var(--red-700)', fontWeight:500 }}>
          <IconBolt size={11} /> Auto-ingested · 1★ review of {fb.rating_shop}
        </div>
      )}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
        <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{fb._id.slice(-8)}</span>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          {sentimentDot(fb.sentiment)}
          <IconDrag size={12} style={{ color:'var(--slate-400)' }} />
        </div>
      </div>
      <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)', lineHeight:1.35, marginBottom:10,
        display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' } as React.CSSProperties}>{fb.title}</div>
      <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
        {categoryChip(fb.category)}{fbSrcChip(fb.source)}
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', borderTop:'1px solid var(--slate-100)', paddingTop:8, marginTop:8 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)' }}>{ageLabel(fb.created_at)}</span>
      </div>
    </div>
  )
}

const FBModal = ({ fb, onClose }: { fb: Feedback | undefined; onClose: () => void }) => {
  const session = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [auditOpen,      setAuditOpen]      = useState(false)
  const updateFields  = useMutation(api.app_feedback.updateFields)
  const archiveFb     = useMutation(api.app_feedback.archive)
  const [localStatus,    setLocalStatus]    = useState(fb?.status ?? 'new')
  const [localCategory,  setLocalCategory]  = useState(fb?.category ?? 'general')
  const [localSentiment, setLocalSentiment] = useState(fb?.sentiment ?? 'neutral')

  const rawAudit = useQuery(api.audit_log.listByEntity, fb ? { entity_type: 'feedback', entity_id: fb._id } : 'skip')
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  const handleSave = async () => {
    if (!fb) return
    await updateFields({
      id: fb._id,
      status: localStatus,
      category: localCategory as any,
      sentiment: localSentiment as any,
      actorName,
      actorId,
    })
    onClose()
  }

  return (
    <Modal open={!!fb} onClose={onClose} width={920}
      eyebrow={fb && <><span className="mono" style={{ fontSize:13, color:'var(--slate-500)' }}>{fb._id.slice(-8)}</span>{categoryChip(fb.category)}{fbSrcChip(fb.source)}{sentimentDot(fb.sentiment)}</>}
      title={fb?.title ?? ''}
      headerRight={<AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Feedback audit log', subtitle:fb ? `${fb._id.slice(-8)} · ${fb.title}` : '', entries:auditEntries }}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={handleSave}>Save</Button></>}>
      {fb && (
        <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr' }}>
          <div style={{ padding:22, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>Description</div>
            <div style={{ fontSize:13, color:'var(--slate-700)', lineHeight:1.6, marginBottom:18, padding:12, background:'var(--slate-25)', borderRadius:8, border:'1px solid var(--slate-100)', fontStyle:'italic' }}>
              "{fb.title}"
            </div>
            <DirectorNotesPanel entityType="feedback" entityId={fb._id} placeholder="Add an internal note about this feedback…" />
          </div>
          <div style={{ padding:22, background:'var(--slate-25)' }}>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              {([
                ['Category',  localCategory,  setLocalCategory,  [{ value:'feature_request', label:'Feature request' },{ value:'ux', label:'UX' },{ value:'shop_quality', label:'Shop quality' },{ value:'general', label:'General' },{ value:'praise', label:'Praise' }]],
                ['Sentiment', localSentiment, setLocalSentiment, [{ value:'positive', label:'Positive' },{ value:'neutral', label:'Neutral' },{ value:'negative', label:'Negative' }]],
                ['Status',    localStatus,    setLocalStatus,    FB_COLUMNS.map(c => ({ value:c.id, label:c.label }))],
              ] as [string, string, (v: string) => void, { value: string; label: string }[]][]).map(([lbl, val, setter, opts]) => (
                <div key={lbl}>
                  <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>{lbl}</label>
                  <Select value={val} onChange={e => setter(e.target.value)} options={opts} style={{ width:'100%' }} />
                </div>
              ))}
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Assignee</label>
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8 }}>
                  <span style={{ width:20, height:20, borderRadius:999, border:'1.5px dashed var(--slate-300)' }} />
                  <span style={{ fontSize:13, color:'var(--slate-500)' }}>Unassigned</span>
                  <span style={{ flex:1 }} />
                  <IconChevronDown size={14} style={{ color:'var(--slate-400)' }} />
                </div>
              </div>
              <div style={{ borderTop:'1px solid var(--slate-200)', paddingTop:14, marginTop:4 }}>
                <Button variant={fb.archived ? 'secondary' : 'danger'} style={{ width:'100%' }}
                  onClick={async () => { await archiveFb({ id: fb._id, archived: !fb.archived, actorName, actorId }); onClose() }}>
                  {fb.archived ? 'Restore from archive' : 'Archive feedback'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

export const TabFeedback = () => {
  const session = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [expandedId,       setExpandedId]       = useState<string | null>(null)
  const [searchQ,          setSearchQ]          = useState('')
  const [categoryFilter,   setCategoryFilter]   = useState('all')
  const [sentimentFilter,  setSentimentFilter]  = useState('all')
  const [viewMode,         setViewMode]         = useState<'active' | 'archived'>('active')
  const [draggingId,       setDraggingId]       = useState<string | null>(null)
  const [dragOverCol,      setDragOverCol]      = useState<string | null>(null)

  useEffect(() => {
    const goto = consumeGoto()
    if (goto) setExpandedId(goto.entityId)
  }, [])

  const grouped      = useQuery(api.app_feedback.listByStatus, { includeArchived: viewMode === 'archived' })
  const updateStatus = useMutation(api.app_feedback.updateStatus)

  const allFb: Feedback[]     = grouped ? (Object.values(grouped).flat() as Feedback[]) : []
  const expanded  = allFb.find(f => f._id === expandedId)
  const hasFilter = categoryFilter !== 'all' || sentimentFilter !== 'all' || !!searchQ

  const filterItems = (items: Feedback[]) => items.filter(f => {
    if (categoryFilter  !== 'all' && f.category  !== categoryFilter)  return false
    if (sentimentFilter !== 'all' && f.sentiment !== sentimentFilter)  return false
    if (searchQ && !f.title.toLowerCase().includes(searchQ.toLowerCase())) return false
    return true
  })

  const handleDrop = (targetColId: string) => {
    if (!draggingId) return
    const fb = allFb.find(f => f._id === draggingId)
    if (fb && fb.status !== targetColId) {
      updateStatus({ id: fb._id, status: targetColId, actorName, actorId })
    }
    setDraggingId(null)
    setDragOverCol(null)
  }

  return (
    <SectionAnchor id="feedback" title="Feedback pipeline"
      subtitle="Triage every customer signal — feature requests, UX gripes, praise, and auto-ingested 1★ reviews." fillViewport
      right={null}>

      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:10, padding:'10px 12px',
        background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>Filters</span>
        <Input icon={<IconSearch size={14} />} value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search feedback…" style={{ width:200 }} />
        <Select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          options={[
            { value:'all',             label:'All categories' },
            { value:'feature_request', label:'Feature request' },
            { value:'ux',              label:'UX' },
            { value:'shop_quality',    label:'Shop quality' },
            { value:'general',         label:'General' },
            { value:'praise',          label:'Praise' },
          ]} />
        <Select value={sentimentFilter} onChange={e => setSentimentFilter(e.target.value)}
          options={[
            { value:'all',      label:'All sentiments' },
            { value:'positive', label:'Positive' },
            { value:'neutral',  label:'Neutral' },
            { value:'negative', label:'Negative' },
          ]} />
        <span style={{ width:1, height:22, background:'var(--slate-200)' }} />
        <Select value={viewMode} onChange={e => { setViewMode(e.target.value as 'active' | 'archived'); setExpandedId(null) }}
          options={[
            { value:'active',   label:'Active' },
            { value:'archived', label:'Archived' },
          ]} />
        <span style={{ flex:1 }} />
        {hasFilter && (
          <Button size="sm" onClick={() => { setCategoryFilter('all'); setSentimentFilter('all'); setSearchQ('') }}>
            <IconX size={12} /> Clear
          </Button>
        )}
      </div>

      {!grouped ? (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <div style={{ flex:1, minHeight:0, display:'grid', gridTemplateColumns:'repeat(7, minmax(0, 1fr))', gap:8, paddingBottom:16 }}>
          {FB_COLUMNS.map(col => {
            const items = filterItems((grouped[col.id] ?? []) as Feedback[])
            const isOver = dragOverCol === col.id && !!draggingId
            return (
              <div key={col.id}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverCol(col.id) }}
                onDragLeave={e => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null) }}
                onDrop={e => { e.preventDefault(); handleDrop(col.id) }}
                style={{
                  background: isOver ? `var(--${col.tone}-50, var(--slate-50))` : 'var(--slate-100)',
                  outline: isOver ? `2px dashed var(--${col.tone}-400, var(--slate-400))` : '2px solid transparent',
                  outlineOffset: -2,
                  borderRadius:10, display:'flex', flexDirection:'column', minHeight:0,
                  transition:'background 80ms, outline-color 80ms',
                }}>
                <div style={{ flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 14px 10px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ width:8, height:8, borderRadius:999, background:`var(--${col.tone}-600, var(--slate-500))` }} />
                    <span style={{ fontSize:12, fontWeight:600, color:'var(--slate-700)', textTransform:'uppercase', letterSpacing:'0.04em' }}>{col.label}</span>
                  </div>
                  <span style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', background:'#fff', borderRadius:999, padding:'1px 8px', border:'1px solid var(--slate-200)' }}>{items.length}</span>
                </div>
                <div style={{ flex:1, minHeight:0, overflowY:'auto', padding:'0 10px 10px', display:'flex', flexDirection:'column' }}>
                  {items.map(f => (
                    <FBCard key={f._id} fb={f} expanded={f._id === expandedId}
                      onClick={() => setExpandedId(f._id === expandedId ? null : f._id)}
                      onDragStart={id => setDraggingId(id)}
                      onDragEnd={() => { setDraggingId(null); setDragOverCol(null) }}
                    />
                  ))}
                  {items.length === 0 && (
                    <div style={{ flex:1, minHeight:60, display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:12, color: isOver ? `var(--${col.tone}-500, var(--slate-400))` : 'var(--slate-400)' }}>
                      {isOver ? 'Drop here' : '—'}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {expanded && <FBModal fb={expanded} onClose={() => setExpandedId(null)} />}
    </SectionAnchor>
  )
}
