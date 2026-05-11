'use client'

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Badge, Card, Select, StatusBadge, tableStyles, IconChevron, IconDot } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'

const COUNTER_DEFS = [
  { key:'active_bookings',        label:'Active bookings',        hint:'confirmed + in_progress + pending', tone:'blue' },
  { key:'bookings_today',         label:'Bookings today',         hint:'all statuses',                      tone:'slate' },
  { key:'total_bookings',         label:'Total bookings',         hint:'lifetime',                          tone:'slate' },
  { key:'active_shops',           label:'Active shops',           hint:'status = active',                   tone:'green' },
  { key:'active_users',           label:'Active users',           hint:'last 30 days',                      tone:'green' },
  { key:'open_bugs',              label:'Open bugs',              hint:'new + triaged + assigned',           tone:'red' },
  { key:'open_feedback',          label:'Open feedback',          hint:'awaiting triage',                   tone:'orange' },
  { key:'pending_mechanic_edits', label:'Pending mechanic edits', hint:'awaiting approval',                 tone:'yellow' },
  { key:'untagged_refunds',       label:'Untagged refunds',       hint:'need reason code',                  tone:'red' },
] as const

const toneColor: Record<string, string> = {
  slate:'var(--slate-600)', blue:'var(--blue-600)', green:'var(--green-600)',
  red:'var(--red-600)', orange:'var(--orange-700)', yellow:'var(--yellow-800)',
}

