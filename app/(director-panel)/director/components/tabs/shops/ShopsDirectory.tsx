'use client'

import { useContext, useMemo, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Input, Select, Toggle, tableStyles, IconSearch, IconShop } from '../../Primitives'
import { StatCard, money, fmtNumber } from '../../Charts'
import { HealthDot, BoolMark } from './shopsUi'
import type { DirectoryRow } from './types'

// Directory — /shops/all ported: 4 stat tiles + one row per shop with the
// server-computed health check, 30d bookings/revenue (client-joined from
// portalSeries), $/hr, rating, mechanics. Row click opens the shop detail.

export const ShopsDirectory = ({ onOpenShop }: { onOpenShop: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [stripeMissingOnly, setStripeMissingOnly] = useState(false)

  const rows = useQuery(api.shopsDirectory.directoryList, { token }) as DirectoryRow[] | undefined
  const stats30 = useQuery(api.portalSeries.bookingsByShop, { token, days: 30 }) as
    | Record<string, { bookings: number; revenue: number }>
    | undefined

  const activeCount = rows?.filter(r => r.isActive).length
  const healthyCount = rows?.filter(r => r.health === 'green').length
  const rated = rows?.filter(r => r.rating !== null) ?? []
  const avgRating = rows === undefined
    ? undefined
    : rated.length > 0 ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length : null

  const filtered = useMemo(() => (rows ?? []).filter(r => {
    if (q && !`${r.name} ${r.city} ${r.zip}`.toLowerCase().includes(q.toLowerCase())) return false
    if (status === 'active' && !r.isActive) return false
    if (status === 'inactive' && r.isActive) return false
    if (status === 'unverified' && r.isVerified) return false
    if (stripeMissingOnly && r.health === 'green') return false
    return true
  }), [rows, q, status, stripeMissingOnly])

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:14 }}>
        <StatCard label="Shops" value={rows === undefined ? '—' : fmtNumber(rows.length)} />
        <StatCard label="Active" value={activeCount === undefined ? '—' : fmtNumber(activeCount)} tone="green" />
        <StatCard label="All checks passing"
          value={healthyCount === undefined || rows === undefined ? '—' : `${fmtNumber(healthyCount)} / ${fmtNumber(rows.length)}`} />
        <StatCard label="Avg rating"
          value={avgRating === undefined ? '—' : avgRating === null ? '—' : `★ ${avgRating.toFixed(2)}`} tone="yellow" />
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, city, ZIP…" style={{ width:280 }} />
        <Select value={status} onChange={e => setStatus(e.target.value)}
          options={[{ value:'all', label:'All statuses' },{ value:'active', label:'Active' },{ value:'inactive', label:'Inactive' },{ value:'unverified', label:'Unverified' }]} />
        <span style={{ width:1, height:22, background:'var(--slate-200)', margin:'0 4px' }} />
        <Toggle checked={stripeMissingOnly} onChange={e => setStripeMissingOnly(e.target.checked)} label="Failing a check only" />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {rows === undefined ? 'Loading…' : `Showing ${filtered.length} of ${rows.length} shops`}
        </span>
      </div>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>City / ZIP</th>
            <th style={tableStyles.th}>Contact</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>$/hr</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Rating</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Mechanics</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Bookings 30d</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Revenue 30d</th>
            <th style={{ ...tableStyles.th, textAlign:'center' }}>Active</th>
            <th style={{ ...tableStyles.th, textAlign:'center' }}>Verified</th>
          </tr></thead>
          <tbody>
            {rows === undefined
              ? <tr><td colSpan={10} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={10} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No shops found.</td></tr>
                : filtered.map(r => {
                  const s30 = stats30?.[r.id]
                  return (
                    <tr key={r.id} onClick={() => onOpenShop(r.id)} style={{ cursor:'pointer' }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                      <td style={tableStyles.td}>
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <span style={{ width:30, height:30, borderRadius:6, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)', flexShrink:0 }}><IconShop size={16} /></span>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <HealthDot health={r.health} failingChecks={r.failingChecks} />
                            <span style={{ fontWeight:500, color:'var(--slate-900)' }}>{r.name}</span>
                          </div>
                        </div>
                      </td>
                      <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>
                        {r.city}{r.zip !== '—' && <span style={{ color:'var(--slate-400)' }}> · {r.zip}</span>}
                        {!r.hasCoords && <span title="No coordinates — missing from the network map" style={{ marginLeft:6, fontSize:11, color:'var(--amber-600, #D97706)' }}>⚑ no pin</span>}
                      </td>
                      <td style={{ ...tableStyles.td, fontSize:12 }} onClick={e => e.stopPropagation()}>
                        {r.phone
                          ? <a href={`tel:${r.phone}`} style={{ color:'var(--blue-600)', textDecoration:'none' }}>{r.phone}</a>
                          : <span style={{ color:'var(--slate-300)' }}>no phone</span>}
                        {r.address && <div title={r.address} style={{ maxWidth:180, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', color:'var(--slate-400)' }}>{r.address}</div>}
                      </td>
                      <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-700)' }}>
                        {r.laborRate !== null ? `$${r.laborRate}` : <span style={{ color:'var(--slate-300)' }}>not set</span>}
                      </td>
                      <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-700)' }}>
                        {r.rating !== null ? <>{r.rating.toFixed(1)} <span style={{ fontSize:11, color:'var(--slate-400)' }}>({r.reviewCount})</span></> : <span style={{ color:'var(--slate-300)' }}>—</span>}
                      </td>
                      <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{r.mechanics}</td>
                      <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">
                        {stats30 === undefined ? '…' : s30 ? fmtNumber(s30.bookings) : <span style={{ color:'var(--slate-400)' }}>0</span>}
                      </td>
                      <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">
                        {stats30 === undefined ? '…' : s30 && s30.revenue > 0 ? money(s30.revenue) : <span style={{ color:'var(--slate-400)' }}>$0</span>}
                      </td>
                      <td style={{ ...tableStyles.td, textAlign:'center' }}><BoolMark on={r.isActive} /></td>
                      <td style={{ ...tableStyles.td, textAlign:'center' }}><BoolMark on={r.isVerified} /></td>
                    </tr>
                  )
                })
            }
          </tbody>
        </table>
      </Card>
    </div>
  )
}
