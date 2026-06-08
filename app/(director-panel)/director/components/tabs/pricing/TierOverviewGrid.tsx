'use client'

import { useContext, useEffect, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Input, Modal, Toggle } from '../../Primitives'
import { Toast } from '../../AdminActionPanel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'

type TierRow = {
  id: Id<'pricing_tiers'>
  code: string
  name: string
  anchor_vehicle_label: string
  description: string | null
  display_order: number
  is_active: boolean
  updated_at: number
}

type Counts = Record<string, number>

const TIER_ACCENT: Record<string, string> = {
  T1:  '#10B981',
  T2a: '#3B82F6',
  T2b: '#6366F1',
  T2c: '#8B5CF6',
  T3a: '#EAB308',
  T3b: '#F97316',
  T4:  '#EF4444',
}

export const TierOverviewGrid = ({
  tiers,
  vehicleCounts,
  configCounts,
  unassignedVehicles,
  unassignedConfigs,
  totalVehicles,
  totalConfigs,
  onPickTier,
}: {
  tiers: TierRow[]
  vehicleCounts: Counts
  configCounts: Counts
  unassignedVehicles: number
  unassignedConfigs: number
  totalVehicles: number
  totalConfigs: number
  onPickTier?: (code: string) => void
}) => {
  const [editTier, setEditTier] = useState<TierRow | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  return (
    <>
      {/* Totals strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <SummaryStat label="Live vehicles" value={totalVehicles} />
        <SummaryStat label="Vehicle configs" value={totalConfigs} />
        <SummaryStat label="Unassigned vehicles" value={unassignedVehicles}
          tone={unassignedVehicles > 0 ? 'yellow' : 'slate'} />
        <SummaryStat label="Unassigned configs" value={unassignedConfigs}
          tone={unassignedConfigs > 0 ? 'yellow' : 'slate'} />
      </div>

      {/* Tier cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(260px, 1fr))', gap:12 }}>
        {tiers.map(t => {
          const vCount = vehicleCounts[t.code] ?? 0
          const cCount = configCounts[t.code] ?? 0
          const accent = TIER_ACCENT[t.code] ?? '#64748B'
          return (
            <Card key={String(t.id)} padded={false} style={{ overflow:'hidden' }}>
              <div style={{ height:4, background: accent }} />
              <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:10 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                  <div>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span className="mono" style={{ fontSize:13, fontWeight:700, color:'var(--slate-900)' }}>{t.code}</span>
                      <Badge tone={t.is_active ? 'green' : 'slate'} dot>{t.is_active ? 'active' : 'inactive'}</Badge>
                    </div>
                    <div style={{ fontSize:14, fontWeight:500, color:'var(--slate-800)', marginTop:2 }}>{t.name}</div>
                    <div style={{ fontSize:11, color:'var(--slate-500)', marginTop:2 }}>{t.anchor_vehicle_label}</div>
                  </div>
                  <Button size="sm" onClick={() => setEditTier(t)}>Edit</Button>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  <button onClick={() => onPickTier?.(t.code)}
                    style={{ background:'var(--slate-25)', border:'1px solid var(--slate-200)', borderRadius:8, padding:'8px 10px', textAlign:'left', cursor:'pointer', fontFamily:'inherit' }}>
                    <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Vehicles</div>
                    <div className="mono" style={{ fontSize:18, fontWeight:600, color:'var(--slate-900)', marginTop:2 }}>{vCount.toLocaleString()}</div>
                  </button>
                  <button onClick={() => onPickTier?.(t.code)}
                    style={{ background:'var(--slate-25)', border:'1px solid var(--slate-200)', borderRadius:8, padding:'8px 10px', textAlign:'left', cursor:'pointer', fontFamily:'inherit' }}>
                    <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Configs</div>
                    <div className="mono" style={{ fontSize:18, fontWeight:600, color:'var(--slate-900)', marginTop:2 }}>{cCount.toLocaleString()}</div>
                  </button>
                </div>
                {t.description && (
                  <div style={{ fontSize:11, color:'var(--slate-600)', lineHeight:1.5 }}>{t.description}</div>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      <TierEditModal tier={editTier} onClose={() => setEditTier(null)}
        onSaved={msg => { setEditTier(null); setToast(msg) }} />
      <Toast msg={toast} onDismiss={() => setToast(null)} />
    </>
  )
}

const SummaryStat = ({ label, value, tone = 'slate' }: { label: string; value: number; tone?: 'slate' | 'yellow' }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:'12px 14px' }}>
    <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</div>
    <div className="mono" style={{
      fontSize:22, fontWeight:600,
      color: tone === 'yellow' ? 'var(--yellow-800)' : 'var(--slate-900)',
      marginTop:4,
    }}>{value.toLocaleString()}</div>
  </div>
)

const TierEditModal = ({ tier, onClose, onSaved }: {
  tier: TierRow | null
  onClose: () => void
  onSaved: (msg: string) => void
}) => {
  const session = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const update = useMutation(api.directorPricing.updateTierMetadata)

  const [name, setName] = useState('')
  const [anchor, setAnchor] = useState('')
  const [order, setOrder] = useState('')
  const [desc, setDesc] = useState('')
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!tier) return
    setName(tier.name)
    setAnchor(tier.anchor_vehicle_label)
    setOrder(String(tier.display_order))
    setDesc(tier.description ?? '')
    setActive(tier.is_active)
  }, [tier?.id])

  if (!tier) return null

  const save = async () => {
    if (!tier) return
    setSaving(true)
    try {
      const res = await update({
        id: tier.id,
        name: name !== tier.name ? name : undefined,
        anchor_vehicle_label: anchor !== tier.anchor_vehicle_label ? anchor : undefined,
        display_order: Number(order) !== tier.display_order ? Number(order) : undefined,
        description: desc !== (tier.description ?? '') ? desc : undefined,
        is_active: active !== tier.is_active ? active : undefined,
        actorName,
        actorId,
      })
      if (res.ok) onSaved(res.changes ? `Tier ${tier.code} updated` : 'No changes')
    } finally {
      setSaving(false)
    }
  }

  const close = () => {
    setName(''); setAnchor(''); setOrder(''); setDesc(''); setActive(true)
    onClose()
  }

  return (
    <Modal open={!!tier} onClose={close} width={560}
      title={`Edit tier ${tier.code}`}
      eyebrow={<span style={{ fontSize:10, fontWeight:600, color:'var(--blue-600)', textTransform:'uppercase', letterSpacing:'0.1em' }}>Pricing tier</span>}
      footer={<>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
      </>}>
      <div style={{ padding:22, display:'flex', flexDirection:'column', gap:12 }}>
        <LabeledInput label="Name" value={name} onChange={setName} />
        <LabeledInput label="Anchor vehicle label" value={anchor} onChange={setAnchor} />
        <LabeledInput label="Display order" value={order} onChange={setOrder} type="number" />
        <div>
          <Lbl>Description</Lbl>
          <textarea value={desc} onChange={e => setDesc(e.target.value)}
            placeholder="What's in this tier and why"
            style={{ width:'100%', minHeight:80, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
        </div>
        <Toggle checked={active} onChange={e => setActive(e.target.checked)} label="Active" />
      </div>
    </Modal>
  )
}

const Lbl = ({ children }: { children: React.ReactNode }) => (
  <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>{children}</label>
)

const LabeledInput = ({ label, value, onChange, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; type?: string
}) => (
  <div>
    <Lbl>{label}</Lbl>
    <Input value={value} onChange={e => onChange(e.target.value)} type={type} />
  </div>
)
