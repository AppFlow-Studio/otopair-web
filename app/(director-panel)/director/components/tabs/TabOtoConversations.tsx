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
 */
import { useState, useContext } from 'react'
import { useQuery, usePaginatedQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Input, Card, Badge, IconSearch } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'

const formatTs = (ts: number | null | undefined) =>
  ts
    ? new Date(ts).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : '—'

const label = (text: string) => (
  <div style={{ fontSize: 11, color: 'var(--slate-500)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
    {text}
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

      {/* ── 1. User selector ──────────────────────────────────────────── */}
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
    </SectionAnchor>
  )
}
