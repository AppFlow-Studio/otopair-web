'use client'

import { useState, useEffect, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from './DirectorSessionCtx'
import {
  Badge, Button, StatusBadge, Modal, AuditButton, Avatar,
  IconStar, IconExternal, IconCheck, IconCard, IconCar,
} from './Primitives'
import { DirectorNotesPanel } from './DirectorNotesPanel'
import { gotoEntity } from './directorNav'

/**
 * BookingDetailModal — drill-down used by TabBookings and ShopModal.
 *
 * Surfaces every "form" the user / mechanic filled out for a booking:
 *   • customer notes
 *   • diagnostic system + checklist
 *   • selected service options (e.g. brake-pad front-vs-rear)
 *   • tire specs
 *   • mechanic recommendations + follow-up
 *   • status timeline + payment + review
 */

type Props = {
  bookingId: Id<'bookings'> | null
  onClose:   () => void
}

const TIMELINE_STAGES = ['pending', 'confirmed', 'in_progress', 'completed'] as const

type HistoryEntry = { status: string; changedAt: number; changedBy?: string; reason?: string }

const BookingTimeline = ({ history, currentStatus }: { history: HistoryEntry[]; currentStatus: string }) => {
  const reachedStatuses = new Set([...history.map(h => h.status), currentStatus])
  return (
    <div style={{ display:'flex', alignItems:'center', gap:0, padding:'16px 0' }}>
      {TIMELINE_STAGES.map((stage, i) => {
        const done = reachedStatuses.has(stage)
        const event = history.find(h => h.status === stage)
        const color = done ? (stage === 'completed' ? 'var(--green-600)' : 'var(--blue-600)') : 'var(--slate-300)'
        const timeStr = event
          ? new Date(event.changedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
          : null
        return (
          <div key={stage} style={{ display:'contents' }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, minWidth:120 }}>
              <div style={{ width:28, height:28, borderRadius:999, background:done ? color : '#fff', border:`2px solid ${color}`, display:'inline-flex', alignItems:'center', justifyContent:'center', color:done ? '#fff' : 'var(--slate-300)' }}>
                {done ? <IconCheck size={14} /> : <span style={{ fontSize:11, fontWeight:600 }}>{i+1}</span>}
              </div>
              <div style={{ fontSize:12, fontWeight:500, color:'var(--slate-800)', textTransform:'capitalize' }}>{stage.replace('_',' ')}</div>
              {timeStr && (
                <div style={{ fontSize:11, color:'var(--slate-500)', textAlign:'center' }}>
                  {timeStr}{event?.changedBy ? <><br/>{event.changedBy}</> : null}
                </div>
              )}
            </div>
            {i < TIMELINE_STAGES.length - 1 && (
              <div style={{ flex:1, height:2, background:reachedStatuses.has(TIMELINE_STAGES[i+1]) ? 'var(--blue-600)' : 'var(--slate-200)', marginTop:-32 }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

const KV = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div style={{ display:'grid', gridTemplateColumns:'160px 1fr', gap:8, padding:'4px 0', fontSize:12 }}>
    <span style={{ color:'var(--slate-500)' }}>{k}</span>
    <span style={{ color:'var(--slate-800)', overflow:'hidden', textOverflow:'ellipsis' }}>{v}</span>
  </div>
)

const checklistStatusTone = (s: string): 'green' | 'yellow' | 'red' | 'slate' => ({
  checked:'green' as const, flagged:'red' as const, pending:'yellow' as const, skipped:'slate' as const,
}[s] ?? 'slate' as const)

function fmtTs(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
}

export const BookingDetailModal = ({ bookingId, onClose }: Props) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [auditOpen, setAuditOpen] = useState(false)
  const logView = useMutation(api.director.logView)
  const detail  = useQuery(api.director.bookingDetail, bookingId ? { id: bookingId } : 'skip')

  useEffect(() => {
    if (bookingId) logView({ entity_type: 'booking', entity_id: String(bookingId), actorName, actorId })
  }, [String(bookingId)])

  const rawAudit = useQuery(api.audit_log.listByEntity,
    bookingId ? { entity_type: 'booking', entity_id: bookingId, token: session?.token ?? '' } : 'skip')
  type AuditRow = { created_at: number; action: string; actor: string; detail?: string }
  const auditEntries = (rawAudit as AuditRow[] | undefined)?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  return (
    <Modal open={!!bookingId} onClose={onClose} width={1080}
      eyebrow={detail && <>
        <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>
          {detail.invoiceNumber ?? String(detail.id).slice(-8)}
        </span>
        {detail.liveStage && <Badge tone="blue">{detail.liveStage}</Badge>}
        {detail.refundReason && <Badge tone="purple">Refund tagged</Badge>}
      </>}
      statusBadge={detail && <StatusBadge status={detail.status} />}
      title={detail?.services.map(s => s.name).join(', ') ?? ''}
      headerRight={<>
        <AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />
        {detail?.payment?.stripePaymentIntentId && (
          <a href={`https://dashboard.stripe.com/payments/${detail.payment.stripePaymentIntentId}`}
             target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
            <Button iconRight={<IconExternal size={13} />}>View on Stripe</Button>
          </a>
        )}
      </>}
      auditDrawer={{
        open: auditOpen, onClose: () => setAuditOpen(false),
        title: 'Booking audit log',
        subtitle: detail ? `${detail.invoiceNumber ?? String(detail.id).slice(-8)} · ${detail.services.map(s => s.name).join(', ')}` : '',
        entries: auditEntries,
      }}
      footer={<Button onClick={onClose}>Close</Button>}>
      {!detail ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <>
          {/* Top strip — user/shop/scheduled */}
          <div style={{ padding:'10px 24px 14px', background:'#fff', display:'flex', flexWrap:'wrap', gap:14, fontSize:12, color:'var(--slate-600)', alignItems:'center', borderBottom:'1px solid var(--slate-100)' }}>
            <span><b style={{ color:'var(--slate-900)' }}>{detail.user}</b></span>
            <span>·</span>
            <span>{detail.shop}</span>
            {detail.scheduled !== '—' && <><span>·</span><span>{detail.scheduled}{detail.time !== '—' ? ` at ${detail.time}` : ''}</span></>}
            {detail.vehicleYmm && <><span>·</span>
              <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                <IconCar size={13} style={{ color:'var(--slate-500)' }} />
                {detail.vehicleYmm}
              </span>
            </>}
            {detail.vin && <><span>·</span><span className="mono" style={{ fontSize:11 }}>{detail.vin}</span></>}
          </div>

          {/* Timeline */}
          <div style={{ padding:'8px 24px 16px', borderBottom:'1px solid var(--slate-200)' }}>
            <SectionTitle label="Status timeline" />
            <BookingTimeline history={detail.statusHistory} currentStatus={detail.status} />
          </div>

          {/* Two-column body — Forms / Specs on left, Parties + Payment on right */}
          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
            {/* LEFT: Forms + diagnostic + selected options + tire specs + recommendations */}
            <div style={{ padding:22, borderRight:'1px solid var(--slate-100)' }}>
              {/* Services */}
              <div style={{ marginBottom:18 }}>
                <SectionTitle
                  label={(() => {
                    const catches = detail.services.filter((s) =>
                      (s.quoteFlags ?? []).includes('fallback_catch'),
                    ).length
                    const corrected = detail.services.filter((s) =>
                      (s.quoteFlags ?? []).includes('engine_corrected_parts'),
                    ).length
                    const aboveEngine = (detail.quoteFlags ?? []).includes(
                      'labor_cost_above_engine',
                    )
                    const parts: string[] = []
                    if (catches > 0) parts.push(`${catches} fallback catch${catches > 1 ? 'es' : ''}`)
                    if (corrected > 0) parts.push(`${corrected} engine-corrected`)
                    if (aboveEngine) {
                      const delta = detail.laborCostDeltaAboveEngineDollars
                      parts.push(
                        delta != null
                          ? `labor $+${delta.toFixed(2)} over engine`
                          : 'labor above engine',
                      )
                    }
                    return parts.length > 0
                      ? `Services (${detail.services.length}) · ${parts.join(' · ')}`
                      : `Services (${detail.services.length})`
                  })()}
                />
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {detail.services.map((s) => {
                    const flags = s.quoteFlags ?? []
                    const isCatch = flags.includes('fallback_catch')
                    const isCorrected = flags.includes('engine_corrected_parts')
                    const isRefused = flags.includes('fallback_only')
                    const otherFlags = flags.filter(
                      (f) =>
                        f !== 'fallback_catch' &&
                        f !== 'engine_corrected_parts' &&
                        f !== 'fallback_only',
                    )
                    const partsLow = s.engineBand?.partsLow
                    const partsHigh = s.engineBand?.partsHigh
                    const linePrice = s.bookingLinePartsCost
                    const fmt = (n: number) => `$${n.toFixed(2)}`
                    const deltaPct =
                      partsLow != null && partsHigh != null && linePrice != null && partsLow > 0
                        ? Math.round(
                            ((linePrice - (partsLow + partsHigh) / 2) /
                              ((partsLow + partsHigh) / 2)) *
                              100,
                          )
                        : null
                    return (
                      <div key={String(s.id)} style={{ background:'#fff', border:`1px solid ${isCatch ? '#FED7AA' : isCorrected ? '#A7F3D0' : 'var(--slate-200)'}`, borderRadius:8, padding:'8px 12px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                            <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{s.name}</span>
                            {isCatch && <Badge tone="orange">⚠ Fallback catch</Badge>}
                            {isCorrected && <Badge tone="green">✓ Engine corrected</Badge>}
                            {isRefused && <Badge tone="red">Engine refused</Badge>}
                            {otherFlags.map((f) => (
                              <Badge key={f} tone="slate">{f}</Badge>
                            ))}
                          </div>
                          {s.category && <Badge tone="slate">{s.category}</Badge>}
                        </div>
                        {s.description && <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:3 }}>{s.description}</div>}
                        {partsLow != null && partsHigh != null && (
                          <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:4, fontFamily:'var(--mono)' }}>
                            Engine parts band {fmt(partsLow)}–{fmt(partsHigh)}
                            {linePrice != null && (
                              <>
                                {' · '}
                                {isCorrected
                                  ? <>customer agreed to engine band ({fmt(linePrice)})</>
                                  : <>booking line {fmt(linePrice)}{deltaPct != null && <> · {deltaPct > 0 ? '+' : ''}{deltaPct}% delta</>}</>
                                }
                              </>
                            )}
                            {s.engineBand?.partsSource && (
                              <> · <span style={{ color:'var(--slate-400)' }}>{s.engineBand.partsSource}</span></>
                            )}
                          </div>
                        )}
                        {isRefused && (
                          <div style={{ fontSize:11, color:'var(--red-700)', marginTop:4 }}>
                            Engine refused this service — routed to booking_approvals.
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Customer notes */}
              {detail.customerNotes && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Customer notes" />
                  <div style={{ background:'var(--blue-50)', border:'1px solid #BFDBFE', borderRadius:8, padding:'10px 12px', fontSize:13, color:'var(--slate-800)', whiteSpace:'pre-wrap', fontStyle:'italic' }}>
                    "{detail.customerNotes}"
                  </div>
                </div>
              )}

              {/* Selected service options (e.g. front vs rear brake pads) */}
              {detail.selectedOptions && detail.selectedOptions.length > 0 && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Selected service options" />
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {detail.selectedOptions.map((o, i) => (
                      <div key={i} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'8px 12px', display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                        <span style={{ fontSize:12, color:'var(--slate-500)' }}>{o.serviceName}</span>
                        <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{o.label}</span>
                        {o.type && <Badge tone="indigo">{o.type}</Badge>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tire specs */}
              {detail.tireSpecs && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Tire request" />
                  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:12 }}>
                      <div><span style={{ color:'var(--slate-500)' }}>Size:</span> <span style={{ fontWeight:500 }} className="mono">{detail.tireSpecs.size}</span></div>
                      <div><span style={{ color:'var(--slate-500)' }}>Quantity:</span> <span style={{ fontWeight:500 }} className="mono">{detail.tireSpecs.quantity}</span></div>
                      <div><span style={{ color:'var(--slate-500)' }}>Type:</span> <span style={{ fontWeight:500 }}>{detail.tireSpecs.type}</span></div>
                      <div><span style={{ color:'var(--slate-500)' }}>Tier:</span> <span style={{ fontWeight:500 }}>{detail.tireSpecs.tier}</span></div>
                    </div>
                  </div>
                </div>
              )}

              {/* Diagnostic system + checklist */}
              {(detail.diagnosticSystem || (detail.diagnosticChecklist && detail.diagnosticChecklist.length > 0)) && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Diagnostic" right={detail.diagnosticSystem && <Badge tone="yellow">{detail.diagnosticSystem}</Badge>} />
                  {detail.diagnosticChecklist && detail.diagnosticChecklist.length > 0 ? (
                    <div style={{ display:'flex', flexDirection:'column', gap:5, marginBottom:8 }}>
                      {detail.diagnosticChecklist.map((item, i: number) => (
                        <div key={i} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'6px 10px' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                            <span style={{ fontSize:12, color:'var(--slate-800)' }}>{item.label}</span>
                            <Badge tone={checklistStatusTone(item.status)}>{item.status}</Badge>
                          </div>
                          {item.mechanic_note && <div style={{ fontSize:11, color:'var(--slate-600)', marginTop:3, fontStyle:'italic' }}>“{item.mechanic_note}”</div>}
                          {item.skip_reason && <div style={{ fontSize:10, color:'var(--slate-500)', marginTop:2 }}>Skipped: {item.skip_reason}</div>}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {detail.diagnosticFindingsNote && (
                    <div style={{ background:'var(--yellow-50)', border:'1px solid #FDE68A', borderRadius:8, padding:'8px 12px', fontSize:12, color:'var(--slate-800)', marginTop:6 }}>
                      <div style={{ fontSize:10, fontWeight:600, color:'var(--yellow-800)', textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:3 }}>Mechanic findings</div>
                      {detail.diagnosticFindingsNote}
                    </div>
                  )}
                  {detail.diagnosticFollowupState && (
                    <div style={{ fontSize:11, color:'var(--slate-600)', marginTop:6 }}>
                      Follow-up: <b>{detail.diagnosticFollowupState}</b>
                      {detail.awaitingInfoNote && <span style={{ fontStyle:'italic' }}> — "{detail.awaitingInfoNote}"</span>}
                    </div>
                  )}
                  {detail.outOfScopeCategory && (
                    <div style={{ fontSize:11, color:'var(--red-700)', marginTop:6 }}>
                      Out of scope: <b>{detail.outOfScopeCategory}</b>
                      {detail.outOfScopeNote && <span> — {detail.outOfScopeNote}</span>}
                    </div>
                  )}
                </div>
              )}

              {/* Recommendations */}
              {detail.recommendedService && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Mechanic recommendation" right={detail.recommendationState && <Badge tone="purple">{detail.recommendationState}</Badge>} />
                  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
                    <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{detail.recommendedService}</div>
                    {detail.recommendedServiceNote && (
                      <div style={{ fontSize:12, color:'var(--slate-600)', marginTop:4, fontStyle:'italic' }}>"{detail.recommendedServiceNote}"</div>
                    )}
                    <div style={{ display:'flex', gap:14, marginTop:6, fontSize:11, color:'var(--slate-500)' }}>
                      {detail.recommendationSentAt && <span>Sent {fmtTs(detail.recommendationSentAt)}</span>}
                      {detail.recommendationDecidedAt && <span>Decided {fmtTs(detail.recommendationDecidedAt)}</span>}
                      {detail.recommendedScheduledDate && (
                        <span>Suggested {detail.recommendedScheduledDate}{detail.recommendedScheduledTime ? ` @ ${detail.recommendedScheduledTime}` : ''}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Refund reason */}
              {detail.refundReason && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Refund reason" />
                  <div style={{ background:'var(--red-50)', border:'1px solid #FECACA', borderRadius:8, padding:'8px 12px', fontSize:12, color:'var(--slate-800)' }}>
                    {detail.refundReason}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT: Parties + payment + review */}
            <div style={{ padding:22, background:'var(--slate-25)' }}>
              {/* Customer */}
              <div style={{ marginBottom:18 }}>
                <SectionTitle label="Customer" right={
                  <Button size="sm" iconRight={<IconExternal size={11} />} onClick={() => gotoEntity('users', String(detail.userId))}>Open</Button>
                } />
                <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px', display:'flex', alignItems:'center', gap:10 }}>
                  <Avatar name={detail.user} size={32} />
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{detail.user}</div>
                    {detail.userEmail && <div style={{ fontSize:11, color:'var(--slate-500)' }}>{detail.userEmail}</div>}
                    {detail.userPhone && <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{detail.userPhone}</div>}
                  </div>
                </div>
              </div>

              {/* Shop */}
              <div style={{ marginBottom:18 }}>
                <SectionTitle label="Shop" right={detail.shopId && (
                  <Button size="sm" iconRight={<IconExternal size={11} />} onClick={() => gotoEntity('shops', String(detail.shopId))}>Open</Button>
                )} />
                <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
                  <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{detail.shop}</div>
                  {detail.shopAddress && <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:2 }}>{detail.shopAddress}</div>}
                  <div style={{ display:'flex', gap:10, fontSize:11, color:'var(--slate-500)', marginTop:4 }}>
                    {detail.shopPhone && <span className="mono">{detail.shopPhone}</span>}
                    {detail.shopEmail && <span>{detail.shopEmail}</span>}
                  </div>
                </div>
              </div>

              {/* Mechanic */}
              <div style={{ marginBottom:18 }}>
                <SectionTitle label="Mechanic assigned" />
                {detail.mechanic ? (
                  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px', display:'flex', alignItems:'center', gap:10 }}>
                    <Avatar name={detail.mechanic.name} size={32} />
                    <div>
                      <div style={{ fontSize:13, fontWeight:500 }}>{detail.mechanic.name}</div>
                      <div style={{ fontSize:11, color:'var(--slate-500)' }}>{detail.mechanic.title ?? '—'}</div>
                      {detail.mechanic.email && <div style={{ fontSize:11, color:'var(--slate-500)' }}>{detail.mechanic.email}</div>}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize:13, color:'var(--slate-400)', fontStyle:'italic' }}>No mechanic assigned.</div>
                )}
              </div>

              {/* Payment */}
              <div style={{ marginBottom:18 }}>
                <SectionTitle label="Payment" />
                <KV k="Total charged" v={<span className="mono" style={{ fontWeight:600 }}>${detail.total.toFixed(2)}</span>} />
                {detail.labor > 0 && <KV k="Labor" v={<span className="mono">${detail.labor.toFixed(2)}</span>} />}
                {detail.parts > 0 && <KV k="Parts" v={<span className="mono">${detail.parts.toFixed(2)}</span>} />}
                {detail.laborMinutesEstimate != null && <KV k="Est. labor (min)" v={<span className="mono">{detail.laborMinutesEstimate}</span>} />}
                {detail.payment?.stripePaymentIntentId && (
                  <KV k="Stripe payment" v={<span className="mono" style={{ fontSize:11, color:'var(--blue-700)' }}>{detail.payment.stripePaymentIntentId.slice(0, 18)}…</span>} />
                )}
                {detail.payment?.paymentMethod && <KV k="Method" v={detail.payment.paymentMethod} />}
                {detail.payment?.status && <KV k="Status" v={<Badge tone="slate" dot>{detail.payment.status}</Badge>} />}
                {detail.allPayments.length > 1 && (
                  <div style={{ marginTop:8, fontSize:11, color:'var(--slate-500)' }}>
                    {detail.allPayments.length} payment events on this booking
                  </div>
                )}
              </div>

              {/* Review */}
              <div style={{ marginBottom:18 }}>
                <SectionTitle label="User rating" />
                {detail.review ? (
                  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:4 }}>
                      {[1,2,3,4,5].map(i => <IconStar key={i} size={14} style={{ color:i <= detail.review!.rating ? '#F59E0B' : 'var(--slate-200)' }} />)}
                      <span style={{ marginLeft:6, fontSize:13, fontWeight:500 }}>{detail.review.rating.toFixed(1)}</span>
                    </div>
                    {detail.review.comment && (
                      <div style={{ fontSize:12, color:'var(--slate-600)', fontStyle:'italic' }}>"{detail.review.comment}"</div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize:13, color:'var(--slate-400)', fontStyle:'italic' }}>No review yet.</div>
                )}
              </div>

              {/* Vehicle quick-link */}
              {detail.vehicleId && (
                <div>
                  <SectionTitle label="Vehicle" right={
                    <Button size="sm" iconRight={<IconExternal size={11} />} onClick={() => gotoEntity('cars', String(detail.vehicleId))}>Open</Button>
                  } />
                  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'8px 12px', display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ width:32, height:32, borderRadius:6, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)' }}><IconCar size={16} /></span>
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:500 }}>{detail.vehicleYmm ?? detail.vin}</div>
                      <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{detail.vin}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Status history full list */}
          {detail.statusHistory.length > 0 && (
            <div style={{ padding:22, borderBottom:'1px solid var(--slate-200)' }}>
              <SectionTitle label={`Status history (${detail.statusHistory.length})`} />
              <div style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
                {detail.statusHistory.map((h, i: number) => (
                  <div key={i} style={{ padding:'8px 12px', borderBottom: i < detail.statusHistory.length - 1 ? '1px solid var(--slate-100)' : 'none', display:'grid', gridTemplateColumns:'140px 140px 1fr 1fr', gap:10, fontSize:12, color:'var(--slate-700)', alignItems:'center' }}>
                    <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{fmtTs(h.changedAt)}</span>
                    <Badge tone="slate" dot>{h.status}</Badge>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{h.changedBy ?? '—'}</span>
                    <span style={{ color:'var(--slate-500)', fontStyle: h.reason ? 'italic' : 'normal', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{h.reason ?? ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          <div style={{ padding:22, background:'var(--slate-25)' }}>
            {bookingId && <DirectorNotesPanel entityType="booking" entityId={bookingId} placeholder="Add an internal note about this booking…" />}
          </div>
        </>
      )}
    </Modal>
  )
}
