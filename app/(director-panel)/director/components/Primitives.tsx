'use client'

import { useState, useEffect, ReactNode, CSSProperties, ReactElement } from 'react'
import type { Note, AuditEntry } from '../data'

/* ---------- ICONS ---------- */
type IconProps = { size?: number; stroke?: number; style?: CSSProperties }

const Icon = ({ d, size = 18, stroke = 1.75, fill = 'none', children, style }: IconProps & { d?: string; fill?: string; children?: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
    strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={style}>
    {d ? <path d={d} /> : children}
  </svg>
)

export const IconHome     = (p: IconProps) => <Icon {...p}><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></Icon>
export const IconShop     = (p: IconProps) => <Icon {...p}><path d="M3 9l1-5h16l1 5"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></Icon>
export const IconUsers    = (p: IconProps) => <Icon {...p}><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15 14c2.5 0 5 1.5 5 4"/></Icon>
export const IconCalendar = (p: IconProps) => <Icon {...p}><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/></Icon>
export const IconBug      = (p: IconProps) => <Icon {...p}><path d="M8 8a4 4 0 018 0"/><rect x="6" y="8" width="12" height="11" rx="6"/><path d="M2 12h4M18 12h4M2 17h4M18 17h4M2 7h3M19 7h3"/></Icon>
export const IconMessage  = (p: IconProps) => <Icon {...p}><path d="M4 5h16v11H8l-4 4z"/></Icon>
export const IconStripe   = (p: IconProps) => <Icon {...p}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></Icon>
export const IconAudit    = (p: IconProps) => <Icon {...p}><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M8 11h8M8 14h8M8 17h5"/></Icon>
export const IconChevron  = (p: IconProps) => <Icon {...p}><path d="M9 6l6 6-6 6"/></Icon>
export const IconChevronDown = (p: IconProps) => <Icon {...p}><path d="M6 9l6 6 6-6"/></Icon>
export const IconExternal = (p: IconProps) => <Icon {...p}><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v6H5V5h6"/></Icon>
export const IconSearch   = (p: IconProps) => <Icon {...p}><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></Icon>
export const IconFilter   = (p: IconProps) => <Icon {...p}><path d="M3 5h18l-7 9v6l-4-2v-4z"/></Icon>
export const IconCheck    = (p: IconProps) => <Icon {...p}><path d="M5 12l5 5L20 7"/></Icon>
export const IconX        = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18"/></Icon>
export const IconStar     = (p: IconProps) => <Icon {...p} fill="currentColor" stroke={0}><path d="M12 2l3 7 7 .7-5.3 4.7 1.7 7L12 17.5 5.6 21.4l1.7-7L2 9.7 9 9z"/></Icon>
export const IconDrag     = (p: IconProps) => <Icon {...p}><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></Icon>
export const IconCar      = (p: IconProps) => <Icon {...p}><path d="M5 16V11l2-5h10l2 5v5"/><circle cx="8" cy="16" r="2"/><circle cx="16" cy="16" r="2"/><path d="M3 11h18"/></Icon>
export const IconCard     = (p: IconProps) => <Icon {...p}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></Icon>
export const IconClock    = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>
export const IconBolt     = (p: IconProps) => <Icon {...p}><path d="M13 3L4 14h6l-1 7 9-11h-6z"/></Icon>
export const IconRefresh  = (p: IconProps) => <Icon {...p}><path d="M3 12a9 9 0 0115-6.7L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/><path d="M3 20v-4h4"/></Icon>
export const IconTag      = (p: IconProps) => <Icon {...p}><path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="8" cy="8" r="1.5"/></Icon>
export const IconSettings = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.4 2l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2 .4 1.7 1.7 0 00-1 1.5V22a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-2 .4l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.4-2 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.4-2l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 002 .4h0a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1a1.7 1.7 0 001 1.5h0a1.7 1.7 0 002-.4l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.4 2v0a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></Icon>

export const IconDot = ({ color = 'var(--slate-400)', size = 8 }: { color?: string; size?: number }) => (
  <span style={{ width: size, height: size, borderRadius: 999, background: color, display: 'inline-block' }} />
)

/* ---------- BADGE ---------- */
type Tone = 'slate' | 'green' | 'yellow' | 'blue' | 'red' | 'purple' | 'indigo' | 'teal' | 'orange'

const TONES: Record<Tone, { bg: string; fg: string; bd: string }> = {
  slate:  { bg:'var(--slate-100)',  fg:'var(--slate-700)',  bd:'var(--slate-200)' },
  green:  { bg:'var(--green-50)',   fg:'var(--green-700)',  bd:'#A7F3D0' },
  yellow: { bg:'var(--yellow-50)',  fg:'var(--yellow-800)', bd:'#FDE68A' },
  blue:   { bg:'var(--blue-50)',    fg:'var(--blue-700)',   bd:'#BFDBFE' },
  red:    { bg:'var(--red-50)',     fg:'var(--red-700)',    bd:'#FECACA' },
  purple: { bg:'var(--purple-50)',  fg:'var(--purple-700)', bd:'#E9D5FF' },
  indigo: { bg:'var(--indigo-50)',  fg:'var(--indigo-700)', bd:'#C7D2FE' },
  teal:   { bg:'var(--teal-50)',    fg:'var(--teal-700)',   bd:'#99F6E4' },
  orange: { bg:'var(--orange-50)',  fg:'var(--orange-700)', bd:'#FED7AA' },
}

export const Badge = ({ tone = 'slate', children, dot, style }: { tone?: Tone; children: ReactNode; dot?: boolean; style?: CSSProperties }) => {
  const t = TONES[tone]
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'3px 9px', borderRadius:999,
      fontSize:12, fontWeight:500, lineHeight:1.4, border:'1px solid transparent', whiteSpace:'nowrap',
      background:t.bg, color:t.fg, borderColor:t.bd, ...style }}>
      {dot && <span style={{ width:6, height:6, borderRadius:999, background:t.fg }} />}
      {children}
    </span>
  )
}

