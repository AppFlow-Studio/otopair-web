'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Badge } from '../../Primitives'
import { LoadingBlock } from './shopsUi'
import type { CalibrationService } from '@/convex/shopsPerformance'

// Labor variance calibration — median predicted-vs-actual per service.
// Data lives in spec_variances (0 rows live today; empty state is honest).

type CalibrationResult = { services: CalibrationService[]; samples: number }

function varianceColor(pct: number): string {
  const abs = Math.abs(pct)
  if (abs > 10) return 'var(--red-600)'
  if (abs > 5) return 'var(--yellow-700)'
  return 'var(--green-600)'
}

function fmtPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

export const PerformanceCalibration = () => {
  const session = useContext(DirectorSessionCtx)
  const data = useQuery(api.shopsPerformance.calibration, { token: session?.token ?? '' }) as CalibrationResult | undefined

  if (data === undefined) return <LoadingBlock label="performance data" />

  const { services, samples } = data

  if (samples === 0 || services.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ borderRadius: 10, background: 'var(--slate-50)', border: '1px solid var(--slate-200)', padding: '32px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--slate-700)', marginBottom: 6 }}>No calibration data yet</div>
          <div style={{ fontSize: 13, color: 'var(--slate-500)', maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>
            Labor variance is computed from <code>spec_variances</code> — predicted vs. actual hours per completed job. This table populates once post-job surveys are flowing.
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>
          Systematically wrong = |median| &gt; 10% at n ≥ 3. Powered by <code>api.shopsPerformance.calibration</code>.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ fontSize: 13, color: 'var(--slate-500)' }}>
        {samples} sample{samples !== 1 ? 's' : ''} from <code>spec_variances</code> — sorted by absolute median variance.
      </div>

      <div style={{ border: '1px solid var(--slate-200)', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--slate-50)', borderBottom: '1px solid var(--slate-200)' }}>
              <th style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 600, color: 'var(--slate-600)' }}>Service</th>
              <th style={{ textAlign: 'right', padding: '10px 14px', fontWeight: 600, color: 'var(--slate-600)', width: 60 }}>n</th>
              <th style={{ textAlign: 'right', padding: '10px 14px', fontWeight: 600, color: 'var(--slate-600)', width: 110 }}>Median variance</th>
              <th style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--slate-600)', width: 140 }}>Bar</th>
              <th style={{ padding: '10px 14px', width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {services.map((svc, i) => (
              <tr key={svc.service} style={{ borderTop: i > 0 ? '1px solid var(--slate-100)' : undefined }}>
                <td style={{ padding: '10px 14px', color: 'var(--slate-800)', fontWeight: 500 }}>
                  {svc.service}
                </td>
                <td style={{ textAlign: 'right', padding: '10px 14px', color: 'var(--slate-500)' }}>
                  {svc.n}
                </td>
                <td style={{ textAlign: 'right', padding: '10px 14px', fontWeight: 700, color: varianceColor(svc.median_variance_pct) }}>
                  {fmtPct(svc.median_variance_pct)}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  {/* Horizontal variance bar centred at 0 */}
                  <div style={{ position: 'relative', height: 10, background: 'var(--slate-100)', borderRadius: 99 }}>
                    <div style={{
                      position: 'absolute',
                      top: 0, bottom: 0,
                      borderRadius: 99,
                      background: varianceColor(svc.median_variance_pct),
                      left: svc.median_variance_pct < 0 ? `${Math.max(0, 50 + svc.median_variance_pct / 2)}%` : '50%',
                      width: `${Math.min(50, Math.abs(svc.median_variance_pct) / 2)}%`,
                    }} />
                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, background: 'var(--slate-300)' }} />
                  </div>
                  {/* Per-shop dots */}
                  {svc.shop_dots.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {svc.shop_dots.map((d, j) => (
                        <span key={j} title={`${d.shop}: ${fmtPct(d.variance_pct)}`}
                          style={{ fontSize: 10, color: varianceColor(d.variance_pct), background: 'var(--slate-50)', border: '1px solid var(--slate-200)', borderRadius: 4, padding: '1px 5px' }}>
                          {d.shop.split(' ')[0]} {fmtPct(d.variance_pct)}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td style={{ padding: '10px 8px' }}>
                  {svc.systematically_wrong && <Badge tone="red">Systematic</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {services.some(s => s.systematically_wrong) && (
        <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>
          <Badge tone="red">Systematic</Badge> = |median| &gt; 10% at n ≥ 3 — labor time estimates are consistently off for this service.
        </div>
      )}
    </div>
  )
}
