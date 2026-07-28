'use client'

// Review sidebar — the single, scalable "open a review item" surface. Every
// row that represents a review_queue item (Overview's stale rail, the Needs
// Attention hub) opens THIS panel instead of each maintaining its own inline
// expand/detail markup or its own popup. Shows the car (VIN/YMMT, copyable),
// the source run, every flag it threw alongside the value CURRENTLY stored
// for that field, and lets a director either Approve (keep the scraped value
// — engine-backed fields get stamped verified so the next re-enrich can't
// clobber the confirmation) or Adjust (type the correct value; writes through
// directorConfigActions.resolveReviewField, which is audited — who/when —
// same as every other admin edit in this panel). Both actions require a
// source link (where the director verified the value) and go through a
// confirm popup before writing, same ceremony as WrongPartsPanel's drawer.
// Also surfaces this config's missing-part and missing-price quotability
// gaps so a director can fill them in manually (source stamped
// "manual_seed" / "director_manual:<name>") without leaving the review.

import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Sidebar, MicroH } from '../../Primitives'
import { CopyableMono, StatusPill, SkeletonBlock, Empty, Linkify, ConfirmPopup, STREAM_SOURCE, timeAgo } from './helpers'

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--slate-200)', borderRadius: 6, padding: '6px 8px',
  fontSize: 12, color: 'var(--slate-800)', background: '#fff', minWidth: 0, fontFamily: 'inherit',
}
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }

const DIRECTOR_ACTION_ERRORS: Record<string, string> = {
  source_url_required: 'Enter a source link (where you verified this value).',
  invalid_source_url: 'That doesn’t look like a valid link (needs http:// or https://).',
  value_required: 'Enter a value.',
  invalid_number: 'Enter a valid number.',
  invalid_price: 'Enter a valid price.',
  field_not_editable: 'This field can’t be auto-resolved from here.',
  config_not_found: 'This vehicle config no longer exists.',
  part_not_found: 'This part no longer exists.',
}
function resolveFieldErrorMessage(reason: string | undefined): string {
  return (reason && DIRECTOR_ACTION_ERRORS[reason]) ?? 'Failed to save'
}

type FlagState = { mode: 'idle' | 'approving' | 'adjusting'; value: string; sourceUrl: string; saving: boolean; saved: string | null; error: string | null }