const Counter = ({ def, value, sub }: { def: typeof COUNTER_DEFS[number]; value: number | undefined; sub?: string }) => (
  <Card style={{ padding:18 }}>
    <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:8 }}>
      <div style={{ fontSize:12, color:'var(--slate-500)', fontWeight:500 }}>{def.label}</div>
      <span style={{ fontSize:10, color:toneColor[def.tone], fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>{def.hint}</span>
    </div>
    <div className="mono" style={{ fontSize:30, fontWeight:600, color: value === undefined ? 'var(--slate-200)' : 'var(--slate-900)', letterSpacing:-0.5, lineHeight:1.1 }}>
      {value === undefined ? '—' : value.toLocaleString()}
    </div>
    {sub && <div style={{ fontSize:12, color:toneColor[def.tone], marginTop:6, fontWeight:500 }}>{sub}</div>}
  </Card>
)

const srcBadge = (src: string) => {
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

function ageLabel(ts: number): string {
  const d = Date.now() - ts
  const m = Math.floor(d / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const TriageList = ({ title, count, loading, items }: {
  title: string; count: number; loading: boolean
  items: { title: string; chip: JSX.Element; age: string; right?: JSX.Element; onClick?: () => void }[]
}) => (
  <Card padded={false}>
    <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
      <div style={{ fontSize:14, fontWeight:600 }}>{title}</div>
      <span style={{ fontSize:12, color:'var(--slate-500)' }}>{loading ? '…' : `${count} open`}</span>
    </div>
    <div>
      {loading
        ? <div style={{ padding:'20px 18px', fontSize:13, color:'var(--slate-400)' }}>Loading…</div>
        : items.length === 0
          ? <div style={{ padding:'20px 18px', fontSize:13, color:'var(--slate-400)' }}>Nothing to triage.</div>
          : items.map((it, i) => (
            <div key={i} onClick={it.onClick}
              style={{ padding:'12px 18px', borderBottom:i < items.length-1 ? '1px solid var(--slate-100)' : 'none',
                display:'flex', alignItems:'center', gap:12,
                cursor: it.onClick ? 'pointer' : 'default', transition:'background 80ms' }}
              onMouseEnter={e => { if (it.onClick) (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-800)', marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.title}</div>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>{it.chip}<span style={{ fontSize:11, color:'var(--slate-500)' }}>{it.age}</span></div>
              </div>
              {it.right}
              <IconChevron size={14} style={{ color: it.onClick ? 'var(--slate-400)' : 'var(--slate-200)' }} />
            </div>
          ))
      }
    </div>
  </Card>
)

export const TabOverview = () => {
  const [period, setPeriod] = useState<'today' | '7d' | '30d'>('today')

  const counters       = useQuery(api.director.overviewCounters, { period })
  const todaysBookings = useQuery(api.director.todaysBookingsList, { period })
  const bugsGrouped    = useQuery(api.bugs.listByStatus)
  const fbGrouped      = useQuery(api.app_feedback.listByStatus)

  const periodLabel = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' }[period]

  const bugItems = bugsGrouped
    ? (bugsGrouped.new ?? []).slice(0, 5).map(b => ({
        title:   b.title,
        chip:    srcBadge(b.source),
        age:     ageLabel(b.created_at),
        onClick: () => gotoEntity('bugs', b._id),
      }))
    : []

  const fbItems = fbGrouped
    ? [...(fbGrouped.new ?? []).slice(0, 4), ...(fbGrouped.reviewed ?? []).slice(0, 1)].map(f => ({
        title:   f.title,
        chip:    srcBadge(f.source),
        age:     ageLabel(f.created_at),
        right:   <IconDot color={f.sentiment === 'negative' ? 'var(--red-600)' : f.sentiment === 'positive' ? 'var(--green-600)' : 'var(--slate-400)'} />,
        onClick: () => gotoEntity('feedback', f._id),
      }))
    : []

  const counterValues: Record<string, number | undefined> = {
    active_bookings:        counters?.active_bookings,
    bookings_today:         counters?.bookings_today,
    total_bookings:         counters?.total_bookings,
    active_shops:           counters?.active_shops,
    active_users:           counters?.active_users,
    open_bugs:              counters?.open_bugs,
    open_feedback:          counters?.open_feedback,
    pending_mechanic_edits: counters?.pending_mechanic_edits,
    untagged_refunds:       counters?.untagged_refunds,
  }

  const counterSubs: Record<string, string | undefined> = {
    open_bugs:     counters ? `${counters.unassigned_bugs} unassigned` : undefined,
    open_feedback: counters ? `${counters.negative_feedback} negative` : undefined,
  }

  const counterOverrides: Partial<Record<string, { label: string; hint: string }>> = {
    bookings_today: {
      label: period === 'today' ? 'Bookings today' : `Bookings (${period})`,
      hint:  period === 'today' ? 'all statuses'   : `last ${period === '7d' ? '7' : '30'} days`,
    },
    active_users: {
      label: 'Active users',
      hint:  period === 'today' ? 'joined today' : `joined in ${period === '7d' ? 'last 7 days' : 'last 30 days'}`,
    },
  }

  return (
    <SectionAnchor id="overview" title="Overview" subtitle="At-a-glance health for the Otopair marketplace."
      right={
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:12, color:'var(--slate-500)' }}>Period</span>
          <Select value={period} onChange={e => setPeriod(e.target.value as 'today' | '7d' | '30d')}
            options={[{ value:'today', label:'Today' },{ value:'7d', label:'Last 7 days' },{ value:'30d', label:'Last 30 days' }]} />
        </div>
      }>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:14, marginBottom:22 }}>
        {COUNTER_DEFS.map(def => {
          const ov = counterOverrides[def.key]
          return <Counter key={def.key} def={ov ? { ...def, ...ov } : def} value={counterValues[def.key]} sub={counterSubs[def.key]} />
        })}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:14 }}>
        <Card padded={false}>
          <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>
                {period === 'today' ? "Today's bookings" : `Bookings — ${periodLabel}`}
              </div>
              <div style={{ fontSize:12, color:'var(--slate-500)' }}>
                {todaysBookings === undefined ? 'Loading…' : `${todaysBookings.length} scheduled`}
              </div>
            </div>
            <span style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'var(--green-700)' }}>
              <span style={{ width:7, height:7, borderRadius:999, background:'var(--green-600)', boxShadow:'0 0 0 3px rgba(5,150,105,0.18)' }} />Live
            </span>
          </div>
          {todaysBookings === undefined ? (
            <div style={{ padding:32, textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>Loading…</div>
          ) : todaysBookings.length === 0 ? (
            <div style={{ padding:32, textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>No bookings for {periodLabel.toLowerCase()}.</div>
          ) : (
            <table style={tableStyles.table}>
              <thead>
                <tr>{['Booking','User','Shop','Service','Time','Status'].map(h => <th key={h} style={tableStyles.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {todaysBookings.map(r => (
                  <tr key={r.id}>
                    <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)', fontSize:12 }}>{String(r.id).slice(-8)}</span></td>
                    <td style={tableStyles.td}>{r.user}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{r.shop}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>{r.service}</td>
                    <td style={tableStyles.td} className="mono">{r.time}</td>
                    <td style={tableStyles.td}><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <TriageList
            title="Open bugs to triage"
            count={counters?.open_bugs ?? 0}
            loading={bugsGrouped === undefined}
            items={bugItems}
          />
          <TriageList
            title="Open feedback to triage"
            count={counters?.open_feedback ?? 0}
            loading={fbGrouped === undefined}
            items={fbItems}
          />
        </div>
      </div>
    </SectionAnchor>
  )
}
