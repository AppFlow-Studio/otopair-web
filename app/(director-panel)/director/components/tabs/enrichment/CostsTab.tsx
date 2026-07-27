'use client'

// Tab 3 · Costs — token-derived spend (the stored estimated_cost_usd column is
// dead; every figure here is recomputed from tokens). Daily cost + token
// trend, cost-per-run, top-cost runs, web-search volume. Native panel styling.

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { StatCard, DailyBars, BarRow, InfoTip, denseDailySeries, dayLabel, money } from '../../Charts'
import { SegmentedControl } from '../../Primitives'
import { Panel, Empty, SkeletonBlock, fmtNum } from './helpers'

const WINDOWS = [{ value: '7', label: '7d' }, { value: '14', label: '14d' }, { value: '30', label: '30d' }]

/** Exact cost, but never collapse a sub-cent day to $0.00 — show 3–4 decimals
 *  so low-volume days still read as non-zero. */
function costLabel(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(v < 0.001 ? 4 : 3)}`
  return money(v, { cents: true })
}

type CostDay = { date: string; runs: number; costUsd: number; tokensIn: number; tokensOut: number; webSearches: number; costPerRun: number | null }

export function CostsTab({ token }: { token: string }) {
  const [win, setWin] = useState('14')
  const days = Number(win)
  const daily = useQuery(api.directorEnrichment.costDaily, { token, days })
  const top = useQuery(api.directorEnrichment.topCostRuns, { token, days })

  // Gap-fill to a contiguous window so the four daily charts share one axis and
  // missing days render as gaps, not shifted bars.
  const dense: CostDay[] = daily === undefined ? [] : denseDailySeries<CostDay>({
    days, rows: daily, dateOf: d => d.date,
    zero: date => ({ date, runs: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, webSearches: 0, costPerRun: null }),
  })
  const ready = daily !== undefined
  const withLabel = dense.map(d => ({ ...d, label: dayLabel(`${d.date}T12:00:00Z`) }))
  const costBars = ready ? withLabel.map(d => ({ ...d, value: d.costUsd })) : undefined
  const tokenBars = ready ? withLabel.map(d => ({ ...d, value: d.tokensIn + d.tokensOut })) : undefined
  const searchBars = ready ? withLabel.map(d => ({ ...d, value: d.webSearches })) : undefined
  const cprBars = ready ? withLabel.map(d => ({ ...d, value: d.costPerRun ?? 0 })) : undefined

  const runs = top?.runs ?? []
  const totalCost = runs.reduce((s, r) => s + r.costUsd, 0)
  const avgCost = runs.length ? totalCost / runs.length : 0
  const maxCost = runs.length ? runs[0].costUsd : 0

  const tip = (content: React.ReactNode) => <InfoTip content={content} width={230} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <SegmentedControl value={win} options={WINDOWS} onChange={setWin} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
        <StatCard label={`Spend · ${win}d`} value={top ? costLabel(totalCost) : '—'} tone="green" hint="token-derived"
          accent={tip(<>Sum of every run’s token cost in the window, blended <b>$0.80/MTok in + $4.00/MTok out</b>. The stored <span className="mono">estimated_cost_usd</span> column is dead ($0) and ignored.</>)} />
        <StatCard label="Avg / run" value={top ? costLabel(avgCost) : '—'}
          accent={tip(<>Total spend ÷ runs scanned in the window.</>)} />
        <StatCard label="Costliest run" value={top ? costLabel(maxCost) : '—'}
          accent={tip(<>The single most expensive run in the window (top of Top-cost runs).</>)} />
        <StatCard label="Runs" value={top ? fmtNum(top.runsScanned) : '—'}
          accent={tip(<>Runs created in the window.{top?.truncated ? ' Capped at 1,000 — older runs excluded.' : ''}</>)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Panel title="Daily cost" sub="token-derived" right={tip(<>Per-day token cost. Sub-cent days are shown to 3–4 decimals so they don’t flatten to $0.</>)}>
          <DailyBars data={costBars} color="var(--green-600)" height={150}
            tooltip={(d) => <><b>{String(d.label)}</b> · {costLabel(Number(d.value))} · {fmtNum(Number(d.runs))} runs</>} />
        </Panel>
        <Panel title="Daily tokens" sub="in + out" right={tip(<>Total tokens (input + output) processed per day.</>)}>
          <DailyBars data={tokenBars} color="var(--blue-400, #60A5FA)" height={150}
            tooltip={(d) => <><b>{String(d.label)}</b> · {fmtNum(Number(d.value))} tok · in {fmtNum(Number(d.tokensIn))} / out {fmtNum(Number(d.tokensOut))}</>} />
        </Panel>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Panel title="Cost per run" sub="token-derived" right={tip(<>Daily spend ÷ that day’s run count — the trend that matters for unit economics as volume changes.</>)}>
          <DailyBars data={cprBars} color="var(--teal-700)" height={150}
            tooltip={(d) => <><b>{String(d.label)}</b> · {d.costPerRun != null ? costLabel(Number(d.costPerRun)) : '—'} / run · {fmtNum(Number(d.runs))} runs</>} />
        </Panel>
        <Panel title="Web searches" sub="daily count (not $-priced)" right={tip(<>Firecrawl/web-search volume. There is no credit metering, so this is a count, not dollars.</>)}>
          <DailyBars data={searchBars} color="var(--purple-700)" height={150}
            tooltip={(d) => <><b>{String(d.label)}</b> · {fmtNum(Number(d.value))} searches</>} />
        </Panel>
      </div>

      <Panel title="Top-cost runs" sub={`${win}d`}>
        {!top ? <SkeletonBlock height={150} /> : runs.length === 0 ? <Empty>No runs in this window.</Empty> : (
          <div>
            {runs.slice(0, 10).map(r => (
              <BarRow key={String(r.id)} label={<span className="mono">{r.configKey ?? '(deleted)'}</span>}
                value={r.costUsd} max={maxCost} valueLabel={costLabel(r.costUsd)} color="var(--green-600)" />
            ))}
          </div>
        )}
      </Panel>

      <div style={{ fontSize: 12, color: 'var(--slate-400)', lineHeight: 1.6, padding: '0 2px' }}>
        <b>Methodology:</b> cost is computed from token counts at a blended $0.80/MTok in + $4.00/MTok out (matching the pipeline).
        The <span className="mono">estimated_cost_usd</span> and <span className="mono">total_firecrawl_credits</span> columns are never
        written by the pipeline, so they are ignored here. FireCrawl/web-search volume is shown as counts, not dollars.
      </div>
    </div>
  )
}
