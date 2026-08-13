'use client'

/**
 * Oto History — read-only director viewer for any user's past PRODUCTION
 * Oto conversations (OTO_HANDOFF.md §A). Pick a user, browse their
 * conversations (sims excluded), read the transcript, and flip on Debug for
 * the per-turn forensic detail (model, prompt version, tool calls, tokens,
 * latency).
 *
 * All three backing queries are director-token-gated server-side
 * (convex/oto/directorConversations.ts). Transcripts are raw user text —
 * treat as PII; keep it inside the panel.
 *
 * ENRICHED with the retired /ops/oto-ai surface (Ops spec p.10):
 *   • a model-usage KPI strip + 14d spend/token/latency trend
 *     (api.directorData.otoUsage), and
 *   • the "T5" transcript viewer — a 3-pane deployment-wide reader
 *     (conversation list · chat bubbles · per-message metadata) backed by
 *     api.opsOtoAi.conversations / api.opsOtoAi.transcript. Opening a
 *     transcript writes a PII access-log row (api.opsOtoAi.logTranscriptView).
 */
import { useState, useContext, useEffect } from 'react'
import { useQuery, usePaginatedQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Input, Card, Badge, IconSearch } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { gotoEntity } from '../directorNav'
import { StatCard, DailyBars, BarRow, money, fmtNumber, dayLabel, fmtDate } from '../Charts'

const formatTs = (ts: number | null | undefined) =>
  ts
    ? new Date(ts).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : '—'

// Compact token count: 1.2M / 3.4k / 812.
const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

// Strip the "claude-" prefix and the trailing -YYYYMMDD date stamp for pills.
const shortModel = (m: string) => m.replace(/^claude-?/, '').replace(/-\d{8}$/, '')

const label = (text: string) => (
  <div style={{ fontSize: 11, color: 'var(--slate-500)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
    {text}
  </div>
)

// Inner section header (ChartKit PageHeader → director SectionTitle, per TabStripe).
const SectionTitle = ({ heading, sub, right }: { heading: string; sub?: string; right?: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
    <div>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--slate-900)' }}>{heading}</h3>
      {sub && <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 3 }}>{sub}</div>}
    </div>
    {right}
  </div>
)

type ConversationRow = {
  _id: Id<'ai_conversations'>
  started_at: number
  ended_at: number | null
  message_count: number
  led_to_booking: boolean
  current_model: string | null
  mood: string | null
  last_user_intent: string | null
  vehicle: string | null
}

