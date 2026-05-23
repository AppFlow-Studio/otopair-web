'use client'

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import {
  Badge, Button, Card, Select, StatusBadge, tableStyles, Avatar,
  IconBolt, IconStar, IconBug, IconMessage, IconShop,
} from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import {
  StatCard, BarRow, DualSparkline,
  fmtCurrency, fmtPct, fmtNumber, fmtRelative,
} from '../Charts'

type Period = 'today' | '7d' | '30d' | '90d'
const PERIOD_LABELS: Record<Period, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', '90d': '90 days' }

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

export const TabOverview = () => {
  const [period, setPeriod] = useState<Period>('30d')

  const metrics    = useQuery(api.directorOverview.overviewMetrics, { period })
  const chart      = useQuery(api.directorOverview.overviewRevenueChart, { days: period === '7d' ? 14 : period === '30d' ? 30 : period === '90d' ? 60 : 14 })
  const topShops   = useQuery(api.directorOverview.overviewTopShops,    { period, limit: 8 }) as TopShopRow[] | undefined
  const topMechs   = useQuery(api.directorOverview.overviewTopMechanics,{ period, limit: 8 }) as TopMechanicRow[] | undefined
  const serviceMix = useQuery(api.directorOverview.overviewServiceMix,  { period, limit: 10 }) as ServiceMixRow[] | undefined
  const today      = useQuery(api.directorOverview.overviewBookingsToday, { period, limit: 30 }) as TodayRow[] | undefined
  const triage     = useQuery(api.directorOverview.overviewTriageQueues, {}) as TriageData | undefined

  return (
    <SectionAnchor id="overview" title="Overview"
      subtitle="Live marketplace health. Updates in real time."
      right={
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <Select value={period} onChange={e => setPeriod(e.target.value as Period)}
            options={(['today','7d','30d','90d'] as Period[]).map(p => ({ value:p, label: PERIOD_LABELS[p] }))} />
        </div>
      }>

      {/* Hero strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Revenue" tone="green"
          value={metrics ? fmtCurrency(metrics.revenue.current) : '…'}
          delta={metrics?.revenue.deltaPct != null ? metrics.revenue.deltaPct / 100 : null}
          hint={metrics ? `vs ${fmtCurrency(metrics.revenue.prior)} prior` : ''}
          spark={chart?.series.map(s => s.revenue)} />
        <StatCard label="Bookings" tone="blue"
          value={metrics ? fmtNumber(metrics.bookings.current) : '…'}
          delta={metrics?.bookings.deltaPct != null ? metrics.bookings.deltaPct / 100 : null}
          hint={metrics ? `${metrics.bookings.completed} completed · ${metrics.bookings.refunded} refunded` : ''}
          spark={chart?.series.map(s => s.bookings)} />
        <StatCard label="New users" tone="purple"
          value={metrics ? fmtNumber(metrics.users.new) : '…'}
          delta={metrics?.users.deltaPct != null ? metrics.users.deltaPct / 100 : null}
          hint={metrics ? `${fmtNumber(metrics.users.total)} total` : ''} />
        <StatCard label="Avg rating" tone="yellow"
          value={metrics ? metrics.reviews.avgRecent.toFixed(2) : '…'}
          accent={<IconStar size={14} style={{ color:'#F59E0B' }} />}
          hint={metrics ? `${metrics.reviews.recent} new · ${metrics.reviews.count} lifetime` : ''} />
      </div>

      {/* Secondary ops counters */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:12, marginBottom:16 }}>
        <SmallStat label="Active bookings"   value={metrics ? fmtNumber(metrics.bookings.active) : '…'}
          hint="confirmed + in-progress + pending" Icon={IconBolt} />
        <SmallStat label="Active shops"      value={metrics ? fmtNumber(metrics.shops.active) : '…'}
          hint={metrics ? `${metrics.shops.stripeConnected} on Stripe` : ''} Icon={IconShop} />
        <SmallStat label="Avg ticket"        value={metrics ? fmtCurrency(metrics.revenue.avgTicket) : '…'}
          hint="completed only" />
        <SmallStat label="Open bugs"         value={metrics ? fmtNumber(metrics.bugs.open) : '…'}
          hint={metrics ? `${metrics.bugs.unassigned} unassigned` : ''} Icon={IconBug} tone="red" />
        <SmallStat label="Open feedback"     value={metrics ? fmtNumber(metrics.feedback.open) : '…'}
          hint={metrics ? `${metrics.feedback.negative} negative` : ''} Icon={IconMessage} />
        <SmallStat label="Oto thumbs-down"   value={metrics ? fmtNumber(metrics.otoFeedback.thumbsDown) : '…'}
          hint={metrics ? `${metrics.otoFeedback.recent} new this period` : ''} Icon={IconBolt} />
      </div>

      {/* Daily chart */}
      <Card style={{ marginBottom:16 }}>
        <SectionTitle label="Daily revenue & bookings"
          right={<span style={{ fontSize:11, color:'var(--slate-500)' }}>
            {chart ? `${chart.days} days · ${fmtCurrency(chart.totalRevenue)} total · ${fmtNumber(chart.totalBookings)} bookings` : ''}
          </span>} />
        {chart ? <DualSparkline series={chart.series} height={140} />
          : <div style={{ height:140, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>}
      </Card>

      {/* Leaderboards */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
        <Card>
          <SectionTitle label={`Top shops by revenue · ${PERIOD_LABELS[period]}`} />
          {topShops === undefined
            ? <div style={{ fontSize:12, color:'var(--slate-400)', padding:'8px 0' }}>Loading…</div>
            : topShops.length === 0
              ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No shop activity in this period.</div>
              : (() => {
                const max = Math.max(1, ...topShops.map(s => s.revenue))
                return (
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {topShops.map(s => (
                      <BarRow key={String(s.id)}
                        label={
                          <span style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
                            <span style={{ color:'var(--slate-900)', fontWeight:500, cursor:'pointer' }}
                              onClick={() => gotoEntity('shops', String(s.id))}>{s.name}</span>
                            {s.refundRate > 0.05 && <Badge tone="red">{fmtPct(s.refundRate)} refund</Badge>}
                          </span>
                        }
                        value={s.revenue} max={max}
                        valueLabel={<>{fmtCurrency(s.revenue)} <span style={{ color:'var(--slate-500)' }}>· {s.bookings}</span></>}
                        color={s.refundRate > 0.05 ? 'var(--red-500)' : 'var(--blue-500)'} />
                    ))}
                  </div>
                )
              })()
          }
        </Card>

        <Card>
          <SectionTitle label={`Top mechanics · ${PERIOD_LABELS[period]}`} />
          {topMechs === undefined
            ? <div style={{ fontSize:12, color:'var(--slate-400)', padding:'8px 0' }}>Loading…</div>
            : topMechs.length === 0
              ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No mechanic activity in this period.</div>
              : (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {topMechs.map((m, i) => (
                    <div key={String(m.id)} style={{
                      display:'flex', alignItems:'center', gap:10, padding:'4px 0',
                      borderBottom: i < topMechs.length - 1 ? '1px solid var(--slate-100)' : 'none',
                    }}>
                      <span style={{ width:18, fontSize:11, color:'var(--slate-500)', textAlign:'right' }} className="mono">{i + 1}</span>
                      <Avatar name={m.name} size={28} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{m.name}</div>
                        <div style={{ fontSize:11, color:'var(--slate-500)' }}>{m.title ?? '—'}</div>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <div className="mono" style={{ fontSize:13, color:'var(--slate-900)' }}>{fmtCurrency(m.revenue)}</div>
                        <div style={{ fontSize:11, color:'var(--slate-500)' }}>
                          {m.completed}/{m.bookings} bookings
                          {m.avgRating > 0 && <> · {m.avgRating.toFixed(1)}★</>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
          }
        </Card>
      </div>

      {/* Service mix + Today's bookings */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.4fr', gap:12, marginBottom:16 }}>
        <Card>
          <SectionTitle label={`Service mix · ${PERIOD_LABELS[period]}`} />
          {serviceMix === undefined
            ? <div style={{ fontSize:12, color:'var(--slate-400)', padding:'8px 0' }}>Loading…</div>
            : serviceMix.length === 0
              ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No services booked in this period.</div>
              : (() => {
                const max = Math.max(1, ...serviceMix.map(s => s.count))
                return (
                  <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                    {serviceMix.map(s => (
                      <BarRow key={String(s.id)}
                        label={<span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</span>}
                        value={s.count} max={max}
                        valueLabel={<>{s.count} <span style={{ color:'var(--slate-500)' }}>· {fmtCurrency(s.revenue)}</span></>}
                        color="var(--indigo-500, #6366F1)" />
                    ))}
                  </div>
                )
              })()
          }
        </Card>

        <Card padded={false}>
          <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
              {period === 'today' ? "Today's bookings" : 'Recent bookings'}
            </span>
            <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, fontWeight:500, color:'var(--green-700)' }}>
              <span style={{ width:6, height:6, borderRadius:999, background:'var(--green-600)' }} />Live
            </span>
          </div>
          {today === undefined
            ? <div style={{ padding:32, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
            : today.length === 0
              ? <div style={{ padding:32, textAlign:'center', color:'var(--slate-400)', fontSize:13, fontStyle:'italic' }}>No bookings yet.</div>
              : (
                <div style={{ maxHeight:300, overflowY:'auto' }}>
                  <table style={{ ...tableStyles.table, fontSize:12 }}>
                    <tbody>
                      {today.map(b => (
                        <tr key={String(b.id)} onClick={() => gotoEntity('bookings', String(b.id))} style={{ cursor:'pointer' }}>
                          <td style={{ ...tableStyles.td, padding:'8px 16px', color:'var(--slate-500)' }} className="mono">{b.time}</td>
                          <td style={{ ...tableStyles.td, padding:'8px 16px', color:'var(--slate-900)' }}>{b.user}</td>
                          <td style={{ ...tableStyles.td, padding:'8px 16px', color:'var(--slate-600)' }}>{b.shop}</td>
                          <td style={{ ...tableStyles.td, padding:'8px 16px', color:'var(--slate-500)', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.service}</td>
                          <td style={{ ...tableStyles.td, padding:'8px 16px' }}><StatusBadge status={b.status} /></td>
                          <td style={{ ...tableStyles.td, padding:'8px 16px', textAlign:'right' }} className="mono">{fmtCurrency(b.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          }
        </Card>
      </div>

      {/* Triage rails */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
        <Card padded={false}>
          <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Open bugs to triage</span>
            <Button size="sm" onClick={() => { window.location.hash = 'bugs' }}>View all →</Button>
          </div>
          {triage === undefined
            ? <div style={{ padding:24, textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>Loading…</div>
            : triage.bugs.length === 0
              ? <div style={{ padding:24, textAlign:'center', fontSize:13, color:'var(--slate-500)' }}>Nothing to triage.</div>
              : triage.bugs.map(b => (
                <div key={String(b.id)} onClick={() => gotoEntity('bugs', String(b.id))}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 16px', borderBottom:'1px solid var(--slate-100)', cursor:'pointer' }}>
                  <Badge tone={b.status === 'new' ? 'blue' : b.status === 'triaged' ? 'indigo' : 'purple'} dot>{b.status}</Badge>
                  <span style={{ flex:1, fontSize:13, color:'var(--slate-900)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.title}</span>
                  <span style={{ fontSize:11, color:'var(--slate-500)' }}>{fmtRelative(b.createdAt)}</span>
                </div>
              ))
          }
        </Card>

        <Card padded={false}>
          <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Open feedback to triage</span>
            <Button size="sm" onClick={() => { window.location.hash = 'feedback' }}>View all →</Button>
          </div>
          {triage === undefined
            ? <div style={{ padding:24, textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>Loading…</div>
            : triage.feedback.length === 0
              ? <div style={{ padding:24, textAlign:'center', fontSize:13, color:'var(--slate-500)' }}>Nothing to triage.</div>
              : triage.feedback.map(f => (
                <div key={String(f.id)} onClick={() => gotoEntity('feedback', String(f.id))}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 16px', borderBottom:'1px solid var(--slate-100)', cursor:'pointer' }}>
                  <span style={{ width:6, height:6, borderRadius:999, background:
                    f.sentiment === 'positive' ? 'var(--green-600)' :
                    f.sentiment === 'negative' ? 'var(--red-600)' : 'var(--slate-400)' }} />
                  <span style={{ flex:1, fontSize:13, color:'var(--slate-900)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.title}</span>
                  <span style={{ fontSize:11, color:'var(--slate-500)' }}>{fmtRelative(f.createdAt)}</span>
                </div>
              ))
          }
        </Card>
      </div>
    </SectionAnchor>
  )
}

const SmallStat = ({ label, value, hint, Icon, tone }: {
  label: string
  value: React.ReactNode
  hint?: string
  Icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  tone?: 'red' | 'yellow'
}) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:'10px 12px' }}>
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
      {Icon && <Icon size={12} style={{ color: tone === 'red' ? 'var(--red-500)' : 'var(--slate-400)' }} />}
      <span style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    </div>
    <div style={{ fontSize:18, fontWeight:600, color:'var(--slate-900)' }} className="mono">{value}</div>
    {hint && <div style={{ fontSize:11, color: tone === 'red' ? 'var(--red-700)' : 'var(--slate-500)', marginTop:2 }}>{hint}</div>}
  </div>
)

type TopShopRow = {
  id: Id<'shops'>; name: string; city: string; revenue: number; bookings: number; completed: number;
  refunded: number; refundRate: number; avgRating: number; reviewCount: number; stripeConnected: boolean
}
type TopMechanicRow = {
  id: Id<'mechanics'>; name: string; title?: string; bookings: number; completed: number; revenue: number;
  avgRating: number; reviewCount: number; shopId?: Id<'shops'>
}
type ServiceMixRow = { id: Id<'services'>; name: string; count: number; revenue: number }
type TodayRow = { id: Id<'bookings'>; user: string; shop: string; service: string; time: string; date: string; status: string; total: number }
type TriageData = {
  bugs:     { id: Id<'bugs'>;         title: string; status: string; source: string; createdAt?: number }[]
  feedback: { id: Id<'app_feedback'>; title: string; status: string; category: string; sentiment: string; source: string; createdAt?: number }[]
}
