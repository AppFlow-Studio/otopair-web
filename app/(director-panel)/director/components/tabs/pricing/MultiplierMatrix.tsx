'use client'

import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, IconClock } from '../../Primitives'

export type MatrixColumn = { id: string; code: string; name: string }
export type MatrixRow = { code: string; name?: string }

export type MatrixCell = {
  id: string
  rowCode: string         // tier code (T1, T2a, …)
  colId: string           // category id
  multiplier: number
  isLocked?: boolean
  source?: string
  notes?: string | null
}

export type MatrixEditPayload = {
  cellId: string
  rowCode: string
  colId: string
  multiplier?: number
  is_locked?: boolean
  source?: string
}

export const MultiplierMatrix = ({
  title,
  subtitle,
  rows,
  columns,
  cells,
  supportsLock,
  onSave,
  onShowHistory,
}: {
  title: string
  subtitle?: string
  rows: MatrixRow[]
  columns: MatrixColumn[]
  cells: MatrixCell[]
  supportsLock?: boolean
  onSave: (payload: MatrixEditPayload) => Promise<void> | void
  /** When provided, each cell renders a clock-icon button that opens the
   *  history modal for that cell's underlying multiplier row. Omit for
   *  matrices without snapshot capture (e.g. v1). */
  onShowHistory?: (cell: MatrixCell) => void
}) => {
  const lookup = useMemo(() => {
    const m = new Map<string, MatrixCell>()
    for (const c of cells) m.set(`${c.rowCode}::${c.colId}`, c)
    return m
  }, [cells])

  // Local edit buffer: cellId → string
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    // Reset drafts whenever cells change identity (after save round-trip).
    setDraft({})
  }, [cells])

  const range = useMemo(() => {
    if (cells.length === 0) return { min: 1, max: 1 }
    let min = Infinity, max = -Infinity
    for (const c of cells) {
      if (c.multiplier < min) min = c.multiplier
      if (c.multiplier > max) max = c.multiplier
    }
    return { min, max }
  }, [cells])

  const heatColor = (val: number) => {
    if (range.max === range.min) return 'rgba(59,130,246,0.06)'
    const t = (val - range.min) / (range.max - range.min)
    // light blue → orange-red
    const r = Math.round(59  + (239 - 59)  * t)
    const g = Math.round(130 + (68  - 130) * t)
    const b = Math.round(246 + (68  - 246) * t)
    const a = 0.08 + 0.20 * t
    return `rgba(${r},${g},${b},${a})`
  }

  const submitCell = async (cell: MatrixCell, value: number) => {
    if (Number.isNaN(value)) return
    if (value === cell.multiplier) return
    setSaving(cell.id)
    try {
      await onSave({
        cellId: cell.id,
        rowCode: cell.rowCode,
        colId: cell.colId,
        multiplier: value,
      })
    } finally {
      setSaving(null)
    }
  }

  const toggleLock = async (cell: MatrixCell) => {
    if (!supportsLock) return
    setSaving(cell.id)
    try {
      await onSave({
        cellId: cell.id,
        rowCode: cell.rowCode,
        colId: cell.colId,
        is_locked: !cell.isLocked,
      })
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card padded={false} style={{ overflow:'hidden' }}>
      <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--slate-200)', background:'var(--slate-25)' }}>
        <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>{title}</div>
        {subtitle && <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:2 }}>{subtitle}</div>}
        <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:6 }}>
          Type a new multiplier and press <kbd style={{ fontFamily:'inherit', background:'var(--slate-100)', padding:'1px 4px', borderRadius:3 }}>Enter</kbd> to save. Tab moves to the next cell.
        </div>
      </div>

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0 }}>
          <thead>
            <tr>
              <th style={thStyle}>Tier</th>
              {columns.map(c => (
                <th key={c.id} style={thStyle}>
                  <div style={{ fontSize:11, color:'var(--slate-700)' }}>{c.name}</div>
                  <div className="mono" style={{ fontSize:10, color:'var(--slate-400)', marginTop:2 }}>{c.code}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.code}>
                <td style={{ ...tdStyle, fontWeight:600 }}>
                  <div className="mono" style={{ fontSize:12, color:'var(--slate-900)' }}>{row.code}</div>
                  {row.name && <div style={{ fontSize:10, color:'var(--slate-500)' }}>{row.name}</div>}
                </td>
                {columns.map(col => {
                  const cell = lookup.get(`${row.code}::${col.id}`)
                  if (!cell) {
                    return <td key={col.id} style={{ ...tdStyle, color:'var(--slate-300)' }}>—</td>
                  }
                  const currentDraft = draft[cell.id]
                  const value = currentDraft ?? cell.multiplier.toFixed(2)
                  const isSaving = saving === cell.id
                  return (
                    <td key={col.id} style={{ ...tdStyle, background: heatColor(cell.multiplier), padding:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:4, padding:'4px 6px' }}>
                        <input
                          value={value}
                          onChange={e => setDraft(d => ({ ...d, [cell.id]: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              const num = parseFloat((e.target as HTMLInputElement).value)
                              submitCell(cell, num)
                            } else if (e.key === 'Escape') {
                              setDraft(d => { const { [cell.id]: _, ...rest } = d; return rest })
                            }
                          }}
                          onBlur={e => {
                            const num = parseFloat(e.target.value)
                            submitCell(cell, num)
                          }}
                          disabled={isSaving}
                          style={{
                            width:64, border:'1px solid var(--slate-200)', borderRadius:6,
                            padding:'4px 6px', fontSize:12, fontFamily:'var(--font-mono, ui-monospace)',
                            background:'#fff', textAlign:'right', outline:'none',
                            opacity:isSaving ? 0.5 : 1,
                          }} />
                        {supportsLock && (
                          <button onClick={() => toggleLock(cell)}
                            title={cell.isLocked ? 'Unlock' : 'Lock'}
                            style={{ border:'none', background:'transparent', cursor:'pointer', fontSize:11, padding:0, color: cell.isLocked ? 'var(--blue-700)' : 'var(--slate-400)' }}>
                            {cell.isLocked ? '🔒' : '🔓'}
                          </button>
                        )}
                        {onShowHistory && (
                          <button onClick={() => onShowHistory(cell)}
                            title="View history"
                            style={{ border:'none', background:'transparent', cursor:'pointer', padding:0,
                              color:'var(--slate-400)', display:'inline-flex' }}>
                            <IconClock size={12} />
                          </button>
                        )}
                      </div>
                      {cell.source && (
                        <div style={{ fontSize:9, color:'var(--slate-500)', padding:'0 6px 4px', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                          {cell.source}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

const thStyle: React.CSSProperties = {
  fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase' as const, letterSpacing:'0.04em',
  textAlign:'left' as const, padding:'10px 12px', borderBottom:'1px solid var(--slate-200)',
  background:'var(--slate-25)', whiteSpace:'nowrap' as const,
}

const tdStyle: React.CSSProperties = {
  fontSize:13, color:'var(--slate-800)', padding:'8px 12px', borderBottom:'1px solid var(--slate-100)',
  verticalAlign:'middle' as const, minWidth:90,
}
