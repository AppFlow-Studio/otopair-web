'use client'

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Modal } from '../Primitives'
import { SectionAnchor } from '../Shell'

const th: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase',
  textAlign: 'left', padding: '9px 14px', borderBottom: '1px solid var(--slate-200)',
  background: 'var(--slate-50)', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontSize: 13, color: 'var(--slate-800)', padding: '9px 14px',
  borderBottom: '1px solid var(--slate-100)', verticalAlign: 'top',
}

const fmtH = (h: number | null | undefined) => (h != null ? `${h.toFixed(1)}h` : '—')
const fmtBand = (b: number[] | null, prefix = '') =>
  b && b[0] != null ? `${prefix}${Math.round(b[0])}–${prefix}${Math.round(b[1])}` : '—'

function MatchBadge({ q, via }: { q: string | null; via: string | null }) {
  if (q === 'engine_sibling') return <Badge tone="orange" dot>sibling{via ? ` · ${via}` : ''}</Badge>
  return <Badge tone="green" dot>exact</Badge>
}

function Stat({ label, value, tone }: { label: string; value?: number | string; tone?: any }) {
  return (
    <Card style={{ minWidth: 140, flex: '0 0 auto' }}>
      <div style={{ fontSize: 11, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--slate-900)', marginTop: 4 }}>
        {value === undefined ? '…' : tone ? <Badge tone={tone}>{value}</Badge> : value}
      </div>
    </Card>
  )
}

export const TabRepairPalLabor = () => {
  const overview = useQuery(api.directorRepairpal.repairpalLaborOverview)
  const [openId, setOpenId] = useState<Id<'vehicle_configs'> | null>(null)

  return (
    <SectionAnchor
      id="repairpalLabor"
      title="RepairPal & Labor"
      subtitle="RepairPal estimate-endpoint data — the authoritative labor source when present (exact MOTOR flat-rate). Other sources shown only as corroboration."
    >
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <Stat label="Configs with data" value={overview?.configCount} />
        <Stat label="Estimate rows" value={overview?.totalRows} />
        <Stat label="Exact rows" value={overview?.exactRows} />
        <Stat label="Engine-sibling rows" value={overview?.siblingRows} />
        <Stat label="Services covered" value={overview?.serviceCount} />
        <Stat
          label="Endpoint labor live?"
          value={overview ? (overview.endpointLaborLive ? 'Yes' : 'No · flag off') : undefined}
          tone={overview ? (overview.endpointLaborLive ? 'green' : 'yellow') : undefined}
        />
      </div>

      <Card padded={false}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Vehicle</th>
              <th style={th}>Tier</th>
              <th style={th}>Services</th>
              <th style={th}>Match</th>
            </tr>
          </thead>
          <tbody>
            {(overview?.configs ?? []).map((c: any) => (
              <tr key={String(c.configId)} style={{ cursor: 'pointer' }} onClick={() => setOpenId(c.configId)}>
                <td style={td}>{[c.year, c.make, c.model, c.trim].filter(Boolean).join(' ')}</td>
                <td style={td}>{c.tier ?? '—'}</td>
                <td style={td}>{c.serviceCount}</td>
                <td style={td}><MatchBadge q={c.matchQuality} via={c.matchedVia} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {overview && overview.configs.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--slate-400)' }}>No RepairPal endpoint data yet.</div>
        )}
      </Card>

      {openId && <ConfigDetail configId={openId} onClose={() => setOpenId(null)} />}
    </SectionAnchor>
  )
}

function ConfigDetail({ configId, onClose }: { configId: Id<'vehicle_configs'>; onClose: () => void }) {
  const rows = useQuery(api.directorRepairpal.repairpalLaborByConfig, { vehicle_config_id: configId })
  return (
    <Modal
      open
      onClose={onClose}
      width={1140}
      eyebrow={<span>RepairPal endpoint — authoritative labor</span>}
      title="Per-service labor &amp; parts"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {rows === undefined ? (
        <div style={{ padding: 20, color: 'var(--slate-400)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, color: 'var(--slate-400)' }}>No endpoint rows for this config.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Service</th>
              <th style={th}>RP labor</th>
              <th style={th}>RP labor $</th>
              <th style={th}>Parts (role · $band)</th>
              <th style={th}>Variant / Match</th>
              <th style={th}>Current book (secondary)</th>
              <th style={th}>Corroboration</th>
            </tr>
          </thead>
          <tbody>
            {(rows as any[]).map((r) => {
              const pricedParts = r.rp.parts.filter((p: any) => p.role)
              return (
                <tr key={String(r.serviceId)}>
                  <td style={td}>{r.serviceName}</td>
                  <td style={{ ...td, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {r.rp.minutes != null ? `${r.rp.minutes}m / ${fmtH(r.rp.hours)}` : '—'}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtBand(r.rp.laborBand, '$')}</td>
                  <td style={td}>
                    {pricedParts.length === 0 ? '—' : pricedParts.map((p: any, i: number) => (
                      <div key={i} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {p.role}{p.position ? ` ${p.position}` : ''} · {fmtBand(p.band, '$')}{p.qty && p.qty > 1 ? ` ×${p.qty}` : ''}
                      </div>
                    ))}
                  </td>
                  <td style={td}>
                    <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>{r.rp.variant ?? '—'}</div>
                    <div style={{ marginTop: 4 }}><MatchBadge q={r.rp.matchQuality} via={r.rp.matchedVia} /></div>
                  </td>
                  <td style={td}>
                    {r.current ? (
                      <div style={{ color: 'var(--slate-500)' }}>
                        <span style={{ fontSize: 12 }}>{fmtH(r.current.bookHours)} ({r.current.source ?? '—'})</span>
                        {r.current.sourcesDisagree && (
                          <div style={{ marginTop: 3 }}><Badge tone="yellow">disagree</Badge></div>
                        )}
                      </div>
                    ) : <span style={{ color: 'var(--slate-400)' }}>none</span>}
                  </td>
                  <td style={{ ...td, fontSize: 11, color: 'var(--slate-500)' }}>
                    {r.corroboration.length === 0 ? '—' : r.corroboration.map((o: any) => `${o.source} ${o.hours}h`).join(', ')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
