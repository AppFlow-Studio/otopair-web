'use client'

import { useState, useContext, useEffect, useMemo } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Avatar, Modal, AuditButton, Select, Input, tableStyles } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { useQuery as useAuditQuery } from 'convex/react'

type VerificationField = {
  field_name: string
  our_value: unknown
  corrected_value: unknown
  status: 'confirmed' | 'corrected' | 'unknown'
  notes?: string
}

type DecisionAction = 'accept' | 'skip' | 'override'

type ReviewDecisionState = {
  action: DecisionAction
  override_value?: string
}

type PendingRow = {
  _id: Id<'mechanic_verifications'>
  configId: Id<'vehicle_configs'>
  configKey: string
  vehicle: string
  mechanicId: Id<'mechanics'>
  mechanicName: string
  overallAccuracy: number | null
  partsUsedCorrect: boolean | null
  actualLaborHours: number | null
  jobId: string | null
  fields: VerificationField[]
  confirmedCount: number
  correctedCount: number
  unknownCount: number
  submittedAt: number | null
  verifiedAt: number | null
  verificationCount: number
  enrichmentStatus: string | null
  status: string
}

type StatusFilter = 'all' | 'pending' | 'accepted' | 'rejected' | 'undone'

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtFieldName(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return String(v)
  return String(v)
}

function timeAgo(ts: number | null): string {
  if (!ts) return '—'
  const d = Date.now() - ts
  const m = Math.floor(d / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function AccuracyBar({ pct }: { pct: number | null }) {
  if (pct === null) return <span style={{ fontSize:12, color:'var(--slate-400)' }}>—</span>
  const tone = pct >= 90 ? 'var(--green-600)' : pct >= 70 ? 'var(--yellow-500)' : 'var(--red-500)'
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ width:48, height:5, borderRadius:9, background:'var(--slate-100)', overflow:'hidden' }}>
        <div style={{ width:`${pct}%`, height:'100%', background:tone, borderRadius:9 }} />
      </div>
      <span style={{ fontSize:12, fontWeight:600, color:tone }}>{pct}%</span>
    </div>
  )
}

function StatusPill({ status }: { status: 'confirmed' | 'corrected' | 'unknown' }) {
  const map = {
    confirmed: { bg:'var(--green-50)',  border:'var(--green-200)',  color:'var(--green-700)',  label:'Confirmed' },
    corrected: { bg:'var(--orange-50)', border:'var(--orange-200)', color:'var(--orange-700)', label:'Corrected' },
    unknown:   { bg:'var(--slate-50)',  border:'var(--slate-200)',  color:'var(--slate-500)',  label:'Unknown'   },
  }
  const s = map[status] ?? map.unknown
  return (
    <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:6,
      background:s.bg, border:`1px solid ${s.border}`, color:s.color }}>
      {s.label}
    </span>
  )
}

// ── Verification Detail Modal ─────────────────────────────────────────────────

