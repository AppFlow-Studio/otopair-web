'use client'

import { useState, useEffect, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Badge, Button, Card, Input, Select, Toggle, StatusBadge, Modal, AuditButton, Avatar, tableStyles, IconShop, IconSearch, IconExternal, IconCheck, IconStripe, IconX } from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto } from '../directorNav'
import { BookingDetailModal } from '../BookingDetailModal'
import { AdminActionPanel, ActionRow } from '../AdminActionPanel'
import { useAction } from 'convex/react'

type ShopRow = {
  id: Id<'shops'>
  name: string
  city: string
  status: string
  stripe: boolean
  stripeAccountId?: string
  stripePayoutsEnabled: boolean
  mechanics: number
  bookings7d: number
  rating?: number
  reviewCount?: number
  address?: string
  phone?: string
  email?: string
  website?: string
  isVerified?: boolean
  laborRate?: number
}

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
        <textarea value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. Shop failed quality inspection on Apr 28"
          style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={isDanger ? 'danger' : 'primary'} onClick={() => { if (reason.trim()) { onConfirm(reason); onClose() } }}>
            Confirm {action}
          </Button>
        </div>
      </div>
    </div>
  )
}

const roleLabel = (role: string) => ({
  shop_owner: 'Owner', owner: 'Owner', shop_mechanic: 'Mechanic', mechanic: 'Mechanic', manager: 'Manager',
}[role] ?? role)

