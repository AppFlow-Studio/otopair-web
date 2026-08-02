'use client'

// Tab 4 · Flags & Quality — flag taxonomy with per-flag run drill-down, fill /
// quotability distributions vs the completion gate, and field-family coverage.
// The review queue itself (claim / resolve / dismiss) lives in the Needs
// Attention tab — this tab just summarizes counts by stream and links there.
// Native panel styling.

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { BarRow, Histogram, InfoTip } from '../../Charts'
import { SegmentedControl, Button } from '../../Primitives'
import {
  Panel, Empty, SkeletonBlock, TableWrap, th, td, thRight, tdRight,
  StatusPill, fmtPct, fmtNum, timeAgo,
} from './helpers'

const WINDOWS = [{ value: '7', label: '7d' }, { value: '14', label: '14d' }, { value: '30', label: '30d' }]

type FamilyMeta = {
  families?: Record<string, { filled: number; total: number }>
  parts_quotability?: { avg_pct: number; samples: number }
}
type Drill = { kind: 'error' | 'sanityField' | 'partMake'; key: string }

/** BarRow wrapped in a clickable affordance, with a selected highlight. */
function ClickableBar({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClick} title="Show the runs behind this flag"
      style={{ cursor: 'pointer', borderRadius: 6, padding: '0 6px', margin: '0 -6px',
        background: selected ? 'var(--blue-50)' : 'transparent', transition: 'background 100ms' }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
      {children}
    </div>
  )
}

