'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Input, Select, Modal, AuditButton, Avatar, IconSearch, IconDrag, IconX } from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto } from '../directorNav'

const BUG_COLUMNS = [
  { id:'new',         label:'New',         tone:'blue' },
  { id:'triaged',     label:'Triaged',     tone:'indigo' },
  { id:'assigned',    label:'Assigned',    tone:'purple' },
  { id:'in_progress', label:'In progress', tone:'yellow' },
  { id:'done',        label:'Done',        tone:'green' },
  { id:'verified',    label:'Verified',    tone:'slate' },
]

const srcTone = (s: string): 'blue'|'green'|'purple'|'slate' =>
  ({ consumer_ios:'blue', consumer_android:'green', shop_web:'purple', manual:'slate' }[s] as 'blue'|'green'|'purple'|'slate') || 'slate'
const srcLabel = (s: string) =>
  ({ consumer_ios:'iOS', consumer_android:'Android', shop_web:'Shop web', manual:'Manual' }[s]) || s

function ageLabel(created_at: number): string {
  const diff = Date.now() - created_at
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

type Bug = {
  _id: Id<'bugs'>
  title: string
  source: string
  status: string
  version?: string
  device?: string
  assignee?: string
  archived?: boolean
  created_at: number
}

const BugCard = ({ bug, expanded, onClick, onDragStart, onDragEnd }: {
  bug: Bug; expanded: boolean; onClick: () => void
  onDragStart: (id: string) => void; onDragEnd: () => void
}) => {
  const [hover, setHover] = useState(false)
  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(bug._id) }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background:'#fff', border:`1px solid ${expanded ? 'var(--blue-500)' : 'var(--slate-200)'}`,
        borderRadius:8, padding:12, marginBottom:8, cursor:'grab',
        boxShadow:hover ? '0 1px 4px rgba(15,23,42,0.06)' : 'none',
        position:'relative', transition:'border-color 120ms', userSelect:'none' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
        <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{bug._id.slice(-8)}</span>
        <IconDrag size={14} style={{ color:'var(--slate-400)' }} />
      </div>
      <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)', lineHeight:1.35, marginBottom:10,
        display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' } as React.CSSProperties}>{bug.title}</div>
      <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:8 }}>
        <Badge tone={srcTone(bug.source)}>{srcLabel(bug.source)}</Badge>
        {bug.version && bug.version !== '—' && <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{bug.version}</span>}
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', borderTop:'1px solid var(--slate-100)', paddingTop:8 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)' }}>{bug.device || '—'} · {ageLabel(bug.created_at)}</span>
        {bug.assignee ? <Avatar name={bug.assignee} size={20} /> : <span style={{ width:20, height:20, borderRadius:999, border:'1.5px dashed var(--slate-300)' }} />}
      </div>
    </div>
  )
}

