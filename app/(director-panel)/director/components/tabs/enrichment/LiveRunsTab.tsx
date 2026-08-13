'use client'

// Tab 2 · Live Runs — pipeline stage funnel + stuck count, then sub-tabbed
// sections (In-flight / Backlog / Recent) so the whole tab is scannable without
// scrolling. Force-unstick per row and in bulk. Native panel styling.

import { useState } from 'react'
import { useQuery, usePaginatedQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '@/convex/_generated/api'
import { BarRow, StatCard } from '../../Charts'
import { Button, SegmentedControl } from '../../Primitives'
import {
  Panel, Empty, TableSkeleton, TableWrap, SubTabs, th, td, thRight, tdRight,
  StatusPill, fmtPct, fmtCost, fmtDuration, fmtNum, timeAgo, type OpenTrigger,
} from './helpers'

type LiveRow = FunctionReturnType<typeof api.directorEnrichment.liveRuns>[number]
type Section = 'inflight' | 'backlog' | 'recent'

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit' }
const FILTERS = [{ value: 'all', label: 'All' }, { value: 'stuck', label: 'Stuck' }]

function StageTile({ label, value, loading, tone, onClick }: {
  label: string; value: number | undefined; loading: boolean; tone?: 'red'; onClick?: () => void
}) {
  return (
    <StatCard label={label} value={loading ? '—' : fmtNum(value ?? 0)} tone={tone === 'red' ? 'red' : 'blue'}
      onClick={onClick}
      accent={tone === 'red' && (value ?? 0) > 0 ? <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--red-500)' }} /> : undefined} />
  )
}

export function LiveRunsTab({ token, openTrigger, goDeepDive, canTrigger }: {
  token: string; openTrigger: OpenTrigger; goDeepDive: (configId: string, configKey: string | null) => void; canTrigger: boolean
}) {
  const funnel = useQuery(api.directorEnrichment.liveStageFunnel, { token })
  const live = useQuery(api.directorEnrichment.liveRuns, { token })
  const hist = useQuery(api.vinQueueQueries.pendingAgeHistogram, { token })
  const { results, status, loadMore } = usePaginatedQuery(
    api.directorEnrichment.recentRunsPaged, { token }, { initialNumItems: 25 },
  )
  const recent = results as FunctionReturnType<typeof api.directorEnrichment.recentRunsPaged>['page']

  const [section, setSection] = useState<Section>('inflight')
  const [filter, setFilter] = useState('all')

  const stuck = funnel?.stale ?? 0
  const filteredLive = (live ?? []).filter(r => filter === 'stuck' ? r.isStale : true)

  const stuckBadge = stuck > 0
    ? <span className="mono" style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--red-50)', color: 'var(--red-700)' }}>{stuck}</span>
    : undefined

  const loading = !funnel

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Pipeline stage funnel — accurate counts (not the capped live list). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <StageTile label="In flight" value={funnel?.total} loading={loading} />
        <StageTile label="Decode" value={funnel?.stages.decode} loading={loading} />
        <StageTile label="Scrape" value={funnel?.stages.scrape} loading={loading} />
        <StageTile label="Batch 1" value={funnel?.stages.batch1} loading={loading} />
        <StageTile label="Batch 2" value={funnel?.stages.batch2} loading={loading} />
        <StageTile label="Stuck · >15m" value={funnel?.stale} loading={loading} tone="red"
          onClick={() => { setSection('inflight'); setFilter('stuck') }} />
      </div>

      <SubTabs<Section> value={section} onChange={setSection} tabs={[
        { id: 'inflight', label: 'In-flight', badge: stuckBadge },
        { id: 'backlog', label: 'Backlog' },
        { id: 'recent', label: 'Recent' },
      ]} />

      {section === 'inflight' && (
        <Panel title="In-flight runs" sub={funnel ? `${funnel.total} live · ${stuck} stuck` : undefined}
          right={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SegmentedControl value={filter} options={FILTERS} onChange={setFilter} />
            {canTrigger && stuck > 0 && (
              <Button variant="danger" size="sm" onClick={() => openTrigger({ kind: 'bulkUnstick', count: stuck })}>
                Force-unstick all stale ({stuck})
              </Button>
            )}
          </div>}>
          {!live ? <TableSkeleton /> : filteredLive.length === 0 ? (
            <Empty>{filter === 'stuck' ? 'No stale runs right now.' : 'No runs in flight right now.'}</Empty>
          ) : (
            <TableWrap>
              <thead><tr>
                <th style={th}>Config</th><th style={th}>Stage</th><th style={th}>Elapsed</th>
                <th style={th}>Heartbeat</th><th style={thRight}>Tokens</th><th style={thRight}>Cost</th><th style={thRight}></th>
              </tr></thead>
              <tbody>
                {filteredLive.map((r: LiveRow) => (
                  <tr key={r.id}>
                    <td style={td}><button className="mono" style={linkBtn} onClick={() => goDeepDive(r.configId, r.configKey)}>{r.configKey ?? '(config deleted)'}</button></td>
                    <td style={td}><StatusPill status={r.status} /></td>
                    <td style={td}>{fmtDuration(r.elapsedMs)}</td>
                    <td style={td}><span style={{ color: r.isStale ? 'var(--red-600)' : 'var(--slate-500)', fontWeight: r.isStale ? 600 : 400 }}>{timeAgo(r.lastHeartbeatAt)}{r.isStale ? ' · stale' : ''}</span></td>
                    <td style={tdRight} className="mono">{fmtNum(r.tokensIn + r.tokensOut)}</td>
                    <td style={tdRight} className="mono">{fmtCost(r.costUsd)}</td>
                    <td style={tdRight}>{r.isStale && <Button variant="danger" size="sm" onClick={() => openTrigger({ kind: 'unstick', runId: r.id, label: r.configKey ?? String(r.id) })}>Force-unstick</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          {funnel?.truncated && <div style={{ marginTop: 10, fontSize: 11, color: 'var(--slate-400)' }}>Funnel counts capped at 1,000 per stage — true totals may be higher.</div>}
        </Panel>
      )}

      {section === 'backlog' && (
        <Panel title="VIN queue backlog" sub={hist ? `${hist.total} pending` : undefined}
          right={<a href="#control-room" style={{ fontSize: 12, fontWeight: 500, color: 'var(--blue-700)', textDecoration: 'none' }}>Manage in Control Room →</a>}>
          {!hist ? <TableSkeleton rows={2} /> : hist.total === 0 ? <Empty>Queue is empty.</Empty> : (
            <div style={{ maxWidth: 440 }}>
              {([['< 1 day', hist.buckets['1d']], ['1–7 days', hist.buckets['7d']], ['7–30 days', hist.buckets['30d']], ['> 30 days', hist.buckets.older]] as const)
                .map(([label, v]) => <BarRow key={label} label={label} value={v} max={hist.total} valueLabel={fmtNum(v)} color="var(--blue-400, #60A5FA)" />)}
            </div>
          )}
        </Panel>
      )}

      {section === 'recent' && (
        <Panel title="Recent runs">
          {status === 'LoadingFirstPage' ? <TableSkeleton /> : recent.length === 0 ? <Empty>No runs recorded yet.</Empty> : (
            <>
              <TableWrap>
                <thead><tr>
                  <th style={th}>Config</th><th style={th}>Status</th><th style={thRight}>Fill</th><th style={thRight}>Quot.</th>
                  <th style={thRight}>Cost</th><th style={thRight}>Duration</th><th style={thRight}>Flags</th><th style={th}>When</th>
                </tr></thead>
                <tbody>
                  {recent.map(r => (
                    <tr key={String(r.id)}>
                      <td style={td}><button className="mono" style={linkBtn} onClick={() => goDeepDive(String(r.configId), r.configKey)}>{r.configKey ?? '(config deleted)'}</button></td>
                      <td style={td}><StatusPill status={r.status} /></td>
                      <td style={tdRight}>{fmtPct(r.fillRate)}</td>
                      <td style={tdRight}>{fmtPct(r.quotabilityPct)}</td>
                      <td style={tdRight} className="mono">{fmtCost(r.costUsd)}</td>
                      <td style={tdRight}>{fmtDuration(r.durationMs)}</td>
                      <td style={tdRight}>{r.errorCount + r.sanityFlagCount > 0 ? <span style={{ fontWeight: 600, color: 'var(--orange-700)' }}>{r.errorCount + r.sanityFlagCount}</span> : <span style={{ color: 'var(--slate-300)' }}>0</span>}</td>
                      <td style={{ ...td, color: 'var(--slate-400)' }}>{timeAgo(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              {status === 'CanLoadMore' && <div style={{ marginTop: 12 }}><Button variant="secondary" size="sm" onClick={() => loadMore(25)}>Load 25 more</Button></div>}
              {status === 'LoadingMore' && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--slate-400)' }}>Loading…</div>}
            </>
          )}
        </Panel>
      )}
    </div>
  )
}