export function FlagsTab({ token, goDeepDive, goTab }: {
  token: string
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
  goTab: (t: string) => void
}) {
  const [win, setWin] = useState('14')
  const [drill, setDrill] = useState<Drill | null>(null)
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null)

  const tax = useQuery(api.directorEnrichment.flagTaxonomy, { token, days: Number(win) })
  const dist = useQuery(api.directorEnrichment.qualityDistributions, { token, days: Number(win) })
  const review = useQuery(api.directorEnrichment.reviewQueueOpen, { token })
  const famStat = useQuery(api.portalStats.getStats, { token, keys: ['data.coverage.field_families'] })
  const drillRuns = useQuery(api.directorEnrichment.runsForFlag,
    drill ? { token, days: Number(win), kind: drill.kind, key: drill.key } : 'skip')

  const famMeta = (famStat?.['data.coverage.field_families']?.meta ?? null) as FamilyMeta | null
  const familyRows = Object.entries(famMeta?.families ?? {})
    .map(([family, f]) => ({ family, frac: f.total > 0 ? f.filled / f.total : 0, filled: f.filled, total: f.total, sub: `${f.filled}/${f.total}` }))
    .sort((a, b) => a.frac - b.frac)

  const maxErr = Math.max(1, ...(tax?.errorBuckets ?? []).map(b => b.count))
  const maxField = Math.max(1, ...(tax?.sanityByField ?? []).map(b => b.count))
  const maxMake = Math.max(1, ...(tax?.partPatternByMake ?? []).map(b => b.count))

  // Review-queue stream breakdown (where issues come from).
  const streamCounts = (review ?? []).reduce<Record<string, number>>((m, r) => { m[r.sourceStream] = (m[r.sourceStream] ?? 0) + 1; return m }, {})

  const isSel = (kind: Drill['kind'], key: string) => drill?.kind === kind && drill.key === key

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <SegmentedControl value={win} options={WINDOWS} onChange={setWin} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Panel title="Error flags" sub={tax ? `${tax.runsWithAnyFlag}/${tax.runsScanned} runs flagged` : undefined}
          right={<InfoTip width={240} content={<>Runs’ <span className="mono">errors[]</span> bucketed by prefix. Click a bar to list the exact runs that raised it and why.</>} />}>
          {!tax ? <SkeletonBlock height={160} /> : tax.errorBuckets.length === 0 ? <Empty>No error flags in this window.</Empty> :
            tax.errorBuckets.map(b => (
              <ClickableBar key={b.key} selected={isSel('error', b.key)} onClick={() => setDrill(isSel('error', b.key) ? null : { kind: 'error', key: b.key })}>
                <BarRow label={b.key} value={b.count} max={maxErr} valueLabel={fmtNum(b.count)} color="var(--yellow-800)" barBg="var(--yellow-50)" />
              </ClickableBar>
            ))}
        </Panel>

        <Panel title="Sanity flags"
          right={<InfoTip width={240} content={<>Structured finalize-pass flags. <b>reject</b> blocks completion; <b>flag</b> is advisory. Click a field to list the runs behind it.</>} />}>
          {!tax ? <SkeletonBlock height={160} /> : (
            <div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                <div style={{ border: '1px solid #FECACA', background: 'var(--red-50)', borderRadius: 8, padding: '8px 14px' }}>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--red-700)' }}>{fmtNum(tax.sanityBySeverity.reject)}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--red-600)' }}>reject</div>
                </div>
                <div style={{ border: '1px solid #FDE68A', background: 'var(--yellow-50)', borderRadius: 8, padding: '8px 14px' }}>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--yellow-800)' }}>{fmtNum(tax.sanityBySeverity.flag)}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--yellow-800)' }}>flag</div>
                </div>
              </div>
              {tax.sanityByField.length === 0 ? <Empty>No sanity flags in this window.</Empty> :
                tax.sanityByField.slice(0, 8).map(f => (
                  <ClickableBar key={f.field} selected={isSel('sanityField', f.field)} onClick={() => setDrill(isSel('sanityField', f.field) ? null : { kind: 'sanityField', key: f.field })}>
                    <BarRow label={f.field} value={f.count} max={maxField} valueLabel={fmtNum(f.count)} color="var(--red-600)" barBg="var(--red-50)" />
                  </ClickableBar>
                ))}
            </div>
          )}
        </Panel>
      </div>

      {tax && tax.partPatternByMake.length > 0 && (
        <Panel title="Suspect part patterns" sub="by make"
          right={<InfoTip width={230} content={<>Makes whose runs raised <span className="mono">part_pattern_suspect</span>. Click to see the offending runs.</>} />}>
          {tax.partPatternByMake.map(m => (
            <ClickableBar key={m.make} selected={isSel('partMake', m.make)} onClick={() => setDrill(isSel('partMake', m.make) ? null : { kind: 'partMake', key: m.make })}>
              <BarRow label={m.make} value={m.count} max={maxMake} valueLabel={fmtNum(m.count)} color="var(--red-600)" barBg="var(--red-50)" />
            </ClickableBar>
          ))}
        </Panel>
      )}

      {drill && (
        <Panel title={`Runs behind "${drill.key}"`} sub={drillRuns ? `${drillRuns.runs.length} runs · ${win}d` : undefined}
          right={<Button variant="ghost" size="sm" onClick={() => setDrill(null)}>Close</Button>}>
          {!drillRuns ? <SkeletonBlock height={120} /> : drillRuns.runs.length === 0 ? <Empty>No runs matched in this window.</Empty> : (
            <TableWrap>
              <thead><tr>
                <th style={th}>Config</th><th style={th}>Status</th><th style={th}>Why (matched)</th><th style={thRight}>When</th>
              </tr></thead>
              <tbody>
                {drillRuns.runs.map(r => (
                  <tr key={String(r.runId)}>
                    <td style={td}><button className="mono" style={linkBtn} onClick={() => goDeepDive(String(r.configId), r.configKey, String(r.runId))}>{r.configKey ?? '(config deleted)'}</button></td>
                    <td style={td}><StatusPill status={r.status} /></td>
                    <td style={{ ...td, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="mono" title={r.matched.join(' · ')}>{r.matched.join(' · ')}</td>
                    <td style={{ ...tdRight, color: 'var(--slate-400)' }}>{timeAgo(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          {drillRuns?.truncated && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--slate-400)' }}>Scan capped at 1,000 runs — older matches excluded.</div>}
        </Panel>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Panel title="Fill-rate distribution" sub={dist ? `${dist.configsScanned} configs · gate ≥70` : undefined}
          right={<InfoTip width={250} content={<>Configs binned by fill-rate (0–9 … 90–100). The dashed line is the completion gate (fill ≥ 70); green bars are at or above it. Left of the line = incomplete.</>} />}>
          {!dist ? <SkeletonBlock height={160} /> : (
            <Histogram gateLabel="gate ≥70"
              bins={dist.fillRateHist.map(b => ({ label: b.bucket, count: b.count, pass: Number(b.bucket.split('-')[0]) >= 70 }))} />
          )}
        </Panel>
        <Panel title="Quotability distribution" sub={dist ? `${dist.runsScanned} runs · gate ≥80` : undefined}
          right={<InfoTip width={250} content={<>Runs binned by parts quotability %. The dashed line is the gate (quotability ≥ 80): can every core service be quoted with a fitment and a trusted price. Left of the line = unquotable.</>} />}>
          {!dist ? <SkeletonBlock height={160} /> : (
            <Histogram gateLabel="gate ≥80"
              bins={dist.quotabilityHist.map(b => ({ label: b.bucket, count: b.count, pass: Number(b.bucket.split('-')[0]) >= 80 }))} />
          )}
        </Panel>
      </div>

      <Panel title="Field-family coverage" sub={famMeta?.parts_quotability ? `avg quotability ${fmtPct(famMeta.parts_quotability.avg_pct)}` : undefined}
        right={<InfoTip width={260} content={<>Each family is a group of related fields (e.g. brakes, fluids). % = filled ÷ total across enriched configs, sorted worst-first — the families where enrichment is leaving the most gaps. Click a family for how to fix it.</>} />}>
        {!famStat ? <SkeletonBlock height={160} /> : familyRows.length === 0 ? <Empty>No coverage snapshot yet.</Empty> :
          familyRows.map(r => (
            <div key={r.family}>
              <div onClick={() => setExpandedFamily(expandedFamily === r.family ? null : r.family)} style={{ cursor: 'pointer' }}>
                <BarRow label={r.family} value={r.frac} max={1} valueLabel={`${Math.round(r.frac * 100)}% · ${r.sub}`}
                  color={r.frac < 0.5 ? 'var(--red-600)' : 'var(--teal-700)'} barBg="var(--teal-50)" />
              </div>
              {expandedFamily === r.family && (
                <div style={{ margin: '2px 0 10px', padding: '10px 12px', background: 'var(--slate-50)', border: '1px solid var(--slate-100)', borderRadius: 8, fontSize: 12, color: 'var(--slate-600)', lineHeight: 1.6 }}>
                  <b>{r.total - r.filled}</b> of {r.total} <span className="mono">{r.family}</span> fields are empty across enriched configs.
                  To lift coverage, find low-fill configs in this family and re-enrich them: open <b>Deep-Dive</b>, pick an affected config by VIN or config_key,
                  and use <b>Re-run</b> — the gap-fill pass targets empty fields. Persistent gaps usually mean a missing source domain or an applicability rule zeroing the field out.
                </div>
              )}
            </div>
          ))}
      </Panel>

      <Panel title="Open review queue" sub={review ? `${review.length} items` : undefined}
        right={<Button variant="secondary" size="sm" onClick={() => goTab('attention')}>Open Needs Attention →</Button>}>
        {!review ? <SkeletonBlock height={60} /> : review.length === 0 ? <Empty>Review queue is clear.</Empty> : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(streamCounts).map(([s, n]) => (
              <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', borderRadius: 8, background: 'var(--slate-50)', border: '1px solid var(--slate-200)' }}>
                <span style={{ color: 'var(--slate-600)' }}>{s}</span>
                <b className="mono" style={{ color: 'var(--slate-900)' }}>{n}</b>
              </span>
            ))}
          </div>
        )}
      </Panel>

      <div style={{ fontSize: 12, color: 'var(--slate-400)', padding: '0 2px' }}>
        Completion gate (completionGate.ts): a config is <b>complete</b> only at fill-rate ≥ 70 AND quotability ≥ 0.8.
        {tax?.truncated ? ' Flag window truncated at 1000 runs.' : ''} {fmtNum(tax?.runsScanned ?? 0)} runs scanned.
      </div>
    </div>
  )
}

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }
