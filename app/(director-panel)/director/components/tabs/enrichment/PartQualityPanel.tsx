'use client'

// Needs Attention · Unpriced parts — CORE-role parts fitted with no trusted
// price (no part_prices row survives the poison/non-pooled/price-band
// filter), so the service they belong to can't actually be quoted. A live
// scan (convex/directorPartQuality.ts scanUnpricedParts) — the wrong-part
// counterpart lives in WrongPartsPanel.tsx (table + side drawer).

import { useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Panel, Empty, SkeletonBlock, CopyableMono } from './helpers'

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }
const inputStyle: React.CSSProperties = {
  border: '1px solid var(--slate-200)', borderRadius: 6, padding: '6px 8px',
  fontSize: 12, color: 'var(--slate-800)', background: '#fff', minWidth: 0, fontFamily: 'inherit',
}

type PriceFormState = { price: string; saving: boolean; saved: boolean }

export function UnpricedPartsPanel({ token }: { token: string }) {
  const data = useQuery(api.directorPartQuality.scanUnpricedParts, { token })
  const addPrice = useMutation(api.directorConfigActions.addManualPartPrice)
  const [forms, setForms] = useState<Record<string, PriceFormState>>({})

  const state = (partId: string): PriceFormState => forms[partId] ?? { price: '', saving: false, saved: false }
  const submit = async (partId: string) => {
    const st = state(partId)
    const price = Number(st.price)
    if (!Number.isFinite(price) || price <= 0) return
    setForms(s => ({ ...s, [partId]: { ...st, saving: true } }))
    try {
      await addPrice({ token, partId: partId as Id<'oem_parts'>, price })
      setForms(s => ({ ...s, [partId]: { price: '', saving: false, saved: true } }))
    } catch {
      setForms(s => ({ ...s, [partId]: { ...st, saving: false } }))
    }
  }

  return (
    <Panel title="Unpriced parts" sub={data ? `${data.flags.length}${data.truncated ? '+' : ''} flagged` : undefined}>
      {!data ? <SkeletonBlock height={100} /> : data.flags.length === 0 ? (
        <Empty>No unpriced core parts found in the most recently confirmed fitments.</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.flags.map(f => {
            const carLabel = [f.year, f.make, f.model, f.trim].filter(Boolean).join(' ')
            const st = state(f.partId)
            return (
              <div key={f.fitmentId} style={{ border: '1px solid var(--yellow-200, #fde68a)', background: 'var(--yellow-50)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, color: 'var(--slate-800)' }}>{carLabel || f.configKey || f.configId}</span>
                  {f.vin && <CopyableMono value={f.vin} label="VIN" />}
                  {f.configKey && <CopyableMono value={f.configKey} label="config" />}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--slate-700)', marginBottom: 8 }}>
                  <CopyableMono value={f.oemNumber} style={{ fontWeight: 600 }} /> · {f.partName}
                  {f.serviceType && <span style={{ color: 'var(--slate-400)' }}> · {f.serviceType}</span>}
                </div>
                {st.saved ? <div style={{ fontSize: 12, color: 'var(--green-700)' }}>✓ Price added</div> : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--slate-400)' }}>$</span>
                    <input value={st.price} onChange={e => setForms(s => ({ ...s, [f.partId]: { ...st, price: e.target.value } }))}
                      placeholder="0.00" inputMode="decimal" style={{ ...inputStyle, width: 100 }} />
                    <button style={{ ...linkBtn, opacity: st.saving || !st.price.trim() ? 0.5 : 1 }}
                      disabled={st.saving || !st.price.trim()} onClick={() => submit(f.partId)}>
                      {st.saving ? 'Adding…' : 'Add price'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {data.truncated && <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>Only the most recently confirmed fitments were scanned — older ones may carry more.</div>}
        </div>
      )}
    </Panel>
  )
}
