'use client'

import { useState, useContext, useMemo, useEffect } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Input, Select, MicroH, IconExternal, IconX } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'

type BillingType = 'subscription' | 'pay_as_you_go' | 'free'

type Integration = {
  _id: Id<'director_integrations'>
  name: string
  url: string
  logo_url?: string
  category?: string
  account?: string
  notes?: string
  billing_type: BillingType
  monthly_cost?: number
  updated_at?: number
}

const BILLING_LABEL: Record<BillingType, { label: string; tone: 'blue' | 'purple' | 'slate' }> = {
  subscription:  { label: 'Subscription', tone: 'blue' },
  pay_as_you_go: { label: 'Pay as you go', tone: 'purple' },
  free:          { label: 'Free / one-time', tone: 'slate' },
}

const BILLING_OPTIONS = [
  { value: 'subscription',  label: 'Subscription (fixed monthly)' },
  { value: 'pay_as_you_go', label: 'Pay as you go (usage)' },
  { value: 'free',          label: 'Free / one-time' },
]

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

/* Favicon-or-letter tile. Tries an explicit logo, then Google's favicon
   service, then a colored initial tile if both fail to load. */
const palette = ['#2563EB', '#059669', '#7E22CE', '#DC2626', '#C2410C', '#0F766E', '#4338CA', '#9333EA']
const ServiceIcon = ({ name, url, logoUrl, size = 40 }: { name: string; url: string; logoUrl?: string; size?: number }) => {
  const host = hostOf(url)
  const sources = useMemo(() => {
    const s: string[] = []
    if (logoUrl) s.push(logoUrl)
    if (host) s.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`)
    return s
  }, [logoUrl, host])
  const [idx, setIdx] = useState(0)
  useEffect(() => { setIdx(0) }, [logoUrl, host])

  const tile = (
    <span style={{ width: size, height: size, borderRadius: 9, flexShrink: 0,
      background: palette[name.charCodeAt(0) % palette.length], color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.42, fontWeight: 700 }}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )

  if (idx >= sources.length) return tile
  return (
    <span style={{ width: size, height: size, borderRadius: 9, flexShrink: 0, background: '#fff',
      border: '1px solid var(--slate-200)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <img
        src={sources[idx]}
        alt={name}
        width={size - 12}
        height={size - 12}
        style={{ objectFit: 'contain' }}
        onError={() => setIdx(i => i + 1)}
      />
    </span>
  )
}

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 14 }}>
    <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-600)', display: 'block', marginBottom: 6 }}>{label}</label>
    {children}
    {hint && <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 4 }}>{hint}</div>}
  </div>
)

const EditModal = ({ service, onClose, actorName, actorId }: {
  service: Integration | 'new'
  onClose: () => void
  actorName: string
  actorId: Id<'director_users'> | undefined
}) => {
  const isNew = service === 'new'
  const s = isNew ? null : service
  const create = useMutation(api.directorIntegrations.create)
  const update = useMutation(api.directorIntegrations.update)

  const [name, setName]         = useState(s?.name ?? '')
  const [url, setUrl]           = useState(s?.url ?? '')
  const [category, setCategory] = useState(s?.category ?? '')
  const [account, setAccount]   = useState(s?.account ?? '')
  const [billing, setBilling]   = useState<BillingType>(s?.billing_type ?? 'subscription')
  const [cost, setCost]         = useState(s?.monthly_cost != null ? String(s.monthly_cost) : '')
  const [logoUrl, setLogoUrl]   = useState(s?.logo_url ?? '')
  const [notes, setNotes]       = useState(s?.notes ?? '')
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState('')

  const costNum = cost.trim() === '' ? undefined : Number(cost)
  const costValid = costNum === undefined || (Number.isFinite(costNum) && costNum >= 0)

  const save = async () => {
    if (!name.trim()) { setErr('Give the service a name.'); return }
    if (!url.trim())  { setErr('Paste the link to the service.'); return }
    if (!costValid)   { setErr('Monthly cost must be a positive number.'); return }
    setBusy(true); setErr('')
    try {
      if (isNew) {
        await create({
          name, url, category, account, notes, logo_url: logoUrl,
          billing_type: billing, monthly_cost: costNum, actorName, actorId,
        })
      } else {
        await update({
          id: s!._id, name, url, category, account, notes, logo_url: logoUrl,
          billing_type: billing, monthly_cost: costNum,
          clear_monthly_cost: costNum === undefined, actorName, actorId,
        })
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.')
      setBusy(false)
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 300, padding: '6vh 24px', overflow: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 520,
        boxShadow: '0 20px 50px rgba(15,23,42,0.25)' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--slate-200)', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ServiceIcon name={name || '?'} url={url} logoUrl={logoUrl} size={36} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>{isNew ? 'Add a service' : 'Edit service'}</div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--slate-500)', padding: 4, display: 'inline-flex' }}>
            <IconX size={18} />
          </button>
        </div>

        <div style={{ padding: '18px 22px' }}>
          <Field label="Name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Convex" style={{ width: '100%' }} />
          </Field>
          <Field label="Link" hint="Paste the dashboard / console URL — clicking the card opens it. The logo is pulled automatically.">
            <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="dashboard.convex.dev" style={{ width: '100%' }} />
          </Field>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label="Category">
                <Input value={category} onChange={e => setCategory(e.target.value)} placeholder="Backend, AI, Payments…" style={{ width: '100%' }} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Billing">
                <Select value={billing} onChange={e => setBilling(e.target.value as BillingType)} options={BILLING_OPTIONS} style={{ width: '100%' }} />
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Field label="Cost / month ($)" hint={billing === 'pay_as_you_go' ? 'Rough monthly estimate' : billing === 'free' ? 'Leave blank if free' : 'Recurring monthly'}>
                <Input value={cost} onChange={e => setCost(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" style={{ width: '100%' }} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Account / login" hint="Whose account it's under">
                <Input value={account} onChange={e => setAccount(e.target.value)} placeholder="ops@otopair.com" style={{ width: '100%' }} />
              </Field>
            </div>
          </div>
          <Field label="Logo URL (optional)" hint="Only if the auto favicon looks wrong.">
            <Input value={logoUrl} onChange={e => setLogoUrl(e.target.value)} placeholder="https://…/logo.png" style={{ width: '100%' }} />
          </Field>
          <Field label="Notes">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Plan, API key location, seat count…"
              style={{ width: '100%', minHeight: 60, padding: 10, fontSize: 13, border: '1px solid var(--slate-200)',
                borderRadius: 8, fontFamily: 'inherit', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }} />
          </Field>

          {err && <div style={{ fontSize: 13, color: 'var(--red-600)', fontWeight: 500, marginBottom: 12 }}>{err}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={busy || !name.trim() || !url.trim()}>
              {busy ? 'Saving…' : isNew ? 'Add service' : 'Save changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const ServiceCard = ({ svc, onEdit, onDelete }: {
  svc: Integration; onEdit: () => void; onDelete: () => void
}) => {
  const [hover, setHover] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const bill = BILLING_LABEL[svc.billing_type]

  const open = () => window.open(svc.url, '_blank', 'noopener,noreferrer')

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setConfirming(false) }}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column',
        background: '#fff', border: '1px solid', borderRadius: 10, cursor: 'pointer',
        transition: 'border-color 120ms, box-shadow 120ms',
        borderColor: hover ? 'var(--blue-300)' : 'var(--slate-200)',
        boxShadow: hover ? '0 6px 18px rgba(15,23,42,0.08)' : 'none' }}>
      <div onClick={open} style={{ padding: 16, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <ServiceIcon name={svc.name} url={svc.url} logoUrl={svc.logo_url} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--slate-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {svc.name}
              </span>
              <IconExternal size={13} style={{ color: hover ? 'var(--blue-500)' : 'var(--slate-300)', flexShrink: 0 }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--slate-400)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {hostOf(svc.url)}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          <Badge tone={bill.tone}>{bill.label}</Badge>
          {svc.monthly_cost != null && svc.monthly_cost > 0 && (
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-800)' }}>
              {fmtMoney(svc.monthly_cost)}<span style={{ color: 'var(--slate-400)', fontWeight: 500 }}>/mo</span>
            </span>
          )}
          {svc.category && <Badge tone="slate">{svc.category}</Badge>}
        </div>

        {svc.account && (
          <div style={{ fontSize: 12, color: 'var(--slate-600)', marginTop: 10 }}>
            <span style={{ color: 'var(--slate-400)' }}>Account · </span>{svc.account}
          </div>
        )}
        {svc.notes && (
          <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 6, lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {svc.notes}
          </div>
        )}
      </div>

      {/* Hover actions — overlay the card, stop propagation so the card link doesn't fire */}
      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 6,
        opacity: hover ? 1 : 0, transition: 'opacity 120ms', pointerEvents: hover ? 'auto' : 'none' }}>
        {!confirming ? (
          <>
            <button onClick={e => { e.stopPropagation(); onEdit() }}
              style={actionBtn}>Edit</button>
            <button onClick={e => { e.stopPropagation(); setConfirming(true) }}
              style={{ ...actionBtn, color: 'var(--red-600)', borderColor: '#FECACA' }}>Remove</button>
          </>
        ) : (
          <>
            <button onClick={e => { e.stopPropagation(); setConfirming(false) }} style={actionBtn}>Cancel</button>
            <button onClick={e => { e.stopPropagation(); onDelete() }}
              style={{ ...actionBtn, background: 'var(--red-600)', color: '#fff', borderColor: 'var(--red-600)' }}>Confirm</button>
          </>
        )}
      </div>
    </div>
  )
}

const actionBtn: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
  background: '#fff', color: 'var(--slate-600)', border: '1px solid var(--slate-200)', fontFamily: 'inherit',
}

const StatTile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <Card style={{ flex: 1, minWidth: 160 }}>
    <MicroH>{label}</MicroH>
    <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--slate-900)', marginTop: 6, letterSpacing: -0.4 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>{sub}</div>}
  </Card>
)

export const TabIntegrations = () => {
  const session = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const services = useQuery(api.directorIntegrations.list) as Integration[] | undefined
  const seedDefaults = useMutation(api.directorIntegrations.seedDefaults)
  const remove = useMutation(api.directorIntegrations.remove)

  const [editing, setEditing] = useState<Integration | 'new' | null>(null)
  const [seeding, setSeeding] = useState(false)

  const totals = useMemo(() => {
    const list = services ?? []
    const subMonthly = list
      .filter(s => s.billing_type === 'subscription')
      .reduce((sum, s) => sum + (s.monthly_cost ?? 0), 0)
    const usageMonthly = list
      .filter(s => s.billing_type === 'pay_as_you_go')
      .reduce((sum, s) => sum + (s.monthly_cost ?? 0), 0)
    return { count: list.length, subMonthly, usageMonthly, allMonthly: subMonthly + usageMonthly }
  }, [services])

  const doSeed = async () => {
    setSeeding(true)
    try { await seedDefaults({ actorName, actorId }) } finally { setSeeding(false) }
  }

  return (
    <SectionAnchor
      id="integrations"
      title="Tools & integrations"
      subtitle="Every third-party service we pay for — where to manage it, whose account it's under, and what it costs."
      right={<Button variant="primary" onClick={() => setEditing('new')}>+ Add service</Button>}
    >
      {/* Spend summary */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatTile label="Services" value={String(totals.count)} />
        <StatTile label="Subscriptions / mo" value={fmtMoney(totals.subMonthly)} sub="Fixed recurring" />
        <StatTile label="Usage / mo (est.)" value={fmtMoney(totals.usageMonthly)} sub="Pay-as-you-go" />
        <StatTile label="Total / mo" value={fmtMoney(totals.allMonthly)} sub={`≈ ${fmtMoney(totals.allMonthly * 12)} / yr`} />
      </div>

      {services === undefined ? (
        <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 13, color: 'var(--slate-400)' }}>Loading…</div>
      ) : services.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--slate-800)' }}>No services yet</div>
          <div style={{ fontSize: 13, color: 'var(--slate-500)', margin: '6px 0 18px' }}>
            Paste a link to any tool you use and we'll pull its logo, or start from the stack we already know about.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={() => setEditing('new')}>+ Add service</Button>
            <Button onClick={doSeed} disabled={seeding}>
              {seeding ? 'Adding…' : 'Add starter services (Convex, Slack, Stripe…)'}
            </Button>
          </div>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {services.map(svc => (
            <ServiceCard
              key={String(svc._id)}
              svc={svc}
              onEdit={() => setEditing(svc)}
              onDelete={() => remove({ id: svc._id, actorName, actorId })}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditModal service={editing} onClose={() => setEditing(null)} actorName={actorName} actorId={actorId} />
      )}
    </SectionAnchor>
  )
}
