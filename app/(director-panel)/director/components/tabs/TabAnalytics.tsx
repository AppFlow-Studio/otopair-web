'use client'

// =============================================================================
// Director · Analytics — hash tab #analytics. Read-only.
// Faithful port of /ops/analytics (app/(portals)/ops/analytics/page.tsx).
//
//   Pulse zone (always visible) — 7d StatCards (events / sessions / users) +
//     hourly event mini-bars + top event types leaderboard, from
//     api.directorData.appEventPulse.
//   Events tab — type-filter dropdown + hourly volume bars + expandable event
//     rows (JSON viewer), from api.opsAnalytics.events.
//   Funnels tab — per-funnel stage bars with drop-off labels + reason badges,
//     from api.opsAnalytics.funnels.
// =============================================================================

import { useState, useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import { Badge, Card, Select, SegmentedControl, MicroH, Skeleton } from '../Primitives'
import { StatCard, BarRow, fmtNumber } from '../Charts'

// ---------------------------------------------------------------------------
// Local types — mirror the convex return shapes (opsAnalytics.ts / directorData.ts)
// ---------------------------------------------------------------------------

type EventRow = {
  id: string
  event_type: string
  event_category: string | null
  user_id: string | null
  session_id: string | null
  data_json: string | null
  at: number
}
type FunnelSummary = {
  funnel_type: string
  total: number
  completed: number
  stages: { stage: string; entered: number; completed: number }[]
  drop_reasons: { reason: string; count: number }[]
}

const fmtDT = (ms: number) => new Date(ms).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

// ---------------------------------------------------------------------------
// MiniBars — dependency-free hourly bar strip (ChartKit MiniBars replacement).
// Matches the ops pulse strip: thin bars scaled to the max, 44px tall by default.
// ---------------------------------------------------------------------------

const MiniBars = ({ values, height = 44, color = 'var(--blue-300, #93C5FD)' }: {
  values: number[]; height?: number; color?: string
}) => {
  const max = Math.max(...values, 1)
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap:1, height }}>
      {values.map((v, i) => (
        <div key={i} title={String(v)}
          style={{ flex:1, minWidth:1, height: Math.max(v > 0 ? 2 : 0, (v / max) * height),
            background: color, borderRadius:'1px 1px 0 0', alignSelf:'flex-end' }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section title (inner heading — matches TabStripe's local SectionTitle)
// ---------------------------------------------------------------------------

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, marginTop:6 }}>
    <MicroH>{label}</MicroH>
    {right}
  </div>
)

// ---------------------------------------------------------------------------
// Pulse zone — 7d event stream at a glance (renders above both tabs)
// ---------------------------------------------------------------------------

const PulseZone = ({ token }: { token: string }) => {
  const pulse = useQuery(api.directorData.appEventPulse, { token })

  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Events · 7d"   tone="blue"  value={pulse === undefined ? '—' : fmtNumber(pulse.total)} />
        <StatCard label="Sessions · 7d" tone="slate" value={pulse === undefined ? '—' : fmtNumber(pulse.sessions)} />
        <StatCard label="Users · 7d"    tone="green" value={pulse === undefined ? '—' : fmtNumber(pulse.users)} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:12, marginBottom:16 }}>
        <Card>
          <MicroH>Hourly event pulse · last 7 days</MicroH>
          <div style={{ marginTop:12 }}>
            {pulse === undefined
              ? <div style={{ height:44, background:'var(--slate-50)', borderRadius:6 }} className="animate-pulse" />
              : <MiniBars values={pulse.hourly.map((h) => h.count)} height={44} />}
          </div>
          {pulse !== undefined && pulse.truncated && (
            <p style={{ marginTop:8, marginBottom:0, fontSize:11, color:'var(--slate-400)' }}>
              Window truncated at 2,000 events.
            </p>
          )}
        </Card>

        <Card>
          <MicroH>Top event types · 7d</MicroH>
          <div style={{ marginTop:12 }}>
            {pulse === undefined ? (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={18} />)}
              </div>
            ) : pulse.top_types.length === 0 ? (
              <p style={{ margin:0, fontSize:13, color:'var(--slate-500)' }}>No events in the window.</p>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {pulse.top_types.map((t) => (
                  <BarRow key={t.type}
                    label={<span className="mono" style={{ fontSize:11 }}>{t.type}</span>}
                    value={t.count}
                    max={Math.max(1, ...pulse.top_types.map((x) => x.count))}
                    valueLabel={fmtNumber(t.count)} />
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Events tab — type filter + hourly volume bars + expandable event rows
// ---------------------------------------------------------------------------

const EventsView = ({ token }: { token: string }) => {
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const events = useQuery(api.opsAnalytics.events, {
    token,
    eventType: typeFilter || undefined,
  })

  if (events === undefined) {
    return <div style={{ height:256, background:'var(--slate-50)', borderRadius:12 }} className="animate-pulse" />
  }

  const maxHourly = Math.max(...events.hourly.map((x: { count: number }) => x.count), 1)

  return (
    <>
      {/* Filter row + hourly volume */}
      <Card style={{ marginBottom:12 }}>
        <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8 }}>
          <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            options={[
              { value:'', label:'All event types' },
              ...events.types.map((t: { type: string; count: number }) => ({
                value: t.type, label: `${t.type} (${t.count})`,
              })),
            ]} />
          <span style={{ fontSize:12, color:'var(--slate-400)' }}>
            {events.window_days}d window{events.truncated ? ' · truncated at 500' : ''}
          </span>
        </div>
        {events.hourly.length > 0 && (
          <div style={{ marginTop:12, display:'flex', alignItems:'flex-end', gap:2, height:120, overflowX:'auto' }}>
            {events.hourly.map((h: { hour: string; count: number }) => (
              <div key={h.hour}
                title={`${h.hour}:00 — ${h.count} events`}
                style={{ width:8, flexShrink:0, height: 4 + (h.count / maxHourly) * 110,
                  background:'var(--blue-300, #93C5FD)', borderRadius:'2px 2px 0 0', alignSelf:'flex-end' }} />
            ))}
          </div>
        )}
      </Card>

      {events.rows.length === 0 ? (
        <Card style={{ textAlign:'center', color:'var(--slate-500)', fontSize:13, padding:32 }}>
          No events in the window.
        </Card>
      ) : (
        <Card padded={false}>
          {(events.rows as EventRow[]).map((e) => (
            <div key={e.id} style={{ borderBottom:'1px solid var(--slate-100)' }}>
              <div role="button" tabIndex={0}
                onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    setExpanded(expanded === e.id ? null : e.id)
                  }
                }}
                style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8, padding:'8px 16px',
                  cursor:'pointer', textAlign:'left' }}
                onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--slate-25)')}
                onMouseLeave={(ev) => (ev.currentTarget.style.background = '')}>
                <Badge tone="slate">{e.event_type}</Badge>
                {e.event_category && (
                  <span style={{ fontSize:11, color:'var(--slate-500)', background:'var(--slate-50)',
                    padding:'2px 7px', borderRadius:999 }}>{e.event_category}</span>
                )}
                {e.user_id && (
                  <a href={`#users`}
                    onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); gotoEntity('users', String(e.user_id)) }}
                    style={{ fontSize:12, fontWeight:500, color:'var(--blue-600)', textDecoration:'none', cursor:'pointer' }}>
                    user →
                  </a>
                )}
                <span style={{ fontSize:12, color:'var(--slate-400)' }}>
                  {e.session_id ? `session ${e.session_id.slice(0, 8)}…` : 'no session'}
                </span>
                <span style={{ marginLeft:'auto', fontSize:12, color:'var(--slate-400)' }}>{fmtDT(e.at)}</span>
              </div>
              {expanded === e.id && (
                <pre className="mono" style={{ margin:0, maxHeight:256, overflow:'auto', background:'var(--slate-50)',
                  padding:'12px 16px', fontSize:11, lineHeight:1.45, color:'var(--slate-700)',
                  whiteSpace:'pre-wrap', wordBreak:'break-all' }}>
                  {e.data_json ?? '(no event_data)'}
                </pre>
              )}
            </div>
          ))}
        </Card>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Funnels tab — stage bars with drop-off labels + reason badges
