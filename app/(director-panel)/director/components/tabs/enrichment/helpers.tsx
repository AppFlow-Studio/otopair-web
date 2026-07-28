'use client'

// Enrichment tab — shared primitives, built natively on the director panel's
// inline-style design system (Primitives + Charts), NOT Tailwind. Palette via
// the panel's CSS vars (--slate-*, --green-*, --red-*, …).

import { Component, useState, type ReactNode, type CSSProperties, type MouseEvent } from 'react'
import type { FunctionReturnType } from 'convex/server'
import { api } from '@/convex/_generated/api'
import { Badge, Button, Card, MicroH, Modal, tableStyles } from '../../Primitives'

// ─── formatting (pure) ───────────────────────────────────────────────────────

export function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
/** Tolerates both 0–1 and 0–100 encodings. */
export function fmtPct(rate: number | null | undefined, digits = 0): string {
  if (rate == null) return '—'
  const pct = rate <= 1 ? rate * 100 : rate
  return `${pct.toFixed(digits)}%`
}
export function fmtCost(usd: number | null | undefined, digits = 2): string {
  if (usd == null) return '—'
  return `$${usd.toFixed(digits)}`
}
export function timeAgo(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const m = Math.floor((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
export function fmtNum(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

// Client mirror of convex/portalStats.ts SLO_THRESHOLDS (not exported to the
// client bundle). Keep in sync.
export const SLO_BANDS: Record<string, { target: number; alert: number; direction: 'above' | 'below' }> = {
  'slo.enrichment_success_rate_7d': { target: 0.8, alert: 0.7, direction: 'above' },
  'slo.avg_confidence': { target: 0.75, alert: 0.65, direction: 'above' },
  'slo.review_queue_depth': { target: 50, alert: 100, direction: 'below' },
}

// ─── status pill ─────────────────────────────────────────────────────────────

const LIVE = new Set(['started', 'scraping', 'batch1', 'batch2'])
type Tone = 'slate' | 'green' | 'yellow' | 'blue' | 'red' | 'orange'

export function statusTone(status: string): Tone {
  if (status === 'complete' || status === 'ok') return 'green'
  if (status === 'failed' || status === 'error') return 'red'
  if (status === 'timeout') return 'orange'
  if (status === 'partial') return 'yellow'
  if (status === 'submitted' || LIVE.has(status)) return 'blue'
  return 'slate'
}
export function StatusPill({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>
}

// ─── run reference ───────────────────────────────────────────────────────────

/** Status pill + last-8-of-id, clickable through to Deep-Dive. Shared by any
 *  surface that can point at the enrichment_run behind a row so a director
 *  can jump straight into investigating it. `approx` marks a best-effort
 *  link (the LATEST run for this vehicle, not necessarily the exact run that
 *  produced this specific row — part_fitments carries no run_id of its own,
 *  unlike review_queue's consensus stream which does) — shown as a dashed
 *  underline with a clarifying tooltip instead of claiming false precision. */
export function RunChip({ runId, runStatus, onOpen, approx }: {
  runId: string | null; runStatus: string | null; onOpen: () => void; approx?: boolean
}) {
  if (!runId) return <span style={{ fontSize: 11, color: 'var(--slate-300)' }}>—</span>
  return (
    <button type="button" onClick={e => { e.stopPropagation(); onOpen() }}
      title={approx ? 'Latest enrichment run for this vehicle — not necessarily the exact run that produced this row. Opens in Deep-Dive.' : 'Open this run in Deep-Dive'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
      <StatusPill status={runStatus ?? 'unknown'} />
      <span className="mono" style={{ fontSize: 11, color: 'var(--blue-700)', fontWeight: 500, textDecoration: approx ? 'underline dashed' : 'underline' }}>
        …{runId.slice(-8)}
      </span>
    </button>
  )
}

// ─── date-range filter ───────────────────────────────────────────────────────

const dateFilterInput: CSSProperties = { border: '1px solid var(--slate-200)', borderRadius: 6, padding: '5px 8px', fontSize: 12, color: 'var(--slate-700)', background: '#fff', fontFamily: 'inherit', height: 30 }

/** From/to native date pickers, shared by every table that lets a director
 *  filter rows by when they appeared. Values are yyyy-mm-dd strings (native
 *  <input type="date"> format) or '' for unset. */
export function DateRangeFilter({ from, to, onFrom, onTo }: {
  from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input type="date" value={from} onChange={e => onFrom(e.target.value)} style={dateFilterInput} title="From date" />
      <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>–</span>
      <input type="date" value={to} onChange={e => onTo(e.target.value)} style={dateFilterInput} title="To date" />
      {(from || to) && (
        <button type="button" onClick={() => { onFrom(''); onTo('') }}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--slate-400)', fontSize: 12, fontFamily: 'inherit' }}>
          ✕
        </button>
      )}
    </div>
  )
}

/** Whether a timestamp falls within an (inclusive) yyyy-mm-dd from/to range.
 *  Empty from/to means unbounded on that side. */
export function dateInRange(ms: number, from: string, to: string): boolean {
  if (from && ms < new Date(`${from}T00:00:00`).getTime()) return false
  if (to && ms > new Date(`${to}T23:59:59.999`).getTime()) return false
  return true
}

// ─── provenance (enrichment_evidence source_type + URL) ──────────────────────

const SOURCE_TONE: Record<string, Tone> = {
  nhtsa: 'blue',
  scraped: 'green',
  web_search: 'yellow',
  training_data: 'slate',
  gap_fill: 'orange',
  consensus_review: 'slate',
  anomaly_detection: 'red',
  mechanic: 'green',
}

export function SourceTypeBadge({ type }: { type: string | null | undefined }) {
  if (!type) return <span style={{ color: 'var(--slate-400)' }}>—</span>
  return <Badge tone={SOURCE_TONE[type] ?? 'slate'}>{type.replace(/_/g, ' ')}</Badge>
}

function hostnameOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

/** Where a fact came from: clickable domain when a URL exists, plain domain
 *  otherwise. stopPropagation so it works inside clickable rows. */
export function SourceChip({ url, domain }: { url: string | null | undefined; domain: string | null | undefined }) {
  const label = domain ?? (url ? hostnameOf(url) : null)
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
        title={url}
        style={{ fontSize: 12, color: 'var(--blue-600)', textDecoration: 'none', display: 'inline-block',
          maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
        {label ?? url} ↗
      </a>
    )
  }
  return <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>{label ?? '—'}</span>
}

const URL_SPLIT_RE = /(https?:\/\/[^\s)]+)/g

/** Renders free text (e.g. a sanity-flag `reason` string) with any embedded
 *  http(s) URL swapped for a clickable domain link — sanityChecks.ts embeds
 *  the actual source_url inline in reasons like "…dropped: sole source is a
 *  low-authority forum page (https://…)" and that URL was otherwise dead
 *  text a director couldn't click through to verify. */
export function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_SPLIT_RE)
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
            title={part}
            style={{ color: 'var(--blue-600)', textDecoration: 'none', wordBreak: 'break-word' }}>
            {hostnameOf(part) ?? part} ↗
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

// ─── copy-to-clipboard ───────────────────────────────────────────────────────

const CopyIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

/** Click-to-copy value chip — for VIN / YMMT / config-key fields a director
 *  needs to paste into a VIN decoder or manufacturer lookup. `mono` renders
 *  the value in a monospace face (ids/VINs); leave it off for prose (YMMT). */
export function CopyableMono({ value, label, mono = true, style }: {
  value: string; label?: ReactNode; mono?: boolean; style?: CSSProperties
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button type="button" title={`Copy ${typeof label === 'string' ? label : 'value'} to clipboard`}
      onClick={(e: MouseEvent) => { e.stopPropagation(); void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${copied ? 'var(--green-200, #BBF7D0)' : 'var(--slate-200)'}`,
        background: copied ? 'var(--green-50)' : '#fff', borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
        fontSize: 12, fontFamily: 'inherit', color: copied ? 'var(--green-700)' : 'var(--slate-700)',
        transition: 'background 120ms, border-color 120ms', ...style }}
      onMouseEnter={e => { if (!copied) (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
      onMouseLeave={e => { if (!copied) (e.currentTarget as HTMLElement).style.background = '#fff' }}>
      {label && <span style={{ color: 'var(--slate-400)', fontWeight: 500 }}>{label}</span>}
      <span style={{ fontFamily: mono ? 'ui-monospace, monospace' : 'inherit', fontWeight: 500 }}>{value}</span>
      {copied ? <span>✓</span> : <CopyIcon />}
    </button>
  )
}

// ─── layout primitives ───────────────────────────────────────────────────────

export function Panel({ title, sub, right, children, style }: {
  title: string; sub?: string; right?: ReactNode; children: ReactNode; style?: CSSProperties
}) {
  return (
    <Card style={{ padding: 16, boxShadow: '0 1px 2px rgba(15,23,42,.05)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--slate-900)' }}>
          {title}
          {sub && <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--slate-400)' }}>· {sub}</span>}
        </div>
        {right}
      </div>
      {children}
    </Card>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, color: 'var(--slate-400)', padding: '4px 0' }}>{children}</div>
}

export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return <div className="animate-pulse" style={{ height, background: 'var(--slate-100)', borderRadius: 8 }} />
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="animate-pulse" style={{ height: 32, background: 'var(--slate-100)', borderRadius: 6 }} />
      ))}
    </div>
  )
}

/** Scrollable table shell using the panel's tableStyles. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--slate-100)', borderRadius: 8 }}>
      <table style={tableStyles.table}>{children}</table>
    </div>
  )
}
export const th = tableStyles.th
export const td = tableStyles.td
export const thRight: CSSProperties = { ...tableStyles.th, textAlign: 'right' }
export const tdRight: CSSProperties = { ...tableStyles.td, textAlign: 'right' }
export const tdMono: CSSProperties = { ...tableStyles.td }

export const pageBtn: CSSProperties = { border: '1px solid var(--slate-200)', background: '#fff', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--slate-700)' }

/** Shared "X–Y of Z · ← Prev · page / count · Next →" strip for a paginated
 *  table. One component so every searchable/filterable table in the
 *  Needs Attention hub (Wrong parts, Unpriced parts, Open reviews) paginates
 *  identically instead of hand-rolling its own prev/next markup. */
export function PageNav({ page, pageCount, total, pageSize, note, onPage }: {
  page: number; pageCount: number; total: number; pageSize: number; note?: string; onPage: (page: number) => void
}) {
  const start = total === 0 ? 0 : page * pageSize + 1
  const end = Math.min(total, (page + 1) * pageSize)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, fontSize: 12, color: 'var(--slate-500)' }}>
      <span>{start}–{end} of {total}{note ? ` (${note})` : ''}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}
          style={{ ...pageBtn, opacity: page === 0 ? 0.4 : 1 }}>← Prev</button>
        <span>{page + 1} / {pageCount}</span>
        <button disabled={page >= pageCount - 1} onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
          style={{ ...pageBtn, opacity: page >= pageCount - 1 ? 0.4 : 1 }}>Next →</button>
      </div>
    </div>
  )
}

/** Per-zone error boundary — one bad data shape can't blank the whole tab. */
export class Zone extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) {
      return (
        <div style={{ border: '1px solid #FECACA', background: 'var(--red-50)', color: 'var(--red-700)', borderRadius: 10, padding: 16, fontSize: 13 }}>
          The {this.props.label} panel failed to render. Reload; if it persists, the underlying data shape changed.
        </div>
      )
    }
    return this.props.children
  }
}

// ─── in-panel sub-tab nav ─────────────────────────────────────────────────────

/** Controlled sub-tab bar for splitting a long tab into sticky sections.
 *  Matches the parent tab bar (blue underline) but sized for in-panel use.
 *  Sticky so the section nav stays visible while its body scrolls. */
export function SubTabs<T extends string>({ tabs, value, onChange, right }: {
  tabs: { id: T; label: string; badge?: ReactNode }[]
  value: T
  onChange: (id: T) => void
  right?: ReactNode
}) {
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', gap: 12, background: 'var(--slate-50)',
      borderBottom: '1px solid var(--slate-200)', margin: '0 0 2px' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {tabs.map(t => {
          const active = t.id === value
          return (
            <button key={t.id} onClick={() => onChange(t.id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px', border: 'none',
                background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                color: active ? 'var(--slate-900)' : 'var(--slate-500)',
                borderBottom: `2px solid ${active ? 'var(--blue-600)' : 'transparent'}`, marginBottom: -1 }}>
              {t.label}
              {t.badge != null && t.badge}
            </button>
          )
        })}
      </div>
      {right}
    </div>
  )
}

// ─── triggers ────────────────────────────────────────────────────────────────

export type TriggerRequest =
  | { kind: 'reenrich'; vin: string }
  | { kind: 'purge'; vin: string }
  | { kind: 'unstick'; runId: string; label: string }
  | { kind: 'bulkUnstick'; count: number }
  | { kind: 'acknowledgeRun'; runId: string; label: string }

export type OpenTrigger = (req: TriggerRequest) => void

// ─── review queue row ────────────────────────────────────────────────────────

/** What "source_stream" means in plain language — the review item's origin.
 *  Shared by every surface that lists review_queue rows (and the sidebar). */
export const STREAM_SOURCE: Record<string, string> = {
  consensus: 'enrichment run — sources disagreed or a sanity check flagged a value',
  correction: 'a shop/mechanic correction to a predicted part, labor, or exclusion',
  report: 'a user-reported data problem',
  survey: 'a routine spec-variance spot-check sample',
}

export type ReviewRow = FunctionReturnType<typeof api.dataOverview.openReviews>['rows'][number]

/** One review_queue row: a single summary line (stream · car/title · age ·
 *  claimed-by · optional Claim). Clicking it opens the review sidebar
 *  (ReviewSidebar) — car identity, source/run, flags-with-current-value, and
 *  the resolve/dismiss actions all live there, ONE component, instead of
 *  each list duplicating its own expand/detail markup. Shared by the
 *  Overview rail (stale-only) and the Needs Attention tab (full queue). */
export function ReviewQueueRow({
  r, active, onOpen, canClaim, onClaim,
}: {
  r: ReviewRow
  active: boolean
  onOpen: () => void
  canClaim?: boolean
  onClaim?: () => void
}) {
  const carLabel = [r.year, r.make, r.model, r.trim].filter(Boolean).join(' ')
  return (
    <div onClick={onOpen} title="Open review detail"
      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 8px', margin: '0 -8px',
        borderRadius: 6, cursor: 'pointer', borderBottom: '1px solid var(--slate-50)',
        background: active ? 'var(--blue-50)' : 'transparent' }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
      <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 999, background: 'var(--yellow-50)', color: 'var(--yellow-800)', flexShrink: 0 }}>{r.stream}</span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-600)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {carLabel || r.title}
      </span>
      {r.status === 'claimed' && (
        <span style={{ color: 'var(--blue-700)', flexShrink: 0, fontSize: 11 }}>● {r.claimed_by ?? 'claimed'}</span>
      )}
      <span style={{ color: 'var(--slate-400)', flexShrink: 0 }} title={new Date(r.created_at).toLocaleString()}>{r.age_h}h</span>
      {canClaim && r.status === 'open' && onClaim && (
        <button style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, flexShrink: 0 }}
          onClick={e => { e.stopPropagation(); onClaim() }}>Claim</button>
      )}
      <span style={{ color: 'var(--slate-300)', flexShrink: 0 }}>›</span>
    </div>
  )
}

/** Which capability an action requires. Review resolution needs data.write; the
 *  run/queue triggers need data.trigger. */
export function triggerCapability(_req: TriggerRequest): 'data.write' | 'data.trigger' {
  return 'data.trigger'
}

function triggerMeta(req: TriggerRequest): { title: string; destructive: boolean; summary: ReactNode } {
  const mono = (t: string) => <span className="mono" style={{ fontWeight: 600, color: 'var(--slate-900)' }}>{t}</span>
  if (req.kind === 'reenrich')
    return { title: 'Re-enrich VIN', destructive: false, summary: <>Queue a fresh Tier-1 enrichment run for VIN {mono(req.vin)}. Rate-limited to once per VIN every 30 minutes.</> }
  if (req.kind === 'purge')
    return { title: 'Purge + re-enrich VIN', destructive: true, summary: <><b>Wipe all enrichment data</b> for the config behind VIN {mono(req.vin)} and re-run from scratch. Destructive and cannot be undone.</> }
  if (req.kind === 'bulkUnstick')
    return { title: 'Force-unstick all stale runs', destructive: true, summary: <>Mark all <b>{req.count}</b> in-flight {req.count === 1 ? 'run' : 'runs'} with a stale heartbeat (&gt;15&nbsp;min) as <b>failed</b> so new runs can take over. Runs still heart-beating are left untouched.</> }
  if (req.kind === 'acknowledgeRun')
    return { title: 'Acknowledge failed run', destructive: false, summary: <>Mark the failed run for {mono(req.label)} as <b>handled</b> so it clears from Needs Attention. This does not re-run it — record why it was triaged.</> }
  return { title: 'Force-unstick run', destructive: true, summary: <>Mark the stale in-flight run for {mono(req.label)} as <b>failed</b> so a new run can take over. Only eligible while its heartbeat is stale (&gt;15&nbsp;min).</> }
}

/** Panel-native write ceremony (reason ≥4 chars → gated mutation + audit). */
export function TriggerCeremony({ req, onClose, onConfirm }: {
  req: TriggerRequest | null; onClose: () => void; onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!req) return null
  const meta = triggerMeta(req)

  const close = () => { if (busy) return; setReason(''); setErr(''); onClose() }
  const submit = async () => {
    if (reason.trim().length < 4) { setErr('A reason is required (at least a few words).'); return }
    setBusy(true); setErr('')
    try { await onConfirm(reason.trim()); setBusy(false); setReason(''); onClose() }
    catch (e) { setBusy(false); setErr(e instanceof Error ? e.message : 'The action failed. Nothing was changed.') }
  }

  return (
    <Modal open onClose={close} title={meta.title} width={480}
      footer={<>
        <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant={meta.destructive ? 'danger' : 'primary'} onClick={submit} disabled={busy}>
          {busy ? 'Applying…' : 'Trigger'}
        </Button>
      </>}>
      <div style={{ padding: '18px 22px' }}>
        <div style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.55 }}>{meta.summary}</div>
        <div style={{ marginTop: 16 }}>
          <MicroH style={{ marginBottom: 6 }}>Reason (recorded in the audit log)</MicroH>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} autoFocus disabled={busy}
            placeholder="Why is this change being made?"
            style={{ width: '100%', padding: 10, fontSize: 13, borderRadius: 8, resize: 'vertical', fontFamily: 'inherit',
              outline: 'none', color: 'var(--slate-900)', background: busy ? 'var(--slate-50)' : '#fff',
              border: `1px solid ${err ? '#FECACA' : 'var(--slate-200)'}` }} />
          {err && <div style={{ marginTop: 8, fontSize: 12, fontWeight: 500, color: 'var(--red-600)' }}>{err}</div>}
        </div>
      </div>
    </Modal>
  )
}

// ─── confirm popup ───────────────────────────────────────────────────────────

/** A second "are you sure?" step for a button whose reason box is already
 *  filled in — the reason box gates whether you CAN act; this gates whether
 *  you MEANT to click. Shared by ReviewSidebar and WrongPartsPanel's drawer
 *  so every approve/adjust/dismiss/resolve action gets the same pause. */
export function ConfirmPopup({ open, title, message, confirmLabel = 'Confirm', destructive, busy, onConfirm, onCancel }: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <Modal open onClose={onCancel} title={title} width={420}
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Applying…' : confirmLabel}
        </Button>
      </>}>
      <div style={{ padding: '18px 22px', fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.55 }}>{message}</div>
    </Modal>
  )
}
