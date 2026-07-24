'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * Hook to track a div's content-box width via ResizeObserver. Keeps SVG
 * chart elements (bars, line, axis text) at native pixel sizes instead of
 * relying on preserveAspectRatio="none" stretching.
 */
function useContainerWidth(fallback = 800) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState<number>(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth || fallback)
    const ro = new ResizeObserver((entries) => {
      const next = Math.max(200, Math.floor(entries[0]?.contentRect.width ?? fallback))
      setW((prev) => (prev === next ? prev : next))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fallback])
  return { ref, w }
}

/**
 * Tiny dependency-free chart primitives for director dashboards.
 * - Sparkline   — single-series area chart with optional grid
 * - DualSparkline — revenue + bookings overlay
 * - BarRow      — horizontal "X of Y" bar for leaderboards
 * - StatCard    — metric tile with delta chip + optional sparkline
 * - DeltaChip   — ▲ +12.3% / ▼ −4.1% pill
 * - InfoTip     — hover/focus "i" popover for explaining a metric
 * - StackedBars — daily bar chart with a per-status segment stack
 */

// ---------------------------------------------------------------------------
// InfoIcon + InfoTip — accessible hover/focus/tap popover. No deps; matches the
// inline-style system. Drops into StatCard's `accent` slot or a Panel title.
// ---------------------------------------------------------------------------

export const InfoIcon = ({ size = 13, color = 'var(--slate-400)' }: { size?: number; color?: string }) => (
  <span aria-hidden style={{
    display:'inline-flex', alignItems:'center', justifyContent:'center', width:size, height:size,
    borderRadius:999, border:`1px solid ${color}`, color, fontSize:Math.round(size * 0.72),
    fontWeight:700, fontStyle:'italic', fontFamily:'Georgia, serif', lineHeight:1, cursor:'help',
  }}>i</span>
)

