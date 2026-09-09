'use client'

// Tab · Road to 1.0 — the fleet quotability program, live. Until Sep 2026
// this census (bands, blocker cohorts, role-gap ranking) only existed in
// operator sessions and devOnly tooling, and the nightly legs that drain the
// cohorts reported to console alone. This tab is the standing surface:
//   · band histogram + fleet counts
//   · cohort cards → member drill-down (rows jump to Deep-Dive)
//   · fleet-wide role-gap + unpriced-service rankings
//   · standing-legs panel: which nightly legs are lit, their budgets, and
//     how much of the fleet their rotation stamps touched in the last 36h
// Data: api.directorRoadTo10.census — one bounded pass, recomputed per open.

import { useMemo, useState } from 'react'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '@/convex/_generated/api'
import { StatCard, BarRow } from '../../Charts'
import { Panel, Empty, StatusPill, SkeletonBlock, fmtNum } from './helpers'

type Census = FunctionReturnType<typeof api.directorRoadTo10.census>
type Cohort = Census['cohorts'][number]

const COHORT_META: Record<string, { label: string; hint: string; tone: 'slate' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' }> = {
  price_only:       { label: 'Price-only',        hint: 'Every fitment present — a price away from 1.0. Drained by the zero-price sweep.', tone: 'blue' },
  consumables_only: { label: 'Consumables-only',  hint: 'Missing only ATF / battery / coolant. Drained by the cohort dispatcher.', tone: 'purple' },
  synthetic_key:    { label: 'Synthetic identity', hint: 'Config keys minted from corrupt engine data (_2l_2cyl era). Needs re-decode + merge.', tone: 'yellow' },
  deep_tail:        { label: 'Deep tail',         hint: '4+ distinct roles missing — full re-enrich territory.', tone: 'red' },
  never_run:        { label: 'Never run',         hint: 'Pending or stuck mid-enrichment — no terminal run yet.', tone: 'slate' },
  thin_fill:        { label: 'Thin fill @ high q', hint: 'Quotable (≥0.9) but fill under the 70 gate — needs spec gap-fill, not parts.', tone: 'green' },
}

const BAND_ROWS = [
  { key: 'at10',       label: 'At 1.0',      color: 'var(--green-600)' },
  { key: 'b90',        label: '0.90 – 0.99', color: 'var(--green-500)' },
  { key: 'b80',        label: '0.80 – 0.89', color: 'var(--yellow-600)' },
  { key: 'b70',        label: '0.70 – 0.79', color: 'var(--orange-700)' },
  { key: 'below70',    label: 'Below 0.70',  color: 'var(--red-600)' },
  { key: 'noSnapshot', label: 'No snapshot', color: 'var(--slate-400)' },
] as const

const GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }

