'use client'

import { useContext, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge, MicroH, Toggle } from '../../Primitives'
import { StatCard, DailyBars, fmtNumber, dayLabel } from '../../Charts'
import { gotoEntity } from '../../directorNav'
import { BookingDetailModal } from '../../BookingDetailModal'
import { Stars } from './shopsUi'
import type { ShopReviewGroup } from './types'

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString()

// Network reviews grouped by shop — /shops/reviews ported. Read-only here
// (moderation lands in a later #reviews tab). Reviewer → #users, mechanic →
// mechanic detail, booking chip → inline booking modal.

export const NetworkReviews = ({ onOpenShop, onOpenMechanic }:
  { onOpenShop: (id: string) => void; onOpenMechanic: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const [lowOnly, setLowOnly] = useState(true)
  const [drillBooking, setDrillBooking] = useState<Id<'bookings'> | null>(null)
  const groups = useQuery(api.shopsReviews.byShop, { token }) as ShopReviewGroup[] | undefined
  const daily = useQuery(api.portalSeries.reviewsDaily, { token, days: 30 }) as
    | { date: string; count: number; avg_rating: number | null }[] | undefined

  const totalReviews = groups?.reduce((s, x) => s + x.count, 0)
  const lowThisWeek = groups?.reduce((s, x) => s + x.low_this_week, 0)
  const ratedGroups = groups?.filter(x => x.avg_rating != null) ?? []
  const networkAvg = groups === undefined
    ? undefined
    : ratedGroups.length > 0
      ? ratedGroups.reduce((s, x) => s + (x.avg_rating ?? 0) * x.count, 0) / Math.max(1, ratedGroups.reduce((s, x) => s + x.count, 0))
      : null

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', justifyContent:'flex-end' }}>
        <Toggle checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} label="≤3★ only" />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12 }}>
        <StatCard label="Reviews (shown window)" value={totalReviews === undefined ? '—' : fmtNumber(totalReviews)} />
        <StatCard label="Network avg rating" value={networkAvg === undefined ? '—' : networkAvg === null ? '—' : `★ ${networkAvg.toFixed(2)}`} tone="yellow" />
        <StatCard label="New ≤3★ this week" value={lowThisWeek === undefined ? '—' : fmtNumber(lowThisWeek)}
          tone={(lowThisWeek ?? 0) > 0 ? 'red' : 'green'}
          accent={lowThisWeek !== undefined ? <Badge tone={lowThisWeek > 0 ? 'red' : 'green'}>{lowThisWeek > 0 ? 'review these' : 'clean week'}</Badge> : undefined} />
      </div>

      <Card>
        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:10 }}>
          <MicroH>Reviews per day</MicroH>
          <span style={{ fontSize:11, color:'var(--slate-400)' }}>last 30 days, network-wide</span>
        </div>
        <DailyBars data={daily?.map(d => ({ label: dayLabel(d.date), value: d.count }))} />
      </Card>

      {groups === undefined
        ? <div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
        : groups.length === 0
          ? <Card><div style={{ textAlign:'center', color:'var(--slate-500)', fontSize:13, padding:'20px 0' }}>No reviews anywhere on the network yet.</div></Card>
          : groups.map(g => {
            const shown = lowOnly ? g.reviews.filter(r => r.rating <= 3) : g.reviews
            const trendMax = Math.max(...g.trend_30d.map(x => x.count), 1)
            return (
              <Card key={g.shop_id} padded={false}>
                <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:10, padding:'12px 16px', borderBottom:'1px solid var(--slate-100)' }}>
                  <a onClick={() => onOpenShop(g.shop_id)} style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)', cursor:'pointer' }}>{g.shop}</a>
                  <Badge tone="slate">★ {g.avg_rating == null ? '—' : g.avg_rating.toFixed(1)} · {g.count}</Badge>
                  {g.low_this_week > 0 && <Badge tone="red">{g.low_this_week} new ≤3★ this week</Badge>}
                  <span style={{ marginLeft:'auto', display:'flex', alignItems:'flex-end', gap:2, height:24 }} title="reviews per week, last 4 weeks">
                    {g.trend_30d.map(w => (
                      <span key={w.week} title={`${w.week}: ${w.count} reviews`} style={{ width:8, borderRadius:'2px 2px 0 0', background:'var(--blue-300, #93C5FD)', height: 4 + (w.count / trendMax) * 20 }} />
                    ))}
                  </span>
                </div>
                {shown.length === 0
                  ? <div style={{ padding:'12px 16px', fontSize:13, color:'var(--slate-400)' }}>{lowOnly ? 'No ≤3★ reviews.' : 'No reviews.'}</div>
                  : shown.map(r => (
                    <div key={r.id} style={{ padding:'10px 16px', borderBottom:'1px solid var(--slate-50)', opacity: r.hidden ? 0.5 : 1 }}>
                      <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8 }}>
                        <Stars rating={r.rating} />
                        {r.reviewer && r.reviewer_id
                          ? <Badge tone="slate"><span style={{ cursor:'pointer' }} onClick={() => gotoEntity('users', r.reviewer_id)}>{r.reviewer}</span></Badge>
                          : r.reviewer ? <Badge tone="slate">{r.reviewer}</Badge> : null}
                        {r.mechanic && (r.mechanic_id
                          ? <Badge tone="slate"><span style={{ cursor:'pointer' }} onClick={() => onOpenMechanic(r.mechanic_id!)}>{r.mechanic}</span></Badge>
                          : <Badge tone="slate">{r.mechanic}</Badge>)}
                        {r.hidden && <Badge tone="slate">hidden</Badge>}
                        <span onClick={() => setDrillBooking(r.booking_id as Id<'bookings'>)} style={{ fontSize:12, fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>booking →</span>
                        <span style={{ marginLeft:'auto', fontSize:12, color:'var(--slate-400)' }}>{fmtDate(r.at)}</span>
                      </div>
                      {(r.vehicle.ymm || r.service_names.length > 0) && (
                        <div style={{ marginTop:4, display:'flex', flexWrap:'wrap', alignItems:'center', gap:6, fontSize:12, color:'var(--slate-500)' }}>
                          {r.vehicle.ymm && <Badge tone="slate">{r.vehicle.ymm}</Badge>}
                          {r.service_names.length > 0 && <span style={{ color:'var(--slate-400)' }}>{r.service_names.join(', ')}</span>}
                        </div>
                      )}
                      {r.comment && <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--slate-600)' }}>{r.comment}</p>}
                    </div>
                  ))}
              </Card>
            )
          })}

      <BookingDetailModal bookingId={drillBooking} onClose={() => setDrillBooking(null)} />
    </div>
  )
}
