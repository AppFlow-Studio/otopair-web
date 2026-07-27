'use client'

// Needs Attention · Data Incidents — the workflow for a systemic defect class
// a director found in an audit (e.g. "priced wrong-generation part beats an
// unpriced correct one in arbitration", batch-11). Detection of these classes
// is manual (a director reads run evidence / owner's manuals and spots the
// pattern) — this panel is what happens AFTER that: declare the incident once
// (convex/dataProvenance.ts declareIncident, already existed for the
// Provenance page), attach the specific affected vehicles (VIN or config_key,
// new: data_incident_configs), then work them down one at a time — re-enrich,
// or open Deep-Dive and fix it by hand — marking each corrected as you go.
// Every add and every correction is audited (who/when/why) via directorGate's
// logAudit, same as every other admin action in this console.

import { useState } from 'react'
import { useMutation, useQuery, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Modal, MicroH, Badge } from '../../Primitives'
import { Panel, Empty, SkeletonBlock, CopyableMono, timeAgo } from './helpers'

const SEVERITY_TONE: Record<string, 'red' | 'orange' | 'yellow'> = { sev1: 'red', sev2: 'orange', sev3: 'yellow' }
const INCIDENT_STATUS_TONE: Record<string, 'red' | 'yellow' | 'green'> = { open: 'red', monitoring: 'yellow', resolved: 'green' }

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--slate-200)', borderRadius: 6, padding: '6px 8px',
  fontSize: 12, color: 'var(--slate-800)', background: '#fff', minWidth: 0, fontFamily: 'inherit',
}
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }

type Incident = {
  id: string; number: number; title: string; severity: 'sev1' | 'sev2' | 'sev3'; status: 'open' | 'monitoring' | 'resolved'
  summary: string; root_cause: string | null; affected_count: number | null; affected_entity_type: string | null
  declared_by: string; declared_at: number
}