export function RoadTo10Tab({ token, goDeepDive }: {
  token: string
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const census = useQuery(api.directorRoadTo10.census, { token })
  const [cohortKey, setCohortKey] = useState<string>('price_only')

  const selected: Cohort | null = useMemo(
    () => census?.cohorts.find((c) => c.key === cohortKey) ?? null,
    [census, cohortKey],
  )

  if (census === undefined) return <SkeletonBlock height={420} />

  const { bands, fleet, legs } = census
  const bandMax = Math.max(...BAND_ROWS.map((b) => bands[b.key]), 1)
  const roleMax = Math.max(...census.roleGaps.map((r) => r.count), 1)
  const svcMax = Math.max(...census.unpricedByService.map((r) => r.count), 1)
  const at10Pct = fleet.measured > 0 ? Math.round((bands.at10 / fleet.operational) * 100) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Headline tiles ─────────────────────────────────────────────── */}
      <div style={GRID}>
        <StatCard label="At quotability 1.0" value={fmtNum(bands.at10)} tone="green"
          hint={`${at10Pct}% of the operational fleet`} />
        <StatCard label="At ≥ 0.9" value={fmtNum(bands.at10 + bands.b90)} tone="blue"
          hint={`of ${fmtNum(fleet.operational)} operational configs`} />
        <StatCard label="Measured" value={fmtNum(fleet.measured)}
          hint={`${fmtNum(bands.noSnapshot)} without a snapshot`} />
        <StatCard label="Test fixtures" value={fmtNum(fleet.fixtures)}
          hint="excluded from the denominator" />
      </div>

      {/* ── Bands + rankings ───────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <Panel title="Quotability bands" sub="Latest snapshot per operational config">
          {BAND_ROWS.map((b) => (
            <BarRow key={b.key} label={b.label} value={bands[b.key]} max={bandMax}
              valueLabel={fmtNum(bands[b.key])} color={b.color} />
          ))}
        </Panel>
        <Panel title="Missing roles fleet-wide" sub="Configs whose snapshot names the role as a core gap">
          {census.roleGaps.length === 0 && <Empty>No role gaps — the fleet is whole.</Empty>}
          {census.roleGaps.slice(0, 10).map((r) => (
            <BarRow key={r.role} label={<span className="mono">{r.role}</span>} value={r.count}
              max={roleMax} valueLabel={fmtNum(r.count)} color="var(--orange-700)" />
          ))}
        </Panel>
        <Panel title="Unpriced services" sub="Fitments present, at least one trusted price missing">
          {census.unpricedByService.length === 0 && <Empty>Every core fitment is priced.</Empty>}
          {census.unpricedByService.slice(0, 10).map((r) => (
            <BarRow key={r.slug} label={<span className="mono">{r.slug}</span>} value={r.count}
              max={svcMax} valueLabel={fmtNum(r.count)} color="var(--blue-500)" />
          ))}
        </Panel>
      </div>

      {/* ── Standing legs ──────────────────────────────────────────────── */}
      <Panel title="Standing nightly legs" sub="Budget envs are read live — a dark leg is one env var from running">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          {legs.map((leg) => {
            const lit = leg.budget > 0
            return (
              <div key={leg.id} style={{ border: '1px solid var(--slate-200)', borderRadius: 8, padding: '10px 12px', background: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-900)' }}>{leg.label}</div>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: lit ? 'var(--green-50, #e8f5ec)' : 'var(--slate-100)',
                    color: lit ? 'var(--green-700, #1c6b36)' : 'var(--slate-500)',
                  }}>{lit ? `LIT · ${leg.budget} ${leg.unit}` : 'DARK'}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>{leg.what}</div>
                <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 6, display: 'flex', gap: 12 }}>
                  <span className="mono">{leg.cron}</span>
                  {!lit && <span className="mono">{leg.envVar}</span>}
                  {leg.stamped && (
                    <span>
                      rotation: {fmtNum(leg.stamped.total)} stamped
                      {leg.stamped.fresh > 0 ? ` · ${fmtNum(leg.stamped.fresh)} in 36h` : ''}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Panel>

      {/* ── Cohorts + drill-down ───────────────────────────────────────── */}
      <Panel title="Blocker cohorts" sub="Every below-1.0 config, classified by what actually blocks it (a config can sit in several)">
        <div style={{ ...GRID, marginBottom: 14 }}>
          {census.cohorts.map((c) => {
            const meta = COHORT_META[c.key] ?? { label: c.key, hint: '', tone: 'slate' as const }
            const active = c.key === cohortKey
            return (
              <button key={c.key} onClick={() => setCohortKey(c.key)}
                style={{ textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', background: 'none', border: 'none', padding: 0 }}>
                <div style={{
                  border: `1px solid ${active ? 'var(--blue-500)' : 'var(--slate-200)'}`,
                  boxShadow: active ? '0 0 0 2px var(--blue-100, #dbeafe)' : 'none',
                  borderRadius: 8, padding: '10px 12px', background: '#fff',
                }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--slate-900)' }}>{fmtNum(c.count)}</div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--slate-800)', marginTop: 2 }}>{meta.label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--slate-500)', marginTop: 2, lineHeight: 1.35 }}>{meta.hint}</div>
                </div>
              </button>
            )
          })}
        </div>

        {selected && selected.rows.length === 0 && <Empty>This cohort is empty — nothing blocked here.</Empty>}
        {selected && selected.rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--slate-500)' }}>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Vehicle</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Status</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Quotability</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Fill</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Blockers</th>
                </tr>
              </thead>
              <tbody>
                {selected.rows.map((r) => (
                  <tr key={r.configId} onClick={() => goDeepDive(r.configId, r.configKey)}
                    style={{ borderTop: '1px solid var(--slate-100)', cursor: 'pointer' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}>
                    <td style={{ padding: '7px 8px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--slate-900)' }}>{r.vehicle}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--slate-400)' }}>{r.configKey ?? r.configId}</div>
                    </td>
                    <td style={{ padding: '7px 8px' }}>{r.status ? <StatusPill status={r.status} /> : '—'}</td>
                    <td className="mono" style={{ padding: '7px 8px' }}>{r.q == null ? '—' : r.q.toFixed(2)}</td>
                    <td className="mono" style={{ padding: '7px 8px' }}>{r.fill == null ? '—' : `${Math.round(r.fill)}%`}</td>
                    <td style={{ padding: '7px 8px', color: 'var(--slate-600)', maxWidth: 420 }}>{r.blockers || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {selected.count > selected.rows.length && (
              <div style={{ fontSize: 11.5, color: 'var(--slate-500)', padding: '8px 8px 0' }}>
                Showing {selected.rows.length} of {selected.count}.
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  )
}
