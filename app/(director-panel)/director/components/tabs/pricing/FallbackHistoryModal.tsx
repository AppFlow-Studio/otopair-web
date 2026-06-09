'use client'

import { useContext, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Modal, IconCheck } from '../../Primitives'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'

type EntityType = 'baseline' | 'parts_multiplier' | 'labor_multiplier' | 'service_labor_hours'

type SnapshotRow = {
  id: Id<'pricing_fallback_snapshots'>
  entity_type: EntityType
  entity_id: string
  entity_label: string
  payload: string
  changes_summary: string
  is_restore: boolean
  actor_name: string
  actor_id: Id<'director_users'> | null
  created_at: number
}

function fmtTs(ts: number) {
  const d = new Date(ts)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function fmtAge(ts: number) {
  const d = Date.now() - ts
  const m = Math.floor(d / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function fmtPayloadValue(key: string, value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    if (key.endsWith('_cents')) return `$${(value / 100).toFixed(2)}`
    if (key.endsWith('_at')) return new Date(value).toLocaleDateString()
    return String(value)
  }
  return String(value)
}

const FIELD_LABEL: Record<string, string> = {
  base_price_low_cents:  'Low (Camry)',
  base_price_high_cents: 'High (Camry)',
  is_real_data:          'Real data',
  data_source:           'Source',
  last_validated_at:     'Last validated',
  notes:                 'Notes',
  multiplier:            'Multiplier',
  source:                'Source',
  tier:                  'Tier',
}

function PayloadCard({ payload }: { payload: string }) {
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(payload) } catch { /* ignore */ }
  const entries = Object.entries(parsed).filter(([k]) =>
    !['created_at', 'updated_at', 'updated_by_user_id', 'anchor_vehicle_config_id',
      'parts_category_id', 'labor_category_id', 'service_id'].includes(k)
  )
  if (entries.length === 0) {
    return <div style={{ fontSize:12, color:'var(--slate-400)' }}>No snapshot fields.</div>
  }
  return (
    <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', columnGap:14, rowGap:6, fontSize:12 }}>
      {entries.map(([k, v]) => (
        <>
          <div key={`k-${k}`} style={{ color:'var(--slate-500)' }}>{FIELD_LABEL[k] ?? k}</div>
          <div key={`v-${k}`} style={{ color:'var(--slate-900)', fontFamily:'ui-monospace, SFMono-Regular, monospace' }}>
            {fmtPayloadValue(k, v)}
          </div>
        </>
      ))}
    </div>
  )
}

export const FallbackHistoryModal = ({ entityType, entityId, title, subtitle, onClose }: {
  entityType: EntityType
  entityId: string
  title: string
  subtitle?: string
  onClose: () => void
}) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const snapshots = useQuery(api.directorPricing.fallbackHistory, {
    entity_type: entityType,
    entity_id: entityId,
  }) as SnapshotRow[] | undefined

  const restore = useMutation(api.directorPricing.restoreFallbackSnapshot)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Id<'pricing_fallback_snapshots'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onRestore = async (id: Id<'pricing_fallback_snapshots'>) => {
    setError(null)
    setBusy(true)
    try {
      const res = await restore({ snapshot_id: id, actorName, actorId })
      if (!res.ok) setError(`Restore failed: ${res.reason}`)
      else setConfirming(null)
    } catch (e: any) {
      setError(e?.message ?? 'Restore failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={title}
      eyebrow={(
        <span style={{ fontSize:11, fontWeight:600, color:'var(--blue-600)', letterSpacing:'0.04em', textTransform:'uppercase' }}>
          Fallback spec history
        </span>
      )}
      width={720}
      footer={(
        <>
          {error && <span style={{ fontSize:12, color:'var(--red-600)', marginRight:'auto' }}>{error}</span>}
          <Button onClick={onClose} disabled={busy}>Close</Button>
        </>
      )}
    >
      <div style={{ padding:'18px 22px', display:'flex', flexDirection:'column', gap:16 }}>
        {subtitle && (
          <div style={{ fontSize:13, color:'var(--slate-500)' }}>{subtitle}</div>
        )}

        {snapshots === undefined && (
          <div style={{ fontSize:13, color:'var(--slate-400)' }}>Loading history…</div>
        )}

        {snapshots && snapshots.length === 0 && (
          <div style={{ padding:24, background:'var(--slate-25)', borderRadius:10, fontSize:13, color:'var(--slate-500)', textAlign:'center' }}>
            No edits recorded yet. The first time this spec is changed, a snapshot will be captured here.
          </div>
        )}

        {snapshots && snapshots.length > 0 && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {snapshots.map(s => {
              const isExpanded = expanded === String(s.id)
              const isConfirming = confirming === s.id
              return (
                <div key={String(s.id)}
                  style={{ border:'1px solid var(--slate-200)', borderRadius:10, background:'#fff', overflow:'hidden' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px',
                    borderBottom: isExpanded ? '1px solid var(--slate-100)' : 'none' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                        {s.is_restore && <Badge tone="purple">Restore point</Badge>}
                        <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{s.actor_name}</span>
                        <span style={{ fontSize:11, color:'var(--slate-500)' }} title={fmtTs(s.created_at)}>{fmtAge(s.created_at)}</span>
                      </div>
                      <div style={{ fontSize:12, color:'var(--slate-600)', fontFamily:'ui-monospace, SFMono-Regular, monospace' }}>
                        {s.changes_summary}
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                      <Button size="sm" onClick={() => setExpanded(isExpanded ? null : String(s.id))}>
                        {isExpanded ? 'Hide values' : 'Show values'}
                      </Button>
                      {isConfirming ? (
                        <div style={{ display:'inline-flex', gap:6 }}>
                          <Button size="sm" onClick={() => setConfirming(null)} disabled={busy}>Cancel</Button>
                          <Button size="sm" variant="primary" onClick={() => onRestore(s.id)} disabled={busy}
                            icon={<IconCheck size={14} />}>
                            {busy ? 'Restoring…' : 'Confirm restore'}
                          </Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="dark" onClick={() => setConfirming(s.id)}>Restore</Button>
                      )}
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ padding:'12px 14px', background:'var(--slate-25)' }}>
                      <div style={{ fontSize:10, fontWeight:600, color:'var(--slate-500)',
                        textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:8 }}>
                        Snapshot · {fmtTs(s.created_at)}
                      </div>
                      <PayloadCard payload={s.payload} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