export function IncidentsPanel({ token, canWrite, canTrigger, goDeepDive }: {
  token: string
  canWrite: boolean
  canTrigger: boolean
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const incidents = useQuery(api.dataProvenance.listIncidents, { token })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [declareOpen, setDeclareOpen] = useState(false)

  const active = (incidents ?? []).filter(i => i.status !== 'resolved')

  return (
    <Panel title="Data Incidents" sub={incidents ? `${active.length} open/monitoring` : undefined}
      right={canWrite ? <Button variant="secondary" size="sm" onClick={() => setDeclareOpen(true)}>Declare incident</Button> : undefined}>
      {!incidents ? <SkeletonBlock height={100} /> : active.length === 0 ? (
        <Empty>No open data-quality incidents.{canWrite ? ' Declare one when an audit finds a systemic defect class (e.g. a whole batch shipping the same wrong-part or wrong-interval pattern).' : ''}</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {active.map(inc => (
            <IncidentCard key={inc.id} incident={inc} expanded={expandedId === inc.id}
              onToggle={() => setExpandedId(expandedId === inc.id ? null : inc.id)}
              token={token} canWrite={canWrite} canTrigger={canTrigger} goDeepDive={goDeepDive} />
          ))}
        </div>
      )}
      <DeclareIncidentModal open={declareOpen} onClose={() => setDeclareOpen(false)} token={token} />
    </Panel>
  )
}

function DeclareIncidentModal({ open, onClose, token }: { open: boolean; onClose: () => void; token: string }) {
  const declare = useMutation(api.dataProvenance.declareIncident)
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<'sev1' | 'sev2' | 'sev3'>('sev2')
  const [summary, setSummary] = useState('')
  const [rootCause, setRootCause] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const close = () => { if (busy) return; setTitle(''); setSummary(''); setRootCause(''); setReason(''); setErr(''); onClose() }
  const submit = async () => {
    if (!title.trim() || !summary.trim()) { setErr('Title and summary are required.'); return }
    if (reason.trim().length < 4) { setErr('A reason is required (at least a few words).'); return }
    setBusy(true); setErr('')
    try {
      await declare({ token, reason: reason.trim(), title: title.trim(), severity, summary: summary.trim(), root_cause: rootCause.trim() || undefined, affected_entity_type: 'vehicle_config' })
      setBusy(false); close()
    } catch (e) {
      setBusy(false); setErr(e instanceof Error ? e.message : 'Failed to declare the incident.')
    }
  }

  return (
    <Modal open={open} onClose={close} title="Declare data incident" width={560}
      footer={<>
        <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={busy}>{busy ? 'Declaring…' : 'Declare'}</Button>
      </>}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <MicroH style={{ marginBottom: 6 }}>Title</MicroH>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Priced wrong-gen part beats unpriced correct part in arbitration"
            style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div>
          <MicroH style={{ marginBottom: 6 }}>Severity</MicroH>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['sev1', 'sev2', 'sev3'] as const).map(s => (
              <button key={s} onClick={() => setSeverity(s)}
                style={{ padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                  border: `1px solid ${severity === s ? 'var(--blue-300, #93C5FD)' : 'var(--slate-200)'}`,
                  background: severity === s ? 'var(--blue-50)' : '#fff', color: severity === s ? 'var(--blue-700)' : 'var(--slate-600)' }}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div>
          <MicroH style={{ marginBottom: 6 }}>Summary — what failed, and the mechanism if known</MicroH>
          <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={4}
            placeholder="e.g. 4 of 5 vehicles shipped a confidently-wrong part. On the Forester every wrong part was priced while the correct part sat in the same list unpriced — priced-ness is beating catalog authority in arbitration."
            style={{ width: '100%', padding: 10, fontSize: 13, borderRadius: 8, resize: 'vertical', fontFamily: 'inherit', outline: 'none', color: 'var(--slate-900)', background: '#fff', border: '1px solid var(--slate-200)' }} />
        </div>
        <div>
          <MicroH style={{ marginBottom: 6 }}>Root cause (optional)</MicroH>
          <input value={rootCause} onChange={e => setRootCause(e.target.value)} placeholder="e.g. partSelector weights price presence above catalog/source authority"
            style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div>
          <MicroH style={{ marginBottom: 6 }}>Reason (recorded in the audit log)</MicroH>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why declare this now — which audit/batch found it?"
            style={{ ...inputStyle, width: '100%' }} />
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--red-600)' }}>{err}</div>}
        <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>Affected vehicles are attached next, from the incident card — paste VINs or config_keys once it&apos;s declared.</div>
      </div>
    </Modal>
  )
}

function IncidentCard({ incident, expanded, onToggle, token, canWrite, canTrigger, goDeepDive }: {
  incident: Incident
  expanded: boolean
  onToggle: () => void
  token: string
  canWrite: boolean
  canTrigger: boolean
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const configs = useQuery(api.dataProvenance.listAffectedConfigs, expanded ? { token, incidentId: incident.id as Id<'data_incidents'> } : 'skip')
  const openCount = configs?.filter(c => c.status === 'open').length
  const correctedCount = configs?.filter(c => c.status === 'corrected').length

  return (
    <div style={{ border: '1px solid var(--slate-200)', borderRadius: 10, overflow: 'hidden' }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: expanded ? 'var(--slate-50)' : '#fff' }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--slate-400)', flexShrink: 0 }}>#{incident.number}</span>
        <Badge tone={SEVERITY_TONE[incident.severity]}>{incident.severity}</Badge>
        <Badge tone={INCIDENT_STATUS_TONE[incident.status]}>{incident.status}</Badge>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--slate-800)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{incident.title}</span>
        <span style={{ fontSize: 11, color: 'var(--slate-500)', flexShrink: 0 }}>
          {expanded && configs ? `${openCount} open · ${correctedCount} corrected` : `${incident.affected_count ?? '?'} affected`}
        </span>
        <span style={{ color: 'var(--slate-300)', flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '14px 16px', borderTop: '1px solid var(--slate-100)' }}>
          <div style={{ fontSize: 13, color: 'var(--slate-700)', lineHeight: 1.6, marginBottom: 10 }}>{incident.summary}</div>
          {incident.root_cause && (
            <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 12 }}>
              <b style={{ color: 'var(--slate-600)' }}>Root cause · </b>{incident.root_cause}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--slate-400)', marginBottom: 14 }}>Declared by {incident.declared_by} · {timeAgo(incident.declared_at)}</div>

          {canWrite && <AddAffectedForm token={token} incidentId={incident.id} />}

          <div style={{ marginTop: 14 }}>
            <MicroH style={{ marginBottom: 8 }}>Affected vehicles</MicroH>
            {!configs ? <SkeletonBlock height={80} /> : configs.length === 0 ? (
              <Empty>No vehicles attached yet — paste VINs or config keys above.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {configs.map(c => (
                  <AffectedConfigRow key={c.id} c={c} token={token} canWrite={canWrite} canTrigger={canTrigger} goDeepDive={goDeepDive} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function AddAffectedForm({ token, incidentId }: { token: string; incidentId: string }) {
  const addAffected = useMutation(api.dataProvenance.addAffectedConfigs)
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ added: number; alreadyPresent: number; notFound: string[] } | null>(null)
  const [err, setErr] = useState('')

  const submit = async () => {
    const identifiers = text.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
    if (identifiers.length === 0) { setErr('Paste at least one VIN or config key.'); return }
    if (reason.trim().length < 4) { setErr('A reason is required.'); return }
    setBusy(true); setErr(''); setResult(null)
    try {
      const res = await addAffected({ token, reason: reason.trim(), incidentId: incidentId as Id<'data_incidents'>, identifiers })
      setBusy(false); setResult(res); setText(''); setReason('')
    } catch (e) {
      setBusy(false); setErr(e instanceof Error ? e.message : 'Failed to add vehicles.')
    }
  }

  return (
    <div style={{ border: '1px dashed var(--slate-200)', borderRadius: 8, padding: '10px 12px', marginBottom: 4 }}>
      <MicroH style={{ marginBottom: 6 }}>Add affected vehicles — one VIN or config_key per line (or comma-separated)</MicroH>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="1FMCU9G60MUA12345&#10;2020_toyota_rav4_xle_2.5l_4cyl_gas"
        style={{ width: '100%', padding: 8, fontSize: 12, borderRadius: 6, resize: 'vertical', fontFamily: 'ui-monospace, monospace', outline: 'none', color: 'var(--slate-900)', background: '#fff', border: '1px solid var(--slate-200)', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (e.g. batch-11 wave-1 audit)"
          style={{ ...inputStyle, flex: 1 }} />
        <Button variant="primary" size="sm" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add'}</Button>
      </div>
      {err && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--red-600)' }}>{err}</div>}
      {result && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--slate-500)' }}>
          ✓ Added {result.added}{result.alreadyPresent ? `, ${result.alreadyPresent} already on this incident` : ''}
          {result.notFound.length > 0 && <span style={{ color: 'var(--red-600)' }}> · not found: {result.notFound.join(', ')}</span>}
        </div>
      )}
    </div>
  )
}

function AffectedConfigRow({ c, token, canWrite, canTrigger, goDeepDive }: {
  c: {
    id: string; configId: string; status: 'open' | 'corrected'; addedBy: string; addedAt: number
    correctedBy: string | null; correctedAt: number | null; correctionNote: string | null
    configKey: string | null; year: number | null; make: string | null; model: string | null; trim: string | null
    engineLabel: string | null; vin: string | null
  }
  token: string
  canWrite: boolean
  canTrigger: boolean
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const setStatus = useMutation(api.dataProvenance.setConfigCorrectionStatus)
  const reEnrich = useAction(api.directorConfigBackfills.reEnrichConfig)
  const [correcting, setCorrecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reEnriching, setReEnriching] = useState(false)
  const [reEnriched, setReEnriched] = useState(false)

  const carLabel = [c.year, c.make, c.model, c.trim].filter(Boolean).join(' ')

  const markCorrected = async () => {
    if (note.trim().length < 4) { setErr('Say what was corrected.'); return }
    setBusy(true); setErr('')
    try {
      await setStatus({ token, reason: note.trim(), id: c.id as Id<'data_incident_configs'>, status: 'corrected' })
      setBusy(false); setCorrecting(false)
    } catch (e) {
      setBusy(false); setErr(e instanceof Error ? e.message : 'Failed to save.')
    }
  }
  const reopen = async () => {
    setBusy(true)
    try { await setStatus({ token, reason: 'Reopened from Needs Attention', id: c.id as Id<'data_incident_configs'>, status: 'open' }) }
    finally { setBusy(false) }
  }
  const triggerReEnrich = async () => {
    setReEnriching(true)
    try { await reEnrich({ token, id: c.configId as Id<'vehicle_configs'> }); setReEnriched(true) }
    finally { setReEnriching(false) }
  }

  return (
    <div style={{ border: '1px solid var(--slate-100)', borderRadius: 8, padding: '8px 10px', background: c.status === 'corrected' ? 'var(--green-50)' : '#fff' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, flexShrink: 0, background: c.status === 'corrected' ? 'var(--green-500)' : 'var(--red-500)' }} />
        <span style={{ fontWeight: 600, color: 'var(--slate-800)' }}>{carLabel || c.configKey || c.configId}</span>
        {c.engineLabel && <span style={{ color: 'var(--slate-400)' }}>{c.engineLabel}</span>}
        {c.vin && <CopyableMono value={c.vin} label="VIN" />}
        {c.configKey && <CopyableMono value={c.configKey} label="config" />}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
          <button style={linkBtn} onClick={() => goDeepDive(c.configId, c.configKey)}>Deep-Dive →</button>
          {canTrigger && (
            <button style={{ ...linkBtn, color: reEnriched ? 'var(--green-700)' : 'var(--blue-700)' }} disabled={reEnriching} onClick={triggerReEnrich}>
              {reEnriching ? 'Re-enriching…' : reEnriched ? 'Queued ✓' : 'Re-enrich'}
            </button>
          )}
          {canWrite && c.status === 'open' && !correcting && (
            <button style={linkBtn} onClick={() => setCorrecting(true)}>Mark corrected…</button>
          )}
          {canWrite && c.status === 'corrected' && (
            <button style={{ ...linkBtn, color: 'var(--slate-500)' }} disabled={busy} onClick={reopen}>Reopen</button>
          )}
        </span>
      </div>
      {c.status === 'corrected' && c.correctionNote && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--green-700)' }}>
          ✓ {c.correctionNote} — {c.correctedBy}{c.correctedAt ? `, ${timeAgo(c.correctedAt)}` : ''}
        </div>
      )}
      {correcting && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="What did you fix? (part/price/interval, source)"
            style={{ ...inputStyle, flex: 1 }} />
          <Button variant="primary" size="sm" disabled={busy} onClick={markCorrected}>{busy ? 'Saving…' : 'Save'}</Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setCorrecting(false); setErr('') }}>Cancel</Button>
        </div>
      )}
      {err && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--red-600)' }}>{err}</div>}
    </div>
  )
}
