'use client'

// Director · Settlement — hash tab #settlement.
// Completed jobs still owed money: the reconciliation cron flags bookings
// `settlement_state = "awaiting_settlement"` when the hold couldn't cover the
// final total (reauth pending, capture failed, no set price). The cron keeps
// retrying + escalating; this is the read-only window so ops can chase the
// stale ones. Oldest shortfall first. Read-only.

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Badge, Card, tableStyles } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import { money } from '../Charts'

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// Rough "how stale" — the cron escalates past 24h, so age is what matters.
const fmtAge = (ms: number | null): string => {
  if (!ms) return '—'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days >= 1) return `${days}d`
  const hours = Math.floor((Date.now() - ms) / 3_600_000)
  return `${hours}h`
}

const REASON_LABEL: Record<string, string> = {
  hold_below_final_total: 'hold too low',
  no_ceiling_or_set_price: 'no set price',
}
const reasonLabel = (r: string | null): string => {
  if (!r) return '—'
  if (r.startsWith('capture_failed:')) return `capture failed (${r.slice('capture_failed:'.length)})`
  return REASON_LABEL[r] ?? r.replace(/_/g, ' ')
}

const TraceLink = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button
    onClick={onClick}
    style={{
      border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
      fontSize: 12, fontWeight: 500, color: 'var(--blue-600)', fontFamily: 'inherit',
    }}
    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'underline' }}
    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.textDecoration = 'none' }}>
    {children}
  </button>
)

type Row = {
  id: string
  user: string | null
  userId: string | null
  shop: string | null
  shopId: string | null
  services: string[]
  vehicleYmm: string | null
  settlementShortfallCents: number
  settlementReason: string | null
  awaitingSinceMs: number | null
  escalatedAtMs: number | null
  paymentApprovalState: string | null
}

export const TabSettlement = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''

  const data = useQuery(api.opsBookings.awaitingSettlementBookings, { token }) as
    | { rows: Row[]; count: number; totalShortfallCents: number; truncated: boolean }
    | undefined

  return (
    <SectionAnchor id="settlement" title="Awaiting Settlement"
      subtitle="Completed jobs still owed money. The reconciliation cron retries capture and escalates automatically — this is the manual-chase window.">

      {data && (
        <div style={{
          borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16,
          border: `1px solid ${data.count === 0 ? '#A7F3D0' : '#FDE68A'}`,
          background: data.count === 0 ? 'var(--green-50)' : 'var(--yellow-50)',
          color: data.count === 0 ? 'var(--green-700)' : 'var(--yellow-800)',
        }}>
          {data.count === 0
            ? '0 bookings awaiting settlement — every completed job is captured.'
            : `${data.count} booking${data.count === 1 ? '' : 's'} awaiting settlement · ${money(data.totalShortfallCents / 100)} outstanding.`}
        </div>
      )}

      {data === undefined ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ height: 40, borderRadius: 8, background: 'var(--slate-100)' }} className="animate-pulse" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 32, color: 'var(--slate-500)', fontSize: 13 }}>
          Nothing awaiting settlement.
        </Card>
      ) : (
        <Card padded={false}>
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Age</th>
              <th style={tableStyles.th}>User</th>
              <th style={tableStyles.th}>Vehicle / service</th>
              <th style={tableStyles.th}>Shop</th>
              <th style={tableStyles.th}>Reason</th>
              <th style={tableStyles.th}>State</th>
              <th style={{ ...tableStyles.th, textAlign: 'right' }}>Shortfall</th>
              <th style={tableStyles.th}>Trace</th>
            </tr></thead>
            <tbody>
              {data.rows.map(r => {
                const stale = r.awaitingSinceMs != null && Date.now() - r.awaitingSinceMs >= 86_400_000
                return (
                  <tr key={r.id} style={stale ? { background: 'var(--yellow-50)' } : undefined}>
                    <td style={{ ...tableStyles.td, color: 'var(--slate-500)', fontSize: 12 }}>
                      {fmtAge(r.awaitingSinceMs)}
                      {r.awaitingSinceMs && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--slate-400)' }}>
                          {fmtDate(r.awaitingSinceMs)}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tableStyles.td, color: 'var(--slate-600)' }}>
                      {r.user && r.userId ? (
                        <TraceLink onClick={() => gotoEntity('users', String(r.userId))}>{r.user}</TraceLink>
                      ) : (r.user ?? '—')}
                    </td>
                    <td style={tableStyles.td}>
                      <span style={{ color: 'var(--slate-800)' }}>{r.vehicleYmm ?? '—'}</span>
                      {r.services.length > 0 && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--slate-400)' }}>
                          {r.services.join(' · ')}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tableStyles.td, color: 'var(--slate-600)' }}>
                      {r.shopId && r.shop ? (
                        <TraceLink onClick={() => gotoEntity('shops', String(r.shopId))}>{r.shop}</TraceLink>
                      ) : (<span style={{ color: 'var(--slate-300)' }}>—</span>)}
                    </td>
                    <td style={{ ...tableStyles.td, color: 'var(--slate-600)', fontSize: 12 }}>
                      {reasonLabel(r.settlementReason)}
                      {r.paymentApprovalState === 'reauth_required' && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--yellow-700)' }}>
                          awaiting customer re-auth
                        </span>
                      )}
                    </td>
                    <td style={tableStyles.td}>
                      <Badge tone={r.escalatedAtMs ? 'yellow' : 'slate'}>
                        {r.escalatedAtMs ? 'escalated' : 'retrying'}
                      </Badge>
                    </td>
                    <td style={{
                      ...tableStyles.td, textAlign: 'right', fontWeight: 600, fontSize: 12,
                      color: 'var(--red-600, #DC2626)',
                    }} className="mono">
                      {money(r.settlementShortfallCents / 100)}
                    </td>
                    <td style={tableStyles.td}>
                      <TraceLink onClick={() => gotoEntity('bookings', String(r.id))}>booking →</TraceLink>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data.truncated && (
            <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--yellow-700)' }}>
              window truncated at 200 rows
            </div>
          )}
        </Card>
      )}
    </SectionAnchor>
  )
}
