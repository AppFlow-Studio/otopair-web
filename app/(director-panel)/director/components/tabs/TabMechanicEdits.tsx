'use client'

import { useState, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Avatar, Modal, AuditButton, tableStyles } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { useQuery as useAuditQuery } from 'convex/react'

type VerificationField = {
  field_name: string
  our_value: unknown
  corrected_value: unknown
  status: 'confirmed' | 'corrected' | 'unknown'
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
  verificationCount: number
  enrichmentStatus: string | null
}

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

  const accept = useMutation(api.director_mechanic_verifications.acceptVerification)
  const reject = useMutation(api.director_mechanic_verifications.rejectVerification)
  const [busy, setBusy]           = useState(false)
  const [confirming, setConfirming] = useState<'accept' | 'reject' | null>(null)
  const [auditOpen, setAuditOpen]   = useState(false)

  const rawAudit = useAuditQuery(
    api.audit_log.listByEntity,
    row ? { entity_type: 'vehicle_config', entity_id: String(row.configId) } : 'skip'
  )
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  if (!row) return null

  const handleAccept = async () => {
    setBusy(true)
    await accept({ id: row._id, actorName, actorId })
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

  const corrected  = row.fields.filter(f => f.status === 'corrected')
  const confirmed  = row.fields.filter(f => f.status === 'confirmed')
  const unknown    = row.fields.filter(f => f.status === 'unknown')

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
                ? `This will apply ${corrected.length} correction${corrected.length !== 1 ? 's' : ''} and ${confirmed.length} confirmation${confirmed.length !== 1 ? 's' : ''} to the vehicle config.`
                : 'This will reject the submission and no data will be written.'}
            </span>
            <Button onClick={() => setConfirming(null)}>Cancel</Button>
            {confirming === 'accept'
              ? <Button variant="primary" onClick={handleAccept} disabled={busy}>{busy ? 'Accepting…' : 'Confirm accept'}</Button>
              : <Button variant="danger"  onClick={handleReject} disabled={busy}>{busy ? 'Rejecting…' : 'Confirm reject'}</Button>
            }
          </div>
        ) : (
          <>
            <Button onClick={onClose}>Close</Button>
            <span style={{ flex:1 }} />
            <Button variant="danger"   onClick={() => setConfirming('reject')}>Reject</Button>
            <Button variant="primary"  onClick={() => setConfirming('accept')}>Accept verification</Button>
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
                {(['Field', 'Our value', "Mechanic's value", 'Status'] as const).map(h => (
                  <th key={h} style={{ padding:'8px 16px', textAlign:'left', fontSize:11, fontWeight:600,
                    color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...corrected, ...confirmed, ...unknown].map((field, i) => {
                const changed = field.status === 'corrected' && fmtValue(field.our_value) !== fmtValue(field.corrected_value)
                return (
                  <tr key={i} style={{ borderBottom:'1px solid var(--slate-100)',
                    background: field.status === 'corrected' ? 'var(--orange-25, #fff9f0)' : 'transparent' }}>
                    <td style={{ padding:'10px 16px', fontWeight:500, color:'var(--slate-700)', whiteSpace:'nowrap' }}>
                      {fmtFieldName(field.field_name)}
                    </td>
                    <td style={{ padding:'10px 16px', fontFamily:'monospace', fontSize:12,
                      color: changed ? 'var(--slate-400)' : 'var(--slate-700)',
                      textDecoration: changed ? 'line-through' : 'none' }}>
                      {fmtValue(field.our_value)}
                    </td>
                    <td style={{ padding:'10px 16px', fontFamily:'monospace', fontSize:12,
                      color: field.status === 'corrected' ? 'var(--orange-700)' : 'var(--slate-700)',
                      fontWeight: field.status === 'corrected' ? 600 : 400 }}>
                      {field.status === 'confirmed' ? fmtValue(field.our_value) : fmtValue(field.corrected_value)}
                    </td>
                    <td style={{ padding:'10px 16px' }}>
                      <StatusPill status={field.status} />
                    </td>
                  </tr>
                )
              })}
              {row.fields.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding:'24px 16px', textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>
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
            {corrected.length > 0 && <div>· Write {corrected.length} correction{corrected.length !== 1 ? 's' : ''} to enrichment evidence (0.99 confidence)</div>}
            {confirmed.length > 0 && <div>· Log {confirmed.length} confirmation{confirmed.length !== 1 ? 's' : ''} (0.98 confidence)</div>}
            <div>· Increment verification count → {row.verificationCount + 1}</div>
            {row.verificationCount + 1 >= 3 && row.enrichmentStatus !== 'verified' && (
              <div style={{ color:'var(--green-700)', fontWeight:500 }}>· Config flips to "verified"</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export const TabMechanicEdits = () => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const [selected,  setSelected]  = useState<PendingRow | null>(null)
  const [quickBusy, setQuickBusy] = useState<string | null>(null)

  const pending = useQuery(api.director_mechanic_verifications.listPending)
  const accept  = useMutation(api.director_mechanic_verifications.acceptVerification)
  const reject  = useMutation(api.director_mechanic_verifications.rejectVerification)

  const quickAccept = async (e: React.MouseEvent, row: PendingRow) => {
    e.stopPropagation()
    setQuickBusy(String(row._id) + '_accept')
    await accept({ id: row._id, actorName, actorId })
    setQuickBusy(null)
  }

  const quickReject = async (e: React.MouseEvent, row: PendingRow) => {
    e.stopPropagation()
    setQuickBusy(String(row._id) + '_reject')
    await reject({ id: row._id, actorName, actorId })
    setQuickBusy(null)
  }

  return (
    <SectionAnchor id="mechanic-edits" title="Pending Mechanic Edits"
      subtitle="Mechanics submit post-job verifications to correct or confirm vehicle config data. Review before writing to enrichment evidence.">

      {pending === undefined ? (
        <div style={{ padding:'40px 0', textAlign:'center', fontSize:13, color:'var(--slate-400)' }}>Loading…</div>
      ) : pending.length === 0 ? (
        <div style={{ padding:'60px 0', textAlign:'center' }}>
          <div style={{ fontSize:24, marginBottom:10 }}>✓</div>
          <div style={{ fontSize:14, fontWeight:600, color:'var(--slate-700)', marginBottom:4 }}>All caught up</div>
          <div style={{ fontSize:13, color:'var(--slate-400)' }}>No pending mechanic verifications.</div>
        </div>
      ) : (
        <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, overflow:'hidden' }}>
          <div style={{ padding:'12px 18px', borderBottom:'1px solid var(--slate-200)', display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:13, fontWeight:600, color:'var(--slate-700)' }}>{pending.length} pending</span>
            <Badge tone="orange">{pending.reduce((n, r) => n + r.correctedCount, 0)} corrections to review</Badge>
          </div>

          <table style={{ ...tableStyles.table, fontSize:13 }}>
            <thead>
              <tr>
                {(['Vehicle', 'Mechanic', 'Submitted', 'Accuracy', 'Fields', 'Parts OK', 'Labor', ''] as const).map(h => (
                  <th key={h} style={{ ...tableStyles.th }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(pending as PendingRow[]).map(row => {
                const isBusy = quickBusy?.startsWith(String(row._id))
                return (
                  <tr key={String(row._id)} onClick={() => setSelected(row)}
                    style={{ ...tableStyles.tr, cursor:'pointer' }}>

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
                      {timeAgo(row.submittedAt)}
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
                        <Button size="sm" variant="danger"
                          onClick={e => quickReject(e, row)}
                          disabled={!!isBusy}>
                          {quickBusy === String(row._id) + '_reject' ? '…' : 'Reject'}
                        </Button>
                        <Button size="sm" variant="primary"
                          onClick={e => quickAccept(e, row)}
                          disabled={!!isBusy}>
                          {quickBusy === String(row._id) + '_accept' ? '…' : 'Accept'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <VerificationModal row={selected} onClose={() => setSelected(null)} />
    </SectionAnchor>
  )
}
