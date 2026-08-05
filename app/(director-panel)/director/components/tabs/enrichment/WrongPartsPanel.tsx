'use client'

// Needs Attention · Wrong parts — confidently-wrong AI parts (cross-make /
// brand-signature mismatch, or refuted by the adversarial fitment verifier
// but kept for multi-source safety — the batch-11 Forester mechanism).
// Searchable, filterable, paginated table; a row opens a side drawer with
// the full flag detail, where it was sourced from, and three DISTINCT
// corrective actions:
//   - Approve — "I checked, this part IS correct" (mechanic_verified = true,
//     trusted for quoting from now on).
//   - Adjust  — type the correct OEM number; the wrong fitment is deleted
//     and replaced with a mechanic-verified one (same writer the pre-job
//     "Add part" flow uses).
//   - Dismiss — "not fixing this now" WITHOUT claiming it's correct; only
//     hides it from this scan, quote-time trust is untouched.
// All three require a reason and are audit-logged (directorConfigActions.
// correctWrongPart) — who reviewed/corrected what, and when.

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Sidebar, MicroH, Input, IconSearch } from '../../Primitives'
import { Panel, Empty, SkeletonBlock, CopyableMono, ConfirmPopup, TableWrap, th, td, thRight, tdRight, fmtWhen, PageNav, RunChip, DateRangeFilter, dateInRange } from './helpers'

type WrongPartFlag = FunctionReturnType<typeof api.directorPartQuality.scanWrongParts>['flags'][number]
type ReasonFilter = 'all' | 'cross_make' | 'refuted' | 'role_identity'

const PAGE_SIZE = 15
const drawerLinkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }
const drawerInput: React.CSSProperties = { border: '1px solid var(--slate-200)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--slate-800)', background: '#fff', fontFamily: 'inherit', width: '100%' }

function confidenceTone(c: number | null): { bg: string; fg: string } {
  if (c == null) return { bg: 'var(--slate-100)', fg: 'var(--slate-600)' }
  if (c < 0.5) return { bg: 'var(--red-50)', fg: 'var(--red-700)' }
  if (c < 0.75) return { bg: 'var(--yellow-50)', fg: 'var(--yellow-800)' }
  return { bg: 'var(--green-50)', fg: 'var(--green-700)' }
}

