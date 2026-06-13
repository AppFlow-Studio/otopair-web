'use client'

import { useState, useEffect, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Badge, Button, Input, Select, Modal, AuditButton, IconSearch, IconDrag, IconX } from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto } from '../directorNav'

const OTO_FB_COLUMNS = [
  { id:'new',        label:'New',        tone:'blue' },
  { id:'reviewed',   label:'Reviewed',   tone:'indigo' },
  { id:'actionable', label:'Actionable', tone:'yellow' },
  { id:'resolved',   label:'Resolved',   tone:'green' },
  { id:'wontfix',    label:"Won't fix",  tone:'slate' },
]

const ratingChip = (r: 'thumbs_up' | 'thumbs_down') =>
  r === 'thumbs_up'
    ? <Badge tone="green">👍 Thumbs up</Badge>
    : <Badge tone="red">👎 Thumbs down</Badge>

function ageLabel(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
}

type OtoFeedback = {
  _id: Id<'ai_feedback'>
  conversation_id: Id<'ai_conversations'>
  message_id?: Id<'ai_messages'>
  user_id: Id<'users'>
  rating: 'thumbs_up' | 'thumbs_down'
  comment?: string
  tags?: string[]
  message_content_snapshot: string
  submitted_at: number
  review_status: string
  archived?: boolean
  userName?: string
  userEmail?: string
  convoScenario?: string
  convoMessageCount?: number
  convoLedToBooking?: boolean
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const OtoFBCard = ({ fb, expanded, onClick, onDragStart, onDragEnd }: {
  fb: OtoFeedback; expanded: boolean; onClick: () => void
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
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
        <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{fb._id.slice(-8)}</span>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          {fb.rating === 'thumbs_down'
            ? <span style={{ fontSize:14 }}>👎</span>
            : <span style={{ fontSize:14 }}>👍</span>}
          <IconDrag size={12} style={{ color:'var(--slate-400)' }} />
        </div>
      </div>
      {fb.comment && (
        <div style={{ fontSize:12, color:'var(--slate-700)', fontStyle:'italic',
          background:'var(--slate-25)', border:'1px solid var(--slate-100)', borderRadius:6,
          padding:'6px 8px', marginBottom:8, lineHeight:1.4,
          display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' } as React.CSSProperties}>
          “{fb.comment}”
        </div>
      )}
      <div style={{ fontSize:12, color:'var(--slate-500)', lineHeight:1.4, marginBottom:8,
        display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical', overflow:'hidden' } as React.CSSProperties}>
        <span style={{ fontWeight:600, color:'var(--slate-600)' }}>Oto said: </span>
        {truncate(fb.message_content_snapshot, 180)}
      </div>
      {fb.tags && fb.tags.length > 0 && (
        <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:8 }}>
          {fb.tags.slice(0, 3).map(t => (
            <span key={t} style={{ fontSize:10, fontWeight:500, color:'var(--purple-700)',
              background:'var(--purple-50)', padding:'1px 6px', borderRadius:4,
              border:'1px solid var(--purple-100)' }}>{t}</span>
          ))}
          {fb.tags.length > 3 && (
            <span style={{ fontSize:10, color:'var(--slate-500)' }}>+{fb.tags.length - 3}</span>
          )}
        </div>
      )}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
        borderTop:'1px solid var(--slate-100)', paddingTop:8 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {fb.userName ?? 'Unknown user'}
        </span>
        <span style={{ fontSize:11, color:'var(--slate-500)' }}>{ageLabel(fb.submitted_at)}</span>
      </div>
    </div>
  )
}

const ConversationTranscript = ({ messages, highlightId }: {
  messages: { _id: Id<'ai_messages'>; role: string; content: string; timestamp: number }[]
  highlightId?: Id<'ai_messages'>
}) => {
  if (!messages || messages.length === 0) {
    return (
      <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic', padding:'12px 0' }}>
        No conversation messages found.
      </div>
    )
  }
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {messages.map(m => {
        const isUser = m.role === 'user'
        const isHighlight = highlightId && m._id === highlightId
        return (
          <div key={m._id} style={{
            display:'flex', flexDirection:'column',
            alignItems: isUser ? 'flex-end' : 'flex-start',
          }}>
            <div style={{
              maxWidth:'88%',
              background: isHighlight
                ? 'var(--yellow-50)'
                : isUser
                  ? 'var(--blue-50)'
                  : 'var(--slate-50)',
              border: `1px solid ${isHighlight ? 'var(--yellow-200, #FDE68A)' : isUser ? '#BFDBFE' : 'var(--slate-200)'}`,
              borderRadius: 10,
              padding: '8px 12px',
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--slate-800)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {m.content}
            </div>
            <div style={{ display:'flex', gap:8, marginTop:3, fontSize:10, color:'var(--slate-500)' }}>
              <span style={{ fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em' }}>{m.role}</span>
              <span>·</span>
              <span>{formatTs(m.timestamp)}</span>
              {isHighlight && <span style={{ color:'var(--yellow-800)', fontWeight:600 }}>· Rated message</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const OtoFBModal = ({ fb, onClose }: { fb: OtoFeedback | undefined; onClose: () => void }) => {
  const session = useContext(DirectorSessionCtx)
  // Server derives the audit actor from this session token (Jun-10 sweep) —
  // actorName/actorId args are gone.
  const token = session?.token ?? ''
  const [auditOpen,   setAuditOpen]   = useState(false)
  const [localStatus, setLocalStatus] = useState(fb?.review_status ?? 'new')

  useEffect(() => { setLocalStatus(fb?.review_status ?? 'new') }, [fb?._id, fb?.review_status])

  const updateStatus = useMutation(api.ai_feedback.updateStatus)
  const archiveFb    = useMutation(api.ai_feedback.archive)

  const detail = useQuery(api.ai_feedback.getConversationForFeedback,
    fb ? { feedbackId: fb._id, token } : 'skip')

  const rawAudit = useQuery(api.audit_log.listByEntity,
    fb ? { entity_type: 'oto_feedback', entity_id: fb._id, token } : 'skip')
  type AuditRow = { created_at: number; action: string; actor: string; detail?: string }
  const auditEntries = (rawAudit as AuditRow[] | undefined)?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  const handleSave = async () => {
    if (!fb) return
    await updateStatus({ id: fb._id, status: localStatus, token })
    onClose()
  }

  const convo    = detail?.conversation
  const messages = (detail?.messages ?? []) as { _id: Id<'ai_messages'>; role: string; content: string; timestamp: number }[]
  const user     = detail?.user

  return (
    <Modal open={!!fb} onClose={onClose} width={1040}
      eyebrow={fb && <>
        <span className="mono" style={{ fontSize:13, color:'var(--slate-500)' }}>{fb._id.slice(-8)}</span>
        {ratingChip(fb.rating)}
        {fb.convoScenario && <Badge tone="indigo">{fb.convoScenario}</Badge>}
      </>}
      title={fb?.comment ? `“${fb.comment}”` : 'Oto feedback'}
      headerRight={<AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false),
        title:'Oto feedback audit log',
        subtitle:fb ? `${fb._id.slice(-8)} · ${fb.rating}` : '',
        entries:auditEntries }}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleSave}>Save</Button>
      </>}>
      {fb && (
        <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr' }}>
          {/* Left column — transcript + rated message highlight */}
          <div style={{ padding:22, borderRight:'1px solid var(--slate-100)', display:'flex', flexDirection:'column', gap:14 }}>
            <div>
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>
                Rated message <span style={{ color:'var(--slate-400)', fontWeight:500 }}>(snapshot)</span>
              </div>
              <div style={{ fontSize:13, color:'var(--slate-800)', lineHeight:1.55,
                background:'var(--yellow-50)', border:'1px solid var(--yellow-200, #FDE68A)',
                borderRadius:8, padding:'10px 12px', whiteSpace:'pre-wrap' }}>
                {fb.message_content_snapshot}
              </div>
            </div>

            {fb.tags && fb.tags.length > 0 && (
              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>User tags</div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                  {fb.tags.map(t => (
                    <span key={t} style={{ fontSize:11, fontWeight:500, color:'var(--purple-700)',
                      background:'var(--purple-50)', padding:'2px 8px', borderRadius:6,
                      border:'1px solid var(--purple-100)' }}>{t}</span>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
                  Full conversation
                </div>
                <span style={{ fontSize:11, color:'var(--slate-500)' }}>
                  {detail === undefined ? 'Loading…' : `${messages.length} message${messages.length === 1 ? '' : 's'}`}
                </span>
              </div>
              <div style={{ maxHeight:360, overflowY:'auto', padding:'4px 2px' }}>
                {detail === undefined
                  ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic', padding:'12px 0' }}>Loading transcript…</div>
                  : <ConversationTranscript messages={messages} highlightId={fb.message_id} />}
              </div>
            </div>

            <DirectorNotesPanel entityType="oto_feedback" entityId={fb._id}
              placeholder="Add an internal note — what should we adjust in Oto?" />
          </div>

          {/* Right column — meta + actions */}
          <div style={{ padding:22, background:'var(--slate-25)' }}>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Status</label>
                <Select value={localStatus} onChange={e => setLocalStatus(e.target.value)}
                  options={OTO_FB_COLUMNS.map(c => ({ value:c.id, label:c.label }))}
                  style={{ width:'100%' }} />
              </div>

              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Submitted by</div>
                <div style={{ fontSize:13, color:'var(--slate-800)' }}>{user?.name ?? fb.userName ?? '—'}</div>
                {(user?.email ?? fb.userEmail) && (
                  <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:2 }}>{user?.email ?? fb.userEmail}</div>
                )}
                {user?.phone && (
                  <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{user.phone}</div>
                )}
              </div>

              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Conversation</div>
                <div style={{ display:'flex', flexDirection:'column', gap:4, fontSize:12, color:'var(--slate-700)' }}>
                  <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{String(fb.conversation_id).slice(-12)}</div>
                  {convo?.scenario_detected && (
                    <div><span style={{ color:'var(--slate-500)' }}>Scenario:</span> {convo.scenario_detected}</div>
                  )}
                  {convo?.last_user_intent && (
                    <div><span style={{ color:'var(--slate-500)' }}>Last intent:</span> {convo.last_user_intent}</div>
                  )}
                  {convo?.current_model && (
                    <div><span style={{ color:'var(--slate-500)' }}>Model:</span> {convo.current_model}</div>
                  )}
                  <div>
                    <span style={{ color:'var(--slate-500)' }}>Turns:</span> {convo?.message_count ?? messages.length}
                    {convo?.led_to_booking && (
                      <span style={{ marginLeft:8 }}><Badge tone="green">→ booked</Badge></span>
                    )}
                  </div>
                </div>
              </div>

              {convo?.established_facts && convo.established_facts.length > 0 && (
                <div>
                  <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Established facts</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:3, fontSize:11, color:'var(--slate-700)' }}>
                    {convo.established_facts.map((f: string, i: number) => (
                      <div key={i} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'4px 8px' }}>{f}</div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Submitted</div>
                <div style={{ fontSize:12, color:'var(--slate-700)' }}>{formatTs(fb.submitted_at)}</div>
              </div>

              <div style={{ borderTop:'1px solid var(--slate-200)', paddingTop:14, marginTop:4 }}>
                <Button variant={fb.archived ? 'secondary' : 'danger'} style={{ width:'100%' }}
                  onClick={async () => { await archiveFb({ id: fb._id, archived: !fb.archived, token }); onClose() }}>
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

export const TabOtoFeedback = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''

  const [expandedId,    setExpandedId]    = useState<string | null>(null)
  const [searchQ,       setSearchQ]       = useState('')
  const [ratingFilter,  setRatingFilter]  = useState('all')
  const [viewMode,      setViewMode]      = useState<'active' | 'archived'>('active')
  const [draggingId,    setDraggingId]    = useState<string | null>(null)
  const [dragOverCol,   setDragOverCol]   = useState<string | null>(null)

  useEffect(() => {
    const goto = consumeGoto()
    if (goto) setExpandedId(goto.entityId)
  }, [])

  const grouped      = useQuery(api.ai_feedback.listByStatus, { token, includeArchived: viewMode === 'archived' })
  const updateStatus = useMutation(api.ai_feedback.updateStatus)

  const allFb: OtoFeedback[] = grouped ? (Object.values(grouped).flat() as OtoFeedback[]) : []
  const expanded  = allFb.find(f => f._id === expandedId)
  const hasFilter = ratingFilter !== 'all' || !!searchQ

  const filterItems = (items: OtoFeedback[]) => items.filter(f => {
    if (ratingFilter !== 'all' && f.rating !== ratingFilter) return false
    if (searchQ) {
      const q = searchQ.toLowerCase()
      const haystack = [
        f.comment ?? '',
        f.message_content_snapshot,
        f.userName ?? '',
        f.userEmail ?? '',
        (f.tags ?? []).join(' '),
      ].join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  const handleDrop = (targetColId: string) => {
    if (!draggingId) return
    const fb = allFb.find(f => f._id === draggingId)
    if (fb && fb.review_status !== targetColId) {
      updateStatus({ id: fb._id, status: targetColId, token })
    }
    setDraggingId(null)
    setDragOverCol(null)
  }

  const totalOpen = grouped
    ? (grouped.new?.length ?? 0) + (grouped.reviewed?.length ?? 0) + (grouped.actionable?.length ?? 0)
    : 0
  const negative = allFb.filter(f => f.rating === 'thumbs_down').length

  return (
    <SectionAnchor id="otoFeedback" title="Oto feedback"
      subtitle={`${totalOpen} open · ${negative} thumbs-down — review the conversation that triggered each rating, then tag for prompt or model adjustments.`}
      fillViewport right={null}>

      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:10, padding:'10px 12px',
        background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, flexWrap:'wrap' }}>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>Filters</span>
        <Input icon={<IconSearch size={14} />} value={searchQ} onChange={e => setSearchQ(e.target.value)}
          placeholder="Search comment, snapshot, tags, user…" style={{ width:280 }} />
        <Select value={ratingFilter} onChange={e => setRatingFilter(e.target.value)}
          options={[
            { value:'all',          label:'All ratings' },
            { value:'thumbs_down',  label:'👎 Thumbs down' },
            { value:'thumbs_up',    label:'👍 Thumbs up' },
          ]} />
        <span style={{ width:1, height:22, background:'var(--slate-200)' }} />
        <Select value={viewMode} onChange={e => { setViewMode(e.target.value as 'active' | 'archived'); setExpandedId(null) }}
          options={[
            { value:'active',   label:'Active' },
            { value:'archived', label:'Archived' },
          ]} />
        <span style={{ flex:1 }} />
        {hasFilter && (
          <Button size="sm" onClick={() => { setRatingFilter('all'); setSearchQ('') }}>
            <IconX size={12} /> Clear
          </Button>
        )}
      </div>

      {!grouped ? (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <div style={{ flex:1, minHeight:0, display:'grid', gridTemplateColumns:`repeat(${OTO_FB_COLUMNS.length}, minmax(0, 1fr))`, gap:10, paddingBottom:16 }}>
          {OTO_FB_COLUMNS.map(col => {
            const items = filterItems((grouped[col.id] ?? []) as OtoFeedback[])
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
                    <OtoFBCard key={f._id} fb={f} expanded={f._id === expandedId}
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
      {expanded && <OtoFBModal fb={expanded} onClose={() => setExpandedId(null)} />}
    </SectionAnchor>
  )
}