export const InfoTip = ({
  content, children, side = 'top', width = 240, label = 'More info',
}: {
  content: ReactNode
  children?: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  width?: number
  label?: string
}) => {
  const [open, setOpen] = useState(false)
  const pos: CSSProperties =
    side === 'bottom' ? { top: '130%', left: '50%', transform: 'translateX(-50%)' }
    : side === 'left' ? { right: '130%', top: '50%', transform: 'translateY(-50%)' }
    : side === 'right' ? { left: '130%', top: '50%', transform: 'translateY(-50%)' }
    : { bottom: '130%', left: '50%', transform: 'translateX(-50%)' }
  return (
    <span
      role="button" tabIndex={0} aria-label={label}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
      style={{ position:'relative', display:'inline-flex', alignItems:'center', outline:'none', verticalAlign:'middle' }}>
      {children ?? <InfoIcon />}
      {open && (
        <span role="tooltip" style={{
          position:'absolute', ...pos, width, zIndex:50, background:'#fff',
          border:'1px solid var(--slate-200)', borderRadius:8, padding:'8px 10px',
          fontSize:12, fontWeight:400, lineHeight:1.5, color:'var(--slate-600)', textAlign:'left',
          textTransform:'none', letterSpacing:'normal', boxShadow:'0 4px 12px rgba(15,23,42,0.10)',
          pointerEvents:'none', whiteSpace:'normal',
        }}>{content}</span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// denseDailySeries — pure gap-filler. Sparse per-day rows (portal_stats /
// overview.daily only carry days that had data) get expanded to a contiguous
// [today-days+1 … today] array so index-positioned bar charts align across
// panels and missing days render as real gaps, not shifted bars.
// ---------------------------------------------------------------------------

export function denseDailySeries<T>({
  days, rows, dateOf, zero, today,
}: {
  days: number
  rows: T[]
  dateOf: (r: T) => string        // 'YYYY-MM-DD'
  zero: (date: string) => T       // synthesize an empty row for a missing day
  today?: string                  // 'YYYY-MM-DD' anchor; defaults to the latest present row / now
}): T[] {
  const byDate = new Map<string, T>()
  for (const r of rows) byDate.set(dateOf(r), r)
  // Anchor: explicit override, else the max present date, else today (UTC).
  const anchor = today
    ?? (rows.length ? [...byDate.keys()].sort().at(-1)! : new Date().toISOString().slice(0, 10))
  const end = new Date(`${anchor}T00:00:00Z`)
  const out: T[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end)
    d.setUTCDate(d.getUTCDate() - i)
    const key = d.toISOString().slice(0, 10)
    out.push(byDate.get(key) ?? zero(key))
  }
  return out
}

// ---------------------------------------------------------------------------
// Sparkline (area + line)
// ---------------------------------------------------------------------------

export const Sparkline = ({
  values, height = 40, color = 'var(--blue-600)', fill = 'var(--blue-50)',
  showLastDot = true, style,
}: {
  values: number[]; height?: number; color?: string; fill?: string;
  showLastDot?: boolean; style?: CSSProperties;
}) => {
  if (!values || values.length === 0) {
    return <div style={{ height, ...style }} />
  }
  const w = 100
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w
    const y = height - ((v - min) / range) * (height - 4) - 2
    return { x, y }
  })
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const fillPath = `${linePath} L ${w},${height} L 0,${height} Z`
  const last = pts[pts.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none"
      style={{ width:'100%', height, display:'block', ...style }}>
      <path d={fillPath} fill={fill} opacity={0.6} />
      <path d={linePath} stroke={color} strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />
      {showLastDot && (
        <circle cx={last.x} cy={last.y} r={1.8} fill={color} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// DualSparkline — primary line + secondary bars (e.g. revenue + bookings)
// ---------------------------------------------------------------------------

export const DualSparkline = ({
  series, height = 130, primaryLabel = 'Revenue', secondaryLabel = 'Bookings',
}: {
  series: { ts: number; revenue: number; bookings: number }[]
  height?: number
  primaryLabel?: string
  secondaryLabel?: string
}) => {
  const { ref, w } = useContainerWidth(800)

  // Use 1:1 viewBox so strokes, bars and text render at their natural sizes
  // regardless of container width.
  const padX = 12, padTop = 14, padBot = 22, padRight = 12
  const innerH = height - padTop - padBot
  const innerW = Math.max(60, w - padX - padRight)

  const n = series?.length ?? 0
  const revVals = (series ?? []).map(s => s.revenue)
  const bookVals = (series ?? []).map(s => s.bookings)
  const revMax = Math.max(...(revVals.length ? revVals : [1]), 1)
  const bookMax = Math.max(...(bookVals.length ? bookVals : [1]), 1)
  const stepX = innerW / Math.max(n - 1, 1)
  // Bar width caps so 60-day spans don't smear into a single wash.
  const barW = Math.min(28, Math.max(3, stepX * 0.55))

  const linePts = (series ?? []).map((s, i) => ({
    x: padX + i * stepX,
    y: padTop + innerH - (s.revenue / revMax) * innerH,
  }))
  const linePath = linePts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const areaPath = linePts.length > 0
    ? `${linePath} L ${(padX + (n - 1) * stepX).toFixed(2)},${padTop + innerH} L ${padX},${padTop + innerH} Z`
    : ''

  const fmtDate = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  // Pick ~4-6 evenly spaced ticks so the axis doesn't get over- or under-labeled
  // at any width.
  const tickCount = Math.max(2, Math.min(6, Math.floor(innerW / 110)))
  const tickIdxs = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i / (tickCount - 1)) * (n - 1)),
  )

  if (!series || series.length === 0) {
    return (
      <div ref={ref} style={{ width:'100%', height, color:'var(--slate-400)', fontSize:12, display:'flex', alignItems:'center', justifyContent:'center' }}>
        No data.
      </div>
    )
  }

  return (
    <div ref={ref} style={{ width:'100%' }}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} style={{ display:'block' }}>
        {/* horizontal grid */}
        {[0.25, 0.5, 0.75, 1].map((f, i) => (
          <line key={i} x1={padX} x2={padX + innerW}
            y1={padTop + innerH * f} y2={padTop + innerH * f}
            stroke={i === 3 ? 'var(--slate-200)' : 'var(--slate-100)'} strokeWidth={1} />
        ))}
        {/* bookings bars (rendered first, under the line) */}
        {series.map((s, i) => {
          if (s.bookings === 0) return null
          const h = (s.bookings / bookMax) * innerH
          const x = padX + i * stepX - barW / 2
          const y = padTop + innerH - h
          return <rect key={i} x={x} y={y} width={barW} height={h} rx={1.5} fill="var(--slate-200)" />
        })}
        {/* revenue area + line */}
        {areaPath && <path d={areaPath} fill="var(--blue-100, #DBEAFE)" opacity={0.5} />}
        <path d={linePath} stroke="var(--blue-600)" strokeWidth={1.75} fill="none" />
        {/* end-of-series dot */}
        {linePts.length > 0 && (() => {
          const last = linePts[linePts.length - 1]
          return <circle cx={last.x} cy={last.y} r={2.5} fill="var(--blue-600)" />
        })()}
        {/* axis labels */}
        {tickIdxs.map((idx, i) => {
          if (idx >= n) return null
          const x = padX + idx * stepX
          const anchor: 'start' | 'middle' | 'end' = i === 0 ? 'start' : i === tickIdxs.length - 1 ? 'end' : 'middle'
          return (
            <text key={i} x={x} y={height - 6} fontSize={10} fill="var(--slate-500)" textAnchor={anchor}>
              {fmtDate(series[idx].ts)}
            </text>
          )
        })}
      </svg>
      <div style={{ display:'flex', gap:14, justifyContent:'flex-end', marginTop:6, fontSize:11, color:'var(--slate-500)' }}>
        <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
          <span style={{ width:12, height:2, background:'var(--blue-600)', borderRadius:2 }} />
          {primaryLabel}
        </span>
        <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
          <span style={{ width:10, height:10, background:'var(--slate-200)', borderRadius:2 }} />
          {secondaryLabel}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BarRow — horizontal proportion bar for leaderboards
// ---------------------------------------------------------------------------

export const BarRow = ({
  label, value, max, valueLabel, color = 'var(--blue-500)', barBg = 'var(--slate-100)',
  width = '100%',
}: {
  label: ReactNode; value: number; max: number; valueLabel?: ReactNode;
  color?: string; barBg?: string; width?: string | number;
}) => {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return (
    <div style={{ width, display:'flex', alignItems:'center', gap:10, padding:'4px 0' }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:12, color:'var(--slate-800)', marginBottom:3, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{label}</div>
        <div style={{ width:'100%', height:6, background: barBg, borderRadius:3, overflow:'hidden' }}>
          <div style={{ width: `${w}%`, height:'100%', background: color, transition:'width 200ms' }} />
        </div>
      </div>
      {valueLabel != null && (
        <div className="mono" style={{ fontSize:12, color:'var(--slate-700)', minWidth:64, textAlign:'right' }}>
          {valueLabel}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DeltaChip — comparison arrow
// ---------------------------------------------------------------------------

export const DeltaChip = ({
  pct, inverted = false,
}: { pct: number | null | undefined; inverted?: boolean }) => {
  if (pct == null || !isFinite(pct)) {
    return <span style={{ fontSize:11, color:'var(--slate-400)' }}>—</span>
  }
  const positive = pct >= 0
  const goodDirection = inverted ? !positive : positive
  const tone = pct === 0
    ? { fg: 'var(--slate-500)', bg: 'var(--slate-100)' }
    : goodDirection
      ? { fg: 'var(--green-700)', bg: 'var(--green-50)' }
      : { fg: 'var(--red-700)',   bg: 'var(--red-50)' }
  const arrow = pct === 0 ? '·' : positive ? '▲' : '▼'
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:3, fontSize:11, fontWeight:600,
      color: tone.fg, background: tone.bg, padding:'1px 6px', borderRadius:999 }} className="mono">
      <span>{arrow}</span>
      <span>{Math.abs(pct).toFixed(1)}%</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// StatCard — metric tile with optional sparkline + delta
// ---------------------------------------------------------------------------

export const StatCard = ({
  label, value, hint, delta, deltaInverted, spark, tone = 'slate', accent, onClick, href,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  delta?: number | null
  deltaInverted?: boolean
  spark?: number[]
  tone?: 'slate' | 'blue' | 'green' | 'yellow' | 'red' | 'purple'
  accent?: ReactNode
  onClick?: () => void
  href?: string
}) => {
  const clickable = !!(onClick || href)
  const inner = (
    <div onClick={onClick}
      style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:'14px 16px', display:'flex', flexDirection:'column', gap:6, minHeight:90, position:'relative', overflow:'hidden', cursor:clickable ? 'pointer' : 'default', transition:'border-color 120ms, box-shadow 120ms', height:'100%' }}
      onMouseEnter={clickable ? e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--blue-300, #93C5FD)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 1px 6px rgba(15,23,42,0.06)' } : undefined}
      onMouseLeave={clickable ? e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--slate-200)'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' } : undefined}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:6 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
        {accent}
      </div>
      <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
        <span style={{ fontSize:22, fontWeight:700, color:'var(--slate-900)' }} className="mono">{value}</span>
        {delta !== undefined && <DeltaChip pct={delta ?? null} inverted={deltaInverted} />}
      </div>
      {hint && <div style={{ fontSize:11, color:'var(--slate-500)' }}>{hint}</div>}
      {spark && spark.length > 0 && (
        <div style={{ marginTop:'auto', marginLeft:-2, marginRight:-2 }}>
          <Sparkline values={spark} height={28}
            color={`var(--${tone}-600, var(--blue-600))`}
            fill={`var(--${tone}-50, var(--blue-50))`} />
        </div>
      )}
    </div>
  )
  if (href) return <a href={href} style={{ textDecoration:'none', display:'block', height:'100%' }}>{inner}</a>
  return inner
}

// ---------------------------------------------------------------------------
// DailyBars — single-series daily bar chart with a sparse date axis. Replaces
// ChartKit's recharts <TrendBars> in the inline-style director panel.
// ---------------------------------------------------------------------------

export const DailyBars = ({
  data, color = 'var(--blue-300, #93C5FD)', height = 120, valueKey = 'value', labelKey = 'label', tooltip,
}: {
  data: Array<Record<string, unknown>> | undefined
  color?: string
  height?: number
  valueKey?: string
  labelKey?: string
  // When supplied, hovering a bar renders a real hover card instead of the
  // native title="" tooltip. Return null to fall back to the title for a bar.
  tooltip?: (row: Record<string, unknown>, i: number) => ReactNode
}) => {
  const [hover, setHover] = useState<number | null>(null)
  if (data === undefined) return <div style={{ height, background:'var(--slate-50)', borderRadius:8 }} />
  if (data.length === 0) return <div style={{ height, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-400)', fontSize:12 }}>No data.</div>
  const vals = data.map(d => Number(d[valueKey] ?? 0))
  const max = Math.max(...vals, 1)
  const barH = height - 22
  const n = data.length
  const tickCount = Math.max(2, Math.min(6, Math.floor(n / 8)))
  const tickIdxs = new Set(Array.from({ length: tickCount }, (_, i) => Math.round((i / (tickCount - 1)) * (n - 1))))
  return (
    <div>
      <div style={{ position:'relative', display:'flex', alignItems:'flex-end', gap:2, height:barH }}
        onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => {
          const v = Number(d[valueKey] ?? 0)
          const h = Math.max(v > 0 ? 2 : 0, (v / max) * barH)
          const label = String(d[labelKey] ?? '')
          return (
            <div key={i} onMouseEnter={() => setHover(i)}
              title={tooltip ? undefined : `${label}: ${v}`}
              style={{ flex:1, height:h, minWidth:2, background:color, borderRadius:'2px 2px 0 0', alignSelf:'flex-end',
                opacity: hover != null && hover !== i ? 0.55 : 1, transition:'opacity 100ms' }} />
          )
        })}
        {tooltip && hover != null && tooltip(data[hover], hover) && (
          <div style={{ position:'absolute', bottom:'100%', marginBottom:6,
            left:`${((hover + 0.5) / n) * 100}%`, transform:'translateX(-50%)',
            background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'6px 9px',
            fontSize:11, lineHeight:1.5, color:'var(--slate-700)', whiteSpace:'nowrap', zIndex:20,
            boxShadow:'0 4px 12px rgba(15,23,42,0.10)', pointerEvents:'none' }}>
            {tooltip(data[hover], hover)}
          </div>
        )}
      </div>
      <div style={{ display:'flex', gap:2, marginTop:6, fontSize:10, color:'var(--slate-400)' }}>
        {data.map((d, i) => (
          <span key={i} style={{ flex:1, textAlign:'center', whiteSpace:'nowrap', overflow:'hidden' }}>
            {tickIdxs.has(i) ? String(d[labelKey] ?? '') : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// StackedBars — daily bars split into stacked segments (e.g. run-status
// composition per day). Shares DailyBars' sparse tick axis + hover-card layer,
// with an inline legend.
// ---------------------------------------------------------------------------

export const StackedBars = ({
  data, segments, labelKey = 'label', height = 160, tooltip,
}: {
  data: Array<Record<string, unknown>> | undefined
  segments: { key: string; color: string; label: string }[]
  labelKey?: string
  height?: number
  tooltip?: (row: Record<string, unknown>, i: number) => ReactNode
}) => {
  const [hover, setHover] = useState<number | null>(null)
  if (data === undefined) return <div style={{ height, background:'var(--slate-50)', borderRadius:8 }} />
  if (data.length === 0) return <div style={{ height, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-400)', fontSize:12 }}>No data.</div>
  const totals = data.map(d => segments.reduce((s, seg) => s + Number(d[seg.key] ?? 0), 0))
  const max = Math.max(...totals, 1)
  const barH = height - 40
  const n = data.length
  const tickCount = Math.max(2, Math.min(6, Math.floor(n / 8)))
  const tickIdxs = new Set(Array.from({ length: tickCount }, (_, i) => Math.round((i / (tickCount - 1)) * (n - 1))))
  return (
    <div>
      <div style={{ position:'relative', display:'flex', alignItems:'flex-end', gap:2, height:barH }}
        onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => {
          const total = totals[i]
          const colH = Math.max(total > 0 ? 2 : 0, (total / max) * barH)
          return (
            <div key={i} onMouseEnter={() => setHover(i)}
              style={{ flex:1, minWidth:2, height:colH, display:'flex', flexDirection:'column',
                alignSelf:'flex-end', borderRadius:'2px 2px 0 0', overflow:'hidden',
                opacity: hover != null && hover !== i ? 0.55 : 1, transition:'opacity 100ms' }}>
              {segments.map(seg => {
                const v = Number(d[seg.key] ?? 0)
                if (v <= 0 || total <= 0) return null
                return <div key={seg.key} style={{ height:`${(v / total) * 100}%`, background:seg.color }} />
              })}
            </div>
          )
        })}
        {tooltip && hover != null && (
          <div style={{ position:'absolute', bottom:'100%', marginBottom:6,
            left:`${((hover + 0.5) / n) * 100}%`, transform:'translateX(-50%)',
            background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'6px 9px',
            fontSize:11, lineHeight:1.5, color:'var(--slate-700)', whiteSpace:'nowrap', zIndex:20,
            boxShadow:'0 4px 12px rgba(15,23,42,0.10)', pointerEvents:'none' }}>
            {tooltip(data[hover], hover)}
          </div>
        )}
      </div>
      <div style={{ display:'flex', gap:2, marginTop:6, fontSize:10, color:'var(--slate-400)' }}>
        {data.map((d, i) => (
          <span key={i} style={{ flex:1, textAlign:'center', whiteSpace:'nowrap', overflow:'hidden' }}>
            {tickIdxs.has(i) ? String(d[labelKey] ?? '') : ''}
          </span>
        ))}
      </div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:'4px 14px', marginTop:10, fontSize:11, color:'var(--slate-500)' }}>
        {segments.map(seg => (
          <span key={seg.key} style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
            <span style={{ width:9, height:9, borderRadius:2, background:seg.color }} />
            {seg.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Histogram — vertical distribution bars with a completion-gate line. Bars at
// or past the gate render green; those before it blue. Used by Flags & Quality
// for the fill-rate / quotability distributions.
// ---------------------------------------------------------------------------

export const Histogram = ({
  bins, gateLabel, height = 140,
}: {
  bins: Array<{ label: string; count: number; pass: boolean }>
  gateLabel?: string
  height?: number
}) => {
  if (!bins || bins.length === 0) {
    return <div style={{ height, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--slate-400)', fontSize:12 }}>No data.</div>
  }
  const max = Math.max(...bins.map(b => b.count), 1)
  const barH = height - 34
  const firstPass = bins.findIndex(b => b.pass)
  return (
    <div style={{ position:'relative' }}>
      {firstPass > 0 && (
        <div style={{ position:'absolute', top:0, bottom:22, left:`${(firstPass / bins.length) * 100}%`, width:0, borderLeft:'2px dashed var(--slate-300)', zIndex:1 }}>
          {gateLabel && (
            <span className="mono" style={{ position:'absolute', top:-1, left:5, fontSize:10, fontWeight:600, color:'var(--slate-400)', whiteSpace:'nowrap' }}>{gateLabel}</span>
          )}
        </div>
      )}
      <div style={{ display:'flex', alignItems:'flex-end', gap:6, height:barH }}>
        {bins.map((b, i) => {
          const h = Math.max(b.count > 0 ? 3 : 0, (b.count / max) * (barH - 14))
          const color = b.pass ? 'var(--green-600)' : 'var(--blue-400, #60A5FA)'
          return (
            <div key={i} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-end', gap:4 }}>
              <span className="mono" style={{ fontSize:10, color:'var(--slate-400)' }}>{b.count}</span>
              <div title={`${b.label}: ${b.count}`} style={{ width:'68%', height:h, minHeight: b.count > 0 ? 3 : 0, background:color, borderRadius:'3px 3px 0 0' }} />
            </div>
          )
        })}
      </div>
      <div style={{ display:'flex', gap:6, marginTop:6, fontSize:10, color:'var(--slate-400)' }}>
        {bins.map((b, i) => (
          <span key={i} style={{ flex:1, textAlign:'center', whiteSpace:'nowrap', overflow:'hidden' }}>{b.label}</span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function fmtCurrency(n: number | undefined | null): string {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

export function fmtPct(n: number | undefined | null, digits = 1): string {
  if (n == null || !isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export function fmtNumber(n: number | undefined | null): string {
  if (n == null) return '—'
  return n.toLocaleString()
}

export function fmtRelative(ts: number | undefined | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

/**
 * Exact currency (whole-dollar by default, cents when asked). Mirrors
 * ChartKit's `money` so ported /ops + /shops surfaces keep exact figures —
 * `fmtCurrency` above compacts ($1.2k) and is for stat tiles only.
 */
export function money(n: number | null | undefined, opts?: { cents?: boolean }): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts?.cents ? 2 : 0,
    maximumFractionDigits: opts?.cents ? 2 : 0,
  })
}

/** Short "M/D" label for a Date, timestamp, or ISO "YYYY-MM-DD" string. */
export function dayLabel(d: number | string | Date): string {
  const date = typeof d === 'string'
    ? new Date(d.length === 10 ? `${d}T00:00:00` : d)
    : new Date(d)
  if (Number.isNaN(date.getTime())) return String(d)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
