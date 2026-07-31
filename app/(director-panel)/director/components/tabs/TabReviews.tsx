'use client'

// Director · Reviews moderation — hash tab #reviews.
// Faithful port of app/(portals)/ops/reviews/page.tsx into the director's
// inline-style theme. Default "needs eyes" = rating ≤3 (or hidden), newest
// first. Hide = ceremony (reason ≥4 chars, audited, never a delete — the row
// stays for the trail); hidden rows render as grey strips with Restore.

import { useContext, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { can } from '@/lib/portal/capabilities'
import { Badge, Button, Card, Modal, MicroH, Skeleton } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity, stashGoto } from '../directorNav'
import { StatCard, DailyBars, fmtNumber } from '../Charts'

// ---------------------------------------------------------------------------
// Local helpers (no director equivalent)
// ---------------------------------------------------------------------------

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString()

const SegmentedView = <T extends string>({ value, options, onChange }:
  { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) => (
  <div style={{ display:'inline-flex', gap:2, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:3 }}>
    {options.map(o => {
      const isActive = value === o.value
      return (
        <button key={o.value} onClick={() => onChange(o.value)}
          style={{ padding:'6px 12px', border:'none', borderRadius:6, cursor:'pointer', fontSize:13, fontWeight:500,
            background: isActive ? 'var(--blue-50)' : 'transparent',
            color: isActive ? 'var(--blue-700)' : 'var(--slate-600)', transition:'background 80ms', fontFamily:'inherit' }}>
          {o.label}
        </button>
      )
    })}
  </div>
)

// Filled/empty stars matching the ops source (amber ★ + slate remainder).
const Stars = ({ n }: { n: number }) => {
  const filled = Math.round(n)
  return (
    <span style={{ fontSize:15, letterSpacing:'-0.5px', whiteSpace:'nowrap' }}>
      <span style={{ color:'#F59E0B' }}>{'★'.repeat(filled)}</span>
      <span style={{ color:'var(--slate-200)' }}>{'★'.repeat(Math.max(0, 5 - filled))}</span>
    </span>
  )
}

// Section header inside the tab body (mirrors ops MICRO_H usage).
const SectionTitle = ({ label, right }: { label: React.ReactNode; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:12 }}>
    <MicroH style={{ display:'flex', alignItems:'baseline', gap:8 }}>{label}</MicroH>
    {right}
  </div>
)

// Inline deep-link that looks like the ops text link.
const LinkText = ({ onClick, title, children, style }:
  { onClick: () => void; title?: string; children: React.ReactNode; style?: React.CSSProperties }) => (
  <span onClick={onClick} title={title}
    style={{ cursor:'pointer', color:'var(--blue-700)', textDecoration:'none', ...style }}
    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'underline' }}
    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'none' }}>
    {children}
  </span>
)

// Pill-style deep link (mirrors the ops PILL links on visible rows).
const LinkPill = ({ onClick, title, tone = 'slate', children }:
  { onClick: () => void; title?: string; tone?: 'slate' | 'blue'; children: React.ReactNode }) => {
  const bg = tone === 'blue' ? 'var(--blue-50)' : 'var(--slate-100)'
  const fg = tone === 'blue' ? 'var(--blue-700)' : 'var(--slate-600)'
  return (
    <span onClick={onClick} title={title}
      style={{ display:'inline-flex', alignItems:'center', padding:'3px 9px', borderRadius:999, fontSize:12, fontWeight:500,
        background:bg, color:fg, cursor:'pointer', whiteSpace:'nowrap' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'underline' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'none' }}>
      {children}
    </span>
  )
}

type ReviewRow = {
  id: string
  rating: number
  comment: string | null
  user: string | null
  user_id: string
  shop: string | null
  shop_id: string
  mechanic: string | null
  mechanic_id: string | null
  booking_id: string
  vehicleYmm: string | null
  services: string[]
  hidden: boolean
  hidden_reason: string | null
  hidden_by: string | null
  at: number
}

type ReviewInsights = {
  total: number
  avg: number | null
  distribution: { rating: number; count: number }[]
  topShops: { id: string; name: string; avg: number; count: number }[]
  worstShops: { id: string; name: string; avg: number; count: number }[]
  topMechanics: { id: string; name: string; avg: number; count: number }[]
}

// ---------------------------------------------------------------------------
// Ceremony modal (director Modal + reason textarea, ≥4 chars)
// ---------------------------------------------------------------------------

