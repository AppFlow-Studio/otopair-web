'use client'

import { useContext, useEffect, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Input, Select } from '../../Primitives'
import { Toast } from '../../AdminActionPanel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { FallbackHistoryModal } from './FallbackHistoryModal'

type BaselineRow = {
  id: Id<'pricing_baselines'>
  service_id: Id<'services'>
  service_name: string
  service_slug: string | null
  base_price_low_cents: number
  base_price_high_cents: number
  is_real_data: boolean
  data_source: string
  last_validated_at: number | null
  notes: string | null
  updated_at: number
}

const SOURCE_OPTIONS = [
  { value: 'enrichment', label: 'Enrichment' },
  { value: 'bookings',   label: 'Bookings' },
  { value: 'modeled',    label: 'Modeled' },
  { value: 'manual',     label: 'Manual' },
]

const fmtMoney = (cents: number) =>
  `$${(cents / 100).toFixed(2)}`

const fmtDate = (ts?: number | null) =>
  ts ? new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—'

export const BaselinesTable = () => {
  const baselines = useQuery(api.directorPricing.baselinesList) as BaselineRow[] | undefined
  const update    = useMutation(api.directorPricing.updateBaseline)
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const [q,       setQ]       = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [toast,   setToast]   = useState<string | null>(null)
  const [historyFor, setHistoryFor] = useState<BaselineRow | null>(null)

  // Local edit buffer
  const [low,    setLow]    = useState('')
  const [high,   setHigh]   = useState('')
  const [source, setSource] = useState('manual')
  const [real,   setReal]   = useState(false)
  const [notes,  setNotes]  = useState('')

  const startEdit = (r: BaselineRow) => {
    setEditing(String(r.id))
    setLow(String((r.base_price_low_cents / 100).toFixed(2)))
    setHigh(String((r.base_price_high_cents / 100).toFixed(2)))
    setSource(r.data_source)
    setReal(r.is_real_data)
    setNotes(r.notes ?? '')
  }

  const cancelEdit = () => {
    setEditing(null)
    setLow(''); setHigh(''); setSource('manual'); setReal(false); setNotes('')
  }

  const saveEdit = async (r: BaselineRow) => {
    const lowCents  = Math.round(parseFloat(low)  * 100)
    const highCents = Math.round(parseFloat(high) * 100)
    if (Number.isNaN(lowCents) || Number.isNaN(highCents)) return
    if (highCents < lowCents) {
      setToast('High must be ≥ low')
      return
    }
    const res = await update({
      id: r.id,
      base_price_low_cents:  lowCents !== r.base_price_low_cents  ? lowCents  : undefined,
      base_price_high_cents: highCents !== r.base_price_high_cents ? highCents : undefined,
      is_real_data:          real !== r.is_real_data ? real : undefined,
      data_source:           source !== r.data_source ? source : undefined,
      notes:                 notes !== (r.notes ?? '') ? notes : undefined,
      actorName, actorId,
    })
    if (res.ok) {
      setToast(res.changes ? `Baseline updated for ${r.service_name}` : 'No changes')
      cancelEdit()
    }
  }

  const filtered = (baselines ?? []).filter(b =>
    !q || b.service_name.toLowerCase().includes(q.toLowerCase()) ||
    (b.service_slug ?? '').toLowerCase().includes(q.toLowerCase())
  )

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff',
        border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12 }}>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search services…" style={{ width:340 }} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {baselines === undefined ? 'Loading…' : `${filtered.length} of ${baselines.length} baselines`}
        </span>
      </div>

      <Card padded={false}>
        <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0 }}>
          <thead>
            <tr>
              <th style={th}>Service</th>
              <th style={{ ...th, textAlign:'right' }}>Low (Camry)</th>
              <th style={{ ...th, textAlign:'right' }}>High (Camry)</th>
              <th style={th}>Source</th>
              <th style={th}>Real?</th>
              <th style={th}>Last validated</th>
              <th style={{ ...th, textAlign:'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {baselines === undefined ? (
              <tr><td colSpan={7} style={{ ...td, textAlign:'center', color:'var(--slate-400)', padding:24 }}>Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, textAlign:'center', color:'var(--slate-400)', padding:24 }}>No baselines found.</td></tr>
            ) : filtered.map(r => {
              const isEdit = editing === String(r.id)
              return (
                <tr key={String(r.id)}>
                  <td style={td}>
                    <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{r.service_name}</div>
                    {r.service_slug && (
                      <div className="mono" style={{ fontSize:10, color:'var(--slate-400)' }}>{r.service_slug}</div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign:'right' }}>
                    {isEdit ? (
                      <Input value={low} onChange={e => setLow(e.target.value)} type="number" style={{ width:90 }} />
                    ) : (
                      <span className="mono">{fmtMoney(r.base_price_low_cents)}</span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign:'right' }}>
                    {isEdit ? (
                      <Input value={high} onChange={e => setHigh(e.target.value)} type="number" style={{ width:90 }} />
                    ) : (
                      <span className="mono">{fmtMoney(r.base_price_high_cents)}</span>
                    )}
                  </td>
                  <td style={td}>
                    {isEdit ? (
                      <Select value={source} onChange={e => setSource(e.target.value)} options={SOURCE_OPTIONS} />
                    ) : (
                      <Badge tone={r.data_source === 'bookings' ? 'green' : r.data_source === 'manual' ? 'purple' : 'slate'}>{r.data_source}</Badge>
                    )}
                  </td>
                  <td style={td}>
                    {isEdit ? (
                      <label style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, cursor:'pointer' }}>
                        <input type="checkbox" checked={real} onChange={e => setReal(e.target.checked)} />
                        Real data
                      </label>
                    ) : (
                      r.is_real_data
                        ? <Badge tone="green" dot>real</Badge>
                        : <Badge tone="yellow" dot>estimate</Badge>
                    )}
                  </td>
                  <td style={{ ...td, color:'var(--slate-600)', fontSize:12 }}>{fmtDate(r.last_validated_at)}</td>
                  <td style={{ ...td, textAlign:'right' }}>
                    {isEdit ? (
                      <div style={{ display:'inline-flex', gap:6 }}>
                        <Button size="sm" onClick={cancelEdit}>Cancel</Button>
                        <Button size="sm" variant="primary" onClick={() => saveEdit(r)}>Save</Button>
                      </div>
                    ) : (
                      <div style={{ display:'inline-flex', gap:6 }}>
                        <Button size="sm" onClick={() => setHistoryFor(r)}>History</Button>
                        <Button size="sm" onClick={() => startEdit(r)}>Edit</Button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
      <Toast msg={toast} onDismiss={() => setToast(null)} />
      {historyFor && (
        <FallbackHistoryModal
          entityType="baseline"
          entityId={String(historyFor.id)}
          title={`History · ${historyFor.service_name}`}
          subtitle={`Current: ${fmtMoney(historyFor.base_price_low_cents)} – ${fmtMoney(historyFor.base_price_high_cents)} · ${historyFor.data_source}${historyFor.is_real_data ? ' · real' : ' · estimate'}`}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </>
  )
}

const th: React.CSSProperties = {
  fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase' as const, letterSpacing:'0.04em',
  textAlign:'left' as const, padding:'10px 16px', borderBottom:'1px solid var(--slate-200)',
  background:'var(--slate-25)', whiteSpace:'nowrap' as const,
}
const td: React.CSSProperties = {
  fontSize:13, color:'var(--slate-800)', padding:'10px 16px', borderBottom:'1px solid var(--slate-100)',
  verticalAlign:'middle' as const,
}