const TranscriptBubbles = ({ messages }: {
  messages: { _id: Id<'ai_messages'>; role: string; content: string; timestamp: number }[]
}) => {
  if (messages.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--slate-400)', fontStyle: 'italic', padding: '12px 0' }}>No messages persisted for this conversation.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {messages.map(m => {
        const isUser = m.role === 'user'
        return (
          <div key={m._id} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '88%',
              background: isUser ? 'var(--blue-50)' : 'var(--slate-50)',
              border: `1px solid ${isUser ? '#BFDBFE' : 'var(--slate-200)'}`,
              borderRadius: 10, padding: '8px 12px', fontSize: 13, lineHeight: 1.5,
              color: 'var(--slate-800)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {m.content}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 10, color: 'var(--slate-500)' }}>
              <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{m.role}</span>
              <span>·</span>
              <span>{formatTs(m.timestamp)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const DebugPane = ({ conversationId, token }: { conversationId: Id<'ai_conversations'>; token: string }) => {
  const debug = useQuery(api.oto.directorConversations.getConversationDebug, { token, conversationId })
  if (debug === undefined) return <div style={{ fontSize: 12, color: 'var(--slate-400)', padding: '12px 0' }}>Loading debug detail…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {(debug.actions.length > 0 || debug.bookingOutcome.state !== 'none') && (
        <div>
          {label('What Oto did')}
          {debug.bookingOutcome.state === 'created' && (
            <div style={{ border: '1px solid #a7f3d0', background: '#ecfdf5', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#065f46', marginBottom: 8 }}>
              ✅ Booking created — {debug.bookingOutcome.services.join(', ') || 'service'} · {debug.bookingOutcome.status.replace(/_/g, ' ')}
              {debug.bookingOutcome.shopName ? ` · ${debug.bookingOutcome.shopName}` : ''}
            </div>
          )}
          {debug.bookingOutcome.state === 'not_created' && (
            <div style={{ border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#92400e', marginBottom: 8 }}>
              ⚠️ Oto teed up a booking but none is linked to this conversation.
            </div>
          )}
          {debug.actions.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--slate-400)', fontStyle: 'italic' }}>No data or booking actions.</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {debug.actions.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                    <Badge tone={a.kind === 'booking' ? 'green' : a.kind === 'vehicle_update' ? 'blue' : a.kind === 'record_confirm' ? 'purple' : 'slate'}>{a.kind.replace(/_/g, ' ')}</Badge>
                    <span style={{ color: 'var(--slate-700)' }}>
                      <span style={{ fontWeight: 600 }}>{a.label}</span>
                      {a.detail ? <span style={{ color: 'var(--slate-500)' }}> — {a.detail}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
      <div>
        {label(`Telemetry (${debug.telemetry.length} turn${debug.telemetry.length === 1 ? '' : 's'})`)}
        {debug.telemetry.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--slate-400)', fontStyle: 'italic' }}>No telemetry rows. (Rows recorded before the Jun-10 telemetry fix carry fabricated zeros.)</div>
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                <thead>
                  <tr style={{ color: 'var(--slate-500)', textAlign: 'left' }}>
                    {['when', 'model', 'iters', 'in tok', 'out tok', 'cache rd', 'latency', 'tools', 'branch'].map(h => (
                      <th key={h} style={{ padding: '4px 8px', borderBottom: '1px solid var(--slate-200)', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {debug.telemetry.map(t => (
                    <tr key={t._id} style={{ color: 'var(--slate-700)' }}>
                      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{formatTs(t.ts)}</td>
                      <td style={{ padding: '4px 8px' }} className="mono">{t.model.includes('sonnet') ? 'sonnet' : t.model.includes('haiku') ? 'haiku' : t.model}</td>
                      <td style={{ padding: '4px 8px' }}>{t.iterations_used}{t.hit_cap ? ' (cap!)' : ''}</td>
                      <td style={{ padding: '4px 8px' }}>{t.input_tokens.toLocaleString()}</td>
                      <td style={{ padding: '4px 8px' }}>{t.output_tokens.toLocaleString()}</td>
                      <td style={{ padding: '4px 8px' }}>{(t.cache_read_tokens ?? 0).toLocaleString()}</td>
                      <td style={{ padding: '4px 8px' }}>{t.total_latency_ms.toLocaleString()}ms</td>
                      <td style={{ padding: '4px 8px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.tools_called.join(', ')}>{t.tools_called.join(', ') || '—'}</td>
                      <td style={{ padding: '4px 8px' }}>{t.final_branch}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <div>
        {label(`Forensic turns (${debug.audit.length})`)}
        {debug.audit.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--slate-400)', fontStyle: 'italic' }}>No conversation_audit rows.</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {debug.audit.map(a => (
                <div key={a._id} style={{ border: '1px solid var(--slate-200)', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--slate-500)', marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700 }}>turn {a.turn_number}</span>
                    <Badge tone={a.role === 'user' ? 'blue' : 'slate'}>{a.role}</Badge>
                    {a.model_used && <Badge tone={a.model_used === 'sonnet' ? 'purple' : 'slate'}>{a.model_used}</Badge>}
                    {a.prompt_version && <span className="mono">{a.prompt_version}</span>}
                    <span style={{ marginLeft: 'auto' }}>{formatTs(a.timestamp)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--slate-700)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto' }}>{a.content}</div>
                  {a.tool_calls && a.tool_calls.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--slate-500)' }}>
                      tools: {a.tool_calls.map((tc: { name: string }) => tc.name).join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}

const TranscriptPane = ({ conversationId, token }: { conversationId: Id<'ai_conversations'>; token: string }) => {
  const [debugOpen, setDebugOpen] = useState(false)
  const detail = useQuery(api.oto.directorConversations.getConversationTranscript, { token, conversationId })

  if (detail === undefined) return <div style={{ fontSize: 12, color: 'var(--slate-400)', padding: 16 }}>Loading transcript…</div>
  if (detail === null) return <div style={{ fontSize: 12, color: 'var(--slate-400)', padding: 16 }}>Conversation not found.</div>

  const c = detail.conversation
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {c.vehicle && <Badge tone="indigo">{c.vehicle}</Badge>}
        {c.mood && <Badge tone="blue">mood: {c.mood}</Badge>}
        {c.current_model === 'sonnet' && <Badge tone="purple">sonnet</Badge>}
        {c.led_to_booking && <Badge tone="green">→ booking</Badge>}
        {c.is_simulation && <Badge tone="yellow">simulation</Badge>}
        <span style={{ fontSize: 11, color: 'var(--slate-500)' }}>{formatTs(c.started_at)}{c.ended_at ? ` – ${formatTs(c.ended_at)}` : ''}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant={debugOpen ? 'primary' : 'ghost'} onClick={() => setDebugOpen(o => !o)}>
          {debugOpen ? 'Transcript' : 'Debug'}
        </Button>
      </div>

      {(c.arc_summary || c.last_user_intent || (c.established_facts?.length ?? 0) > 0) && !debugOpen && (
        <div style={{ fontSize: 12, color: 'var(--slate-600)', background: 'var(--slate-25)', border: '1px solid var(--slate-100)', borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {c.arc_summary && <div><b>arc:</b> {c.arc_summary}</div>}
          {c.last_user_intent && <div><b>last intent:</b> {c.last_user_intent}</div>}
          {(c.established_facts?.length ?? 0) > 0 && <div><b>facts:</b> {c.established_facts.join(' · ')}</div>}
        </div>
      )}

      <div style={{ maxHeight: 480, overflowY: 'auto', padding: '4px 2px' }}>
        {debugOpen
          ? <DebugPane conversationId={conversationId} token={token} />
          : <TranscriptBubbles messages={detail.messages} />}
      </div>
    </div>
  )
}

// ===========================================================================
// Usage analytics zone — model spend / tokens / latency (api.directorData.otoUsage)
// ===========================================================================

const UsageZone = ({ token }: { token: string }) => {
  const usage = useQuery(api.directorData.otoUsage, { token, days: 14 })
  const convData = useQuery(api.opsOtoAi.conversations, { token })

  const hitCapPct = usage == null ? null : usage.totals.hit_cap_rate * 100
  // Per-day spend bars (ChartKit TrendArea → director DailyBars).
  const spendBars = usage?.days.map(d => ({ label: dayLabel(d.date), value: d.est_cost_usd }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Usage KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <StatCard
          label="Turns · 7d"
          value={usage === undefined ? '—' : fmtNumber(usage.totals.turns_7d)}
          spark={usage?.days.map(d => d.turns)}
        />
        <StatCard
          label="Cost · 7d (est.)"
          value={usage === undefined ? '—' : money(usage.totals.est_cost_7d_usd, { cents: true })}
        />
        <StatCard
          label="p50 latency"
          value={usage === undefined ? '—' : `${fmtNumber(usage.totals.p50_latency_ms)} ms`}
        />
        <StatCard
          label="Hit-cap rate · 7d"
          value={hitCapPct == null ? '—' : `${hitCapPct.toFixed(1)}%`}
          tone={hitCapPct != null && hitCapPct > 10 ? 'yellow' : 'slate'}
          accent={hitCapPct != null && hitCapPct > 10 ? <Badge tone="yellow">high</Badge> : undefined}
        />
      </div>

      {/* Estimated daily spend trend */}
      <Card>
        <div style={{ padding: 16 }}>
          {label(
            `Estimated model spend per day · last ${usage === undefined ? 14 : usage.days.length} days${
              usage !== undefined ? ` · ${fmtNumber(usage.totals.distinct_users)} distinct users` : ''
            }`,
          )}
          <div style={{ marginTop: 10 }}>
            <DailyBars data={spendBars} color="var(--green-400, #34d399)" height={150} />
          </div>
        </div>
      </Card>

      {/* Token split + per-model spend */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr)', gap: 16, alignItems: 'stretch' }}>
        <Card>
          <div style={{ padding: 16 }}>
            {label('Token usage · 7d')}
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, textAlign: 'center' }}>
              <div style={{ borderRadius: 8, background: 'var(--slate-50)', padding: 12 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--slate-900)' }} className="mono">
                  {usage === undefined ? '—' : fmtTok(usage.totals.tokens_in_7d)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--slate-500)' }}>Input</div>
              </div>
              <div style={{ borderRadius: 8, background: 'var(--slate-50)', padding: 12 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--slate-900)' }} className="mono">
                  {usage === undefined ? '—' : fmtTok(usage.totals.tokens_out_7d)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--slate-500)' }}>Output</div>
              </div>
              <div style={{ borderRadius: 8, background: 'var(--slate-50)', padding: 12 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--slate-900)' }} className="mono">
                  {usage === undefined ? '—' : `${Math.round(usage.totals.cache_read_pct * 100)}%`}
                </div>
                <div style={{ fontSize: 11, color: 'var(--slate-500)' }}>Cache read</div>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div style={{ padding: 16 }}>
            {label('Spend by model · 7d')}
            {usage === undefined ? (
              <div style={{ marginTop: 10, height: 80, background: 'var(--slate-100)', borderRadius: 8 }} className="animate-pulse" />
            ) : usage.totals.by_model.length === 0 ? (
              <p style={{ marginTop: 10, fontSize: 12, color: 'var(--slate-400)' }}>No turns in the last 7 days.</p>
            ) : (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {(() => {
                  const maxCost = Math.max(0.0001, ...usage.totals.by_model.map(x => x.est_cost_usd))
                  return usage.totals.by_model.map(m => (
                    <BarRow
                      key={m.model}
                      label={<span title={m.model}>{shortModel(m.model)}</span>}
                      value={m.est_cost_usd}
                      max={maxCost}
                      color="var(--green-400, #34d399)"
                      valueLabel={`${money(m.est_cost_usd, { cents: true })} · ${fmtNumber(m.turns)} turns`}
                    />
                  ))
                })()}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Deployment engagement KPI strip (api.opsOtoAi.conversations) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <StatCard
          label="Conversations · 7d"
          value={convData === undefined ? '—' : fmtNumber(convData.kpis.conversations_7d)}
        />
        <StatCard
          label="Avg messages"
          value={convData === undefined ? '—' : convData.kpis.avg_messages == null ? '—' : convData.kpis.avg_messages.toFixed(1)}
        />
        <StatCard
          label="→ booking"
          value={
            convData === undefined
              ? '—'
              : convData.kpis.to_booking_pct == null
                ? '—'
                : `${Math.round(convData.kpis.to_booking_pct * 100)}%`
          }
        />
      </div>
    </div>
  )
}

// ===========================================================================
// T5 transcript viewer — deployment-wide 3-pane reader (api.opsOtoAi.*)
// left conversation list · center chat bubbles · right message metadata.
// ===========================================================================

// Action-kind → Badge tone for the "Oto actions" timeline.
const actionTone = (k: string): 'green' | 'blue' | 'purple' | 'slate' =>
  k === 'booking' ? 'green' : k === 'vehicle_update' ? 'blue' : k === 'record_confirm' ? 'purple' : 'slate'

type RenderCardShape = { kind: string; title: string; fields: { label: string; value: string }[] }
type T5Message = {
  id: string
  role: string
  content: string
  timestamp: number
  confidence: number | null
  metadata: unknown
  render: RenderCardShape[]
}

// The mobile booking bottom-sheet / vehicle-update card a render turn produced,
// shown inline where the bubble would otherwise be empty.
const RenderSheet = ({ card }: { card: RenderCardShape }) => {
  const accent =
    card.kind === 'booking'
      ? { border: '#a7f3d0', bg: 'rgba(236,253,245,0.6)' }
      : card.kind === 'vehicle_update'
        ? { border: '#BFDBFE', bg: 'rgba(239,246,255,0.6)' }
        : { border: '#E9D5FF', bg: 'rgba(250,245,255,0.6)' }
  const icon = card.kind === 'booking' ? '📋' : card.kind === 'vehicle_update' ? '🚗' : '🧾'
  return (
    <div style={{ maxWidth: '85%', borderRadius: 12, border: `1px solid ${accent.border}`, background: accent.bg, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ marginBottom: 4, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--slate-700)' }}>
        <span>{icon}</span>
        {card.title}
        <span style={{ borderRadius: 999, background: 'rgba(255,255,255,0.7)', padding: '1px 6px', fontSize: 10, fontWeight: 500, color: 'var(--slate-500)' }}>
          rendered in-app
        </span>
      </div>
      {card.fields.length === 0 ? (
        <div style={{ color: 'var(--slate-400)' }}>(no details captured)</div>
      ) : (
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {card.fields.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <dt style={{ width: 80, flexShrink: 0, color: 'var(--slate-400)' }}>{f.label}</dt>
              <dd style={{ margin: 0, color: 'var(--slate-700)' }}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

const T5Viewer = ({ token }: { token: string }) => {
  const [selected, setSelected] = useState<string | null>(null)
  const [focusMsg, setFocusMsg] = useState<T5Message | null>(null)

  const data = useQuery(api.opsOtoAi.conversations, { token })
  const transcript = useQuery(
    api.opsOtoAi.transcript,
    selected ? { token, conversationId: selected as Id<'ai_conversations'> } : 'skip',
  )
  const logView = useMutation(api.opsOtoAi.logTranscriptView)

  // Access-log each transcript open exactly once (PII audit row).
  useEffect(() => {
    if (selected) {
      void logView({ token, conversationId: selected as Id<'ai_conversations'> })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr 260px', gap: 14, alignItems: 'start', minHeight: 0 }}>
      {/* Left — conversation list */}
      <div style={{ maxHeight: 620, overflowY: 'auto', borderRadius: 10, border: '1px solid var(--slate-200)', background: '#fff' }}>
        {data === undefined ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ height: 48, borderRadius: 8, background: 'var(--slate-100)' }} className="animate-pulse" />
            ))}
          </div>
        ) : data.rows.length === 0 ? (
          <p style={{ padding: 16, fontSize: 13, color: 'var(--slate-500)' }}>No conversations on this deployment.</p>
        ) : (
          data.rows.map(c => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => { setSelected(c.id); setFocusMsg(null) }}
              onKeyDown={ev => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSelected(c.id); setFocusMsg(null) }
              }}
              style={{
                display: 'block', width: '100%', cursor: 'pointer', textAlign: 'left',
                borderBottom: '1px solid var(--slate-50)', padding: '10px 12px',
                background: selected === c.id ? 'var(--blue-50)' : 'transparent',
              }}
              onMouseEnter={e => { if (selected !== c.id) (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)' }}
              onMouseLeave={e => { if (selected !== c.id) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  onClick={e => { e.stopPropagation(); gotoEntity('users', c.user_id) }}
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: 'var(--slate-800)', cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--blue-700)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--slate-800)'}
                >
                  {c.user ?? 'Unknown user'}
                </span>
                {c.led_to_booking && (
                  <Badge tone="green">→ booking{c.booking_status ? ` · ${c.booking_status.replace(/_/g, ' ')}` : ''}</Badge>
                )}
              </div>
              {c.vehicleYmm && (
                <div style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 500, color: 'var(--slate-600)' }}>
                  🚗 {c.vehicleYmm}
                </div>
              )}
              <div style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--slate-400)' }}>
                {formatTs(c.started_at)}
                {c.scenario && <Badge tone="slate">{c.scenario}</Badge>}
                {c.model && <Badge tone="purple">{shortModel(c.model)}</Badge>}
                {c.mood && <Badge tone="slate">{c.mood}</Badge>}
                {c.message_count != null && <span>{c.message_count} msgs</span>}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Center — bubbles */}
      <div style={{ maxHeight: 620, overflowY: 'auto', borderRadius: 10, border: '1px solid var(--slate-200)', background: '#fff', padding: 16 }}>
        {!selected ? (
          <p style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: 'var(--slate-500)' }}>
            Pick a conversation — bubbles render here, read-only.
          </p>
        ) : transcript === undefined ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} style={{ height: 48, borderRadius: 12, background: 'var(--slate-100)' }} className="animate-pulse" />
            ))}
          </div>
        ) : transcript === null ? (
          <p style={{ fontSize: 13, color: 'var(--red-700)' }}>That conversation no longer exists.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(transcript.vehicleYmm || transcript.telemetry) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderRadius: 8, border: '1px solid var(--slate-100)', background: 'var(--slate-50)', padding: '8px 12px', fontSize: 12 }}>
                {transcript.vehicleYmm && <span style={{ fontWeight: 500, color: 'var(--slate-700)' }}>🚗 {transcript.vehicleYmm}</span>}
                {transcript.telemetry && (
                  <>
                    <span style={{ color: 'var(--slate-500)' }}>
                      {transcript.telemetry.turns} turns · {money(transcript.telemetry.estCostUsd, { cents: true })}
                    </span>
                    <span style={{ color: 'var(--slate-400)' }}>
                      {fmtTok(transcript.telemetry.tokensIn)} in / {fmtTok(transcript.telemetry.tokensOut)} out · {fmtNumber(transcript.telemetry.p50LatencyMs)}ms p50
                    </span>
                    {transcript.telemetry.models.map((mo: string) => (
                      <Badge key={mo} tone="purple">{shortModel(mo)}</Badge>
                    ))}
                  </>
                )}
              </div>
            )}
            {/* Booking outcome — did Oto's "it's booked" actually land? */}
            {transcript.bookingOutcome.state === 'created' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderRadius: 8, border: '1px solid #a7f3d0', background: '#ecfdf5', padding: '8px 12px', fontSize: 12 }}>
                <span style={{ fontWeight: 600, color: '#065f46' }}>✅ Booking created</span>
                {transcript.bookingOutcome.services.length > 0 && (
                  <span style={{ color: '#047857' }}>{transcript.bookingOutcome.services.join(', ')}</span>
                )}
                <Badge tone="green">{transcript.bookingOutcome.status.replace(/_/g, ' ')}</Badge>
                {(transcript.bookingOutcome.scheduledDate || transcript.bookingOutcome.shopName) && (
                  <span style={{ color: '#047857' }}>
                    {[transcript.bookingOutcome.scheduledDate ? fmtDate(transcript.bookingOutcome.scheduledDate) : null, transcript.bookingOutcome.scheduledTime].filter(Boolean).join(' ')}
                    {transcript.bookingOutcome.shopName ? ` · ${transcript.bookingOutcome.shopName}` : ''}
                  </span>
                )}
                <span
                  onClick={() => gotoEntity('bookings', transcript.bookingOutcome.state === 'created' ? transcript.bookingOutcome.bookingId : '')}
                  style={{ marginLeft: 'auto', fontWeight: 500, color: '#065f46', textDecoration: 'underline', cursor: 'pointer' }}
                >
                  open booking →
                </span>
              </div>
            )}
            {transcript.bookingOutcome.state === 'not_created' && (
              <div style={{ borderRadius: 8, border: '1px solid #fde68a', background: '#fffbeb', padding: '8px 12px', fontSize: 12, fontWeight: 500, color: '#92400e' }}>
                ⚠️ Oto teed up a booking in this conversation, but none is linked — it may have over-claimed, or the user never finished the flow.
              </div>
            )}

            {/* What Oto DID — action timeline (renders + data/memory writes). */}
            {transcript.actions.length > 0 && (
              <div style={{ borderRadius: 8, border: '1px solid var(--slate-200)', background: '#fff', padding: '8px 12px' }}>
                {label('Oto actions')}
                <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {transcript.actions.map((a, idx) => (
                    <li key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                      <Badge tone={actionTone(a.kind)}>{a.kind.replace(/_/g, ' ')}</Badge>
                      <span style={{ color: 'var(--slate-700)' }}>
                        <span style={{ fontWeight: 500 }}>{a.label}</span>
                        {a.detail ? <span style={{ color: 'var(--slate-500)' }}> — {a.detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {transcript.arc && (
              <div style={{ borderRadius: 8, background: 'var(--slate-50)', padding: '8px 12px', fontSize: 12, fontStyle: 'italic', color: 'var(--slate-500)' }}>
                arc: {transcript.arc}
              </div>
            )}
            {(transcript.messages as T5Message[]).map(m => {
              if (m.role === 'system') {
                return (
                  <details key={m.id} style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                    <summary style={{ cursor: 'pointer' }}>system message</summary>
                    <div style={{ marginTop: 4, borderRadius: 6, background: 'var(--slate-50)', padding: 8, whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  </details>
                )
              }
              const hasText = m.content.trim().length > 0
              const hasRender = m.render && m.render.length > 0
              return (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  {hasText && (
                    <button
                      onClick={() => setFocusMsg(m)}
                      style={{
                        display: 'block', maxWidth: '85%', textAlign: 'left', borderRadius: 12, padding: '8px 14px',
                        fontSize: 13, lineHeight: 1.5, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        color: 'var(--slate-800)',
                        border: `1px solid ${m.role === 'user' ? '#BFDBFE' : 'var(--slate-200)'}`,
                        background: m.role === 'user' ? '#EFF6FF' : '#fff',
                        boxShadow: focusMsg?.id === m.id ? '0 0 0 2px #93C5FD' : 'none',
                      }}
                    >
                      {m.content}
                    </button>
                  )}
                  {hasRender && m.render.map((card, ci) => <RenderSheet key={ci} card={card} />)}
                  {!hasText && !hasRender && m.role === 'assistant' && (
                    <div style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--slate-300)' }}>(no text)</div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Right — metadata */}
      <div style={{ borderRadius: 10, border: '1px solid var(--slate-200)', background: '#fff', padding: 16 }}>
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--slate-900)' }}>Message metadata</h4>
        {!focusMsg ? (
          <p style={{ marginTop: 10, fontSize: 13, color: 'var(--slate-500)' }}>
            Click a bubble to inspect confidence and timing.
          </p>
        ) : (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div>
              <span style={{ color: 'var(--slate-500)' }}>role</span>{' '}
              <span style={{ fontWeight: 500, color: 'var(--slate-800)' }}>{focusMsg.role}</span>
            </div>
            <div>
              <span style={{ color: 'var(--slate-500)' }}>at</span>{' '}
              <span style={{ fontWeight: 500, color: 'var(--slate-800)' }}>{formatTs(focusMsg.timestamp)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--slate-500)' }}>confidence</span>{' '}
              <span style={{ fontWeight: 500, color: 'var(--slate-800)' }}>
                {focusMsg.confidence == null ? '—' : focusMsg.confidence.toFixed(2)}
              </span>
            </div>
            {transcript && transcript !== null && transcript.scenario && (
              <div>
                <span style={{ color: 'var(--slate-500)' }}>scenario</span>{' '}
                <Badge tone="slate">{transcript.scenario}</Badge>
              </div>
            )}
            {focusMsg.metadata != null &&
              (typeof focusMsg.metadata !== 'object' || Object.keys(focusMsg.metadata as object).length > 0) && (
                <div>
                  <span style={{ color: 'var(--slate-500)' }}>metadata</span>
                  <pre style={{ marginTop: 4, maxHeight: 192, overflow: 'auto', borderRadius: 6, background: 'var(--slate-50)', padding: 8, fontSize: 11, lineHeight: 1.4, color: 'var(--slate-600)' }} className="mono">
                    {JSON.stringify(focusMsg.metadata, null, 2)}
                  </pre>
                </div>
              )}
          </div>
        )}

        {/* Conversation-level telemetry (always shown once a transcript loads) */}
        {transcript && transcript !== null && transcript.telemetry && (
          <div style={{ marginTop: 16, borderTop: '1px solid var(--slate-100)', paddingTop: 12 }}>
            {label('Conversation telemetry')}
            <dl style={{ margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <dt style={{ color: 'var(--slate-500)' }}>Turns</dt>
                <dd style={{ margin: 0, color: 'var(--slate-700)' }} className="mono">{transcript.telemetry.turns}</dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <dt style={{ color: 'var(--slate-500)' }}>Est. cost</dt>
                <dd style={{ margin: 0, color: 'var(--slate-700)' }} className="mono">{money(transcript.telemetry.estCostUsd, { cents: true })}</dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <dt style={{ color: 'var(--slate-500)' }}>Tokens (in/out)</dt>
                <dd style={{ margin: 0, color: 'var(--slate-700)' }} className="mono">
                  {fmtTok(transcript.telemetry.tokensIn)} / {fmtTok(transcript.telemetry.tokensOut)}
                </dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <dt style={{ color: 'var(--slate-500)' }}>Cache read</dt>
                <dd style={{ margin: 0, color: 'var(--slate-700)' }} className="mono">{fmtTok(transcript.telemetry.cacheRead)}</dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <dt style={{ color: 'var(--slate-500)' }}>p50 latency</dt>
                <dd style={{ margin: 0, color: 'var(--slate-700)' }} className="mono">{fmtNumber(transcript.telemetry.p50LatencyMs)} ms</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  )
}

export const TabOtoConversations = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''

  // ── user picker (same pattern as the Sim tab) ─────────────────────────────
  const users = useQuery(api.director.usersList, { token })
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<{ id: string; name: string; email: string } | null>(null)
  const [openId, setOpenId] = useState<Id<'ai_conversations'> | null>(null)

  const filtered = (users ?? []).filter(u => {
    if (!q) return false
    const n = q.toLowerCase()
    return u.name.toLowerCase().includes(n) || u.email.toLowerCase().includes(n) || (u.phone ?? '').includes(q)
  }).slice(0, 8)

  const pickUser = (u: { id: string; name: string; email: string }) => { setSelected(u); setQ(''); setOpenId(null) }

  // ── paginated conversation list ───────────────────────────────────────────
  const { results, status, loadMore } = usePaginatedQuery(
    api.oto.directorConversations.listUserConversations,
    selected ? { token, userId: selected.id as Id<'users'> } : 'skip',
    { initialNumItems: 20 },
  )
  const conversations = (results ?? []) as ConversationRow[]

  return (
    <SectionAnchor id="otoConversations" title="Oto History"
      subtitle="Read any user's past production Oto conversations — transcript plus per-turn debug (model, tools, tokens, latency). Sims are excluded; a sim continued into an existing production conversation is indistinguishable until per-message tagging lands. Transcripts are raw user text — PII stays in the panel.">

      {/* ── PII access-log banner (T5 opens write an audit row) ───────────── */}
      <div style={{ marginBottom: 16, borderRadius: 8, border: '1px solid #FDE68A', background: 'var(--yellow-50)', padding: '8px 14px', fontSize: 12, fontWeight: 600, color: 'var(--yellow-800)' }}>
        Private user conversation — access logged. Every transcript open in the reader below writes an audit row with your name on it.
      </div>

      {/* ── 0. Model usage & spend (api.directorData.otoUsage) ────────────── */}
      <UsageZone token={token} />

      {/* ── T5 · deployment-wide transcript reader (api.opsOtoAi.*) ───────── */}
      <div style={{ marginTop: 24 }}>
        <SectionTitle heading="Transcript reader" sub="Latest 200 conversations on this deployment · model usage, spend, and read-only transcripts of the in-app assistant." />
        <T5Viewer token={token} />
      </div>

      {/* ── 1. User selector (existing director-native history lookup) ────── */}
      <div style={{ marginTop: 24 }}>
        <SectionTitle heading="Per-user history" sub="Look up a specific user and page through their production conversations with full per-turn debug." />
        <Card>
          <div style={{ padding: 14 }}>
            {label('1 · User')}
            {selected ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Badge tone="indigo">{selected.name}</Badge>
                <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>{selected.email}</span>
                <span style={{ flex: 1 }} />
                <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setOpenId(null) }}>Change user</Button>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)}
                  placeholder={users === undefined ? 'Loading users…' : 'Search by name, email, or phone…'} style={{ width: 420 }} />
                {q && (
                  <div style={{ marginTop: 6, border: '1px solid var(--slate-200)', borderRadius: 8, background: '#fff', maxHeight: 260, overflowY: 'auto' }}>
                    {filtered.length === 0
                      ? <div style={{ padding: 10, fontSize: 12, color: 'var(--slate-400)' }}>No matches.</div>
                      : filtered.map(u => (
                        <div key={u.id} onClick={() => pickUser(u)} data-testid="otoconv-user" data-email={u.email}
                          style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--slate-100)', display: 'flex', justifyContent: 'space-between', gap: 10 }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)'}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#fff'}>
                          <span style={{ fontSize: 13, color: 'var(--slate-800)' }}>{u.name}</span>
                          <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>{u.email}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* ── 2. Conversations + transcript ─────────────────────────────── */}
        {selected && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.8fr', gap: 14, marginTop: 14, alignItems: 'start' }}>
            <Card>
              <div style={{ padding: 14 }}>
                {label(`2 · Production conversations${status === 'LoadingFirstPage' ? '' : ` (${conversations.length}${status === 'CanLoadMore' ? '+' : ''})`}`)}
                {status === 'LoadingFirstPage'
                  ? <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>Loading…</div>
                  : conversations.length === 0
                    ? <div style={{ fontSize: 12, color: 'var(--slate-400)', fontStyle: 'italic' }}>No production conversations for this user.</div>
                    : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 520, overflowY: 'auto' }}>
                        {conversations.map(c => (
                          <div key={c._id} onClick={() => setOpenId(c._id)} data-testid="otoconv-row"
                            style={{
                              border: `1px solid ${openId === c._id ? 'var(--blue-300, #93C5FD)' : 'var(--slate-200)'}`,
                              background: openId === c._id ? 'var(--blue-50)' : '#fff',
                              borderRadius: 8, padding: '8px 10px', cursor: 'pointer',
                            }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-800)' }}>{formatTs(c.started_at)}</span>
                              {c.led_to_booking && <Badge tone="green">→ booking</Badge>}
                              {c.current_model === 'sonnet' && <Badge tone="purple">sonnet</Badge>}
                            </div>
                            <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 11, color: 'var(--slate-500)', flexWrap: 'wrap' }}>
                              {c.vehicle && <span>{c.vehicle}</span>}
                              <span>{c.message_count} msg{c.message_count === 1 ? '' : 's'}</span>
                              {c.mood && <span>mood: {c.mood}</span>}
                            </div>
                          </div>
                        ))}
                        {status === 'CanLoadMore' && (
                          <Button size="sm" variant="ghost" onClick={() => loadMore(20)}>Load more</Button>
                        )}
                      </div>
                    )}
              </div>
            </Card>

            <Card>
              <div style={{ padding: 16 }}>
                {openId
                  ? <TranscriptPane conversationId={openId} token={token} />
                  : <div style={{ fontSize: 12, color: 'var(--slate-400)', fontStyle: 'italic', padding: 16 }}>Select a conversation to read the transcript.</div>}
              </div>
            </Card>
          </div>
        )}
      </div>
    </SectionAnchor>
  )
}
