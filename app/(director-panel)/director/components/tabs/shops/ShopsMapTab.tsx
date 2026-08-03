'use client'

import { useContext } from 'react'
import dynamic from 'next/dynamic'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge, MicroH, tableStyles } from '../../Primitives'
import { StatCard, DailyBars, money, fmtNumber, dayLabel } from '../../Charts'

// Network map + week KPIs + new-shops trend + 7d league table — ported from
// /shops (network overview). ShopsMap is reused verbatim (Leaflet, ssr:false);
// its popup "Open shop →" links to /shops/all/:id, which the redirect shim
// forwards back into #shops.

const ShopsMap = dynamic(() => import('@/components/portal/ShopsMap'), {
  ssr: false,
  loading: () => <div style={{ height:380, background:'var(--slate-100)', borderRadius:8 }} className="animate-pulse" />,
})

type WeekKpis = { week_start: number; bookings_week: number; gmv_week: number; bookings_prev_week: number; gmv_prev_week: number }
type LeagueRow = {
  id: string; name: string; city: string | null; is_active: boolean
  rating: number | null; review_count: number; bookings_7d: number; gmv_7d: number; completion_rate_7d: number | null
}

const WowChip = ({ current, prev }: { current: number; prev: number }) => {
  if (prev === 0) return current > 0 ? <Badge tone="green">new vs last wk</Badge> : null
  const pct = Math.round(((current - prev) / prev) * 100)
  if (pct === 0) return <Badge tone="slate">flat vs last wk</Badge>
  const up = pct > 0
  return <Badge tone={up ? 'green' : 'red'}>{up ? '▲' : '▼'} {Math.abs(pct)}% vs last wk</Badge>
}

const LegendDot = ({ color, label }: { color: string; label: string }) => (
  <span style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, color:'var(--slate-600)' }}>
    <span style={{ width:12, height:12, borderRadius:999, background:color, border:'2px solid #fff', boxShadow:'0 1px 3px rgba(2,6,23,0.3)' }} />
    {label}
  </span>
)

