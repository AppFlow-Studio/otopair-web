'use client'

import { useContext, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import {
  Badge, Button, Card, Select, Skeleton, StatusBadge, tableStyles, Avatar,
  IconBolt, IconStar, IconBug, IconMessage, IconShop, IconClock,
} from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import {
  StatCard, BarRow, DualSparkline,
  fmtCurrency, fmtPct, fmtNumber, fmtRelative, money,
} from '../Charts'

// Status label map for the ops activity feed + needs-attention rows (from
// app/(portals)/ops/page.tsx STATUS_LABEL).
const OPS_STATUS_LABEL: Record<string, string> = {
  pending_quote: 'pending quote',
  quotes_ready: 'quotes ready',
  vehicle_at_shop: 'vehicle at shop',
}

type Period = 'today' | '7d' | '30d' | '90d'
const PERIOD_LABELS: Record<Period, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', '90d': '90 days' }

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

export const TabOverview = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const [period, setPeriod] = useState<Period>('30d')

  const metrics    = useQuery(api.directorOverview.overviewMetrics, { token, period })
  const chart      = useQuery(api.directorOverview.overviewRevenueChart, { token, days: period === '7d' ? 14 : period === '30d' ? 30 : period === '90d' ? 60 : 14 })
  const topShops   = useQuery(api.directorOverview.overviewTopShops,    { token, period, limit: 8 }) as TopShopRow[] | undefined
  const topMechs   = useQuery(api.directorOverview.overviewTopMechanics,{ token, period, limit: 8 }) as TopMechanicRow[] | undefined
  const serviceMix = useQuery(api.directorOverview.overviewServiceMix,  { token, period, limit: 10 }) as ServiceMixRow[] | undefined
  const today      = useQuery(api.directorOverview.overviewBookingsToday, { token, period, limit: 30 }) as TodayRow[] | undefined
  const triage     = useQuery(api.directorOverview.overviewTriageQueues, { token }) as TriageData | undefined

  // Ops-fed live surfaces (ported from app/(portals)/ops/page.tsx).
  const kpis       = useQuery(api.opsOverview.kpis, { token }) as OpsKpis | undefined
  const feed       = useQuery(api.opsOverview.activityFeed, { token, limit: 30 }) as FeedItem[] | undefined
  const attention  = useQuery(api.opsOverview.needsAttention, { token }) as AttentionData | undefined

  // Lifetime KPI counters (portal_stats, R2) + daily series for the KPI-tile
  // sparklines — ported verbatim from app/(portals)/ops/page.tsx.
  const stats      = useQuery(api.portalStats.getStats, { token, keys: ['ops.users_total', 'ops.active_users_7d'] }) as StatsRow | undefined
  const opsDays    = period === '7d' ? 7 : period === '90d' ? 90 : 30
  const paymentsDaily = useQuery(api.portalSeries.paymentsDaily, { token, days: opsDays }) as { captured_usd: number }[] | undefined
  const bookingsDaily = useQuery(api.portalSeries.bookingsDaily, { token, days: opsDays }) as { created: number }[] | undefined

  const usersTotal    = stats?.['ops.users_total']?.value ?? null
  const activeUsers7d  = stats?.['ops.active_users_7d']?.value ?? null
  const capturedSpark = paymentsDaily?.map(d => d.captured_usd)
  const bookingsSpark = bookingsDaily?.map(d => d.created)

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

      {/* Ops KPI strip — today's live pulse (api.opsOverview.kpis) + lifetime
          counters (api.portalStats.getStats). Sparklines from api.portalSeries. */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Bookings today" tone="blue"
          value={kpis === undefined ? '…' : fmtNumber(kpis.bookings_today)}
          spark={bookingsSpark}
          onClick={() => { window.location.hash = 'bookings' }} />
        <StatCard label="GMV today" tone="slate"
          value={kpis === undefined ? '…' : money(kpis.gmv_today)} />
        <StatCard label="Captured today" tone="green"
          value={kpis === undefined ? '…' : money(kpis.captured_today)}
          spark={capturedSpark}
          onClick={() => { window.location.hash = 'transactions' }} />
        <StatCard label="Failed payments 24h" tone={kpis && kpis.failed_payments_24h > 0 ? 'red' : 'slate'}
          value={kpis === undefined ? '…'
            : kpis.failed_payments_24h > 0
              ? <span style={{ color:'var(--red-600)' }}>{fmtNumber(kpis.failed_payments_24h)}</span>
              : fmtNumber(kpis.failed_payments_24h)}
          accent={kpis && kpis.failed_payments_24h > 0 ? <Badge tone="red">attention</Badge> : undefined}
          onClick={() => { window.location.hash = 'transactions' }} />
        <StatCard label="Pending deletions" tone={kpis && kpis.pending_deletions > 0 ? 'yellow' : 'slate'}
          value={kpis === undefined ? '…' : fmtNumber(kpis.pending_deletions)}
          accent={kpis && kpis.pending_deletions > 0 ? <Badge tone="yellow">queue</Badge> : undefined}
          onClick={() => { window.location.hash = 'deletionQueue' }} />
        <StatCard label="Users total" tone="purple"
          value={stats === undefined ? '…' : fmtNumber(usersTotal)}
          onClick={() => { window.location.hash = 'users' }} />
        <StatCard label="Active users 7d" tone="slate"
          value={stats === undefined ? '…' : fmtNumber(activeUsers7d)} />
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

      {/* Ops live rails — Activity feed + Needs attention (api.opsOverview.*) */}
      <div style={{ display:'grid', gridTemplateColumns:'1.35fr 1fr', gap:12, marginBottom:16 }}>
        {/* Activity feed — merged recent bookings + payments */}
        <Card padded={false}>
          <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Live activity</span>
            <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, fontWeight:500, color:'var(--green-700)' }}>
              <span style={{ width:6, height:6, borderRadius:999, background:'var(--green-600)' }} />Live
            </span>
          </div>
          {feed === undefined ? (
            <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:8 }}>
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={30} />)}
            </div>
          ) : feed.length === 0 ? (
            <div style={{ padding:32, textAlign:'center', color:'var(--slate-400)', fontSize:13, fontStyle:'italic' }}>Quiet so far today.</div>
          ) : (
            <div style={{ maxHeight:360, overflowY:'auto' }}>
              {feed.map(e => {
                const context = [
                  e.vehicleYmm,
                  e.services.filter(s => s && s !== '—').join(', ') || null,
                  e.shop,
                ].filter(Boolean).join(' · ')
                const goDetail = () =>
                  e.kind === 'booking'
                    ? gotoEntity('bookings', e.bookingId ?? e.id)
                    : gotoEntity('transactions', e.id)
                return (
                  <div key={`${e.kind}-${e.id}`}
                    style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'10px 16px', borderBottom:'1px solid var(--slate-100)' }}>
                    <Badge tone={e.kind === 'booking' ? 'blue' : 'green'} style={{ marginTop:2, flexShrink:0 }}>{e.kind}</Badge>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'baseline', gap:6, fontSize:13 }}>
                        <span style={{ fontWeight:500, color:'var(--slate-900)', cursor:'pointer' }}
                          onClick={() => gotoEntity('users', e.user.id)}>{e.user.name}</span>
                        <span style={{ color:'var(--slate-400)' }}>·</span>
                        <span style={{ color:'var(--slate-600)' }}>{OPS_STATUS_LABEL[e.status] ?? e.status.replace(/_/g, ' ')}</span>
                      </div>
                      <div onClick={goDetail}
                        style={{ marginTop:1, fontSize:12, color:'var(--slate-500)', cursor:'pointer', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {context || 'no vehicle / service on file'}
                      </div>
                    </div>
                    {e.amount != null && (
                      <span className="mono" style={{ marginTop:1, flexShrink:0, fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{money(e.amount)}</span>
                    )}
                    <span style={{ marginTop:1, flexShrink:0, fontSize:11, color:'var(--slate-400)' }} title={new Date(e.at).toLocaleString()}>{fmtRelative(e.at)}</span>
                    <span onClick={goDetail}
                      style={{ marginTop:1, flexShrink:0, fontSize:12, color:'var(--slate-300)', cursor:'pointer' }} aria-label="Open detail">→</span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* Needs attention — stuck bookings + pending deletions */}
        <Card padded={false} style={{ border:'1px solid var(--yellow-300, #FCD34D)' }}>
          <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Needs attention</span>
            {kpis && kpis.failed_payments_24h > 0 && (
              <Badge tone="red" dot>{fmtNumber(kpis.failed_payments_24h)} failed 24h</Badge>
            )}
          </div>
          {attention === undefined ? (
            <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:8 }}>
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} height={30} />)}
            </div>
          ) : (
            <div style={{ padding:'10px 12px', display:'flex', flexDirection:'column', gap:8 }}>
              {attention.pending_deletions > 0 && (
                <div onClick={() => { window.location.hash = 'deletionQueue' }}
                  style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, padding:'8px 12px', borderRadius:8, background:'var(--yellow-50, #FEFCE8)', cursor:'pointer', fontSize:13, color:'var(--slate-700)' }}>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                    <IconClock size={13} style={{ color:'var(--yellow-700, #A16207)' }} />
                    {attention.pending_deletions} deletion request{attention.pending_deletions === 1 ? '' : 's'} pending
                    {attention.oldest_deletion_age_days != null && ` — oldest ${attention.oldest_deletion_age_days}d`}
                  </span>
                  <span style={{ flexShrink:0, fontWeight:600, color:'var(--blue-600)' }}>Fix →</span>
                </div>
              )}
              {attention.stuck_bookings.map(b => (
                <div key={b.id} onClick={() => gotoEntity('bookings', b.id)}
                  style={{ padding:'8px 12px', borderRadius:8, background:'var(--yellow-50, #FEFCE8)', cursor:'pointer', fontSize:13, color:'var(--slate-700)' }}>
                  <div>
                    <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                      <IconBolt size={13} style={{ color:'var(--yellow-700, #A16207)' }} />
                      <span style={{ fontWeight:500, color:'var(--slate-900)' }}>{b.user}</span>
                    </span>
                    {"'s booking at "}
                    <span style={{ fontWeight:500, color:'var(--slate-900)' }}>{b.shop}</span> — stuck in{' '}
                    <span style={{ fontWeight:500 }}>{OPS_STATUS_LABEL[b.status] ?? b.status}</span> {b.age_h}h
                  </div>
                  <div style={{ marginTop:2, fontSize:11, color:'var(--slate-500)' }}>
                    {(() => {
                      const parts: React.ReactNode[] = [
                        b.total != null ? money(b.total) : null,
                        b.scheduled ? `scheduled ${b.scheduled}` : null,
                        b.vin ? <a key="vin" href={`/director/data/vins/${b.vin}`} onClick={ev => ev.stopPropagation()} style={{ color:'var(--slate-500)', textDecoration:'underline' }}>{`VIN ${b.vin}`}</a> : null,
                      ].filter(Boolean)
                      if (parts.length === 0) return 'no quote yet'
                      return parts.reduce<React.ReactNode[]>((acc, part, i) => i === 0 ? [part] : [...acc, ' · ', part], [])
                    })()}
                  </div>
                </div>
              ))}
              {attention.pending_deletions === 0 && attention.stuck_bookings.length === 0 && (
                <div style={{ padding:'8px 4px', fontSize:13, color:'var(--slate-500)' }}>Nothing needs attention right now.</div>
              )}
            </div>
          )}
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

// ---- api.portalStats.getStats shape (ops.users_total / ops.active_users_7d) ----
type StatsRow = Record<string, { value: number; meta?: unknown; computed_at: number } | null>

// ---- api.opsOverview.* shapes (ported from app/(portals)/ops/page.tsx) ----
type OpsKpis = {
  bookings_today: number
  gmv_today: number
  captured_today: number
  failed_payments_24h: number
  pending_deletions: number
}
type FeedItem = {
  kind: 'booking' | 'payment'
  id: string
  bookingId: string | null
  at: number
  status: string
  amount: number | null
  user: { id: string; name: string }
  vehicleYmm: string | null
  services: string[]
  shop: string | null
}
type StuckBooking = {
  id: string
  status: string
  age_h: number
  user: string
  shop: string
  vin: string | null
  total: number | null
  scheduled: string | null
}
type AttentionData = {
  oldest_deletion_age_days: number | null
  pending_deletions: number
  stuck_bookings: StuckBooking[]
}