const ShopModal = ({ shopId, onClose }: { shopId: Id<'shops'> | null; onClose: () => void }) => {
  const session = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [auditOpen, setAuditOpen]       = useState(false)
  const [confirmAction, setConfirmAction] = useState<string | null>(null)
  const [drillBookingId, setDrillBookingId] = useState<Id<'bookings'> | null>(null)
  // Editable fields. Always rendered; "Save changes" submits whatever's dirty.
  const [editPhone, setEditPhone]       = useState('')
  const [editEmail, setEditEmail]       = useState('')
  const [editAddress, setEditAddress]   = useState('')
  const [editWebsite, setEditWebsite]   = useState('')
  const [editLaborRate, setEditLaborRate] = useState<string>('')
  const [saving, setSaving]             = useState(false)
  const [toast,  setToast]              = useState<string | null>(null)
  const [stripeLinkLoading, setStripeLinkLoading] = useState(false)
  const detail   = useQuery(api.director.shopDetail, shopId ? { id: shopId } : 'skip')
  const logView  = useMutation(api.director.logView)
  const updateBasics = useMutation(api.directorShopActions.updateShopBasics)
  const createOnboardingLink = useAction(api.directorStripeLive.createOrResendOnboardingLink)

  const handleStripeOnboarding = async () => {
    if (!shopId || !detail) return
    setStripeLinkLoading(true)
    try {
      const res = await createOnboardingLink({
        stripeAccountId: detail.stripeAccountId ?? undefined,
        shopName:        detail.name,
        shopEmail:       detail.email ?? undefined,
        baseUrl:         window.location.origin,
      })
      if (res.ok) {
        // Auto-open the onboarding URL + show toast.
        window.open(res.url, '_blank', 'noopener,noreferrer')
        setToast(res.created
          ? `Connected account created (${res.accountId.slice(0, 16)}…). Onboarding URL opened.`
          : 'Onboarding URL opened in new tab.')
      } else {
        setToast(`Stripe error: ${res.error}`)
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Stripe link failed.')
    } finally {
      setStripeLinkLoading(false)
    }
  }

  useEffect(() => {
    if (shopId) logView({ entity_type: 'shop', entity_id: String(shopId), actorName, actorId })
  }, [String(shopId)])

  // Seed edit fields whenever detail arrives or shopId changes.
  useEffect(() => {
    if (!detail) return
    setEditPhone(detail.phone ?? '')
    setEditEmail(detail.email ?? '')
    setEditAddress(detail.address ?? '')
    setEditWebsite(detail.website ?? '')
    setEditLaborRate(detail.laborRate != null ? String(detail.laborRate) : '')
  }, [detail?.id, detail?.phone, detail?.email, detail?.address, detail?.website, detail?.laborRate])

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const rawAudit = useQuery(api.audit_log.listByEntity, shopId ? { entity_type: 'shop', entity_id: shopId, token: session?.token ?? '' } : 'skip')
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))
  const setShopActive   = useMutation(api.director.setShopActive)
  const setShopVerified = useMutation(api.director.setShopVerified)

  const handleAction = async (action: string, reason: string) => {
    if (!shopId) return
    if (action === 'Deactivate')           await setShopActive({ id: shopId, active: false, reason, actorName, actorId })
    if (action === 'Reactivate')           await setShopActive({ id: shopId, active: true,  reason, actorName, actorId })
    if (action === 'Mark Verified')        await setShopVerified({ id: shopId, verified: true,  reason, actorName, actorId })
    if (action === 'Remove Verification')  await setShopVerified({ id: shopId, verified: false, reason, actorName, actorId })
  }

  const handleSaveChanges = async () => {
    if (!shopId) return
    setSaving(true)
    try {
      const laborRateNum = editLaborRate.trim() === '' ? undefined : Number(editLaborRate)
      const res = await updateBasics({
        id: shopId,
        phone:   editPhone,
        email:   editEmail,
        address: editAddress,
        website: editWebsite,
        labor_rate: laborRateNum != null && !Number.isNaN(laborRateNum) ? laborRateNum : undefined,
        actorName,
        actorId,
      })
      setToast(res?.ok ? (res.changes > 0 ? `Saved ${res.changes} change${res.changes === 1 ? '' : 's'}.` : 'No changes.') : 'Save failed.')
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={!!shopId} onClose={onClose} width={920}
      eyebrow={detail && <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{String(detail.id).slice(-8)}</span>}
      statusBadge={detail && <StatusBadge status={detail.status} />}
      title={detail?.name ?? ''}
      headerRight={<>
        <AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />
        {detail?.stripeAccountId && (
          <a href={`https://dashboard.stripe.com/connect/accounts/${detail.stripeAccountId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
            <Button iconRight={<IconExternal size={13} />}>Open in Stripe</Button>
          </a>
        )}
        <a href={`/dashboard?shop=${shopId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
          <Button variant="primary" iconRight={<IconExternal size={13} />}>Open Shop CRM</Button>
        </a>
      </>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Shop audit log', subtitle:detail ? `${String(detail.id).slice(-8)} · ${detail.name}` : '', entries:auditEntries }}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={handleSaveChanges} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </>}>
      {!detail ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <>
          <div style={{ padding:'12px 24px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', alignItems:'center', gap:14 }}>
            <span style={{ width:44, height:44, borderRadius:8, background:'#fff', border:'1px solid var(--slate-200)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--blue-600)' }}>
              <IconShop size={22} />
            </span>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, color:'var(--slate-500)', display:'flex', gap:14, alignItems:'center', flexWrap:'wrap' }}>
                <span>{detail.city}</span>
                {detail.members.length > 0 && <><span>·</span><span><b className="mono" style={{ color:'var(--slate-800)' }}>{detail.members.length}</b> members</span></>}
                <span>·</span><span><b className="mono" style={{ color:'var(--slate-800)' }}>{detail.bookings7d}</b> bookings (7d)</span>
              </div>
              <div style={{ fontSize:12, color:'var(--slate-500)', marginTop:4, display:'flex', gap:14, alignItems:'center' }}>
                {detail.isVerified
                  ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, color:'var(--green-700)', fontWeight:500 }}><IconCheck size={13} />Verified</span>
                  : <Badge tone="yellow">Unverified</Badge>}
                {detail.stripe
                  ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, color:'var(--green-700)', fontWeight:500 }}><IconCheck size={13} />Stripe connected</span>
                  : <span style={{ color:'var(--slate-500)' }}>Stripe not connected</span>}
              </div>
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
            <div style={{ padding:18, borderRight:'1px solid var(--slate-100)', borderBottom:'1px solid var(--slate-100)' }}>
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>
                Team ({detail.members.length})
              </div>
              {detail.members.length === 0
                ? <div style={{ fontSize:13, color:'var(--slate-400)' }}>No members yet.</div>
                : detail.members.map((m, i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0' }}>
                    <Avatar name={m.name} size={28} />
                    <div>
                      <div style={{ fontSize:13, fontWeight:500 }}>{m.name}</div>
                      <div style={{ fontSize:12, color:'var(--slate-500)' }}>{roleLabel(m.role)}</div>
                    </div>
                  </div>
                ))
              }
            </div>

            <div style={{ padding:18, borderBottom:'1px solid var(--slate-100)' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
                  Recent bookings ({detail.recentBookings.length} of {detail.totalBookings ?? detail.recentBookings.length})
                </div>
                <div style={{ fontSize:11, color:'var(--slate-500)' }}>
                  Click row → full booking detail
                </div>
              </div>
              {detail.recentBookings.length === 0
                ? <div style={{ fontSize:13, color:'var(--slate-400)' }}>No bookings yet.</div>
                : (
                  <div style={{ maxHeight:280, overflowY:'auto' }}>
                    <table style={{ width:'100%', fontSize:12 }}>
                      <tbody>
                        {detail.recentBookings.map((b: any) => (
                          <tr key={b.id} onClick={() => setDrillBookingId(b.id)}
                            style={{ borderBottom:'1px solid var(--slate-100)', cursor:'pointer' }}
                            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)'}
                            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                            <td style={{ padding:'8px 4px', whiteSpace:'nowrap' }}>
                              <span className="mono" style={{ color:'var(--blue-700)' }}>{String(b.id).slice(-8)}</span>
                            </td>
                            <td style={{ padding:'8px 4px', color:'var(--slate-600)', whiteSpace:'nowrap' }}>{b.date}</td>
                            <td style={{ padding:'8px 4px', color:'var(--slate-600)', maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.user}</td>
                            <td style={{ padding:'8px 4px', color:'var(--slate-500)', fontSize:11, maxWidth:140, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {(b.services ?? []).join(', ') || '—'}
                            </td>
                            <td style={{ padding:'8px 4px' }}><StatusBadge status={b.status} /></td>
                            <td style={{ padding:'8px 4px', textAlign:'right' }} className="mono">${(b.total ?? 0).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </div>

            <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Stripe Connect</div>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                <span style={{ width:32, height:32, borderRadius:6, background:'#635BFF', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'#fff' }}><IconStripe size={16} /></span>
                <div>
                  <div style={{ fontSize:13, fontWeight:500 }}>{detail.stripe ? 'Connected' : 'Not connected'}</div>
                  {detail.stripeAccountId && <div style={{ fontSize:12, color:'var(--slate-500)' }}>{detail.stripeAccountId.slice(0, 16)}…</div>}
                </div>
              </div>
              {[
                ['Payouts enabled', detail.stripePayoutsEnabled ? 'Yes' : 'No'],
                ['Charges enabled', detail.stripe ? 'Yes' : 'No'],
              ].map(([l, v]) => (
                <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:12 }}>
                  <span style={{ color:'var(--slate-500)' }}>{l}</span>
                  <span style={{ fontWeight:500, color: v === 'Yes' ? 'var(--green-700)' : 'var(--slate-500)' }}>{v}</span>
                </div>
              ))}
            </div>

            <div style={{ padding:18 }}>
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>
                Details <span style={{ fontSize:10, fontWeight:500, color:'var(--slate-400)' }}>· editable · click Save changes</span>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8, fontSize:12 }}>
                <ShopField label="Phone">
                  <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="555-0100" />
                </ShopField>
                <ShopField label="Email">
                  <Input value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="shop@example.com" />
                </ShopField>
                <ShopField label="Website">
                  <Input value={editWebsite} onChange={e => setEditWebsite(e.target.value)} placeholder="https://…" />
                </ShopField>
                <ShopField label="Address">
                  <Input value={editAddress} onChange={e => setEditAddress(e.target.value)} placeholder="123 Main St" />
                </ShopField>
                <ShopField label="Labor rate ($/hr)">
                  <Input value={editLaborRate} onChange={e => setEditLaborRate(e.target.value)} placeholder="125" type="number" />
                </ShopField>
                <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', gap:8 }}>
                  <span style={{ color:'var(--slate-500)' }}>Rating</span>
                  <span style={{ fontWeight:500 }}>{detail.rating ? `${detail.rating.toFixed(1)} ★ (${detail.reviewCount ?? 0} reviews)` : '—'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Performance & service breakdown */}
          {(detail.totalBookings ?? 0) > 0 && (
            <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--slate-200)' }}>
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>
                Performance
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10, marginBottom:18 }}>
                <Stat label="Total bookings" value={String(detail.totalBookings ?? 0)} />
                <Stat label="7-day"          value={String(detail.bookings7d ?? 0)} />
                <Stat label="30-day"         value={String(detail.bookings30d ?? 0)} />
                <Stat label="Total revenue"  value={`$${(detail.totalRevenue ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                <Stat label="Avg ticket"     value={
                  (detail.totalBookings ?? 0) > 0
                    ? `$${((detail.totalRevenue ?? 0) / (detail.totalBookings ?? 1)).toFixed(0)}`
                    : '—'
                } />
              </div>

              {detail.statusMix && Object.keys(detail.statusMix).length > 0 && (
                <div style={{ marginBottom:18 }}>
                  <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>Status mix</div>
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                    {Object.entries(detail.statusMix).map(([status, count]) => (
                      <span key={status} style={{ display:'inline-flex', alignItems:'center', gap:6, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:999, padding:'3px 10px', fontSize:12 }}>
                        <StatusBadge status={status} />
                        <span className="mono" style={{ color:'var(--slate-700)', fontWeight:500 }}>{Number(count)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {detail.serviceBreakdown && detail.serviceBreakdown.length > 0 && (
                <div>
                  <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }}>
                    Services provided ({detail.serviceBreakdown.length})
                  </div>
                  <div style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 100px 100px 110px 130px', padding:'8px 12px', background:'var(--slate-25)', borderBottom:'1px solid var(--slate-200)', fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                      <span>Service</span>
                      <span style={{ textAlign:'right' }}>Booked</span>
                      <span style={{ textAlign:'right' }}>Completed</span>
                      <span style={{ textAlign:'right' }}>Revenue</span>
                      <span style={{ textAlign:'right' }}>Last performed</span>
                    </div>
                    <div style={{ maxHeight:260, overflowY:'auto' }}>
                      {detail.serviceBreakdown.map((row: any, i: number) => (
                        <div key={String(row.serviceId)} style={{
                          display:'grid', gridTemplateColumns:'1fr 100px 100px 110px 130px',
                          padding:'8px 12px',
                          borderBottom: i < (detail.serviceBreakdown?.length ?? 0) - 1 ? '1px solid var(--slate-100)' : 'none',
                          fontSize:12, color:'var(--slate-700)', alignItems:'center',
                        }}>
                          <span style={{ fontWeight:500, color:'var(--slate-900)' }}>{row.name}</span>
                          <span className="mono" style={{ textAlign:'right' }}>{row.count}</span>
                          <span className="mono" style={{ textAlign:'right', color: row.completedCount === row.count ? 'var(--green-700)' : 'var(--slate-700)' }}>{row.completedCount}</span>
                          <span className="mono" style={{ textAlign:'right' }}>${row.totalRevenue.toFixed(0)}</span>
                          <span style={{ textAlign:'right', fontSize:11, color:'var(--slate-500)' }}>
                            {row.lastPerformed
                              ? new Date(row.lastPerformed).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
                              : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Admin controls */}
          <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--slate-200)', background:'var(--slate-25)' }}>
            <AdminActionPanel title="Admin controls"
              subtitle="Every action is logged with reason + actor.">
              <ActionRow
                label={detail.stripe ? 'Stripe Connect' : 'Stripe Connect onboarding'}
                hint={detail.stripe
                  ? detail.stripeAccountId
                    ? `Connected · ${detail.stripeAccountId.slice(0, 16)}…`
                    : 'Connected'
                  : 'Generate a one-time onboarding URL (Stripe Connect)'}
                action={detail.stripe
                  ? (detail.stripeAccountId
                      ? <a href={`https://dashboard.stripe.com/connect/accounts/${detail.stripeAccountId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
                          <Button size="sm" iconRight={<IconExternal size={11} />}>Open</Button>
                        </a>
                      : <Button size="sm" disabled>Connected</Button>)
                  : <Button size="sm" variant="primary" onClick={handleStripeOnboarding} disabled={stripeLinkLoading}>
                      {stripeLinkLoading ? 'Generating…' : 'Generate link'}
                    </Button>} />
              <ActionRow
                label={detail.isVerified ? 'Remove verification' : 'Mark as verified'}
                hint={detail.isVerified ? 'Currently verified' : 'Customer-visible trust badge'}
                action={detail.isVerified
                  ? <Button size="sm" onClick={() => setConfirmAction('Remove Verification')}>Remove</Button>
                  : <Button size="sm" variant="primary" onClick={() => setConfirmAction('Mark Verified')}>Verify</Button>} />
              <ActionRow
                label={detail.status === 'active' ? 'Deactivate shop' : 'Reactivate shop'}
                hint={detail.status === 'active'
                  ? 'Hides shop from marketplace, blocks new bookings'
                  : 'Currently deactivated'}
                danger={detail.status === 'active'}
                action={detail.status === 'active'
                  ? <Button size="sm" variant="danger" onClick={() => setConfirmAction('Deactivate')}>Deactivate</Button>
                  : <Button size="sm" variant="primary" onClick={() => setConfirmAction('Reactivate')}>Reactivate</Button>} />
              <ActionRow
                label="Open shop CRM"
                hint="Live shop-side dashboard for this shop"
                action={<a href={`/dashboard?shop=${shopId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
                  <Button size="sm" iconRight={<IconExternal size={11} />}>Open</Button>
                </a>} />
            </AdminActionPanel>
          </div>

          <div style={{ padding:22, background:'var(--slate-25)' }}>
            {shopId && <DirectorNotesPanel entityType="shop" entityId={shopId} placeholder="Add an internal note about this shop…" />}
          </div>

          {confirmAction && confirmAction !== 'Resend Stripe Invite' && (
            <ConfirmDialog
              action={confirmAction}
              onConfirm={(reason) => handleAction(confirmAction, reason)}
              onClose={() => setConfirmAction(null)}
            />
          )}

          {/* Nested drill — booking detail */}
          <BookingDetailModal bookingId={drillBookingId} onClose={() => setDrillBookingId(null)} />

          {toast && (
            <div style={{
              position:'fixed', bottom:24, right:24, zIndex:400,
              background:'var(--slate-900)', color:'#fff',
              padding:'10px 14px', borderRadius:8, fontSize:13, fontWeight:500,
              boxShadow:'0 10px 30px rgba(15,23,42,0.25)',
              display:'flex', alignItems:'center', gap:8,
            }}>
              <IconCheck size={14} />
              {toast}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

const ShopField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display:'grid', gridTemplateColumns:'120px 1fr', alignItems:'center', gap:8 }}>
    <span style={{ color:'var(--slate-500)', fontSize:11 }}>{label}</span>
    {children}
  </div>
)

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
    <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:4 }}>{label}</div>
    <div style={{ fontSize:16, fontWeight:600, color:'var(--slate-900)' }} className="mono">{value}</div>
  </div>
)

export const TabShops = () => {
  const [q, setQ]               = useState('')
  const [status, setStatus]     = useState('all')
  const [stripeOnly, setStripeOnly] = useState(false)
  const [hasBookings, setHasBookings] = useState(false)
  const [openId, setOpenId]     = useState<Id<'shops'> | null>(null)

  useEffect(() => {
    const goto = consumeGoto()
    if (goto) setOpenId(goto.entityId as Id<'shops'>)
  }, [])

  const shops = useQuery(api.director.shopsList)

  const filtered = (shops ?? []).filter(s => {
    if (q && !s.name.toLowerCase().includes(q.toLowerCase())) return false
    if (status !== 'all' && s.status !== status) return false
    if (stripeOnly && !s.stripe) return false
    if (hasBookings && s.bookings7d === 0) return false
    return true
  })

  return (
    <SectionAnchor id="shops" title="Shops" subtitle="All shops on the platform. Click a row to open the full detail."
>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)} placeholder="Search shop name…" style={{ width:280 }} />
        <Select value={status} onChange={e => setStatus(e.target.value)}
          options={[{ value:'all', label:'All statuses' },{ value:'active', label:'Active' },{ value:'inactive', label:'Inactive' }]} />
        <span style={{ width:1, height:22, background:'var(--slate-200)', margin:'0 4px' }} />
        <Toggle checked={stripeOnly} onChange={e => setStripeOnly(e.target.checked)} label="Stripe connected only" />
        <Toggle checked={hasBookings} onChange={e => setHasBookings(e.target.checked)} label="Has bookings (7d)" />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {shops === undefined ? 'Loading…' : `Showing ${filtered.length} of ${shops.length} shops`}
        </span>
      </div>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>City</th>
            <th style={tableStyles.th}>Status</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Members</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Bookings (7d)</th>
            <th style={tableStyles.th}>Stripe</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Rating</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {shops === undefined
              ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No shops found.</td></tr>
                : filtered.map(s => (
                  <tr key={s.id} onClick={() => setOpenId(s.id)} style={{ cursor:'pointer' }}>
                    <td style={tableStyles.td}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ width:30, height:30, borderRadius:6, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)' }}><IconShop size={16} /></span>
                        <div>
                          <div style={{ fontWeight:500, color:'var(--slate-900)' }}>{s.name}</div>
                          <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{String(s.id).slice(-8)}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{s.city}</td>
                    <td style={tableStyles.td}><StatusBadge status={s.status} /></td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{s.mechanics}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{s.bookings7d}</td>
                    <td style={tableStyles.td}>
                      {s.stripe
                        ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, color:'var(--green-700)', fontSize:13, fontWeight:500 }}><IconCheck size={14} />Connected</span>
                        : <span style={{ color:'var(--slate-400)' }}>—</span>}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-600)' }}>
                      {s.rating ? `${s.rating.toFixed(1)} ★` : '—'}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                      <Button size="sm" onClick={() => setOpenId(s.id)}>View</Button>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>

      <ShopModal shopId={openId} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
