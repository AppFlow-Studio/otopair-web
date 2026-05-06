'use client'

import { ReactNode, CSSProperties } from 'react'
import { IconHome, IconShop, IconUsers, IconCalendar, IconBug, IconMessage, IconStripe, IconAudit, IconSearch, IconSettings, Avatar } from './Primitives'

const NAV_ITEMS = [
  { id:'overview',  label:'Overview',  Icon:IconHome },
  { id:'shops',     label:'Shops',     Icon:IconShop },
  { id:'users',     label:'Users',     Icon:IconUsers },
  { id:'bookings',  label:'Bookings',  Icon:IconCalendar },
  { id:'bugs',      label:'Bugs',      Icon:IconBug,     badge:'bugs' },
  { id:'feedback',  label:'Feedback',  Icon:IconMessage, badge:'feedback' },
  { id:'stripe',    label:'Stripe',    Icon:IconStripe,  badge:'stripe' },
  { id:'audit',     label:'Audit log', Icon:IconAudit },
]

type Counts = { bugs?: number; feedback?: number; stripe?: number }

export const Sidebar = ({ active, onNavigate, counts }: { active: string; onNavigate: (id: string) => void; counts?: Counts }) => (
  <aside style={{ width:232, flexShrink:0, background:'var(--slate-900)', color:'var(--slate-300)',
    display:'flex', flexDirection:'column', position:'sticky', top:0, height:'100vh',
    borderRight:'1px solid var(--slate-800)' }}>
    <div style={{ padding:'20px 18px 18px', display:'flex', alignItems:'center', gap:10 }}>
      <span style={{ width:28, height:28, borderRadius:8, background:'var(--blue-600)', color:'#fff',
        display:'inline-flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:14 }}>O</span>
      <div>
        <div style={{ color:'#fff', fontWeight:600, fontSize:14, letterSpacing:-0.1 }}>Otopair</div>
        <div style={{ fontSize:10, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.08em', marginTop:1 }}>Director · Internal</div>
      </div>
    </div>
    <div style={{ margin:'0 14px 14px', padding:'6px 10px', background:'var(--slate-800)', borderRadius:8,
      fontSize:12, color:'var(--slate-400)', display:'flex', alignItems:'center', gap:8 }}>
      <IconSearch size={13} />
      <span style={{ flex:1 }}>Quick search…</span>
      <span className="mono" style={{ fontSize:10, padding:'1px 5px', borderRadius:4, background:'var(--slate-700)', color:'var(--slate-300)' }}>⌘K</span>
    </div>
    <nav style={{ padding:'0 10px', flex:1, overflowY:'auto' }}>
      <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.1em', padding:'0 10px 8px' }}>
        Control plane
      </div>
      {NAV_ITEMS.map(item => {
        const Ic = item.Icon
        const isActive = active === item.id
        const badgeVal = item.badge ? counts?.[item.badge as keyof Counts] : undefined
        const isStripe = item.badge === 'stripe'
        return (
          <a key={item.id} href={`#${item.id}`} onClick={e => { e.preventDefault(); onNavigate(item.id) }}
            style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', margin:'1px 0',
              borderRadius:6, fontSize:13, fontWeight:500, color:isActive ? '#fff' : 'var(--slate-400)',
              background:isActive ? 'var(--slate-800)' : 'transparent', textDecoration:'none',
              position:'relative', transition:'color 120ms, background 120ms' }}>
            {isActive && <span style={{ position:'absolute', left:-10, top:6, bottom:6, width:3, background:'var(--blue-500)', borderRadius:'0 3px 3px 0' }} />}
            <Ic size={16} stroke={isActive ? 2 : 1.75} style={{ color:isActive ? 'var(--blue-500)' : 'var(--slate-400)' }} />
            <span style={{ flex:1 }}>{item.label}</span>
            {badgeVal !== undefined && badgeVal > 0 && (
              isStripe
                ? <span style={{ fontSize:10, padding:'1px 5px', borderRadius:4, background:'#7C2D12', color:'#FED7AA' }} className="mono">{badgeVal}</span>
                : <span style={{ fontSize:11, color:'var(--slate-400)' }} className="mono">{badgeVal}</span>
            )}
          </a>
        )
      })}
    </nav>
    <div style={{ padding:'12px 14px', borderTop:'1px solid var(--slate-800)', display:'flex', alignItems:'center', gap:10 }}>
      <Avatar name="Temur AB" size={28} />
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ color:'#fff', fontSize:13, fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>Temur AB</div>
        <div style={{ color:'var(--slate-500)', fontSize:11 }}>Founder · superadmin</div>
      </div>
      <IconSettings size={15} style={{ color:'var(--slate-500)' }} />
    </div>
  </aside>
)

export const SectionAnchor = ({ id, title, subtitle, right, children, fillViewport }:
  { id: string; title: string; subtitle?: string; right?: ReactNode; children: ReactNode; fillViewport?: boolean }) => (
  <section id={id} style={{ flex:1, minHeight:0, display:'flex', flexDirection:'column', overflow:fillViewport ? 'hidden' : 'auto' }}>
    <div style={{ flexShrink:0, padding:'32px 28px 20px', display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:16 }}>
      <div>
        <h2 style={{ margin:0, fontSize:22, fontWeight:600, color:'var(--slate-900)', letterSpacing:-0.3 }}>{title}</h2>
        {subtitle && <div style={{ fontSize:13, color:'var(--slate-500)', marginTop:4 }}>{subtitle}</div>}
      </div>
      {right}
    </div>
    {fillViewport
      ? <div style={{ flex:1, minHeight:0, padding:'0 28px 8px', display:'flex', flexDirection:'column' }}>{children}</div>
      : <div style={{ padding:'0 28px 60px' }}>{children}</div>}
  </section>
)
