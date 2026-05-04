'use client'

import { useState } from 'react'
import { Badge, Button, Card, Input, Select, Toggle, StatusBadge, NotesPanel, Modal, AuditButton, Avatar, tableStyles, IconShop, IconSearch, IconExternal, IconCheck, IconStripe } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { SHOPS, BOOKINGS, SHOP_AUDIT } from '../../data'
import type { Shop } from '../../data'

const ShopModal = ({ shop, onClose }: { shop: Shop | undefined; onClose: () => void }) => {
  const [auditOpen, setAuditOpen] = useState(false)
  return (
    <Modal open={!!shop} onClose={onClose} width={920}
      eyebrow={shop && <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{shop.id}</span>}
      statusBadge={shop && <StatusBadge status={shop.status} />}
      title={shop?.name ?? ''}
      headerRight={<>
        <AuditButton onClick={() => setAuditOpen(o => !o)} count={SHOP_AUDIT.length} />
        <Button iconRight={<IconExternal size={13} />}>Open in Stripe</Button>
        <Button variant="primary" iconRight={<IconExternal size={13} />}>Open Shop CRM</Button>
      </>}
      auditDrawer={{ open:auditOpen, onClose:() => setAuditOpen(false), title:'Shop audit log', subtitle:shop ? `${shop.id} · ${shop.name}` : '', entries:SHOP_AUDIT }}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary">Save changes</Button></>}>
      {shop && <>
        <div style={{ padding:'12px 24px 16px', borderBottom:'1px solid var(--slate-200)', display:'flex', alignItems:'center', gap:14 }}>
          <span style={{ width:44, height:44, borderRadius:8, background:'#fff', border:'1px solid var(--slate-200)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--blue-600)' }}>
            <IconShop size={22} />
          </span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:12, color:'var(--slate-500)', display:'flex', gap:14, alignItems:'center', flexWrap:'wrap' }}>
              <span>{shop.city}</span><span>·</span>
              <span><b className="mono" style={{ color:'var(--slate-800)' }}>{shop.mechanics}</b> mechanics</span><span>·</span>
              <span><b className="mono" style={{ color:'var(--slate-800)' }}>{shop.bookings7d}</b> bookings (7d)</span><span>·</span>
              <span>Last activity {shop.lastActivity}</span>
            </div>
            <div style={{ fontSize:12, color:'var(--slate-500)', marginTop:4, display:'flex', gap:14, alignItems:'center' }}>
              <Badge tone={shop.tier === 'Premium' ? 'indigo' : 'slate'}>{shop.tier}</Badge>
              {shop.stripe
                ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, color:'var(--green-700)', fontWeight:500 }}><IconCheck size={13} />Stripe connected</span>
                : <span style={{ color:'var(--slate-500)' }}>Stripe not connected</span>}
            </div>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)', borderBottom:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Mechanics ({shop.mechanics})</div>
            {[{ name:'Luis Ortega', role:'Lead mechanic' },{ name:'Daniel Chelala', role:'Owner · mechanic' },{ name:'Erik Sundberg', role:'Mechanic' }].map(m => (
              <div key={m.name} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0' }}>
                <Avatar name={m.name} size={28} />
                <div><div style={{ fontSize:13, fontWeight:500 }}>{m.name}</div><div style={{ fontSize:12, color:'var(--slate-500)' }}>{m.role}</div></div>
              </div>
            ))}
          </div>
          <div style={{ padding:18, borderBottom:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Recent bookings</div>
            <table style={{ width:'100%', fontSize:12 }}>
              <tbody>
                {BOOKINGS.slice(0,4).map(b => (
                  <tr key={b.id} style={{ borderBottom:'1px solid var(--slate-100)' }}>
                    <td style={{ padding:'8px 0' }}><span className="mono" style={{ color:'var(--blue-700)' }}>{b.id}</span></td>
                    <td style={{ padding:'8px 0', color:'var(--slate-600)' }}>{b.user}</td>
                    <td style={{ padding:'8px 0' }}><StatusBadge status={b.status} /></td>
                    <td style={{ padding:'8px 0', textAlign:'right' }} className="mono">${b.total.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding:18, borderRight:'1px solid var(--slate-100)' }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Stripe Connect</div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <span style={{ width:32, height:32, borderRadius:6, background:'#635BFF', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'#fff' }}><IconStripe size={16} /></span>
              <div><div style={{ fontSize:13, fontWeight:500 }}>{shop.stripe ? 'Connected' : 'Not connected'}</div><div style={{ fontSize:12, color:'var(--slate-500)' }}>acct_1Q9k…cE3</div></div>
            </div>
            {[['Payout schedule', shop.payoutSchedule],['Pending payout','$2,431.50'],['Last payout','Apr 28 · $1,892.00']].map(([l,v]) => (
              <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:12 }}>
                <span style={{ color:'var(--slate-500)' }}>{l}</span><span style={{ fontWeight:500 }} className={l === 'Pending payout' ? 'mono' : ''}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ padding:18 }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>Settings snapshot</div>
            {[['Pricing tier', <Badge key="t" tone={shop.tier === 'Premium' ? 'indigo' : 'slate'}>{shop.tier}</Badge>],
              ['Notifications', <span key="n" style={{ fontWeight:500, color:shop.notifications ? 'var(--green-700)' : 'var(--slate-500)' }}>{shop.notifications ? 'On' : 'Off'}</span>],
              ['Auto-accept threshold', '$300'],['Service radius', '12 mi']].map(([l,v]) => (
              <div key={String(l)} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:12 }}>
                <span style={{ color:'var(--slate-500)' }}>{l}</span><span>{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ padding:22, background:'var(--slate-25)' }}>
          <NotesPanel placeholder="Add an internal note about this shop…" initialNotes={[
            { author:'Temur AB',       when:'2h ago',  text:'Owner asked about expanding service radius to 15mi. Need to review demand data first.' },
            { author:'System', system:true, when:'Apr 28, 9:17 AM', text:'Stripe payout of $1,892.00 settled successfully.' },
            { author:'Daniel Chelala', when:'Apr 18',  text:'Upgraded to Premium tier — qualifies for featured placement on quotes screen.' },
          ]} />
        </div>
      </>}
    </Modal>
  )
}

export const TabShops = () => {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [stripeOnly, setStripeOnly] = useState(false)
  const [hasBookings, setHasBookings] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const filtered = SHOPS.filter(s => {
    if (q && !s.name.toLowerCase().includes(q.toLowerCase())) return false
    if (status !== 'all' && s.status !== status) return false
    if (stripeOnly && !s.stripe) return false
    if (hasBookings && s.bookings7d === 0) return false
    return true
  })
  const open = SHOPS.find(s => s.id === openId)

  return (
    <SectionAnchor id="shops" title="Shops" subtitle="All shops on the platform. Click a row to open the full detail."
      right={<Button variant="dark" iconRight={<IconExternal size={13} />}>Export CSV</Button>}>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)} placeholder="Search shop name…" style={{ width:280 }} />
        <Select value={status} onChange={e => setStatus(e.target.value)} options={[{ value:'all', label:'All statuses' },{ value:'active', label:'Active' },{ value:'pending', label:'Pending' },{ value:'suspended', label:'Suspended' }]} />
        <span style={{ width:1, height:22, background:'var(--slate-200)', margin:'0 4px' }} />
        <Toggle checked={stripeOnly} onChange={e => setStripeOnly(e.target.checked)} label="Stripe connected only" />
        <Toggle checked={hasBookings} onChange={e => setHasBookings(e.target.checked)} label="Has bookings (7d)" />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>Showing {filtered.length} of 38 shops</span>
      </div>
      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Shop</th><th style={tableStyles.th}>City</th><th style={tableStyles.th}>Status</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Mechanics</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Bookings (7d)</th>
            <th style={tableStyles.th}>Stripe</th><th style={tableStyles.th}>Last activity</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {filtered.map(s => (
              <tr key={s.id} onClick={() => setOpenId(s.id)} style={{ cursor:'pointer' }}>
                <td style={tableStyles.td}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ width:30, height:30, borderRadius:6, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)' }}><IconShop size={16} /></span>
                    <div><div style={{ fontWeight:500, color:'var(--slate-900)' }}>{s.name}</div><div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{s.id}</div></div>
                  </div>
                </td>
                <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{s.city}</td>
                <td style={tableStyles.td}><StatusBadge status={s.status} /></td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{s.mechanics}</td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{s.bookings7d}</td>
                <td style={tableStyles.td}>{s.stripe ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, color:'var(--green-700)', fontSize:13, fontWeight:500 }}><IconCheck size={14} />Connected</span> : <span style={{ color:'var(--slate-400)' }}>—</span>}</td>
                <td style={{ ...tableStyles.td, color:'var(--slate-500)', fontSize:12 }}>{s.lastActivity}</td>
                <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                  <Button size="sm" onClick={() => setOpenId(s.id)}>View</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ShopModal shop={open} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
