'use client'

// Director · System health (#systemHealth) — faithful port of the retired
// /ops/system-health page. Read-only. StatCards → daily bugs/feedback trend
// panels → "Reliability & delivery" zone (reliability_events, client_logs,
// sms_delivery_log, notification_outbox) → hourly client error/warn bars +
// grouped-by-signature list (stack expands) → bug tracker table.

import { useContext, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Badge, Card, tableStyles } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { gotoEntity } from '../directorNav'
import { StatCard, BarRow, DailyBars, fmtNumber, fmtRelative } from '../Charts'

const fmtDT = (ms: number) => new Date(ms).toLocaleString()

type LogGroup = {
  signature: string
  level: string
  count: number
  latest_at: number
  latest_stack: string | null
  user_ids: number
}
type BugRow = {
  id: string
  title: string
  source: string
  status: string
  device: string | null
  at: number
}

// Inner section header (mirrors the local SectionTitle pattern used across the panel).
const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, marginTop:6 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

// A larger zone header (the ops <h2> "Reliability & delivery" / "Client errors & warnings").
const ZoneHeading = ({ title, muted }: { title: string; muted?: React.ReactNode }) => (
  <h3 style={{ margin:0, fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>
    {title}{muted != null && <span style={{ fontWeight:400, color:'var(--slate-400)' }}> {muted}</span>}
  </h3>
)

const SkeletonRows = ({ n = 4, height = 20 }: { n?: number; height?: number }) => (
  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
    {Array.from({ length: n }).map((_, i) => (
      <div key={i} className="animate-pulse" style={{ height, borderRadius:6, background:'var(--slate-100)' }} />
    ))}
  </div>
)

// Notification-outbox status → Badge tone.
const outboxTone = (status: string): 'red' | 'yellow' | 'green' | 'slate' => {
  if (status === 'failed') return 'red'
  if (status === 'pending') return 'yellow'
  if (status === 'sent' || status === 'processed') return 'green'
  return 'slate'
}

// Bug status → Badge tone (done/verified = green, new = red, else yellow).
const bugStatusTone = (status: string): 'green' | 'red' | 'yellow' =>
  ['done', 'verified'].includes(status) ? 'green' : status === 'new' ? 'red' : 'yellow'

export const TabSystemHealth = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''

  const [expanded, setExpanded] = useState<string | null>(null)

  const health = useQuery(api.opsSystemHealth.errorOverview, { token })
  const bugs = useQuery(api.opsSystemHealth.bugsList, { token })
  const daily = useQuery(api.portalSeries.systemHealthDaily, { token, days: 30 })
  const rel = useQuery(api.portalSeries.reliabilityOverview, { token, days: 7 })

  const bugs30d = daily?.reduce((s, d) => s + d.bugs, 0)
  const feedback30d = daily?.reduce((s, d) => s + d.feedback, 0)
  const clientErrors7d = rel === undefined ? undefined : (rel.client_logs.by_level['error'] ?? 0)
  const relErrors7d = rel?.reliability.days.reduce((s, d) => s + d.errors, 0)
  const hasRelErrors = relErrors7d != null && relErrors7d > 0

  return (
    <SectionAnchor
      id="systemHealth"
      title="System Health"
      subtitle="Bugs, feedback, client errors, and delivery reliability — the app's vital signs."
    >
      {/* Stat tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Bugs filed · 30d" tone="red"
          value={bugs30d == null ? '—' : fmtNumber(bugs30d)}
          spark={daily?.map(d => d.bugs)} />
        <StatCard label="Feedback · 30d" tone="blue"
          value={feedback30d == null ? '—' : fmtNumber(feedback30d)}
          spark={daily?.map(d => d.feedback)} />
        <StatCard label={`Client errors · ${rel?.window_days ?? 7}d`} tone="red"
          value={clientErrors7d == null ? '—' : fmtNumber(clientErrors7d)}
          accent={clientErrors7d != null && clientErrors7d > 0 ? <Badge tone="red">investigate</Badge> : undefined} />
        <StatCard label="SMS failures open" tone="red"
          value={rel === undefined ? '—' : fmtNumber(rel.sms.failed_open)}
          accent={rel !== undefined && rel.sms.failed_open > 0 ? <Badge tone="red">failing</Badge> : undefined} />
      </div>

      {/* Zone 1 — daily bugs + feedback (two panels, never dual-axis) */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
        <Card>
          <SectionTitle label="Bugs filed per day · last 30 days" />
          <DailyBars data={daily} valueKey="bugs" labelKey="date" color="var(--red-300, #FCA5A5)" height={150} />
        </Card>
        <Card>
          <SectionTitle label="App feedback per day · last 30 days" />
          <DailyBars data={daily} valueKey="feedback" labelKey="date" color="var(--blue-300, #93C5FD)" height={150} />
        </Card>
      </div>

      {/* Zone 2 — Reliability & delivery */}
      <div style={{ marginBottom:16 }}>
        <div style={{ marginBottom:12 }}>
          <ZoneHeading title="Reliability & delivery"
            muted={<>({rel?.window_days ?? '…'}d{rel?.reliability.truncated ? ', event window truncated' : ''})</>} />
        </div>

        <div style={{ display:'grid', gridTemplateColumns: hasRelErrors ? '1fr 1fr' : '1fr', gap:12, marginBottom:12 }}>
          <Card>
            <SectionTitle label={`Reliability events per day${rel !== undefined ? ` · ${fmtNumber(rel.reliability.total)} total` : ''}`} />
            <DailyBars data={rel?.reliability.days} valueKey="events" labelKey="date" color="var(--blue-500, #3B82F6)" height={150} />
          </Card>
          {hasRelErrors && (
            <Card>
              <SectionTitle label={`Reliability errors per day · ${fmtNumber(relErrors7d)} total`} />
              <DailyBars data={rel?.reliability.days} valueKey="errors" labelKey="date" color="var(--yellow-500, #F59E0B)" height={150} />
            </Card>
          )}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
          {/* By surface */}
          <Card>
            <SectionTitle label="Events by surface" />
            {rel === undefined ? (
              <SkeletonRows n={4} />
            ) : Object.keys(rel.reliability.by_surface).length === 0 ? (
              <p style={{ fontSize:13, color:'var(--slate-500)', margin:0 }}>No reliability events in the window.</p>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {(() => {
                  const entries = Object.entries(rel.reliability.by_surface).sort((a, b) => b[1] - a[1])
                  const max = Math.max(1, ...entries.map(([, v]) => v))
                  return entries.map(([surface, count]) => (
                    <BarRow key={surface} label={surface} value={count} max={max} valueLabel={fmtNumber(count)} />
                  ))
                })()}
              </div>
            )}
          </Card>

          {/* Recent client errors */}
          <Card>
            <SectionTitle label={`Recent client errors${rel !== undefined && rel.client_logs.truncated ? ' · window truncated' : ''}`} />
            {rel === undefined ? (
              <SkeletonRows n={4} height={32} />
            ) : rel.client_logs.recent_errors.length === 0 ? (
              <p style={{ fontSize:13, color:'var(--green-700)', margin:0 }}>No client errors in the window.</p>
            ) : (
              <ul style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:10 }}>
                {rel.client_logs.recent_errors.map((e, i) => (
                  <li key={i} style={{ fontSize:12 }}>
                    <div className="mono" style={{ color:'var(--slate-700)', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>{e.message}</div>
                    <div style={{ marginTop:2, fontSize:11, color:'var(--slate-400)' }}>
                      {fmtRelative(e.at)}
                      {e.session_id ? ` · session ${e.session_id.slice(0, 8)}…` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* SMS + outbox */}
          <Card>
            <SectionTitle label="SMS delivery & outbox" />
            {rel === undefined ? (
              <SkeletonRows n={4} height={32} />
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                <div style={{ fontSize:13, color:'var(--slate-600)' }}>
                  <span style={{ fontWeight:600, color:'var(--slate-900)' }} className="mono">{fmtNumber(rel.sms.sent_window)}</span>{' '}
                  SMS attempts · {rel.window_days}d ·{' '}
                  <span style={rel.sms.failed_open > 0 ? { fontWeight:600, color:'var(--red-600)' } : undefined}>
                    {fmtNumber(rel.sms.failed_open)} failed open
                  </span>
                </div>
                {rel.sms.recent_failures.length > 0 && (
                  <ul style={{ listStyle:'none', margin:0, padding:0, display:'flex', flexDirection:'column', gap:10 }}>
                    {rel.sms.recent_failures.map((f, i) => (
                      <li key={i} style={{ border:'1px solid #FECACA', background:'var(--red-50)', borderRadius:8, padding:'6px 10px', fontSize:12 }}>
                        <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:6 }}>
                          <span className="mono" style={{ color:'var(--slate-700)' }}>{f.to_phone}</span>
                          <span style={{ fontSize:11, color:'var(--slate-400)' }}>{fmtRelative(f.at)}</span>
                          {f.booking_id && (
                            <button onClick={() => gotoEntity('bookings', String(f.booking_id))}
                              style={{ marginLeft:'auto', border:'none', background:'transparent', cursor:'pointer', padding:0,
                                fontSize:11, fontWeight:500, color:'var(--blue-600)', fontFamily:'inherit' }}>
                              booking →
                            </button>
                          )}
                        </div>
                        <div style={{ marginTop:2, color:'var(--red-700)' }}>{f.error}</div>
                      </li>
                    ))}
                  </ul>
                )}
                <div>
                  <SectionTitle label="Notification outbox" />
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:-4 }}>
                    {Object.keys(rel.outbox_by_status).length === 0 ? (
                      <span style={{ fontSize:13, color:'var(--slate-500)' }}>Outbox is empty.</span>
                    ) : (
                      Object.entries(rel.outbox_by_status).map(([status, count]) => (
                        <Badge key={status} tone={outboxTone(status)}>{status} × {count}</Badge>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Zone 3 — hourly client error/warn rate */}
      <Card style={{ marginBottom:16 }}>
        <div style={{ marginBottom:10, marginTop:2 }}>
          <ZoneHeading title="Client errors & warnings"
            muted={<>({health?.window_days ?? '…'}d{health?.truncated ? ', level windows truncated' : ''})</>} />
        </div>
        {health === undefined ? (
          <div className="animate-pulse" style={{ height:90, borderRadius:8, background:'var(--slate-100)' }} />
        ) : health.hourly.length === 0 ? (
          <p style={{ fontSize:13, color:'var(--green-700)', margin:0 }}>Zero client errors or warnings in the window.</p>
        ) : (
          <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:90, overflowX:'auto' }}>
            {(() => {
              const max = Math.max(...health.hourly.map(x => x.errors + x.warns), 1)
              return health.hourly.map((h: { hour: string; errors: number; warns: number }) => (
                <div key={h.hour} title={`${h.hour}:00 — ${h.errors} errors, ${h.warns} warns`}
                  style={{ display:'flex', width:8, flexShrink:0, flexDirection:'column', justifyContent:'flex-end' }}>
                  <div style={{ width:'100%', borderRadius:'2px 2px 0 0', background:'var(--yellow-300, #FCD34D)', height:(h.warns / max) * 80 }} />
                  <div style={{ width:'100%', background:'var(--red-500, #EF4444)', height:(h.errors / max) * 80 }} />
                </div>
              ))
            })()}
          </div>
        )}
      </Card>

      {/* Signature groups */}
      {health !== undefined && health.groups.length > 0 && (
        <Card padded={false} style={{ marginBottom:16 }}>
          {(health.groups as LogGroup[]).map((g, gi) => {
            const key = `${g.level}:${g.signature}`
            const isOpen = expanded === key
            return (
              <div key={key} style={{ borderBottom: gi < health.groups.length - 1 ? '1px solid var(--slate-100)' : 'none' }}>
                <button onClick={() => setExpanded(isOpen ? null : key)}
                  style={{ display:'flex', width:'100%', flexWrap:'wrap', alignItems:'center', gap:8, padding:'10px 16px',
                    textAlign:'left', border:'none', background: isOpen ? 'var(--slate-25)' : 'transparent', cursor:'pointer', fontFamily:'inherit' }}
                  onMouseEnter={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)' }}
                  onMouseLeave={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                  <Badge tone={g.level === 'error' ? 'red' : 'yellow'}>{g.level} × {g.count}</Badge>
                  <span className="mono" style={{ fontSize:12, color:'var(--slate-700)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'60%' }}>
                    {g.signature}
                  </span>
                  <span style={{ marginLeft:'auto', fontSize:11, color:'var(--slate-400)' }}>
                    {g.user_ids} user{g.user_ids === 1 ? '' : 's'} · latest {fmtDT(g.latest_at)}
                  </span>
                </button>
                {isOpen && (
                  <pre style={{ maxHeight:288, overflow:'auto', margin:0, background:'var(--slate-900)', color:'var(--slate-100, #F1F5F9)',
                    padding:'12px 16px', fontSize:11, lineHeight:1.4, fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {g.latest_stack ?? '(no stack captured on the latest occurrence)'}
                  </pre>
                )}
              </div>
            )
          })}
        </Card>
      )}

      {/* Bug tracker */}
      <Card padded={false}>
        <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--slate-200)', fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>
          Bug tracker
        </div>
        {bugs === undefined ? (
          <div style={{ padding:12 }}><SkeletonRows n={3} height={36} /></div>
        ) : bugs.length === 0 ? (
          <p style={{ padding:16, fontSize:13, color:'var(--slate-500)', margin:0 }}>No open bugs recorded.</p>
        ) : (
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Title</th>
              <th style={tableStyles.th}>Source</th>
              <th style={tableStyles.th}>Status</th>
              <th style={tableStyles.th}>Device</th>
              <th style={tableStyles.th}>When</th>
            </tr></thead>
            <tbody>
              {(bugs as BugRow[]).map(b => (
                <tr key={b.id}>
                  <td style={tableStyles.td}>{b.title}</td>
                  <td style={tableStyles.td}><Badge tone="slate">{b.source}</Badge></td>
                  <td style={tableStyles.td}><Badge tone={bugStatusTone(b.status)}>{b.status}</Badge></td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-500)' }}>{b.device ?? '—'}</td>
                  <td style={{ ...tableStyles.td, color:'var(--slate-500)', fontSize:12 }}>{fmtDT(b.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </SectionAnchor>
  )
}
