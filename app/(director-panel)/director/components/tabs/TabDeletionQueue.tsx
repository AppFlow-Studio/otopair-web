'use client'

// Director · Deletion Queue (#deletionQueue) — faithful port of
// app/(portals)/ops/deletion-queue/page.tsx (Ops spec §5.3). Compliance queue:
// users who asked to be deleted, oldest first, with an SLA stat (red >25d),
// per-row age + grace pills, survey response, an open-bookings blocker, and a
// RESTORE action (users.write) behind a Modal reason ceremony.

import { useState, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import { can } from '@/lib/portal/capabilities'
import {
  Badge, Button, Card, Modal, tableStyles,
} from '../Primitives'
import { StatCard, fmtNumber } from '../Charts'

const DAY = 24 * 60 * 60 * 1000

function ageDays(requestedAt: number | null): number | null {
  if (requestedAt == null) return null
  return Math.floor((Date.now() - requestedAt) / DAY)
}

// Age since the deletion request — amber >7d, red >25d (SLA breach).
function AgePill({ days }: { days: number | null }) {
  if (days === null) return <Badge tone="slate">unknown</Badge>
  const tone = days > 25 ? 'red' : days > 7 ? 'amber' : 'slate'
  return <Badge tone={tone === 'amber' ? 'yellow' : tone}>{days}d</Badge>
}

// Days left in the 30-day compliance grace window before cleanup permanently
// deletes the account — green with room, amber as it nears, red at the wire.
function GracePill({ days }: { days: number | null }) {
  if (days === null) return <span style={{ color:'var(--slate-400)' }}>—</span>
  const tone = days <= 5 ? 'red' : days <= 14 ? 'yellow' : 'green'
  return <Badge tone={tone}>{days}d left</Badge>
}

const PROVIDER_LABEL: Record<string, string> = {
  password: 'Email + password',
  oauth_google: 'Google',
  google: 'Google',
  oauth_apple: 'Apple',
  apple: 'Apple',
  phone: 'Phone',
}
function providerLabel(p: string | null): string | null {
  if (!p) return null
  return PROVIDER_LABEL[p] ?? p.replace(/_/g, ' ')
}

const fmtDate = (ms: number | null) =>
  ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
const fmtSpend = (n: number) => (n > 0 ? `$${Math.round(n).toLocaleString()}` : '—')

type Row = {
  id: string
  name: string
  email: string | null
  phone: string | null
  requested_at: number | null
  survey_response: string | null
  survey_skipped: boolean
  open_bookings: number
  bookings_total: number
  vehicles: number
  primaryVehicle: string | null
  spend: number
  authProvider: string | null
  createdAt: number
  lastActive: number | null
  graceRemainingDays: number | null
}

// ---------------------------------------------------------------------------
// Restore ceremony — director Modal holding a required reason textarea.
// ---------------------------------------------------------------------------

const RestoreModal = ({ row, onClose }: { row: Row | null; onClose: () => void }) => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const restoreUser = useMutation(api.opsDeletion.restoreUser)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const close = () => { setReason(''); setBusy(false); onClose() }

  const handleConfirm = async () => {
    if (!row || reason.trim().length < 4 || busy) return
    setBusy(true)
    try {
      await restoreUser({
        token,
        reason: reason.trim(),
        userId: row.id as Parameters<typeof restoreUser>[0]['userId'],
      })
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={!!row} onClose={close} width={480}
      title="Restore user"
      footer={<>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={handleConfirm} disabled={reason.trim().length < 4 || busy}>
          {busy ? 'Restoring…' : 'Restore user'}
        </Button>
      </>}>
      <div style={{ padding:22 }}>
        <div style={{ fontSize:13, color:'var(--slate-600)', lineHeight:1.5, marginBottom:16 }}>
          {row && <>
            <b style={{ color:'var(--slate-900)' }}>{row.name}</b> will be taken out of the deletion
            queue: the pending-deletion flag is cleared and the request timestamp removed. Their
            account stays active.
          </>}
        </div>
        <label style={{ fontSize:12, fontWeight:500, color:'var(--slate-700)', display:'block', marginBottom:6 }}>
          Reason (required)
        </label>
        <textarea value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. User reached out to support and asked to keep their account (ticket #4421)"
          style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical', outline:'none' }} />
        <div style={{ fontSize:11, color:'var(--slate-400)', marginTop:6 }}>
          This action will be logged in the audit trail.
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// TabDeletionQueue root
// ---------------------------------------------------------------------------

export const TabDeletionQueue = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const canWrite = can(session?.role, 'users.write')

  const rows = useQuery(api.opsDeletion.listPendingDeletions, { token }) as Row[] | undefined
  const [restoring, setRestoring] = useState<Row | null>(null)

  const oldest = rows && rows.length > 0 ? ageDays(rows[0].requested_at) : null
  const blocked = rows?.filter((r) => r.open_bookings > 0).length ?? 0

  const linkStyle: React.CSSProperties = { color:'var(--blue-700)', textDecoration:'none' }

  return (
    <SectionAnchor id="deletionQueue" title="Deletion Queue"
      subtitle="Compliance queue — users who asked to be deleted, oldest first.">

      {/* Stat tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Pending requests"
          value={rows === undefined ? '…' : fmtNumber(rows.length)}
          tone="yellow"
          accent={rows !== undefined && rows.length > 0 ? <Badge tone="yellow">queue</Badge> : undefined} />
        <StatCard label="Oldest request"
          value={
            rows === undefined ? '…'
              : rows.length === 0 ? '—'
                : oldest === null ? 'unknown'
                  : <span style={{ color: oldest > 25 ? 'var(--red-600)' : undefined }}>{oldest}d</span>
          }
          tone={oldest !== null && oldest > 25 ? 'red' : 'slate'}
          accent={oldest !== null && oldest > 25 ? <Badge tone="red">SLA breach</Badge> : undefined} />
        <StatCard label="Blocked by open bookings"
          value={rows === undefined ? '…' : fmtNumber(blocked)}
          tone="slate" />
      </div>

      {/* Table */}
      <Card padded={false}>
        {rows === undefined ? (
          <div style={{ padding:32, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading deletion queue…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding:32, textAlign:'center', color:'var(--slate-500)', fontSize:13 }}>
            No users are pending deletion. The compliance queue is clear.
          </div>
        ) : (
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>User</th>
              <th style={tableStyles.th}>Account</th>
              <th style={tableStyles.th}>Requested</th>
              <th style={tableStyles.th}>Age</th>
              <th style={tableStyles.th}>Grace left</th>
              <th style={tableStyles.th}>Survey response</th>
              <th style={tableStyles.th}>Open bookings</th>
              <th style={{ ...tableStyles.th, textAlign:'right' }} />
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const days = ageDays(r.requested_at)
                return (
                  <tr key={r.id}>
                    <td style={{ ...tableStyles.td, verticalAlign:'top' }}>
                      <a onClick={() => gotoEntity('users', r.id)}
                        style={{ fontWeight:500, color:'var(--slate-900)', cursor:'pointer' }}>
                        {r.name}
                      </a>
                      {r.email && (
                        <div style={{ fontSize:12, marginTop:2 }}>
                          <a href={`mailto:${r.email}`} style={linkStyle}>{r.email}</a>
                        </div>
                      )}
                      {r.phone && (
                        <div style={{ fontSize:12, marginTop:2 }}>
                          <a href={`tel:${r.phone}`} style={linkStyle}>{r.phone}</a>
                        </div>
                      )}
                    </td>
                    <td style={{ ...tableStyles.td, verticalAlign:'top', fontSize:12, color:'var(--slate-500)' }}>
                      {providerLabel(r.authProvider) && (
                        <div style={{ color:'var(--slate-700)' }}>{providerLabel(r.authProvider)}</div>
                      )}
                      <div>{r.vehicles} veh · {fmtSpend(r.spend)} · {r.bookings_total} bkg</div>
                      {r.primaryVehicle && (
                        <div style={{ color:'var(--slate-400)' }}>🚗 {r.primaryVehicle}</div>
                      )}
                      <div style={{ color:'var(--slate-400)' }}>joined {fmtDate(r.createdAt)}</div>
                    </td>
                    <td style={{ ...tableStyles.td, verticalAlign:'top', color:'var(--slate-600)' }}>
                      {fmtDate(r.requested_at)}
                    </td>
                    <td style={{ ...tableStyles.td, verticalAlign:'top' }}>
                      <AgePill days={days} />
                    </td>
                    <td style={{ ...tableStyles.td, verticalAlign:'top' }}>
                      <GracePill days={r.graceRemainingDays} />
                    </td>
                    <td style={{ ...tableStyles.td, verticalAlign:'top', maxWidth:280 }}>
                      {r.survey_skipped ? (
                        <Badge tone="slate">skipped</Badge>
                      ) : r.survey_response ? (
                        <span style={{ color:'var(--slate-600)', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>{r.survey_response}</span>
                      ) : (
                        <span style={{ color:'var(--slate-400)' }}>—</span>
                      )}
                    </td>
                    <td style={{ ...tableStyles.td, verticalAlign:'top' }}>
                      {r.open_bookings > 0 ? (
                        <Badge tone="red">{r.open_bookings} open — blocked</Badge>
                      ) : (
                        <Badge tone="green">clear</Badge>
                      )}
                    </td>
                    <td style={{ ...tableStyles.td, verticalAlign:'top', textAlign:'right' }}>
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:6 }}>
                        {r.email && (
                          <a href={`mailto:${r.email}`} style={{ textDecoration:'none' }}>
                            <Button size="sm">Email</Button>
                          </a>
                        )}
                        {r.phone && (
                          <a href={`tel:${r.phone}`} style={{ textDecoration:'none' }}>
                            <Button size="sm">Call</Button>
                          </a>
                        )}
                        {canWrite && (
                          <Button size="sm" onClick={() => setRestoring(r)}>Restore</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      <RestoreModal row={restoring} onClose={() => setRestoring(null)} />
    </SectionAnchor>
  )
}
