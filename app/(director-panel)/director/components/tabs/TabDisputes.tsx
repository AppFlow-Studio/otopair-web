'use client'

// Director · Disputes (#disputes) — one unified inbox over three sources that
// never converge on their own: public web support requests (support_requests),
// app-filed booking disputes (booking_disputes), and Stripe chargebacks
// (payment_disputes). Triage is gated users.write; resolving with a real refund
// is gated money.write (separation of duties). The refund itself runs in
// convex/directorRefunds.ts.

import { useContext, useMemo, useState } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { SectionAnchor } from '../Shell'
import { can } from '@/lib/portal/capabilities'
import {
  Badge, Button, Card, Modal, Select, Input, SegmentedControl, NotesPanel, AuditLogCompact, tableStyles,
} from '../Primitives'
import { StatCard, fmtNumber, money, fmtDate, fmtDateTime } from '../Charts'

type Kind = 'web_support' | 'app_dispute' | 'stripe_chargeback'

type UnifiedDispute = {
  kind: Kind
  id: string
  status: 'new' | 'in_review' | 'resolved' | 'closed'
  raw_status: string
  filed_at: number
  customer: { name: string; email: string | null }
  shop: { name: string | null; id: string | null }
  amount_cents: number | null
  summary: string
  detail: string | null
  category: string | null
  booking_id: string | null
  needs_link: boolean
  evidence_due_by_ms: number | null
}

const KIND_META: Record<Kind, { label: string; tone: 'blue' | 'purple' | 'orange' }> = {
  web_support: { label: 'Web support', tone: 'blue' },
  app_dispute: { label: 'App dispute', tone: 'purple' },
  stripe_chargeback: { label: 'Chargeback', tone: 'orange' },
}

const SOURCE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'web_support', label: 'Web support' },
  { value: 'app_dispute', label: 'App disputes' },
  { value: 'stripe_chargeback', label: 'Chargebacks' },
]

const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'new', label: 'New' },
  { id: 'in_review', label: 'In review' },
  { id: 'resolved', label: 'Resolved' },
]

const moneyCents = (c: number | null | undefined) =>
  c == null ? '—' : money(c / 100, { cents: true })

const statusTone = (s: UnifiedDispute['status']) =>
  s === 'new' ? 'red' : s === 'in_review' ? 'yellow' : s === 'resolved' ? 'green' : 'slate'

