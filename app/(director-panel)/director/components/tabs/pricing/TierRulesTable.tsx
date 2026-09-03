'use client'

import { useContext, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card } from '../../Primitives'
import { Toast } from '../../AdminActionPanel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { TierRuleModal, type TierRuleRow } from './TierRuleModal'

const TIER_TONE: Record<string, 'slate' | 'blue' | 'orange' | 'purple'> = {
  T1: 'slate',
  T2a: 'blue', T2b: 'blue', T2c: 'blue',
  T3a: 'orange', T3b: 'orange',
  T4: 'purple',
}

const fmtYears = (min: number | null, max: number | null): string => {
  if (min == null && max == null) return 'any'
  if (min != null && max != null) return `${min}–${max}`
  if (min != null) return `${min}+`
  return `≤${max}`
}

/**
 * Director "Make / model tiers" — the live, no-deploy rule layer above the
 * hardcoded ASSIGNMENT_RULES engine. Rules apply to future onboards (at config
 * creation) and re-tier existing matching cars on save (directorPricing).
 */
export const TierRulesSection = ({ unassignedConfigs }: { unassignedConfigs?: number }) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined

  const rules  = useQuery(api.directorPricing.tierRulesList, {})
  const retier = useMutation(api.directorPricing.retierConfigs)
  const toggle = useMutation(api.directorPricing.setTierRuleEnabled)

  const [modal, setModal] = useState<{ open: boolean; rule: TierRuleRow | null }>({ open: false, rule: null })
  const [toast, setToast] = useState<string | null>(null)
  const [busy,  setBusy]  = useState(false)

  const retierAll = async () => {
    setBusy(true)
    try {
      const res = await retier({ actorName, actorId })
      setToast(`Re-tier complete · ${res.retiered} updated · ${res.stillNull} still need review`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff',
        border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <div style={{ fontSize:13, color:'var(--slate-600)' }}>
          {rules === undefined ? 'Loading…' : `${rules.length} rule${rules.length === 1 ? '' : 's'}`}
          {unassignedConfigs
            ? <> · <span style={{ color:'var(--red-600)', fontWeight:500 }}>{unassignedConfigs.toLocaleString()} config(s) untiered</span></>
            : null}
        </div>
        <span style={{ flex:1 }} />
        <Button size="sm" disabled={busy} onClick={retierAll}>{busy ? 'Re-tiering…' : 'Re-tier all now'}</Button>
        <Button size="sm" variant="primary" onClick={() => setModal({ open: true, rule: null })}>Add rule</Button>
      </div>

      <Card padded={false}>
        <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0 }}>
          <thead><tr>
            <th style={th}>Make</th>
            <th style={th}>Model kw</th>
            <th style={th}>Trim kw</th>
            <th style={th}>Years</th>
            <th style={th}>Tier</th>
            <th style={th}>Enabled</th>
            <th style={{ ...th, textAlign:'right' }}>Owns</th>
            <th style={{ ...th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {rules === undefined ? (
              <tr><td colSpan={8} style={{ ...td, textAlign:'center', color:'var(--slate-400)', padding:28 }}>Loading…</td></tr>
            ) : rules.length === 0 ? (
              <tr><td colSpan={8} style={{ ...td, textAlign:'center', color:'var(--slate-400)', padding:28 }}>No rules yet. “Add rule” assigns a make / model / trim to a tier for all matching cars.</td></tr>
            ) : rules.map(r => (
              <tr key={String(r.id)} onClick={() => setModal({ open: true, rule: r })}
                style={{ cursor:'pointer', opacity: r.enabled ? 1 : 0.55 }}>
                <td style={td}>
                  <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{r.make}</div>
                  {r.note && <div style={{ fontSize:11, color:'var(--slate-500)', maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.note}</div>}
                </td>
                <td style={{ ...td, color:'var(--slate-600)' }}>{r.model_includes ?? <span style={{ color:'var(--slate-300)' }}>any</span>}</td>
                <td style={{ ...td, color:'var(--slate-600)' }}>{r.trim_includes ?? <span style={{ color:'var(--slate-300)' }}>any</span>}</td>
                <td style={{ ...td, color:'var(--slate-600)' }} className="mono">{fmtYears(r.year_min, r.year_max)}</td>
                <td style={td}><Badge tone={TIER_TONE[r.tier] ?? 'slate'}>{r.tier}</Badge></td>
                <td style={td} onClick={e => e.stopPropagation()}>
                  <label style={{ cursor:'pointer', fontSize:12, color:'var(--slate-600)', display:'inline-flex', alignItems:'center', gap:5 }}>
                    <input type="checkbox" checked={r.enabled}
                      onChange={async e => { await toggle({ id: r.id, enabled: e.target.checked, actorName, actorId }) }} />
                    {r.enabled ? 'On' : 'Off'}
                  </label>
                </td>
                <td style={{ ...td, textAlign:'right' }} className="mono">{r.matchCount}</td>
                <td style={{ ...td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                  <Button size="sm" onClick={() => setModal({ open: true, rule: r })}>Edit</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <TierRuleModal open={modal.open} rule={modal.rule}
        onClose={() => setModal({ open: false, rule: null })}
        onSaved={(msg) => setToast(msg)} />
      <Toast msg={toast} onDismiss={() => setToast(null)} />
    </>
  )
}

const th: React.CSSProperties = {
  fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase' as const, letterSpacing:'0.04em',
  textAlign:'left' as const, padding:'10px 16px', borderBottom:'1px solid var(--slate-200)',
  background:'var(--slate-25)', whiteSpace:'nowrap' as const,
}
const td: React.CSSProperties = {
  fontSize:13, color:'var(--slate-800)', padding:'10px 16px', borderBottom:'1px solid var(--slate-100)',
  verticalAlign:'middle' as const,
}
