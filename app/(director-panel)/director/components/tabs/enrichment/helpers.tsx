'use client'

// Enrichment tab — shared primitives, built natively on the director panel's
// inline-style design system (Primitives + Charts), NOT Tailwind. Palette via
// the panel's CSS vars (--slate-*, --green-*, --red-*, …).

import { Component, useState, type ReactNode, type CSSProperties } from 'react'
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
  | { kind: 'resolveReview'; id: string; title: string; outcome: 'resolved' | 'dismissed' }

export type OpenTrigger = (req: TriggerRequest) => void

/** Which capability an action requires. Review resolution needs data.write; the
 *  run/queue triggers need data.trigger. */
export function triggerCapability(req: TriggerRequest): 'data.write' | 'data.trigger' {
  return req.kind === 'resolveReview' ? 'data.write' : 'data.trigger'
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
  if (req.kind === 'resolveReview')
    return { title: req.outcome === 'dismissed' ? 'Dismiss review item' : 'Resolve review item', destructive: req.outcome === 'dismissed',
      summary: <>Mark the review item {mono(req.title)} as <b>{req.outcome}</b>. It stays in history for audit; the source record is untouched.</> }
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
