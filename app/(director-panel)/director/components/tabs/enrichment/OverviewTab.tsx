'use client'

// Tab 1 · Overview — health & SLO tiles (with metric tooltips), 7d run-status
// distribution, stacked runs-per-day, stuck-run banner, and an actionable
// attention rail (acknowledge / deep-dive / resolve) with trend + causes.

import { useState } from 'react'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '@/convex/_generated/api'
import { StatCard, BarRow, StackedBars, DailyBars, DeltaChip, InfoTip, denseDailySeries, dayLabel } from '../../Charts'
import { Button, SegmentedControl } from '../../Primitives'
import { Panel, Empty, StatusPill, SkeletonBlock, fmtPct, fmtCost, fmtNum, fmtWhen, SLO_BANDS, type OpenTrigger } from './helpers'

const WINDOWS = [{ value: '7', label: '7d' }, { value: '14', label: '14d' }, { value: '30', label: '30d' }]

/** Sparkline series + a first-half-vs-second-half trend delta (%), from real
 *  per-day values only — never fabricated. Delta is null when too few samples. */
function seriesTrend(nums: Array<number | null | undefined>): { spark: number[]; delta: number | null } {
  const s = nums.filter((v): v is number => typeof v === 'number' && isFinite(v))
  if (s.length < 2) return { spark: s, delta: null }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const half = Math.floor(s.length / 2)
  const a = mean(s.slice(0, half))
  const b = mean(s.slice(half))
  const delta = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null
  return { spark: s, delta }
}

type StatsRet = FunctionReturnType<typeof api.portalStats.getStats>
function statVal(stats: StatsRet | undefined, key: string): number | null {
  if (!stats) return null
  const row = (stats as Record<string, { value: number } | null>)[key]
  return row ? row.value : null
}
function bandTone(value: number | null, key: string): 'green' | 'yellow' | 'red' | 'slate' {
  const b = SLO_BANDS[key]
  if (value == null || !b) return 'slate'
  const below = b.direction === 'below'
  const bad = below ? value > b.alert : value < b.alert
  const warn = below ? value > b.target : value < b.target
  return bad ? 'red' : warn ? 'yellow' : 'green'
}

const GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }
const STATUS_SEGMENTS = [
  { key: 'complete', color: 'var(--green-600)', label: 'Complete' },
  { key: 'live', color: 'var(--blue-500)', label: 'In-flight' },
  { key: 'timeout', color: 'var(--orange-700)', label: 'Timeout' },
  { key: 'failed', color: 'var(--red-600)', label: 'Failed' },
  { key: 'other', color: 'var(--slate-400)', label: 'Other' },
]

