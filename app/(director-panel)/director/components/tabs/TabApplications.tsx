'use client'

// Director · Shop Applications (#applications) — review queue for the invite-based
// B2B onboarding pipeline (Steps 2–4). Pending applications can be approved
// (creates the shop + hashed invite + branded email via /api/applications/approve)
// or rejected (shops.write). Invited/rejected are read-only history.

import { useContext, useMemo, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { SectionAnchor } from '../Shell'
import { can } from '@/lib/portal/capabilities'
import { Badge, Button, Card, Modal, tableStyles } from '../Primitives'
import { StatCard, fmtNumber } from '../Charts'

type Application = {
  _id: string
  shop_legal_name: string
  owner_full_name: string
  business_email: string
  phone: string
  street_address: string
  status: string
  rejection_reason?: string
  reviewed_by_name?: string
  invited_at?: number
  created_at: number
}

type StatusFilter = 'pending_review' | 'invited' | 'rejected'

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'pending_review', label: 'Pending' },
  { id: 'invited', label: 'Invited' },
  { id: 'rejected', label: 'Rejected' },
]

const fmtDate = (ms: number | null | undefined) =>
  ms == null ? '—' : new Date(ms).toLocaleDateString()

// ---------------------------------------------------------------------------
// Reject ceremony — Modal with an optional reason.
// ---------------------------------------------------------------------------
const RejectModal = ({
  row,
  token,
  onClose,
  onDone,
}: {
  row: Application | null
  token: string
  onClose: () => void
  onDone: (msg: string) => void
}) => {
  const reject = useMutation(api.shopApplications.reject)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => { setReason(''); setBusy(false); setError(null); onClose() }

  const handleConfirm = async () => {
    if (!row || busy) return
    setBusy(true)
    setError(null)
    try {
      await reject({
        token,
        applicationId: row._id as Parameters<typeof reject>[0]['applicationId'],
        reason: reason.trim() || undefined,
      })
      onDone(`Rejected ${row.shop_legal_name}.`)
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject.')
      setBusy(false)
    }
  }

  return (
    <Modal open={!!row} onClose={close} width={480} title="Reject application"
      footer={<>
        <Button onClick={close}>Cancel</Button>
        <Button variant="danger" onClick={handleConfirm} disabled={busy}>
          {busy ? 'Rejecting…' : 'Reject application'}
        </Button>
      </>}>
      <div style={{ padding: 22 }}>
        <div style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.5, marginBottom: 16 }}>
          {row && <><b style={{ color: 'var(--slate-900)' }}>{row.shop_legal_name}</b> will be marked
          rejected. No shop or invite is created. This is logged in the audit trail.</>}
        </div>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--slate-700)', display: 'block', marginBottom: 6 }}>
          Reason (optional)
        </label>
        <textarea value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. Outside current service area"
          style={{ width: '100%', minHeight: 72, padding: 10, fontSize: 13, border: '1px solid var(--slate-200)', borderRadius: 8, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }} />
        {error && <div style={{ fontSize: 12, color: 'var(--red-600)', marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Approve result Modal — shows the one-time invite link (copyable). The raw
// token is only ever available here, right after approval.
// ---------------------------------------------------------------------------
const ApproveResultModal = ({
  result,
  onClose,
}: {
  result: { shopName: string; inviteUrl: string; emailSent: boolean } | null
  onClose: () => void
}) => {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.inviteUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable — the link is shown below to copy manually */ }
  }
  return (
    <Modal open={!!result} onClose={onClose} width={520} title="Invite sent"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div style={{ padding: 22 }}>
        {result && <>
          <div style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.5, marginBottom: 16 }}>
            <b style={{ color: 'var(--slate-900)' }}>{result.shopName}</b> was created and an invite
            {result.emailSent ? ' email was sent' : ' was generated'}. This one-time claim link is shown
            once — copy it if you need to resend manually.
          </div>
          {!result.emailSent && (
            <div style={{ marginBottom: 12 }}><Badge tone="yellow">email failed — share the link manually</Badge></div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input readOnly value={result.inviteUrl}
              style={{ flex: 1, padding: '8px 10px', fontSize: 12, border: '1px solid var(--slate-200)', borderRadius: 8, fontFamily: 'var(--font-mono, monospace)', color: 'var(--slate-700)', outline: 'none' }} />
            <Button variant="primary" size="sm" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</Button>
          </div>
        </>}
      </div>
    </Modal>
  )
}

export const TabApplications = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const canWrite = can(session?.role, 'shops.write')

  const [filter, setFilter] = useState<StatusFilter>('pending_review')
  const rows = useQuery(api.shopApplications.listByStatus, { token, status: filter }) as Application[] | undefined

  const [rejecting, setRejecting] = useState<Application | null>(null)
  const [approveResult, setApproveResult] = useState<{ shopName: string; inviteUrl: string; emailSent: boolean } | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const pendingCount = useQuery(api.shopApplications.listByStatus, { token, status: 'pending_review' }) as Application[] | undefined

  const linkStyle: React.CSSProperties = { color: 'var(--blue-700)', textDecoration: 'none' }

  const handleApprove = async (row: Application) => {
    if (approvingId) return
    setApprovingId(row._id)
    setToast(null)
    try {
      const res = await fetch('/api/applications/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, applicationId: row._id }),
      })
      const data = await res.json()
      if (res.ok && data?.success) {
        setApproveResult({ shopName: row.shop_legal_name, inviteUrl: data.inviteUrl, emailSent: !!data.emailSent })
      } else {
        setToast(data?.error ?? 'Failed to approve.')
      }
    } catch {
      setToast('Failed to approve. Please try again.')
    } finally {
      setApprovingId(null)
    }
  }

  const emptyCopy = useMemo(() => {
    if (filter === 'pending_review') return 'No applications are waiting for review.'
    if (filter === 'invited') return 'No invited shops yet.'
    return 'No rejected applications.'
  }, [filter])

  return (
    <SectionAnchor id="applications" title="Shop Applications"
      subtitle="Review partner applications, then approve to create the shop and email a claim invite."
      right={
        <div style={{ display: 'flex', gap: 4, background: 'var(--slate-100)', padding: 3, borderRadius: 8 }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              style={{ border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                padding: '5px 12px', borderRadius: 6, background: filter === f.id ? '#fff' : 'transparent',
                color: filter === f.id ? 'var(--slate-900)' : 'var(--slate-500)',
                boxShadow: filter === f.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
              {f.label}
            </button>
          ))}
        </div>
      }>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        <StatCard label="Pending review"
          value={pendingCount === undefined ? '…' : fmtNumber(pendingCount.length)}
          tone={pendingCount && pendingCount.length > 0 ? 'yellow' : 'slate'}
          accent={pendingCount && pendingCount.length > 0 ? <Badge tone="yellow">queue</Badge> : undefined} />
        <StatCard label="Showing"
          value={rows === undefined ? '…' : fmtNumber(rows.length)} tone="slate" />
        <StatCard label="Filter" value={FILTERS.find(f => f.id === filter)?.label ?? '—'} tone="slate" />
      </div>

      <Card padded={false}>
        {rows === undefined ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--slate-400)', fontSize: 13 }}>Loading applications…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--slate-500)', fontSize: 13 }}>{emptyCopy}</div>
        ) : (
          <table style={tableStyles.table}>
            <thead><tr>
              <th style={tableStyles.th}>Shop</th>
              <th style={tableStyles.th}>Owner &amp; contact</th>
              <th style={tableStyles.th}>Address</th>
              <th style={tableStyles.th}>Submitted</th>
              {filter === 'rejected' && <th style={tableStyles.th}>Reason</th>}
              <th style={{ ...tableStyles.th, textAlign: 'right' }} />
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r._id}>
                  <td style={{ ...tableStyles.td, verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 500, color: 'var(--slate-900)' }}>{r.shop_legal_name}</div>
                    {r.status === 'invited' && r.invited_at && (
                      <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 2 }}>invited {fmtDate(r.invited_at)}</div>
                    )}
                  </td>
                  <td style={{ ...tableStyles.td, verticalAlign: 'top', fontSize: 12, color: 'var(--slate-500)' }}>
                    <div style={{ color: 'var(--slate-700)' }}>{r.owner_full_name}</div>
                    <div style={{ marginTop: 2 }}><a href={`mailto:${r.business_email}`} style={linkStyle}>{r.business_email}</a></div>
                    <div style={{ marginTop: 2 }}><a href={`tel:${r.phone}`} style={linkStyle}>{r.phone}</a></div>
                  </td>
                  <td style={{ ...tableStyles.td, verticalAlign: 'top', fontSize: 12, color: 'var(--slate-600)', maxWidth: 240 }}>
                    {r.street_address}
                  </td>
                  <td style={{ ...tableStyles.td, verticalAlign: 'top', color: 'var(--slate-600)' }}>{fmtDate(r.created_at)}</td>
                  {filter === 'rejected' && (
                    <td style={{ ...tableStyles.td, verticalAlign: 'top', fontSize: 12, color: 'var(--slate-500)', maxWidth: 220 }}>
                      {r.rejection_reason || <span style={{ color: 'var(--slate-400)' }}>—</span>}
                    </td>
                  )}
                  <td style={{ ...tableStyles.td, verticalAlign: 'top', textAlign: 'right' }}>
                    {r.status === 'pending_review' ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        {canWrite && (
                          <>
                            <Button size="sm" onClick={() => setRejecting(r)} disabled={approvingId === r._id}>Reject</Button>
                            <Button variant="primary" size="sm" onClick={() => handleApprove(r)} disabled={approvingId === r._id}>
                              {approvingId === r._id ? 'Approving…' : 'Approve'}
                            </Button>
                          </>
                        )}
                      </div>
                    ) : (
                      <Badge tone={r.status === 'invited' ? 'blue' : r.status === 'active' ? 'green' : 'slate'}>{r.status}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <RejectModal row={rejecting} token={token} onClose={() => setRejecting(null)} onDone={(m) => setToast(m)} />
      <ApproveResultModal result={approveResult} onClose={() => setApproveResult(null)} />

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