const ReviewCeremony = ({ target, onClose, onConfirm }: {
  target: { row: ReviewRow; action: 'hide' | 'restore' } | null
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) => {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const isHide = target?.action === 'hide'
  const valid = reason.trim().length >= 4

  const submit = async () => {
    if (!target || !valid) return
    setBusy(true)
    try {
      await onConfirm(reason.trim())
      setReason('')
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={target !== null} onClose={() => { setReason(''); onClose() }} width={480}
      title={isHide ? 'Hide review' : 'Restore review'}
      footer={<>
        <Button onClick={() => { setReason(''); onClose() }}>Cancel</Button>
        <Button variant={isHide ? 'danger' : 'primary'} onClick={submit} disabled={!valid || busy}>
          {busy ? 'Working…' : isHide ? 'Hide review' : 'Restore review'}
        </Button>
      </>}>
      <div style={{ padding:22 }}>
        {target && (
          <div style={{ fontSize:13, color:'var(--slate-600)', lineHeight:1.5, marginBottom:16 }}>
            <b>{target.row.rating}★ review</b>{target.row.user ? ` by ${target.row.user}` : ''}
            {target.row.shop ? ` for ${target.row.shop}` : ''} —{' '}
            {isHide
              ? 'hidden from every consumer surface (the row is kept for the audit trail).'
              : 'returns to consumer surfaces immediately.'}
          </div>
        )}
        <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>
          Reason (required)
        </label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} autoFocus
          placeholder="Why is this being moderated? Logged to the audit trail."
          style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)',
            borderRadius:8, fontFamily:'inherit', resize:'vertical', background:'#fff', outline:'none', boxSizing:'border-box' }} />
        {!valid && reason.length > 0 && (
          <div style={{ marginTop:6, fontSize:11, color:'var(--red-700)' }}>A reason of at least 4 characters is required.</div>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// TabReviews root
// ---------------------------------------------------------------------------

export const TabReviews = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const canWrite = can(session?.role, 'users.write')

  const [view, setView] = useState<'needs-eyes' | 'all'>('needs-eyes')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<{ row: ReviewRow; action: 'hide' | 'restore' } | null>(null)

  const reviews  = useQuery(api.opsReviews.list, { token }) as ReviewRow[] | undefined
  const insights = useQuery(api.opsReviews.insights, { token }) as ReviewInsights | undefined
  const daily    = useQuery(api.portalSeries.reviewsDaily, { token, days: 30 }) as
    { date: string; count: number; avg_rating: number | null }[] | undefined
  const hide     = useMutation(api.opsReviews.hide)
  const restore  = useMutation(api.opsReviews.restore)

  const rows = useMemo(() => {
    const all: ReviewRow[] = reviews ?? []
    return view === 'needs-eyes' ? all.filter(r => r.rating <= 3 || r.hidden) : all
  }, [reviews, view])

  // 30d rollups from the daily series (weighted avg over days with reviews).
  const count30d = daily?.reduce((s, d) => s + d.count, 0)
  const avg30d = useMemo(() => {
    if (!daily) return undefined
    let sum = 0
    let n = 0
    for (const d of daily) {
      if (d.avg_rating != null && d.count > 0) {
        sum += d.avg_rating * d.count
        n += d.count
      }
    }
    return n > 0 ? sum / n : null
  }, [daily])
  const avgSpark = daily?.filter(d => d.avg_rating != null).map(d => d.avg_rating as number)
  const needsEyes = reviews?.filter(r => !r.hidden && r.rating <= 3).length
  const hiddenCount = reviews?.filter(r => r.hidden).length

  const toggleExpand = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Deep-link helpers matching the ops <Link> targets.
  const gotoUser = (id: string) => gotoEntity('users', id)
  const gotoShop = (id: string) => gotoEntity('shops', id)
  // Mechanic detail lives inside the #shops tab, keyed off a stashed goto that
  // TabShops consumes on mount — matches usersUi.openMechanic. stashGoto alone
  // does NOT navigate, so we must also flip the hash to #shops.
  const gotoMechanic = (id: string) => { stashGoto('shops-mechanic', id); window.location.hash = 'shops' }
  const gotoBooking = (id: string) => gotoEntity('bookings', id)

  return (
    <SectionAnchor id="reviews" title="Reviews"
      subtitle="Consumer reviews across the shop network — moderate with a reason, never delete."
      right={
        <SegmentedView value={view}
          onChange={setView}
          options={[
            { value:'needs-eyes', label:'Needs eyes (≤3★)' },
            { value:'all',        label:'All' },
          ]} />
      }>

      {/* Analytics zone — 30d stat cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Reviews · 30d" value={count30d == null ? '—' : fmtNumber(count30d)} />
        <StatCard label="Avg rating · 30d" tone="yellow"
          value={avg30d === undefined ? '—' : avg30d === null ? '—' : `${avg30d.toFixed(1)}★`}
          spark={avgSpark && avgSpark.length > 1 ? avgSpark : undefined} />
        <StatCard label="Needs eyes (≤3★, visible)" tone="yellow"
          value={needsEyes == null ? '—' : fmtNumber(needsEyes)}
          accent={needsEyes != null && needsEyes > 0 ? <Badge tone="yellow">review</Badge> : undefined} />
        <StatCard label="Hidden" tone="slate" value={hiddenCount == null ? '—' : fmtNumber(hiddenCount)} />
      </div>

      {/* Insights: rating distribution + shop/mechanic rollups */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(0,1.4fr)', gap:12, marginBottom:16 }}>
        <Card>
          <SectionTitle label={
            <>
              Rating distribution
              {insights && (
                <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'var(--slate-400)' }}>
                  {insights.total} visible · {insights.avg != null ? `${insights.avg.toFixed(2)}★ avg` : 'no ratings'}
                </span>
              )}
            </>
          } />
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {insights === undefined ? (
              Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} height={16} style={{ borderRadius:4 }} />
              ))
            ) : (
              [...insights.distribution].reverse().map(d => {
                const max = Math.max(1, ...insights.distribution.map(x => x.count))
                const pct = Math.round((d.count / max) * 100)
                const color = d.rating >= 4 ? 'var(--green-500, #10B981)' : d.rating === 3 ? '#F59E0B' : 'var(--red-500, #EF4444)'
                return (
                  <div key={d.rating} style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span className="mono" style={{ width:32, flexShrink:0, fontSize:12, color:'var(--slate-500)' }}>{d.rating}★</span>
                    <div style={{ height:16, flex:1, overflow:'hidden', borderRadius:4, background:'var(--slate-100)' }}>
                      <div style={{ height:'100%', borderRadius:4, width:`${pct}%`, background:color }} />
                    </div>
                    <span className="mono" style={{ width:32, flexShrink:0, textAlign:'right', fontSize:12, color:'var(--slate-600)' }}>{d.count}</span>
                  </div>
                )
              })
            )}
          </div>
        </Card>

        <Card>
          <SectionTitle label="Shop & mechanic rollups (≥2 reviews)" />
          {insights === undefined ? (
            <div style={{ height:96, background:'var(--slate-50)', borderRadius:8 }} className="animate-pulse" />
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div>
                <div style={{ marginBottom:6, fontSize:11, fontWeight:600, color:'var(--green-700)' }}>Top shops</div>
                {insights.topShops.length === 0 ? (
                  <p style={{ fontSize:12, color:'var(--slate-400)', margin:0 }}>Not enough rated shops yet.</p>
                ) : (
                  <ul style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:4 }}>
                    {insights.topShops.map(s => (
                      <li key={s.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, fontSize:12 }}>
                        <LinkText onClick={() => gotoShop(s.id)} style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</LinkText>
                        <span className="mono" style={{ flexShrink:0, color:'var(--slate-500)' }}>{s.avg.toFixed(1)}★ · {s.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {insights.worstShops.length > 0 && insights.worstShops[0].avg < 4 && (
                  <>
                    <div style={{ margin:'12px 0 6px', fontSize:11, fontWeight:600, color:'var(--red-700)' }}>Needs attention</div>
                    <ul style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:4 }}>
                      {insights.worstShops.filter(s => s.avg < 4).map(s => (
                        <li key={s.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, fontSize:12 }}>
                          <LinkText onClick={() => gotoShop(s.id)} style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</LinkText>
                          <span className="mono" style={{ flexShrink:0, color:'var(--red-700)' }}>{s.avg.toFixed(1)}★ · {s.count}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <div>
                <div style={{ marginBottom:6, fontSize:11, fontWeight:600, color:'var(--slate-600)' }}>Top mechanics</div>
                {insights.topMechanics.length === 0 ? (
                  <p style={{ fontSize:12, color:'var(--slate-400)', margin:0 }}>Not enough rated mechanics yet.</p>
                ) : (
                  <ul style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:4 }}>
                    {insights.topMechanics.map(m => (
                      <li key={m.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, fontSize:12 }}>
                        <LinkText onClick={() => gotoMechanic(m.id)} style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</LinkText>
                        <span className="mono" style={{ flexShrink:0, color:'var(--slate-500)' }}>{m.avg.toFixed(1)}★ · {m.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* 30d trend */}
      <Card style={{ marginBottom:16 }}>
        <SectionTitle label="Reviews per day · last 30 days" />
        <DailyBars
          data={daily?.map(d => ({ label: d.date.slice(5), value: d.count }))}
          valueKey="value" labelKey="label" color="#93C5FD" height={150} />
      </Card>

      {/* Review list */}
      {reviews === undefined ? (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ height:64 }} className="animate-pulse">
              <div style={{ height:'100%', background:'var(--slate-100)', borderRadius:10 }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card style={{ textAlign:'center', color:'var(--slate-500)', fontSize:13, padding:32 }}>
          {view === 'needs-eyes'
            ? 'Nothing needs eyes — no ≤3★ or hidden reviews.'
            : 'No reviews on this deployment.'}
        </Card>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {rows.map(r =>
            r.hidden ? (
              /* Hidden strip */
              <div key={r.id}
                style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8, borderRadius:10,
                  border:'1px solid var(--slate-200)', background:'var(--slate-100)', padding:'8px 16px',
                  fontSize:13, color:'var(--slate-500)' }}>
                <Badge tone="slate">hidden</Badge>
                <Stars n={r.rating} />
                {r.user && <LinkText onClick={() => gotoUser(r.user_id)} title="Reviewer" style={{ color:'inherit' }}>{r.user}</LinkText>}
                {r.shop && <LinkText onClick={() => gotoShop(r.shop_id)} title="Shop" style={{ color:'inherit' }}>{r.shop}</LinkText>}
                {r.mechanic && (r.mechanic_id
                  ? <LinkText onClick={() => gotoMechanic(r.mechanic_id!)} title="Mechanic" style={{ color:'inherit' }}>{r.mechanic}</LinkText>
                  : <span title="Mechanic">{r.mechanic}</span>)}
                <span style={{ fontStyle:'italic' }}>— {r.hidden_reason ?? 'no reason recorded'}</span>
                <span style={{ color:'var(--slate-400)' }}>by {r.hidden_by ?? '?'}</span>
                <LinkText onClick={() => gotoBooking(r.booking_id)} style={{ fontSize:12, fontWeight:500, color:'var(--blue-600)' }}>booking →</LinkText>
                {canWrite && (
                  <span style={{ marginLeft:'auto' }}>
                    <Button size="sm" onClick={() => setTarget({ row: r, action: 'restore' })}>Restore</Button>
                  </span>
                )}
              </div>
            ) : (
              <Card key={r.id} style={{ boxShadow:'0 1px 2px rgba(15,23,42,0.04)' }}>
                <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8 }}>
                  <Stars n={r.rating} />
                  {r.user && <LinkPill onClick={() => gotoUser(r.user_id)} title="Reviewer">{r.user}</LinkPill>}
                  {r.shop && <LinkPill onClick={() => gotoShop(r.shop_id)} title="Shop" tone="blue">{r.shop}</LinkPill>}
                  {r.mechanic && (r.mechanic_id
                    ? <LinkPill onClick={() => gotoMechanic(r.mechanic_id!)} title="Mechanic">{r.mechanic}</LinkPill>
                    : <span title="Mechanic"
                        style={{ display:'inline-flex', alignItems:'center', padding:'3px 9px', borderRadius:999, fontSize:12, fontWeight:500, background:'var(--slate-100)', color:'var(--slate-600)' }}>{r.mechanic}</span>)}
                  <LinkText onClick={() => gotoBooking(r.booking_id)} style={{ fontSize:12, fontWeight:500, color:'var(--blue-600)' }}>booking →</LinkText>
                  <span style={{ marginLeft:'auto', fontSize:12, color:'var(--slate-400)' }}>{fmtDate(r.at)}</span>
                  {canWrite && (
                    <Button size="sm" variant="danger" onClick={() => setTarget({ row: r, action: 'hide' })}>Hide</Button>
                  )}
                </div>
                {/* What was reviewed — car + job, joined from the booking. */}
                {(r.vehicleYmm || r.services.length > 0) && (
                  <div style={{ marginTop:6, fontSize:12, color:'var(--slate-500)' }}>
                    {[
                      r.vehicleYmm,
                      r.services.filter(s => s && s !== '—').join(', ') || null,
                    ].filter(Boolean).join(' · ')}
                  </div>
                )}
                {r.comment && (
                  <p onClick={() => toggleExpand(r.id)} title="click to expand"
                    style={{ marginTop:8, marginBottom:0, cursor:'pointer', fontSize:13, color:'var(--slate-600)', lineHeight:1.5,
                      ...(expanded.has(r.id) ? {} : { display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }) }}>
                    {r.comment}
                  </p>
                )}
              </Card>
            ),
          )}
        </div>
      )}

      <ReviewCeremony
        target={target}
        onClose={() => setTarget(null)}
        onConfirm={async (reason) => {
          if (!target) return
          const fn = target.action === 'hide' ? hide : restore
          await fn({ token, reason, id: target.row.id as Id<'reviews'> })
        }} />
    </SectionAnchor>
  )
}