const STATUS_MAP: Record<string, { tone: Tone; label: string }> = {
  confirmed:    { tone:'green',  label:'Confirmed' },
  pending:      { tone:'yellow', label:'Pending' },
  in_progress:  { tone:'blue',   label:'In progress' },
  completed:    { tone:'slate',  label:'Completed' },
  cancelled:    { tone:'red',    label:'Cancelled' },
  refunded:     { tone:'purple', label:'Refunded' },
  active:       { tone:'green',  label:'Active' },
  suspended:    { tone:'red',    label:'Suspended' },
  connected:    { tone:'green',  label:'Connected' },
  not_connected:{ tone:'slate',  label:'Not connected' },
}

export const StatusBadge = ({ status }: { status: string }) => {
  const m = STATUS_MAP[status] || { tone: 'slate' as Tone, label: status }
  return <Badge tone={m.tone} dot>{m.label}</Badge>
}

/* ---------- BUTTON ---------- */
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark'
type BtnSize = 'sm' | 'md' | 'lg'

export const Button = ({ variant = 'secondary', size = 'md', children, icon, iconRight, onClick, style, type = 'button', disabled }:
  { variant?: BtnVariant; size?: BtnSize; children?: ReactNode; icon?: ReactNode; iconRight?: ReactNode; onClick?: () => void; style?: CSSProperties; type?: 'button' | 'submit'; disabled?: boolean }) => {
  const sizes = { sm:{p:'5px 10px',fs:12,gap:5,h:28}, md:{p:'7px 13px',fs:13,gap:6,h:34}, lg:{p:'10px 16px',fs:14,gap:8,h:40} }
  const variants: Record<BtnVariant, { bg:string;fg:string;bd:string;hov:string }> = {
    primary:  { bg:'var(--blue-600)', fg:'#fff',              bd:'var(--blue-600)',  hov:'var(--blue-700)' },
    secondary:{ bg:'#fff',            fg:'var(--slate-700)',   bd:'var(--slate-200)', hov:'var(--slate-50)' },
    ghost:    { bg:'transparent',     fg:'var(--slate-700)',   bd:'transparent',      hov:'var(--slate-100)' },
    danger:   { bg:'#fff',            fg:'var(--red-700)',     bd:'#FECACA',          hov:'var(--red-50)' },
    dark:     { bg:'var(--slate-900)',fg:'#fff',              bd:'var(--slate-900)', hov:'var(--slate-800)' },
  }
  const [hov, setHov] = useState(false)
  const s = sizes[size]; const v = variants[variant]
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', gap:s.gap,
        padding:s.p, fontSize:s.fs, height:s.h, background:hov && !disabled ? v.hov : v.bg, color:v.fg,
        border:`1px solid ${v.bd}`, borderRadius:8, fontWeight:500, transition:'background 120ms',
        whiteSpace:'nowrap', cursor:disabled ? 'not-allowed' : 'pointer', opacity:disabled ? 0.6 : 1,
        ...style }}>
      {icon}{children}{iconRight}
    </button>
  )
}

