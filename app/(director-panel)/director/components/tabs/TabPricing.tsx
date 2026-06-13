'use client'

import { useContext, useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Input, Select, IconSearch } from '../Primitives'
import { Toast } from '../AdminActionPanel'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { TierOverviewGrid } from './pricing/TierOverviewGrid'
import { MultiplierMatrix, type MatrixCell, type MatrixColumn, type MatrixRow } from './pricing/MultiplierMatrix'
import { BaselinesTable } from './pricing/BaselinesTable'
import { VehicleConfigTierModal } from './pricing/VehicleConfigTierModal'
import { FallbackHistoryModal } from './pricing/FallbackHistoryModal'

type SubTab = 'overview' | 'multipliers' | 'baselines' | 'assignments'

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'overview',    label: 'Overview' },
  { id: 'multipliers', label: 'Multipliers' },
  { id: 'baselines',   label: 'Baselines' },
  { id: 'assignments', label: 'Vehicle assignments' },
]

const TIERS = ['T1','T2a','T2b','T2c','T3a','T3b','T4'] as const

export const TabPricing = () => {
  const [sub, setSub] = useState<SubTab>('overview')
  const overview = useQuery(api.directorPricing.pricingOverview)
  const [pickedTier, setPickedTier] = useState<string>('T1')

  const handlePickTier = (code: string) => {
    setPickedTier(code)
    setSub('assignments')
  }

  return (
    <SectionAnchor id="pricing" title="Pricing & fallback tiers"
      subtitle={overview
        ? `${overview.totalVehicles.toLocaleString()} live vehicles · ${overview.totalConfigs.toLocaleString()} configs · ${overview.tiers.length} tiers`
        : 'Loading…'}>

      <div style={{ display:'flex', gap:6, marginBottom:14, borderBottom:'1px solid var(--slate-200)' }}>
        {SUB_TABS.map(t => {
          const active = sub === t.id
          return (
            <button key={t.id} onClick={() => setSub(t.id)}
              style={{ background:'none', border:'none', cursor:'pointer', padding:'10px 14px',
                fontSize:13, fontWeight:500, fontFamily:'inherit',
                color: active ? 'var(--slate-900)' : 'var(--slate-500)',
                borderBottom: `2px solid ${active ? 'var(--blue-600)' : 'transparent'}`,
                marginBottom:-1, transition:'color 120ms, border-color 120ms' }}>
              {t.label}
            </button>
          )
        })}
      </div>

      {sub === 'overview' && (
        overview === undefined
          ? <LoadingBlock />
          : <TierOverviewGrid
              tiers={overview.tiers}
              vehicleCounts={overview.vehicleCounts}
              configCounts={overview.configCounts}
              unassignedVehicles={overview.unassignedVehicles}
              unassignedConfigs={overview.unassignedConfigs}
              totalVehicles={overview.totalVehicles}
              totalConfigs={overview.totalConfigs}
              onPickTier={handlePickTier}
            />
      )}

      {sub === 'multipliers'  && <MultipliersSection />}
      {sub === 'baselines'    && <BaselinesTable />}
      {sub === 'assignments'  && <AssignmentsSection initialTier={pickedTier} />}
    </SectionAnchor>
  )
}

// ---------------------------------------------------------------------------
// Multipliers: switch between v1 (8-cat) / v2 parts (9-cat) / v2 labor (4-cat)
// ---------------------------------------------------------------------------

type HistoryTarget = {
  entityType: 'parts_multiplier' | 'labor_multiplier'
  entityId: string
  title: string
  subtitle: string
}