export function WrongPartsPanel({ token, goDeepDive }: {
  token: string
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const data = useQuery(api.directorPartQuality.scanWrongParts, { token })
  const [search, setSearch] = useState('')
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<WrongPartFlag | null>(null)

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.flags.filter(f => {
      if (reasonFilter !== 'all' && f.reasonKind !== reasonFilter) return false
      if (!dateInRange(f.firstSeenAt, dateFrom, dateTo)) return false
      if (!q) return true
      const hay = [f.vin, f.configKey, f.oemNumber, f.partName, f.scrapedName, f.make, f.model, f.trim, String(f.year ?? '')]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [data, search, reasonFilter, dateFrom, dateTo])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE)

  const crossMakeCount = (data?.flags ?? []).filter(f => f.reasonKind === 'cross_make').length
  const refutedCount = (data?.flags ?? []).filter(f => f.reasonKind === 'refuted').length
  const roleIdentityCount = (data?.flags ?? []).filter(f => f.reasonKind === 'role_identity').length

  return (
    <Panel title="Wrong parts" sub={data ? `${data.flags.length}${data.truncated ? '+' : ''} flagged` : undefined}
      right={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input icon={<IconSearch size={14} />} value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search VIN, config, part…" style={{ width: 200, height: 30 }} />
          <div style={{ display: 'inline-flex', gap: 2, background: '#fff', border: '1px solid var(--slate-200)', borderRadius: 8, padding: 3 }}>
            {([
              ['all', `All (${data?.flags.length ?? 0})`],
              ['cross_make', `Cross-make (${crossMakeCount})`],
              ['refuted', `Refuted (${refutedCount})`],
              ['role_identity', `Wrong component (${roleIdentityCount})`],
            ] as const).map(([v, label]) => (
              <button key={v} onClick={() => { setReasonFilter(v); setPage(0) }}
                style={{ padding: '5px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
                  background: reasonFilter === v ? 'var(--blue-50)' : 'transparent', color: reasonFilter === v ? 'var(--blue-700)' : 'var(--slate-600)' }}>
                {label}
              </button>
            ))}
          </div>
          <DateRangeFilter from={dateFrom} to={dateTo}
            onFrom={v => { setDateFrom(v); setPage(0) }} onTo={v => { setDateTo(v); setPage(0) }} />
        </div>
      }>
      {!data ? <SkeletonBlock height={200} /> : filtered.length === 0 ? (
        <Empty>{data.flags.length === 0 ? 'No cross-make or refuted parts found in the most recently confirmed fitments.' : 'No flags match this search/filter.'}</Empty>
      ) : (
        <>
          <TableWrap>
            <thead><tr>
              <th style={th}>Vehicle</th>
              <th style={th}>Part</th>
              <th style={th}>Service</th>
              <th style={th}>Reason</th>
              <th style={thRight}>Confidence</th>
              <th style={thRight}>First seen</th>
              <th style={thRight}>Run</th>
            </tr></thead>
            <tbody>
              {pageRows.map(f => {
                const carLabel = [f.year, f.make, f.model, f.trim].filter(Boolean).join(' ')
                const tone = confidenceTone(f.confidence)
                return (
                  <tr key={f.fitmentId} onClick={() => setSelected(f)} style={{ cursor: 'pointer' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                    <td style={{ ...td, padding: '16px 18px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--slate-800)' }}>{carLabel || f.configKey || f.configId}</div>
                      {f.vin && <div className="mono" style={{ fontSize: 11, color: 'var(--slate-400)' }}>{f.vin}</div>}
                    </td>
                    <td style={{ ...td, padding: '16px 18px' }}>
                      <CopyableMono value={f.oemNumber} style={{ fontWeight: 600 }} />
                      <div style={{ fontSize: 11, color: 'var(--slate-500)' }}>{f.partName}</div>
                      {f.scrapedName && f.scrapedName !== f.partName && (
                        <div style={{ fontSize: 11, color: 'var(--slate-400)', fontStyle: 'italic' }}>
                          listed as “{f.scrapedName}”
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, padding: '16px 18px' }}>{f.serviceType ?? '—'}</td>
                    <td style={{ ...td, padding: '16px 18px' }}>
                      <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', padding: '2px 7px', borderRadius: 999,
                        background: f.reasonKind === 'cross_make' ? 'var(--red-50)' : f.reasonKind === 'role_identity' ? 'var(--purple-50, #f5f3ff)' : 'var(--orange-50)',
                        color: f.reasonKind === 'cross_make' ? 'var(--red-700)' : f.reasonKind === 'role_identity' ? 'var(--purple-700, #6d28d9)' : 'var(--orange-700)' }}>
                        {f.reasonKind === 'cross_make' ? 'Cross-make' : f.reasonKind === 'role_identity' ? 'Wrong component' : 'Refuted'}
                      </span>
                    </td>
                    <td style={{ ...thRight, padding: '16px 18px' }}>
                      {f.confidence != null ? (
                        <span className="mono" style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: tone.bg, color: tone.fg }}>
                          {Math.round(f.confidence * 100)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ ...tdRight, padding: '16px 18px', color: 'var(--slate-500)' }} title={new Date(f.firstSeenAt).toLocaleString()}>{fmtWhen(f.firstSeenAt)}</td>
                    <td style={{ ...tdRight, padding: '16px 18px' }}>
                      <RunChip runId={f.runId} runStatus={f.runStatus} approx
                        onOpen={() => goDeepDive(f.configId, f.configKey, f.runId ?? undefined)} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
          <PageNav page={clampedPage} pageCount={pageCount} total={filtered.length} pageSize={PAGE_SIZE}
            note={data.truncated ? 'scan capped — older fitments excluded' : undefined} onPage={setPage} />
        </>
      )}
      <WrongPartDrawer key={selected?.fitmentId ?? 'none'} token={token} flag={selected}
        onClose={() => setSelected(null)} goDeepDive={goDeepDive} />
    </Panel>
  )
}

export type { WrongPartFlag }

/** The wrong-part triage drawer (approve / adjust / dismiss, audited). Exported
 *  so the car-centric Needs Attention tabs (Incomplete Car Configs) can launch
 *  the exact same ceremony a director already knows from the Wrong parts tab. */
export function WrongPartDrawer({ token, flag, onClose, goDeepDive }: {
  token: string
  flag: WrongPartFlag | null
  onClose: () => void
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const correctPart = useMutation(api.directorConfigActions.correctWrongPart)
  const [mode, setMode] = useState<'idle' | 'adjusting'>('idle')
  const [reason, setReason] = useState('')
  const [oem, setOem] = useState('')
  const [partName, setPartName] = useState('')
  const [busy, setBusy] = useState<'approve' | 'dismiss' | 'adjust' | null>(null)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<string | null>(null)
  // The reason box gates whether you CAN act; requestAction's confirm popup
  // gates whether you MEANT to click — approve/adjust change quote-time
  // trust or delete a fitment, so a misclick shouldn't be silent.
  const [pending, setPending] = useState<'approve' | 'dismiss' | 'adjust' | null>(null)

  if (!flag) return <Sidebar open={false} onClose={onClose} title="Wrong part" />

  const carLabel = [flag.year, flag.make, flag.model, flag.trim].filter(Boolean).join(' ')

  const openDeepDive = () => { onClose(); goDeepDive(flag.configId, flag.configKey, flag.runId ?? undefined) }

  const requestAction = (action: 'approve' | 'dismiss' | 'adjust') => {
    if (reason.trim().length < 4) { setErr('A reason is required (at least a few words).'); return }
    if (action === 'adjust' && !oem.trim()) { setErr('Enter the correct OEM part number.'); return }
    setErr('')
    setPending(action)
  }
  const act = async (action: 'approve' | 'dismiss' | 'adjust') => {
    setBusy(action); setErr('')
    try {
      const res = await correctPart({
        token, reason: reason.trim(), fitmentId: flag.fitmentId as Id<'part_fitments'>, action,
        oemNumber: action === 'adjust' ? oem.trim() : undefined,
        partName: action === 'adjust' ? (partName.trim() || undefined) : undefined,
      })
      if (!res.ok) { setBusy(null); setPending(null); setErr(res.reason ?? 'Failed to save.'); return }
      setBusy(null); setPending(null)
      setDone(action === 'approve' ? 'Confirmed correct — trusted for quoting from now on.'
        : action === 'dismiss' ? 'Dismissed — cleared from this list, quote trust unchanged.'
          : 'Corrected — the wrong part was replaced.')
    } catch (e) {
      setBusy(null); setPending(null); setErr(e instanceof Error ? e.message : 'Failed to save.')
    }
  }
  const confirmMeta: Record<'approve' | 'dismiss' | 'adjust', { title: string; message: React.ReactNode; confirmLabel: string; destructive?: boolean }> = {
    approve: {
      title: 'Approve this part?',
      message: <>Marks <b className="mono">{flag.oemNumber}</b> as mechanic-verified — it will be trusted for real quotes from now on, despite the wrong-part flag.</>,
      confirmLabel: 'Approve',
    },
    dismiss: {
      title: 'Dismiss this flag?',
      message: <>Clears <b className="mono">{flag.oemNumber}</b> from the Wrong Parts list. This does <b>not</b> mark it correct — quote-time trust is unchanged.</>,
      confirmLabel: 'Dismiss',
      destructive: true,
    },
    adjust: {
      title: 'Save this correction?',
      message: <>Deletes the flagged fitment (<b className="mono">{flag.oemNumber}</b>) and replaces it with <b className="mono">{oem}</b>, marked verified. Cannot be undone.</>,
      confirmLabel: 'Save correction',
      destructive: true,
    },
  }

  return (
    <Sidebar open onClose={onClose} title="Wrong part" width={520}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {done ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--green-700)' }}>✓ {done}</div>
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <div>
              <MicroH style={{ marginBottom: 7 }}>Vehicle</MicroH>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                {carLabel && <CopyableMono mono={false} label="YMMT" value={carLabel} />}
                {flag.vin && <CopyableMono value={flag.vin} label="VIN" />}
                {flag.configKey && <CopyableMono value={flag.configKey} label="config" />}
                <button className="mono" style={drawerLinkBtn} onClick={openDeepDive}>Open in Deep-Dive →</button>
              </div>
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Part</MicroH>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--slate-800)' }}>
                <CopyableMono value={flag.oemNumber} style={{ fontWeight: 600 }} /> — {flag.partName}
              </div>
              {flag.scrapedName && flag.scrapedName !== flag.partName && (
                <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2, fontStyle: 'italic' }}>
                  Source listing title: “{flag.scrapedName}”
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>
                {flag.serviceType && <>Service: <span className="mono">{flag.serviceType}</span> · </>}
                Confidence: <b style={{ color: 'var(--slate-700)' }}>{flag.confidence != null ? `${Math.round(flag.confidence * 100)}%` : '—'}</b>
                {' · '}First seen {fmtWhen(flag.firstSeenAt)}{' · '}last confirmed {fmtWhen(flag.confirmedAt)}
              </div>
              {flag.partMakeName && flag.configMakeName && flag.partMakeName !== flag.configMakeName && (
                <div style={{ fontSize: 12, color: 'var(--red-600)', marginTop: 4 }}>{flag.partMakeName} part on a {flag.configMakeName} vehicle</div>
              )}
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Run to investigate</MicroH>
              <RunChip runId={flag.runId} runStatus={flag.runStatus} approx onOpen={openDeepDive} />
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Why it&apos;s flagged</MicroH>
              <div style={{ fontSize: 12, color: 'var(--red-700)', background: 'var(--red-50)', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px' }}>
                {flag.reason}
              </div>
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Sourced from</MicroH>
              {flag.sourceDomains.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {flag.sourceDomains.map(d => (
                    <a key={d} href={`https://${d}`} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 12, color: 'var(--blue-600)', textDecoration: 'none' }}>
                      {d} ↗
                    </a>
                  ))}
                </div>
              ) : <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>No source domain recorded for this fitment.</span>}
            </div>

            <div>
              <MicroH style={{ marginBottom: 6 }}>Reason (recorded in the audit log)</MicroH>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                placeholder="Why are you approving, dismissing, or adjusting this?"
                style={{ width: '100%', padding: 10, fontSize: 13, borderRadius: 8, resize: 'vertical', fontFamily: 'inherit',
                  outline: 'none', color: 'var(--slate-900)', background: '#fff', border: '1px solid var(--slate-200)' }} />
            </div>

            {mode === 'adjusting' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--slate-200)', borderRadius: 8, padding: '16px 18px' }}>
                <MicroH>Correct part</MicroH>
                <input value={oem} onChange={e => setOem(e.target.value)} placeholder="Correct OEM part number" className="mono" style={drawerInput} />
                <input value={partName} onChange={e => setPartName(e.target.value)} placeholder="Part name (optional)" style={drawerInput} />
              </div>
            )}

            {err && <div style={{ fontSize: 12, color: 'var(--red-600)' }}>{err}</div>}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 12, borderTop: '1px solid var(--slate-200)' }}>
              <Button variant="primary" size="sm" disabled={!!busy} onClick={() => requestAction('approve')}>
                Approve — this is correct
              </Button>
              {mode === 'idle' ? (
                <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => setMode('adjusting')}>Adjust…</Button>
              ) : (
                <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => requestAction('adjust')}>
                  Save correction
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => requestAction('dismiss')}>
                Dismiss
              </Button>
            </div>
          </>
        )}
      </div>
      {pending && (
        <ConfirmPopup open onCancel={() => setPending(null)} onConfirm={() => act(pending)} busy={!!busy}
          title={confirmMeta[pending].title} message={confirmMeta[pending].message}
          confirmLabel={confirmMeta[pending].confirmLabel} destructive={confirmMeta[pending].destructive} />
      )}
    </Sidebar>
  )
}
