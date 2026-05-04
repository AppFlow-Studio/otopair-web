'use client'

import { useState } from 'react'
import { Badge, Button, Input, Select, NotesPanel, Modal, AuditButton, Avatar, tableStyles, IconSearch, IconDrag, IconChevronDown } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { BUGS, BUG_AUDIT } from '../../data'
import type { Bug } from '../../data'

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

const BugCard = ({ bug, expanded, onClick }: { bug: Bug; expanded: boolean; onClick: () => void }) => {
  const [hover, setHover] = useState(false)
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background:'#fff', border:`1px solid ${expanded ? 'var(--blue-500)' : 'var(--slate-200)'}`, borderRadius:8, padding:12, marginBottom:8, cursor:'pointer', boxShadow:hover ? '0 1px 4px rgba(15,23,42,0.06)' : 'none', position:'relative', transition:'border-color 120ms' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
        <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{bug.id}</span>
        {hover && <IconDrag size={14} style={{ color:'var(--slate-400)' }} />}
      </div>
      <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)', lineHeight:1.35, marginBottom:10, display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' } as React.CSSProperties}>{bug.title}</div>
      <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:8 }}>
        <Badge tone={srcTone(bug.source)}>{srcLabel(bug.source)}</Badge>
        {bug.version !== '—' && <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{bug.version}</span>}
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', borderTop:'1px solid var(--slate-100)', paddingTop:8 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)' }}>{bug.device !== '—' ? bug.device : '—'} · {bug.age}</span>
        {bug.assignee ? <Avatar name={bug.assignee} size={20} /> : <span style={{ width:20, height:20, borderRadius:999, border:'1.5px dashed var(--slate-300)' }} />}
      </div>
    </div>
  )
}

const BugModal = ({ bug, onClose }: { bug: Bug | undefined; onClose: () => void }) => {
  const [auditOpen, setAuditOpen] = useState(false)
  const breadcrumbs = [
    { t:'14:02:11', e:'tap_pay_button',          ctx:'checkout · $124.50' },
    { t:'14:02:13', e:'stripe_intent_confirmed', ctx:'pi_3QkR…7Lb' },
    { t:'14:02:14', e:'navigate_to_confirmation',ctx:'screen=BookingConfirmation' },
    { t:'14:02:14', e:'fcm_dispatch_queued',     ctx:'topic=booking_confirm' },
    { t:'14:02:18', e:'app_background',          ctx:'os_event' },
  ]
  return (
    <Modal open={!!bug} onClose={onClose} width={920}
      eyebrow={bug && <><span className="mono" style={{ fontSize:13, color:'var(--slate-500)' }}>{bug.id}</span><Badge tone={srcTone(bug.source)}>{srcLabel(bug.source)}</Badge></>}
      title={bug?.title ?? ''}
      headerRight={<><AuditButton onClick={() => setAuditOpen(o => !o)} count={BUG_AUDIT.length} />{bug?.assignee && <Avatar name={bug.assignee} size={28} />}</>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Bug audit log', subtitle:bug ? `${bug.id} · ${bug.title}` : '', entries:BUG_AUDIT }}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary">Save</Button></>}>
      {bug && <>
        <div style={{ padding:'10px 22px 14px', borderBottom:'1px solid var(--slate-200)', fontSize:12, color:'var(--slate-500)' }}>
          {bug.version !== '—' && <>{bug.version} · </>}{bug.device !== '—' && <>{bug.device} · </>}reported {bug.age}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr' }}>
          <div style={{ padding:22, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>Description</div>
            <div style={{ fontSize:13, color:'var(--slate-700)', lineHeight:1.6, marginBottom:18 }}>
              User reports the booking confirmation push notification is not delivered after a successful Stripe payment. Email receipt arrives normally. Reproduces consistently. Likely race condition between webhook acknowledgment and notification dispatch.
            </div>
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
            <NotesPanel placeholder="Add an internal note about this bug…" initialNotes={[
              { author:'Priya', when:'1h ago', text:'Reproduced on Pixel 8 with Android 14. FCM token confirmed registered.' },
              { author:'System', system:true, when:'Apr 29, 1:08 PM', text:'Sentry grouped 14 new occurrences in the last hour (release v2.41.0).' },
            ]} />
          </div>
          <div style={{ padding:22, background:'var(--slate-25)' }}>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Status</label>
                <Select value="in_progress" onChange={() => {}} options={[{ value:'new', label:'New' },{ value:'triaged', label:'Triaged' },{ value:'assigned', label:'Assigned' },{ value:'in_progress', label:'In progress' },{ value:'done', label:'Done' },{ value:'verified', label:'Verified' }]} style={{ width:'100%' }} />
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Assignee</label>
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8 }}>
                  <Avatar name={bug.assignee || 'Temur AB'} size={20} />
                  <span style={{ fontSize:13 }}>{bug.assignee || 'Temur AB'}</span>
                  <span style={{ flex:1 }} />
                  <IconChevronDown size={14} style={{ color:'var(--slate-400)' }} />
                </div>
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Resolution notes</label>
                <textarea placeholder="What did you find / fix?" style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical', background:'#fff' }} />
              </div>
              <div>
                <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Resolved in version</label>
                <Input value="" onChange={() => {}} placeholder="e.g. Android 2.3.9" />
              </div>
            </div>
          </div>
        </div>
      </>}
    </Modal>
  )
}

export const TabBugs = () => {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const allBugs = Object.values(BUGS).flat()
  const expanded = allBugs.find(b => b.id === expandedId)

  return (
    <SectionAnchor id="bugs" title="Bugs" subtitle="Drag cards across columns to advance triage. 23 open · 4 unassigned." fillViewport
      right={
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <Input icon={<IconSearch size={14} />} value="" onChange={() => {}} placeholder="Search bugs…" style={{ width:220 }} />
          <Button>Filter</Button>
          <Button variant="primary">+ New bug</Button>
        </div>
      }>
      <div style={{ flex:1, minHeight:0, display:'grid', gridTemplateColumns:'repeat(6, minmax(0, 1fr))', gap:10, paddingBottom:16 }}>
        {BUG_COLUMNS.map(col => {
          const items = BUGS[col.id] || []
          return (
            <div key={col.id} style={{ background:'var(--slate-100)', borderRadius:10, display:'flex', flexDirection:'column', minHeight:0 }}>
              <div style={{ flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 14px 10px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ width:8, height:8, borderRadius:999, background:`var(--${col.tone}-600, var(--slate-500))` }} />
                  <span style={{ fontSize:12, fontWeight:600, color:'var(--slate-700)', textTransform:'uppercase', letterSpacing:'0.04em' }}>{col.label}</span>
                </div>
                <span style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', background:'#fff', borderRadius:999, padding:'1px 8px', border:'1px solid var(--slate-200)' }}>{items.length}</span>
              </div>
              <div style={{ flex:1, minHeight:0, overflowY:'auto', padding:'0 10px 10px', display:'flex', flexDirection:'column' }}>
                {items.map(b => <BugCard key={b.id} bug={b} expanded={b.id === expandedId} onClick={() => setExpandedId(b.id === expandedId ? null : b.id)} />)}
                {items.length === 0 && <div style={{ fontSize:12, color:'var(--slate-400)', padding:16, textAlign:'center' }}>—</div>}
              </div>
            </div>
          )
        })}
      </div>
      <BugModal bug={expanded} onClose={() => setExpandedId(null)} />
    </SectionAnchor>
  )
}
