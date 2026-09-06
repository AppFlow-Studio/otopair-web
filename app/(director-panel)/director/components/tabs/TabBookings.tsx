'use client'

import { useContext, useState, useEffect } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Badge, Button, Card, Input, Select, Toggle, StatusBadge, SegmentedControl, tableStyles, IconShop } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { consumeGoto, consumeStashedGoto, gotoEntity } from '../directorNav'
import { StatCard, DailyBars, money, fmtDate } from '../Charts'
import { BookingDetailModal } from '../BookingDetailModal'

// MEASURED status set on this deployment (mirrors opsBookings.BOOKING_STATUSES).
const BOARD_STATUSES = [
  'pending',
  'pending_quote',
  'quotes_ready',
  'vehicle_at_shop',
  'completed',
  'cancelled',
  'no_show',
] as const

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  pending_quote: 'Pending quote',
  quotes_ready: 'Quotes ready',
  vehicle_at_shop: 'Vehicle at shop',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No show',
}

// Analytics trend window — mirrors ops/bookings/page.tsx TREND_PERIODS. Drives
// both the bookingsDaily `days` arg and the stat-tile labels.
const TREND_PERIODS = ['7d', '30d', '90d'] as const
type TrendPeriod = (typeof TREND_PERIODS)[number]
const TREND_DAYS: Record<TrendPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 }

// Row shape returned by opsBookings.board (annotated locally — generated api
// types collapse in this tree).
type BoardCard = {
  id: Id<'bookings'>
  userId: Id<'users'>
  user: string
  shopId: Id<'shops'> | null
  shop: string
  vin: string
  vehicleYmm: string | null
  services: string[]
  customServices?: string[]
  origin?: 'walk_in' | 'app'
  source?: string | null
  scheduledDate: string | null
  scheduledTime: string | null
  createdAt: number
  status: string
  liveStage: string | null
  total: number | null
  quote: { low: number | null; high: number | null; setPrice: number | null; isFixed: boolean }
}
type BoardColumn = { status: string; count: number; more: boolean; cards: BoardCard[] }

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// The money to show on a card: the captured total when present, else the quote
// (fixed/set price, or the disclosed low–high band) for quote-stage bookings.
function cardPrice(r: BoardCard): { text: string; estimate: boolean } | null {
  if (r.total != null) return { text: money(r.total, { cents: true }), estimate: false }
  if (r.quote.setPrice != null) return { text: money(r.quote.setPrice, { cents: true }), estimate: !r.quote.isFixed }
  if (r.quote.low != null && r.quote.high != null)
    return { text: `${money(r.quote.low, { cents: true })}–${money(r.quote.high, { cents: true })}`, estimate: true }
  if (r.quote.high != null) return { text: money(r.quote.high, { cents: true }), estimate: true }
  return null
}

// Walk-in (shop-created) vs app (customer self-serve) pill. Origin comes from
// booking.source — see bookingOrigin in convex/director.ts.
const OriginBadge = ({ origin }: { origin?: 'walk_in' | 'app' }) =>
  origin === 'walk_in'
    ? <Badge tone="orange">Walk-in</Badge>
    : <Badge tone="blue">App</Badge>

