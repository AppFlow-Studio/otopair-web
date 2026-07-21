'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Badge } from '../../Primitives'
import { LoadingBlock } from './shopsUi'
import type { CapacityResult } from '@/convex/shopsCapacity'

// 14-day capacity heatmap: shops × days. Each cell = available / total slots.
// Integrity issues (double-booked mechanics) listed below.

const DAY_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function cellColor(available: number, total: number): string {
  if (total === 0) return 'var(--slate-100)'
  const ratio = available / total
  if (ratio >= 0.6) return '#D1FAE5'   // green-100
  if (ratio >= 0.3) return '#FEF3C7'   // amber-100
  return '#FEE2E2'                      // red-100
}

function cellFg(available: number, total: number): string {
  if (total === 0) return 'var(--slate-400)'
  const ratio = available / total
  if (ratio >= 0.6) return 'var(--green-700)'
  if (ratio >= 0.3) return 'var(--yellow-800)'
  return 'var(--red-700)'
}

function dateLbl(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return `${DAY_ABBR[d.getDay()]} ${iso.slice(5)}`
}

export const CapacityHeatmap = () => {
  const session = useContext(DirectorSessionCtx)
  const data = useQuery(api.shopsCapacity.overview, { token: session?.token ?? '' }) as CapacityResult | undefined

  if (data === undefined) return <LoadingBlock label="capacity heatmap" />

  const { rows, dates, integrity } = data

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* ── heatmap grid ── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 600 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 12px 6px 0', fontWeight: 600, color: 'var(--slate-700)', minWidth: 140, whiteSpace: 'nowrap' }}>
                Shop
              </th>
              {dates.map(d => (
                <th key={d} style={{ padding: '6px 4px', fontWeight: 500, color: 'var(--slate-500)', whiteSpace: 'nowrap', minWidth: 56, textAlign: 'center' }}>
                  {dateLbl(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.shop_id}>
                <td style={{ padding: '4px 12px 4px 0', fontWeight: 500, color: 'var(--slate-800)', whiteSpace: 'nowrap' }}>
                  {row.shop}
                </td>
                {row.cells.map(cell => (
                  <td key={cell.date}
                    title={`${cell.date} — ${cell.available} available, ${cell.booked} booked, ${cell.total} total`}
                    style={{ padding: 3, textAlign: 'center' }}>
                    <div style={{
                      borderRadius: 6, padding: '5px 4px',
                      background: cellColor(cell.available, cell.total),
                      color: cellFg(cell.available, cell.total),
                      fontWeight: 600, lineHeight: 1, fontSize: 11,
                    }}>
                      {cell.total === 0
                        ? <span style={{ color: 'var(--slate-300)' }}>—</span>
                        : <>{cell.available}<span style={{ fontWeight: 400, opacity: 0.7 }}>/{cell.total}</span></>
                      }
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── legend ── */}
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--slate-500)' }}>
        <span>Cell = <strong>available / total</strong> 15-min windows.</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 14, height: 14, borderRadius: 3, background: '#D1FAE5', display: 'inline-block' }} />≥60% free
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 14, height: 14, borderRadius: 3, background: '#FEF3C7', display: 'inline-block' }} />30–59%
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 14, height: 14, borderRadius: 3, background: '#FEE2E2', display: 'inline-block' }} />&lt;30%
        </span>
      </div>

      {/* ── integrity issues ── */}
      {integrity.length === 0 ? (
        <div style={{ borderRadius: 10, background: 'var(--green-50)', border: '1px solid #A7F3D0', padding: '16px 20px', fontSize: 13, color: 'var(--green-700)' }}>
          No double-booking conflicts detected across the 14-day window.
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red-700)', marginBottom: 10 }}>
            {integrity.length} double-booking conflict{integrity.length !== 1 ? 's' : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {integrity.map((iss, i) => (
              <div key={i} style={{ borderRadius: 8, border: '1px solid #FECACA', background: 'var(--red-50)', padding: '10px 14px', fontSize: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <Badge tone="red">Double-booked</Badge>
                  <span style={{ fontWeight: 500, color: 'var(--slate-800)' }}>{iss.shop}</span>
                  <span style={{ color: 'var(--slate-400)' }}>{iss.date}</span>
                </div>
                <div style={{ color: 'var(--slate-600)' }}>{iss.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
