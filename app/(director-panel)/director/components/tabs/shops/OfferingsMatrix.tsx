'use client'

import { useContext, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Badge } from '../../Primitives'
import { LoadingBlock } from './shopsUi'
import { can } from '@/lib/portal/capabilities'
import type { OfferingsResult } from '@/convex/shopsOfferings'

// Services × shops offerings matrix with director toggle (shops.write).

type PendingToggle = { shopId: string; shopName: string; serviceId: string; serviceName: string; offered: boolean }

export const OfferingsMatrix = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const canWrite = can(session?.role, 'shops.write')

  const data = useQuery(api.shopsOfferings.matrix, { token }) as OfferingsResult | undefined
  const toggleOffering = useMutation(api.shopsOfferings.toggleOffering)

  const [pending, setPending] = useState<PendingToggle | null>(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (data === undefined) return <LoadingBlock label="offerings matrix" />

  const { shops, services } = data

  const offeredSet = new Set(
    services.flatMap(svc => svc.offered_by.map(sid => `${svc.service_id}:${sid}`))
  )

  const categories = [...new Set(services.map(s => s.category))]

  async function confirmToggle() {
    if (!pending || reason.trim().length < 4) { setErr('Reason required (4+ chars).'); return }
    setSaving(true); setErr(null)
    try {
      await toggleOffering({
        token,
        reason: reason.trim(),
        shopId: pending.shopId as Id<'shops'>,
        serviceId: pending.serviceId as Id<'services'>,
        offered: pending.offered,
      })
      setPending(null); setReason('')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Toggle failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* ── matrix ── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 500 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 12px 6px 0', fontWeight: 600, color: 'var(--slate-700)', minWidth: 180 }}>
                Service
              </th>
              {shops.map(sh => (
                <th key={sh.id} style={{ padding: '6px 8px', fontWeight: 500, color: 'var(--slate-500)', whiteSpace: 'nowrap', textAlign: 'center', maxWidth: 80 }}>
                  <span title={sh.name} style={{ display: 'inline-block', maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {sh.name.split(' ')[0]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map(cat => {
              const catServices = services.filter(s => s.category === cat)
              return [
                <tr key={`cat-${cat}`}>
                  <td colSpan={shops.length + 1} style={{ padding: '10px 0 4px', fontSize: 11, fontWeight: 700, color: 'var(--slate-400)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {cat}
                  </td>
                </tr>,
                ...catServices.map(svc => (
                  <tr key={svc.service_id} style={{ borderTop: '1px solid var(--slate-100)' }}>
                    <td style={{ padding: '5px 12px 5px 0', color: 'var(--slate-700)', whiteSpace: 'nowrap' }}>
                      {svc.name}
                      {svc.offered_by.length <= 1 && (
                        <Badge tone="yellow" style={{ marginLeft: 6 }}>Gap</Badge>
                      )}
                    </td>
                    {shops.map(sh => {
                      const key = `${svc.service_id}:${sh.id}`
                      const isOffered = offeredSet.has(key)
                      return (
                        <td key={sh.id} style={{ textAlign: 'center', padding: '3px 8px' }}>
                          {canWrite ? (
                            <button
                              onClick={() => {
                                setPending({ shopId: sh.id, shopName: sh.name, serviceId: svc.service_id, serviceName: svc.name, offered: !isOffered })
                                setReason(''); setErr(null)
                              }}
                              title={`${isOffered ? 'Disable' : 'Enable'} ${svc.name} at ${sh.name}`}
                              style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontSize: 14,
                                color: isOffered ? 'var(--green-600)' : 'var(--slate-300)',
                                fontWeight: isOffered ? 700 : 400 }}>
                              {isOffered ? '✓' : '—'}
                            </button>
                          ) : (
                            <span style={{ fontSize: 14, fontWeight: isOffered ? 700 : 400, color: isOffered ? 'var(--green-600)' : 'var(--slate-300)' }}>
                              {isOffered ? '✓' : '—'}
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )),
              ]
            })}
          </tbody>
        </table>
      </div>

      {/* ── coverage gaps ── */}
      {data.coverage_gaps.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-700)', marginBottom: 8 }}>
            Coverage gaps — offered by ≤1 shop
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.coverage_gaps.map(g => (
              <Badge key={g.service} tone={g.offered_by === 0 ? 'red' : 'yellow'}>
                {g.service} ({g.offered_by === 0 ? 'no shop' : '1 shop'})
              </Badge>
            ))}
          </div>
        </div>
      )}

      {!canWrite && (
        <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>
          Read-only — your role does not have shops.write permission.
        </div>
      )}

      {/* ── toggle confirm modal ── */}
      {pending && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) { setPending(null); setReason('') } }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,.18)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--slate-900)', marginBottom: 6 }}>
              {pending.offered ? 'Enable' : 'Disable'} offering
            </div>
            <div style={{ fontSize: 13, color: 'var(--slate-600)', marginBottom: 16 }}>
              <strong>{pending.serviceName}</strong> at <strong>{pending.shopName}</strong>
            </div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--slate-700)', display: 'block', marginBottom: 4 }}>
              Reason <span style={{ color: 'var(--red-500)' }}>*</span>
            </label>
            <input
              autoFocus
              value={reason}
              onChange={e => { setReason(e.target.value); setErr(null) }}
              placeholder="Required (4+ chars)"
              style={{ width: '100%', boxSizing: 'border-box', border: '1px solid var(--slate-300)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', marginBottom: 4 }}
            />
            {err && <div style={{ fontSize: 12, color: 'var(--red-600)', marginBottom: 8 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={() => { setPending(null); setReason('') }}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--slate-200)', background: '#fff', cursor: 'pointer', fontSize: 13, color: 'var(--slate-700)' }}>
                Cancel
              </button>
              <button onClick={confirmToggle} disabled={saving}
                style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                  background: pending.offered ? 'var(--green-600)' : 'var(--red-600)', color: '#fff', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : (pending.offered ? 'Enable' : 'Disable')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
