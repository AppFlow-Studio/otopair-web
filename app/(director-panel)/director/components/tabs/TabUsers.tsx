'use client'

import { useState, useEffect, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Badge, Button, Card, Input, Select, Modal, AuditButton, Avatar, tableStyles, IconSearch, IconExternal, IconX, IconCheck } from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto, consumeStashedGoto } from '../directorNav'
import { AdminActionPanel, ActionRow, CreditPromptModal } from '../AdminActionPanel'
import { BookingDetailModal } from '../BookingDetailModal'
import { fmtDate } from '../Charts'
import { UserProfileTab } from './users/UserProfileTab'
import { UserEngagementTab } from './users/UserEngagementTab'
import { UserGarageTab } from './users/UserGarageTab'
import { UserBookingsTab } from './users/UserBookingsTab'
import { UserMoneyTab } from './users/UserMoneyTab'
import { UserFootprintTab } from './users/UserFootprintTab'

const USER_TABS = ['Profile', 'Engagement', 'Garage', 'Bookings', 'Money', 'Footprint'] as const
type UserTab = (typeof USER_TABS)[number]

const loyaltyChip = (loyalty: string, pending?: boolean) => {
  if (pending) return <Badge tone="red">Pending deletion</Badge>
  const m: Record<string, { tone: 'slate'|'indigo'|'orange'; label: string }> = {
    standard:{ tone:'slate',  label:'Standard' },
    premium: { tone:'indigo', label:'Premium' },
    elite:   { tone:'orange', label:'Elite' },
  }
  const v = m[loyalty] || { tone:'slate' as const, label:loyalty }
  return <Badge tone={v.tone} dot>{v.label}</Badge>
}

const ConfirmDialog = ({ action, onConfirm, onClose }: { action: string; onConfirm: (reason: string) => void; onClose: () => void }) => {
  const [reason, setReason] = useState('')
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
          placeholder="e.g. User requested account deletion via support ticket #4421"
          style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={action === 'Soft Delete' ? 'danger' : 'primary'} onClick={() => { if (reason.trim()) { onConfirm(reason); onClose() } }}>
            Confirm {action}
          </Button>
        </div>
      </div>
    </div>
  )
}

