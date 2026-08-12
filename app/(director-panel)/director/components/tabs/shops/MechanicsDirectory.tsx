'use client'

import { useContext, useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge, MicroH, Avatar, tableStyles } from '../../Primitives'
import { StatCard, BarRow, fmtNumber } from '../../Charts'
import type { MechanicDirRow } from './types'

// Mechanics directory — /shops/mechanics ported: tiles + rating distribution +
// table sorted by the "data contributions" moat column. Rows open the mechanic
// detail; the shop chip opens the shop detail.

export const MechanicsDirectory = ({ onOpenMechanic, onOpenShop }:
  { onOpenMechanic: (id: string) => void; onOpenShop: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const rows = useQuery(api.shopsMechanics.directory, { token: session?.token ?? '' }) as MechanicDirRow[] | undefined

  const activeCount = rows?.filter(m => m.active).length
  const rated = rows?.filter(m => m.rating != null) ?? []
  const avgRating = rows === undefined ? undefined : rated.length > 0 ? rated.reduce((s, m) => s + (m.rating ?? 0), 0) / rated.length : null
  const totalContributions = rows?.reduce((s, m) => s + m.contributions, 0)

  const ratingDist = useMemo(() => {
    if (!rows) return undefined
    const buckets = [5, 4, 3, 2, 1].map(star => ({
      label: '★'.repeat(star),
      value: rows.filter(m => m.rating != null && Math.round(m.rating) === star).length,
    }))
    const unrated = rows.filter(m => m.rating == null).length
    if (unrated > 0) buckets.push({ label: 'unrated', value: unrated })
    return buckets
  }, [rows])
  const distMax = ratingDist ? Math.max(...ratingDist.map(b => b.value), 1) : 1

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
        <StatCard label="Mechanics" value={rows === undefined ? '—' : fmtNumber(rows.length)} />
        <StatCard label="Active" value={activeCount === undefined ? '—' : fmtNumber(activeCount)} tone="green" />
        <StatCard label="Avg rating" value={avgRating === undefined ? '—' : avgRating === null ? '—' : `★ ${avgRating.toFixed(2)}`} tone="yellow" />
        <StatCard label="Data contributions" value={totalContributions === undefined ? '—' : fmtNumber(totalContributions)}
          accent={<Badge tone="green">the moat</Badge>} tone="green" />
      </div>

      <Card>
        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:10 }}>
          <MicroH>Rating distribution</MicroH>
          <span style={{ fontSize:11, color:'var(--slate-400)' }}>mechanics by rounded star rating</span>
        </div>
        {ratingDist === undefined
          ? <div style={{ height:80, background:'var(--slate-50)', borderRadius:8 }} className="animate-pulse" />
          : ratingDist.every(b => b.value === 0)
            ? <div style={{ fontSize:13, color:'var(--slate-500)' }}>No mechanics to distribute yet.</div>
            : ratingDist.map(b => <BarRow key={b.label} label={b.label} value={b.value} max={distMax} valueLabel={b.value} color="#FBBF24" />)}
      </Card>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Mechanic</th>
            <th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>Rating</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Jobs</th>
            <th style={tableStyles.th}>Contributions</th>
            <th style={tableStyles.th}>Next slot</th>
          </tr></thead>
          <tbody>
            {rows === undefined
              ? <tr><td colSpan={6} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : rows.length === 0
                ? <tr><td colSpan={6} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No mechanics on this deployment.</td></tr>
                : rows.map(m => (
                  <tr key={m.id} onClick={() => onOpenMechanic(m.id)} style={{ cursor:'pointer', opacity: m.active ? 1 : 0.55 }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={tableStyles.td}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <Avatar name={m.name} size={30} />
                        <div>
                          <div style={{ fontWeight:500, color:'var(--slate-900)' }}>
                            {m.name}{m.title && <span style={{ marginLeft:6, fontSize:12, color:'var(--slate-400)', fontWeight:400 }}>{m.title}</span>}
                            {!m.active && <Badge tone="slate" style={{ marginLeft:6 }}>inactive</Badge>}
                          </div>
                          {m.email && <div style={{ fontSize:11, color:'var(--slate-400)' }}>{m.email}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={tableStyles.td} onClick={e => e.stopPropagation()}>
                      {m.shop
                        ? <Badge tone="blue" style={{ cursor:'pointer' }}><span onClick={() => onOpenShop(m.shop_id)}>{m.shop}</span></Badge>
                        : <span style={{ color:'var(--slate-400)' }}>—</span>}
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{m.rating != null ? `★ ${m.rating.toFixed(1)} (${m.review_count ?? 0})` : '—'}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{m.jobs}{m.jobs_capped ? '+' : ''}</td>
                    <td style={tableStyles.td}>
                      <Badge tone={m.contributions > 0 ? 'green' : 'slate'}>{m.contributions} verifications</Badge>
                    </td>
                    <td style={{ ...tableStyles.td, fontSize:12 }}>
                      {m.next_slot ? <span className="mono" style={{ color:'var(--slate-600)' }}>{m.next_slot}</span> : <span style={{ color:'var(--slate-300)' }}>no availability</span>}
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
