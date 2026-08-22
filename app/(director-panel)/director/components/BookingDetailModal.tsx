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
import { money, fmtDate, fmtDateTime } from './Charts'
import { DirectorNotesPanel } from './DirectorNotesPanel'
import { gotoEntity } from './directorNav'

/**
 * BookingDetailModal — drill-down used by TabBookings and ShopModal.
 *
 * Inner 4-tab strip (mirrors ops/bookings/[id]/page.tsx):
 *   • Overview          — the director booking detail (forms, specs, parties,
 *                         payment, review, status timeline + notes).
 *   • Completion report — opsBookings.completion (job_actuals, diagnostics,
 *                         recommendations, arrival→completion timestamps).
 *   • Money & approvals — opsBookings.moneyDetail (approval/capture state,
 *                         approval cycles, disputes, shop quote responses).
 *   • Audit timeline    — opsBookings.auditTimeline (merged lifecycle feed).
 */

type Props = {
  bookingId: Id<'bookings'> | null
  onClose:   () => void
}

const TABS = ['Overview', 'Completion report', 'Money & approvals', 'Audit timeline'] as const
type Tab = (typeof TABS)[number]

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

function fmtTs(ts?: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
}

function fmtDur(min: number | null | undefined): string {
  if (min == null) return '—'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// Inner-tab strip (matches ops/bookings/[id] underline tabs).
const InnerTabs = ({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) => (
  <div style={{ display:'flex', flexWrap:'wrap', gap:2, padding:'0 24px', borderBottom:'1px solid var(--slate-100)', background:'#fff' }}>
    {TABS.map(t => {
      const active = tab === t
      return (
        <button key={t} onClick={() => onChange(t)}
          style={{ marginBottom:-1, padding:'10px 12px', border:'none', borderBottom:`2px solid ${active ? 'var(--slate-900)' : 'transparent'}`,
            background:'transparent', cursor:'pointer', fontSize:13, fontWeight:500,
            color: active ? 'var(--slate-900)' : 'var(--slate-500)', fontFamily:'inherit' }}>
          {t}
        </button>
      )
    })}
  </div>
)

// Section card used inside the ops-detail tabs.
const TabCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:18, marginBottom:14 }}>
    <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)', marginBottom:12 }}>{title}</div>
    {children}
  </div>
)

const Field = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-400)', textTransform:'uppercase', letterSpacing:'0.04em' }}>{label}</div>
    <div style={{ marginTop:2, fontSize:13, color:'var(--slate-800)' }}>{value ?? '—'}</div>
  </div>
)

const Loading = ({ label }: { label: string }) => (
  <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>{label}</div>
)

export const BookingDetailModal = ({ bookingId, onClose }: Props) => {
  const session   = useContext(DirectorSessionCtx)
  const token     = session?.token ?? ''
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [auditOpen, setAuditOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('Overview')
  const logView = useMutation(api.director.logView)
  const detail  = useQuery(api.director.bookingDetail, bookingId ? { id: bookingId, token } : 'skip')

  // Reset to Overview each time a new booking is opened.
  useEffect(() => { setTab('Overview') }, [String(bookingId)])

  useEffect(() => {
    if (bookingId) logView({ entity_type: 'booking', entity_id: String(bookingId), actorName, actorId })
  }, [String(bookingId)])

  const rawAudit = useQuery(api.audit_log.listByEntity,
    bookingId ? { entity_type: 'booking', entity_id: bookingId, token } : 'skip')
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
        <Loading label="Loading…" />
      ) : (
        <>
          {/* Top strip — user/shop/scheduled */}
          <div style={{ padding:'10px 24px 14px', background:'#fff', display:'flex', flexWrap:'wrap', gap:14, fontSize:12, color:'var(--slate-600)', alignItems:'center', borderBottom:'1px solid var(--slate-100)' }}>
            <span><b style={{ color:'var(--slate-900)' }}>{detail.user}</b></span>
            <span>·</span>
            <span>{detail.shop}</span>
            {detail.scheduled !== '—' && <><span>·</span><span>{fmtDate(detail.scheduled)}{detail.time !== '—' ? ` at ${detail.time}` : ''}</span></>}
            {detail.vehicleYmm && <><span>·</span>
              <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                <IconCar size={13} style={{ color:'var(--slate-500)' }} />
                {detail.vehicleYmm}
              </span>
            </>}
            {detail.vin && <><span>·</span><span className="mono" style={{ fontSize:11 }}>{detail.vin}</span></>}
          </div>

          {/* Inner tab strip */}
          <InnerTabs tab={tab} onChange={setTab} />

          {tab === 'Overview' && <OverviewTab detail={detail} bookingId={bookingId} />}
          {tab === 'Completion report' && bookingId && <CompletionTab token={token} id={bookingId} />}
          {tab === 'Money & approvals' && bookingId && <MoneyApprovalsTab token={token} id={bookingId} />}
          {tab === 'Audit timeline' && bookingId && <AuditTimelineTab token={token} id={bookingId} />}
        </>
      )}
    </Modal>
  )
}