// Service(s) cell: catalog service names, then any off-catalog custom jobs each
// tagged "Custom". A pure walk-in has no catalog services, so without the custom
// names the cell would read "—" for real work that happened.
const ServiceCell = ({ services, custom }: { services: string[]; custom?: string[] }) => {
  const catalog = (services ?? []).filter(s => s && s !== '—')
  const customJobs = custom ?? []
  if (catalog.length === 0 && customJobs.length === 0) return <>—</>
  return (
    <span style={{ display:'inline-flex', flexWrap:'wrap', alignItems:'center' }}>
      {catalog.length > 0 && <span>{catalog.join(', ')}</span>}
      {customJobs.map((name, i) => {
        // Comma-separate from whatever came before (catalog list or a prior
        // custom line) so the whole cell reads as one list.
        const needsComma = catalog.length > 0 || i > 0
        return (
          <span key={i} style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
            <span>{needsComma ? `, ${name}` : name}</span>
            <Badge tone="teal">Custom</Badge>
          </span>
        )
      })}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Analytics strip — created / completed / cancelled / revenue + created-per-day
// bar trend from portalSeries.bookingsDaily (single query, zero-filled days).
// Mirrors ops/bookings/page.tsx AnalyticsZone.
// ---------------------------------------------------------------------------
const AnalyticsStrip = ({ token, period }: { token: string; period: TrendPeriod }) => {
  const days = TREND_DAYS[period]
  const series = useQuery(api.portalSeries.bookingsDaily, { token, days })

  const sum = (key: 'created' | 'completed' | 'cancelled' | 'revenue') =>
    series?.reduce((s, d) => s + (d[key] ?? 0), 0)
  const spark = (key: 'created' | 'completed' | 'cancelled') => series?.map(d => d[key] ?? 0)

  const bars = series?.map(d => ({ label: d.date.slice(5), value: d.created }))

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
        <StatCard label={`Created (${period})`} tone="blue"
          value={series === undefined ? '—' : (sum('created') ?? 0).toLocaleString()}
          spark={spark('created')} />
        <StatCard label={`Completed (${period})`} tone="green"
          value={series === undefined ? '—' : (sum('completed') ?? 0).toLocaleString()}
          spark={spark('completed')} />
        <StatCard label={`Cancelled (${period})`} tone="red"
          value={series === undefined ? '—' : (sum('cancelled') ?? 0).toLocaleString()}
          spark={spark('cancelled')} />
        <StatCard label={`Completed revenue (${period})`} tone="purple"
          value={series === undefined ? '—' : money(sum('revenue') ?? 0)} />
      </div>
      <Card>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--slate-500)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Bookings created per day
          </span>
          <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>last {days} days</span>
        </div>
        <DailyBars data={bars} valueKey="value" labelKey="label" height={140} color="var(--blue-300, #93C5FD)" />
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Board view — one Card column per measured status, read-only (no drag).
// Mirrors ops/bookings/page.tsx BoardView. Customer name → users tab; the rest
// of the card opens the BookingDetailModal.
// ---------------------------------------------------------------------------
const BoardView = ({ token, onOpen }: { token: string; onOpen: (id: Id<'bookings'>) => void }) => {
  const columns = useQuery(api.opsBookings.board, { token }) as BoardColumn[] | undefined

  return (
    <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
      {(columns ?? BOARD_STATUSES.map(s => ({ status: s, count: 0, more: false, cards: [] as BoardCard[] }))).map(col => (
        <div key={col.status} style={{ display: 'flex', flexDirection: 'column', width: 272, flexShrink: 0, background: '#fff', border: '1px solid var(--slate-200)', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--slate-100)' }}>
            <StatusBadge status={col.status} />
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-400)' }} className="mono">
              {columns === undefined ? '…' : `${col.count}${col.more ? '+' : ''}`}
            </span>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', padding: 8, maxHeight: '70vh' }}>
            {columns === undefined ? (
              <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12, color: 'var(--slate-400)' }}>Loading…</div>
            ) : col.cards.length === 0 ? (
              <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12, color: 'var(--slate-400)' }}>
                No {(STATUS_LABEL[col.status] ?? col.status).toLowerCase()} bookings.
              </div>
            ) : (
              col.cards.map(c => {
                const price = cardPrice(c)
                return (
                  <div key={String(c.id)} onClick={() => onOpen(c.id)}
                    style={{ borderRadius: 8, border: '1px solid var(--slate-100)', padding: '9px 10px', cursor: 'pointer', background: '#fff', transition: 'border-color 80ms, background 80ms' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--slate-300)'; (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--slate-100)'; (e.currentTarget as HTMLElement).style.background = '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                      <span onClick={e => { e.stopPropagation(); gotoEntity('users', String(c.userId)) }}
                        style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-800)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--blue-600)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--slate-800)' }}>
                        {c.user}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--slate-400)' }}>
                        {c.scheduledDate ? fmtDate(c.scheduledDate) : shortDate(c.createdAt)}{c.scheduledTime ? ` ${c.scheduledTime}` : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
                      <span style={{ flex: 1, fontSize: 12, color: 'var(--slate-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.shop}</span>
                      <OriginBadge origin={c.origin} />
                    </div>
                    {c.vehicleYmm && (
                      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--slate-700)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.vehicleYmm}</div>
                    )}
                    <div style={{ fontSize: 12, color: 'var(--slate-600)', marginTop: 3 }}>
                      {c.services.filter(s => s && s !== '—').length === 0 && (c.customServices ?? []).length === 0
                        ? 'Service TBD'
                        : <ServiceCell services={c.services} custom={c.customServices} />}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 5 }}>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--slate-400)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.vin || 'no VIN'}
                      </span>
                      {price ? (
                        <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: 'var(--slate-700)' }} className="mono">
                          {price.text}
                          {price.estimate && <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 400, color: 'var(--slate-400)' }}>est</span>}
                        </span>
                      ) : (
                        <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--slate-400)' }}>awaiting quote</span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// List view — the existing recent-50 director list (api.director.recentBookingsList)