const UserModal = ({ userId, onClose, onOpenUser }: { userId: Id<'users'> | null; onClose: () => void; onOpenUser: (id: Id<'users'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [auditOpen, setAuditOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<string | null>(null)
  const [tab, setTab] = useState<UserTab>('Profile')
  const [drillBooking, setDrillBooking] = useState<Id<'bookings'> | null>(null)
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [editFirst, setEditFirst] = useState('')
  const [editLast,  setEditLast]  = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [creditOpen, setCreditOpen] = useState(false)
  const softDelete = useMutation(api.director.softDeleteUser)
  const restoreUser = useMutation(api.directorUserActions.restoreUser)
  const setRole    = useMutation(api.directorUserActions.setUserRole)
  const grantCredit = useMutation(api.directorUserActions.grantCredit)
  const updateBasics = useMutation(api.directorUserActions.updateUserBasics)
  const logView    = useMutation(api.director.logView)
  const detail = useQuery(api.director.userDetail, userId ? { id: userId, token: session?.token ?? '' } : 'skip')
  const externalIds = useQuery(api.directorUserActions.userExternalIds, userId ? { id: userId } : 'skip')

  // Seed edit form when entering edit mode.
  useEffect(() => {
    if (!editing || !detail) return
    // Split the name back into first/last for the form. `detail.name` is the
    // joined form so we can't perfectly round-trip, but split on first space.
    const parts = detail.name.split(' ')
    setEditFirst(parts[0] ?? '')
    setEditLast(parts.slice(1).join(' ') ?? '')
    setEditEmail(detail.email === '—' ? '' : detail.email)
    setEditPhone(detail.phone === '—' ? '' : detail.phone)
  }, [editing, detail?.name, detail?.email, detail?.phone])

  useEffect(() => {
    if (userId) logView({ entity_type: 'user', entity_id: String(userId), actorName, actorId })
  }, [String(userId)])
  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const rawAudit = useQuery(api.audit_log.listByEntity, userId ? { entity_type: 'user', entity_id: userId, token: session?.token ?? '' } : 'skip')
  const auditEntries = rawAudit?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  const handleAction = async (action: string, reason: string) => {
    if (!userId) return
    if (action === 'Soft Delete') {
      await softDelete({ id: userId, reason, actorName, actorId })
      setToast('Account marked for deletion. Audit logged.')
    } else if (action === 'Restore Account') {
      await restoreUser({ id: userId, reason, actorName, actorId })
      setToast('Account restored.')
    }
  }

  const handleGrantCredit = async (amount: number, description: string) => {
    if (!userId) return
    await grantCredit({ id: userId, amount, description, actorName, actorId })
    setCreditOpen(false)
    setToast(`Credited $${amount.toFixed(2)} · "${description.slice(0, 36)}${description.length > 36 ? '…' : ''}"`)
  }

  const handleSaveProfile = async () => {
    if (!userId) return
    setSaving(true)
    try {
      const res = await updateBasics({
        id: userId,
        first_name: editFirst,
        last_name:  editLast,
        email:      editEmail,
        phone:      editPhone,
        actorName,
        actorId,
      })
      if (res?.ok && res.changes > 0) {
        setToast(`Saved ${res.changes} change${res.changes === 1 ? '' : 's'}.`)
      } else if (res?.ok) {
        setToast('No changes.')
      } else {
        setToast('Save failed.')
      }
      setEditing(false)
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  // Clerk admin dashboard deep-link — Clerk owns verification + password flows.
  const clerkDashboardUrl = externalIds?.clerkUserId
    ? `https://dashboard.clerk.com/last-active?path=users/${externalIds.clerkUserId}`
    : null
  const stripeCustomerUrl = externalIds?.stripe_customer_id
    ? `https://dashboard.stripe.com/customers/${externalIds.stripe_customer_id}`
    : null

  return (
    <Modal open={!!userId} onClose={onClose} width={920}
      eyebrow={detail && <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{String(detail.id).slice(-8)}</span>}
      statusBadge={detail && loyaltyChip(detail.role, detail.isPendingDeletion)}
      title={detail?.name ?? ''}
      headerRight={<>
        <AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />
        {stripeCustomerUrl
          ? <a href={stripeCustomerUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
              <Button iconRight={<IconExternal size={13} />}>Open in Stripe</Button>
            </a>
          : <Button iconRight={<IconExternal size={13} />} disabled>No Stripe customer</Button>}
        {!editing
          ? <Button variant="primary" onClick={() => setEditing(true)}>Edit profile</Button>
          : <Button variant="primary" onClick={handleSaveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>}
      </>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'User audit log', subtitle:detail ? `${String(detail.id).slice(-8)} · ${detail.name}` : '', entries:auditEntries }}
      footer={<>
        {editing && <Button onClick={() => setEditing(false)} disabled={saving}>Cancel edit</Button>}
        <Button onClick={onClose}>Close</Button>
      </>}>
      {!detail ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : <>
        <div style={{ padding:'10px 24px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', alignItems:'center', gap:14 }}>
          <Avatar name={detail.name} size={44} />
          {editing ? (
            <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <Input value={editFirst} onChange={e => setEditFirst(e.target.value)} placeholder="First name" />
              <Input value={editLast}  onChange={e => setEditLast(e.target.value)}  placeholder="Last name" />
              <Input value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="Email" />
              <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="Phone" />
            </div>
          ) : (
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, color:'var(--slate-500)', display:'flex', gap:14, alignItems:'center', flexWrap:'wrap' }}>
                <span>{detail.email}</span><span>·</span><span>{detail.phone}</span><span>·</span><span>Joined {detail.joined}</span>
              </div>
              <div style={{ fontSize:12, color:'var(--slate-500)', marginTop:4, display:'flex', gap:14 }}>
                <span><b className="mono" style={{ color:'var(--slate-800)' }}>{detail.recentBookings.length}</b> recent bookings</span>
                <span>·</span>
                <span><b className="mono" style={{ color:'var(--slate-800)' }}>{detail.vehicles.length}</b> vehicles</span>
              </div>
            </div>
          )}
        </div>

        {/* Detail tab strip */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:2, padding:'0 24px', borderBottom:'1px solid var(--slate-200)' }}>
          {USER_TABS.map(t => {
            const active = tab === t
            return (
              <button key={t} onClick={() => setTab(t)}
                style={{ marginBottom:-1, background:'none', border:'none', borderBottom:`2px solid ${active ? 'var(--blue-600)' : 'transparent'}`, padding:'10px 12px', fontSize:13, fontWeight:500, cursor:'pointer', color: active ? 'var(--blue-700)' : 'var(--slate-500)', fontFamily:'inherit' }}>
                {t}
              </button>
            )
          })}
        </div>

        {/* Detail tab panel — powered by api.opsUsers.* (identical auth, so the
            director token works directly). */}
        <div style={{ padding:22, borderBottom:'1px solid var(--slate-200)', background:'var(--slate-25)' }}>
          {userId && tab === 'Profile' && <UserProfileTab userId={userId} />}
          {userId && tab === 'Engagement' && <UserEngagementTab userId={userId} onOpenUser={onOpenUser} onOpenBooking={setDrillBooking} />}
          {userId && tab === 'Garage' && <UserGarageTab userId={userId} onOpenBooking={setDrillBooking} />}
          {userId && tab === 'Bookings' && <UserBookingsTab userId={userId} onOpenBooking={setDrillBooking} />}
          {userId && tab === 'Money' && <UserMoneyTab userId={userId} onOpenBooking={setDrillBooking} />}
          {userId && tab === 'Footprint' && <UserFootprintTab userId={userId} onOpenBooking={setDrillBooking} />}
        </div>

        {/* Admin controls — expanded */}
        <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--slate-200)', background:'var(--slate-25)' }}>
          <AdminActionPanel title="Admin controls"
            subtitle="Auth / password flows live in Clerk. Everything else is logged to the audit trail.">
            {clerkDashboardUrl
              ? <ActionRow label="Manage in Clerk" hint="Email verification, password reset, sessions, MFA, organizations"
                  action={<a href={clerkDashboardUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
                    <Button size="sm" iconRight={<IconExternal size={11} />}>Open Clerk</Button>
                  </a>} />
              : <ActionRow label="Manage in Clerk" hint="No Clerk user ID on file"
                  action={<Button size="sm" disabled>Unavailable</Button>} />}
            <ActionRow label="Issue manual credit"
              hint="Adds a transactions row + audit"
              action={<Button size="sm" onClick={() => setCreditOpen(true)}>Issue</Button>} />
            {detail.isPendingDeletion
              ? <ActionRow label="Restore account"
                  hint="Undo pending deletion"
                  action={<Button size="sm" variant="primary" onClick={() => setConfirmAction('Restore Account')}>Restore</Button>} />
              : <ActionRow label="Soft delete account" danger
                  hint="Marks isPendingDeletion=true. Reversible."
                  action={<Button size="sm" variant="danger" onClick={() => setConfirmAction('Soft Delete')}>Delete</Button>} />}
          </AdminActionPanel>
        </div>

        <div style={{ padding:22, background:'var(--slate-25)' }}>
          {userId && <DirectorNotesPanel entityType="user" entityId={userId} placeholder="Add an internal note about this user…" />}
        </div>

        {confirmAction && (
          <ConfirmDialog
            action={confirmAction}
            onConfirm={(reason) => handleAction(confirmAction, reason)}
            onClose={() => setConfirmAction(null)}
          />
        )}

        <CreditPromptModal
          open={creditOpen}
          onConfirm={handleGrantCredit}
          onClose={() => setCreditOpen(false)} />

        <BookingDetailModal bookingId={drillBooking} onClose={() => setDrillBooking(null)} />

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
      </>}
    </Modal>
  )
}

export const TabUsers = () => {
  const session = useContext(DirectorSessionCtx)
  const [q, setQ]           = useState('')
  const [loyalty, setLoyalty] = useState('all')
  const [openId, setOpenId] = useState<Id<'users'> | null>(null)

  useEffect(() => {
    const g = consumeGoto() ?? consumeStashedGoto('users')
    if (g) setOpenId(g.entityId as Id<'users'>)
  }, [])

  const users = useQuery(api.director.usersList, { token: session?.token ?? '' })

  const filtered = (users ?? []).filter(u => {
    if (loyalty !== 'all' && (u.loyalty ?? 'standard') !== loyalty) return false
    if (q) {
      const needle = q.toLowerCase()
      return u.name.toLowerCase().includes(needle)
        || u.email.toLowerCase().includes(needle)
        || u.phone.includes(q)
    }
    return true
  })

  return (
    <SectionAnchor id="users" title="Users" subtitle="All consumer accounts on Otopair."
>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12 }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, email, or phone…" style={{ width:360 }} />
        <Select value={loyalty} onChange={e => setLoyalty(e.target.value)}
          options={[{ value:'all', label:'All loyalty tiers' },{ value:'standard', label:'Standard' },{ value:'premium', label:'Premium' },{ value:'elite', label:'Elite' }]} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {users === undefined ? 'Loading…' : `Showing ${filtered.length} of ${users.length} users`}
        </span>
      </div>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Name</th>
            <th style={tableStyles.th}>Email</th>
            <th style={tableStyles.th}>Phone</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Vehicles</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Bookings</th>
            <th style={tableStyles.th}>Last booking</th>
            <th style={tableStyles.th}>Status</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {users === undefined
              ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No users found.</td></tr>
                : filtered.map(u => (
                  <tr key={u.id} onClick={() => setOpenId(u.id)} style={{ cursor:'pointer' }}>
                    <td style={tableStyles.td}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <Avatar name={u.name} size={28} />
                        <span style={{ fontWeight:500 }}>{u.name}</span>
                      </div>
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{u.email}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }} className="mono">{u.phone}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{u.vehicles}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{u.bookings}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{fmtDate(u.lastBooking)}</td>
                    <td style={tableStyles.td}>{loyaltyChip(u.loyalty, u.isPendingDeletion)}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                      <Button size="sm" onClick={() => setOpenId(u.id)}>View</Button>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>

      <UserModal userId={openId} onClose={() => setOpenId(null)} onOpenUser={setOpenId} />
    </SectionAnchor>
  )
}
