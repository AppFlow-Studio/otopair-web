'use client'

import { useContext, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge, MicroH, Avatar, tableStyles, IconChevron } from '../../Primitives'
import { money, fmtNumber } from '../../Charts'
import { BookingDetailModal } from '../../BookingDetailModal'
import { Stars } from './shopsUi'
import type { MechanicDetail as MechanicDetailShape } from './types'

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

const VarianceBadge = ({ pct }: { pct: number }) => {
  const abs = Math.abs(pct)
  const tone = abs <= 0.1 ? 'green' : abs <= 0.25 ? 'yellow' : 'red'
  return <Badge tone={tone}>{pct > 0 ? '+' : ''}{Math.round(pct * 100)}%</Badge>
}

const MiniStat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:'12px 14px' }}>
    <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:500 }}>{label}</div>
    <div style={{ fontSize:18, fontWeight:700, color:'var(--slate-900)', marginTop:2 }} className="mono">{value}</div>
    {sub && <div style={{ fontSize:11, color:'var(--slate-400)', marginTop:1 }}>{sub}</div>}
  </div>
)

const BookingChip = ({ id, onOpen }: { id: string; onOpen: () => void }) => (
  <span onClick={onOpen} style={{ display:'inline-flex', padding:'1px 8px', borderRadius:999, background:'var(--blue-50)', color:'var(--blue-700)', fontSize:11, fontWeight:600, cursor:'pointer' }} className="mono">…{id.slice(-6)}</span>
)

