'use client'

import { useState, useContext, useRef, useEffect } from 'react'
import { useQuery, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Input, Card, Badge, IconSearch, IconCar } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { summarizeRenderDirectives, type RenderDirectiveRow } from './renderDirectiveSummary'

type QuickReply = { id?: string; text: string; value?: string; variant?: string }
type ChatMsg = { role: 'user' | 'assistant'; text: string; quickReplies?: QuickReply[]; render?: RenderDirectiveRow[] }
type UserCar = { vehicleId: string | null; vin: string; ymm: string; nickname?: string; mileage?: number }

type CardState = {
  busy?: boolean
  result?: string
  ok?: boolean
  // Set when applyVehicleTruth returns a reconfirmable (absurd_forward)
  // rejection — drives the inline reconfirm component on the card.
  reconfirm?: { message: string; payload: any }
}

type TruthResult = {
  ok?: boolean; needsReconfirm?: boolean; reconfirmable?: boolean; reason?: string
  current?: number | null; proposed?: number; maxAllowed?: number
  mileageUpdated?: boolean; servicesFlagged?: string[]; servicesCompleted?: string[]; faultLightsAdded?: string[]
}

const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

// Plain-language copy for a HARD (non-reconfirmable) mileage rejection.
function rejectionMessage(res: TruthResult): string {
  switch (res?.reason) {
    case 'backward':
      return `Can't apply — ${num(res.proposed)} mi is below the recorded ${num(res.current)} mi. An odometer can't go backward.`
    case 'implausible':
      return `Can't apply — that isn't a valid odometer reading.`
    default:
      return `Couldn't apply: ${res?.reason ?? 'rejected'}.`
  }
}

// Applied-success summary line.
function appliedMessage(res: TruthResult): string {
  return `✓ Applied${res.mileageUpdated ? ' · mileage' : ''}` +
    `${res.servicesCompleted?.length ? ` · recorded done ${res.servicesCompleted.join(', ')}` : ''}` +
    `${res.servicesFlagged?.length ? ` · flagged ${res.servicesFlagged.join(', ')}` : ''}` +
    `${res.faultLightsAdded?.length ? ` · lights ${res.faultLightsAdded.join(', ')}` : ''}`
}

const levelLabel = (lvl: number | string | null | undefined): string | null => {
  if (lvl == null) return null
  if (typeof lvl === 'number') return lvl <= 1 ? 'beginner' : lvl === 2 ? 'intermediate' : 'experienced'
  return String(lvl)
}

