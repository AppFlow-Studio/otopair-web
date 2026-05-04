'use client'

import { useState } from 'react'
import { Badge, Button, Card, Input, Select, StatusBadge, NotesPanel, Modal, AuditButton, Avatar, tableStyles, IconUsers, IconSearch, IconExternal, IconX, IconCar, IconCard } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { USERS, BOOKINGS, USER_AUDIT } from '../../data'
import type { User } from '../../data'

const loyaltyChip = (loyalty: string) => {
  const m: Record<string, { tone: 'slate'|'indigo'|'orange'; label: string }> = {
    standard:{ tone:'slate',  label:'Standard' },
    premium: { tone:'indigo', label:'Premium' },
    elite:   { tone:'orange', label:'Elite' },
  }
  const v = m[loyalty] || { tone:'slate' as const, label:loyalty }
  return <Badge tone={v.tone} dot>{v.label}</Badge>
}

const ConfirmDialog = ({ action, onClose }: { action: string; onClose: () => void }) => {
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
        <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. User requested account deletion via support ticket #4421"
          style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={action === 'Soft Delete' ? 'danger' : 'primary'} onClick={onClose}>Confirm {action}</Button>
        </div>
      </div>
    </div>
  )
}

const UserModal = ({ user, onClose, onAction }: { user: User | undefined; onClose: () => void; onAction: (a: string) => void }) => {
  const [auditOpen, setAuditOpen] = useState(false)
  const vehicles = [{ ymm:'2024 Volkswagen Tiguan', vin:'3VVSB7AX9RM230023' },{ ymm:'2018 Ford F-150', vin:'1FTEW1EP5JKF94312' },{ ymm:'2020 Toyota RAV4', vin:'2T3P1RFV6LW124981' }]
  return (
    <Modal open={!!user} onClose={onClose} width={920}
      eyebrow={user && <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{user.id}</span>}
      statusBadge={user && loyaltyChip(user.loyalty)}
      title={user?.name ?? ''}
      headerRight={<>
        <AuditButton onClick={() => setAuditOpen(o => !o)} count={USER_AUDIT.length} />
        <Button iconRight={<IconExternal size={13} />}>Open in Stripe</Button>
        <Button variant="primary">Edit profile</Button>
      </>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'User audit log', subtitle:user ? `${user.id} · ${user.name}` : '', entries:USER_AUDIT }}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary">Save changes</Button></>}>
      {user && <>
        <div style={{ padding:'10px 24px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', alignItems:'center', gap:14 }}>
          <Avatar name={user.name} size={44} />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:12, color:'var(--slate-500)', display:'flex', gap:14, alignItems:'center', flexWrap:'wrap' }}>
              <span>{user.email}</span><span>·</span><span>{user.phone}</span><span>·</span><span>Joined {user.joined}</span>
            </div>
            <div style={{ fontSize:12, color:'var(--slate-500)', marginTop:4, display:'flex', gap:14 }}>
              <span><b className="mono" style={{ color:'var(--slate-800)' }}>{user.bookings}</b> bookings</span><span>·</span>
              <span><b className="mono" style={{ color:'var(--slate-800)' }}>{user.vehicles}</b> vehicles</span><span>·</span>
              <span>Last booking <b style={{ color:'var(--slate-800)' }}>{user.lastBooking}</b></span>
            </div>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1.2fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Vehicles ({user.vehicles})</div>
            {vehicles.slice(0, user.vehicles).map(v => (
              <div key={v.vin} style={{ padding:10, border:'1px solid var(--slate-200)', borderRadius:8, marginBottom:8, display:'flex', gap:10, alignItems:'center' }}>
                <span style={{ width:32, height:32, borderRadius:6, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)' }}><IconCar size={16} /></span>
                <div><div style={{ fontSize:13, fontWeight:500 }}>{v.ymm}</div><div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{v.vin}</div></div>
              </div>
            ))}
          </div>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Recent bookings</div>
            <table style={{ width:'100%', fontSize:12 }}>
              <tbody>{BOOKINGS.slice(0,5).map(b => (
                <tr key={b.id} style={{ borderBottom:'1px solid var(--slate-100)' }}>
                  <td style={{ padding:'7px 0', color:'var(--slate-500)' }}>{b.scheduled}</td>
                  <td style={{ padding:'7px 0' }}>{b.shop}</td>
                  <td style={{ padding:'7px 0' }}><StatusBadge status={b.status} /></td>
                  <td style={{ padding:'7px 0', textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{ padding:18 }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Transactions</div>
            {[{ date:'Apr 28', amount:124.50, last4:'4242', brand:'Visa' },{ date:'Apr 22', amount:410.00, last4:'4242', brand:'Visa' },{ date:'Apr 14', amount:79.00, last4:'0005', brand:'MC' }].map(t => (
              <div key={t.date+t.amount} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0', borderBottom:'1px solid var(--slate-100)' }}>
                <IconCard size={15} style={{ color:'var(--slate-400)' }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:500 }}>${t.amount.toFixed(2)}</div>
                  <div style={{ fontSize:11, color:'var(--slate-500)' }}>{t.date} · {t.brand} ····{t.last4}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--slate-200)', background:'var(--slate-25)' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:14, flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Admin actions</div>
              <div style={{ fontSize:12, color:'var(--slate-500)' }}>All admin actions require a reason and are logged in the audit trail.</div>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <Button variant="secondary" onClick={() => onAction('Resend Verification')}>Resend verification</Button>
              <Button variant="secondary" onClick={() => onAction('Reset Password')}>Reset password</Button>
              <Button variant="danger" onClick={() => onAction('Soft Delete')}>Soft delete account</Button>
            </div>
          </div>
        </div>
        <div style={{ padding:22, background:'var(--slate-25)' }}>
          <NotesPanel placeholder="Add an internal note about this user…" initialNotes={[
            { author:'Temur AB',       when:'1d ago',  text:'User reached out via support — wants to merge two accounts. Verified identity.' },
            { author:'System', system:true, when:'Apr 23, 6:11 AM', text:'Email verification re-sent automatically (previous link expired).' },
            { author:'Daniel Chelala', when:'Apr 22',  text:"Comp'd $25 credit after Marina Garage no-show. Acknowledged via email." },
            { author:'System', system:true, when:'Apr 22, 10:08 AM', text:'$25 credit auto-applied to wallet after refund tag was set to goodwill.' },
          ]} />
        </div>
      </>}
    </Modal>
  )
}

export const TabUsers = () => {
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<string | null>(null)

  const filtered = USERS.filter(u => !q || u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()) || u.phone.includes(q))
  const open = USERS.find(u => u.id === openId)

  return (
    <SectionAnchor id="users" title="Users" subtitle="All consumer accounts on Otopair."
      right={<Button variant="dark" iconRight={<IconExternal size={13} />}>Export CSV</Button>}>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12 }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, email, or phone…" style={{ width:360 }} />
        <Select value="all" onChange={() => {}} options={[{ value:'all', label:'All loyalty tiers' },{ value:'standard', label:'Standard' },{ value:'premium', label:'Premium' },{ value:'elite', label:'Elite' }]} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>Showing {filtered.length} of 2,147 users</span>
      </div>
      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Name</th><th style={tableStyles.th}>Email</th><th style={tableStyles.th}>Phone</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Vehicles</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Bookings</th>
            <th style={tableStyles.th}>Last booking</th><th style={tableStyles.th}>Loyalty</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.id} onClick={() => setOpenId(u.id)} style={{ cursor:'pointer' }}>
                <td style={tableStyles.td}><div style={{ display:'flex', alignItems:'center', gap:10 }}><Avatar name={u.name} size={28} /><span style={{ fontWeight:500 }}>{u.name}</span></div></td>
                <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{u.email}</td>
                <td style={{ ...tableStyles.td, color:'var(--slate-600)' }} className="mono">{u.phone}</td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{u.vehicles}</td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{u.bookings}</td>
                <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{u.lastBooking}</td>
                <td style={tableStyles.td}>{loyaltyChip(u.loyalty)}</td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}><Button size="sm" onClick={() => setOpenId(u.id)}>View</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <UserModal user={open} onClose={() => setOpenId(null)} onAction={a => setConfirmAction(a)} />
      {confirmAction && <ConfirmDialog action={confirmAction} onClose={() => setConfirmAction(null)} />}
    </SectionAnchor>
  )
}
