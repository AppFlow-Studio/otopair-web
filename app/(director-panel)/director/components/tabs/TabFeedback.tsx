'use client'

import { useState } from 'react'
import { Badge, Button, Input, Select, NotesPanel, Modal, AuditButton, IconDot, IconBolt, IconSearch, IconShop, IconExternal, IconChevronDown } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { FEEDBACK, FB_AUDIT } from '../../data'
import type { FeedbackItem } from '../../data'

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
    consumer_ios:   { tone:'blue',   label:'iOS' },
    rating_comment: { tone:'orange', label:'Rating' },
    email:          { tone:'slate',  label:'Email' },
    manual:         { tone:'slate',  label:'Manual' },
    consumer_android:{ tone:'green', label:'Android' },
  }
  const v = m[s] || { tone:'slate', label:s }
  return <span style={{ fontSize:10, fontWeight:500, color:`var(--${v.tone}-700)`, background:`var(--${v.tone}-50)`, padding:'1px 6px', borderRadius:4, border:`1px solid var(--${v.tone}-100)` }}>{v.label}</span>
}

const FBCard = ({ fb, expanded, onClick }: { fb: FeedbackItem; expanded: boolean; onClick: () => void }) => {
  const [hover, setHover] = useState(false)
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background:'#fff', border:`1px solid ${expanded ? 'var(--blue-500)' : 'var(--slate-200)'}`, borderRadius:8, padding:12, marginBottom:8, cursor:'pointer', boxShadow:hover ? '0 1px 4px rgba(15,23,42,0.06)' : 'none', position:'relative' }}>
      {fb.autoIngested && (
        <div style={{ background:'var(--red-50)', border:'1px solid var(--red-100)', borderRadius:6, padding:'4px 8px', marginBottom:8, display:'flex', alignItems:'center', gap:6, fontSize:11, color:'var(--red-700)', fontWeight:500 }}>
          <IconBolt size={11} /> Auto-ingested · 1★ review of {fb.ratingShop}
        </div>
      )}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
        <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{fb.id}</span>
        {sentimentDot(fb.sentiment)}
      </div>
      <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)', lineHeight:1.35, marginBottom:10, display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' } as React.CSSProperties}>{fb.title}</div>
      <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
        {categoryChip(fb.category)}{fbSrcChip(fb.source)}
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', borderTop:'1px solid var(--slate-100)', paddingTop:8, marginTop:8 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)' }}>{fb.age}</span>
      </div>
    </div>
  )
}

const FBModal = ({ fb, onClose }: { fb: FeedbackItem | undefined; onClose: () => void }) => {
  const [auditOpen, setAuditOpen] = useState(false)
  return (
    <Modal open={!!fb} onClose={onClose} width={920}
      eyebrow={fb && <><span className="mono" style={{ fontSize:13, color:'var(--slate-500)' }}>{fb.id}</span>{categoryChip(fb.category)}{fbSrcChip(fb.source)}{sentimentDot(fb.sentiment)}</>}
      title={fb?.title ?? ''}
      headerRight={<AuditButton onClick={() => setAuditOpen(o => !o)} count={FB_AUDIT.length} />}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Feedback audit log', subtitle:fb ? `${fb.id} · ${fb.title}` : '', entries:FB_AUDIT }}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary">Save</Button></>}>
      {fb && (
        <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr' }}>
          <div style={{ padding:22, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>Description</div>
            <div style={{ fontSize:13, color:'var(--slate-700)', lineHeight:1.6, marginBottom:18, padding:12, background:'var(--slate-25)', borderRadius:8, border:'1px solid var(--slate-100)', fontStyle:'italic' }}>
              "Wait time for quotes was way too long. I sat there for over 15 minutes and only one shop responded with a price way above what I'd seen elsewhere. Eventually gave up and went to a local place directly."
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:18 }}>
              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Related booking</div>
                <div style={{ padding:'10px 12px', border:'1px solid var(--slate-200)', borderRadius:8, fontSize:13 }}>
                  <div className="mono" style={{ color:'var(--blue-700)', fontSize:12, marginBottom:2 }}>BKG-9298</div>
                  <div style={{ color:'var(--slate-600)' }}>Sofia Martinez · East Bay Diesel</div>
                </div>
              </div>
              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Related shop</div>
                <div style={{ padding:'10px 12px', border:'1px solid var(--slate-200)', borderRadius:8, fontSize:13, display:'flex', alignItems:'center', gap:8 }}>
                  <IconShop size={14} style={{ color:'var(--slate-500)' }} /><span>East Bay Diesel</span>
                  <IconExternal size={11} style={{ color:'var(--slate-400)', marginLeft:'auto' }} />
                </div>
              </div>
            </div>
            <NotesPanel placeholder="Add an internal note about this feedback…" initialNotes={[
              { author:'Daniel Chelala', when:'1d ago', text:'Pattern: 3 negative reviews this week mentioning quote latency at East Bay Diesel. Worth a call.' },
              { author:'System', system:true, when:'Apr 28, 7:00 AM', text:'Sentiment auto-classified as negative (confidence 0.92) and routed to triage queue.' },
            ]} />
          </div>
          <div style={{ padding:22, background:'var(--slate-25)' }}>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              {[['Category', fb.category, [{ value:'feature_request', label:'Feature request' },{ value:'ux', label:'UX' },{ value:'shop_quality', label:'Shop quality' },{ value:'general', label:'General' },{ value:'praise', label:'Praise' }]],
                ['Sentiment', fb.sentiment, [{ value:'positive', label:'Positive' },{ value:'neutral', label:'Neutral' },{ value:'negative', label:'Negative' }]],
                ['Status', 'new', FB_COLUMNS.map(c => ({ value:c.id, label:c.label }))]].map(([lbl, val, opts]) => (
                <div key={String(lbl)}>
                  <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>{lbl as string}</label>
                  <Select value={val as string} onChange={() => {}} options={opts as { value:string; label:string }[]} style={{ width:'100%' }} />
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
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

export const TabFeedback = () => {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const allFb = Object.values(FEEDBACK).flat()
  const expanded = allFb.find(f => f.id === expandedId)

  return (
    <SectionAnchor id="feedback" title="Feedback pipeline" subtitle="Triage every customer signal — feature requests, UX gripes, praise, and auto-ingested 1★ reviews." fillViewport
      right={
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <Input icon={<IconSearch size={14} />} value="" onChange={() => {}} placeholder="Search feedback…" style={{ width:220 }} />
          <Button>Filter</Button>
        </div>
      }>
      <div style={{ flex:1, minHeight:0, display:'grid', gridTemplateColumns:'repeat(7, minmax(0, 1fr))', gap:8, paddingBottom:16 }}>
        {FB_COLUMNS.map(col => {
          const items = FEEDBACK[col.id] || []
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
                {items.map(f => <FBCard key={f.id} fb={f} expanded={f.id === expandedId} onClick={() => setExpandedId(f.id === expandedId ? null : f.id)} />)}
                {items.length === 0 && <div style={{ fontSize:12, color:'var(--slate-400)', padding:16, textAlign:'center' }}>—</div>}
              </div>
            </div>
          )
        })}
      </div>
      {expanded && <FBModal fb={expanded} onClose={() => setExpandedId(null)} />}
    </SectionAnchor>
  )
}