// with its status/shop/refund/fallback filters, plus origin (walk-in/app) +
// custom-work filters and an Origin column.
// ---------------------------------------------------------------------------
const ListView = ({ token, onOpen }: { token: string; onOpen: (id: Id<'bookings'>) => void }) => {
  const [statusFilter, setStatusFilter] = useState('all')
  const [shopFilter, setShopFilter]     = useState('')
  const [originFilter, setOriginFilter] = useState('all')
  const [untaggedOnly, setUntaggedOnly] = useState(false)
  const [fallbackOnly, setFallbackOnly] = useState(false)
  const [customOnly, setCustomOnly]     = useState(false)

  const bookings = useQuery(api.director.recentBookingsList, { token })

  const filtered = (bookings ?? []).filter(b => {
    if (statusFilter !== 'all' && b.status !== statusFilter) return false
    if (shopFilter && !b.shop.toLowerCase().includes(shopFilter.toLowerCase())) return false
    if (originFilter !== 'all' && (b.origin ?? 'app') !== originFilter) return false
    if (customOnly && (b.customServices ?? []).length === 0) return false
    if (untaggedOnly && b.status !== 'refunded') return false
    if (
      fallbackOnly &&
      (b.fallback.catches +
        b.fallback.corrected +
        b.fallback.refused +
        b.fallback.aboveEngine +
        (b.fallback.laborFloored ?? 0) +
        (b.fallback.laborAbove ?? 0)) === 0
    ) return false
    return true
  })

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          options={[{ value:'all', label:'All statuses' },{ value:'pending', label:'Pending' },{ value:'confirmed', label:'Confirmed' },{ value:'in_progress', label:'In progress' },{ value:'completed', label:'Completed' },{ value:'cancelled', label:'Cancelled' },{ value:'refunded', label:'Refunded' }]} />
        <Select value={originFilter} onChange={e => setOriginFilter(e.target.value)}
          options={[{ value:'all', label:'All origins' },{ value:'app', label:'App' },{ value:'walk_in', label:'Walk-in' }]} />
        <Input icon={<IconShop size={14} />} value={shopFilter} onChange={e => setShopFilter(e.target.value)} placeholder="Filter by shop…" style={{ width:220 }} />
        <span style={{ width:1, height:22, background:'var(--slate-200)' }} />
        <Toggle checked={customOnly} onChange={e => setCustomOnly(e.target.checked)} label="Custom work only" />
        <Toggle checked={untaggedOnly} onChange={e => setUntaggedOnly(e.target.checked)} label="Show refunds only" />
        <Toggle checked={fallbackOnly} onChange={e => setFallbackOnly(e.target.checked)} label="Fallback only" />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {bookings === undefined ? 'Loading…' : `Showing ${filtered.length} of ${bookings.length}`}
        </span>
      </div>
      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Booking</th>
            <th style={tableStyles.th}>User</th>
            <th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>Origin</th>
            <th style={tableStyles.th}>Service(s)</th>
            <th style={tableStyles.th}>Fallback</th>
            <th style={tableStyles.th}>Scheduled</th>
            <th style={tableStyles.th}>Status</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Total</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {bookings === undefined
              ? <tr><td colSpan={10} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={10} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No bookings found.</td></tr>
                : filtered.map(b => (
                  <tr key={b.id} onClick={() => onOpen(b.id)} style={{ cursor:'pointer' }}>
                    <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)', fontWeight:500 }}>{String(b.id).slice(-8)}</span></td>
                    <td style={tableStyles.td}>{b.user}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.shop}</td>
                    <td style={tableStyles.td}><OriginBadge origin={b.origin} /></td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}><ServiceCell services={b.services} custom={b.customServices} /></td>
                    <td style={tableStyles.td}>
                      {(b.fallback.catches +
                        b.fallback.corrected +
                        b.fallback.refused +
                        b.fallback.aboveEngine +
                        (b.fallback.laborFloored ?? 0) +
                        (b.fallback.laborAbove ?? 0)) === 0 ? null : (
                        <span style={{ display:'inline-flex', gap:4, flexWrap:'wrap' }}>
                          {b.fallback.catches > 0 && <Badge tone="orange">⚠{b.fallback.catches}</Badge>}
                          {b.fallback.corrected > 0 && <Badge tone="green">✓{b.fallback.corrected}</Badge>}
                          {b.fallback.refused > 0 && <Badge tone="red">✗{b.fallback.refused}</Badge>}
                          {b.fallback.aboveEngine > 0 && (
                            <Badge tone="blue">
                              {b.fallback.aboveEngineDeltaDollars != null
                                ? `$+${b.fallback.aboveEngineDeltaDollars.toFixed(0)}`
                                : "$+"}
                            </Badge>
                          )}
                          {(b.fallback.laborFloored ?? 0) > 0 && (
                            <Badge tone="yellow">Lh↑{b.fallback.laborFloored}</Badge>
                          )}
                          {(b.fallback.laborAbove ?? 0) > 0 && (
                            <Badge tone="slate">Lh+{b.fallback.laborAbove}</Badge>
                          )}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{fmtDate(b.scheduled)}{b.time !== '—' ? ` · ${b.time}` : ''}</td>
                    <td style={tableStyles.td}><StatusBadge status={b.status} /></td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                      <Button size="sm" onClick={() => onOpen(b.id)}>View</Button>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>
    </>
  )
}

export const TabBookings = () => {
  const session = useContext(DirectorSessionCtx)
  const token   = session?.token ?? ''
  const [view, setView]     = useState<'list' | 'board'>('list')
  const [period, setPeriod] = useState<TrendPeriod>('30d')
  const [openId, setOpenId] = useState<Id<'bookings'> | null>(null)

  useEffect(() => {
    // In-memory goto (same-session nav) or a stashed goto surviving the hard
    // redirect from the retired /ops/bookings/[id] shim.
    const goto = consumeGoto() ?? consumeStashedGoto('bookings')
    if (goto?.entityId) setOpenId(goto.entityId as Id<'bookings'>)
  }, [])

  return (
    <SectionAnchor id="bookings" title="Bookings"
      subtitle="The heartbeat page — every booking across the marketplace, by status."
      right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SegmentedControl<TrendPeriod> value={period} onChange={setPeriod}
            options={TREND_PERIODS.map(p => ({ value: p, label: p }))} />
          <SegmentedControl<'list' | 'board'> value={view} onChange={setView}
            options={[{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }]} />
        </div>
      }>
      <AnalyticsStrip token={token} period={period} />

      {view === 'board'
        ? <BoardView token={token} onOpen={setOpenId} />
        : <ListView token={token} onOpen={setOpenId} />}

      <BookingDetailModal bookingId={openId} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