const VerificationModal = ({ row, onClose }: { row: PendingRow | null; onClose: () => void }) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const acceptPartial = useMutation(api.director_mechanic_verifications.acceptVerificationPartial)
  const reject = useMutation(api.director_mechanic_verifications.rejectVerification)
  const undo   = useMutation(api.undoMechanicVerification.undoById)
  const [busy, setBusy]           = useState(false)
  const [confirming, setConfirming] = useState<'accept' | 'reject' | 'undo' | null>(null)
  const [auditOpen, setAuditOpen]   = useState(false)
  // Per-field accept/skip/override choices. Keyed by field_name; only the
  // non-unknown fields participate (unknown can't be applied).
  const [decisions, setDecisions] = useState<Record<string, ReviewDecisionState>>({})

  const rawAudit = useAuditQuery(
    api.audit_log.listByEntity,
    row ? { entity_type: 'vehicle_config', entity_id: String(row.configId), token: session?.token ?? '' } : 'skip'
  )
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  // Seed decisions whenever a new pending row is selected. Default every
  // non-unknown field to "accept"; unknown fields are excluded (display-only).
  useEffect(() => {
    if (!row) return
    if (row.status !== 'pending') {
      setDecisions({})
      return
    }
    const seeded: Record<string, ReviewDecisionState> = {}
    for (const f of row.fields) {
      if (f.status === 'unknown') continue
      seeded[f.field_name] = { action: 'accept' }
    }
    setDecisions(seeded)
  }, [row?._id])

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const decisionCounts = useMemo(() => {
    let accept = 0, override = 0, skip = 0, acceptConfirmed = 0, acceptCorrected = 0
    if (!row) return { accept, override, skip, acceptConfirmed, acceptCorrected }
    for (const f of row.fields) {
      if (f.status === 'unknown') continue
      const d = decisions[f.field_name]
      if (!d) continue
      if (d.action === 'skip') skip++
      else if (d.action === 'override') override++
      else {
        accept++
        if (f.status === 'confirmed') acceptConfirmed++
        else acceptCorrected++
      }
    }
    return { accept, override, skip, acceptConfirmed, acceptCorrected }
  }, [row, decisions])

  if (!row) return null

  const handleAccept = async () => {
    setBusy(true)
    // Build the decisions[] payload from state. Unknown fields are excluded
    // entirely so the server doesn't have to filter them out.
    const payload = row.fields
      .filter(f => f.status !== 'unknown')
      .map(f => {
        const d = decisions[f.field_name] ?? { action: 'accept' as const }
        return d.action === 'override'
          ? { field_name: f.field_name, action: 'override' as const, override_value: d.override_value ?? '' }
          : { field_name: f.field_name, action: d.action }
      })
    await acceptPartial({ id: row._id, decisions: payload, actorName, actorId })
    setBusy(false)
    setConfirming(null)
    onClose()
  }

  const handleReject = async () => {
    setBusy(true)
    await reject({ id: row._id, actorName, actorId })
    setBusy(false)
    setConfirming(null)
    onClose()
  }

  const handleUndo = async () => {
    setBusy(true)
    await undo({ id: row._id, actorName, actorId })
    setBusy(false)
    setConfirming(null)
    onClose()
  }

  const corrected  = row.fields.filter(f => f.status === 'corrected')
  const confirmed  = row.fields.filter(f => f.status === 'confirmed')
  const unknown    = row.fields.filter(f => f.status === 'unknown')
  const isPending  = row.status === 'pending'
  const isAccepted = row.status === 'accepted'
  const isRejected = row.status === 'rejected'
  const isUndone   = row.status === 'undone'

  return (
    <Modal open={!!row} onClose={onClose} width={900}
      eyebrow={<span className="mono" style={{ fontSize:12, color:'var(--slate-500)' }}>{row.configKey}</span>}
      title={row.vehicle || 'Unknown vehicle'}
      headerRight={<AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Config audit log', subtitle:row.vehicle, entries:auditEntries }}
      footer={
        confirming ? (
          <div style={{ display:'flex', alignItems:'center', gap:8, width:'100%' }}>
            <span style={{ fontSize:13, color:'var(--slate-600)', flex:1 }}>
              {confirming === 'accept'
                ? `This will apply ${decisionCounts.accept} field${decisionCounts.accept !== 1 ? 's' : ''}`
                  + (decisionCounts.override > 0 ? `, override ${decisionCounts.override}` : '')
                  + (decisionCounts.skip > 0 ? `, and skip ${decisionCounts.skip}` : '')
                  + ' on the vehicle config.'
                : confirming === 'reject'
                ? 'This will reject the submission and no data will be written.'
                : `This will revert ${corrected.length + confirmed.length} field${corrected.length + confirmed.length !== 1 ? 's' : ''} on the vehicle config back to their previous values.`}
            </span>
            <Button onClick={() => setConfirming(null)}>Cancel</Button>
            {confirming === 'accept' && (
              <Button variant="primary" onClick={handleAccept} disabled={busy}>{busy ? 'Accepting…' : 'Confirm accept'}</Button>
            )}
            {confirming === 'reject' && (
              <Button variant="danger" onClick={handleReject} disabled={busy}>{busy ? 'Rejecting…' : 'Confirm reject'}</Button>
            )}
            {confirming === 'undo' && (
              <Button variant="danger" onClick={handleUndo} disabled={busy}>{busy ? 'Reverting…' : 'Confirm undo'}</Button>
            )}
          </div>
        ) : (
          <>
            <Button onClick={onClose}>Close</Button>
            <span style={{ flex:1 }} />
            {isPending && <>
              <Button variant="danger"   onClick={() => setConfirming('reject')}>Reject</Button>
              <Button variant="primary"  onClick={() => setConfirming('accept')}>Accept verification</Button>
            </>}
            {isAccepted && (
              <Button variant="danger" onClick={() => setConfirming('undo')}>Undo accept</Button>
            )}
            {isRejected && (
              <span style={{ fontSize:12, color:'var(--slate-400)' }}>This submission was rejected · no changes applied</span>
            )}
            {isUndone && (
              <span style={{ fontSize:12, color:'var(--purple-700)' }}>This verification was accepted, then reverted · data restored to pre-mechanic state</span>
            )}
          </>
        )
      }>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 280px', height:'100%' }}>

        {/* Left — field table */}
        <div style={{ overflow:'auto', borderRight:'1px solid var(--slate-100)' }}>
          {/* Summary strip */}
          <div style={{ display:'flex', gap:24, padding:'14px 22px', borderBottom:'1px solid var(--slate-100)', background:'var(--slate-25)', flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-400)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Overall accuracy</div>
              <AccuracyBar pct={row.overallAccuracy !== null ? Math.round(row.overallAccuracy * (row.overallAccuracy <= 1 ? 100 : 1)) : null} />
            </div>
            <div>
              <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-400)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Parts used correct</div>
              <span style={{ fontSize:12, fontWeight:600,
                color: row.partsUsedCorrect === true ? 'var(--green-700)' : row.partsUsedCorrect === false ? 'var(--red-600)' : 'var(--slate-400)' }}>
                {row.partsUsedCorrect === true ? 'Yes' : row.partsUsedCorrect === false ? 'No' : '—'}
              </span>
            </div>
            <div>
              <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-400)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Actual labor</div>
              <span style={{ fontSize:12, fontWeight:600, color:'var(--slate-700)' }}>{row.actualLaborHours !== null ? `${row.actualLaborHours}h` : '—'}</span>
            </div>
            <div>
              <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-400)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Fields</div>
              <span style={{ fontSize:12, color:'var(--slate-600)' }}>
                <span style={{ color:'var(--green-700)', fontWeight:600 }}>{row.confirmedCount} confirmed</span>
                {' · '}
                <span style={{ color:'var(--orange-700)', fontWeight:600 }}>{row.correctedCount} corrected</span>
                {row.unknownCount > 0 && <>{' · '}<span style={{ color:'var(--slate-500)' }}>{row.unknownCount} unknown</span></>}
              </span>
            </div>
          </div>

          {/* Field rows */}
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'var(--slate-50)', borderBottom:'1px solid var(--slate-200)' }}>
                {(['Field', 'Our value', "Mechanic's value", 'Status', ...(isPending ? ['Decision'] : [])] as const).map(h => (
                  <th key={h} style={{ padding:'8px 16px', textAlign:'left', fontSize:11, fontWeight:600,
                    color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...corrected, ...confirmed, ...unknown].map((field, i) => {
                const changed = field.status === 'corrected' && fmtValue(field.our_value) !== fmtValue(field.corrected_value)
                const decision = decisions[field.field_name]
                const isOverride = isPending && decision?.action === 'override'
                const isSkip = isPending && decision?.action === 'skip'
                const isUnknown = field.status === 'unknown'
                return (
                  <tr key={i} style={{ borderBottom:'1px solid var(--slate-100)',
                    background: field.status === 'corrected' ? 'var(--orange-25, #fff9f0)' :
                                isSkip ? 'var(--slate-50)' : 'transparent',
                    opacity: isSkip ? 0.6 : 1 }}>
                    <td style={{ padding:'10px 16px', fontWeight:500, color:'var(--slate-700)', whiteSpace:'nowrap', verticalAlign:'top' }}>
                      {fmtFieldName(field.field_name)}
                      {field.notes && (
                        <div style={{ marginTop:4, fontSize:11, fontWeight:400, fontStyle:'italic',
                          color:'var(--slate-500)', whiteSpace:'normal', maxWidth:200 }}>
                          “{field.notes}”
                        </div>
                      )}
                    </td>
                    <td style={{ padding:'10px 16px', fontFamily:'monospace', fontSize:12, verticalAlign:'top',
                      color: changed ? 'var(--slate-400)' : 'var(--slate-700)',
                      textDecoration: changed ? 'line-through' : 'none' }}>
                      {fmtValue(field.our_value)}
                    </td>
                    <td style={{ padding:'10px 16px', fontFamily:'monospace', fontSize:12, verticalAlign:'top',
                      color: field.status === 'corrected' ? 'var(--orange-700)' : 'var(--slate-700)',
                      fontWeight: field.status === 'corrected' ? 600 : 400 }}>
                      {field.status === 'confirmed' ? fmtValue(field.our_value) : fmtValue(field.corrected_value)}
                    </td>
                    <td style={{ padding:'10px 16px', verticalAlign:'top' }}>
                      <StatusPill status={field.status} />
                    </td>
                    {isPending && (
                      <td style={{ padding:'8px 16px', verticalAlign:'top', minWidth:170 }}>
                        {isUnknown ? (
                          <span style={{ fontSize:11, color:'var(--slate-400)' }}>—</span>
                        ) : (
                          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                            <Select
                              value={decision?.action ?? 'accept'}
                              onChange={(e) => {
                                const next = e.target.value as DecisionAction
                                setDecisions(prev => ({
                                  ...prev,
                                  [field.field_name]: next === 'override'
                                    ? {
                                        action: 'override',
                                        override_value:
                                          prev[field.field_name]?.override_value ??
                                          (field.status === 'corrected'
                                            ? fmtValue(field.corrected_value)
                                            : fmtValue(field.our_value)),
                                      }
                                    : { action: next },
                                }))
                              }}
                              options={[
                                { value:'accept',   label:'Accept' },
                                { value:'skip',     label:'Skip' },
                                { value:'override', label:'Override' },
                              ]}
                              style={{ height:30, fontSize:12 }}
                            />
                            {isOverride && (
                              <Input
                                value={decision?.override_value ?? ''}
                                onChange={(e) => setDecisions(prev => ({
                                  ...prev,
                                  [field.field_name]: { action:'override', override_value: e.target.value },
                                }))}
                                placeholder="Override value"
                                style={{ height:30, fontSize:12 }}
                              />
                            )}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
              {row.fields.length === 0 && (
                <tr>
                  <td colSpan={isPending ? 5 : 4} style={{ padding:'24px 16px', textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>
                    No field data in this submission
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Right — meta panel */}
        <div style={{ padding:20, background:'var(--slate-25)', display:'flex', flexDirection:'column', gap:18 }}>
          <div>
            <div style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>Mechanic</div>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <Avatar name={row.mechanicName} size={32} />
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>{row.mechanicName}</div>
                <div style={{ fontSize:11, color:'var(--slate-500)' }}>Submitted {timeAgo(row.submittedAt)}</div>
              </div>
            </div>
          </div>

          {row.jobId && (
            <div>
              <div style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Job ID</div>
              <span className="mono" style={{ fontSize:11, color:'var(--blue-700)', wordBreak:'break-all' }}>{row.jobId}</span>
            </div>
          )}

          <div>
            <div style={{ fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Config verification</div>
            <div style={{ fontSize:12, color:'var(--slate-700)', marginBottom:4 }}>
              Verified <strong>{row.verificationCount}</strong> time{row.verificationCount !== 1 ? 's' : ''}
              {row.verificationCount < 3 && (
                <span style={{ color:'var(--slate-400)' }}> · {3 - row.verificationCount} more to auto-verify</span>
              )}
            </div>
            {row.enrichmentStatus && (
              <Badge tone={row.enrichmentStatus === 'verified' ? 'green' : row.enrichmentStatus === 'enriched' ? 'blue' : 'slate'}>
                {row.enrichmentStatus}
              </Badge>
            )}
          </div>

          <div style={{ marginTop:'auto', padding:'12px 14px', background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, fontSize:12, color:'var(--slate-600)', lineHeight:1.6 }}>
            <strong style={{ display:'block', marginBottom:4, color:'var(--slate-700)' }}>On accept:</strong>
            {isPending ? (
              <>
                {decisionCounts.acceptCorrected > 0 && (
                  <div>· Apply {decisionCounts.acceptCorrected} correction{decisionCounts.acceptCorrected !== 1 ? 's' : ''} (0.99 confidence)</div>
                )}
                {decisionCounts.acceptConfirmed > 0 && (
                  <div>· Log {decisionCounts.acceptConfirmed} confirmation{decisionCounts.acceptConfirmed !== 1 ? 's' : ''} (0.98 confidence)</div>
                )}
                {decisionCounts.override > 0 && (
                  <div>· Write {decisionCounts.override} director override{decisionCounts.override !== 1 ? 's' : ''} (0.99 confidence)</div>
                )}
                {decisionCounts.skip > 0 && (
                  <div style={{ color:'var(--slate-500)' }}>· Skip {decisionCounts.skip} field{decisionCounts.skip !== 1 ? 's' : ''}</div>
                )}
                <div>· Increment verification count → {row.verificationCount + 1}</div>
                {row.verificationCount + 1 >= 3 && row.enrichmentStatus !== 'verified' && (
                  <div style={{ color:'var(--green-700)', fontWeight:500 }}>· Config flips to &quot;verified&quot;</div>
                )}
              </>
            ) : (
              <div style={{ color:'var(--slate-500)' }}>Review-only — no decision changes available.</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: 'orange' | 'green' | 'red' | 'slate' | 'purple'; label: string }> = {
    pending:  { tone: 'orange', label: 'Pending'  },
    accepted: { tone: 'green',  label: 'Accepted' },
    rejected: { tone: 'red',    label: 'Rejected' },
    undone:   { tone: 'purple', label: 'Undone'   },
  }
  const m = map[status] ?? { tone: 'slate' as const, label: status }
  return <Badge tone={m.tone}>{m.label}</Badge>
}

export const TabMechanicEdits = () => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const [selected,   setSelected]   = useState<PendingRow | null>(null)
  const [quickBusy,  setQuickBusy]  = useState<string | null>(null)
  const [filter,     setFilter]     = useState<StatusFilter>('pending')

  const rows = useQuery(
    api.director_mechanic_verifications.listAll,
    { status: filter === 'all' ? undefined : filter }
  )
  const accept = useMutation(api.director_mechanic_verifications.acceptVerification)
  const reject = useMutation(api.director_mechanic_verifications.rejectVerification)
  const undo   = useMutation(api.undoMechanicVerification.undoById)

  // Counts shown on filter tabs — fetched separately so the counts stay
  // accurate regardless of which filter is active.
  const allCounts = useQuery(api.director_mechanic_verifications.listAll, { status: undefined })
  const counts = allCounts
    ? {
        all:      allCounts.length,
        pending:  allCounts.filter((r: PendingRow) => r.status === 'pending').length,
        accepted: allCounts.filter((r: PendingRow) => r.status === 'accepted').length,
        rejected: allCounts.filter((r: PendingRow) => r.status === 'rejected').length,
        undone:   allCounts.filter((r: PendingRow) => r.status === 'undone').length,
      }
    : { all: 0, pending: 0, accepted: 0, rejected: 0, undone: 0 }

  const quickAccept = async (row: PendingRow) => {
    setQuickBusy(String(row._id) + '_accept')
    await accept({ id: row._id, actorName, actorId })
    setQuickBusy(null)
  }

  const quickReject = async (row: PendingRow) => {
    setQuickBusy(String(row._id) + '_reject')
    await reject({ id: row._id, actorName, actorId })
    setQuickBusy(null)
  }

  const quickUndo = async (row: PendingRow) => {
    if (!confirm(`Revert this accepted verification?\n\n${row.vehicle}\n${row.fields.length} fields will be restored to their previous values.`)) return
    setQuickBusy(String(row._id) + '_undo')
    await undo({ id: row._id, actorName, actorId })
    setQuickBusy(null)
  }

  const FilterTab = ({ value, label, count }: { value: StatusFilter; label: string; count: number }) => {
    const active = filter === value
    return (
      <button
        onClick={() => setFilter(value)}
        style={{
          padding: '8px 14px',
          fontSize: 13,
          fontWeight: 600,
          border: 'none',
          background: 'transparent',
          color: active ? 'var(--slate-900)' : 'var(--slate-500)',
          borderBottom: active ? '2px solid var(--blue-600)' : '2px solid transparent',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
        {label}
        <span style={{
          fontSize: 11,
          padding: '1px 6px',
          borderRadius: 10,
          background: active ? 'var(--blue-50)' : 'var(--slate-100)',
          color: active ? 'var(--blue-700)' : 'var(--slate-500)',
        }}>{count}</span>
      </button>
    )
  }

  return (
    <SectionAnchor id="mechanic-edits" title="Mechanic Edits"
      subtitle="Mechanics submit post-job verifications to correct or confirm vehicle config data. Review history shown across all statuses.">

      <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, overflow:'hidden' }}>
        {/* Filter tabs */}
        <div style={{ display:'flex', alignItems:'center', borderBottom:'1px solid var(--slate-200)', padding:'0 14px', gap:4 }}>
          <FilterTab value="pending"  label="Pending"  count={counts.pending} />
          <FilterTab value="accepted" label="Accepted" count={counts.accepted} />
          <FilterTab value="rejected" label="Rejected" count={counts.rejected} />
          <FilterTab value="undone"   label="Undone"   count={counts.undone} />
          <FilterTab value="all"      label="All"      count={counts.all} />
        </div>

        {rows === undefined ? (
          <div style={{ padding:'40px 0', textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding:'60px 0', textAlign:'center' }}>
            <div style={{ fontSize:24, marginBottom:10 }}>{filter === 'pending' ? '✓' : '—'}</div>
            <div style={{ fontSize:14, fontWeight:600, color:'var(--slate-700)', marginBottom:4 }}>
              {filter === 'pending' ? 'All caught up' : 'No records'}
            </div>
            <div style={{ fontSize:13, color:'var(--slate-400)' }}>
              {filter === 'pending'
                ? 'No pending mechanic verifications.'
                : `No ${filter === 'all' ? '' : filter + ' '}mechanic verifications.`}
            </div>
          </div>
        ) : (
          <>
            <table style={{ ...tableStyles.table, fontSize:13 }}>
              <thead>
                <tr>
                  {(['Status', 'Vehicle', 'Mechanic', 'Submitted', 'Accuracy', 'Fields', 'Parts OK', 'Labor', ''] as const).map(h => (
                    <th key={h} style={{ ...tableStyles.th }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rows as PendingRow[]).map(row => {
                  const isBusy   = quickBusy?.startsWith(String(row._id))
                  const isPending  = row.status === 'pending'
                  const isAccepted = row.status === 'accepted'
                  return (
                    <tr key={String(row._id)} onClick={() => setSelected(row)}
                      style={{ ...tableStyles.tr, cursor:'pointer' }}>

                      <td style={{ ...tableStyles.td }}>
                        <StatusBadge status={row.status} />
                      </td>

                      <td style={{ ...tableStyles.td }}>
                        <div style={{ fontWeight:600, color:'var(--slate-900)' }}>{row.vehicle || '—'}</div>
                        <div className="mono" style={{ fontSize:11, color:'var(--slate-400)', marginTop:2 }}>{row.configKey}</div>
                      </td>

                      <td style={{ ...tableStyles.td }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <Avatar name={row.mechanicName} size={24} />
                          <span style={{ color:'var(--slate-700)' }}>{row.mechanicName}</span>
                        </div>
                      </td>

                      <td style={{ ...tableStyles.td, color:'var(--slate-500)', whiteSpace:'nowrap' }}>
                        <div>{timeAgo(row.submittedAt)}</div>
                        {row.verifiedAt && (
                          <div style={{ fontSize:11, color:'var(--slate-400)', marginTop:2 }}>
                            {row.status === 'accepted' ? 'accepted' :
                             row.status === 'rejected' ? 'rejected' :
                             row.status === 'undone'   ? 'reverted' : 'reviewed'}{' '}
                            {timeAgo(row.verifiedAt)}
                          </div>
                        )}
                      </td>

                      <td style={{ ...tableStyles.td }}>
                        <AccuracyBar pct={row.overallAccuracy !== null
                          ? Math.round(row.overallAccuracy * (row.overallAccuracy <= 1 ? 100 : 1))
                          : null} />
                      </td>

                      <td style={{ ...tableStyles.td, whiteSpace:'nowrap' }}>
                        {row.correctedCount > 0 && <span style={{ color:'var(--orange-700)', fontWeight:600 }}>{row.correctedCount}✗ </span>}
                        {row.confirmedCount > 0 && <span style={{ color:'var(--green-700)', fontWeight:600 }}>{row.confirmedCount}✓ </span>}
                        {row.unknownCount > 0 && <span style={{ color:'var(--slate-400)' }}>{row.unknownCount}? </span>}
                        {row.fields.length === 0 && <span style={{ color:'var(--slate-300)' }}>—</span>}
                      </td>

                      <td style={{ ...tableStyles.td }}>
                        {row.partsUsedCorrect === true  && <Badge tone="green">Yes</Badge>}
                        {row.partsUsedCorrect === false && <Badge tone="red">No</Badge>}
                        {row.partsUsedCorrect === null  && <span style={{ color:'var(--slate-300)' }}>—</span>}
                      </td>

                      <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>
                        {row.actualLaborHours !== null ? `${row.actualLaborHours}h` : '—'}
                      </td>

                      <td style={{ ...tableStyles.td }} onClick={e => e.stopPropagation()}>
                        <div style={{ display:'flex', gap:6 }}>
                          {isPending && (
                            <>
                              <Button size="sm" variant="danger"
                                onClick={() => quickReject(row)}
                                disabled={!!isBusy}>
                                {quickBusy === String(row._id) + '_reject' ? '…' : 'Reject'}
                              </Button>
                              <Button size="sm" variant="primary"
                                onClick={() => quickAccept(row)}
                                disabled={!!isBusy}>
                                {quickBusy === String(row._id) + '_accept' ? '…' : 'Accept'}
                              </Button>
                            </>
                          )}
                          {isAccepted && (
                            <Button size="sm" variant="danger"
                              onClick={() => quickUndo(row)}
                              disabled={!!isBusy}>
                              {quickBusy === String(row._id) + '_undo' ? '…' : 'Undo'}
                            </Button>
                          )}
                          {!isPending && !isAccepted && (
                            <span style={{ fontSize:11, color:'var(--slate-400)' }}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      <VerificationModal row={selected} onClose={() => setSelected(null)} />
    </SectionAnchor>
  )
}
