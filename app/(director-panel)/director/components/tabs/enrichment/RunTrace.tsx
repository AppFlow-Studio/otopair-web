'use client'

// Per-run pipeline trace — replays one enrichment run stage by stage
// (NHTSA+VDB decode → scrape → Batch 1 → Batch 2 → finalize) with each batch's
// prompt (request) and raw+parsed model output (response). Native panel styling.

import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Panel, Empty, TableSkeleton, StatusPill, fmtDuration, fmtCost, fmtWhen, fmtNum } from './helpers'

type StepRow = FunctionReturnType<typeof api.directorEnrichment.stepsForRun>[number]

const STEP_LABEL: Record<string, string> = {
  decode: '1 · NHTSA + VDB Decode',
  scrape: '2 · Scrape & Merge',
  batch1: '3 · Batch 1 — specs · parts · fluids',
  batch2: '4 · Batch 2 — gap-fill + pricing',
  finalize: '5 · Finalize',
}

function CodeBlock({ label, text }: { label: string; text: string }) {
  return (
    <details style={{ marginTop: 8, border: '1px solid var(--slate-200)', borderRadius: 8, background: 'var(--slate-50)' }}>
      <summary style={{ cursor: 'pointer', userSelect: 'none', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--slate-600)' }}>
        {label} <span style={{ fontWeight: 400, color: 'var(--slate-400)' }}>({fmtNum(text.length)} chars)</span>
      </summary>
      <pre className="mono" style={{ maxHeight: 380, overflow: 'auto', borderTop: '1px solid var(--slate-200)', background: '#fff', padding: '8px 12px', fontSize: 11, lineHeight: 1.5, color: 'var(--slate-700)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {text}
      </pre>
    </details>
  )
}

function StepCard({ s }: { s: StepRow }) {
  const hasTokens = s.tokensIn != null || s.tokensOut != null
  const dotColor = s.status === 'error' ? 'var(--red-600)' : s.status === 'timeout' ? 'var(--orange-700)' : s.status === 'submitted' ? 'var(--blue-500)' : 'var(--green-600)'
  return (
    <li style={{ position: 'relative', paddingLeft: 22, listStyle: 'none' }}>
      <span style={{ position: 'absolute', left: 0, top: 18, width: 11, height: 11, borderRadius: 999, background: dotColor, boxShadow: '0 0 0 3px #fff' }} />
      <div style={{ border: '1px solid var(--slate-200)', borderRadius: 10, background: '#fff', padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-900)' }}>{STEP_LABEL[s.step] ?? s.step}</span>
          {s.status && <StatusPill status={s.status} />}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--slate-500)' }}>
            {s.durationMs != null && <span>{fmtDuration(s.durationMs)}</span>}
            {hasTokens && <span className="mono">{fmtNum((s.tokensIn ?? 0) + (s.tokensOut ?? 0))} tok{s.webSearches ? ` · ${s.webSearches} search` : ''}</span>}
            {s.costUsd > 0 && <span className="mono" style={{ color: 'var(--green-700)' }}>{fmtCost(s.costUsd)}</span>}
            {s.startedAt && <span style={{ color: 'var(--slate-400)' }}>{fmtWhen(s.startedAt)}</span>}
          </span>
        </div>
        {s.summary && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--slate-600)' }}>{s.summary}</div>}
        {s.truncated && <div style={{ marginTop: 4, fontSize: 11, color: 'var(--orange-700)' }}>Captured text was truncated to fit.</div>}
        {s.requestText && <CodeBlock label="Request / prompt" text={s.requestText} />}
        {s.responseText && <CodeBlock label="Response (raw + parsed)" text={s.responseText} />}
      </div>
    </li>
  )
}

export function RunTrace({ token, runId }: { token: string; runId: Id<'enrichment_runs'> | null }) {
  const steps = useQuery(api.directorEnrichment.stepsForRun, runId ? { token, enrichmentRunId: runId } : 'skip')
  return (
    <Panel title="Pipeline trace" sub="selected run, step by step">
      {!runId ? <Empty>No run selected.</Empty> :
        steps === undefined ? <TableSkeleton /> :
          steps.length === 0 ? (
            <Empty>No stage trace for this run. Only runs enriched after the trace instrumentation shipped record per-stage prompts and responses — re-run this VIN to capture one.</Empty>
          ) : (
            <ol style={{ margin: 0, padding: 0, borderLeft: '1px solid var(--slate-200)' }}>
              {steps.map(s => <StepCard key={String(s.id)} s={s} />)}
            </ol>
          )}
    </Panel>
  )
}