// ===========================================================================
// Overview tab — the original director booking detail (preserved verbatim).
// ===========================================================================
const OverviewTab = ({ detail, bookingId }: { detail: any; bookingId: Id<'bookings'> | null }) => (
  <>
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
              const catches = detail.services.filter((s: any) =>
                (s.quoteFlags ?? []).includes('fallback_catch'),
              ).length
              const corrected = detail.services.filter((s: any) =>
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
            {detail.services.map((s: any) => {
              const flags = s.quoteFlags ?? []
              const isCatch = flags.includes('fallback_catch')
              const isCorrected = flags.includes('engine_corrected_parts')
              const isRefused = flags.includes('fallback_only')
              const otherFlags = flags.filter(
                (f: string) =>
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
                      {otherFlags.map((f: string) => (
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
              {detail.selectedOptions.map((o: any, i: number) => (
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
                {detail.diagnosticChecklist.map((item: any, i: number) => (
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
          {detail.statusHistory.map((h: HistoryEntry, i: number) => (
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
)

// ===========================================================================
// Completion report tab — opsBookings.completion (job_actuals + diagnostics +
// arrival/completion + post-job recommendations).
// ===========================================================================
const CompletionTab = ({ token, id }: { token: string; id: Id<'bookings'> }) => {
  const data = useQuery(api.opsBookings.completion, { token, id })
  if (data === undefined) return <Loading label="Loading completion report…" />
  if (data === null) return <Loading label="Booking not found." />
  const ja = data.jobActual

  return (
    <div style={{ padding:22, background:'var(--slate-25)' }}>
      {/* Arrival → completion */}
      <TabCard title="Arrival → completion">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:14 }}>
          <Field label="Vehicle arrived" value={data.arrivedAtMs ? fmtTs(data.arrivedAtMs) : '—'} />
          <Field label="Job started" value={ja?.startedAt ? fmtTs(ja.startedAt) : '—'} />
          <Field label="Completed" value={(ja?.completedAtMs ?? data.completedAtMs) ? fmtTs(ja?.completedAtMs ?? data.completedAtMs) : '—'} />
          <Field label="Finalized" value={ja?.finalizedAtMs ? `${fmtTs(ja.finalizedAtMs)}${ja.finalizedBy ? ` · ${ja.finalizedBy}` : ''}` : '—'} />
        </div>
      </TabCard>

      {ja ? (
        <TabCard title="Job actuals">
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:14 }}>
            <Field label="Labor (actual vs est.)" value={
              <span>
                {fmtDur(ja.actualLaborMinutes)}
                {data.estimatedLaborMinutes != null && (
                  <span style={{ marginLeft:4, fontSize:11, color:'var(--slate-400)' }}>est {fmtDur(data.estimatedLaborMinutes)}</span>
                )}
              </span>
            } />
            <Field label="Parts (actual)" value={money(ja.actualPartsCost, { cents: true })} />
            <Field label="Difficulty" value={ja.difficultyRating != null ? `${ja.difficultyRating}/5` : '—'} />
            <Field label="Odometer in" value={ja.odometerIn != null ? `${ja.odometerIn.toLocaleString()} mi` : '—'} />
            <Field label="Odometer out" value={ja.completionMileage != null ? `${ja.completionMileage.toLocaleString()} mi` : '—'} />
            <Field label="Reports" value={
              <span style={{ display:'flex', gap:4 }}>
                <span style={{ borderRadius:4, padding:'2px 6px', fontSize:10, background: ja.hasPrejobReport ? 'var(--green-50)' : 'var(--slate-100)', color: ja.hasPrejobReport ? 'var(--green-700)' : 'var(--slate-400)' }}>pre-job</span>
                <span style={{ borderRadius:4, padding:'2px 6px', fontSize:10, background: ja.hasPostjobReport ? 'var(--green-50)' : 'var(--slate-100)', color: ja.hasPostjobReport ? 'var(--green-700)' : 'var(--slate-400)' }}>post-job</span>
              </span>
            } />
          </div>
          {/* Which parts, not just how much. The receipt has itemised this for
              the customer all along — the operator had less detail than the
              person who paid the bill. Each row names the work it went into,
              so an off-catalog part is traceable to its line. */}
          {ja.partsUsed && ja.partsUsed.length > 0 && (
            <div style={{ marginTop:14, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
              <div style={{ marginBottom:8, fontSize:10, fontWeight:600, color:'var(--slate-400)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                Parts used ({ja.partsUsed.filter((p: any) => !p.notUsed).length})
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {ja.partsUsed.map((p: any, i: number) => (
                  <div
                    key={i}
                    style={{
                      display:'flex', alignItems:'baseline', justifyContent:'space-between',
                      gap:12, fontSize:13,
                      opacity: p.notUsed ? 0.45 : 1,
                    }}
                  >
                    <span style={{ minWidth:0 }}>
                      <span style={{ fontWeight:600, textDecoration: p.notUsed ? 'line-through' : 'none' }}>
                        {p.partName}
                      </span>
                      {p.quantity > 1 && <span style={{ color:'var(--slate-500)' }}> ×{p.quantity}</span>}
                      {p.oemNumber && (
                        <span className="mono" style={{ marginLeft:6, fontSize:11, color:'var(--slate-500)' }}>
                          {p.oemNumber}
                        </span>
                      )}
                      <span style={{ display:'block', fontSize:11, color:'var(--slate-500)', marginTop:1 }}>
                        {p.forWork ?? 'Unattributed'}
                        {p.isCustom && (
                          <span style={{ marginLeft:6, borderRadius:3, border:'1px solid var(--amber-500, #B45309)', color:'var(--amber-700, #B45309)', padding:'0 4px', fontSize:9, fontWeight:700, letterSpacing:'0.04em', textTransform:'uppercase' }}>
                            custom
                          </span>
                        )}
                        {p.suppliedByCustomer && (
                          <span style={{ marginLeft:6, color:'var(--slate-400)' }}>customer-supplied</span>
                        )}
                        {p.notUsed && <span style={{ marginLeft:6 }}>not used</span>}
                      </span>
                    </span>
                    <span className="mono" style={{ whiteSpace:'nowrap' }}>
                      {money(p.lineCost, { cents: true })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(ja.mechanicFindings || ja.technicianNotes || ja.additionalObservations || ja.inProgressNotes) && (
            <div style={{ marginTop:14, display:'flex', flexDirection:'column', gap:10, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
              {ja.mechanicFindings && <Field label="Mechanic findings (customer-facing)" value={ja.mechanicFindings} />}
              {ja.technicianNotes && <Field label="Technician notes (internal)" value={ja.technicianNotes} />}
              {ja.additionalObservations && <Field label="Additional observations" value={ja.additionalObservations} />}
              {ja.inProgressNotes && <Field label="In-progress notes" value={ja.inProgressNotes} />}
            </div>
          )}
          {ja.inProgressPhotos.length > 0 && (
            <div style={{ marginTop:14, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
              <div style={{ marginBottom:8, fontSize:10, fontWeight:600, color:'var(--slate-400)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                In-progress photos ({ja.inProgressPhotos.length})
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                {ja.inProgressPhotos.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" title={p.caption ?? undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={p.caption ?? 'in-progress'} style={{ height:80, width:112, borderRadius:8, objectFit:'cover', border:'1px solid var(--slate-200)' }} />
                  </a>
                ))}
              </div>
            </div>
          )}
        </TabCard>
      ) : (
        <TabCard title="Job actuals">
          <div style={{ fontSize:12, color:'var(--slate-400)' }}>
            No job-actuals recorded yet — the completion report fills once the mechanic starts and finalizes the job.
          </div>
        </TabCard>
      )}

      {/* Diagnostics */}
      <TabCard title="Diagnostics">
        <div style={{ marginBottom:12, display:'flex', flexWrap:'wrap', gap:16 }}>
          <Field label="System" value={data.diagnosticSystem ?? '—'} />
          <Field label="Checklist completed" value={data.diagnosticChecklistCompletedAtMs ? fmtTs(data.diagnosticChecklistCompletedAtMs) : '—'} />
          {data.recommendationState && data.recommendationState !== 'none' && (
            <Field label="Recommendation" value={`${data.recommendedServiceName ?? 'service'} · ${data.recommendationState.replace(/_/g, ' ')}`} />
          )}
        </div>
        {data.diagnosticFindingsNote && <div style={{ marginBottom:12, fontSize:12, color:'var(--slate-600)' }}>{data.diagnosticFindingsNote}</div>}
        {data.diagnosticChecklist.length === 0 ? (
          <div style={{ fontSize:12, color:'var(--slate-400)' }}>No diagnostic checklist on this booking.</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            {data.diagnosticChecklist.map((c, i) => (
              <div key={i} style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, fontSize:12 }}>
                <span style={{ color:'var(--slate-700)' }}>
                  {c.label}
                  {c.mechanicNote && <span style={{ marginLeft:4, color:'var(--slate-400)' }}>— {c.mechanicNote}</span>}
                  {c.skipReason && <span style={{ marginLeft:4, color:'var(--slate-400)' }}>({c.skipReason.replace(/_/g, ' ')})</span>}
                </span>
                <Badge tone={checklistStatusTone(c.status)}>{c.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </TabCard>

      {/* Post-job recommendations */}
      {Array.isArray(data.recommendations) && data.recommendations.length > 0 && (
        <TabCard title={`Recommendations (${data.recommendations.length})`}>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {data.recommendations.map((r: {
              id: string; service: string | null; freeformText: string | null;
              urgency: string; status: string; reason: string | null;
              authorLabel: string | null; targetMileage: number | null;
              visibleToDriver: boolean; createdAt: number;
            }) => (
              <div key={r.id} style={{ borderRadius:8, border:'1px solid var(--slate-100)', padding:12 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-800)' }}>
                    {r.service ?? r.freeformText ?? 'Recommendation'}
                  </span>
                  <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <Badge tone={r.urgency === 'soon' ? 'red' : r.urgency === 'within_3_months' ? 'yellow' : 'slate'}>{r.urgency.replace(/_/g, ' ')}</Badge>
                    <Badge tone="slate">{r.status}</Badge>
                  </span>
                </div>
                {r.reason && <div style={{ marginTop:4, fontSize:12, color:'var(--slate-600)' }}>{r.reason}</div>}
                <div style={{ marginTop:4, fontSize:11, color:'var(--slate-400)' }}>
                  {fmtTs(r.createdAt)}
                  {r.authorLabel ? ` · ${r.authorLabel}` : ''}
                  {r.targetMileage != null ? ` · target ${r.targetMileage.toLocaleString()} mi` : ''}
                  {r.visibleToDriver ? ' · visible to driver' : ' · internal'}
                </div>
              </div>
            ))}
          </div>
        </TabCard>
      )}
    </div>
  )
}

// ===========================================================================
// Money & approvals tab — opsBookings.moneyDetail (approval/capture, cycles,
// disputes, shop quote responses).
// ===========================================================================
const MoneyApprovalsTab = ({ token, id }: { token: string; id: Id<'bookings'> }) => {
  const data = useQuery(api.opsBookings.moneyDetail, { token, id })
  if (data === undefined) return <Loading label="Loading money trail…" />
  if (data === null) return <Loading label="Booking not found." />

  return (
    <div style={{ padding:22, background:'var(--slate-25)' }}>
      {/* Capture reconciliation */}
      <TabCard title="Approval & capture state">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:14 }}>
          <Field label="Approval state" value={data.approvalState ? data.approvalState.replace(/_/g, ' ') : '—'} />
          <Field label="Running ceiling" value={money(data.runningApprovedCeiling, { cents: true })} />
          <Field label="Final total" value={money(data.finalTotal, { cents: true })} />
          <Field label="Final captured" value={money(data.finalCaptureAmount, { cents: true })} />
        </div>
        {data.finalTotal != null && data.finalCaptureAmount != null && data.finalCaptureAmount < data.finalTotal && (
          <div style={{ marginTop:12, borderRadius:8, background:'var(--yellow-50)', padding:'8px 12px', fontSize:12, color:'var(--yellow-800)' }}>
            Captured {money(data.finalCaptureAmount, { cents: true })} of a {money(data.finalTotal, { cents: true })} final total — {money(data.finalTotal - data.finalCaptureAmount, { cents: true })} not captured (deposit forfeit, partial capture, or refund).
          </div>
        )}
        {data.settlementState === 'awaiting_settlement' && (
          <div style={{ marginTop:12, borderRadius:8, background:'var(--yellow-50)', padding:'8px 12px', fontSize:12, color:'var(--yellow-800)' }}>
            Awaiting settlement — {money(data.settlementShortfall, { cents: true })} outstanding
            {data.settlementReason ? ` (${data.settlementReason.replace(/_/g, ' ')})` : ''}. The reconciliation cron is retrying capture{data.approvalState === 'reauth_required' ? ' once the customer re-authorizes' : ''}.
          </div>
        )}
        {(data.quoteFlags.length > 0 || data.lowConfidenceParts || data.serviceQuoteFlagCount > 0) && (
          <div style={{ marginTop:12, display:'flex', flexWrap:'wrap', gap:6, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
            {data.lowConfidenceParts && <Badge tone="yellow">low-confidence parts</Badge>}
            {data.serviceQuoteFlagCount > 0 && <Badge tone="yellow">{data.serviceQuoteFlagCount} service quote flags</Badge>}
            {data.quoteFlags.map((f: string) => (
              <Badge key={f} tone="slate">{f}</Badge>
            ))}
          </div>
        )}
      </TabCard>

      {/* Mechanic vs catalog quote */}
      {(data.mechanicQuotedPrice != null || data.catalogQuotedPrice != null) && (
        <TabCard title="Mechanic vs catalog quote">
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:14 }}>
            <Field label="Mechanic quote" value={data.mechanicQuotedPrice != null ? money(data.mechanicQuotedPrice, { cents: true }) : '—'} />
            <Field label="Catalog quote" value={data.catalogQuotedPrice != null ? money(data.catalogQuotedPrice, { cents: true }) : '—'} />
            <Field label="Mechanic est." value={fmtDur(data.mechanicEstimatedMinutes)} />
            <Field label="Catalog est." value={fmtDur(data.catalogEstimatedMinutes)} />
          </div>
        </TabCard>
      )}

      {/* Approval cycles */}
      <TabCard title={`Approval cycles (${data.approvals.length})`}>
        {data.approvals.length === 0 ? (
          <div style={{ fontSize:12, color:'var(--slate-400)' }}>
            No approval cycles — this booking hasn’t gone through mechanic-set-price approval.
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            {data.approvals.map((a, i: number) => (
              <div key={i} style={{ borderRadius:8, border:'1px solid var(--slate-100)', padding:12 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <span style={{ fontSize:13, fontWeight:600, color:'var(--slate-800)' }}>
                    {a.cycle.replace(/_/g, ' ')} · {money(a.mechanicSetPrice, { cents: true })}
                    {a.over && <Badge tone="red" style={{ marginLeft:6 }}>over ceiling</Badge>}
                  </span>
                  <Badge tone={
                    a.decision === 'approved' || a.decision === 'auto_approved_within_range' ? 'green'
                      : a.decision === 'declined' || a.decision === 'sla_expired' ? 'red'
                        : a.decision ? 'slate' : 'yellow'
                  }>
                    {a.decision ? a.decision.replace(/_/g, ' ') : 'open'}
                  </Badge>
                </div>
                <div style={{ marginTop:4, display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:6, fontSize:11, color:'var(--slate-500)' }}>
                  {a.parts != null && <span>Parts {money(a.parts, { cents: true })}</span>}
                  {a.labor != null && <span>Labor {money(a.labor, { cents: true })}</span>}
                  {a.tax != null && <span>Tax {money(a.tax, { cents: true })}</span>}
                  {a.serviceFee != null && <span>Fee {money(a.serviceFee, { cents: true })}</span>}
                </div>
                <div style={{ marginTop:6, fontSize:11, color:'var(--slate-400)' }}>
                  submitted {fmtTs(a.submittedAtMs)}{a.submittedBy ? ` by ${a.submittedBy}` : ''} · prior ceiling {money(a.priorCeiling, { cents: true })}
                  {a.decidedAtMs && ` · decided ${fmtTs(a.decidedAtMs)}${a.decidedBy ? ` by ${a.decidedBy}` : ''}`}
                  {a.ceilingAfter != null && ` · new ceiling ${money(a.ceilingAfter, { cents: true })}`}
                  {a.stripeAction && ` · ${a.stripeAction.replace(/_/g, ' ')}`}
                </div>
                {a.addedServices && a.addedServices.length > 0 && (
                  <div style={{ marginTop:4, fontSize:11, color:'var(--slate-500)' }}>
                    Added: {a.addedServices.join(', ')}
                  </div>
                )}
                {a.deniedParts && a.deniedParts.length > 0 && (
                  <div style={{ marginTop:4, borderRadius:6, background:'var(--red-50)', border:'1px solid #FECACA', padding:'6px 10px' }}>
                    <div style={{ fontSize:10, fontWeight:600, color:'var(--red-700)', textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:2 }}>
                      Denied parts — not charged
                    </div>
                    {a.deniedParts.map((p, pi: number) => (
                      <div key={pi} style={{ display:'flex', justifyContent:'space-between', gap:10, fontSize:12, color:'var(--slate-600)' }}>
                        <span>{p.quantity > 1 ? `${p.quantity} × ` : ''}{p.name}</span>
                        {p.lineCents != null && <span className="mono" style={{ textDecoration:'line-through' }}>{money(p.lineCents, { cents: true })}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {a.notes && <div style={{ marginTop:4, fontSize:12, color:'var(--slate-600)' }}>{a.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </TabCard>

      {/* Disputes */}
      {(data.bookingDisputes.length > 0 || data.paymentDisputes.length > 0) && (
        <TabCard title="Disputes & refunds">
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {data.bookingDisputes.map(d => (
              <div key={d.id} style={{ borderRadius:8, border:'1px solid #FECACA', background:'var(--red-50)', padding:12, fontSize:12 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <span style={{ fontWeight:500, color:'var(--slate-800)' }}>Customer dispute — {d.reason.replace(/_/g, ' ')}</span>
                  <Badge tone="red">{d.status.replace(/_/g, ' ')}</Badge>
                </div>
                {d.notes && <div style={{ marginTop:4, color:'var(--slate-600)' }}>{d.notes}</div>}
                <div style={{ marginTop:4, fontSize:11, color:'var(--slate-400)' }}>
                  filed {fmtTs(d.filedAtMs)}
                  {d.resolvedAtMs && ` · resolved ${fmtTs(d.resolvedAtMs)}`}
                  {d.resolution && ` · ${d.resolution.replace(/_/g, ' ')}`}
                  {d.resolutionRefund != null && ` · refund ${money(d.resolutionRefund, { cents: true })}`}
                </div>
              </div>
            ))}
            {data.paymentDisputes.map(d => (
              <div key={d.id} style={{ borderRadius:8, border:'1px solid #FECACA', background:'var(--red-50)', padding:12, fontSize:12 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <span style={{ fontWeight:500, color:'var(--slate-800)' }}>Stripe dispute {d.reason ? `— ${d.reason}` : ''}</span>
                  <Badge tone="red">{d.status}</Badge>
                </div>
                <div style={{ marginTop:4, fontSize:11, color:'var(--slate-400)' }}>
                  {money(d.amount, { cents: true })} · opened {fmtTs(d.openedAtMs)}
                  {d.closedAtMs && ` · closed ${fmtTs(d.closedAtMs)}`}
                  {d.evidenceDueByMs && ` · evidence due ${fmtTs(d.evidenceDueByMs)}`}
                </div>
              </div>
            ))}
          </div>
        </TabCard>
      )}

      {/* Shop quote responses (tire/rotor jobs) + dismissals */}
      {(data.tireQuotes.length > 0 || data.rotorQuotes.length > 0 || data.dismissals.length > 0) && (
        <TabCard title="Shop quote responses">
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {data.tireQuotes.map(q => (
              <div key={q.id} style={{ borderRadius:8, border:'1px solid var(--slate-100)', padding:12, fontSize:12, opacity: q.superseded ? 0.5 : 1 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <span style={{ fontWeight:500, color:'var(--slate-800)' }}>
                    🛞 {q.shop ?? 'Shop'} — {q.brand}{q.model ? ` ${q.model}` : ''} ×{q.quantity}
                  </span>
                  <span style={{ fontWeight:600, color:'var(--slate-800)' }}>{money(q.total, { cents: true })}</span>
                </div>
                <div style={{ marginTop:4, fontSize:11, color:'var(--slate-400)' }}>
                  {money(q.perUnit, { cents: true })}/tire · labor {money(q.labor, { cents: true })}
                  {q.availability && ` · avail ${q.availability}`}
                  {q.superseded && ' · superseded'}
                </div>
              </div>
            ))}
            {data.rotorQuotes.map(q => (
              <div key={q.id} style={{ borderRadius:8, border:'1px solid var(--slate-100)', padding:12, fontSize:12, opacity: q.superseded ? 0.5 : 1 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <span style={{ fontWeight:500, color:'var(--slate-800)' }}>
                    🛑 {q.shop ?? 'Shop'} — {q.brand}{q.model ? ` ${q.model}` : ''} ×{q.quantity}
                  </span>
                  <span style={{ fontWeight:600, color:'var(--slate-800)' }}>{money(q.total, { cents: true })}</span>
                </div>
                <div style={{ marginTop:4, fontSize:11, color:'var(--slate-400)' }}>
                  {money(q.perUnit, { cents: true })}/rotor · labor {money(q.labor, { cents: true })}
                  {q.padBrand && ` · pads ${q.padBrand}`}
                  {q.availability && ` · avail ${q.availability}`}
                  {q.superseded && ' · superseded'}
                </div>
              </div>
            ))}
            {data.dismissals.map(d => (
              <div key={d.id} style={{ fontSize:11, color:'var(--slate-400)' }}>
                {d.shop ?? 'Shop'} dismissed the {d.kind} quote request · {fmtTs(d.dismissedAtMs)}
              </div>
            ))}
          </div>
        </TabCard>
      )}
    </div>
  )
}

// ===========================================================================
// Audit timeline tab — opsBookings.auditTimeline (merged lifecycle feed).
// ===========================================================================
const AUDIT_KIND_TONE: Record<string, 'slate' | 'blue' | 'indigo' | 'purple' | 'green' | 'red' | 'yellow'> = {
  status: 'slate',
  estimate_submitted: 'blue',
  estimate_decision: 'indigo',
  part_edit: 'purple',
  labor_edit: 'purple',
  payment_status: 'green',
  dispute_filed: 'red',
  dispute_resolved: 'red',
  payment_dispute: 'red',
  audit: 'yellow',
}

const AuditTimelineTab = ({ token, id }: { token: string; id: Id<'bookings'> }) => {
  const data = useQuery(api.opsBookings.auditTimeline, { token, id })
  if (data === undefined) return <Loading label="Loading audit timeline…" />
  if (data === null) return <Loading label="Booking not found." />

  return (
    <div style={{ padding:22, background:'var(--slate-25)' }}>
      <TabCard title={`Audit timeline (${data.events.length} events)`}>
        {data.events.length === 0 ? (
          <div style={{ fontSize:12, color:'var(--slate-400)' }}>No lifecycle events recorded for this booking yet.</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            {data.events.map((e, i: number) => (
              <div key={i} style={{ display:'flex', gap:12 }}>
                <span style={{ marginTop:6, width:6, height:6, flexShrink:0, borderRadius:999, background:'var(--slate-300)' }} />
                <div style={{ minWidth:0, flex:1 }}>
                  <div style={{ display:'flex', flexWrap:'wrap', alignItems:'baseline', gap:8 }}>
                    <Badge tone={AUDIT_KIND_TONE[e.kind] ?? 'slate'}>{e.kind.replace(/_/g, ' ')}</Badge>
                    <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-800)' }}>{e.title}</span>
                    {e.actor && <span style={{ fontSize:11, color:'var(--slate-400)' }}>by {e.actor}</span>}
                  </div>
                  <div style={{ fontSize:11, color:'var(--slate-400)' }} title={fmtDateTime(e.at)}>{fmtTs(e.at)}</div>
                  {e.detail && <div style={{ marginTop:2, fontSize:12, color:'var(--slate-500)' }}>{e.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </TabCard>
    </div>
  )
}