export function ReviewSidebar({ token, item, onClose, onResolved, goDeepDive }: {
  token: string
  item: { id: string; title: string } | null
  onClose: () => void
  onResolved: () => void
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const ctx = useQuery(api.dataOverview.reviewResolveContext, item ? { token, id: item.id as Id<'review_queue'> } : 'skip')
  const partGaps = useQuery(api.serviceParts.getServiceGapsForConfig,
    ctx?.configId ? { vehicleConfigId: ctx.configId as Id<'vehicle_configs'> } : 'skip')
  const priceGaps = useQuery(api.serviceParts.getPriceGapsForConfig,
    ctx?.configId ? { vehicleConfigId: ctx.configId as Id<'vehicle_configs'> } : 'skip')

  const resolveField = useMutation(api.directorConfigActions.resolveReviewField)
  const addFitment = useMutation(api.directorConfigActions.addConfigFitment)
  const addPrice = useMutation(api.directorConfigActions.addManualPartPrice)
  const resolveReview = useMutation(api.reviewQueue.resolve)

  const [flagState, setFlagState] = useState<Record<string, FlagState>>({})
  const [gapForms, setGapForms] = useState<Record<string, { oem: string; name: string; saving: boolean; saved: boolean }>>({})
  const [priceForms, setPriceForms] = useState<Record<string, { price: string; sourceUrl: string; saving: boolean; saved: boolean; error: string }>>({})
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<'resolved' | 'dismissed' | null>(null)
  const [err, setErr] = useState('')

  // Navigating to Deep-Dive changes the tab underneath this sidebar — close
  // it first so the director isn't left staring at an overlay over a tab
  // that just changed behind it.
  const openDeepDive = (configId: string, configKey: string | null, runId?: string) => {
    onClose()
    goDeepDive(configId, configKey, runId)
  }
  const flag = (field: string): FlagState => flagState[field] ?? { mode: 'idle', value: '', sourceUrl: '', saving: false, saved: null, error: null }
  const patchFlag = (field: string, patch: Partial<FlagState>) =>
    setFlagState(s => ({ ...s, [field]: { ...flag(field), ...patch } }))

  const approve = async (field: string) => {
    if (!ctx?.configId) return
    const sourceUrl = flag(field).sourceUrl.trim()
    patchFlag(field, { saving: true, error: null })
    try {
      const res = await resolveField({ token, vehicleConfigId: ctx.configId as Id<'vehicle_configs'>, field, action: 'approve', sourceUrl })
      if (!res.ok) { patchFlag(field, { saving: false, error: resolveFieldErrorMessage(res.reason) }); setFlagPending(null); return }
      patchFlag(field, { saving: false, saved: 'Confirmed as-is', mode: 'idle' })
      setFlagPending(null)
    } catch (e) {
      patchFlag(field, { saving: false, error: e instanceof Error ? e.message : 'Failed to save' })
      setFlagPending(null)
    }
  }
  const saveAdjust = async (field: string) => {
    if (!ctx?.configId) return
    const v = flag(field).value.trim()
    const sourceUrl = flag(field).sourceUrl.trim()
    if (!v) { patchFlag(field, { error: 'Enter a value' }); return }
    patchFlag(field, { saving: true, error: null })
    try {
      const res = await resolveField({ token, vehicleConfigId: ctx.configId as Id<'vehicle_configs'>, field, action: 'adjust', value: v, sourceUrl })
      if (!res.ok) { patchFlag(field, { saving: false, error: resolveFieldErrorMessage(res.reason) }); setFlagPending(null); return }
      patchFlag(field, { saving: false, saved: `Adjusted → ${v}`, mode: 'idle' })
      setFlagPending(null)
    } catch (e) {
      patchFlag(field, { saving: false, error: e instanceof Error ? e.message : 'Failed to save' })
      setFlagPending(null)
    }
  }

  // The per-field source-link box gates whether an approve/adjust CAN be
  // submitted; flagPending's confirm popup gates whether the director MEANT
  // to click — same two-stage ceremony as the top-level resolve/dismiss
  // below, and as WrongPartsPanel's drawer.
  const [flagPending, setFlagPending] = useState<{ field: string; action: 'approve' | 'adjust' } | null>(null)
  const requestFlagAction = (field: string, action: 'approve' | 'adjust') => {
    const fs = flag(field)
    if (!fs.sourceUrl.trim()) { patchFlag(field, { error: 'Enter a source link (where you verified this value)' }); return }
    if (action === 'adjust' && !fs.value.trim()) { patchFlag(field, { error: 'Enter a value' }); return }
    patchFlag(field, { error: null })
    setFlagPending({ field, action })
  }

  const gapKey = (g: { serviceSlug: string; roleKey: string }) => `${g.serviceSlug}:${g.roleKey}`
  const gapState = (k: string) => gapForms[k] ?? { oem: '', name: '', saving: false, saved: false }
  const addPart = async (g: { serviceSlug: string; roleKey: string }) => {
    if (!ctx?.configId) return
    const k = gapKey(g)
    const st = gapState(k)
    if (!st.oem.trim()) return
    setGapForms(s => ({ ...s, [k]: { ...st, saving: true } }))
    try {
      await addFitment({ token, vehicleConfigId: ctx.configId as Id<'vehicle_configs'>, serviceSlug: g.serviceSlug, roleKey: g.roleKey, oemNumber: st.oem.trim(), partName: st.name.trim() || undefined })
      setGapForms(s => ({ ...s, [k]: { oem: '', name: '', saving: false, saved: true } }))
    } catch {
      setGapForms(s => ({ ...s, [k]: { ...st, saving: false } }))
    }
  }

  const priceState = (partId: string) => priceForms[partId] ?? { price: '', sourceUrl: '', saving: false, saved: false, error: '' }
  const addManualPrice = async (partId: string) => {
    const st = priceState(partId)
    const price = Number(st.price)
    if (!Number.isFinite(price) || price <= 0) { setPriceForms(s => ({ ...s, [partId]: { ...st, error: 'Enter a valid price' } })); return }
    if (!st.sourceUrl.trim()) { setPriceForms(s => ({ ...s, [partId]: { ...st, error: 'Enter a source link (where you found this price)' } })); return }
    setPriceForms(s => ({ ...s, [partId]: { ...st, saving: true, error: '' } }))
    try {
      const res = await addPrice({ token, partId: partId as Id<'oem_parts'>, price, sourceUrl: st.sourceUrl.trim() })
      if (!res.ok) { setPriceForms(s => ({ ...s, [partId]: { ...st, saving: false, error: resolveFieldErrorMessage(res.reason) } })); return }
      setPriceForms(s => ({ ...s, [partId]: { price: '', sourceUrl: '', saving: false, saved: true, error: '' } }))
    } catch (e) {
      setPriceForms(s => ({ ...s, [partId]: { ...st, saving: false, error: e instanceof Error ? e.message : 'Failed to save' } }))
    }
  }

  // The reason box gates whether you CAN resolve/dismiss; requestFinish's
  // confirm popup gates whether you MEANT to click — this closes the review
  // for good, so a misclick shouldn't be silent.
  const [pending, setPending] = useState<'resolved' | 'dismissed' | null>(null)
  const requestFinish = (outcome: 'resolved' | 'dismissed') => {
    if (reason.trim().length < 4) { setErr('A reason is required (at least a few words).'); return }
    setErr('')
    setPending(outcome)
  }
  const finish = async (outcome: 'resolved' | 'dismissed') => {
    if (!item) return
    setBusy(outcome); setErr('')
    try {
      await resolveReview({ token, id: item.id as Id<'review_queue'>, reason: reason.trim(), outcome })
      setPending(null)
      onResolved()
    } catch (e) {
      setBusy(null); setPending(null); setErr(e instanceof Error ? e.message : 'The action failed. Nothing was changed.')
    }
  }

  const carLabel = ctx ? [ctx.year, ctx.make, ctx.model, ctx.trim].filter(Boolean).join(' ') : ''

  return (
    <Sidebar open={!!item} onClose={onClose} title="Resolve review item" width={560}
      footer={<>
        <div style={{ flex: 1, textAlign: 'left' }}>
          {err && <span style={{ fontSize: 12, color: 'var(--red-600)' }}>{err}</span>}
        </div>
        <Button variant="secondary" onClick={onClose} disabled={!!busy}>Cancel</Button>
        <Button variant="secondary" onClick={() => requestFinish('dismissed')} disabled={!!busy}>Dismiss…</Button>
        <Button variant="primary" onClick={() => requestFinish('resolved')} disabled={!!busy}>Resolve…</Button>
      </>}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {!ctx ? <SkeletonBlock height={200} /> : (
          <>
            <div style={{ fontSize: 13, color: 'var(--slate-800)', fontWeight: 500 }}>{ctx.title}</div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Vehicle</MicroH>
              {carLabel || ctx.vin || ctx.configKey || ctx.engineLabel ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  {carLabel && <CopyableMono mono={false} label="YMMT" value={carLabel} />}
                  {ctx.engineLabel && (
                    carLabel
                      ? <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>{ctx.engineLabel}</span>
                      : <span style={{ fontWeight: 600, color: 'var(--slate-800)', fontSize: 12 }}>Engine {ctx.engineLabel}</span>
                  )}
                  {ctx.vin && <CopyableMono value={ctx.vin} label="VIN" />}
                  {ctx.configKey && <CopyableMono value={ctx.configKey} label="config" />}
                  {ctx.configId && (
                    <button className="mono" style={linkBtn}
                      onClick={() => openDeepDive(ctx.configId!, ctx.configKey, ctx.runId ?? undefined)}>
                      Open in Deep-Dive →
                    </button>
                  )}
                </div>
              ) : <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>No car identity resolved (entity: {ctx.entityType}).</span>}
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Source</MicroH>
              <div style={{ fontSize: 12, color: 'var(--slate-500)', lineHeight: 1.6 }}>
                {STREAM_SOURCE[ctx.stream] ?? ctx.stream}
                <br />
                flagged {timeAgo(ctx.createdAt)} <span style={{ color: 'var(--slate-400)' }}>({new Date(ctx.createdAt).toLocaleString()})</span>
                {ctx.runId && (
                  <>
                    <br />
                    run <StatusPill status={ctx.runStatus ?? 'unknown'} />{' '}
                    <button className="mono" style={linkBtn}
                      onClick={() => ctx.configId && openDeepDive(ctx.configId, ctx.configKey, ctx.runId!)}
                      title="Open this run in Deep-Dive">
                      …{ctx.runId.slice(-8)}
                    </button>
                  </>
                )}
              </div>
            </div>

            {ctx.flags.length > 0 && (
              <div>
                <MicroH style={{ marginBottom: 8 }}>Flags thrown — approve the scraped value, or adjust it</MicroH>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {ctx.flags.map((f, i) => {
                    const fs = flag(f.field)
                    return (
                      <div key={i} style={{ border: '1px solid var(--slate-200)', borderRadius: 8, padding: '10px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 4,
                            background: f.severity === 'reject' ? 'var(--red-50)' : 'var(--orange-50)',
                            color: f.severity === 'reject' ? 'var(--red-700)' : 'var(--orange-700)' }}>{f.severity}</span>
                          <span className="mono" style={{ fontWeight: 600, color: 'var(--slate-800)', fontSize: 13 }}>{f.field}</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 6 }}><Linkify text={f.reason} /></div>
                        <div style={{ fontSize: 12, color: 'var(--slate-700)', marginBottom: 8 }}>
                          Scraped value flagged: <span className="mono" style={{ fontWeight: 600 }}>{f.value != null ? String(f.value) : '—'}</span>
                          {f.editable && <span> · currently stored: <span className="mono" style={{ fontWeight: 600 }}>{f.currentValue != null ? String(f.currentValue) : '—'}</span></span>}
                        </div>

                        {!f.editable ? (
                          <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>Can&apos;t auto-resolve this field&apos;s storage location from here — edit it from Deep-Dive, then Resolve this item.</div>
                        ) : fs.saved ? (
                          <div style={{ fontSize: 12, color: 'var(--green-700)' }}>✓ {fs.saved}</div>
                        ) : fs.mode === 'idle' ? (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <Button variant="secondary" size="sm" disabled={fs.saving} onClick={() => patchFlag(f.field, { mode: 'approving', sourceUrl: '', error: null })}>Approve — keep scraped value</Button>
                            <Button variant="secondary" size="sm" disabled={fs.saving} onClick={() => patchFlag(f.field, { mode: 'adjusting', value: f.currentValue != null ? String(f.currentValue) : '', sourceUrl: '', error: null })}>Adjust…</Button>
                          </div>
                        ) : fs.mode === 'approving' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <input value={fs.sourceUrl} onChange={e => patchFlag(f.field, { sourceUrl: e.target.value })}
                              placeholder="Source link — where you verified this value is correct" style={inputStyle} />
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <Button variant="primary" size="sm" disabled={fs.saving} onClick={() => requestFlagAction(f.field, 'approve')}>Confirm approve</Button>
                              <Button variant="secondary" size="sm" disabled={fs.saving} onClick={() => patchFlag(f.field, { mode: 'idle' })}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <input value={fs.value} onChange={e => patchFlag(f.field, { value: e.target.value })}
                              placeholder="Correct value" style={inputStyle} />
                            <input value={fs.sourceUrl} onChange={e => patchFlag(f.field, { sourceUrl: e.target.value })}
                              placeholder="Source link — where you verified the correct value" style={inputStyle} />
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <Button variant="primary" size="sm" disabled={fs.saving} onClick={() => requestFlagAction(f.field, 'adjust')}>{fs.saving ? 'Saving…' : 'Save'}</Button>
                              <Button variant="secondary" size="sm" disabled={fs.saving} onClick={() => patchFlag(f.field, { mode: 'idle' })}>Cancel</Button>
                            </div>
                          </div>
                        )}
                        {fs.error && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--red-600)' }}>{fs.error}</div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {ctx.configId && partGaps && partGaps.gaps.length > 0 && (
              <div>
                <MicroH style={{ marginBottom: 8 }}>Missing parts — this config has no OEM part on file for these</MicroH>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {partGaps.gaps.map(g => {
                    const k = gapKey(g)
                    const st = gapState(k)
                    return (
                      <div key={k} style={{ border: '1px solid var(--yellow-200, #fde68a)', background: 'var(--yellow-50)', borderRadius: 8, padding: '10px 12px' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-700)', marginBottom: 6 }}>{g.serviceName} · {g.roleLabel}</div>
                        {st.saved ? <div style={{ fontSize: 12, color: 'var(--green-700)' }}>✓ Part added</div> : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <input value={st.oem} onChange={e => setGapForms(s => ({ ...s, [k]: { ...st, oem: e.target.value } }))}
                              placeholder="OEM part number" className="mono" style={inputStyle} />
                            <input value={st.name} onChange={e => setGapForms(s => ({ ...s, [k]: { ...st, name: e.target.value } }))}
                              placeholder="Part name (optional)" style={inputStyle} />
                            <Button variant="primary" size="sm" disabled={st.saving || !st.oem.trim()} onClick={() => addPart(g)}>{st.saving ? 'Adding…' : 'Add part'}</Button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {ctx.configId && priceGaps && priceGaps.gaps.length > 0 && (
              <div>
                <MicroH style={{ marginBottom: 8 }}>Missing prices — these parts are fitted but have no trusted price</MicroH>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {priceGaps.gaps.map(g => {
                    const st = priceState(g.partId)
                    return (
                      <div key={g.partId} style={{ border: '1px solid var(--yellow-200, #fde68a)', background: 'var(--yellow-50)', borderRadius: 8, padding: '10px 12px' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-700)', marginBottom: 2 }}>{g.serviceName}</div>
                        <div style={{ fontSize: 12, color: 'var(--slate-600)', marginBottom: 6 }}>
                          <span className="mono">{g.oemNumber ?? '—'}</span>{g.partName ? ` · ${g.partName}` : ''}
                        </div>
                        {st.saved ? <div style={{ fontSize: 12, color: 'var(--green-700)' }}>✓ Price added</div> : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <span style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--slate-400)' }}>$</span>
                              <input value={st.price} onChange={e => setPriceForms(s => ({ ...s, [g.partId]: { ...st, price: e.target.value } }))}
                                placeholder="0.00" inputMode="decimal" style={{ ...inputStyle, width: 100 }} />
                              <Button variant="primary" size="sm" disabled={st.saving} onClick={() => addManualPrice(g.partId)}>{st.saving ? 'Adding…' : 'Add price'}</Button>
                            </div>
                            <input value={st.sourceUrl} onChange={e => setPriceForms(s => ({ ...s, [g.partId]: { ...st, sourceUrl: e.target.value } }))}
                              placeholder="Source link — where you found this price" style={inputStyle} />
                            {st.error && <div style={{ fontSize: 11, color: 'var(--red-600)' }}>{st.error}</div>}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {ctx.flags.length === 0 && !(partGaps?.gaps.length) && !(priceGaps?.gaps.length) && (
              <Empty>No structured flags, part gaps, or price gaps on this item — resolve or dismiss with a reason below.</Empty>
            )}

            <div>
              <MicroH style={{ marginBottom: 6 }}>Reason (recorded in the audit log)</MicroH>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                placeholder="Why is this review being resolved or dismissed?"
                style={{ width: '100%', padding: 10, fontSize: 13, borderRadius: 8, resize: 'vertical', fontFamily: 'inherit',
                  outline: 'none', color: 'var(--slate-900)', background: busy ? 'var(--slate-50)' : '#fff',
                  border: '1px solid var(--slate-200)' }} />
            </div>
          </>
        )}
      </div>
      {pending && (
        <ConfirmPopup open onCancel={() => setPending(null)} onConfirm={() => finish(pending)} busy={!!busy}
          title={pending === 'resolved' ? 'Resolve this review item?' : 'Dismiss this review item?'}
          message={pending === 'resolved'
            ? <>Marks this item <b>resolved</b>. It stays in history for audit; the source record is untouched.</>
            : <>Marks this item <b>dismissed</b> — no data was changed. It stays in history for audit.</>}
          confirmLabel={pending === 'resolved' ? 'Resolve' : 'Dismiss'}
          destructive={pending === 'dismissed'} />
      )}
      {flagPending && (() => {
        const fs = flag(flagPending.field)
        return (
          <ConfirmPopup open onCancel={() => setFlagPending(null)} busy={fs.saving}
            onConfirm={() => (flagPending.action === 'approve' ? approve(flagPending.field) : saveAdjust(flagPending.field))}
            title={flagPending.action === 'approve' ? 'Approve this value?' : 'Save this correction?'}
            message={flagPending.action === 'approve'
              ? <>Confirms <span className="mono" style={{ fontWeight: 600 }}>{flagPending.field}</span> is correct as scraped, sourced from <span style={{ wordBreak: 'break-word' }}>{fs.sourceUrl}</span>.</>
              : <>Changes <span className="mono" style={{ fontWeight: 600 }}>{flagPending.field}</span> to <span className="mono" style={{ fontWeight: 600 }}>{fs.value}</span>, sourced from <span style={{ wordBreak: 'break-word' }}>{fs.sourceUrl}</span>.</>}
            confirmLabel={flagPending.action === 'approve' ? 'Approve' : 'Save'} />
        )
      })()}
    </Sidebar>
  )
}
