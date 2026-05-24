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
 */

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
  label, value, hint, delta, deltaInverted, spark, tone = 'slate', accent,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  delta?: number | null
  deltaInverted?: boolean
  spark?: number[]
  tone?: 'slate' | 'blue' | 'green' | 'yellow' | 'red' | 'purple'
  accent?: ReactNode
}) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:'14px 16px', display:'flex', flexDirection:'column', gap:6, minHeight:90, position:'relative', overflow:'hidden' }}>
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
