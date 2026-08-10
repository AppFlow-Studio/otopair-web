'use client'

import { useContext, useEffect, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Modal, Select } from '../../Primitives'
import { Toast } from '../../AdminActionPanel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'

const TIERS = ['T1','T2a','T2b','T2c','T3a','T3b','T4'] as const
type Tier = typeof TIERS[number]

const BRAKE_OPTIONS = [
  { value: 'iron_standard',          label: 'Iron — standard' },
  { value: 'iron_high_performance',  label: 'Iron — high performance' },
  { value: 'ccb_optional',           label: 'CCB — optional' },
  { value: 'ccb_standard',           label: 'CCB — standard' },
]
const POWERTRAIN_OPTIONS = [
  { value: 'ice',    label: 'ICE' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'phev',   label: 'PHEV' },
  { value: 'bev',    label: 'BEV' },
]

export const VehicleConfigTierModal = ({
  vehicleConfigId, onClose,
}: {
  vehicleConfigId: Id<'vehicle_configs'> | null
  onClose: () => void
}) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const data = useQuery(
    api.directorPricing.tierAssignmentDetail,
    vehicleConfigId ? { vehicleConfigId } : 'skip',
  )
  const override = useMutation(api.directorPricing.overrideVehicleConfigTier)

  const [newTier,    setNewTier]    = useState<Tier>('T1')
  const [brake,      setBrake]      = useState('iron_standard')
  const [powertrain, setPowertrain] = useState('ice')
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)
  const [toast,      setToast]      = useState<string | null>(null)

  useEffect(() => {
    if (!data) return
    setNewTier((data.config.pricing_tier as Tier | null) ?? 'T1')
    if (data.assignment) {
      setBrake(data.assignment.brake_system)
      setPowertrain(data.assignment.powertrain_type)
    } else {
      setBrake('iron_standard')
      setPowertrain('ice')
    }
    setReason('')
  }, [data?.config.id])

  if (!vehicleConfigId) return null

  const cfg = data?.config
  const assignment = data?.assignment

  const submit = async () => {
    if (!cfg || !reason.trim()) return
    setSaving(true)
    try {
      const res = await override({
        vehicleConfigId: cfg.id,
        newTier,
        reason: reason.trim(),
        brakeSystem:    assignment ? brake      : brake,
        powertrainType: assignment ? powertrain : powertrain,
        actorName, actorId,
      })
      if (res.ok) {
        setToast(`Override applied · ${res.prevTier ?? '—'} → ${res.newTier}`)
        onClose()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Modal open={!!vehicleConfigId} onClose={onClose} width={620}
        title={cfg ? `${cfg.year} ${cfg.make} ${cfg.model} ${cfg.trim !== '—' ? cfg.trim : ''}` : 'Vehicle config'}
        eyebrow={<span style={{ fontSize:10, fontWeight:600, color:'var(--blue-600)', textTransform:'uppercase', letterSpacing:'0.1em' }}>Tier override</span>}
        statusBadge={cfg?.pricing_tier && <Badge tone="purple">{cfg.pricing_tier}</Badge>}
        footer={<>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!reason.trim() || saving} onClick={submit}>
            {saving ? 'Saving…' : 'Apply override'}
          </Button>
        </>}>
        <div style={{ padding:22, display:'flex', flexDirection:'column', gap:14 }}>
          {!cfg ? (
            <div style={{ color:'var(--slate-400)', fontSize:12 }}>Loading…</div>
          ) : (
            <>
              <Section title="Current state">
                <Grid>
                  <KV k="Config key" v={<span className="mono" style={{ fontSize:11 }}>{cfg.config_key}</span>} />
                  <KV k="Chassis" v={<span className="mono">{cfg.chassis_code ?? '—'}</span>} />
                  <KV k="Pricing tier" v={cfg.pricing_tier ? <Badge tone="purple">{cfg.pricing_tier}</Badge> : <span style={{ color:'var(--slate-400)' }}>—</span>} />
                  <KV k="Source" v={cfg.pricing_tier_source ?? '—'} />
                  <KV k="Brake system" v={<span className="mono">{assignment?.brake_system ?? '—'}</span>} />
                  <KV k="Powertrain" v={<span className="mono">{assignment?.powertrain_type ?? '—'}</span>} />
                  <KV k="Set at" v={cfg.pricing_tier_set_at ? new Date(cfg.pricing_tier_set_at).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'} />
                  <KV k="Override?" v={assignment?.is_manual_override ? <Badge tone="yellow">manual</Badge> : <Badge tone="slate">auto</Badge>} />
                </Grid>
                {assignment?.classifier_score_breakdown && (
                  <div style={{ marginTop:10, padding:'8px 10px', background:'var(--slate-25)', border:'1px solid var(--slate-200)', borderRadius:6 }}>
                    <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>Classifier score breakdown</div>
                    <pre className="mono" style={{ margin:0, fontSize:10, color:'var(--slate-700)', overflow:'auto', maxHeight:120 }}>{assignment.classifier_score_breakdown}</pre>
                  </div>
                )}
              </Section>

              <Section title="New assignment">
                <Grid>
                  <div>
                    <Lbl>New tier</Lbl>
                    <Select value={newTier} onChange={e => setNewTier(e.target.value as Tier)}
                      options={TIERS.map(t => ({ value: t, label: t }))} />
                  </div>
                  <div>
                    <Lbl>Brake system</Lbl>
                    <Select value={brake} onChange={e => setBrake(e.target.value)} options={BRAKE_OPTIONS} />
                  </div>
                  <div>
                    <Lbl>Powertrain</Lbl>
                    <Select value={powertrain} onChange={e => setPowertrain(e.target.value)} options={POWERTRAIN_OPTIONS} />
                  </div>
                </Grid>
                <div style={{ marginTop:10 }}>
                  <Lbl>Reason (audit-logged, required)</Lbl>
                  <textarea value={reason} onChange={e => setReason(e.target.value)}
                    placeholder="Why is this vehicle being reassigned?"
                    style={{ width:'100%', minHeight:70, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
                </div>
              </Section>
            </>
          )}
        </div>
      </Modal>
      <Toast msg={toast} onDismiss={() => setToast(null)} />
    </>
  )
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>{title}</div>
    {children}
  </div>
)

const Grid = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:10 }}>{children}</div>
)

const KV = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'6px 10px' }}>
    <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:2 }}>{k}</div>
    <div style={{ fontSize:12, color:'var(--slate-900)' }}>{v}</div>
  </div>
)

const Lbl = ({ children }: { children: React.ReactNode }) => (
  <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>{children}</label>
)