const MultipliersSection = () => {
  const [view, setView] = useState<'v1' | 'v2_parts' | 'v2_labor'>('v2_parts')
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [toast, setToast] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryTarget | null>(null)

  const v1     = useQuery(api.directorPricing.multipliersV1)
  const v2p    = useQuery(api.directorPricing.multipliersV2Parts)
  const v2l    = useQuery(api.directorPricing.multipliersV2Labor)
  const editV1 = useMutation(api.directorPricing.updateMultiplierV1)
  const editV2p = useMutation(api.directorPricing.updateMultiplierV2Parts)
  const editV2l = useMutation(api.directorPricing.updateMultiplierV2Labor)

  // v1 shape: cells use {tier_id, pricing_category_id}. We map tier_id → code for the row key.
  const v1Matrix = useMemo(() => {
    if (!v1) return null
    const tierCodeById = new Map(v1.tiers.map(t => [String(t.id), t.code]))
    const rows: MatrixRow[] = v1.tiers.map(t => ({ code: t.code, name: t.name }))
    const cols: MatrixColumn[] = v1.categories.map(c => ({ id: String(c.id), code: c.code, name: c.name }))
    const cells: MatrixCell[] = v1.cells.map(c => ({
      id:        String(c.id),
      rowCode:   tierCodeById.get(String(c.tier_id)) ?? '?',
      colId:     String(c.pricing_category_id),
      multiplier: c.multiplier,
      isLocked:  c.is_locked,
      notes:     c.notes,
    }))
    return { rows, cols, cells }
  }, [v1])

  const v2pMatrix = useMemo(() => {
    if (!v2p) return null
    const rows: MatrixRow[] = TIERS.map(code => ({ code }))
    const cols: MatrixColumn[] = v2p.categories.map(c => ({ id: String(c.id), code: c.code, name: c.name }))
    const cells: MatrixCell[] = v2p.cells.map(c => ({
      id:        String(c.id),
      rowCode:   c.tier,
      colId:     String(c.parts_category_id),
      multiplier: c.multiplier,
      source:    c.source,
    }))
    return { rows, cols, cells }
  }, [v2p])

  const v2lMatrix = useMemo(() => {
    if (!v2l) return null
    const rows: MatrixRow[] = TIERS.map(code => ({ code }))
    const cols: MatrixColumn[] = v2l.categories.map(c => ({ id: String(c.id), code: c.code, name: c.name }))
    const cells: MatrixCell[] = v2l.cells.map(c => ({
      id:        String(c.id),
      rowCode:   c.tier,
      colId:     String(c.labor_category_id),
      multiplier: c.multiplier,
      source:    c.source,
    }))
    return { rows, cols, cells }
  }, [v2l])

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <TabPill active={view === 'v2_parts'} onClick={() => setView('v2_parts')} label="v2 · Parts (9×7)" />
        <TabPill active={view === 'v2_labor'} onClick={() => setView('v2_labor')} label="v2 · Labor (4×7)" />
        <TabPill active={view === 'v1'}       onClick={() => setView('v1')}       label="v1 · Legacy (8×7)" />
        <span style={{ flex:1 }} />
      </div>

      {view === 'v1' && (
        v1Matrix === null
          ? <LoadingBlock />
          : <MultiplierMatrix
              title="Pricing v1 — legacy 8-category multipliers"
              subtitle="Applied at quote time pre-v2 cutover. is_locked freezes the cell at validated bookings count."
              rows={v1Matrix.rows}
              columns={v1Matrix.cols}
              cells={v1Matrix.cells}
              supportsLock
              onSave={async payload => {
                const res = await editV1({
                  id: payload.cellId as Id<'pricing_multipliers'>,
                  multiplier: payload.multiplier,
                  is_locked:  payload.is_locked,
                  actorName, actorId,
                })
                if (res.ok && res.changes) setToast(`v1 cell updated · ${payload.rowCode}`)
              }} />
      )}

      {view === 'v2_parts' && (
        v2pMatrix === null
          ? <LoadingBlock />
          : <MultiplierMatrix
              title="Pricing v2 — parts multipliers (May 29 2026 spec)"
              subtitle="9 parts categories × 7 tiers. Applied to the Camry OEM dealer-counter baseline. Click 🕐 to view history."
              rows={v2pMatrix.rows}
              columns={v2pMatrix.cols}
              cells={v2pMatrix.cells}
              onSave={async payload => {
                const res = await editV2p({
                  id: payload.cellId as Id<'pricing_parts_multipliers'>,
                  multiplier: payload.multiplier,
                  source:     payload.multiplier !== undefined ? 'empirical_correction' : undefined,
                  actorName, actorId,
                })
                if (res.ok && res.changes) setToast(`v2 parts cell updated · ${payload.rowCode}`)
              }}
              onShowHistory={cell => {
                const col = v2pMatrix.cols.find(c => c.id === cell.colId)
                setHistory({
                  entityType: 'parts_multiplier',
                  entityId: cell.id,
                  title: `History · Parts · ${col?.code ?? '?'} · ${cell.rowCode}`,
                  subtitle: `Current multiplier: ${cell.multiplier.toFixed(3)}${cell.source ? ' · ' + cell.source : ''}`,
                })
              }} />
      )}

      {view === 'v2_labor' && (
        v2lMatrix === null
          ? <LoadingBlock />
          : <MultiplierMatrix
              title="Pricing v2 — labor multipliers (May 29 2026 spec)"
              subtitle="4 labor categories × 7 tiers. Multiplied against Camry-anchored book hours. Click 🕐 to view history."
              rows={v2lMatrix.rows}
              columns={v2lMatrix.cols}
              cells={v2lMatrix.cells}
              onSave={async payload => {
                const res = await editV2l({
                  id: payload.cellId as Id<'pricing_labor_multipliers'>,
                  multiplier: payload.multiplier,
                  source:     payload.multiplier !== undefined ? 'empirical_correction' : undefined,
                  actorName, actorId,
                })
                if (res.ok && res.changes) setToast(`v2 labor cell updated · ${payload.rowCode}`)
              }}
              onShowHistory={cell => {
                const col = v2lMatrix.cols.find(c => c.id === cell.colId)
                setHistory({
                  entityType: 'labor_multiplier',
                  entityId: cell.id,
                  title: `History · Labor · ${col?.code ?? '?'} · ${cell.rowCode}`,
                  subtitle: `Current multiplier: ${cell.multiplier.toFixed(3)}${cell.source ? ' · ' + cell.source : ''}`,
                })
              }} />
      )}

      <Toast msg={toast} onDismiss={() => setToast(null)} />
      {history && (
        <FallbackHistoryModal
          entityType={history.entityType}
          entityId={history.entityId}
          title={history.title}
          subtitle={history.subtitle}
          onClose={() => setHistory(null)}
        />
      )}
    </>
  )
}

const TabPill = ({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) => (
  <button onClick={onClick}
    style={{ background: active ? 'var(--slate-900)' : '#fff',
      color: active ? '#fff' : 'var(--slate-700)',
      border: '1px solid ' + (active ? 'var(--slate-900)' : 'var(--slate-200)'),
      borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 500,
      fontFamily: 'inherit', cursor: 'pointer' }}>
    {label}
  </button>
)

// ---------------------------------------------------------------------------
// Assignments section — pick a tier, list its vehicle_configs, click to override.
// ---------------------------------------------------------------------------

const AssignmentsSection = ({ initialTier }: { initialTier: string }) => {
  const [tier,   setTier]   = useState<string>(initialTier)
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<Id<'vehicle_configs'> | null>(null)

  const data = useQuery(api.directorPricing.vehicleConfigsByTier, {
    tier: tier as any,
    search: search || undefined,
    limit: 250,
  })

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff',
        border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Select value={tier} onChange={e => setTier(e.target.value)}
          options={TIERS.map(t => ({ value: t, label: `Tier ${t}` }))} />
        <Input icon={<IconSearch size={14} />} value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search make, model, trim, chassis…" style={{ width:380 }} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {data === undefined
            ? 'Loading…'
            : `${data.rows.length} shown of ${data.total} in ${tier}`}
        </span>
      </div>

      <Card padded={false}>
        <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0 }}>
          <thead>
            <tr>
              <th style={th}>Vehicle</th>
              <th style={th}>Chassis</th>
              <th style={th}>Tier</th>
              <th style={th}>Source</th>
              <th style={{ ...th, textAlign:'right' }}># VINs</th>
              <th style={{ ...th, textAlign:'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data === undefined ? (
              <tr><td colSpan={6} style={{ ...td, textAlign:'center', color:'var(--slate-400)', padding:28 }}>Loading…</td></tr>
            ) : data.rows.length === 0 ? (
              <tr><td colSpan={6} style={{ ...td, textAlign:'center', color:'var(--slate-400)', padding:28 }}>No configs in {tier}.</td></tr>
            ) : data.rows.map(r => (
              <tr key={String(r.id)} onClick={() => setOpenId(r.id)} style={{ cursor:'pointer' }}>
                <td style={td}>
                  <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{r.year} {r.make} {r.model}</div>
                  <div style={{ fontSize:11, color:'var(--slate-500)' }}>{r.trim !== '—' ? r.trim : ''}</div>
                  <div className="mono" style={{ fontSize:10, color:'var(--slate-400)', marginTop:2, maxWidth:280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.config_key}</div>
                </td>
                <td style={{ ...td, color:'var(--slate-600)' }} className="mono">{r.chassis_code ?? '—'}</td>
                <td style={td}>{r.pricing_tier ? <Badge tone="purple">{r.pricing_tier}</Badge> : <span style={{ color:'var(--slate-400)' }}>—</span>}</td>
                <td style={td}>
                  {r.pricing_tier_source === 'manual'
                    ? <Badge tone="yellow" dot>manual</Badge>
                    : r.pricing_tier_source
                      ? <Badge tone="slate">{r.pricing_tier_source}</Badge>
                      : <span style={{ color:'var(--slate-400)' }}>—</span>}
                </td>
                <td style={{ ...td, textAlign:'right' }} className="mono">{r.vin_count}</td>
                <td style={{ ...td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                  <Button size="sm" onClick={() => setOpenId(r.id)}>Override</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <VehicleConfigTierModal vehicleConfigId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}

const LoadingBlock = () => (
  <div style={{ padding:32, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
)

const th: React.CSSProperties = {
  fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase' as const, letterSpacing:'0.04em',
  textAlign:'left' as const, padding:'10px 16px', borderBottom:'1px solid var(--slate-200)',
  background:'var(--slate-25)', whiteSpace:'nowrap' as const,
}
const td: React.CSSProperties = {
  fontSize:13, color:'var(--slate-800)', padding:'10px 16px', borderBottom:'1px solid var(--slate-100)',
  verticalAlign:'middle' as const,
}