const BugModal = ({ bug, onClose }: { bug: Bug | undefined; onClose: () => void }) => {
  const [auditOpen, setAuditOpen] = useState(false)
  const updateStatus   = useMutation(api.bugs.updateStatus)
  const updateAssignee = useMutation(api.bugs.updateAssignee)
  const archiveBug     = useMutation(api.bugs.archive)
  const [localStatus,   setLocalStatus]   = useState(bug?.status ?? 'new')
  const [localAssignee, setLocalAssignee] = useState(bug?.assignee ?? '')

  const rawAudit = useQuery(api.audit_log.listByEntity, bug ? { entity_type: 'bug', entity_id: bug._id } : 'skip')
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  const breadcrumbs = [
    { t:'14:02:11', e:'tap_pay_button',           ctx:'checkout · $124.50' },
    { t:'14:02:13', e:'stripe_intent_confirmed',  ctx:'pi_3QkR…7Lb' },
    { t:'14:02:14', e:'navigate_to_confirmation', ctx:'screen=BookingConfirmation' },
    { t:'14:02:14', e:'fcm_dispatch_queued',      ctx:'topic=booking_confirm' },
    { t:'14:02:18', e:'app_background',           ctx:'os_event' },
  ]

  const handleSave = async () => {
    if (!bug) return
    await Promise.all([
      updateStatus({ id: bug._id, status: localStatus }),
      updateAssignee({ id: bug._id, assignee: localAssignee || undefined }),
    ])
    onClose()
  }

  return (
    <Modal open={!!bug} onClose={onClose} width={920}
      eyebrow={bug && <><span className="mono" style={{ fontSize:13, color:'var(--slate-500)' }}>{bug._id.slice(-8)}</span><Badge tone={srcTone(bug.source)}>{srcLabel(bug.source)}</Badge></>}
      title={bug?.title ?? ''}
      headerRight={<><AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />{bug?.assignee && <Avatar name={bug.assignee} size={28} />}</>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Bug audit log', subtitle:bug ? `${bug._id.slice(-8)} · ${bug.title}` : '', entries:auditEntries }}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={handleSave}>Save</Button></>}>
      {bug && <>
        <div style={{ padding:'10px 22px 14px', borderBottom:'1px solid var(--slate-200)', fontSize:12, color:'var(--slate-500)' }}>
          {bug.version && bug.version !== '—' && <>{bug.version} · </>}{bug.device && bug.device !== '—' && <>{bug.device} · </>}reported {ageLabel(bug.created_at)}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr' }}>
          <div style={{ padding:22, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>Description</div>
            <div style={{ fontSize:13, color:'var(--slate-700)', lineHeight:1.6, marginBottom:18 }}>{bug.title}</div>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>Telemetry breadcrumbs</div>
            <div style={{ background:'var(--slate-25)', border:'1px solid var(--slate-100)', borderRadius:8, padding:'8px 12px', fontSize:12, marginBottom:18 }} className="mono">
              {breadcrumbs.map((b, i) => (
                <div key={i} style={{ display:'flex', gap:10, padding:'3px 0', borderBottom:i < breadcrumbs.length-1 ? '1px solid var(--slate-100)' : 'none' }}>
                  <span style={{ color:'var(--slate-400)' }}>{b.t}</span>
                  <span style={{ color:'var(--blue-700)' }}>{b.e}</span>
                  <span style={{ color:'var(--slate-500)' }}>{b.ctx}</span>
                </div>
              ))}
            </div>
            <DirectorNotesPanel entityType="bug" entityId={bug._id} placeholder="Add an internal note about this bug…" />
          </div>
          <div style={{ padding:22, background:'var(--slate-25)' }}>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Status</label>
                <Select value={localStatus} onChange={e => setLocalStatus(e.target.value)}
                  options={BUG_COLUMNS.map(c => ({ value:c.id, label:c.label }))} style={{ width:'100%' }} />
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Assignee</label>
                <Input value={localAssignee} onChange={e => setLocalAssignee(e.target.value)} placeholder="Name…" style={{ width:'100%' }} />
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Resolution notes</label>
                <textarea placeholder="What did you find / fix?" style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical', background:'#fff' }} />
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Resolved in version</label>
                <Input value="" onChange={() => {}} placeholder="e.g. Android 2.3.9" />
              </div>
              <div style={{ borderTop:'1px solid var(--slate-200)', paddingTop:14, marginTop:4 }}>
                <Button variant={bug.archived ? 'secondary' : 'danger'} style={{ width:'100%' }}
                  onClick={async () => { await archiveBug({ id: bug._id, archived: !bug.archived }); onClose() }}>
                  {bug.archived ? 'Restore from archive' : 'Archive bug'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </>}
    </Modal>
  )
}

export const TabBugs = () => {
  const [expandedId,      setExpandedId]      = useState<string | null>(null)
  const [searchQ,         setSearchQ]         = useState('')
  const [sourceFilter,    setSourceFilter]    = useState('all')
  const [assigneeFilter,  setAssigneeFilter]  = useState('all')
  const [viewMode,        setViewMode]        = useState<'active' | 'archived'>('active')
  const [draggingId,      setDraggingId]      = useState<string | null>(null)
  const [dragOverCol,     setDragOverCol]     = useState<string | null>(null)

  useEffect(() => {
    const goto = consumeGoto()
    if (goto) setExpandedId(goto.entityId)
  }, [])

  const grouped      = useQuery(api.bugs.listByStatus, { includeArchived: viewMode === 'archived' })
  const updateStatus = useMutation(api.bugs.updateStatus)

  const allBugs    = grouped ? Object.values(grouped).flat() : []
  const expanded   = allBugs.find(b => b._id === expandedId)
  const openCount  = grouped ? (grouped.new?.length ?? 0) + (grouped.triaged?.length ?? 0) + (grouped.assigned?.length ?? 0) : 0
  const unassigned = allBugs.filter(b => !b.assignee && !['done','verified'].includes(b.status)).length
  const hasFilter  = sourceFilter !== 'all' || assigneeFilter !== 'all' || !!searchQ

  const filterItems = (items: Bug[]) => items.filter(b => {
    if (sourceFilter   !== 'all' && b.source !== sourceFilter) return false
    if (assigneeFilter === 'assigned'   && !b.assignee) return false
    if (assigneeFilter === 'unassigned' &&  b.assignee) return false
    if (searchQ && !b.title.toLowerCase().includes(searchQ.toLowerCase())) return false
    return true
  })

  const handleDrop = (targetColId: string) => {
    if (!draggingId) return
    const bug = allBugs.find(b => b._id === draggingId)
    if (bug && bug.status !== targetColId) {
      updateStatus({ id: bug._id, status: targetColId })
    }
    setDraggingId(null)
    setDragOverCol(null)
  }

  return (
    <SectionAnchor id="bugs" title="Bugs"
      subtitle={`${openCount} open · ${unassigned} unassigned`} fillViewport
      right={
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <Button variant="primary">+ New bug</Button>
        </div>
      }>

      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:10, padding:'10px 12px',
        background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8 }}>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>Filters</span>
        <Input icon={<IconSearch size={14} />} value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search bugs…" style={{ width:200 }} />
        <Select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          options={[
            { value:'all',              label:'All sources' },
            { value:'consumer_ios',     label:'iOS' },
            { value:'consumer_android', label:'Android' },
            { value:'shop_web',         label:'Shop web' },
            { value:'manual',           label:'Manual' },
          ]} />
        <Select value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}
          options={[
            { value:'all',        label:'All assignees' },
            { value:'assigned',   label:'Assigned' },
            { value:'unassigned', label:'Unassigned' },
          ]} />
        <span style={{ width:1, height:22, background:'var(--slate-200)' }} />
        <Select value={viewMode} onChange={e => { setViewMode(e.target.value as 'active' | 'archived'); setExpandedId(null) }}
          options={[
            { value:'active',   label:'Active' },
            { value:'archived', label:'Archived' },
          ]} />
        <span style={{ flex:1 }} />
        {hasFilter && (
          <Button size="sm" onClick={() => { setSourceFilter('all'); setAssigneeFilter('all'); setSearchQ('') }}>
            <IconX size={12} /> Clear
          </Button>
        )}
      </div>

      {!grouped ? (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <div style={{ flex:1, minHeight:0, display:'grid', gridTemplateColumns:'repeat(6, minmax(0, 1fr))', gap:10, paddingBottom:16 }}>
          {BUG_COLUMNS.map(col => {
            const items = filterItems(grouped[col.id] ?? [])
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
                  {items.map(b => (
                    <BugCard key={b._id} bug={b} expanded={b._id === expandedId}
                      onClick={() => setExpandedId(b._id === expandedId ? null : b._id)}
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
      <BugModal bug={expanded} onClose={() => setExpandedId(null)} />
    </SectionAnchor>
  )
}
