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
  const detail   = useQuery(api.director.shopDetail, shopId ? { id: shopId } : 'skip')
  const logView  = useMutation(api.director.logView)

  useEffect(() => {
    if (shopId) logView({ entity_type: 'shop', entity_id: String(shopId), actorName, actorId })
  }, [String(shopId)])
  const rawAudit = useQuery(api.audit_log.listByEntity, shopId ? { entity_type: 'shop', entity_id: shopId } : 'skip')
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
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary">Save changes</Button></>}>
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
                {detail.mechanics > 0 && <><span>·</span><span><b className="mono" style={{ color:'var(--slate-800)' }}>{detail.mechanics}</b> members</span></>}
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
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Recent bookings</div>
              {detail.recentBookings.length === 0
                ? <div style={{ fontSize:13, color:'var(--slate-400)' }}>No bookings yet.</div>
                : (
                  <table style={{ width:'100%', fontSize:12 }}>
                    <tbody>
                      {detail.recentBookings.map(b => (
                        <tr key={b.id} style={{ borderBottom:'1px solid var(--slate-100)' }}>
                          <td style={{ padding:'8px 0' }}><span className="mono" style={{ color:'var(--blue-700)' }}>{String(b.id).slice(-8)}</span></td>
                          <td style={{ padding:'8px 0', color:'var(--slate-600)' }}>{b.user}</td>
                          <td style={{ padding:'8px 0' }}><StatusBadge status={b.status} /></td>
                          <td style={{ padding:'8px 0', textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Details</div>
              {[
                ['Labor rate',   detail.laborRate ? `$${detail.laborRate}/hr` : '—'],
                ['Rating',       detail.rating ? `${detail.rating.toFixed(1)} ★ (${detail.reviewCount ?? 0} reviews)` : '—'],
                ['Phone',        detail.phone ?? '—'],
                ['Email',        detail.email ?? '—'],
                ['Address',      detail.address ?? '—'],
              ].map(([l, v]) => (
                <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:12, gap:8 }}>
                  <span style={{ color:'var(--slate-500)', flexShrink:0 }}>{l}</span>
                  <span style={{ fontWeight:500, textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Admin actions */}
          <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--slate-200)', background:'var(--slate-25)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:14, flexWrap:'wrap' }}>
              <div>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Admin actions</div>
                <div style={{ fontSize:12, color:'var(--slate-500)' }}>All admin actions require a reason and are logged in the audit trail.</div>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <Button variant="secondary" onClick={() => setConfirmAction('Resend Stripe Invite')} disabled={detail.stripe}>
                  {detail.stripe ? 'Stripe connected' : 'Resend Stripe invite'}
                </Button>
                {detail.isVerified
                  ? <Button variant="secondary" onClick={() => setConfirmAction('Remove Verification')}>Remove verification</Button>
                  : <Button variant="primary" onClick={() => setConfirmAction('Mark Verified')}>Mark as verified</Button>}
                {detail.status === 'active'
                  ? <Button variant="danger" onClick={() => setConfirmAction('Deactivate')}>Deactivate shop</Button>
                  : <Button variant="primary" onClick={() => setConfirmAction('Reactivate')}>Reactivate shop</Button>}
              </div>
            </div>
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
        </>
      )}
    </Modal>
  )
}

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