// ---------------------------------------------------------------------------
// Link-to-booking — resolve the customer's free-text order reference into a
// real booking and attach it (unlocks the refund seam).
// ---------------------------------------------------------------------------
const LinkBookingPanel = ({
  supportId, token, onDone,
}: {
  supportId: string
  token: string
  onDone: (msg: string) => void
}) => {
  const linkToBooking = useMutation(api.supportRequests.linkToBooking)
  const [draft, setDraft] = useState('')
  const [committed, setCommitted] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const results = useQuery(
    api.directorDisputes.resolveBookingRef,
    committed ? { token, query: committed } : 'skip',
  )

  const doLink = async (bookingId: string) => {
    setBusyId(bookingId)
    setError(null)
    try {
      await linkToBooking({
        token,
        id: supportId as Id<'support_requests'>,
        bookingId: bookingId as Id<'bookings'>,
      })
      onDone('Linked to booking.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to link.')
      setBusyId(null)
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 14, background: 'var(--slate-25)', border: '1px solid var(--slate-200)', borderRadius: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-700)', marginBottom: 8 }}>
        Link to a booking
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="Invoice #, OTP code, booking id, or the last few digits" style={{ flex: 1 }} />
        <Button variant="primary" size="sm" onClick={() => setCommitted(draft.trim())} disabled={!draft.trim()}>
          Search
        </Button>
      </div>
      {committed && (
        <div style={{ marginTop: 10 }}>
          {results === undefined ? (
            <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>Searching…</div>
          ) : results.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>No bookings matched “{committed}”.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {results.map((b) => (
                <div key={b.bookingId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 10px', background: '#fff', border: '1px solid var(--slate-200)', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--slate-700)' }}>
                    <div style={{ fontWeight: 600, color: 'var(--slate-900)' }}>{b.customerName} · {b.shopName ?? 'No shop'}</div>
                    <div style={{ color: 'var(--slate-500)' }}>{b.vin} · {fmtDate(b.date)} · {moneyCents(b.totalCents)}</div>
                  </div>
                  <Button variant="primary" size="sm" onClick={() => doLink(b.bookingId)} disabled={busyId === b.bookingId}>
                    {busyId === b.bookingId ? 'Linking…' : 'Link'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: 'var(--red-600)', marginTop: 8 }}>{error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resolve-with-refund — the money surface. Gated money.write by the caller.
// ---------------------------------------------------------------------------
const ResolvePanel = ({
  row, token, onDone,
}: {
  row: UnifiedDispute
  token: string
  onDone: (msg: string) => void
}) => {
  const resolve = useAction(api.directorRefunds.resolveDisputeWithRefund)
  const [resolution, setResolution] = useState<'no_refund' | 'partial_refund' | 'full_refund'>('no_refund')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handle = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const refundCents =
        resolution === 'partial_refund' ? Math.round(parseFloat(amount || '0') * 100) : undefined
      if (resolution === 'partial_refund' && (!refundCents || refundCents <= 0)) {
        throw new Error('Enter a refund amount.')
      }
      const res = await resolve({
        token,
        kind: row.kind,
        id: row.id,
        resolution,
        refundCents,
        notes: notes.trim() || undefined,
      })
      onDone(
        resolution === 'no_refund'
          ? 'Resolved — no refund.'
          : `Refund issued (${moneyCents((res as any)?.refundedTotalCents ?? refundCents ?? 0)}).`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resolve.')
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 14, background: 'var(--slate-25)', border: '1px solid var(--slate-200)', borderRadius: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-700)', marginBottom: 10 }}>
        Resolve
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}
          options={[
            { value: 'no_refund', label: 'No refund' },
            { value: 'partial_refund', label: 'Partial refund' },
            { value: 'full_refund', label: 'Full refund' },
          ]} />
        {resolution === 'partial_refund' && (
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} type="text"
            placeholder="Amount in $ (e.g. 45.00)" style={{ width: 180 }} />
        )}
      </div>
      {resolution === 'full_refund' && (
        <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 8 }}>
          Refunds the full remaining captured amount to the customer&apos;s original payment method.
        </div>
      )}
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="Resolution notes (optional) — recorded on the refund + audit log"
        style={{ width: '100%', minHeight: 60, marginTop: 10, padding: 10, fontSize: 13, border: '1px solid var(--slate-200)', borderRadius: 8, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }} />
      {error && <div style={{ fontSize: 12, color: 'var(--red-600)', marginTop: 8 }}>{error}</div>}
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={handle} disabled={busy}>
          {busy ? 'Working…' : resolution === 'no_refund' ? 'Resolve' : 'Issue refund'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer — adapts by kind.
// ---------------------------------------------------------------------------
const DisputeDrawer = ({
  row, token, canMoney, canTriage, onClose, onToast,
}: {
  row: UnifiedDispute
  token: string
  canMoney: boolean
  canTriage: boolean
  onClose: () => void
  onToast: (msg: string) => void
}) => {
  const full = useQuery(
    api.supportRequests.get,
    row.kind === 'web_support' ? { token, id: row.id as Id<'support_requests'> } : 'skip',
  )
  const addNote = useMutation(api.supportRequests.addNote)
  const assign = useMutation(api.supportRequests.assign)
  const setStatus = useMutation(api.supportRequests.setStatus)

  // Full lifecycle timeline — director audit_log merged with the source row's
  // own lifecycle events. Re-runs reactively, so acting in this drawer updates it.
  const timeline = useQuery(api.directorDisputes.disputeTimeline, {
    token,
    kind: row.kind,
    id: row.id,
  })
  const timelineEntries = timeline?.map((e) => ({
    timestamp: fmtDateTime(e.at),
    action: e.action,
    actor: e.actor,
    detail: e.detail,
  }))

  const notes = useMemo(() => {
    const src = (full as any)?.internal_notes ?? []
    return src.map((n: any) => ({ author: n.author, when: fmtDate(n.at), text: n.text }))
  }, [full])

  const canResolve =
    canMoney && (row.kind === 'app_dispute' || (row.kind === 'web_support' && !!row.booking_id))
  const rowIsOpen = row.status === 'new' || row.status === 'in_review'

  const kv = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 10, fontSize: 13, marginBottom: 6 }}>
      <span style={{ color: 'var(--slate-500)', minWidth: 96 }}>{label}</span>
      <span style={{ color: 'var(--slate-800)' }}>{value}</span>
    </div>
  )

  return (
    <Modal open onClose={onClose} width={620}
      title={row.customer.name}
      eyebrow={KIND_META[row.kind].label}
      statusBadge={<Badge tone={statusTone(row.status)}>{row.status.replace(/_/g, ' ')}</Badge>}
    >
      <div style={{ padding: 22 }}>
        {kv('Customer', <>
          {row.customer.name}
          {row.customer.email && <> · <a href={`mailto:${row.customer.email}`} style={{ color: 'var(--blue-700)' }}>{row.customer.email}</a></>}
        </>)}
        {kv('Shop', row.shop.name ?? '—')}
        {kv('Amount', moneyCents(row.amount_cents))}
        {kv('Filed', fmtDate(row.filed_at))}
        {row.category && kv('Category', row.category.replace(/_/g, ' '))}
        {kv('Summary', row.summary)}
        {row.evidence_due_by_ms && kv('Evidence due', fmtDate(row.evidence_due_by_ms))}
        {row.booking_id && kv('Booking', <code style={{ fontSize: 12 }}>{row.booking_id}</code>)}

        {/* Full description / note */}
        {(row.kind === 'web_support' && (full as any)?.description) && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>What happened</div>
            <div style={{ fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{(full as any).description}</div>
            {((full as any).order_reference || (full as any).shop_name_text || (full as any).customer_phone) && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--slate-500)' }}>
                {(full as any).order_reference && <div>Order ref: {(full as any).order_reference}</div>}
                {(full as any).shop_name_text && <div>Shop named: {(full as any).shop_name_text}</div>}
                {(full as any).customer_phone && <div>Phone: {(full as any).customer_phone}</div>}
              </div>
            )}
          </div>
        )}
        {row.kind === 'app_dispute' && row.detail && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Customer note</div>
            <div style={{ fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{row.detail}</div>
          </div>
        )}

        {/* Triage controls (web_support) */}
        {row.kind === 'web_support' && canTriage && (
          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" onClick={async () => { try { await assign({ token, id: row.id as Id<'support_requests'> }); onToast('Assigned to you.') } catch (e) { onToast(e instanceof Error ? e.message : 'Failed.') } }}>
              Assign to me
            </Button>
            {row.status !== 'closed' && (
              <Button size="sm" onClick={async () => { try { await setStatus({ token, id: row.id as Id<'support_requests'>, status: 'closed' }); onToast('Closed.') } catch (e) { onToast(e instanceof Error ? e.message : 'Failed.') } }}>
                Close
              </Button>
            )}
          </div>
        )}

        {/* Link-to-booking (web_support without a link) */}
        {row.kind === 'web_support' && row.needs_link && canTriage && (
          <LinkBookingPanel supportId={row.id} token={token} onDone={(m) => { onToast(m); onClose() }} />
        )}

        {/* Resolve with refund */}
        {rowIsOpen && canResolve && (
          <ResolvePanel row={row} token={token} onDone={(m) => { onToast(m); onClose() }} />
        )}
        {row.kind === 'stripe_chargeback' && (
          <div style={{ marginTop: 16, padding: 12, background: 'var(--amber-50, #FFFBEB)', border: '1px solid var(--amber-200, #FDE68A)', borderRadius: 10, fontSize: 12, color: 'var(--slate-700)' }}>
            This is a Stripe chargeback. Refunds can&apos;t be issued on a disputed charge — respond with evidence in the Stripe dashboard.
          </div>
        )}
        {rowIsOpen && !canResolve && row.kind !== 'stripe_chargeback' && (
          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--slate-500)' }}>
            {row.kind === 'web_support' && row.needs_link
              ? 'Link this request to a booking to enable a refund.'
              : 'Resolving with a refund requires the money.write capability.'}
          </div>
        )}

        {/* Internal notes (web_support) */}
        {row.kind === 'web_support' && canTriage && (
          <div style={{ marginTop: 18 }}>
            <NotesPanel
              label="Internal notes"
              notes={notes}
              onAdd={async (text) => {
                try { await addNote({ token, id: row.id as Id<'support_requests'>, text }) }
                catch (e) { onToast(e instanceof Error ? e.message : 'Failed to add note.') }
              }}
            />
          </div>
        )}

        {/* Lifecycle / audit timeline — every event across the dispute's life. */}
        <div style={{ marginTop: 18, borderTop: '1px solid var(--slate-100)', paddingTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Activity
          </div>
          <AuditLogCompact entries={timelineEntries} />
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
export const TabDisputes = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const canMoney = can(session?.role, 'money.write')
  const canTriage = can(session?.role, 'users.write')

  const [source, setSource] = useState('all')
  const [status, setStatus] = useState('active')
  const [selected, setSelected] = useState<UnifiedDispute | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const rows = useQuery(api.directorDisputes.listUnifiedDisputes, { token }) as UnifiedDispute[] | undefined

  const filtered = useMemo(() => {
    if (!rows) return []
    return rows.filter((r) => {
      if (source !== 'all' && r.kind !== source) return false
      if (status === 'active') return r.status === 'new' || r.status === 'in_review'
      if (status === 'resolved') return r.status === 'resolved' || r.status === 'closed'
      return r.status === status
    })
  }, [rows, source, status])

  const stats = useMemo(() => {
    const active = (rows ?? []).filter((r) => r.status === 'new' || r.status === 'in_review')
    return {
      open: active.length,
      web: active.filter((r) => r.kind === 'web_support').length,
      app: active.filter((r) => r.kind === 'app_dispute').length,
      cb: active.filter((r) => r.kind === 'stripe_chargeback').length,
    }
  }, [rows])

  return (
    <SectionAnchor id="disputes" title="Disputes"
      subtitle="Customer disputes across every channel — web support requests, app disputes, and Stripe chargebacks."
      right={
        <SegmentedControl value={source} options={SOURCE_FILTERS} onChange={setSource} />
      }>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard label="Open total" value={rows === undefined ? '…' : fmtNumber(stats.open)}
          tone={stats.open > 0 ? 'yellow' : 'slate'}
          accent={stats.open > 0 ? <Badge tone="yellow">queue</Badge> : undefined} />
        <StatCard label="Web support" value={rows === undefined ? '…' : fmtNumber(stats.web)} tone="slate" />
        <StatCard label="App disputes" value={rows === undefined ? '…' : fmtNumber(stats.app)} tone="slate" />
        <StatCard label="Chargebacks" value={rows === undefined ? '…' : fmtNumber(stats.cb)} tone="slate" />
      </div>

      <div style={{ display: 'flex', gap: 4, background: 'var(--slate-100)', padding: 3, borderRadius: 8, marginBottom: 12, width: 'fit-content' }}>
        {STATUS_FILTERS.map((f) => (
          <button key={f.id} onClick={() => setStatus(f.id)}
            style={{ border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
              padding: '5px 12px', borderRadius: 6, background: status === f.id ? '#fff' : 'transparent',
              color: status === f.id ? 'var(--slate-900)' : 'var(--slate-500)',
              boxShadow: status === f.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
            {f.label}
          </button>
        ))}
      </div>

      <Card padded={false}>
        {rows === undefined ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--slate-400)', fontSize: 13 }}>Loading disputes…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--slate-500)', fontSize: 13 }}>No disputes match this filter.</div>
        ) : (
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Source</th>
              <th style={tableStyles.th}>Customer</th>
              <th style={tableStyles.th}>Shop</th>
              <th style={{ ...tableStyles.th, textAlign: 'right' }}>Amount</th>
              <th style={tableStyles.th}>Summary</th>
              <th style={tableStyles.th}>Filed</th>
              <th style={tableStyles.th}>Status</th>
              <th style={{ ...tableStyles.th, textAlign: 'right' }} />
            </tr></thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={`${r.kind}:${r.id}`}>
                  <td style={tableStyles.td}><Badge tone={KIND_META[r.kind].tone}>{KIND_META[r.kind].label}</Badge></td>
                  <td style={tableStyles.td}>
                    <div style={{ color: 'var(--slate-900)', fontWeight: 500 }}>{r.customer.name}</div>
                    {r.customer.email && <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>{r.customer.email}</div>}
                  </td>
                  <td style={{ ...tableStyles.td, color: 'var(--slate-600)' }}>{r.shop.name ?? '—'}</td>
                  <td style={{ ...tableStyles.td, textAlign: 'right', color: 'var(--slate-800)' }}>{moneyCents(r.amount_cents)}</td>
                  <td style={{ ...tableStyles.td, color: 'var(--slate-700)', maxWidth: 240 }}>
                    {r.summary}
                    {r.needs_link && <Badge tone="slate" style={{ marginLeft: 6 }}>needs link</Badge>}
                  </td>
                  <td style={{ ...tableStyles.td, color: 'var(--slate-600)' }}>{fmtDate(r.filed_at)}</td>
                  <td style={tableStyles.td}><Badge tone={statusTone(r.status)}>{r.status.replace(/_/g, ' ')}</Badge></td>
                  <td style={{ ...tableStyles.td, textAlign: 'right' }}>
                    <Button size="sm" onClick={() => setSelected(r)}>Open</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected && (
        <DisputeDrawer
          row={selected}
          token={token}
          canMoney={canMoney}
          canTriage={canTriage}
          onClose={() => setSelected(null)}
          onToast={(m) => setToast(m)}
        />
      )}

      {toast && (
        <div onClick={() => setToast(null)}
          style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 400, background: 'var(--slate-900)', color: '#fff',
            padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
            boxShadow: '0 10px 30px rgba(15,23,42,0.25)' }}>
          {toast}
        </div>
      )}
    </SectionAnchor>
  )
}