/* ---------- CARD ---------- */
export const Card = ({ children, style, padded = true }: { children: ReactNode; style?: CSSProperties; padded?: boolean }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:padded ? 20 : 0, ...style }}>
    {children}
  </div>
)

/* ---------- AVATAR ---------- */
const palette = ['#2563EB','#059669','#7E22CE','#DC2626','#C2410C','#0F766E','#4338CA','#9333EA']
export const Avatar = ({ name, size = 28 }: { name: string; size?: number }) => {
  const initials = name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()
  const i = name.charCodeAt(0) % palette.length
  return (
    <span style={{ width:size, height:size, borderRadius:999, background:palette[i], color:'#fff',
      fontSize:size*0.4, fontWeight:600, display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
      {initials}
    </span>
  )
}

/* ---------- INPUT ---------- */
export const Input = ({ icon, value, onChange, placeholder, style, type = 'text', disabled = false }:
  { icon?: ReactNode; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder?: string; style?: CSSProperties; type?: string; disabled?: boolean }) => (
  <div style={{ position:'relative', display:'flex', alignItems:'center', background: disabled ? 'var(--slate-50)' : '#fff',
    border:'1px solid var(--slate-200)', borderRadius:8, height:34, padding:'0 12px', gap:8, opacity: disabled ? 0.65 : 1, ...style }}>
    {icon && <span style={{ color:'var(--slate-400)', display:'flex' }}>{icon}</span>}
    <input type={type} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled}
      style={{ flex:1, border:'none', outline:'none', background:'transparent', fontSize:13, color:'var(--slate-900)', fontFamily:'inherit' }} />
  </div>
)

/* ---------- SELECT ---------- */
export const Select = ({ value, onChange, options, style }:
  { value: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void; options: { value: string; label: string }[]; style?: CSSProperties }) => (
  <select value={value} onChange={onChange}
    style={{ height:34, padding:'0 30px 0 12px', fontSize:13, background:'#fff',
      border:'1px solid var(--slate-200)', borderRadius:8, color:'var(--slate-900)', fontFamily:'inherit',
      appearance:'none',
      backgroundImage:`url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748B' stroke-width='2'><path d='M6 9l6 6 6-6'/></svg>")`,
      backgroundRepeat:'no-repeat', backgroundPosition:'right 10px center', ...style }}>
    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
)

/* ---------- TOGGLE ---------- */
export const Toggle = ({ checked, onChange, label }:
  { checked: boolean; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; label: string }) => (
  <label style={{ display:'inline-flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:13, color:'var(--slate-700)' }}>
    <span style={{ width:32, height:18, borderRadius:999, background:checked ? 'var(--blue-600)' : 'var(--slate-300)', position:'relative', transition:'background 120ms' }}>
      <span style={{ position:'absolute', top:2, left:checked ? 16 : 2, width:14, height:14, borderRadius:999, background:'#fff', transition:'left 120ms' }} />
    </span>
    <input type="checkbox" checked={checked} onChange={onChange} style={{ display:'none' }} />
    {label}
  </label>
)

/* ---------- SECTION TITLE ---------- */
export const SectionTitle = ({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) => (
  <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16, marginBottom:16 }}>
    <div>
      <h2 style={{ margin:0, fontSize:16, fontWeight:600, color:'var(--slate-900)' }}>{title}</h2>
      {subtitle && <div style={{ fontSize:13, color:'var(--slate-500)', marginTop:2 }}>{subtitle}</div>}
    </div>
    {right}
  </div>
)

/* ---------- TABLE STYLES ---------- */
export const tableStyles = {
  table: { width:'100%', borderCollapse:'separate' as const, borderSpacing:0 },
  th: { fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase' as const, letterSpacing:'0.04em',
    textAlign:'left' as const, padding:'10px 16px', borderBottom:'1px solid var(--slate-200)',
    background:'var(--slate-25)', whiteSpace:'nowrap' as const },
  td: { fontSize:13, color:'var(--slate-800)', padding:'12px 16px', borderBottom:'1px solid var(--slate-100)', verticalAlign:'middle' as const },
  tr: {} as React.CSSProperties,
}

/* ---------- NOTES PANEL ---------- */
const SystemBadge = ({ size = 28 }: { size?: number }) => (
  <div style={{ width:size, height:size, borderRadius:6, background:'var(--slate-900)', color:'#fff',
    display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
    <IconBolt size={Math.round(size * 0.5)} />
  </div>
)

export const NotesPanel = ({ initialNotes = [], placeholder = 'Add an internal note…', label = 'Notes', notes: controlledNotes, onAdd }:
  { initialNotes?: Note[]; placeholder?: string; label?: string; notes?: Note[]; onAdd?: (text: string) => void }) => {
  const [localNotes, setLocalNotes] = useState<Note[]>(initialNotes)
  const [draft, setDraft] = useState('')
  const notes = controlledNotes ?? localNotes
  const submit = () => {
    if (!draft.trim()) return
    if (onAdd) {
      onAdd(draft.trim())
    } else {
      setLocalNotes(prev => [...prev, { author:'Director', when:'just now', text:draft.trim() }])
    }
    setDraft('')
  }
  return (
    <div>
      <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>{label}</div>
      <div style={{ display:'flex', gap:8, alignItems:'flex-start', marginBottom:12 }}>
        <Avatar name="Temur AB" size={28} />
        <div style={{ flex:1 }}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
            style={{ width:'100%', minHeight:64, padding:10, fontSize:13, border:'1px solid var(--slate-200)',
              borderRadius:8, fontFamily:'inherit', resize:'vertical', background:'#fff', outline:'none' }} />
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:6 }}>
            <span style={{ fontSize:11, color:'var(--slate-400)' }}>⌘+Enter to post</span>
            <Button variant="primary" size="sm" onClick={submit}>Post note</Button>
          </div>
        </div>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {notes.map((n, i) => {
          const sys = n.system === true || n.author === 'System'
          return (
            <div key={i} style={{ display:'flex', gap:10 }}>
              {sys ? <SystemBadge size={28} /> : <Avatar name={n.author} size={28} />}
              <div style={{ flex:1, background:sys ? 'var(--slate-50)' : 'var(--slate-25)',
                border:sys ? '1px solid var(--slate-200)' : '1px solid var(--slate-100)', borderRadius:8, padding:'8px 12px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                    <span style={{ fontSize:12, fontWeight:600, color:'var(--slate-800)' }}>{sys ? 'System' : n.author}</span>
                    {sys && <span style={{ fontSize:9, fontWeight:600, letterSpacing:'0.06em', padding:'1px 5px', borderRadius:3,
                      textTransform:'uppercase', background:'var(--slate-900)', color:'#fff' }}>auto</span>}
                  </span>
                  <span style={{ fontSize:11, color:'var(--slate-500)' }}>{n.when}</span>
                </div>
                <div style={{ fontSize:13, color:sys ? 'var(--slate-600)' : 'var(--slate-700)', lineHeight:1.5, fontStyle:sys ? 'italic' : 'normal' }}>
                  {n.text}
                </div>
              </div>
            </div>
          )
        })}
        {notes.length === 0 && <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic', padding:'8px 0' }}>No notes yet.</div>}
      </div>
    </div>
  )
}

/* ---------- AUDIT LOG ---------- */
export const auditMeta = (a: string) => {
  const m: Record<string, { tone: Tone; label: string; Icon: (p: IconProps) => ReactElement }> = {
    status_change:    { tone:'blue',   label:'Status change',    Icon: IconRefresh },
    refund_issued:    { tone:'orange', label:'Refund issued',    Icon: IconCard },
    refund_tagged:    { tone:'purple', label:'Refund tagged',    Icon: IconTag },
    note_added:       { tone:'slate',  label:'Note added',       Icon: IconMessage },
    assignee_change:  { tone:'indigo', label:'Assignee change',  Icon: IconUsers },
    field_edit:       { tone:'slate',  label:'Field edited',     Icon: IconSettings },
    payment_captured: { tone:'green',  label:'Payment captured', Icon: IconCheck },
    email_sent:       { tone:'slate',  label:'Email sent',       Icon: IconExternal },
    flag_raised:      { tone:'red',    label:'Flag raised',      Icon: IconBolt },
    viewed:           { tone:'slate',  label:'Record viewed',    Icon: IconSearch },
    payout_sent:      { tone:'green',  label:'Payout sent',      Icon: IconCard },
    mechanic_added:   { tone:'indigo', label:'Mechanic added',   Icon: IconUsers },
    tier_change:      { tone:'purple', label:'Tier change',      Icon: IconSettings },
    shop_created:     { tone:'slate',  label:'Shop created',     Icon: IconShop },
    login_failed:     { tone:'red',    label:'Login failed',     Icon: IconBolt },
  }
  return m[a] || { tone:'slate' as Tone, label:a, Icon: IconClock }
}

export const AuditLogCompact = ({ entries }: { entries?: AuditEntry[] }) => (
  <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
    {entries === undefined
      ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic', padding:'12px 0' }}>Loading…</div>
      : entries.length === 0
        ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic', padding:'12px 0' }}>No audit events yet.</div>
        : entries.map((e, i) => {
            const m = auditMeta(e.action)
            const Ic = m.Icon
            const isSystem = e.actor === 'system'
            return (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'24px 1fr', gap:12, padding:'12px 0',
                borderBottom:i < entries.length - 1 ? '1px solid var(--slate-100)' : 'none' }}>
                <div style={{ position:'relative' }}>
                  <span style={{ width:24, height:24, borderRadius:6, background:`var(--${m.tone}-50)`, color:`var(--${m.tone}-700)`,
                    display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
                    <Ic size={12} />
                  </span>
                  {i < entries.length - 1 && <span style={{ position:'absolute', left:11, top:26, bottom:-12, width:2, background:'var(--slate-100)' }} />}
                </div>
                <div style={{ minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                    <Badge tone={m.tone}>{m.label}</Badge>
                    <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{e.timestamp}</span>
                  </div>
                  <div style={{ fontSize:13, color:'var(--slate-700)', lineHeight:1.5, marginBottom:6 }}>{e.detail}</div>
                  <div style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:11, color:'var(--slate-600)' }}>
                    {isSystem
                      ? <><span style={{ width:18, height:18, borderRadius:4, background:'var(--slate-900)', color:'#fff', display:'inline-flex', alignItems:'center', justifyContent:'center' }}><IconBolt size={10} /></span><span>System</span></>
                      : <><Avatar name={e.actor} size={18} /><span>{e.actor}</span></>}
                  </div>
                </div>
              </div>
            )
          })
    }
  </div>
)

export const GlobalAuditTable = ({ entries, loading, onRowClick }: {
  entries: AuditEntry[]; loading?: boolean; onRowClick?: (entry: AuditEntry) => void
}) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
    <div style={{ display:'grid', gridTemplateColumns:'150px 28px 150px 1fr 200px 130px', alignItems:'center', gap:12,
      padding:'10px 14px', background:'var(--slate-25)', borderBottom:'1px solid var(--slate-200)',
      fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
      <span>Timestamp</span><span></span><span>Action</span><span>Detail</span><span>Entity</span>
      <span style={{ justifySelf:'flex-end' }}>Actor</span>
    </div>
    {loading
      ? <div style={{ padding:'24px 14px', textAlign:'center', fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>Loading…</div>
      : entries.length === 0
        ? <div style={{ padding:'24px 14px', textAlign:'center', fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No audit entries found.</div>
        : entries.map((e, i) => {
            const m = auditMeta(e.action)
            const Ic = m.Icon
            const isSystem = e.actor === 'system'
            return (
              <div key={i} onClick={() => onRowClick?.(e)}
                style={{ display:'grid', gridTemplateColumns:'150px 28px 150px 1fr 200px 130px', alignItems:'center', gap:12,
                  padding:'10px 14px', borderBottom:i < entries.length - 1 ? '1px solid var(--slate-100)' : 'none',
                  fontSize:12, cursor: onRowClick ? 'pointer' : 'default',
                  transition:'background 80ms' }}
                onMouseEnter={e2 => { if (onRowClick) (e2.currentTarget as HTMLElement).style.background = 'var(--slate-25)' }}
                onMouseLeave={e2 => { (e2.currentTarget as HTMLElement).style.background = '' }}>
                <span className="mono" style={{ color:'var(--slate-500)', fontSize:11 }}>{e.timestamp}</span>
                <span style={{ width:22, height:22, borderRadius:6, background:`var(--${m.tone}-50)`, color:`var(--${m.tone}-700)`,
                  display:'inline-flex', alignItems:'center', justifyContent:'center' }}><Ic size={12} /></span>
                <Badge tone={m.tone}>{m.label}</Badge>
                <span style={{ color:'var(--slate-700)' }}>{e.detail}</span>
                <span className="mono" style={{ fontSize:11, color:'var(--blue-700)' }}>{e.entity}</span>
                <span style={{ display:'inline-flex', alignItems:'center', gap:6, color:'var(--slate-600)', fontSize:11, justifySelf:'flex-end' }}>
                  {isSystem
                    ? <><span style={{ width:18, height:18, borderRadius:4, background:'var(--slate-900)', color:'#fff', display:'inline-flex', alignItems:'center', justifyContent:'center' }}><IconBolt size={10} /></span><span>System</span></>
                    : <><Avatar name={e.actor} size={18} /><span>{e.actor.split(' ')[0]}</span></>}
                </span>
              </div>
            )
          })
    }
  </div>
)

/* ---------- AUDIT BUTTON ---------- */
export const AuditButton = ({ onClick, count }: { onClick: () => void; count?: number }) => (
  <button onClick={onClick}
    style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 10px', borderRadius:6,
      border:'1px solid var(--slate-200)', background:'#fff', fontSize:12, fontWeight:500,
      color:'var(--slate-700)', cursor:'pointer', fontFamily:'inherit' }}
    onMouseEnter={e => (e.currentTarget.style.background = 'var(--slate-50)')}
    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
    <IconClock size={12} style={{ color:'var(--slate-500)' }} />
    <span>Audit log</span>
    {count != null && <span style={{ fontSize:10, fontWeight:600, padding:'1px 5px', borderRadius:999,
      background:'var(--slate-100)', color:'var(--slate-600)' }}>{count}</span>}
  </button>
)

/* ---------- MODAL ---------- */
type AuditDrawerProps = { open: boolean; onClose: () => void; title?: string; subtitle?: string; entries?: AuditEntry[] }

const ModalAuditDrawerBody = ({ onClose, title = 'Audit log', subtitle, entries }: AuditDrawerProps) => (
  <>
    <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--slate-200)', display:'flex', alignItems:'flex-start',
      justifyContent:'space-between', gap:12, background:'var(--slate-25)', borderRadius:'0 12px 0 0' }}>
      <div style={{ minWidth:0 }}>
        <div style={{ fontSize:10, fontWeight:600, color:'var(--blue-600)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:4 }}>System of record</div>
        <div style={{ fontSize:15, fontWeight:600, color:'var(--slate-900)' }}>{title}</div>
        {subtitle && <div style={{ fontSize:12, color:'var(--slate-500)', marginTop:2 }}>{subtitle}</div>}
      </div>
      <button onClick={onClose} style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-500)', padding:4, borderRadius:6, display:'inline-flex' }}>
        <IconX size={18} />
      </button>
    </div>
    <div style={{ flex:1, overflowY:'auto', padding:18 }}><AuditLogCompact entries={entries} /></div>
    <div style={{ padding:'10px 18px', borderTop:'1px solid var(--slate-200)', fontSize:11, color:'var(--slate-500)',
      display:'flex', alignItems:'center', gap:6, background:'var(--slate-25)', borderRadius:'0 0 12px 0' }}>
      <IconBolt size={11} style={{ color:'var(--slate-400)' }} />
      Append-only · cannot be edited or deleted.
    </div>
  </>
)

/**
 * Generic right-side drawer slot. Caller renders its own header + body inside
 * `children` (the Modal only provides the panel chrome). When stacked with
 * auditDrawer, both panels appear side-by-side to the right of the main modal.
 */
export type RightDrawerProps = {
  open: boolean
  onClose: () => void
  width?: number
  children?: ReactNode
}

export type ModalProps = {
  open: boolean
  onClose: () => void
  title: string
  eyebrow?: ReactNode
  statusBadge?: ReactNode
  headerRight?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  width?: number
  auditDrawer?: AuditDrawerProps
  rightDrawer?: RightDrawerProps
}

export const Modal = ({ open, onClose, title, eyebrow, statusBadge, headerRight, children, footer, width = 880, auditDrawer, rightDrawer }: ModalProps) => {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])
  if (!open) return null
  const auditWidth = 440
  const rightWidth = rightDrawer?.width ?? 440
  const auditOpen = !!auditDrawer?.open
  const rightOpen = !!rightDrawer?.open
  const anyDrawerOpen = auditOpen || rightOpen
  const totalDrawerPx = (auditOpen ? auditWidth : 0) + (rightOpen ? rightWidth : 0)
  // Pick the radius for the outermost open drawer (rightDrawer outranks audit when both open).
  const mainRightRadius = anyDrawerOpen ? '12px 0 0 12px' : '12px'
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(15,23,42,0.55)', display:'flex',
      alignItems:'flex-start', justifyContent:'center', zIndex:200, padding:'5vh 24px', overflow:'auto', backdropFilter:'blur(2px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ display:'flex', alignItems:'stretch',
        width:`min(100%, ${width + totalDrawerPx}px)`,
        transition:'width 240ms cubic-bezier(.2,.7,.2,1)' }}>
        <div style={{ background:'#fff', borderRadius:mainRightRadius, flex:'1 1 0', minWidth:0,
          boxShadow:'0 24px 60px rgba(15,23,42,0.35)', overflow:'hidden', display:'flex', flexDirection:'column',
          transition:'border-radius 240ms ease' }}>
          <div style={{ padding:'16px 22px', borderBottom:'1px solid var(--slate-200)',
            background:'linear-gradient(to right, var(--blue-50), #fff 60%)',
            display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
            <div style={{ minWidth:0 }}>
              {eyebrow && <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>{eyebrow}{statusBadge}</div>}
              <div style={{ fontSize:17, fontWeight:600, color:'var(--slate-900)', letterSpacing:-0.2 }}>{title}</div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              {headerRight}
              <button onClick={onClose} style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-500)', padding:4, borderRadius:6, display:'inline-flex' }}>
                <IconX size={18} />
              </button>
            </div>
          </div>
          <div style={{ overflow:'auto', maxHeight:'80vh' }}>{children}</div>
          {footer && <div style={{ padding:'12px 22px', borderTop:'1px solid var(--slate-200)', background:'var(--slate-25)', display:'flex', justifyContent:'flex-end', gap:8 }}>{footer}</div>}
        </div>
        {auditDrawer && (
          <div style={{ width:auditOpen ? auditWidth : 0, transition:'width 240ms cubic-bezier(.2,.7,.2,1)', overflow:'hidden', display:'flex',
            // Only round the right edge when this is the outermost open drawer.
            borderRadius: auditOpen && !rightOpen ? '0 12px 12px 0' : '0' }}>
            <div style={{ width:auditWidth, flexShrink:0, background:'#fff', borderLeft:'1px solid var(--slate-200)',
              boxShadow:'0 24px 60px rgba(15,23,42,0.35)',
              borderRadius: rightOpen ? '0' : '0 12px 12px 0',
              display:'flex', flexDirection:'column', maxHeight:'90vh' }}>
              <ModalAuditDrawerBody {...auditDrawer} />
            </div>
          </div>
        )}
        {rightDrawer && (
          <div style={{ width:rightOpen ? rightWidth : 0, transition:'width 240ms cubic-bezier(.2,.7,.2,1)', overflow:'hidden', display:'flex' }}>
            <div style={{ width:rightWidth, flexShrink:0, background:'#fff', borderLeft:'1px solid var(--slate-200)',
              boxShadow:'0 24px 60px rgba(15,23,42,0.35)', borderRadius:'0 12px 12px 0',
              display:'flex', flexDirection:'column', maxHeight:'90vh' }}>
              {rightDrawer.children}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
