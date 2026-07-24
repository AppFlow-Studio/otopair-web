'use client'

// Tab 5 · Deep-Dive — one config end-to-end: variant facets, latest run +
// flags, run timeline, pipeline trace, parts + prices, evidence. Config chosen
// via a compact native picker (VIN / config_key). Native panel styling.

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Input, MicroH } from '../../Primitives'
import { IconSearch } from '../../Primitives'
import {
  Panel, Empty, TableSkeleton, TableWrap, th, td, thRight, tdRight,
  SkeletonBlock, StatusPill, fmtPct, fmtCost, fmtDuration, timeAgo, fmtWhen, type OpenTrigger,
} from './helpers'
import { RunTrace } from './RunTrace'

export type PickedConfig = { id: string; config_key: string }

// ─── native config picker ────────────────────────────────────────────────────

type ConfigMatch = { id: string; config_key: string; year: number; trim_name: string | null; engine_label: string | null; enrichment_status: string | null }

function ConfigPicker({ token, selected, onSelect }: { token: string; selected: PickedConfig | null; onSelect: (c: PickedConfig | null) => void }) {
  const [mode, setMode] = useState<'VIN' | 'config_key'>('VIN')
  const [q, setQ] = useState('')
  const [armed, setArmed] = useState(false)

  const args = mode === 'VIN'
    ? (armed && q.trim().length >= 11 ? { token, vin: q.trim() } : null)
    : (q.trim().length >= 2 ? { token, search: q.trim() } : null)
  const result = useQuery(api.dataVehicleResolve.resolve, args ?? 'skip')

  const pick = (m: ConfigMatch) => { onSelect({ id: m.id, config_key: m.config_key }); setArmed(false); setQ('') }
  const tabBtn = (m: 'VIN' | 'config_key') => (
    <button onClick={() => { setMode(m); setArmed(false) }}
      style={{ padding: '5px 11px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
        background: mode === m ? 'var(--slate-900)' : 'transparent', color: mode === m ? '#fff' : 'var(--slate-600)' }}>{m}</button>
  )

  if (selected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <MicroH>Config</MicroH>
        <span className="mono" style={{ border: '1px solid var(--slate-200)', background: 'var(--slate-50)', borderRadius: 8, padding: '7px 12px', fontSize: 13, color: 'var(--slate-900)' }}>{selected.config_key}</span>
        <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>Change</Button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>{tabBtn('VIN')}{tabBtn('config_key')}</div>
      <div style={{ display: 'flex', gap: 8, maxWidth: 560 }}>
        <div style={{ flex: 1 }}>
          <Input icon={<IconSearch size={13} />} value={q}
            onChange={e => { setQ(e.target.value); setArmed(false) }}
            placeholder={mode === 'VIN' ? '17-char VIN — e.g. 2G61U5S35D9217183' : 'config_key contains…'} />
        </div>
        {mode === 'VIN' && <Button variant="dark" onClick={() => setArmed(true)}>Look up</Button>}
      </div>
      {args && (
        <div style={{ marginTop: 10, maxWidth: 560, border: '1px solid var(--slate-100)', borderRadius: 8, overflow: 'hidden' }}>
          {result === undefined ? <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--slate-500)' }}>Looking up…</div> : (
            <>
              {result.note && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--yellow-800)', background: 'var(--yellow-50)', borderBottom: '1px solid var(--slate-100)' }}>{result.note}</div>}
              {(result.matches as ConfigMatch[]).length === 0 && <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--slate-500)' }}>No matches.</div>}
              {(result.matches as ConfigMatch[]).map(m => (
                <button key={m.id} onClick={() => pick(m)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderBottom: '1px solid var(--slate-50)', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--blue-50)')} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--slate-800)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.config_key}</span>
                  {m.trim_name && <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'var(--slate-100)', color: 'var(--slate-600)' }}>{m.trim_name}</span>}
                  {m.enrichment_status && <span style={{ marginLeft: 'auto' }}><StatusPill status={m.enrichment_status} /></span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── facet + tab ─────────────────────────────────────────────────────────────

function Facet({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ marginTop: 2, fontSize: 13, color: 'var(--slate-800)' }}>{value ?? '—'}</div>
    </div>
  )
}
const facetGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }

export function DeepDiveTab({ token, selected, onSelect, openTrigger, focusRunId }: {
  token: string; selected: PickedConfig | null; onSelect: (c: PickedConfig | null) => void; openTrigger: OpenTrigger
  focusRunId?: string | null
}) {
  const configId = selected ? (selected.id as Id<'vehicle_configs'>) : null
  const ov = useQuery(api.directorEnrichment.configOverview, configId ? { token, vehicleConfigId: configId } : 'skip')
  const runs = useQuery(api.directorEnrichment.runsForConfig, configId ? { token, vehicleConfigId: configId } : 'skip')
  const parts = useQuery(api.directorEnrichment.partsForConfig, configId ? { token, vehicleConfigId: configId } : 'skip')
  const vins = useQuery(api.directorEnrichment.vinsForConfig, configId ? { token, vehicleConfigId: configId } : 'skip')
  const latestRunId = ov?.latestRun?.id ?? null
  const evidence = useQuery(api.directorEnrichment.evidenceForRun, latestRunId ? { token, enrichmentRunId: latestRunId } : 'skip')

  // A flag→run drill-down seeds the trace selection so the timeline + RunTrace
  // open on that exact run. The tab remounts on each entry (conditional render
  // in TabEnrichment), so a mount-time initializer captures the focused run.
  const [traceRunId, setTraceRunId] = useState<Id<'enrichment_runs'> | null>(
    focusRunId ? (focusRunId as Id<'enrichment_runs'>) : null,
  )
  const activeTraceRunId = traceRunId ?? latestRunId
  const vin = vins && vins.length > 0 ? vins[0].vin : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="Config"><ConfigPicker token={token} selected={selected} onSelect={onSelect} /></Panel>

      {!selected ? (
        <div style={{ border: '1px dashed var(--slate-200)', borderRadius: 10, padding: 40, textAlign: 'center' }}>
          <Empty>Pick a config by VIN or config_key to inspect it end-to-end.</Empty>
        </div>
      ) : ov === undefined ? <SkeletonBlock height={160} /> : ov === null ? <Empty>That config no longer exists.</Empty> : (
        <>
          <Panel title="Variant fingerprint" sub="resolved facets"
            right={<div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" disabled={!vin} onClick={() => vin && openTrigger({ kind: 'reenrich', vin })}>Re-run</Button>
              <Button variant="danger" size="sm" disabled={!vin} onClick={() => vin && openTrigger({ kind: 'purge', vin })}>Purge + re-enrich</Button>
            </div>}>
            <div style={facetGrid}>
              <Facet label="Vehicle" value={`${ov.facets.year} ${ov.facets.make} ${ov.facets.model}${ov.facets.trim ? ` ${ov.facets.trim}` : ''}`} />
              <Facet label="Engine" value={ov.facets.engineLabel} />
              <Facet label="Transmission" value={ov.facets.transmissionLabel} />
              <Facet label="Drivetrain" value={ov.facets.drivetrain} />
              <Facet label="Status" value={ov.facets.enrichmentStatus ? <StatusPill status={ov.facets.enrichmentStatus} /> : '—'} />
              <Facet label="Fill rate" value={fmtPct(ov.facets.fillRate)} />
              <Facet label="Confidence" value={fmtPct(ov.facets.confidenceAvg)} />
              <Facet label="VIN" value={vin ? <span className="mono">{vin}</span> : 'none attached'} />
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--slate-400)' }}>
              The full variant fingerprint is computed at decode but not persisted today (log-only) — these facets are the stored engine/transmission/drivetrain resolution.
            </div>
          </Panel>

          {ov.latestRun && (
            <Panel title="Latest run" sub={fmtWhen(ov.latestRun.at)} right={<StatusPill status={ov.latestRun.status} />}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
                <div style={{ fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.7 }}>
                  <div>Fill: <b>{fmtPct(ov.latestRun.fillRate)}</b> · Applicable: <b>{fmtPct(ov.latestRun.applicableFillRate)}</b></div>
                  <div>Quotability: <b>{fmtPct(ov.latestRun.quotabilityPct)}</b></div>
                  <div>Cost: <b>{fmtCost(ov.latestRun.costUsd)}</b></div>
                </div>
                <div>
                  <MicroH style={{ marginBottom: 4 }}>Errors ({ov.latestRun.errors.length})</MicroH>
                  {ov.latestRun.errors.length === 0 ? <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>none</div> :
                    <div className="mono" style={{ fontSize: 11, color: 'var(--orange-700)', lineHeight: 1.6 }}>{ov.latestRun.errors.slice(0, 12).map((e, i) => <div key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e}</div>)}</div>}
                </div>
                <div>
                  <MicroH style={{ marginBottom: 4 }}>Sanity ({ov.latestRun.sanityFlags.length}) · Gaps ({ov.latestRun.fieldGaps.length})</MicroH>
                  <div style={{ fontSize: 11, lineHeight: 1.6 }}>
                    {ov.latestRun.sanityFlags.slice(0, 6).map((s, i) => (
                      <div key={`s${i}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ color: s.severity === 'reject' ? 'var(--red-600)' : 'var(--orange-700)' }}>{s.severity}</span>{' '}
                        <span className="mono" style={{ color: 'var(--slate-600)' }}>{s.field}</span>: {s.reason}
                      </div>
                    ))}
                    {ov.latestRun.fieldGaps.slice(0, 6).map((g, i) => (
                      <div key={`g${i}`} style={{ color: 'var(--slate-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span className="mono">{g.field}</span>: {g.reason}</div>
                    ))}
                  </div>
                </div>
              </div>
            </Panel>
          )}

          <Panel title="Run timeline" sub="latest 20 · click a row to trace it below">
            {runs === undefined ? <TableSkeleton /> : runs.length === 0 ? <Empty>No runs for this config.</Empty> : (
              <TableWrap>
                <thead><tr>
                  <th style={th}>Status</th><th style={th}>Trigger</th><th style={thRight}>Fill</th><th style={thRight}>Quot.</th>
                  <th style={thRight}>Cost</th><th style={thRight}>Duration</th><th style={thRight}>Flags</th><th style={th}>When</th>
                </tr></thead>
                <tbody>
                  {runs.map(r => {
                    const active = r.id === activeTraceRunId
                    return (
                      <tr key={String(r.id)} onClick={() => setTraceRunId(r.id)} style={{ cursor: 'pointer', background: active ? 'var(--blue-50)' : undefined }}>
                        <td style={td}><StatusPill status={r.status} /></td>
                        <td style={{ ...td, color: 'var(--slate-500)' }}>{r.trigger ?? '—'}</td>
                        <td style={tdRight}>{fmtPct(r.fillRate)}</td>
                        <td style={tdRight}>{fmtPct(r.quotabilityPct)}</td>
                        <td style={tdRight} className="mono">{fmtCost(r.costUsd)}</td>
                        <td style={tdRight}>{fmtDuration(r.durationMs)}</td>
                        <td style={{ ...tdRight, color: 'var(--orange-700)' }}>{r.errorCount + r.sanityFlagCount || ''}</td>
                        <td style={{ ...td, color: 'var(--slate-400)' }}>{timeAgo(r.at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </TableWrap>
            )}
          </Panel>

          <RunTrace token={token} runId={activeTraceRunId} />

          <Panel title="Parts & fitments" sub={parts ? String(parts.length) : undefined}>
            {parts === undefined ? <TableSkeleton /> : parts.length === 0 ? <Empty>No parts attached to this config.</Empty> : (
              <TableWrap>
                <thead><tr>
                  <th style={th}>OEM #</th><th style={th}>Part</th><th style={th}>Role</th>
                  <th style={thRight}>Conf.</th><th style={thRight}>Sources</th><th style={thRight}>Price</th>
                </tr></thead>
                <tbody>
                  {parts.map(p => (
                    <tr key={String(p.fitmentId)}>
                      <td style={td} className="mono">{p.oemNumber}</td>
                      <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</td>
                      <td style={{ ...td, color: 'var(--slate-500)' }}>{p.serviceRole ?? '—'}</td>
                      <td style={tdRight}>{fmtPct(p.confidence)}</td>
                      <td style={{ ...tdRight, color: 'var(--slate-500)' }}>{p.sourceCount ?? '—'}</td>
                      <td style={tdRight}>{p.price != null ? fmtCost(p.price) : <span style={{ color: 'var(--red-600)' }}>no price</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Panel>

          <Panel title="Evidence" sub={latestRunId ? 'latest run' : undefined}>
            {!latestRunId ? <Empty>No run to show evidence for.</Empty> :
              evidence === undefined ? <TableSkeleton /> : evidence.length === 0 ? <Empty>No evidence recorded for the latest run.</Empty> : (
                <TableWrap>
                  <thead><tr>
                    <th style={th}>Field</th><th style={th}>Value</th><th style={th}>Source</th><th style={thRight}>Conf.</th>
                  </tr></thead>
                  <tbody>
                    {evidence.slice(0, 100).map((e, i) => (
                      <tr key={i}>
                        <td style={td} className="mono">{e.field}</td>
                        <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.value ?? '—'}</td>
                        <td style={{ ...td, color: 'var(--slate-500)' }}>{e.sourceDomain ?? '—'}</td>
                        <td style={tdRight}>{fmtPct(e.confidence)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
          </Panel>
        </>
      )}
    </div>
  )
}