export const ShopsMapTab = ({ onOpenShop, onGoDirectory }: { onOpenShop: (id: string) => void; onGoDirectory: () => void }) => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''

  const stats = useQuery(api.portalStats.getStats, { token, keys: ['shops.mechanics_total'] }) as
    | Record<string, { value: number } | null> | undefined
  const week = useQuery(api.shopsNetwork.weekKpis, { token }) as WeekKpis | undefined
  const league = useQuery(api.shopsNetwork.leagueTable, { token }) as LeagueRow[] | undefined
  const mapData = useQuery(api.portalSeries.shopsMap, { token }) as
    | { pins: any[]; missing_coords: { id: string; name: string }[] } | undefined
  const shopStats = useQuery(api.portalSeries.bookingsByShop, { token, days: 30 }) as
    | Record<string, { bookings: number; revenue: number }> | undefined
  const shopsDaily = useQuery(api.portalSeries.shopsDaily, { token, days: 90 }) as
    | { date: string; new_shops: number }[] | undefined

  const pins = mapData?.pins
  const totalShops = mapData === undefined ? null : mapData.pins.length + mapData.missing_coords.length
  const activeShops = pins === undefined ? null : pins.filter((p: any) => p.is_active).length
  const stripeReady = pins === undefined ? null : pins.filter((p: any) => p.stripe_ready).length
  const mechanicsTotal = stats === undefined ? null : stats['shops.mechanics_total']?.value ?? 0
  const newShops90 = shopsDaily === undefined ? null : shopsDaily.reduce((s, d) => s + d.new_shops, 0)

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* KPI tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
        <StatCard label="Total shops" value={totalShops === null ? '—' : fmtNumber(totalShops)} onClick={onGoDirectory} />
        <StatCard label="Active shops" value={activeShops === null ? '—' : fmtNumber(activeShops)} tone="green" />
        <StatCard label="Stripe-ready" value={stripeReady === null ? '—' : fmtNumber(stripeReady)}
          accent={stripeReady !== null && activeShops !== null && activeShops > 0
            ? <Badge tone={stripeReady < activeShops ? 'yellow' : 'green'}>{Math.round((stripeReady / activeShops) * 100)}% of active</Badge>
            : undefined} />
        <StatCard label="Active mechanics" value={mechanicsTotal === null ? '—' : fmtNumber(mechanicsTotal)} />
        <StatCard label="Bookings this week" value={week === undefined ? '—' : fmtNumber(week.bookings_week)}
          accent={week === undefined ? undefined : <WowChip current={week.bookings_week} prev={week.bookings_prev_week} />} />
        <StatCard label="Network GMV (week)" value={week === undefined ? '—' : money(week.gmv_week)}
          accent={week === undefined ? undefined : <WowChip current={week.gmv_week} prev={week.gmv_prev_week} />} />
        <StatCard label="New shops (90d)" value={newShops90 === null ? '—' : fmtNumber(newShops90)}
          spark={shopsDaily?.map(d => d.new_shops)} tone="blue" />
      </div>

      {/* Network map */}
      <Card>
        <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:12, marginBottom:12 }}>
          <MicroH>Network map</MicroH>
          {pins !== undefined && <span style={{ fontSize:11, color:'var(--slate-400)' }}>{pins.length} shop{pins.length === 1 ? '' : 's'} pinned · popups deep-link to the shop</span>}
          <span style={{ flex:1 }} />
          <div style={{ display:'flex', flexWrap:'wrap', gap:12 }}>
            <LegendDot color="#059669" label="active + Stripe-ready" />
            <LegendDot color="#3b82f6" label="active" />
            <LegendDot color="#94a3b8" label="inactive" />
          </div>
        </div>
        {mapData === undefined ? (
          <div style={{ height:380, background:'var(--slate-100)', borderRadius:8 }} className="animate-pulse" />
        ) : mapData.pins.length === 0 ? (
          <div style={{ height:200, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)', fontSize:13 }}>
            No shops have coordinates yet — the map fills in as lat/lng land on shop rows.
          </div>
        ) : (
          <ShopsMap pins={mapData.pins} stats={shopStats} height={380} />
        )}
        {mapData !== undefined && mapData.missing_coords.length > 0 && (
          <div style={{ marginTop:12, padding:'10px 12px', borderRadius:8, border:'1px solid #FDE68A', background:'var(--amber-50, #FFFBEB)', fontSize:12, color:'var(--amber-800, #92400E)' }}>
            <b>{mapData.missing_coords.length} shop{mapData.missing_coords.length === 1 ? '' : 's'} missing coordinates</b> (not on the map):{' '}
            {mapData.missing_coords.map((s, i) => (
              <span key={s.id}>{i > 0 && ', '}
                <a onClick={() => onOpenShop(s.id)} style={{ textDecoration:'underline', cursor:'pointer', fontWeight:500 }}>{s.name}</a>
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* New shops trend */}
      <Card>
        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:10 }}>
          <MicroH>New shops</MicroH>
          <span style={{ fontSize:11, color:'var(--slate-400)' }}>last 90 days</span>
        </div>
        <DailyBars data={shopsDaily?.map(d => ({ label: dayLabel(d.date), value: d.new_shops }))} />
      </Card>

      {/* League table */}
      <Card padded={false}>
        <div style={{ display:'flex', alignItems:'baseline', gap:8, padding:'16px 18px 10px' }}>
          <MicroH>League table</MicroH>
          <span style={{ fontSize:11, color:'var(--slate-400)' }}>last 7 days</span>
        </div>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Shop</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Bookings 7d</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>GMV 7d</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Completion</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Rating</th>
          </tr></thead>
          <tbody>
            {league === undefined
              ? <tr><td colSpan={5} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:28 }}>Loading…</td></tr>
              : league.length === 0
                ? <tr><td colSpan={5} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:28 }}>No shops yet.</td></tr>
                : league.map(r => (
                  <tr key={r.id} onClick={() => onOpenShop(r.id)} style={{ cursor:'pointer' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={tableStyles.td}>
                      <span style={{ fontWeight:500, color:'var(--slate-900)' }}>{r.name}</span>
                      {r.city && <span style={{ marginLeft:6, fontSize:11, color:'var(--slate-400)' }}>{r.city}</span>}
                      {!r.is_active && <Badge tone="slate" style={{ marginLeft:6 }}>inactive</Badge>}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{r.bookings_7d}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{r.gmv_7d > 0 ? money(r.gmv_7d) : <span style={{ color:'var(--slate-300)' }}>—</span>}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{r.completion_rate_7d === null ? <span style={{ color:'var(--slate-300)' }}>—</span> : `${Math.round(r.completion_rate_7d * 100)}%`}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">
                      {r.rating === null ? <span style={{ color:'var(--slate-300)' }}>—</span>
                        : <span style={{ color: r.rating < 4 ? 'var(--red-600)' : 'var(--slate-700)', fontWeight: r.rating < 4 ? 600 : 400 }}>★ {r.rating.toFixed(1)} <span style={{ fontSize:11, color:'var(--slate-400)' }}>({r.review_count})</span></span>}
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>
    </div>
  )
}
