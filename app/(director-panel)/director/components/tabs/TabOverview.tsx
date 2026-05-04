'use client'

import { Badge, Button, Card, Select, StatusBadge, tableStyles, IconRefresh, IconChevron, IconDot } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { BOOKINGS, BUGS, FEEDBACK, COUNTERS } from '../../data'

const COUNTER_DEFS = [
  { key:'active_bookings',        label:'Active bookings',      hint:'in_progress + confirmed', delta:'+12 vs yesterday', tone:'blue' },
  { key:'bookings_today',         label:'Bookings today',       hint:'all statuses',            delta:'+8 vs 7-day avg',  tone:'slate' },
  { key:'total_bookings',         label:'Total bookings',       hint:'lifetime',                delta:'8,429 all-time',   tone:'slate' },
  { key:'active_shops',           label:'Active shops',         hint:'status = active',         delta:'+2 this week',     tone:'green' },
  { key:'active_users',           label:'Active users',         hint:'last 30d',                delta:'+147 this week',   tone:'green' },
  { key:'open_bugs',              label:'Open bugs',            hint:'new + triaged + assigned',delta:'4 unassigned',     tone:'red' },
  { key:'open_feedback',          label:'Open feedback',        hint:'awaiting triage',         delta:'11 negative',      tone:'orange' },
  { key:'pending_mechanic_edits', label:'Pending mechanic edits',hint:'awaiting approval',      delta:'oldest: 2d',       tone:'yellow' },
  { key:'untagged_refunds',       label:'Untagged refunds',     hint:'need reason code',        delta:'$981.75 total',    tone:'red' },
] as const

const toneColor: Record<string, string> = {
  slate:'var(--slate-600)', blue:'var(--blue-600)', green:'var(--green-600)',
  red:'var(--red-600)', orange:'var(--orange-700)', yellow:'var(--yellow-800)',
}

const Counter = ({ def, value }: { def: typeof COUNTER_DEFS[number]; value: number }) => (
  <Card style={{ padding:18 }}>
    <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:8 }}>
      <div style={{ fontSize:12, color:'var(--slate-500)', fontWeight:500 }}>{def.label}</div>
      <span style={{ fontSize:10, color:toneColor[def.tone], fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>{def.hint}</span>
    </div>
    <div className="mono" style={{ fontSize:30, fontWeight:600, color:'var(--slate-900)', letterSpacing:-0.5, lineHeight:1.1 }}>{value.toLocaleString()}</div>
    <div style={{ fontSize:12, color:toneColor[def.tone], marginTop:6, fontWeight:500 }}>{def.delta}</div>
  </Card>
)

const sourceBadge = (src: string) => {
  const m: Record<string, { tone: 'blue'|'green'|'purple'|'slate'|'orange'; label: string }> = {
    consumer_ios:     { tone:'blue',   label:'iOS' },
    consumer_android: { tone:'green',  label:'Android' },
    shop_web:         { tone:'purple', label:'Shop web' },
    manual:           { tone:'slate',  label:'Manual' },
    rating_comment:   { tone:'orange', label:'Rating' },
    email:            { tone:'slate',  label:'Email' },
  }
  const v = m[src] || { tone:'slate' as const, label:src }
  return <Badge tone={v.tone}>{v.label}</Badge>
}

const TriageList = ({ title, count, items }: { title: string; count: number; items: { title: string; chip: JSX.Element; age: string; right?: JSX.Element }[] }) => (
  <Card padded={false}>
    <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
      <div style={{ fontSize:14, fontWeight:600 }}>{title}</div>
      <span style={{ fontSize:12, color:'var(--slate-500)' }}>{count} open</span>
    </div>
    <div>
      {items.map((it, i) => (
        <div key={i} style={{ padding:'12px 18px', borderBottom:i < items.length-1 ? '1px solid var(--slate-100)' : 'none', display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-800)', marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.title}</div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>{it.chip}<span style={{ fontSize:11, color:'var(--slate-500)' }}>{it.age}</span></div>
          </div>
          {it.right}
          <IconChevron size={14} style={{ color:'var(--slate-300)' }} />
        </div>
      ))}
    </div>
  </Card>
)

export const TabOverview = () => {
  const bugItems = BUGS.new.slice(0, 5).map(b => ({ title:`${b.id} · ${b.title}`, chip:sourceBadge(b.source), age:b.age }))
  const fbItems = [...FEEDBACK.new.slice(0, 4), ...FEEDBACK.reviewed.slice(0, 1)].map(f => ({
    title:f.title, chip:sourceBadge(f.category === 'feature_request' ? 'manual' : f.source), age:f.age,
    right:<IconDot color={f.sentiment === 'negative' ? 'var(--red-600)' : f.sentiment === 'positive' ? 'var(--green-600)' : 'var(--slate-400)'} />,
  }))

  return (
    <SectionAnchor id="overview" title="Overview" subtitle="At-a-glance health for the Otopair marketplace. Updated live."
      right={
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:12, color:'var(--slate-500)' }}>Period</span>
          <Select value="today" onChange={() => {}} options={[{ value:'today', label:'Today' },{ value:'7d', label:'Last 7 days' },{ value:'30d', label:'Last 30 days' }]} />
          <Button icon={<IconRefresh size={14} />}>Refresh</Button>
        </div>
      }>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:14, marginBottom:22 }}>
        {COUNTER_DEFS.map(def => <Counter key={def.key} def={def} value={COUNTERS[def.key as keyof typeof COUNTERS]} />)}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:14 }}>
        <Card padded={false}>
          <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>Today's bookings</div>
              <div style={{ fontSize:12, color:'var(--slate-500)' }}>Live · {BOOKINGS.slice(0,10).length} of 112</div>
            </div>
            <span style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'var(--green-700)' }}>
              <span style={{ width:7, height:7, borderRadius:999, background:'var(--green-600)', boxShadow:'0 0 0 3px rgba(5,150,105,0.18)' }} />Streaming
            </span>
          </div>
          <table style={tableStyles.table}>
            <thead>
              <tr>
                {['Booking','User','Shop','Service','Time','Status'].map(h => <th key={h} style={tableStyles.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {BOOKINGS.slice(0,10).map(r => (
                <tr key={r.id}>
                  <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)', fontSize:12 }}>{r.id}</span></td>
                  <td style={tableStyles.td}>{r.user}</td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{r.shop}</td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>{r.service}</td>
                  <td style={tableStyles.td} className="mono">{r.time}</td>
                  <td style={tableStyles.td}><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <TriageList title="Open bugs to triage" count={4} items={bugItems} />
          <TriageList title="Open feedback to triage" count={5} items={fbItems} />
        </div>
      </div>
    </SectionAnchor>
  )
}