export const MechanicDetail = ({ mechanicId, onBack, onOpenShop }:
  { mechanicId: string; onBack: () => void; onOpenShop: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const [drillBooking, setDrillBooking] = useState<Id<'bookings'> | null>(null)
  const detail = useQuery(api.shopsMechanics.detail, { token: session?.token ?? '', mechanicId: mechanicId as Id<'mechanics'> }) as MechanicDetailShape | undefined

  const back = (
    <button onClick={onBack} style={{ display:'inline-flex', alignItems:'center', gap:4, background:'none', border:'none', cursor:'pointer', fontSize:13, color:'var(--slate-500)', padding:0, fontFamily:'inherit' }}>
      <IconChevron size={14} style={{ transform:'rotate(180deg)' }} /> Mechanics
    </button>
  )

  if (detail === undefined) return <div>{back}<div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading mechanic…</div></div>
  if (detail === null) return <div>{back}<Card style={{ marginTop:12 }}><div style={{ color:'var(--red-600)', fontSize:14 }}>That mechanic no longer exists.</div></Card></div>

  const a = detail.aggregates

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {back}

      {/* Header */}
      <Card style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:16 }}>
        <Avatar name={detail.name} size={56} />
        <div style={{ minWidth:0, flex:1 }}>
          <h1 style={{ margin:0, fontSize:20, fontWeight:600, color:'var(--slate-900)' }}>{detail.name}</h1>
          <div style={{ marginTop:6, display:'flex', flexWrap:'wrap', alignItems:'center', gap:8, fontSize:13, color:'var(--slate-500)' }}>
            {detail.title && <span>{detail.title}</span>}
            {detail.email && <a href={`mailto:${detail.email}`} style={{ color:'var(--blue-600)', textDecoration:'none' }}>{detail.email}</a>}
            {detail.shop && <Badge tone="blue" style={{ cursor:'pointer' }}><span onClick={() => onOpenShop(detail.shop_id)}>{detail.shop}</span></Badge>}
            {detail.rating != null && <span>★ {detail.rating.toFixed(1)} ({detail.review_count ?? 0})</span>}
            <Badge tone={detail.active ? 'green' : 'slate'}>{detail.active ? 'active' : 'inactive'}</Badge>
          </div>
        </div>
      </Card>

      {/* Aggregates */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10 }}>
        <MiniStat label="Jobs logged" value={fmtNumber(a.total_jobs)} />
        <MiniStat label="Avg labor" value={a.avg_labor_minutes != null ? `${a.avg_labor_minutes}m` : '—'}
          sub={a.labor_variance_pct != null ? `${a.labor_variance_pct > 0 ? '+' : ''}${Math.round(a.labor_variance_pct * 100)}% vs est` : undefined} />
        <MiniStat label="Parts handled" value={money(a.total_parts_cost)} />
        <MiniStat label="Labor revenue" value={a.labor_revenue != null ? money(a.labor_revenue) : '—'} />
        <MiniStat label="Avg difficulty" value={a.avg_difficulty != null ? `${a.avg_difficulty.toFixed(1)}/5` : '—'} />
        <MiniStat label="Distinct services" value={fmtNumber(a.distinct_services)} />
        <MiniStat label="Distinct customers" value={fmtNumber(a.distinct_customers)} />
        <MiniStat label="Avg review" value={a.avg_review != null ? `★ ${a.avg_review.toFixed(2)}` : '—'} />
        <MiniStat label="Data accuracy" value={a.contribution_accuracy != null ? `${Math.round(a.contribution_accuracy * 100)}%` : '—'} />
      </div>

      {/* Recent jobs */}
      <Card padded={false}>
        <div style={{ padding:'16px 18px 8px' }}><MicroH>Performance — recent jobs</MicroH></div>
        {detail.recent_jobs.length === 0
          ? <div style={{ padding:'0 18px 18px', fontSize:13, color:'var(--slate-500)' }}>No completed jobs recorded.</div>
          : (
            <table style={tableStyles.table}>
              <thead><tr>
                <th style={tableStyles.th}>When</th>
                <th style={tableStyles.th}>Service / Vehicle</th>
                <th style={tableStyles.th}>Labor est→act</th>
                <th style={tableStyles.th}>Parts</th>
                <th style={tableStyles.th}>Diff.</th>
                <th style={tableStyles.th}>Mileage</th>
                <th style={tableStyles.th}>Status</th>
              </tr></thead>
              <tbody>
                {detail.recent_jobs.map(j => {
                  const variance = j.minutes != null && j.est_minutes != null && j.est_minutes > 0 ? (j.minutes - j.est_minutes) / j.est_minutes : null
                  return (
                    <tr key={j.id}>
                      <td style={{ ...tableStyles.td, whiteSpace:'nowrap' }}>
                        <div style={{ color:'var(--slate-500)' }}>{fmtDate(j.at)}</div>
                        <BookingChip id={j.booking_id} onOpen={() => setDrillBooking(j.booking_id as Id<'bookings'>)} />
                      </td>
                      <td style={tableStyles.td}>
                        <div style={{ color:'var(--slate-700)' }}>{j.services.length > 0 ? j.services.join(', ') : '—'}</div>
                        {j.vehicle && <div style={{ fontSize:12, color:'var(--slate-400)' }}>{j.vehicle}</div>}
                        {j.notes && <div style={{ fontSize:12, fontStyle:'italic', color:'var(--slate-400)', maxWidth:260 }}>“{j.notes}”</div>}
                      </td>
                      <td style={{ ...tableStyles.td, whiteSpace:'nowrap' }}>
                        <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                          <span>{j.est_minutes ?? '—'} → {j.minutes != null ? `${j.minutes}m` : '—'}</span>
                          {variance != null && <VarianceBadge pct={variance} />}
                        </span>
                      </td>
                      <td style={{ ...tableStyles.td, color:'var(--slate-700)' }}>{j.parts_cost != null ? money(j.parts_cost) : '—'}{j.parts_count != null && <span style={{ fontSize:11, color:'var(--slate-400)' }}> ({j.parts_count})</span>}</td>
                      <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{j.difficulty != null ? `${j.difficulty}/5` : '—'}</td>
                      <td style={{ ...tableStyles.td, color:'var(--slate-600)', whiteSpace:'nowrap' }}>{j.mileage_in != null || j.mileage_out != null ? `${j.mileage_in != null ? fmtNumber(j.mileage_in) : '—'} → ${j.mileage_out != null ? fmtNumber(j.mileage_out) : '—'}` : '—'}</td>
                      <td style={tableStyles.td}>{j.status && <Badge tone={['completed','active'].includes(j.status) ? 'green' : ['cancelled','no_show','declined'].includes(j.status) ? 'red' : 'yellow'}>{j.status}</Badge>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
      </Card>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        {/* Reviews */}
        <Card>
          <MicroH style={{ marginBottom:10 }}>Reviews</MicroH>
          {detail.reviews.length === 0
            ? <div style={{ fontSize:13, color:'var(--slate-500)' }}>No reviews yet.</div>
            : (
              <div style={{ display:'flex', flexDirection:'column', gap:8, maxHeight:360, overflow:'auto' }}>
                {detail.reviews.map(r => (
                  <div key={r.id} style={{ border:'1px solid var(--slate-100)', borderRadius:8, padding:'8px 10px', opacity: r.hidden ? 0.5 : 1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <Stars rating={r.rating} />
                      {r.reviewer && <span style={{ fontSize:12, fontWeight:500, color:'var(--slate-600)' }}>{r.reviewer}</span>}
                      {r.hidden && <Badge tone="slate">hidden</Badge>}
                      <span style={{ marginLeft:'auto', fontSize:11, color:'var(--slate-400)' }}>{fmtDate(r.at)}</span>
                    </div>
                    {(r.vehicle.ymm || r.service_names.length > 0) && (
                      <div style={{ marginTop:2, display:'flex', flexWrap:'wrap', alignItems:'center', gap:6, fontSize:12, color:'var(--slate-500)' }}>
                        {r.vehicle.ymm && <span>{r.vehicle.ymm}</span>}
                        {r.service_names.length > 0 && <span style={{ color:'var(--slate-400)' }}>· {r.service_names.join(', ')}</span>}
                        <BookingChip id={r.booking_id} onOpen={() => setDrillBooking(r.booking_id as Id<'bookings'>)} />
                      </div>
                    )}
                    {r.comment && <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--slate-600)' }}>{r.comment}</p>}
                  </div>
                ))}
              </div>
            )}
        </Card>

        {/* Week strip */}
        <Card>
          <MicroH>This week</MicroH>
          <div style={{ fontSize:11, color:'var(--slate-400)', marginTop:2 }}>Open windows derived from shop hours minus bookings &amp; blocks.</div>
          <div style={{ marginTop:12, display:'flex', gap:8 }}>
            {detail.week_slots.map(d => (
              <div key={d.date} style={{ flex:1, borderRadius:8, border:'1px solid var(--slate-100)', padding:8, textAlign:'center' }}>
                <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-400)' }}>{d.date.slice(5)}</div>
                <div style={{ fontSize:15, fontWeight:700, color:'var(--green-700)', marginTop:2 }}>{d.available}</div>
                <div style={{ fontSize:10, color:'var(--slate-400)' }}>open</div>
                <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-600)', marginTop:2 }}>{d.booked} booked</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Data contributions */}
      <Card padded={false}>
        <div style={{ padding:'16px 18px 8px', display:'flex', alignItems:'center', gap:8 }}>
          <MicroH>Data contributions</MicroH><Badge tone="green">the moat</Badge>
        </div>
        {detail.contributions.length === 0
          ? <div style={{ padding:'0 18px 18px', fontSize:13, color:'var(--slate-500)' }}>No verification submissions yet.</div>
          : (
            <table style={tableStyles.table}>
              <thead><tr>
                <th style={tableStyles.th}>Status</th>
                <th style={tableStyles.th}>Service</th>
                <th style={tableStyles.th}>Labor hrs</th>
                <th style={tableStyles.th}>Parts ok</th>
                <th style={{ ...tableStyles.th, textAlign:'right' }}>Fields</th>
                <th style={{ ...tableStyles.th, textAlign:'right' }}>Decisions</th>
                <th style={{ ...tableStyles.th, textAlign:'right' }}>Accuracy</th>
                <th style={tableStyles.th}>Reviewer</th>
                <th style={tableStyles.th}>When</th>
              </tr></thead>
              <tbody>
                {detail.contributions.map(c => (
                  <tr key={c.id}>
                    <td style={tableStyles.td}><Badge tone={c.status === 'accepted' ? 'green' : c.status === 'rejected' ? 'red' : 'yellow'}>{c.status ?? 'pending'}</Badge></td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-700)' }}>{c.service ?? '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{c.labor_hours != null ? `${c.labor_hours}h` : '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{c.parts_correct == null ? '—' : c.parts_correct ? '✓' : '✗'}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-600)' }}>{c.fields}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-600)' }}>{c.decisions}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-600)' }}>{c.accuracy != null ? `${Math.round(c.accuracy * 100)}%` : '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-500)' }}>{c.reviewer ?? '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-400)' }}>{fmtDate(c.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      <BookingDetailModal bookingId={drillBooking} onClose={() => setDrillBooking(null)} />
    </div>
  )
}