export const TabOtoSim = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const sim = useAction(api.oto.simulate.simulateOtoForDirector)
  const applyTruth = useAction(api.vehicleTruth.applyVehicleTruthForDirector)
  // Per-card interaction state, keyed `${messageIndex}:${directiveKey}`.
  const [cardState, setCardState] = useState<Record<string, CardState>>({})

  // ── user picker (reuses the Users-tab list + the same client filter) ──────
  const users = useQuery(api.director.usersList, { token })
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<{ id: string; name: string; email: string } | null>(null)

  // ── selected user's detail → cars + onboarding level (mirrors Users tab) ──
  const detail = useQuery(api.director.userDetail, selected ? { id: selected.id as Id<'users'>, token } : 'skip')
  const level = useQuery(
    api.onboarding_questions_answers.getCarKnowledgeLevelForUser,
    selected ? { user_id: selected.id as Id<'users'> } : 'skip',
  )
  const cars: UserCar[] = (detail?.vehicles as UserCar[] | undefined) ?? []

  const filtered = (users ?? []).filter(u => {
    if (!q) return false
    const n = q.toLowerCase()
    return u.name.toLowerCase().includes(n) || u.email.toLowerCase().includes(n) || (u.phone ?? '').includes(q)
  }).slice(0, 8)

  // ── chat state ────────────────────────────────────────────────────────────
  const [car, setCar] = useState<UserCar | null>(null)
  const [convoId, setConvoId] = useState<Id<'ai_conversations'> | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [convoState, setConvoState] = useState<{ vehicleId: string | null; mood: string | null; lastUserIntent: string | null; arcSummary: string | null; establishedFacts: string[] } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages, busy])

  const resetConversation = () => { setConvoId(null); setMessages([]); setError(null); setConvoState(null); setCardState({}) }

  // Interact with a render_vehicle_update card the same way the mobile confirm
  // tap does — apply the captured payload for the simulated user via the
  // director-gated wrapper. A big-but-real forward jump (absurd_forward) comes
  // back reconfirmable: we show an inline reconfirm prompt, and "Apply anyway"
  // re-sends with reconfirmed:true. backward / implausible are hard rejections.
  const confirmVehicleUpdate = async (cardId: string, payload: any, reconfirmed = false) => {
    if (!selected || !car || cardState[cardId]?.busy) return
    setCardState(s => ({ ...s, [cardId]: { busy: true } }))
    try {
      const res = await applyTruth({
        token,
        userId: selected.id as Id<'users'>,
        vehicleVin: car.vin,
        ...(payload?.mileage !== undefined ? { mileage: payload.mileage } : {}),
        ...(payload?.service_claims !== undefined ? { service_claims: payload.service_claims } : {}),
        ...(payload?.fault_lights !== undefined ? { fault_lights: payload.fault_lights } : {}),
        ...(reconfirmed ? { reconfirmed: true } : {}),
      }) as TruthResult
      if (res?.ok) {
        setCardState(s => ({ ...s, [cardId]: { result: appliedMessage(res), ok: true } }))
      } else if (res?.needsReconfirm && res?.reconfirmable) {
        const message = `Big jump — record shows ${num(res.current)} mi, and ${num(res.proposed)} mi is past the one-step limit of ${num(res.maxAllowed)} mi. Confirm it's real?`
        setCardState(s => ({ ...s, [cardId]: { reconfirm: { message, payload } } }))
      } else {
        setCardState(s => ({ ...s, [cardId]: { result: rejectionMessage(res), ok: false } }))
      }
    } catch (e) {
      setCardState(s => ({ ...s, [cardId]: { result: (e as Error).message, ok: false } }))
    }
  }
  const pickUser = (u: { id: string; name: string; email: string }) => { setSelected(u); setQ(''); setCar(null); resetConversation() }
  const pickCar = (c: UserCar) => { setCar(c); resetConversation() }
  const changeUser = () => { setSelected(null); setCar(null); resetConversation() }

  const send = async (text: string) => {
    const body = text.trim()
    if (!selected || !car || !body || busy) return
    setError(null)
    setMessages(m => [...m, { role: 'user', text: body }])
    setInput('')
    setBusy(true)
    try {
      const res = await sim({
        token,
        userId: selected.id as Id<'users'>,
        ...(convoId ? { conversationId: convoId } : {}),
        message: body,
        vehicleVin: car.vin, // a car is always selected before chatting (mirrors the app)
      }) as { conversationId: Id<'ai_conversations'>; result?: Record<string, any>; convoState?: typeof convoState }
      setConvoId(res.conversationId)
      const r = (res.result ?? {}) as Record<string, any>
      setMessages(m => [...m, {
        role: 'assistant',
        text: r.text ?? '(no text returned)',
        quickReplies: (r.quickReplies as QuickReply[]) ?? [],
        render: summarizeRenderDirectives(r),
      }])
      if (res.convoState) setConvoState(res.convoState)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const lastChips = messages.length > 0 && messages[messages.length - 1].role === 'assistant'
    ? (messages[messages.length - 1].quickReplies ?? [])
    : []

  const canChat = !!selected && !!car

  return (
    <SectionAnchor id="otoSim" title="Oto Sim"
      subtitle="Chat with the in-app Oto as any user — real authenticated turns through the production agent. Pick a user, then a car (just like the app), then chat. Multi-turn; tagged 'simulation'.">

      {/* ── 1. User selector ──────────────────────────────────────────── */}
      <Card>
        <div style={{ padding:14 }}>
          <div style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>1 · Chat as</div>
          {selected ? (
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
              <Badge tone="indigo">{selected.name}</Badge>
              <span style={{ fontSize:12, color:'var(--slate-500)' }}>{selected.email}</span>
              {levelLabel(level) && <Badge tone="blue">car knowledge: {levelLabel(level)}</Badge>}
              {level === null && <span style={{ fontSize:11, color:'var(--slate-400)' }}>no onboarding level</span>}
              <span style={{ flex:1 }} />
              <Button size="sm" variant="ghost" onClick={changeUser}>Change user</Button>
            </div>
          ) : (
            <div style={{ position:'relative' }}>
              <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)}
                placeholder={users === undefined ? 'Loading users…' : 'Search by name, email, or phone…'} style={{ width:420 }} />
              {q && (
                <div style={{ marginTop:6, border:'1px solid var(--slate-200)', borderRadius:8, background:'#fff', maxHeight:260, overflowY:'auto' }}>
                  {filtered.length === 0
                    ? <div style={{ padding:10, fontSize:12, color:'var(--slate-400)' }}>No matches.</div>
                    : filtered.map(u => (
                      <div key={u.id} onClick={() => pickUser(u)} data-testid="sim-user" data-email={u.email}
                        style={{ padding:'8px 10px', cursor:'pointer', borderBottom:'1px solid var(--slate-100)', display:'flex', justifyContent:'space-between', gap:10 }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#fff'}>
                        <span style={{ fontSize:13, color:'var(--slate-800)' }}>{u.name}</span>
                        <span style={{ fontSize:12, color:'var(--slate-500)' }}>{u.email}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* ── 2. Car selector (required, mirrors the app) ──────────────────── */}
      {selected && (
        <div style={{ marginTop:14 }}>
          <Card>
            <div style={{ padding:14 }}>
              <div style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>2 · Select a car</div>
              {detail === undefined ? (
                <span style={{ fontSize:12, color:'var(--slate-400)' }}>Loading {selected.name}’s cars…</span>
              ) : cars.length === 0 ? (
                <span style={{ fontSize:12, color:'var(--slate-400)' }}>This user has no cars — Oto needs a car to chat about (just like the app). Pick a different user.</span>
              ) : (
                <div style={{ display:'flex', flexWrap:'wrap', gap:10 }}>
                  {cars.map(c => {
                    const active = car?.vin === c.vin
                    return (
                      <div key={c.vin} onClick={() => pickCar(c)} data-testid="sim-car" data-vin={c.vin}
                        style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 12px', cursor:'pointer', borderRadius:9,
                          border:`1.5px solid ${active ? 'var(--blue-600, #2563eb)' : 'var(--slate-200)'}`,
                          background: active ? 'var(--blue-50)' : '#fff' }}>
                        <IconCar size={15} />
                        <div style={{ display:'flex', flexDirection:'column' }}>
                          <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-800)' }}>{c.nickname || c.ymm || c.vin}</span>
                          <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{c.vin}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* ── 3. Chat ──────────────────────────────────────────────────────── */}
      <div style={{ marginTop:14 }}>
        <Card padded={false}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', borderBottom:'1px solid var(--slate-200)' }}>
            <span style={{ fontSize:12, color:'var(--slate-500)' }}>
              {!selected ? 'Pick a user to start'
                : !car ? 'Select a car to start'
                : convoId ? `Live conversation · ${car.nickname || car.ymm || car.vin}`
                : `Ready · chatting about ${car.nickname || car.ymm || car.vin}`}
            </span>
            <Button size="sm" variant="ghost" disabled={!convoId && messages.length === 0} onClick={resetConversation}>New conversation</Button>
          </div>

          <div ref={scrollRef} style={{ height:420, overflowY:'auto', padding:16, background:'var(--slate-25)', display:'flex', flexDirection:'column', gap:10 }}>
            {messages.length === 0 && (
              <div style={{ margin:'auto', fontSize:12, color:'var(--slate-400)', textAlign:'center', maxWidth:400 }}>
                {!selected ? 'Select a user above, then a car, then send a message to drive a real Oto turn.'
                  : !car ? 'Now select one of this user’s cars above.'
                  : `Chatting as ${selected.name} about their ${car.nickname || car.ymm || car.vin}. Try “my brakes are squealing”, “my car won't turn over”, or “I want to chat with my mechanic”.`}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth:'78%',
                display:'flex', flexDirection:'column', gap:6, alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  padding:'9px 12px', borderRadius:12, fontSize:13, lineHeight:1.5, whiteSpace:'pre-wrap',
                  ...(m.role === 'user'
                    ? { background:'var(--blue-700)', color:'#fff', borderBottomRightRadius:4 }
                    : { background:'#fff', color:'var(--slate-800)', border:'1px solid var(--slate-200)', borderBottomLeftRadius:4 }),
                }}>{m.text}</div>
                {/* Render-tool components Oto fired this turn — so the director SEES the
                    card/button the mobile app would draw, instead of just Oto's text. */}
                {m.role === 'assistant' && (m.render?.length ?? 0) > 0 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:6, width:'100%' }}>
                    {m.render!.map(d => {
                      const cardId = `${i}:${d.key}`
                      const st = cardState[cardId]
                      const interactive = d.key === 'showVehicleUpdate'
                      return (
                        <div key={d.key} style={{ display:'flex', alignItems:'center', gap:9, padding:'8px 11px',
                          border:'1px solid var(--blue-200, #BFDBFE)', background:'var(--blue-50)', borderRadius:10 }}>
                          <Badge tone="blue" dot>render</Badge>
                          <div style={{ display:'flex', flexDirection:'column', minWidth:0, flex:1 }}>
                            <span style={{ fontSize:12, fontWeight:600, color:'var(--slate-800)' }}>{d.label}</span>
                            <span style={{ fontSize:11, color:'var(--slate-500)', whiteSpace:'pre-wrap' }}>{d.detail}</span>
                          </div>
                          {interactive && (
                            st?.reconfirm
                              ? <div style={{ display:'flex', flexDirection:'column', gap:6, flexShrink:0, maxWidth:300 }}>
                                  <span style={{ fontSize:11, color:'var(--orange-700, #c2410c)' }}>{st.reconfirm.message}</span>
                                  <div style={{ display:'flex', gap:6 }}>
                                    <Button size="sm" variant="primary"
                                      onClick={() => confirmVehicleUpdate(cardId, st!.reconfirm!.payload, true)}>Apply anyway</Button>
                                    <Button size="sm" variant="ghost"
                                      onClick={() => setCardState(s => ({ ...s, [cardId]: {} }))}>Cancel</Button>
                                  </div>
                                </div>
                              : st?.result
                                ? <span style={{ fontSize:11, fontWeight:600, flexShrink:0,
                                    color: st.ok ? 'var(--green-700)' : 'var(--orange-700, #c2410c)' }}>{st.result}</span>
                                : <Button size="sm" variant="primary" disabled={!!st?.busy || !canChat}
                                    onClick={() => confirmVehicleUpdate(cardId, d.payload)}>
                                    {st?.busy ? 'Applying…' : 'Confirm update'}
                                  </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
            {busy && <div style={{ alignSelf:'flex-start', fontSize:12, color:'var(--slate-400)', padding:'4px 8px' }}>Oto is thinking…</div>}
          </div>

          {lastChips.length > 0 && !busy && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, padding:'10px 14px', borderTop:'1px solid var(--slate-200)' }}>
              {lastChips.map((c, i) => (
                <button key={c.id ?? i} onClick={() => send(c.value ?? c.text)}
                  style={{ fontSize:12, padding:'6px 12px', borderRadius:999, cursor:'pointer',
                    border:'1px solid var(--slate-300)', background: c.variant === 'outline' ? '#fff' : 'var(--slate-100)', color:'var(--slate-700)' }}>
                  {c.text}
                </button>
              ))}
            </div>
          )}

          {/* conversation-state debug strip — what actually persisted this turn */}
          {convoState && (
            <div data-testid="sim-convostate" style={{ display:'flex', flexWrap:'wrap', gap:12, padding:'8px 14px', borderTop:'1px solid var(--slate-200)', background:'var(--slate-25)', fontSize:11, color:'var(--slate-500)' }}>
              <span>vehicle: <b style={{ color: convoState.vehicleId ? 'var(--green-700)' : 'var(--slate-400)' }}>{convoState.vehicleId ? '✓ attached' : '— none'}</b></span>
              <span>mood: <b style={{ color:'var(--slate-700)' }}>{convoState.mood ?? '—'}</b></span>
              <span>intent: <b style={{ color:'var(--slate-700)' }}>{convoState.lastUserIntent ?? '—'}</b></span>
              <span>facts: <b style={{ color:'var(--slate-700)' }}>{convoState.establishedFacts?.length ?? 0}</b></span>
              {convoState.arcSummary && <span style={{ flexBasis:'100%' }}>arc: {convoState.arcSummary}</span>}
            </div>
          )}

          {error && <div style={{ padding:'8px 14px', fontSize:12, color:'var(--red-600, #dc2626)', borderTop:'1px solid var(--slate-200)' }}>Error: {error}</div>}

          <div style={{ display:'flex', gap:8, padding:12, borderTop:'1px solid var(--slate-200)' }}>
            <div style={{ flex:1 }} onKeyDown={e => { if (e.key === 'Enter') send(input) }}>
              <Input value={input} onChange={e => setInput(e.target.value)} disabled={!canChat || busy}
                placeholder={!selected ? 'Pick a user first' : !car ? 'Select a car first' : 'Message Oto…'} />
            </div>
            <Button variant="primary" disabled={!canChat || busy || !input.trim()} onClick={() => send(input)}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </Card>
      </div>
    </SectionAnchor>
  )
}
