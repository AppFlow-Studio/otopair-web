'use client'

import { useContext, useEffect, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Input, Modal, Select } from '../../Primitives'
import { Toast } from '../../AdminActionPanel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'

const TIERS = ['T1','T2a','T2b','T2c','T3a','T3b','T4'] as const
type Tier = typeof TIERS[number]

const TIER_LABEL: Record<Tier, string> = {
  T1: 'Mainstream',
  T2a: 'Value premium',
  T2b: 'German mid',
  T2c: 'BMW non-M',
  T3a: 'Performance',
  T3b: 'Premium sports',
  T4: 'Ultra-exotic',
}

export type TierRuleRow = {
  id: Id<'pricing_tier_rules'>
  make: string
  model_includes: string | null
  trim_includes: string | null
  year_min: number | null
  year_max: number | null
  tier: string
  enabled: boolean
  note: string | null
  matchCount: number
}

/**
 * Create/edit a make/model/trim → tier rule. `rule` present = edit (delete
 * enabled). `prefill` seeds a fresh rule from a specific car (Cars page).
 */
export const TierRuleModal = ({
  open, onClose, rule, prefill, onSaved,
}: {
  open: boolean
  onClose: () => void
  rule?: TierRuleRow | null
  prefill?: { make?: string; model?: string; trim?: string }
  onSaved?: (msg: string) => void
}) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const upsert = useMutation(api.directorPricing.upsertTierRule)
  const del    = useMutation(api.directorPricing.deleteTierRule)

  const [make,   setMake]   = useState('')
  const [model,  setModel]  = useState('')
  const [trim,   setTrim]   = useState('')
  const [yearMin, setYearMin] = useState('')
  const [yearMax, setYearMax] = useState('')
  const [tier,   setTier]   = useState<Tier>('T1')
  const [enabled, setEnabled] = useState(true)
  const [note,   setNote]   = useState('')
  const [saving, setSaving] = useState(false)
  const [toast,  setToast]  = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (rule) {
      setMake(rule.make)
      setModel(rule.model_includes ?? '')
      setTrim(rule.trim_includes ?? '')
      setYearMin(rule.year_min != null ? String(rule.year_min) : '')
      setYearMax(rule.year_max != null ? String(rule.year_max) : '')
      setTier((rule.tier as Tier) ?? 'T1')
      setEnabled(rule.enabled)
      setNote(rule.note ?? '')
    } else {
      setMake(prefill?.make && prefill.make !== '—' ? prefill.make : '')
      setModel(prefill?.model && prefill.model !== '—' ? prefill.model : '')
      setTrim(prefill?.trim && prefill.trim !== '—' ? prefill.trim : '')
      setYearMin(''); setYearMax('')
      setTier('T1'); setEnabled(true); setNote('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.id])

  if (!open) return null

  const toNum = (s: string): number | undefined => {
    const n = parseInt(s.trim(), 10)
    return Number.isFinite(n) ? n : undefined
  }

  const submit = async () => {
    if (!make.trim() || saving) return
    setSaving(true)
    try {
      const res = await upsert({
        id: rule?.id,
        make: make.trim(),
        model_includes: model.trim() || undefined,
        trim_includes: trim.trim() || undefined,
        year_min: toNum(yearMin),
        year_max: toNum(yearMax),
        tier,
        enabled,
        note: note.trim() || undefined,
        actorName, actorId,
      })
      if (res.ok) {
        onSaved?.(`Rule saved · re-tiered ${res.retier?.retiered ?? 0} car(s)`)
        onClose()
      } else {
        setToast(`Could not save: ${res.reason}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!rule || saving) return
    setSaving(true)
    try {
      const res = await del({ id: rule.id, actorName, actorId })
      if (res.ok) {
        onSaved?.(`Rule deleted · re-tiered ${res.retier?.retiered ?? 0} car(s)`)
        onClose()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} width={620}
        title={rule ? `Edit tier rule · ${rule.make}` : 'New tier rule'}
        eyebrow={<span style={{ fontSize:10, fontWeight:600, color:'var(--blue-600)', textTransform:'uppercase', letterSpacing:'0.1em' }}>Make / model tier</span>}
        statusBadge={<Badge tone="purple">{tier}</Badge>}
        footer={<>
          {rule && <Button variant="danger" disabled={saving} onClick={remove}>Delete</Button>}
          <span style={{ flex:1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!make.trim() || saving} onClick={submit}>
            {saving ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}
          </Button>
        </>}>
        <div style={{ padding:22, display:'flex', flexDirection:'column', gap:16 }}>
          <p style={{ margin:0, fontSize:12, color:'var(--slate-500)', lineHeight:1.5 }}>
            Matches by <strong>make</strong> (required). Add a <strong>model</strong> and/or
            <strong> trim</strong> keyword to narrow it — e.g. make “Mercedes-Benz”, trim “AMG 63”.
            The most specific rule wins. Saving re-tiers matching cars now and applies to all
            future onboards. Manual per-car overrides are never touched.
          </p>

          <div>
            <Lbl>Make (required)</Lbl>
            <Input value={make} onChange={e => setMake(e.target.value)} placeholder="Mercedes-Benz" />
          </div>

          <Grid>
            <div>
              <Lbl>Model keyword (optional)</Lbl>
              <Input value={model} onChange={e => setModel(e.target.value)} placeholder="GLE" />
            </div>
            <div>
              <Lbl>Trim keyword (optional)</Lbl>
              <Input value={trim} onChange={e => setTrim(e.target.value)} placeholder="AMG 63" />
            </div>
            <div>
              <Lbl>Year from (optional)</Lbl>
              <Input type="number" value={yearMin} onChange={e => setYearMin(e.target.value)} placeholder="2019" />
            </div>
            <div>
              <Lbl>Year to (optional)</Lbl>
              <Input type="number" value={yearMax} onChange={e => setYearMax(e.target.value)} placeholder="2025" />
            </div>
            <div>
              <Lbl>Tier</Lbl>
              <Select value={tier} onChange={e => setTier(e.target.value as Tier)}
                options={TIERS.map(t => ({ value: t, label: `${t} — ${TIER_LABEL[t]}` }))} />
            </div>
            <div>
              <Lbl>Enabled</Lbl>
              <Select value={enabled ? 'yes' : 'no'} onChange={e => setEnabled(e.target.value === 'yes')}
                options={[{ value:'yes', label:'Enabled' }, { value:'no', label:'Disabled' }]} />
            </div>
          </Grid>

          <div>
            <Lbl>Note (optional)</Lbl>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="Why this tier? (shown in the rules list + audit log)"
              style={{ width:'100%', minHeight:60, padding:10, fontSize:13, border:'1px solid var(--slate-200)', borderRadius:8, fontFamily:'inherit', resize:'vertical' }} />
          </div>
        </div>
      </Modal>
      <Toast msg={toast} onDismiss={() => setToast(null)} />
    </>
  )
}

const Grid = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:12 }}>{children}</div>
)

const Lbl = ({ children }: { children: React.ReactNode }) => (
  <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>{children}</label>
)
