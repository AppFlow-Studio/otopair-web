'use client'

// Director · Follow-ups — ported from /ops/follow-ups (Ops spec p.10).
// StatCards (created 30d + spark, pending, sent 7d, sent→booking conversion) →
// 30d created-per-day trend with a status-mix legend → Queue / Sent / Dismissed
// view toggle over opsFollowUps.board → the list table (fires-countdown for the
// queue / timestamp otherwise, user link, VIN link, service + type pill,
// signals, View + Cancel) → a message drawer with a phone-frame preview +
// telemetry. Cancel (pending only) is a Modal reason ceremony gated by
// can(role,'users.write'). Create/edit/send-now stay descoped — the sending
// engine is consumer-side (follow_ups.ts).

import { useContext, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { can } from '@/lib/portal/capabilities'
import {
  Badge, Button, Card, Modal, SegmentedControl, MicroH, tableStyles, IconX,
} from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import { StatCard, DailyBars, fmtNumber } from '../Charts'

// --- Local helpers (no director equivalent) ----------------------------------

const fmtDT = (ms: number) => new Date(ms).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Countdown to the scheduled fire time, matching the ops copy exactly. */
function countdown(ms: number): string {
  const d = ms - Date.now()
  if (d <= 0) return 'due now'
  const hours = Math.floor(d / 3600000)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

/** Amber for pending-ish states, green for sent, slate otherwise. */
type Tone = 'slate' | 'green' | 'yellow' | 'blue' | 'red' | 'purple' | 'indigo' | 'teal' | 'orange'
function statusTone(status: string): Tone {
  if (['pending', 'scheduled', 'queued'].includes(status)) return 'yellow'
  if (status === 'sent') return 'green'
  return 'slate'
}

// Mirrors convex/opsFollowUps.ts FollowUpRow.
type FollowUpRow = {
  id: string
  user: string | null
  user_id: string
  booking_id: string | null
  vin: string
  service: string | null
  type: string
  scheduled_for: number
  status: string
  message: string | null
  sent_at: number | null
  dismissed_reason: string | null
  from_recommendation: boolean
  led_to_booking: boolean
}

type BoardResult = {
  queue: FollowUpRow[]
  sent: FollowUpRow[]
  dismissed: FollowUpRow[]
  metrics: { pending: number; sent_7d: number; conversion_pct: number | null }
}

type DailyResult = {
  days: { date: string; created: number }[]
  by_status: Record<string, number>
}

type View = 'queue' | 'sent' | 'dismissed'

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:10, flexWrap:'wrap' }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

export const TabFollowUps = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const canWrite = can(session?.role, 'users.write')

  const [view, setView] = useState<View>('queue')
  const [drawer, setDrawer] = useState<FollowUpRow | null>(null)
  const [cancelTarget, setCancelTarget] = useState<FollowUpRow | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const data  = useQuery(api.opsFollowUps.board, { token }) as BoardResult | undefined
  const daily = useQuery(api.portalSeries.followUpsDaily, { token, days: 30 }) as DailyResult | undefined
  const cancel = useMutation(api.opsFollowUps.cancel)

  const rows: FollowUpRow[] =
    data === undefined ? [] : view === 'queue' ? data.queue : view === 'sent' ? data.sent : data.dismissed

  const created30d = daily?.days.reduce((s, d) => s + d.created, 0)

  const closeCancel = () => { setCancelTarget(null); setReason(''); setSubmitting(false) }

  const doCancel = async () => {
    if (!cancelTarget || reason.trim().length < 4) return
    setSubmitting(true)
    try {
      await cancel({ token, reason: reason.trim(), id: cancelTarget.id as Id<'follow_ups'> })
      closeCancel()
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <SectionAnchor id="followUps" title="Follow-ups"
      subtitle="Read + cancel. Creating and firing follow-ups stays with the consumer-side engine for now — the create wizard ships when ops-triggered sends get their own design pass.">

      {/* ── Metric strip ─────────────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Created · 30d" tone="blue"
          value={created30d == null ? '—' : fmtNumber(created30d)}
          spark={daily?.days.map(d => d.created)} />
        <StatCard label="Pending" tone="yellow"
          value={data === undefined ? '…' : fmtNumber(data.metrics.pending)} />
        <StatCard label="Sent · 7d" tone="green"
          value={data === undefined ? '…' : fmtNumber(data.metrics.sent_7d)} />
        <StatCard label="Sent → booking" tone="purple"
          value={
            data === undefined
              ? '…'
              : data.metrics.conversion_pct == null
                ? '—'
                : `${Math.round(data.metrics.conversion_pct * 100)}%`
          }
          hint="of sent follow-ups led to a booking" />
      </div>

      {/* ── 30d created trend + status mix ───────────────────────────────── */}
      <Card style={{ marginBottom:16 }}>
        <SectionTitle label="Follow-ups created per day · last 30 days"
          right={daily !== undefined && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {Object.entries(daily.by_status)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <Badge key={status} tone={statusTone(status)}>{status} × {count}</Badge>
                ))}
            </div>
          )} />
        <DailyBars data={daily?.days} valueKey="created" labelKey="date" color="var(--blue-300, #93C5FD)" height={150} />
      </Card>

      {/* ── View toggle ──────────────────────────────────────────────────── */}
      <div style={{ marginBottom:12 }}>
        <SegmentedControl<View> value={view} onChange={setView}
          options={[
            { value:'queue',     label:'Queue' },
            { value:'sent',      label:'Sent' },
            { value:'dismissed', label:'Dismissed' },
          ]} />
      </div>

      {/* ── List table ───────────────────────────────────────────────────── */}
      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>{view === 'queue' ? 'Fires' : 'When'}</th>
            <th style={tableStyles.th}>User</th>
            <th style={tableStyles.th}>VIN</th>
            <th style={tableStyles.th}>Service / Type</th>
            <th style={tableStyles.th}>Signals</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }} />
          </tr></thead>
          <tbody>
            {data === undefined
              ? <tr><td colSpan={6} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : rows.length === 0
                ? <tr><td colSpan={6} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Nothing in {view}.</td></tr>
                : rows.map(f => (
                  <tr key={f.id}>
                    <td style={tableStyles.td}>
                      {view === 'queue'
                        ? <Badge tone="blue">{countdown(f.scheduled_for)}</Badge>
                        : <span style={{ color:'var(--slate-500)', fontSize:12 }}>{fmtDT(f.sent_at ?? f.scheduled_for)}</span>}
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>
                      {f.user
                        ? <span style={{ color:'var(--blue-700)', cursor:'pointer' }}
                            onClick={() => gotoEntity('users', f.user_id)}>{f.user}</span>
                        : '—'}
                    </td>
                    <td style={{ ...tableStyles.td }} className="mono">
                      <a href={`/director/data/vins/${f.vin}`}
                        title="Open VIN in the data portal"
                        style={{ color:'var(--slate-600)', textDecoration:'none', fontSize:12 }}>
                        {f.vin}
                      </a>
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-700)' }}>
                      {f.service ?? '—'}
                      <Badge tone="slate" style={{ marginLeft:6 }}>{f.type}</Badge>
                    </td>
                    <td style={tableStyles.td}>
                      <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                        {f.from_recommendation && <Badge tone="purple">mechanic rec</Badge>}
                        {f.led_to_booking && (
                          f.booking_id
                            ? <span style={{ cursor:'pointer' }} onClick={() => gotoEntity('bookings', f.booking_id as string)}>
                                <Badge tone="green">booking →</Badge>
                              </span>
                            : <Badge tone="green">→ booking</Badge>
                        )}
                        {f.dismissed_reason && (
                          <span style={{ fontSize:12, fontStyle:'italic', color:'var(--slate-400)' }}>{f.dismissed_reason}</span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }}>
                      <div style={{ display:'flex', gap:4, justifyContent:'flex-end' }}>
                        <Button size="sm" onClick={() => setDrawer(f)}>View</Button>
                        {canWrite && f.status === 'pending' && (
                          <Button size="sm" variant="danger" onClick={() => setCancelTarget(f)}>Cancel</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>

      {/* ── Message drawer (phone-frame preview + telemetry) ─────────────── */}
      {drawer && (
        <div onClick={() => setDrawer(null)}
          style={{ position:'fixed', inset:0, background:'rgba(15,23,42,0.45)', zIndex:200, display:'flex', justifyContent:'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width:'100%', maxWidth:440, height:'100%', overflow:'auto', background:'#fff', boxShadow:'-24px 0 60px rgba(15,23,42,0.35)', padding:24 }}>
            <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
              <div style={{ minWidth:0, flex:1 }}>
                <div style={{ fontSize:16, fontWeight:600, color:'var(--slate-900)' }}>
                  {drawer.type} · {drawer.service ?? drawer.vin}
                </div>
                <div style={{ fontSize:12, color:'var(--slate-500)', marginTop:4 }}>
                  {drawer.user ?? 'user'} · scheduled {fmtDT(drawer.scheduled_for)} · status{' '}
                  <Badge tone={statusTone(drawer.status)}>{drawer.status}</Badge>
                </div>
              </div>
              <button onClick={() => setDrawer(null)}
                style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-400)', padding:4, borderRadius:6, display:'inline-flex' }}>
                <IconX size={18} />
              </button>
            </div>

            <div style={{ marginTop:24, display:'flex', justifyContent:'center' }}>
              <div style={{ width:240, borderRadius:28, border:'6px solid var(--slate-800)', background:'var(--slate-50)', padding:16 }}>
                <MicroH>message preview</MicroH>
                <div style={{ marginTop:8, borderRadius:12, border:'1px solid var(--slate-200)', background:'#fff', padding:'10px 12px', fontSize:12, lineHeight:1.6, color:'var(--slate-800)' }}>
                  {drawer.message ?? '(no message body — templated at send time)'}
                </div>
              </div>
            </div>

            {/* Telemetry */}
            <div style={{ marginTop:24 }}>
              <MicroH style={{ marginBottom:8 }}>telemetry</MicroH>
              <div style={{ display:'flex', flexDirection:'column', gap:8, fontSize:13, color:'var(--slate-700)' }}>
                <TelRow label="VIN">
                  <a href={`/director/data/vins/${drawer.vin}`} className="mono" style={{ color:'var(--blue-700)', textDecoration:'none' }}>{drawer.vin}</a>
                </TelRow>
                <TelRow label="Scheduled">{fmtDT(drawer.scheduled_for)}</TelRow>
                <TelRow label="Sent">{drawer.sent_at ? fmtDT(drawer.sent_at) : '—'}</TelRow>
                <TelRow label="From mechanic rec">{drawer.from_recommendation ? <Badge tone="purple">yes</Badge> : 'no'}</TelRow>
                <TelRow label="Led to booking">
                  {drawer.led_to_booking
                    ? (drawer.booking_id
                        ? <span style={{ cursor:'pointer' }} onClick={() => { setDrawer(null); gotoEntity('bookings', drawer.booking_id as string) }}><Badge tone="green">booking →</Badge></span>
                        : <Badge tone="green">yes</Badge>)
                    : 'no'}
                </TelRow>
                {drawer.dismissed_reason && (
                  <TelRow label="Dismissed reason">
                    <span style={{ fontStyle:'italic', color:'var(--slate-500)' }}>{drawer.dismissed_reason}</span>
                  </TelRow>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Cancel ceremony (reason required, ≥ 4 chars) ─────────────────── */}
      <Modal open={cancelTarget !== null} onClose={closeCancel} width={480}
        title="Cancel follow-up"
        footer={<>
          <Button onClick={closeCancel}>Cancel</Button>
          <Button variant="danger" onClick={doCancel} disabled={reason.trim().length < 4 || submitting}>
            {submitting ? 'Cancelling…' : 'Dismiss follow-up'}
          </Button>
        </>}>
        <div style={{ padding:22 }}>
          {cancelTarget && (
            <div style={{ fontSize:13, color:'var(--slate-600)', lineHeight:1.6, marginBottom:16 }}>
              {cancelTarget.type} for {cancelTarget.user ?? 'user'} (
              <span className="mono">{cancelTarget.vin}</span>), scheduled{' '}
              {fmtDT(cancelTarget.scheduled_for)} — will be dismissed and never sent.
            </div>
          )}
          <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>
            Reason
          </label>
          <textarea value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Why is this follow-up being cancelled? (logged in the audit trail)"
            autoFocus
            style={{ width:'100%', minHeight:84, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical', background:'#fff', outline:'none', color:'var(--slate-900)' }} />
          <div style={{ fontSize:11, color:'var(--slate-400)', marginTop:6 }}>A reason of at least 4 characters is required.</div>
        </div>
      </Modal>
    </SectionAnchor>
  )
}

const TelRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, padding:'6px 0', borderBottom:'1px solid var(--slate-100)' }}>
    <span style={{ color:'var(--slate-500)' }}>{label}</span>
    <span style={{ textAlign:'right' }}>{children}</span>
  </div>
)
