'use client'

import { useContext, useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { can } from '@/lib/portal/capabilities'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import {
  Card, Badge, Button, Input, MicroH, tableStyles, Modal, AuditButton, AuditLogCompact,
  IconChevron, IconShop, IconExternal, IconX, IconCheck,
} from '../../Primitives'
import { money } from '../../Charts'
import { gotoEntity } from '../../directorNav'
import { AdminActionPanel, ActionRow } from '../../AdminActionPanel'
import { DirectorNotesPanel } from '../../DirectorNotesPanel'
import { BookingDetailModal } from '../../BookingDetailModal'
import { HealthDot } from './shopsUi'
import type {
  Profile, HourRow, ServicesResult, RosterMechanic, CalendarResult, ShopBookingRow, ShopInsights,
  ShopComplianceResult,
} from './types'

const TABS = ['Profile', 'Hours', 'Services & Rate', 'Compliance', 'Mechanics', 'Calendar', 'Bookings', 'Insights'] as const

const LICENSE_LABELS: Record<string, string> = {
  dmv_inspection_station: 'NY DMV Inspection Station License',
}
const licenseLabel = (t: string) => LICENSE_LABELS[t] ?? t
const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
const LICENSE_TONE = { pending_review: 'yellow', verified: 'green', rejected: 'red' } as const
const LICENSE_STATUS_LABEL = { pending_review: 'Pending review', verified: 'Verified', rejected: 'Rejected' } as const
type Tab = (typeof TABS)[number]

// ── week helpers (ported from /shops/all/[id]) ──
function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7))
  return out
}
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function weekDates(monday: Date): string[] {
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return isoDate(d) })
}

const Field = ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => (
  <div>
    <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', color:'var(--slate-400)' }}>{label}</div>
    <div style={{ marginTop:2, fontSize:13, color:'var(--slate-800)' }}>{children}</div>
  </div>
)

// Reason-capture confirm (verify / activate), mirrors TabShops' dialog.
const ConfirmDialog = ({ action, onConfirm, onClose }: { action: string; onConfirm: (reason: string) => void; onClose: () => void }) => {
  const [reason, setReason] = useState('')
  const isDanger = action === 'Deactivate' || action === 'Remove Verification'
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(15,23,42,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:300 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'#fff', borderRadius:12, width:460, padding:22, boxShadow:'0 20px 50px rgba(15,23,42,0.25)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14 }}>
          <div>
            <div style={{ fontSize:16, fontWeight:600 }}>Confirm: {action}</div>
            <div style={{ fontSize:13, color:'var(--slate-500)', marginTop:4 }}>This action will be logged in the audit trail.</div>
          </div>
          <button onClick={onClose} style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-400)' }}><IconX size={18} /></button>
        </div>
        <label style={{ fontSize:12, fontWeight:500, color:'var(--slate-700)', display:'block', marginBottom:6 }}>Reason (required)</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Shop failed quality inspection"
          style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={isDanger ? 'danger' : 'primary'} onClick={() => { if (reason.trim()) { onConfirm(reason); onClose() } }}>Confirm {action}</Button>
        </div>
      </div>
    </div>
  )
}

