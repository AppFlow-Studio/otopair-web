'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge } from '../../Primitives'
import { H2, Field, Loading, fmtDate, providerLabel, sourceLabel, statusTone, openMechanic } from './usersUi'

const OtoActivity = ({ userId, onOpenBooking }: { userId: Id<'users'>; onOpenBooking: (id: Id<'bookings'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const convos = useQuery(api.opsUsers.otoConversations, { token: session?.token ?? '', id: userId })
  if (convos === undefined) return <div style={{ padding:'20px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading Oto activity…</div>
  if (convos.length === 0) return <div style={{ padding:'20px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>No Oto conversations yet.</div>
  return (
    <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
      {convos.map(c => (
        <div key={c.id} style={{ borderRadius:8, border:'1px solid var(--slate-100)', padding:12 }}>
          <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8, fontSize:12, color:'var(--slate-500)' }}>
            <span style={{ fontWeight:500, color:'var(--slate-700)' }}>{c.vehicleYmm ?? 'Vehicle —'}</span>
            <span>{fmtDate(c.started_at)}</span>
            {c.mood && <Badge tone="slate">{c.mood}</Badge>}
            {c.message_count != null && <span>{c.message_count} msgs</span>}
            {c.bookingOutcome.state === 'created' && (() => {
              const bid = c.bookingOutcome.bookingId as Id<'bookings'>
              const st = c.bookingOutcome.status
              return (
                <span onClick={() => onOpenBooking(bid)} style={{ cursor:'pointer' }}>
                  <Badge tone="green">→ booking · {st.replace(/_/g, ' ')}</Badge>
                </span>
              )
            })()}
            {c.bookingOutcome.state === 'not_created' && <Badge tone="yellow">booking mentioned, none created</Badge>}
          </div>
          {c.actions.length > 0 && (
            <ul style={{ margin:'6px 0 0', padding:0, listStyle:'none', display:'flex', flexDirection:'column', gap:2 }}>
              {c.actions.map((a, i) => (
                <li key={i} style={{ fontSize:12, color:'var(--slate-600)' }}>
                  <span style={{ fontWeight:500 }}>{a.label}</span>{a.detail ? <span style={{ color:'var(--slate-400)' }}> — {a.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

export const UserEngagementTab = ({ userId, onOpenUser, onOpenBooking }:
  { userId: Id<'users'>; onOpenUser: (id: Id<'users'>) => void; onOpenBooking: (id: Id<'bookings'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const data = useQuery(api.opsUsers.engagement, { token: session?.token ?? '', id: userId })

  if (data === undefined) return <Loading label="engagement" />
  if (data === null) return <Loading label="engagement" />

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, alignItems:'start' }}>
      <div style={{ gridColumn:'1 / -1' }}>
        <Card>
          <H2>Recent Oto conversations</H2>
          <OtoActivity userId={userId} onOpenBooking={onOpenBooking} />
        </Card>
      </div>

      <Card>
        <H2>Acquisition</H2>
        <div style={{ marginTop:14, display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          <Field label="Auth provider" value={providerLabel(data.authProvider)} />
          <Field label="Source" value={sourceLabel(data.acquisitionSource)} />
          {data.walkInClaimedAt != null && <Field label="Walk-in claimed" value={fmtDate(data.walkInClaimedAt)} />}
        </div>
        <div style={{ marginTop:16, borderTop:'1px solid var(--slate-100)', paddingTop:14 }}>
          <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>Referred by</div>
          {data.referredBy ? (
            <div style={{ marginTop:4, fontSize:13, color:'var(--slate-800)' }}>
              {data.referredBy.referrerId
                ? <a onClick={() => onOpenUser(data.referredBy!.referrerId as Id<'users'>)} style={{ fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>{data.referredBy.referrerName ?? 'Unknown referrer'}</a>
                : <span style={{ fontWeight:500 }}>{data.referredBy.referrerName ?? 'Unknown referrer'}</span>}
              <span style={{ marginLeft:8 }}><Badge tone={statusTone(data.referredBy.status)}>{data.referredBy.status}</Badge></span>
              <div style={{ marginTop:2, fontSize:12, color:'var(--slate-400)' }}>
                {data.referredBy.code ? `code ${data.referredBy.code} · ` : ''}{fmtDate(data.referredBy.createdAt)}{data.referredBy.creditedAt ? ` · credited ${fmtDate(data.referredBy.creditedAt)}` : ''}
              </div>
            </div>
          ) : <div style={{ marginTop:4, fontSize:13, color:'var(--slate-500)' }}>Not referred (direct signup).</div>}
        </div>
        <div style={{ marginTop:14, borderTop:'1px solid var(--slate-100)', paddingTop:14 }}>
          <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>Referrals made</div>
          <div style={{ marginTop:4, display:'flex', alignItems:'center', gap:10, fontSize:13 }}>
            <span style={{ fontWeight:600, color:'var(--slate-900)' }}>{data.referralsMade.total}</span>
            <span style={{ color:'var(--slate-400)' }}>total</span>
            {data.referralsMade.credited > 0 && <Badge tone="green">{data.referralsMade.credited} credited</Badge>}
            {data.referralsMade.pending > 0 && <Badge tone="yellow">{data.referralsMade.pending} pending</Badge>}
          </div>
        </div>
      </Card>

      <Card>
        <H2>Notifications &amp; preferences</H2>
        <div style={{ marginTop:14, display:'flex', alignItems:'center', gap:8 }}>
          <Badge tone={data.pushRegistered ? 'green' : 'slate'}>{data.pushRegistered ? 'Push registered' : 'No push token'}</Badge>
          {data.pushTokenUpdatedAt != null && <span style={{ fontSize:12, color:'var(--slate-400)' }}>updated {fmtDate(data.pushTokenUpdatedAt)}</span>}
        </div>
        <div style={{ marginTop:14, borderTop:'1px solid var(--slate-100)', paddingTop:14 }}>
          {!data.notifications.hasPreferencesRow
            ? <p style={{ margin:0, fontSize:13, color:'var(--slate-500)' }}>No preferences row — user hasn’t customized notifications (platform defaults apply).</p>
            : data.notifications.entries.length === 0
              ? <p style={{ margin:0, fontSize:13, color:'var(--slate-500)' }}>Preferences row exists but is empty.</p>
              : <ul style={{ margin:0, padding:0, listStyle:'none', display:'flex', flexDirection:'column', gap:6 }}>
                {data.notifications.entries.map(e => (
                  <li key={e.key} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:13 }}>
                    <span style={{ color:'var(--slate-600)' }}>{e.key.replace(/_/g, ' ')}</span>
                    {e.enabled != null ? <Badge tone={e.enabled ? 'green' : 'slate'}>{e.enabled ? 'On' : 'Off'}</Badge> : <span style={{ color:'var(--slate-500)' }}>{e.value ?? '—'}</span>}
                  </li>
                ))}
              </ul>}
        </div>
      </Card>

      <Card>
        <H2>Saved addresses</H2>
        {data.savedAddresses.length === 0
          ? <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-500)' }}>No saved addresses.</p>
          : <ul style={{ margin:'12px 0 0', padding:0, listStyle:'none', display:'flex', flexDirection:'column', gap:8 }}>
            {data.savedAddresses.map(a => (
              <li key={a.id} style={{ fontSize:13 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontWeight:500, color:'var(--slate-800)' }}>{a.label}</span>
                  <Badge tone="slate">{a.type}</Badge>
                  {a.isPrimary && <Badge tone="green">primary</Badge>}
                </div>
                <div style={{ fontSize:12, color:'var(--slate-500)' }}>{a.address}</div>
              </li>
            ))}
          </ul>}
      </Card>

      <Card>
        <H2>Preferences</H2>
        <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:12 }}>
          <div>
            <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>Mechanic preferences</div>
            {data.mechanicPreferences.length === 0
              ? <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--slate-500)' }}>None set.</p>
              : <ul style={{ margin:'4px 0 0', padding:0, listStyle:'none', display:'flex', flexDirection:'column', gap:4 }}>
                {data.mechanicPreferences.map(m => (
                  <li key={m.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13 }}>
                    {m.mechanic && m.mechanicId
                      ? <a onClick={() => openMechanic(m.mechanicId!)} style={{ color:'var(--blue-600)', cursor:'pointer' }}>{m.mechanic}</a>
                      : <span style={{ color:'var(--slate-700)' }}>{m.mechanic ?? 'Unknown mechanic'}</span>}
                    {m.isFavorite && <Badge tone="yellow">★ favorite</Badge>}
                    {m.isHidden && <Badge tone="slate">hidden</Badge>}
                  </li>
                ))}
              </ul>}
          </div>
          <div style={{ borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
            <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>Onboarding</div>
            {data.onboarding ? (
              <div style={{ marginTop:4, fontSize:13, color:'var(--slate-700)', display:'flex', flexWrap:'wrap', alignItems:'center', gap:6 }}>
                {data.onboarding.carKnowledgeLevel && <span>Car knowledge: <b>{data.onboarding.carKnowledgeLevel}</b></span>}
                {data.onboarding.hasAnswers && <Badge tone="slate">Q&amp;A on file</Badge>}
                {data.onboarding.hasIntentions && <Badge tone="slate">intent captured</Badge>}
                {data.onboarding.lastUpdated && <span style={{ width:'100%', fontSize:11, color:'var(--slate-400)' }}>updated {fmtDate(data.onboarding.lastUpdated)}</span>}
              </div>
            ) : <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--slate-500)' }}>No onboarding answers on file.</p>}
          </div>
        </div>
      </Card>
    </div>
  )
}
