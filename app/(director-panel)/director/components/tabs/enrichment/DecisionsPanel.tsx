'use client'

// Deep-Dive · Decisions — the run's thought process as a timeline. Every row
// is one choice the pipeline made (enrichment_decisions): which branch fired,
// what it considered, why, at what cost. Two sections: decisions taken INSIDE
// the run (identity chain, batch-2 health, verify verdicts, finalize gate)
// and everything that happened to the config AFTER it (heal rungs, nightly-leg
// dispatches, gate re-evaluations with their trigger). Expand a row for the
// full reason / evidence / env-flag snapshot.

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Panel, Empty, SkeletonBlock } from './helpers'

const STAGE_COLORS: Record<string, string> = {
  admission: 'var(--slate-500)',
  identity: 'var(--purple-600, #7c3aed)',
  scrape: 'var(--blue-500)',
  batch2: 'var(--blue-600)',
  verify: 'var(--orange-700)',
  gate: 'var(--green-600)',
  heal: 'var(--yellow-600, #ca8a04)',
  leg: 'var(--slate-600)',
}

const OUTCOME_STYLE: Record<string, { bg: string; fg: string }> = {
  ok: { bg: 'var(--green-50, #e8f5ec)', fg: 'var(--green-700, #1c6b36)' },
  promoted: { bg: 'var(--green-50, #e8f5ec)', fg: 'var(--green-700, #1c6b36)' },
  noop: { bg: 'var(--slate-100)', fg: 'var(--slate-500)' },
  skipped: { bg: 'var(--slate-100)', fg: 'var(--slate-500)' },
  held: { bg: 'var(--yellow-50, #fef9e7)', fg: 'var(--yellow-700, #a16207)' },
  unchanged: { bg: 'var(--slate-100)', fg: 'var(--slate-500)' },
  rejected: { bg: 'var(--red-50, #fdecea)', fg: 'var(--red-700, #b91c1c)' },
  error: { bg: 'var(--red-50, #fdecea)', fg: 'var(--red-700, #b91c1c)' },
}

type DecisionRow = {
  id: string
  at: number
  stage: string
  key: string
  chosen: string
  alternatives: string[]
  reason: string
  evidence: string[]
  outcome: string | null
  cost: { tokens_in?: number; tokens_out?: number; web_searches?: number; ms?: number } | null
  flags: string | null
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function DecisionRowView({ d }: { d: DecisionRow }) {
  const [open, setOpen] = useState(false)
  const oc = d.outcome ? OUTCOME_STYLE[d.outcome] ?? OUTCOME_STYLE.noop : null
  return (
    <div style={{ borderTop: '1px solid var(--slate-100)' }}>
      <button onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', textAlign: 'left',
          padding: '8px 4px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5 }}>
        <span style={{ color: 'var(--slate-400)', fontSize: 11, whiteSpace: 'nowrap' }}>{fmtClock(d.at)}</span>
        <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: STAGE_COLORS[d.stage] ?? 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {d.stage}
        </span>
        <span className="mono" style={{ color: 'var(--slate-500)', fontSize: 11.5 }}>{d.key}</span>
        <span style={{ fontWeight: 600, color: 'var(--slate-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {d.chosen}
        </span>
        {oc && d.outcome && (
          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: oc.bg, color: oc.fg, whiteSpace: 'nowrap' }}>
            {d.outcome}
          </span>
        )}
        <span style={{ color: 'var(--slate-400)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 4px 10px 4px', fontSize: 12, color: 'var(--slate-600)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ lineHeight: 1.5 }}>{d.reason}</div>
          {d.evidence.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {d.evidence.map((e, i) => (
                <span key={i} className="mono" style={{ fontSize: 10.5, background: 'var(--slate-100)', borderRadius: 4, padding: '1px 6px' }}>{e}</span>
              ))}
            </div>
          )}
          {d.alternatives.length > 0 && (
            <div style={{ fontSize: 11.5 }}>
              <span style={{ color: 'var(--slate-400)' }}>considered: </span>
              {d.alternatives.join(' · ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--slate-400)' }} className="mono">
            {d.flags && <span>{d.flags}</span>}
            {d.cost?.web_searches != null && <span>{d.cost.web_searches} searches</span>}
            {d.cost?.tokens_out != null && <span>{d.cost.tokens_out} tok out</span>}
            {d.cost?.ms != null && <span>{Math.round(d.cost.ms / 1000)}s</span>}
          </div>
        </div>
      )}
    </div>
  )
}

export function DecisionsPanel({ token, runId }: { token: string; runId: Id<'enrichment_runs'> | null }) {
  const data = useQuery(
    api.directorRoadTo10.runDecisions,
    runId ? { token, runId } : 'skip',
  )
  if (!runId) return null
  if (data === undefined) return <Panel title="Decisions"><SkeletonBlock height={80} /></Panel>
  const empty = data.inRun.length === 0 && data.postRun.length === 0
  return (
    <Panel title="Decisions" sub="The pipeline's recorded choices — expand a row for the why, the evidence, and the env flags it consulted">
      {empty && (
        <Empty>
          No decision events for this run — the decision stream started Sep 7 2026; older runs predate it.
        </Empty>
      )}
      {data.inRun.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--slate-400)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '2px 0 2px 4px' }}>
            During the run · {data.inRun.length}
          </div>
          {data.inRun.map((d) => <DecisionRowView key={d.id} d={d as DecisionRow} />)}
        </div>
      )}
      {data.postRun.length > 0 && (
        <div style={{ marginTop: data.inRun.length > 0 ? 14 : 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--slate-400)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '2px 0 2px 4px' }}>
            After the run — heals, legs & gate re-asks · {data.postRun.length}
          </div>
          {data.postRun.map((d) => <DecisionRowView key={d.id} d={d as DecisionRow} />)}
        </div>
      )}
    </Panel>
  )
}