export const ShopDetail = ({ shopId, onBack, onOpenMechanic }:
  { shopId: string; onBack: () => void; onOpenMechanic: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const actorName = session?.name ?? 'Director'
  const actorId = session?.userId as Id<'director_users'> | undefined
  const canWriteShops = can(session?.role, 'shops.write')
  const sid = shopId as Id<'shops'>

  const [tab, setTab] = useState<Tab>('Profile')
  const [auditOpen, setAuditOpen] = useState(false)
  const [drillBooking, setDrillBooking] = useState<Id<'bookings'> | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const profile = useQuery(api.shopsDirectory.shopProfile, { token, id: sid }) as Profile | undefined
  const hours = useQuery(api.shopsDirectory.shopHours, tab === 'Hours' ? { token, id: sid } : 'skip') as HourRow[] | undefined
  const servicesResult = useQuery(api.shopsDirectory.shopServicesList, tab === 'Services & Rate' ? { token, id: sid } : 'skip') as ServicesResult | undefined
  const mechanics = useQuery(api.shopsDirectory.shopMechanics, tab === 'Mechanics' ? { token, id: sid } : 'skip') as RosterMechanic[] | undefined
  const bookings = useQuery(api.shopsDirectory.shopBookings, tab === 'Bookings' ? { token, id: sid } : 'skip') as ShopBookingRow[] | undefined
  const insights = useQuery(api.shopsDirectory.shopInsights, tab === 'Insights' ? { token, id: sid } : 'skip') as ShopInsights | undefined
  const compliance = useQuery(api.shopsDirectory.shopLicenses, tab === 'Compliance' ? { token, id: sid } : 'skip') as ShopComplianceResult | undefined

  const [weekMonday, setWeekMonday] = useState(() => mondayOf(new Date()))
  const dates = useMemo(() => weekDates(weekMonday), [weekMonday])
  const calendar = useQuery(api.shopsDirectory.shopCalendarWeek, tab === 'Calendar' ? { token, id: sid, dates } : 'skip') as CalendarResult | undefined

  const rawAudit = useQuery(api.audit_log.listByEntity, { entity_type: 'shop', entity_id: shopId, token }) as any[] | undefined
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '', entity: '',
  }))

  const logView = useMutation(api.director.logView)
  const updateBasics = useMutation(api.directorShopActions.updateShopBasics)
  const setShopActive = useMutation(api.director.setShopActive)
  const setShopVerified = useMutation(api.director.setShopVerified)
  const setLaborRate = useMutation(api.shopsDirectory.setLaborRate)
  const reviewShopLicense = useMutation(api.shopsDirectory.reviewShopLicense)
  const createOnboardingLink = useAction(api.directorStripeLive.createOrResendOnboardingLink)

  useEffect(() => { logView({ entity_type: 'shop', entity_id: shopId, actorName, actorId }) }, [shopId])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t) }, [toast])

  // Editable basics (phone/email/website/address) — labor rate goes through the ceremony.
  const [editPhone, setEditPhone] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editWebsite, setEditWebsite] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!profile) return
    setEditPhone(profile.phone ?? ''); setEditEmail(profile.email ?? '')
    setEditWebsite(profile.website ?? ''); setEditAddress(profile.address ?? '')
  }, [profile?.id])

  const [confirmAction, setConfirmAction] = useState<string | null>(null)
  const [reviewTarget, setReviewTarget] = useState<{ id: string; status: 'verified' | 'rejected' } | null>(null)
  const [stripeLoading, setStripeLoading] = useState(false)

  // Rate ceremony
  const [rateOpen, setRateOpen] = useState(false)
  const [rateInput, setRateInput] = useState('')
  const [coSignName, setCoSignName] = useState('')
  const [rateReason, setRateReason] = useState('')
  const [rateError, setRateError] = useState('')

  const currentRate = servicesResult?.laborRate ?? profile?.laborRate ?? null
  const parsedRate = Number(rateInput)
  const rateValid = Number.isFinite(parsedRate) && parsedRate > 0
  const bigMove = rateValid && currentRate !== null && currentRate > 0 ? Math.abs(parsedRate - currentRate) / currentRate > 0.15 : false

  const handleSaveBasics = async () => {
    setSaving(true)
    try {
      const res = await updateBasics({ id: sid, phone: editPhone, email: editEmail, address: editAddress, website: editWebsite, actorName, actorId })
      setToast(res?.ok ? (res.changes > 0 ? `Saved ${res.changes} change${res.changes === 1 ? '' : 's'}.` : 'No changes.') : 'Save failed.')
    } catch (e) { setToast(e instanceof Error ? e.message : 'Save failed.') } finally { setSaving(false) }
  }

  const handleAction = async (action: string, reason: string) => {
    if (action === 'Deactivate') await setShopActive({ id: sid, active: false, reason, actorName, actorId })
    if (action === 'Reactivate') await setShopActive({ id: sid, active: true, reason, actorName, actorId })
    if (action === 'Mark Verified') await setShopVerified({ id: sid, verified: true, reason, actorName, actorId })
    if (action === 'Remove Verification') await setShopVerified({ id: sid, verified: false, reason, actorName, actorId })
    setToast(`${action} done — logged in audit.`)
  }

  const handleReviewLicense = async (reason: string) => {
    if (!reviewTarget) return
    try {
      await reviewShopLicense({ token, licenseId: reviewTarget.id as Id<'shop_licenses'>, status: reviewTarget.status, note: reason })
      setToast(`License ${reviewTarget.status} — logged in audit.`)
    } catch (e) { setToast(e instanceof Error ? e.message : 'Review failed.') }
  }

  const handleStripeOnboarding = async () => {
    if (!profile) return
    setStripeLoading(true)
    try {
      const res = await createOnboardingLink({ stripeAccountId: profile.stripeAccountId ?? undefined, shopName: profile.name, shopEmail: profile.email ?? undefined, baseUrl: window.location.origin })
      if (res.ok) { window.open(res.url, '_blank', 'noopener,noreferrer'); setToast(res.created ? 'Connected account created. Onboarding URL opened.' : 'Onboarding URL opened in new tab.') }
      else setToast(`Stripe error: ${res.error}`)
    } catch (e) { setToast(e instanceof Error ? e.message : 'Stripe link failed.') } finally { setStripeLoading(false) }
  }

  const openRateCeremony = () => {
    setRateError('')
    if (!rateValid) { setRateError('Enter a valid positive hourly rate.'); return }
    if (bigMove && coSignName.trim().length === 0) { setRateError('This move is more than ±15% — a co-signer name is required.'); return }
    setRateReason(''); setRateOpen(true)
  }
  const confirmRate = async () => {
    if (!rateReason.trim()) { setRateError('A reason is required.'); return }
    await setLaborRate({ token, reason: rateReason.trim(), shopId: sid, newRate: parsedRate, co_sign_name: bigMove ? coSignName.trim() : undefined })
    setRateOpen(false); setRateInput(''); setCoSignName(''); setToast('Labor rate changed — logged in audit.')
  }

  const back = (
    <button onClick={onBack} style={{ display:'inline-flex', alignItems:'center', gap:4, background:'none', border:'none', cursor:'pointer', fontSize:13, color:'var(--slate-500)', padding:0, fontFamily:'inherit' }}>
      <IconChevron size={14} style={{ transform:'rotate(180deg)' }} /> Shops Directory
    </button>
  )

  if (profile === undefined) return <div>{back}<div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading shop…</div></div>
  if (profile === null) return <div>{back}<Card style={{ marginTop:12 }}><div style={{ color:'var(--slate-500)', fontSize:14 }}>This shop no longer exists.</div></Card></div>

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {back}

      {/* Header card */}
      <Card style={{ display:'flex', flexWrap:'wrap', alignItems:'flex-start', justifyContent:'space-between', gap:16 }}>
        <div style={{ display:'flex', gap:14, minWidth:0 }}>
          <span style={{ width:48, height:48, borderRadius:10, background:'#fff', border:'1px solid var(--slate-200)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--blue-600)', flexShrink:0, overflow:'hidden' }}>
            {profile.logo ? <img src={profile.logo} alt="" style={{ width:48, height:48, objectFit:'cover' }} /> : <IconShop size={24} />}
          </span>
          <div style={{ minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
              <HealthDot health={profile.health} failingChecks={profile.failingChecks} />
              <h1 style={{ margin:0, fontSize:20, fontWeight:600, color:'var(--slate-900)' }}>{profile.name}</h1>
              {!profile.isActive && <Badge tone="red">inactive</Badge>}
              {profile.isVerified && <Badge tone="green">verified</Badge>}
            </div>
            <div style={{ marginTop:4, fontSize:13, color:'var(--slate-500)' }}>
              {[profile.address, profile.city, profile.state, profile.zip].filter(Boolean).join(', ') || 'No address on file'}
            </div>
            {profile.health === 'amber' && <div style={{ marginTop:4, fontSize:12, color:'var(--amber-700, #B45309)' }}>{profile.failingChecks.join(' · ')}</div>}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:18 }}>
          {[
            [profile.laborRate !== null ? `$${profile.laborRate}` : '—', '$/hr'],
            [profile.rating !== null ? profile.rating.toFixed(1) : '—', `rating (${profile.reviewCount})`],
            [String(profile.mechanicCount), 'mechanics'],
          ].map(([v, l]) => (
            <div key={l} style={{ textAlign:'right' }}>
              <div style={{ fontSize:22, fontWeight:700, color:'var(--slate-900)' }} className="mono">{v}</div>
              <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>{l}</div>
            </div>
          ))}
          <AuditButton onClick={() => setAuditOpen(true)} count={auditEntries?.length} />
        </div>
      </Card>

      {/* Tab strip */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:2, borderBottom:'1px solid var(--slate-200)' }}>
        {TABS.map(t => {
          const active = tab === t
          return (
            <button key={t} onClick={() => setTab(t)}
              style={{ marginBottom:-1, background:'none', border:'none', borderBottom:`2px solid ${active ? 'var(--blue-600)' : 'transparent'}`, padding:'8px 12px', fontSize:13, fontWeight:500, cursor:'pointer', color: active ? 'var(--blue-700)' : 'var(--slate-500)', fontFamily:'inherit' }}>
              {t}
            </button>
          )
        })}
      </div>

      {/* ── Profile ── */}
      {tab === 'Profile' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <Card>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'14px 32px' }}>
              <Field label="Name">{profile.name}</Field>
              <Field label="Slug">{profile.slug ?? '—'}</Field>
              <Field label="City / State / ZIP">{[profile.city, profile.state, profile.zip].filter(Boolean).join(', ') || '—'}</Field>
              <Field label="Phone">{profile.phone ? <a href={`tel:${profile.phone}`} style={{ color:'var(--blue-600)', textDecoration:'none' }}>{profile.phone}</a> : '—'}</Field>
              <Field label="Email">{profile.email ? <a href={`mailto:${profile.email}`} style={{ color:'var(--blue-600)', textDecoration:'none' }}>{profile.email}</a> : '—'}</Field>
              <Field label="Owner">{profile.owner ? <a onClick={() => gotoEntity('users', profile.owner!.id)} style={{ color:'var(--blue-600)', cursor:'pointer' }}>{profile.owner.name}</a> : '—'}</Field>
              <Field label="Website">{profile.website ? <a href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`} target="_blank" rel="noopener noreferrer" style={{ color:'var(--blue-600)', textDecoration:'none' }}>{profile.website}</a> : '—'}</Field>
              <Field label="Timezone">{profile.timezone ?? '—'}</Field>
              <Field label="Coordinates">{profile.lat != null && profile.lng != null
                ? <a href={`https://www.openstreetmap.org/?mlat=${profile.lat}&mlon=${profile.lng}#map=16/${profile.lat}/${profile.lng}`} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize:12, color:'var(--blue-600)', textDecoration:'none' }}>{profile.lat.toFixed(5)}, {profile.lng.toFixed(5)}</a>
                : <span style={{ color:'var(--amber-600, #D97706)' }} title="Missing from the network map">not geocoded</span>}</Field>
              <Field label="Labor rate">{profile.laborRate !== null ? `$${profile.laborRate}/hr` : '—'}</Field>
              <Field label="Active">{profile.isActive ? 'Yes' : 'No'}</Field>
              <Field label="Verified">{profile.isVerified ? 'Yes' : 'No'}</Field>
              <Field label="Stripe">{profile.stripeAccountId ? `${profile.stripeAccountId} · charges ${profile.stripeChargesEnabled ? '✓' : '✗'} · payouts ${profile.stripePayoutsEnabled ? '✓' : '✗'}` : 'Not connected'}</Field>
              <Field label="Onboarding">{profile.onboardingComplete ? <span style={{ color:'var(--green-700)' }}>Complete</span> : <span style={{ color:'var(--amber-700, #B45309)' }}>Incomplete</span>}</Field>
              <Field label="Requirements due">{profile.stripeRequirementsDue.length > 0 ? <span style={{ color:'var(--amber-700, #B45309)' }}>{profile.stripeRequirementsDue.join(', ')}</span> : 'None'}</Field>
              <Field label="Rates updated">{profile.laborRatesUpdatedAt ? new Date(profile.laborRatesUpdatedAt).toLocaleDateString() : '—'}</Field>
              <Field label="Created">{new Date(profile.createdAt).toLocaleDateString()}</Field>
            </div>

            {profile.description && (
              <div style={{ marginTop:16, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
                <MicroH>Description</MicroH>
                <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--slate-700)' }}>{profile.description}</p>
              </div>
            )}

            {(profile.laborRatesByTier || profile.declinedTiers.length > 0) && (
              <div style={{ marginTop:16, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
                <MicroH>Labor rates by tier</MicroH>
                <div style={{ marginTop:8, display:'flex', flexWrap:'wrap', gap:8 }}>
                  {(['T1','T2a','T2b','T2c','T3a','T3b','T4'] as const).map(t => {
                    const declined = profile.declinedTiers.includes(t)
                    const rate = profile.laborRatesByTier?.[t]
                    return (
                      <span key={t} style={{ display:'inline-flex', alignItems:'center', gap:5, borderRadius:8, padding:'4px 8px', fontSize:12,
                        border:`1px solid ${declined ? '#FECACA' : 'var(--slate-200)'}`, background: declined ? 'var(--red-50)' : 'var(--slate-50)', color: declined ? 'var(--red-600)' : 'var(--slate-700)' }}>
                        <b>{t}</b><span>{declined ? 'declined' : rate != null ? `$${rate}/hr` : '—'}</span>
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ marginTop:16, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
              <MicroH>Scheduling configuration</MicroH>
              <div style={{ marginTop:8, display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:'8px 24px' }}>
                {([
                  ['Buffer', profile.scheduling.bufferMinutes != null ? `${profile.scheduling.bufferMinutes} min` : '—'],
                  ['No-show after', profile.scheduling.noShowThresholdMinutes != null ? `${profile.scheduling.noShowThresholdMinutes} min` : '—'],
                  ['Max/mech/hr', profile.scheduling.maxBookingsPerMechanicRollingHour ?? '—'],
                  ['Reminder lead', profile.scheduling.appointmentReminderLeadMinutes != null ? `${profile.scheduling.appointmentReminderLeadMinutes} min` : '—'],
                  ['Overrun ext %', profile.scheduling.overrunDefaultExtensionPercent != null ? `${profile.scheduling.overrunDefaultExtensionPercent}%` : '—'],
                  ['Overrun floor', profile.scheduling.overrunExtensionFloorMinutes != null ? `${profile.scheduling.overrunExtensionFloorMinutes} min` : '—'],
                  ['Overrun escalate', profile.scheduling.overrunEscalationMinutes != null ? `${profile.scheduling.overrunEscalationMinutes} min` : '—'],
                  ['Entity labels', profile.scheduling.entityLabelMode ?? '—'],
                ] as [string, React.ReactNode][]).map(([l, v]) => (
                  <div key={l}><div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:'0.04em', color:'var(--slate-400)' }}>{l}</div><div style={{ fontSize:12, color:'var(--slate-700)' }}>{v}</div></div>
                ))}
              </div>
            </div>
          </Card>

          {/* Editable basics */}
          <Card>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
              <MicroH>Editable details</MicroH>
              <Button variant="primary" size="sm" onClick={handleSaveBasics} disabled={saving || !canWriteShops}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:12 }}>
              <div><div style={{ fontSize:11, color:'var(--slate-500)', marginBottom:4 }}>Phone</div><Input value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="555-0100" /></div>
              <div><div style={{ fontSize:11, color:'var(--slate-500)', marginBottom:4 }}>Email</div><Input value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="shop@example.com" /></div>
              <div><div style={{ fontSize:11, color:'var(--slate-500)', marginBottom:4 }}>Website</div><Input value={editWebsite} onChange={e => setEditWebsite(e.target.value)} placeholder="https://…" /></div>
              <div><div style={{ fontSize:11, color:'var(--slate-500)', marginBottom:4 }}>Address</div><Input value={editAddress} onChange={e => setEditAddress(e.target.value)} placeholder="123 Main St" /></div>
            </div>
            {!canWriteShops && <div style={{ marginTop:8, fontSize:12, color:'var(--slate-400)' }}>Your role cannot edit shops (requires shops.write).</div>}
          </Card>

          {/* Admin controls */}
          <Card style={{ background:'var(--slate-25)' }}>
            <AdminActionPanel title="Admin controls" subtitle="Every action is logged with reason + actor.">
              <ActionRow label={profile.stripeAccountId ? 'Stripe Connect' : 'Stripe Connect onboarding'}
                hint={profile.stripeAccountId ? `Connected · ${profile.stripeAccountId.slice(0, 16)}…` : 'Generate a one-time onboarding URL'}
                action={profile.stripeAccountId
                  ? <a href={`https://dashboard.stripe.com/connect/accounts/${profile.stripeAccountId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}><Button size="sm" iconRight={<IconExternal size={11} />}>Open</Button></a>
                  : <Button size="sm" variant="primary" onClick={handleStripeOnboarding} disabled={stripeLoading || !canWriteShops}>{stripeLoading ? 'Generating…' : 'Generate link'}</Button>} />
              <ActionRow label={profile.isVerified ? 'Remove verification' : 'Mark as verified'}
                hint={profile.isVerified ? 'Currently verified' : 'Customer-visible trust badge'}
                action={profile.isVerified
                  ? <Button size="sm" onClick={() => setConfirmAction('Remove Verification')} disabled={!canWriteShops}>Remove</Button>
                  : <Button size="sm" variant="primary" onClick={() => setConfirmAction('Mark Verified')} disabled={!canWriteShops}>Verify</Button>} />
              <ActionRow label={profile.isActive ? 'Deactivate shop' : 'Reactivate shop'}
                hint={profile.isActive ? 'Hides shop from marketplace, blocks new bookings' : 'Currently deactivated'} danger={profile.isActive}
                action={profile.isActive
                  ? <Button size="sm" variant="danger" onClick={() => setConfirmAction('Deactivate')} disabled={!canWriteShops}>Deactivate</Button>
                  : <Button size="sm" variant="primary" onClick={() => setConfirmAction('Reactivate')} disabled={!canWriteShops}>Reactivate</Button>} />
              <ActionRow label="Open shop CRM" hint="Live shop-side dashboard for this shop"
                action={<a href={`/dashboard?shop=${shopId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}><Button size="sm" iconRight={<IconExternal size={11} />}>Open</Button></a>} />
            </AdminActionPanel>
          </Card>

          {/* Notes */}
          <Card style={{ background:'var(--slate-25)' }}>
            <DirectorNotesPanel entityType="shop" entityId={shopId} placeholder="Add an internal note about this shop…" />
          </Card>
        </div>
      )}

      {/* ── Hours ── */}
      {tab === 'Hours' && (
        <Card>
          {hours === undefined ? <div style={{ color:'var(--slate-400)', fontSize:13 }}>Loading hours…</div>
            : hours.length === 0 ? <div style={{ padding:'20px 0', textAlign:'center', fontSize:13, color:'var(--slate-500)' }}>No hours configured — this shop cannot generate slots until its week is set.</div>
            : (
              <>
                <table style={tableStyles.table}>
                  <thead><tr><th style={tableStyles.th}>Day</th><th style={tableStyles.th}>Open</th><th style={tableStyles.th}>Close</th><th style={tableStyles.th}>Status</th></tr></thead>
                  <tbody>
                    {hours.map(h => (
                      <tr key={h.id}>
                        <td style={{ ...tableStyles.td, fontWeight:500, color:'var(--slate-800)' }}>{h.dayName}</td>
                        <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{h.isClosed ? '—' : h.openTime ?? '—'}</td>
                        <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{h.isClosed ? '—' : h.closeTime ?? '—'}</td>
                        <td style={tableStyles.td}><Badge tone={h.isClosed ? 'slate' : 'green'}>{h.isClosed ? 'Closed' : 'Open'}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {hours.length < 7 && <div style={{ marginTop:12, borderRadius:8, background:'var(--amber-50, #FFFBEB)', padding:'8px 12px', fontSize:12, fontWeight:500, color:'var(--amber-700, #B45309)' }}>Only {hours.length}/7 days configured — missing days block slot generation.</div>}
              </>
            )}
        </Card>
      )}

      {/* ── Services & Rate ── */}
      {tab === 'Services & Rate' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <Card>
            <div style={{ display:'flex', flexWrap:'wrap', alignItems:'flex-end', justifyContent:'space-between', gap:16 }}>
              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:500 }}>Current labor rate</div>
                <div style={{ fontSize:22, fontWeight:700, color:'var(--slate-900)' }}>{currentRate != null ? `$${currentRate}/hr` : 'Not set'}</div>
                <div style={{ marginTop:4, fontSize:12, color:'var(--slate-500)' }}>Moves greater than ±15% require a co-signer, recorded in the audit log.</div>
              </div>
              {canWriteShops && (
                <div style={{ display:'flex', flexWrap:'wrap', alignItems:'flex-end', gap:10 }}>
                  <div>
                    <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', color:'var(--slate-400)', marginBottom:4 }}>New rate ($/hr)</div>
                    <Input value={rateInput} onChange={e => setRateInput(e.target.value)} type="number" placeholder={currentRate != null ? String(currentRate) : 'e.g. 120'} style={{ width:130 }} />
                  </div>
                  {bigMove && (
                    <div>
                      <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', color:'var(--amber-600, #D97706)', marginBottom:4 }}>Co-signer (required, ±15%+)</div>
                      <Input value={coSignName} onChange={e => setCoSignName(e.target.value)} placeholder="Second approver" style={{ width:180 }} />
                    </div>
                  )}
                  <Button variant="primary" onClick={openRateCeremony}>Change rate</Button>
                </div>
              )}
            </div>
            {rateError && !rateOpen && <div style={{ marginTop:8, fontSize:13, fontWeight:500, color:'var(--red-600)' }}>{rateError}</div>}
            {!canWriteShops && <div style={{ marginTop:8, fontSize:12, color:'var(--slate-400)' }}>Your role cannot change rates (requires shops.write).</div>}
          </Card>

          <Card>
            {servicesResult === undefined ? <div style={{ color:'var(--slate-400)', fontSize:13 }}>Loading services…</div>
              : servicesResult === null || servicesResult.services.length === 0 ? <div style={{ padding:'20px 0', textAlign:'center', fontSize:13, color:'var(--slate-500)' }}>No services configured for this shop yet.</div>
              : (
                <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
                  {Array.from(new Set(servicesResult.services.map(s => s.category))).map(cat => (
                    <div key={cat}>
                      <MicroH style={{ marginBottom:6 }}>{cat}</MicroH>
                      <table style={{ width:'100%', fontSize:13 }}>
                        <tbody>
                          {servicesResult.services.filter(s => s.category === cat).map(s => (
                            <tr key={s.id} style={{ borderBottom:'1px solid var(--slate-50)', verticalAlign:'top' }}>
                              <td style={{ padding:'8px 12px 8px 0' }}>
                                <div style={{ fontWeight:500, color:'var(--slate-800)' }}>{s.name}</div>
                                {s.description && <div style={{ marginTop:2, maxWidth:420, fontSize:12, color:'var(--slate-400)' }}>{s.description}</div>}
                                <div style={{ marginTop:4, display:'flex', flexWrap:'wrap', gap:4 }}>
                                  {s.isLaborOnly && <Badge tone="slate">labor-only</Badge>}
                                  {s.requiresParts && <Badge tone="blue">needs parts</Badge>}
                                  {s.hasOptions && <Badge tone="purple">has options</Badge>}
                                  {s.partsKind && <Badge tone="slate">{s.partsKind}</Badge>}
                                  {s.minModelYear != null && <Badge tone="slate">{s.minModelYear}+</Badge>}
                                  {s.laborDeterminant && <Badge tone="slate">{s.laborDeterminant}</Badge>}
                                </div>
                              </td>
                              <td style={{ padding:'8px 12px' }}><Badge tone={s.isOffered ? 'green' : 'slate'}>{s.isOffered ? 'Offered' : 'Not offered'}</Badge></td>
                              <td style={{ padding:'8px 0', fontSize:12, color:'var(--slate-500)' }}>{s.defaultLaborHours !== null && currentRate != null ? `≈ $${Math.round(s.defaultLaborHours * currentRate)} labor (${s.defaultLaborHours}h)` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                  <div style={{ fontSize:11, fontWeight:600, color:'var(--red-600)' }}>INTERNAL ONLY — pricing construction is never exported.</div>
                </div>
              )}
          </Card>
        </div>
      )}

      {/* ── Compliance (licenses & certificates) ── */}
      {tab === 'Compliance' && (
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          {compliance === undefined ? (
            <Card><div style={{ color:'var(--slate-500)', fontSize:13 }}>Loading…</div></Card>
          ) : (
            <>
              {compliance.offersInspectionServices &&
                !compliance.licenses.some(l => l.licenseType === 'dmv_inspection_station' && l.reviewStatus === 'verified') && (
                <div style={{ display:'flex', gap:10, alignItems:'flex-start', padding:'12px 14px', borderRadius:10, border:'1px solid #FDE68A', background:'var(--yellow-50, #FEFCE8)', color:'var(--yellow-800, #854D0E)', fontSize:13 }}>
                  <span style={{ fontSize:15, lineHeight:1 }}>⚠</span>
                  <div>This shop offers <strong>State Inspection / Emissions Test</strong> but has no <strong>verified</strong> NY DMV inspection station license on file.</div>
                </div>
              )}

              <Card>
                <MicroH>Licenses &amp; certificates</MicroH>
                {compliance.licenses.length === 0 ? (
                  <div style={{ color:'var(--slate-500)', fontSize:13, marginTop:10 }}>No documents uploaded yet.</div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:12, marginTop:12 }}>
                    {compliance.licenses.map(lic => (
                      <div key={lic._id} style={{ border:'1px solid var(--slate-200)', borderRadius:10, padding:14, display:'flex', flexDirection:'column', gap:12 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
                          <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                            <div style={{ fontSize:14, fontWeight:600, color:'var(--slate-800)' }}>{licenseLabel(lic.licenseType)}</div>
                            <div style={{ fontSize:12.5 }}>
                              {lic.url
                                ? <a href={lic.url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--blue-600)', textDecoration:'none' }}>{lic.originalFilename ?? 'View document'} <IconExternal size={11} /></a>
                                : <span style={{ color:'var(--slate-500)' }}>{lic.originalFilename ?? 'Document'}</span>}
                            </div>
                          </div>
                          <Badge tone={LICENSE_TONE[lic.reviewStatus]}>{LICENSE_STATUS_LABEL[lic.reviewStatus]}</Badge>
                        </div>

                        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'10px 24px' }}>
                          <Field label="License #">{lic.licenseNumber ?? '—'}</Field>
                          <Field label="Expires">{fmtDate(lic.expiresAt)}</Field>
                          <Field label="Uploaded">{fmtDate(lic.createdAt)}</Field>
                          {lic.reviewStatus !== 'pending_review' && <Field label="Reviewed by">{lic.reviewedBy ?? '—'}</Field>}
                          {lic.reviewNote && <Field label="Review note">{lic.reviewNote}</Field>}
                        </div>

                        <div style={{ display:'flex', gap:8 }}>
                          <Button size="sm" variant="primary" disabled={!canWriteShops || lic.reviewStatus === 'verified'} onClick={() => setReviewTarget({ id: lic._id, status: 'verified' })}>Verify</Button>
                          <Button size="sm" variant="danger" disabled={!canWriteShops || lic.reviewStatus === 'rejected'} onClick={() => setReviewTarget({ id: lic._id, status: 'rejected' })}>Reject</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      )}

      {/* ── Mechanics ── */}
      {tab === 'Mechanics' && (
        <div>
          {mechanics === undefined ? <Card><div style={{ color:'var(--slate-400)', fontSize:13 }}>Loading mechanics…</div></Card>
            : mechanics.length === 0 ? <Card><div style={{ padding:'20px 0', textAlign:'center', fontSize:13, color:'var(--slate-500)' }}>No mechanics on this shop's roster yet.</div></Card>
            : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:14 }}>
                {mechanics.map(m => (
                  <Card key={m.id}>
                    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                      <span style={{ width:48, height:48, borderRadius:999, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:600, color:'var(--slate-500)', overflow:'hidden', flexShrink:0 }}>
                        {m.photo ? <img src={m.photo} alt="" style={{ width:48, height:48, objectFit:'cover' }} /> : m.name.split(' ').map(p => p[0]).slice(0, 2).join('')}
                      </span>
                      <div style={{ minWidth:0 }}>
                        <a onClick={() => onOpenMechanic(m.id)} style={{ fontSize:15, fontWeight:600, color:'var(--slate-900)', cursor:'pointer' }}>{m.name}</a>
                        <div style={{ fontSize:12, color:'var(--slate-500)' }}>{m.title ?? profile.name}</div>
                      </div>
                    </div>
                    <div style={{ marginTop:12, display:'flex', alignItems:'center', gap:10, fontSize:12, color:'var(--slate-600)' }}>
                      <span>{m.rating !== null ? `★ ${m.rating.toFixed(1)} (${m.reviewCount})` : 'No reviews yet'}</span>
                      <Badge tone={m.isActive ? 'green' : 'slate'}>{m.isActive ? 'Active' : 'Inactive'}</Badge>
                    </div>
                    {m.email && <div style={{ marginTop:6, fontSize:12, color:'var(--slate-400)' }}>{m.email}</div>}
                    <a onClick={() => onOpenMechanic(m.id)} style={{ marginTop:8, display:'inline-block', fontSize:12, fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>Open mechanic →</a>
                  </Card>
                ))}
              </div>
            )}
        </div>
      )}

      {/* ── Calendar ── */}
      {tab === 'Calendar' && (
        <Card>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:10 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <Button size="sm" onClick={() => setWeekMonday(m => { const d = new Date(m); d.setDate(d.getDate() - 7); return d })}>‹</Button>
              <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-700)' }}>Week of {dates[0]} – {dates[6]}</span>
              <Button size="sm" onClick={() => setWeekMonday(m => { const d = new Date(m); d.setDate(d.getDate() + 7); return d })}>›</Button>
              <Button size="sm" onClick={() => setWeekMonday(mondayOf(new Date()))}>Today</Button>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:12, fontSize:11, color:'var(--slate-500)' }}>
              <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}><span style={{ width:10, height:10, borderRadius:3, background:'var(--green-100, #D1FAE5)', boxShadow:'inset 0 0 0 1px #6EE7B7' }} /> available</span>
              <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}><span style={{ width:10, height:10, borderRadius:3, background:'#fff', boxShadow:'inset 0 0 0 1px var(--slate-300)' }} /> booked</span>
              <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}><span style={{ width:10, height:10, borderRadius:3, background:'var(--amber-100, #FEF3C7)', boxShadow:'inset 0 0 0 1px #FCD34D' }} /> blocked</span>
            </div>
          </div>
          <div style={{ fontSize:11, color:'var(--slate-400)', marginBottom:12 }}>Availability is derived live from shop hours minus bookings and blocks — open windows are computed, not pre-generated.</div>
          {calendar === undefined ? <div style={{ color:'var(--slate-400)', fontSize:13 }}>Loading calendar…</div>
            : calendar.mechanics.length === 0 ? <div style={{ padding:'20px 0', textAlign:'center', fontSize:13, color:'var(--slate-500)' }}>No mechanics — no bays to schedule. Add a mechanic first.</div>
            : (
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', fontSize:13, borderCollapse:'collapse' }}>
                  <thead><tr style={{ textAlign:'left' }}>
                    <th style={{ ...tableStyles.th, background:'transparent' }}>Day</th>
                    {calendar.mechanics.map(m => <th key={m.id} style={{ ...tableStyles.th, background:'transparent' }}>{m.name}{!m.isActive && <span style={{ marginLeft:4, color:'var(--slate-300)', fontWeight:400 }}>(inactive)</span>}</th>)}
                  </tr></thead>
                  <tbody>
                    {dates.map(date => (
                      <tr key={date} style={{ borderBottom:'1px solid var(--slate-50)', verticalAlign:'top' }}>
                        <td style={{ padding:'10px 16px 10px 0', fontWeight:500, color:'var(--slate-700)', whiteSpace:'nowrap' }}>{new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday:'short', month:'numeric', day:'numeric' })}</td>
                        {calendar.mechanics.map(m => {
                          const cellSlots = calendar.slots.filter(s => s.date === date && s.mechanicId === m.id).sort((a, b) => a.start.localeCompare(b.start))
                          return (
                            <td key={m.id} style={{ padding:'8px 16px 8px 0' }}>
                              {cellSlots.length === 0 ? <span style={{ fontSize:11, color:'var(--slate-300)' }}>no slots</span>
                                : <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                                  {cellSlots.map(s => (
                                    <span key={s.id} title={`${s.start}–${s.end}${s.title ? ` · ${s.title}` : ''}${s.note ? ` · ${s.note}` : ''}`}
                                      style={{ display:'inline-flex', borderRadius:4, padding:'2px 6px', fontSize:11, fontWeight:500,
                                        background: s.state === 'available' ? 'var(--green-50)' : s.state === 'blocked' ? 'var(--amber-50, #FFFBEB)' : '#fff',
                                        color: s.state === 'available' ? 'var(--green-700)' : s.state === 'blocked' ? 'var(--amber-700, #B45309)' : 'var(--slate-600)',
                                        boxShadow: `inset 0 0 0 1px ${s.state === 'available' ? '#A7F3D0' : s.state === 'blocked' ? '#FCD34D' : 'var(--slate-200)'}` }}>
                                      {s.state === 'available' ? `${s.start}–${s.end}` : `${s.start} ${s.note ?? s.title ?? ''}`.trim()}
                                    </span>
                                  ))}
                                </div>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
      )}

      {/* ── Bookings ── */}
      {tab === 'Bookings' && (
        <Card padded={false}>
          {bookings === undefined ? <div style={{ padding:24, color:'var(--slate-400)', fontSize:13 }}>Loading bookings…</div>
            : bookings.length === 0 ? <div style={{ padding:'20px 0', textAlign:'center', fontSize:13, color:'var(--slate-500)' }}>No bookings for this shop yet.</div>
            : (
              <>
                <table style={tableStyles.table}>
                  <thead><tr>
                    <th style={tableStyles.th}>Booking</th><th style={tableStyles.th}>Customer</th><th style={tableStyles.th}>Vehicle</th>
                    <th style={tableStyles.th}>Services</th><th style={tableStyles.th}>Scheduled</th><th style={tableStyles.th}>Labor est→act</th>
                    <th style={tableStyles.th}>Status</th><th style={{ ...tableStyles.th, textAlign:'right' }}>Total</th>
                  </tr></thead>
                  <tbody>
                    {bookings.map(b => {
                      const variance = b.estLaborMinutes != null && b.actualDurationMinutes != null && b.estLaborMinutes > 0 ? (b.actualDurationMinutes - b.estLaborMinutes) / b.estLaborMinutes : null
                      return (
                        <tr key={b.id} style={{ verticalAlign:'top' }}>
                          <td style={tableStyles.td}>
                            <span onClick={() => setDrillBooking(b.id as Id<'bookings'>)} className="mono" style={{ display:'inline-flex', padding:'1px 8px', borderRadius:999, background:'var(--blue-50)', color:'var(--blue-700)', fontSize:11, fontWeight:600, cursor:'pointer' }}>…{b.id.slice(-6)}</span>
                            {b.invoiceNumber && <div className="mono" style={{ marginTop:2, fontSize:10, color:'var(--slate-400)' }}>#{b.invoiceNumber}</div>}
                            {b.rescheduled && <div style={{ marginTop:2, fontSize:10, color:'var(--amber-600, #D97706)' }}>rescheduled</div>}
                          </td>
                          <td style={{ ...tableStyles.td, color:'var(--slate-800)' }}><a onClick={() => gotoEntity('users', b.user_id)} style={{ cursor:'pointer' }}>{b.user}</a></td>
                          <td style={{ ...tableStyles.td, fontSize:12, color:'var(--slate-600)' }}>{b.vehicle ?? '—'}</td>
                          <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>
                            <div>{b.services.join(', ') || '—'}</div>
                            {b.customerNotes && <div title={b.customerNotes} style={{ marginTop:2, maxWidth:256, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', fontSize:11, fontStyle:'italic', color:'var(--slate-400)' }}>“{b.customerNotes}”</div>}
                            {b.recommendationState && b.recommendationState !== 'none' && <Badge tone="purple" style={{ marginTop:2 }}>upsell: {b.recommendationState}</Badge>}
                          </td>
                          <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.date ?? '—'}{b.time ? ` ${b.time}` : ''}</td>
                          <td style={{ ...tableStyles.td, fontSize:12, color:'var(--slate-600)' }}>
                            {b.estLaborMinutes != null || b.actualDurationMinutes != null
                              ? <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                                  <span>{b.estLaborMinutes ?? '—'} → {b.actualDurationMinutes ?? '—'}</span>
                                  {variance != null && <Badge tone={Math.abs(variance) <= 0.1 ? 'green' : Math.abs(variance) <= 0.25 ? 'yellow' : 'red'}>{variance > 0 ? '+' : ''}{Math.round(variance * 100)}%</Badge>}
                                </span>
                              : '—'}
                          </td>
                          <td style={tableStyles.td}><Badge tone={b.status === 'completed' ? 'green' : ['cancelled','no_show'].includes(b.status) ? 'red' : ['pending','pending_quote','quotes_ready'].includes(b.status) ? 'yellow' : 'slate'}>{b.status}</Badge></td>
                          <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-700)' }}>
                            {b.total !== null ? money(b.total, { cents: true }) : '—'}
                            {(b.laborCost != null || b.partsCost != null) && <div style={{ fontSize:10, color:'var(--slate-400)' }}>{b.laborCost != null ? `L $${b.laborCost.toFixed(0)}` : ''}{b.laborCost != null && b.partsCost != null ? ' · ' : ''}{b.partsCost != null ? `P $${b.partsCost.toFixed(0)}` : ''}</div>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div style={{ padding:'8px 16px', fontSize:11, color:'var(--slate-400)' }}>Showing the 50 most recent. Booking chips open the full booking detail.</div>
              </>
            )}
        </Card>
      )}

      {/* ── Insights ── */}
      {tab === 'Insights' && (
        insights === undefined ? <div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading insights…</div>
        : (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
              {[
                ['Completed', String(insights.stats.completed), `of ${insights.stats.total}`],
                ['Cancellation rate', insights.stats.cancelRate != null ? `${Math.round(insights.stats.cancelRate * 100)}%` : '—', `${insights.stats.cancelled} cancelled`],
                ['No-show rate', insights.stats.noShowRate != null ? `${Math.round(insights.stats.noShowRate * 100)}%` : '—', `${insights.stats.noShow} no-shows`],
                ['Stripe disputes', String(insights.stats.disputeCount), ''],
              ].map(([l, v, sub]) => (
                <Card key={l}><div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:500 }}>{l}</div><div style={{ fontSize:18, fontWeight:700, color:'var(--slate-900)', marginTop:2 }}>{v}</div>{sub && <div style={{ fontSize:11, color:'var(--slate-400)' }}>{sub}</div>}</Card>
              ))}
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <Card>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>Labor-estimate accuracy</div>
                <div style={{ marginTop:2, fontSize:11, color:'var(--slate-400)' }}>Estimated vs actual labor; flagged = off by &gt;25%.</div>
                <div style={{ marginTop:12, display:'flex', gap:28 }}>
                  <div><div style={{ fontSize:18, fontWeight:700, color:'var(--slate-900)' }}>{insights.laborQa.avgVariancePct != null ? `${insights.laborQa.avgVariancePct > 0 ? '+' : ''}${Math.round(insights.laborQa.avgVariancePct * 100)}%` : '—'}</div><div style={{ fontSize:11, color:'var(--slate-400)' }}>avg variance</div></div>
                  <div><div style={{ fontSize:18, fontWeight:700, color:'var(--slate-900)' }}>{insights.laborQa.flagged}</div><div style={{ fontSize:11, color:'var(--slate-400)' }}>flagged jobs</div></div>
                  <div><div style={{ fontSize:18, fontWeight:700, color:'var(--slate-900)' }}>{insights.laborQa.sampled}</div><div style={{ fontSize:11, color:'var(--slate-400)' }}>sampled</div></div>
                </div>
              </Card>
              <Card>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>Disputes ({insights.disputes.length})</div>
                {insights.disputes.length === 0 ? <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-400)' }}>No payment disputes on record.</p>
                  : <div style={{ marginTop:12, maxHeight:288, overflow:'auto', display:'flex', flexDirection:'column', gap:8 }}>
                    {insights.disputes.map(d => (
                      <div key={d.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12 }}>
                        <Badge tone={d.closedAt != null ? 'slate' : 'red'}>{d.status}</Badge>
                        <span style={{ fontWeight:600, color:'var(--slate-800)' }}>{money(d.amount, { cents: true })}</span>
                        {d.reason && <span style={{ color:'var(--slate-500)' }}>{d.reason}</span>}
                        {d.booking_id && <span onClick={() => setDrillBooking(d.booking_id as Id<'bookings'>)} style={{ color:'var(--blue-600)', cursor:'pointer' }}>booking →</span>}
                        <span style={{ marginLeft:'auto', fontSize:11, color:'var(--slate-400)' }}>{new Date(d.openedAt).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>}
              </Card>
            </div>

            {insights.portfolio.length > 0 && (
              <Card>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>Portfolio ({insights.portfolio.length})</div>
                <div style={{ marginTop:12, display:'flex', flexWrap:'wrap', gap:8 }}>
                  {insights.portfolio.map(p => (
                    <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" title={p.caption ?? undefined}>
                      <img src={p.url} alt={p.caption ?? 'portfolio'} style={{ height:96, width:128, objectFit:'cover', borderRadius:8, boxShadow:'inset 0 0 0 1px var(--slate-200)' }} />
                    </a>
                  ))}
                </div>
              </Card>
            )}

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <Card>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>Reviews ({insights.reviews.length})</div>
                {insights.reviews.length === 0 ? <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-400)' }}>No reviews for this shop yet.</p>
                  : <div style={{ marginTop:12, maxHeight:384, overflow:'auto', display:'flex', flexDirection:'column', gap:8 }}>
                    {insights.reviews.map(r => (
                      <div key={r.id} style={{ borderBottom:'1px solid var(--slate-50)', paddingBottom:8, opacity: r.hidden ? 0.5 : 1 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <span style={{ color:'#F59E0B' }}>{'★'.repeat(Math.round(r.rating))}</span>
                          {r.reviewer && <a onClick={() => gotoEntity('users', r.reviewer_id)} style={{ fontSize:12, fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>{r.reviewer}</a>}
                          {r.mechanic && <span style={{ fontSize:11, color:'var(--slate-400)' }}>· {r.mechanic}</span>}
                          {r.hidden && <Badge tone="slate">hidden</Badge>}
                          <span style={{ marginLeft:'auto', fontSize:11, color:'var(--slate-400)' }}>{new Date(r.at).toLocaleDateString()}</span>
                        </div>
                        {(r.vehicle.ymm || r.service_names.length > 0) && (
                          <div style={{ marginTop:2, display:'flex', flexWrap:'wrap', alignItems:'center', gap:6, fontSize:11, color:'var(--slate-500)' }}>
                            {r.vehicle.ymm && <span>{r.vehicle.ymm}</span>}
                            {r.service_names.length > 0 && <span style={{ color:'var(--slate-400)' }}>· {r.service_names.join(', ')}</span>}
                            <span onClick={() => setDrillBooking(r.booking_id as Id<'bookings'>)} style={{ color:'var(--blue-600)', cursor:'pointer' }}>booking →</span>
                          </div>
                        )}
                        {r.comment && <p style={{ margin:'4px 0 0', fontSize:12, color:'var(--slate-600)' }}>{r.comment}</p>}
                      </div>
                    ))}
                  </div>}
              </Card>

              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                <Card>
                  <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>Labor-rate history</div>
                  {insights.rateHistory.length === 0 ? <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-400)' }}>No rate changes recorded.</p>
                    : <ol style={{ margin:'12px 0 0', padding:0, listStyle:'none', display:'flex', flexDirection:'column', gap:8 }}>
                      {insights.rateHistory.map((h, i) => (
                        <li key={i} style={{ fontSize:12 }}>
                          <div style={{ color:'var(--slate-700)' }}>{h.detail ?? 'rate changed'}</div>
                          <div style={{ fontSize:11, color:'var(--slate-400)' }}>{new Date(h.at).toLocaleString()} · {h.actor}</div>
                        </li>
                      ))}
                    </ol>}
                </Card>
                <Card>
                  <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>Fixed-price overrides</div>
                  {insights.fixedPrices.length === 0 ? <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-400)' }}>No per-service flat prices set.</p>
                    : <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:4 }}>
                      {insights.fixedPrices.map((f, i) => (
                        <div key={i} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:12 }}>
                          <span style={{ color:'var(--slate-700)' }}>{f.service} <span style={{ color:'var(--slate-400)' }}>· {f.tier}</span></span>
                          <span style={{ fontWeight:600, color:'var(--slate-800)' }}>{money(f.price, { cents: true })}</span>
                        </div>
                      ))}
                    </div>}
                </Card>
              </div>
            </div>
          </div>
        )
      )}

      {/* Rate ceremony */}
      <Modal open={rateOpen} onClose={() => setRateOpen(false)} width={520} title="Change labor rate"
        footer={<><Button onClick={() => setRateOpen(false)}>Cancel</Button><Button variant="primary" onClick={confirmRate}>Confirm change</Button></>}>
        <div style={{ padding:22 }}>
          <div style={{ fontSize:13, color:'var(--slate-700)', marginBottom:14 }}>
            {profile.name}: labor rate <b>{currentRate != null ? `$${currentRate}/hr` : 'unset'}</b> → <b>${rateInput}/hr</b>
            {bigMove && <> — a &gt;±15% move, co-signed by <b>{coSignName.trim()}</b>.</>}
          </div>
          <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Reason (required)</label>
          <textarea value={rateReason} onChange={e => setRateReason(e.target.value)} placeholder="Why is this rate changing?"
            style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
          {rateError && <div style={{ marginTop:8, fontSize:13, fontWeight:500, color:'var(--red-600)' }}>{rateError}</div>}
        </div>
      </Modal>

      {/* Confirm verify/activate */}
      {confirmAction && <ConfirmDialog action={confirmAction} onConfirm={reason => handleAction(confirmAction, reason)} onClose={() => setConfirmAction(null)} />}

      {/* Confirm license verify/reject */}
      {reviewTarget && <ConfirmDialog action={reviewTarget.status === 'verified' ? 'Verify License' : 'Reject License'} onConfirm={reason => handleReviewLicense(reason)} onClose={() => setReviewTarget(null)} />}

      {/* Booking drill */}
      <BookingDetailModal bookingId={drillBooking} onClose={() => setDrillBooking(null)} />

      {/* Audit drawer (right slide-over) */}
      {auditOpen && (
        <div onClick={() => setAuditOpen(false)} style={{ position:'fixed', inset:0, background:'rgba(15,23,42,0.4)', zIndex:200, display:'flex', justifyContent:'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width:440, height:'100%', background:'#fff', boxShadow:'-12px 0 40px rgba(15,23,42,0.25)', display:'flex', flexDirection:'column' }}>
            <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--slate-200)', background:'var(--slate-25)', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
              <div>
                <div style={{ fontSize:10, fontWeight:600, color:'var(--blue-600)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:4 }}>System of record</div>
                <div style={{ fontSize:15, fontWeight:600, color:'var(--slate-900)' }}>Shop audit log</div>
                <div style={{ fontSize:12, color:'var(--slate-500)', marginTop:2 }}>{profile.name}</div>
              </div>
              <button onClick={() => setAuditOpen(false)} style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-500)' }}><IconX size={18} /></button>
            </div>
            <div style={{ flex:1, overflowY:'auto', padding:18 }}><AuditLogCompact entries={auditEntries} /></div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position:'fixed', bottom:24, right:24, zIndex:400, background:'var(--slate-900)', color:'#fff', padding:'10px 14px', borderRadius:8, fontSize:13, fontWeight:500, boxShadow:'0 10px 30px rgba(15,23,42,0.25)', display:'flex', alignItems:'center', gap:8 }}>
          <IconCheck size={14} />{toast}
        </div>
      )}
    </div>
  )
}