// ---------------------------------------------------------------------------

const FunnelsView = ({ token }: { token: string }) => {
  const funnels = useQuery(api.opsAnalytics.funnels, { token })

  if (funnels === undefined) {
    return <div style={{ height:256, background:'var(--slate-50)', borderRadius:12 }} className="animate-pulse" />
  }

  if (funnels.funnels.length === 0) {
    return (
      <Card style={{ textAlign:'center', color:'var(--slate-500)', fontSize:13, padding:32 }}>
        No funnel records in the last {funnels.window_days} days.
      </Card>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {(funnels.funnels as FunnelSummary[]).map((f) => {
        const maxEntered = Math.max(...f.stages.map((x) => x.entered), 1)
        return (
          <Card key={f.funnel_type}>
            <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8 }}>
              <h2 style={{ margin:0, fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>{f.funnel_type}</h2>
              <Badge tone="slate">{f.total} entered</Badge>
              <Badge tone="green">
                {f.completed} completed ({f.total > 0 ? Math.round((f.completed / f.total) * 100) : 0}%)
              </Badge>
            </div>

            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:6 }}>
              {f.stages.map((s) => {
                const dropped = s.entered - s.completed
                return (
                  <div key={s.stage} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13 }}>
                    <span style={{ width:160, flexShrink:0, overflow:'hidden', textOverflow:'ellipsis',
                      whiteSpace:'nowrap', color:'var(--slate-600)' }}>{s.stage}</span>
                    <div style={{ height:16, flex:1, overflow:'hidden', borderRadius:4, background:'var(--slate-50)' }}
                      title={`${s.stage} — ${s.entered} entered, ${s.completed} completed`}>
                      <div style={{ height:'100%', borderRadius:'0 4px 4px 0',
                        width:`${Math.max(4, (s.entered / maxEntered) * 100)}%`,
                        background:'var(--blue-300, #93C5FD)' }} />
                    </div>
                    <span className="mono" style={{ width:96, textAlign:'right', color:'var(--slate-500)' }}>
                      {s.entered}
                      {dropped > 0 && <span style={{ marginLeft:4, fontSize:11, color:'var(--red-500)' }}>−{dropped}</span>}
                    </span>
                  </div>
                )
              })}
            </div>

            {f.drop_reasons.length > 0 && (
              <div style={{ marginTop:12, display:'flex', flexWrap:'wrap', gap:6 }}>
                {f.drop_reasons.map((r) => (
                  <Badge key={r.reason} tone="red">{r.reason} × {r.count}</Badge>
                ))}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TabAnalytics root
// ---------------------------------------------------------------------------

export const TabAnalytics = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const [tab, setTab] = useState<'Events' | 'Funnels'>('Events')

  return (
    <SectionAnchor id="analytics" title="Analytics"
      subtitle="Raw app events and conversion funnels — what users actually do in the app."
      right={
        <SegmentedControl<'Events' | 'Funnels'>
          value={tab}
          onChange={setTab}
          options={[{ value:'Events', label:'Events' }, { value:'Funnels', label:'Funnels' }]} />
      }>

      {/* Pulse zone — 7d event stream at a glance */}
      <PulseZone token={token} />

      {tab === 'Events'  && <EventsView token={token} />}
      {tab === 'Funnels' && <FunnelsView token={token} />}
    </SectionAnchor>
  )
}