export function OverviewTab({ token, goTab, goDeepDive, openTrigger }: {
  token: string
  goTab: (t: string) => void
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
  openTrigger: OpenTrigger
}) {
  const [win, setWin] = useState('7')
  const ov = useQuery(api.directorEnrichment.overview, { token, days: 7 })
  const ovWin = useQuery(api.directorEnrichment.overview, { token, days: Number(win) })
  const cost = useQuery(api.directorEnrichment.costDaily, { token, days: 7 })
  const live = useQuery(api.directorEnrichment.liveRuns, { token })
  const attention = useQuery(api.dataOverview.attention, { token })
  const causes = useQuery(api.directorEnrichment.flagTaxonomy, { token, days: 1 })
  const stats = useQuery(api.portalStats.getStats, {
    token, keys: ['slo.avg_confidence', 'data.vin_queue_pending', 'slo.review_queue_depth'],
  })

  const stuck = (live ?? []).filter(r => r.isStale)
  const conf = statVal(stats, 'slo.avg_confidence')
  const vinPending = statVal(stats, 'data.vin_queue_pending')
  const reviewDepth = statVal(stats, 'slo.review_queue_depth')

  const runsTrend = seriesTrend((ov?.daily ?? []).map(d => d.total))
  const successTrend = seriesTrend((ov?.daily ?? []).map(d => {
    const den = d.complete + d.failed
    return den > 0 ? (d.complete / den) * 100 : null
  }))
  const costTrend = seriesTrend((cost ?? []).slice(-7).map(d => d.costUsd))
  const failedTrend = seriesTrend((ov?.daily ?? []).map(d => d.failed))
  const failedByDay = (ov?.daily ?? []).map(d => ({ label: dayLabel(`${d.date}T12:00:00Z`), value: d.failed }))

  // Stacked per-status runs-per-day, gap-filled to the selected window.
  const stackedDaily = ovWin === undefined ? undefined : denseDailySeries({
    days: Number(win), rows: ovWin.daily, dateOf: d => d.date,
    zero: date => ({ date, total: 0, complete: 0, timeout: 0, failed: 0, live: 0, other: 0 }),
  }).map(d => ({ ...d, label: dayLabel(`${d.date}T12:00:00Z`) }))

  const Dot = ({ tone }: { tone: 'green' | 'yellow' | 'red' | 'slate' }) => (
    <span style={{ width: 8, height: 8, borderRadius: 999, background: `var(--${tone === 'slate' ? 'slate-300' : tone + '-500'})` }} />
  )
  const accent = (dotTone: 'green' | 'yellow' | 'red' | 'slate' | null, tip: React.ReactNode) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {dotTone && <Dot tone={dotTone} />}
      <InfoTip content={tip} width={230} />
    </span>
  )

  const byStatus = ov?.byStatus
  const causeMax = Math.max(1, ...(causes?.errorBuckets ?? []).map(b => b.count))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {stuck.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          border: '1px solid #FECACA', background: 'var(--red-50)', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ fontSize: 13, color: 'var(--red-700)' }}>
            <b>{stuck.length}</b> in-flight {stuck.length === 1 ? 'run has' : 'runs have'} a stale heartbeat (&gt;15&nbsp;min) — likely crashed chains awaiting force-unstick.
          </div>
          <Button variant="danger" size="sm" onClick={() => goTab('runs')}>Review in Live Runs</Button>
        </div>
      )}

      <div style={GRID}>
        <StatCard label="Success rate · 7d" value={ov ? fmtPct(ov.successRate) : '—'}
          tone="green" accent={accent(bandTone(ov?.successRate ?? null, 'slo.enrichment_success_rate_7d'),
            <>complete ÷ (complete + failed) over 7 days. Live and timeout runs are excluded from the denominator. Target {fmtPct(SLO_BANDS['slo.enrichment_success_rate_7d'].target)}, alert below {fmtPct(SLO_BANDS['slo.enrichment_success_rate_7d'].alert)}.{ov?.successSamples != null ? ` ${fmtNum(ov.successSamples)} samples.` : ''}</>)}
          spark={successTrend.spark} delta={successTrend.delta ?? undefined}
          hint={`target ${fmtPct(SLO_BANDS['slo.enrichment_success_rate_7d'].target)}`} />
        <StatCard label="Avg confidence" value={conf != null ? fmtPct(conf) : '—'}
          accent={accent(bandTone(conf, 'slo.avg_confidence'),
            <>Average model confidence across enriched fields. Target {fmtPct(SLO_BANDS['slo.avg_confidence'].target)}.</>)}
          hint={`target ${fmtPct(SLO_BANDS['slo.avg_confidence'].target)}`} />
        <StatCard label="Runs · 7d" value={ov ? fmtNum(ov.runsScanned) : '—'} tone="blue"
          accent={accent(null, <>Enrichment runs created in the last 7 days.{ov?.truncated ? ' Capped at 2,000 — older runs excluded.' : ''}</>)}
          spark={runsTrend.spark} delta={runsTrend.delta ?? undefined} />
        <StatCard label="Cost · 7d" value={ov ? fmtCost(ov.cost7dUsd) : '—'} tone="green" hint="token-derived"
          accent={accent(null, <>Token-derived spend at $0.80/MTok in + $4.00/MTok out.{ov ? ` ${fmtNum(ov.tokensIn7d)} in / ${fmtNum(ov.tokensOut7d)} out, ${fmtNum(ov.webSearches7d)} web searches.` : ''} The stored estimated_cost_usd column is dead.</>)}
          spark={costTrend.spark} delta={costTrend.delta ?? undefined} deltaInverted />
        <StatCard label="VIN queue · pending" value={vinPending != null ? fmtNum(vinPending) : '—'}
          accent={accent(null, <>VINs awaiting a first enrichment run. Managed in the Control Room.</>)} />
        <StatCard label="Review queue · open" value={reviewDepth != null ? fmtNum(reviewDepth) : '—'}
          accent={accent(bandTone(reviewDepth, 'slo.review_queue_depth'),
            <>Open manual-review items. SLO target under {SLO_BANDS['slo.review_queue_depth'].target}, alert over {SLO_BANDS['slo.review_queue_depth'].alert}.</>)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Panel title="Run status" sub="7d"
          right={<InfoTip width={250} content={<>Runs grouped into families: <b>Complete</b>, <b>In-flight</b> (started/scraping/batch1/batch2), <b>Timeout</b>, <b>Failed</b>, and <b>Other</b>. Click a row to jump to Live Runs.</>} />}>
          {!ov || !byStatus ? <SkeletonBlock height={160} /> : ov.runsScanned === 0 ? <Empty>No runs in this window.</Empty> : (
            <div>
              {([
                ['Complete', byStatus.complete, 'var(--green-600)', null],
                ['In-flight', byStatus.live, 'var(--blue-500)', 'runs'],
                ['Timeout', byStatus.timeout, 'var(--orange-700)', 'runs'],
                ['Failed', byStatus.failed, 'var(--red-600)', 'runs'],
                ['Other', byStatus.other, 'var(--slate-400)', null],
              ] as const).map(([label, value, color, goto]) => {
                const pct = ov.runsScanned > 0 ? Math.round((value / ov.runsScanned) * 100) : 0
                const row = (
                  <BarRow key={label} label={label} value={value} max={ov.runsScanned}
                    valueLabel={<>{fmtNum(value)} · {pct}%</>} color={color} />
                )
                return goto ? (
                  <div key={label} onClick={() => goTab('runs')} style={{ cursor: 'pointer' }}
                    title="View in Live Runs">{row}</div>
                ) : row
              })}
            </div>
          )}
        </Panel>

        <Panel title="Runs per day" sub={`${win}d · by status`}
          right={<SegmentedControl value={win} options={WINDOWS} onChange={setWin} />}>
          <StackedBars data={stackedDaily} segments={STATUS_SEGMENTS} height={160}
            tooltip={(d) => {
              const den = Number(d.complete) + Number(d.failed)
              const succ = den > 0 ? Math.round((Number(d.complete) / den) * 100) : null
              return <><b>{String(d.label)}</b> · {fmtNum(Number(d.total))} runs{succ != null ? ` · ${succ}% success` : ''}<br />
                ✓{fmtNum(Number(d.complete))} · ◷{fmtNum(Number(d.live))} · ⌛{fmtNum(Number(d.timeout))} · ✕{fmtNum(Number(d.failed))}</>
            }} />
        </Panel>
      </div>

      <Panel title="Needs attention" sub={attention ? `${attention.failed_runs_24h_total} failed · 24h` : undefined}>
        {!attention ? <SkeletonBlock height={100} /> :
          attention.failed_runs_24h.length === 0 && attention.stale_open_reviews.length === 0 ? (
            <Empty>Nothing needs attention — no failed runs in 24h, no stale reviews.</Empty>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Failed runs · 24h</div>
                {attention.failed_runs_24h.length === 0 ? <Empty>None.</Empty> :
                  attention.failed_runs_24h.slice(0, 8).map(r => (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
                      <StatusPill status="failed" />
                      <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-600)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.first_error ?? '—'}</span>
                      <span style={{ color: 'var(--slate-400)' }}>{fmtWhen(r.at)}</span>
                      <button style={{ ...linkBtn }} onClick={() => goDeepDive(r.vehicle_config_id, null, r.id)}>Deep-dive</button>
                      <button style={{ ...linkBtn, color: 'var(--slate-500)' }}
                        onClick={() => openTrigger({ kind: 'acknowledgeRun', runId: r.id, label: r.first_error ?? String(r.id) })}>Ack</button>
                    </div>
                  ))}
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Stale open reviews · &gt;72h</div>
                {attention.stale_open_reviews.length === 0 ? <Empty>None.</Empty> :
                  attention.stale_open_reviews.slice(0, 8).map(r => (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
                      <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 999, background: 'var(--yellow-50)', color: 'var(--yellow-800)' }}>{r.stream}</span>
                      <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-600)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                      <span style={{ color: 'var(--slate-400)' }}>{r.age_h}h</span>
                      <button style={{ ...linkBtn }} onClick={() => openTrigger({ kind: 'resolveReview', id: r.id, title: r.title, outcome: 'resolved' })}>Resolve</button>
                      <button style={{ ...linkBtn, color: 'var(--slate-500)' }} onClick={() => openTrigger({ kind: 'resolveReview', id: r.id, title: r.title, outcome: 'dismissed' })}>Dismiss</button>
                    </div>
                  ))}
              </div>
            </div>
          )}

        {/* Trend + causes rail */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--slate-100)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Failed runs / day · 7d</div>
              <DeltaChip pct={failedTrend.delta} inverted />
            </div>
            <DailyBars data={ov === undefined ? undefined : failedByDay} color="var(--red-600)" height={90}
              tooltip={(d) => <><b>{String(d.label)}</b> · {fmtNum(Number(d.value))} failed</>} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Open reviews by stream</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {attention && (['consensus', 'correction', 'report', 'survey'] as const).map(s => (
                <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', borderRadius: 8, background: 'var(--slate-50)', border: '1px solid var(--slate-200)' }}>
                  <span style={{ color: 'var(--slate-600)' }}>{s}</span>
                  <b className="mono" style={{ color: 'var(--slate-900)' }}>{fmtNum(attention.open_by_stream[s])}</b>
                </span>
              ))}
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Top causes · 24h</div>
              <InfoTip width={230} content={<>Most common flag prefixes across all runs’ errors[] in the last 24h — what is driving failures and flags.</>} />
            </div>
            {!causes ? <SkeletonBlock height={90} /> : causes.errorBuckets.length === 0 ? <Empty>No flags in 24h.</Empty> :
              causes.errorBuckets.slice(0, 6).map(b => (
                <BarRow key={b.key} label={b.key} value={b.count} max={causeMax} valueLabel={fmtNum(b.count)} color="var(--orange-700)" barBg="var(--orange-50)" />
              ))}
          </div>
        </div>
      </Panel>
    </div>
  )
}

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }
