'use client'

import { useState, useEffect, useRef, useContext } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import {
  Badge, Button, Card, Input, Select, Modal, AuditButton,
  tableStyles, IconSearch, IconX, IconCar, IconExternal, IconCheck,
} from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto, gotoEntity } from '../directorNav'
import { UserVehicleHistoryModal } from '../UserVehicleHistoryModal'
import { fmtDate } from '../Charts'
import { TiresSection } from '../TiresSection'
import { AdminActionPanel, ActionRow, Toast, ReasonPromptModal } from '../AdminActionPanel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { TierRuleModal } from './pricing/TierRuleModal'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ageLabel(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const hrs = Math.floor(diff / 3600000)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

const ENRICHMENT_TONE: Record<string, 'green' | 'yellow' | 'red' | 'slate' | 'blue'> = {
  verified:  'green',
  enriched:  'green',
  complete:  'green',
  partial:   'yellow',
  pending:   'yellow',
  in_progress: 'blue',
  failed:    'red',
  error:     'red',
  no_config: 'slate',
  unknown:   'slate',
}

/**
 * Pipeline writes fill_rate as a percent (0-100, see calculateV3FillRate).
 * A few legacy seed rows store it as a 0-1 ratio. Detect via threshold so
 * both display correctly without surfacing "8500%".
 */
const fmtFillRate = (rate?: number): string => {
  if (rate == null) return ''
  const pct = rate <= 1 ? rate * 100 : rate
  return `${Math.min(100, Math.round(pct))}%`
}

const enrichmentChip = (status: string, fillRate?: number) => {
  const tone = ENRICHMENT_TONE[status] ?? 'slate'
  const pct = fillRate != null ? ` · ${fmtFillRate(fillRate)}` : ''
  return <Badge tone={tone} dot>{status}{pct}</Badge>
}

// Pricing tier chip. Colour groups the 7 tiers the way the shop-facing
// labor-rate card does: mainstream / luxury / performance / exotic.
const TIER_TONE: Record<string, 'slate' | 'blue' | 'orange' | 'purple'> = {
  T1: 'slate',
  T2a: 'blue', T2b: 'blue', T2c: 'blue',
  T3a: 'orange', T3b: 'orange',
  T4: 'purple',
}

/**
 * `tier` = effective tier (persisted, else what the resolver would assign).
 * `source` ending in "_detected" means it was computed live but not yet
 * written to the config (persists on next quote / enrich). Null → the car
 * matches no rule → "Needs review".
 */
const tierChip = (tier?: string | null, source?: string | null) => {
  if (!tier) {
    return (
      <span title="No tier rule matches this vehicle — assign one to price it.">
        <Badge tone="red" dot>Needs review</Badge>
      </span>
    )
  }
  const detected = !!source && source.endsWith('_detected')
  return (
    <span
      title={
        detected
          ? 'Detected from rules — not yet saved (persists on next quote or enrichment)'
          : `Source: ${source ?? 'stored'}`
      }
    >
      <Badge
        tone={TIER_TONE[tier] ?? 'slate'}
        style={detected ? { opacity: 0.6, borderStyle: 'dashed' } : undefined}
      >
        {tier}
      </Badge>
    </span>
  )
}

type OwnerRow = {
  ownerId:    Id<'vehicle_owners'>
  userId:     Id<'users'>
  userName:   string
  userEmail?: string
  userPhone?: string
  status:     string
  isPrimary?: boolean
  nickname?:  string
  mileage?:   number
  ownership_type?: string
  usage_pattern?: string
  driving_conditions?: string
  annual_mileage_band?: string
  owner_segment?: string
  vehicle_mode?: string
}

type BookingRow = {
  id:        Id<'bookings'>
  shop:      string
  shopId?:   Id<'shops'>
  scheduled: string
  time:      string
  status:    string
  total:     number
  services:  string[]
  userName:  string
  userId:    Id<'users'>
  createdAt?: number
}

// ---------------------------------------------------------------------------
// Car drill-down modal
// ---------------------------------------------------------------------------

const CarModal = ({ carId, onClose }: { carId: Id<'vehicles'> | null; onClose: () => void }) => {
  const session   = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [auditOpen, setAuditOpen] = useState(false)
  const [drillUserId, setDrillUserId] = useState<Id<'users'> | null>(null)
  const [mileageOpen, setMileageOpen] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [ownerEditing,      setOwnerEditing]      = useState<{ id: Id<'vehicle_owners'>; user: string } | null>(null)
  const [ownerSpecsEditing, setOwnerSpecsEditing] = useState<{ id: Id<'vehicle_owners'>; user: string } | null>(null)
  const [tierRuleOpen,      setTierRuleOpen]      = useState(false)
  const [toast,      setToast]      = useState<string | null>(null)
  const serviceHistoryRef = useRef<HTMLDivElement>(null)
  const detail = useQuery(api.directorCars.carDetail, carId ? { id: carId } : 'skip')

  const updateMileage = useMutation(api.directorVehicleActions.updateVehicleMileage)
  const markVerified  = useMutation(api.directorVehicleActions.markVehicleVerified)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const rawAudit = useQuery(api.audit_log.listByEntity,
    carId ? { entity_type: 'vehicle', entity_id: carId, token: session?.token ?? '' } : 'skip')
  type AuditRow = { created_at: number; action: string; actor: string; detail?: string }
  const auditEntries = (rawAudit as AuditRow[] | undefined)?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  const handleVerify = async (reason: string) => {
    if (!carId) return
    await markVerified({ id: carId, note: reason, actorName, actorId })
    setToast('Vehicle marked verified.')
    setVerifyOpen(false)
  }

  return (
    <Modal open={!!carId} onClose={onClose} width={1100}
      eyebrow={detail && <>
        <span style={{ width:32, height:32, borderRadius:8, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-600)' }}>
          <IconCar size={16} />
        </span>
        <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{detail.vin}</span>
        {detail.enrichment && enrichmentChip(detail.enrichment.status, detail.enrichment.fillRate)}
      </>}
      title={detail?.ymmt ?? ''}
      headerRight={<AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />}
      auditDrawer={{
        open: auditOpen,
        onClose: () => setAuditOpen(false),
        title: 'Vehicle audit log',
        subtitle: detail ? `${detail.vin} · ${detail.ymmt}` : '',
        entries: auditEntries,
      }}
      footer={<Button onClick={onClose}>Close</Button>}>

      {!detail ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <>
          {/* Specs strip */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', borderBottom:'1px solid var(--slate-200)' }}>
            {[
              { label:'Year', value: detail.year ?? '—' },
              { label:'Make', value: detail.make },
              { label:'Model', value: detail.model },
              { label:'Trim', value: detail.trim },
            ].map(stat => (
              <div key={stat.label} style={{ padding:'14px 18px', borderRight:'1px solid var(--slate-100)' }}>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>{stat.label}</div>
                <div style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>{String(stat.value)}</div>
              </div>
            ))}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
            {/* Left: Specs (engine / transmission / chassis / trimSpecs) */}
            <div style={{ padding:22, borderRight:'1px solid var(--slate-100)' }}>
              <SpecsBlock title="Engine" empty={!detail.engine} rows={detail.engine ? [
                ['Code',              detail.engine.code],
                ['Family',            detail.engine.family],
                ['Configuration',     detail.engine.configuration],
                ['Cylinders',         detail.engine.cylinders],
                ['Displacement (L)',  detail.engine.displacement_l],
                ['Aspiration',        detail.engine.aspiration],
                ['Fuel type',         detail.engine.fuel_type],
                ['Fuel injection',    detail.engine.fuel_injection],
                ['Timing system',     detail.engine.timing_system],
                ['Oil viscosity',     detail.engine.oil_viscosity],
                ['Oil capacity (qts)', detail.engine.oil_capacity_qts],
                ['Coolant type',      detail.engine.coolant_type],
                ['Coolant cap. (qts)', detail.engine.coolant_capacity_qts],
                ['Spark plugs',       detail.engine.spark_plug_quantity],
                ['Spark plug gap (mm)', detail.engine.spark_plug_gap_mm],
                ['Water-pump on timing', detail.engine.water_pump_timing_driven],
                ['Data quality',      detail.engine.data_quality],
                ['Last enriched',     detail.engine.last_enriched_at && fmtDate(detail.engine.last_enriched_at)],
              ] : []} />

              <SpecsBlock title="Transmission" empty={!detail.transmission} rows={detail.transmission ? [
                ['Type',              detail.transmission.type],
                ['Code',              detail.transmission.code],
                ['Speeds',            detail.transmission.speeds],
                ['Manufacturer',      detail.transmission.manufacturer],
                ['Fluid type',        detail.transmission.fluid_type],
                ['Drain & fill (qts)', detail.transmission.fluid_capacity_drain_fill_qts],
                ['Lifetime fill',     detail.transmission.is_lifetime_fill],
                ['Serviceable filter', detail.transmission.has_serviceable_filter],
                ['Service method',    detail.transmission.service_method],
                ['Data quality',      detail.transmission.data_quality],
              ] : []} />

              <SpecsBlock title="Chassis & platform" empty={!detail.chassis && !detail.chassisSpecs} rows={[
                ...(detail.chassis ? [
                  ['Drivetrain',     detail.chassis.drivetrain_type],
                  ['Notes',          detail.chassis.notes],
                  ['Confidence',     detail.chassis.confidence_score],
                ] as [string, unknown][] : []),
                ...(detail.chassisSpecs ? [
                  ['Chassis code',   detail.chassisSpecs.chassis_code],
                  ['Brake fluid',    detail.chassisSpecs.brake_fluid_type],
                  ['Brake fluid cap (oz)', detail.chassisSpecs.brake_fluid_capacity_oz],
                  ['PS fluid',       detail.chassisSpecs.ps_fluid_type],
                  ['PS fluid cap (oz)', detail.chassisSpecs.ps_fluid_capacity_oz],
                  ['Lug-nut torque (ft-lbs)', detail.chassisSpecs.lug_nut_torque_ft_lbs],
                  ['Steering type',  detail.chassisSpecs.steering_type],
                  ['Parking brake',  detail.chassisSpecs.parking_brake_type],
                  ['Has rear wiper', detail.chassisSpecs.has_rear_wiper],
                  ['Wiper driver (in)', detail.chassisSpecs.wiper_blade_driver_size_in],
                  ['Wiper passenger (in)', detail.chassisSpecs.wiper_blade_passenger_size_in],
                  ['Wiper rear (in)', detail.chassisSpecs.wiper_blade_rear_size_in],
                  ['Battery group',  detail.chassisSpecs.battery_group],
                  ['Battery type',   detail.chassisSpecs.battery_type],
                  ['Brake pad sensor', detail.chassisSpecs.has_brake_pad_sensor],
                  ['Data quality',   detail.chassisSpecs.data_quality],
                  ['Last enriched',  detail.chassisSpecs.last_enriched_at && fmtDate(detail.chassisSpecs.last_enriched_at)],
                ] as [string, unknown][] : []),
              ]} />

              <TiresSection trim={detail.trimSpecs} passport={detail.passport?.tires} />
            </div>

            {/* Right: Enrichment + Passport + Owners + IDs */}
            <div style={{ padding:22, background:'var(--slate-25)' }}>
              {detail.vehicleConfig && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Enrichment" />
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    <Row k="Status" v={enrichmentChip(detail.vehicleConfig.enrichment_status ?? 'unknown', detail.vehicleConfig.fill_rate)} />
                    <Row k="Config key" v={<span className="mono" style={{ fontSize:11 }}>{detail.vehicleConfig.config_key}</span>} />
                    {detail.vehicleConfig.nhtsa_vin_key && <Row k="NHTSA VIN key" v={<span className="mono" style={{ fontSize:11 }}>{detail.vehicleConfig.nhtsa_vin_key}</span>} />}
                    {detail.vehicleConfig.chassis_code && <Row k="Chassis code" v={detail.vehicleConfig.chassis_code} />}
                    {detail.vehicleConfig.drivetrain && <Row k="Drivetrain" v={detail.vehicleConfig.drivetrain} />}
                    {detail.vehicleConfig.fill_rate != null && <Row k="Fill rate" v={fmtFillRate(detail.vehicleConfig.fill_rate)} />}
                    {detail.vehicleConfig.confidence_avg != null && <Row k="Confidence" v={detail.vehicleConfig.confidence_avg.toFixed(2)} />}
                    {detail.vehicleConfig.enrichment_version && <Row k="Version" v={<span className="mono" style={{ fontSize:11 }}>{detail.vehicleConfig.enrichment_version}</span>} />}
                    {detail.vehicleConfig.last_enriched_at && <Row k="Last enriched" v={`${fmtDate(detail.vehicleConfig.last_enriched_at)} (${ageLabel(detail.vehicleConfig.last_enriched_at)})`} />}
                    {detail.vehicleConfig.last_verified_at && <Row k="Last verified" v={fmtDate(detail.vehicleConfig.last_verified_at)} />}
                    {detail.vehicleConfig.verification_count != null && <Row k="Verifications" v={String(detail.vehicleConfig.verification_count)} />}
                  </div>
                  {detail.vehicleConfig.packages_available && detail.vehicleConfig.packages_available.length > 0 && (
                    <div style={{ marginTop:10 }}>
                      <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, marginBottom:6 }}>Available packages</div>
                      <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                        {detail.vehicleConfig.packages_available.map((p: { label: string }, i: number) => (
                          <Badge key={i} tone="purple">{p.label}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginBottom:18 }}>
                <SectionTitle label="Pricing tier" />
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  <Row k="Tier" v={tierChip(
                    detail.vehicleConfig?.pricing_tier ?? null,
                    detail.vehicleConfig?.pricing_tier_source ?? null,
                  )} />
                  {detail.vehicleConfig?.pricing_tier_source && (
                    <Row k="Source" v={<span className="mono" style={{ fontSize:11 }}>{detail.vehicleConfig.pricing_tier_source}</span>} />
                  )}
                </div>
                <div style={{ marginTop:10 }}>
                  <Button size="sm" variant="primary" onClick={() => setTierRuleOpen(true)}>Set tier rule</Button>
                </div>
                <div style={{ marginTop:6, fontSize:11, color:'var(--slate-500)', lineHeight:1.4 }}>
                  Creates a make / model / trim rule for this and every matching car. For a one-off
                  per-car change use Pricing → Vehicle assignments.
                </div>
              </div>

              {detail.passport && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label="Vehicle passport" />
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {detail.passport.mileage != null && <Row k="Mileage" v={`${detail.passport.mileage.toLocaleString()} mi`} />}
                    {detail.passport.mileage_velocity != null && <Row k="Velocity" v={`${detail.passport.mileage_velocity.toFixed(0)} mi/day`} />}
                    {detail.passport.last_reported_at && <Row k="Last report" v={fmtDate(detail.passport.last_reported_at)} />}
                    {detail.passport.last_shop_confirmed_at && <Row k="Last shop confirm" v={fmtDate(detail.passport.last_shop_confirmed_at)} />}
                  </div>
                </div>
              )}

              <div style={{ marginBottom:18 }}>
                <SectionTitle label={`Owners (${detail.owners.length})`} />
                {detail.owners.length === 0 ? (
                  <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No owners.</div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {(detail.owners as OwnerRow[]).map((o) => {
                      const profileBits = [
                        o.ownership_type,
                        o.usage_pattern,
                        o.driving_conditions,
                        o.annual_mileage_band,
                        o.vehicle_mode,
                      ].filter(Boolean) as string[]
                      return (
                        <div key={String(o.ownerId)} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:6, marginBottom:6 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
                              <span style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{o.userName}</span>
                              {o.isPrimary && <Badge tone="indigo">Primary</Badge>}
                              {o.status === 'removed' && <Badge tone="slate">Removed</Badge>}
                            </div>
                            <div style={{ display:'flex', gap:4 }}>
                              <Button size="sm" onClick={() => setDrillUserId(o.userId)}>History</Button>
                              <Button size="sm" iconRight={<IconExternal size={11} />} onClick={() => gotoEntity('users', String(o.userId))}>Profile</Button>
                            </div>
                          </div>
                          <div style={{ fontSize:11, color:'var(--slate-500)', display:'flex', gap:10, flexWrap:'wrap', marginBottom:6 }}>
                            {o.userEmail && <span>{o.userEmail}</span>}
                            {o.userPhone && <span className="mono">{o.userPhone}</span>}
                            {o.nickname && <span>"{o.nickname}"</span>}
                            {o.mileage != null && <span>{o.mileage.toLocaleString()} mi</span>}
                          </div>
                          {/* Driving profile snapshot */}
                          {profileBits.length > 0 && (
                            <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
                              {profileBits.map((b, i) => (
                                <span key={i} style={{ fontSize:10, color:'var(--slate-700)', background:'var(--slate-100)', padding:'2px 6px', borderRadius:4 }}>{b}</span>
                              ))}
                              {o.owner_segment && (
                                <span style={{ fontSize:10, color:'var(--indigo-700)', background:'var(--indigo-50)', padding:'2px 6px', borderRadius:4 }}>{o.owner_segment}</span>
                              )}
                            </div>
                          )}
                          {/* Per-owner edit buttons */}
                          <div style={{ display:'flex', gap:4, paddingTop:4, borderTop:'1px solid var(--slate-100)' }}>
                            <Button size="sm" onClick={() => setOwnerEditing({ id: o.ownerId, user: o.userName })}>Edit driver profile</Button>
                            <Button size="sm" onClick={() => setOwnerSpecsEditing({ id: o.ownerId, user: o.userName })}>Edit owner specs</Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Admin controls */}
              <div style={{ marginBottom:18 }}>
                <AdminActionPanel title="Admin controls"
                  subtitle="Every change is logged to the audit trail.">
                  <ActionRow label="Update mileage"
                    hint={detail.passport?.mileage != null ? `Current: ${detail.passport.mileage.toLocaleString()} mi` : 'No mileage recorded'}
                    action={<Button size="sm" onClick={() => setMileageOpen(true)}>Update</Button>} />
                  <ActionRow label="Service history"
                    hint={`${detail.bookingCount} booking${detail.bookingCount === 1 ? '' : 's'} on this VIN`}
                    action={<Button size="sm" onClick={() => serviceHistoryRef.current?.scrollIntoView({ behavior:'smooth', block:'start' })}>Jump ↓</Button>} />
                  {detail.vehicleConfig && (
                    <ActionRow label="Open vehicle config"
                      hint={`${detail.vehicleConfig.config_key} — edit engine / transmission / chassis / tire specs there`}
                      action={<Button size="sm" iconRight={<IconExternal size={11} />}
                        onClick={() => gotoEntity('configs', String(detail.vehicleConfig?.id))}>Open</Button>} />
                  )}
                  <ActionRow label="Mark VIN verified"
                    hint="Adds a director note + audit entry"
                    action={<Button size="sm" variant="primary" onClick={() => setVerifyOpen(true)}>Verify</Button>} />
                </AdminActionPanel>
              </div>

              <SectionTitle label="Raw IDs" />
              <div style={{ display:'flex', flexDirection:'column', gap:6, fontSize:11, color:'var(--slate-600)' }}>
                {detail.raw.engine_id        && <Row k="engine_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.raw.engine_id)}</span>} />}
                {detail.raw.transmission_id  && <Row k="transmission_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.raw.transmission_id)}</span>} />}
                {detail.raw.chassis_id       && <Row k="chassis_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.raw.chassis_id)}</span>} />}
                {detail.raw.trim_id          && <Row k="trim_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.raw.trim_id)}</span>} />}
                {detail.raw.vehicle_config_id && <Row k="vehicle_config_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.raw.vehicle_config_id)}</span>} />}
                {detail.raw.created_at && <Row k="created_at" v={fmtDate(detail.raw.created_at)} />}
                {detail.raw.updated_at && <Row k="updated_at" v={fmtDate(detail.raw.updated_at)} />}
              </div>
            </div>
          </div>

          {/* Service history */}
          <div ref={serviceHistoryRef} style={{ padding:22 }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>
              Service history — all bookings on this vehicle ({detail.bookingCount})
            </div>
            {detail.bookings.length === 0 ? (
              <div style={{ fontSize:13, color:'var(--slate-400)', fontStyle:'italic' }}>No bookings yet.</div>
            ) : (
              <div style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
                <div style={{ display:'grid', gridTemplateColumns:'110px 1fr 1fr 1fr 110px 100px', padding:'10px 12px', background:'var(--slate-25)', borderBottom:'1px solid var(--slate-200)', fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                  <span>Date</span><span>User</span><span>Services</span><span>Shop</span><span>Status</span><span style={{ textAlign:'right' }}>Total</span>
                </div>
                {(detail.bookings as BookingRow[]).map((b, i: number) => (
                  <div key={String(b.id)} style={{
                    display:'grid', gridTemplateColumns:'110px 1fr 1fr 1fr 110px 100px',
                    padding:'10px 12px', alignItems:'center',
                    borderBottom: i < detail.bookings.length - 1 ? '1px solid var(--slate-100)' : 'none',
                    fontSize:12, color:'var(--slate-700)',
                  }}>
                    <span className="mono">{fmtDate(b.scheduled)}</span>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.userName}</span>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.services.join(', ') || '—'}</span>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.shop}</span>
                    <span><Badge tone="slate" dot>{b.status}</Badge></span>
                    <span className="mono" style={{ textAlign:'right' }}>${(b.total ?? 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div style={{ padding:22, background:'var(--slate-25)', borderTop:'1px solid var(--slate-200)' }}>
            {carId && <DirectorNotesPanel entityType="vehicle" entityId={carId} placeholder="Add an internal note about this vehicle…" />}
          </div>

          {/* Nested drill: user history on this car */}
          <UserVehicleHistoryModal userId={drillUserId} vehicleId={carId} onClose={() => setDrillUserId(null)} />

          {/* Mileage update */}
          <MileageUpdateModal open={mileageOpen} onClose={() => setMileageOpen(false)}
            carId={carId} currentMileage={detail.passport?.mileage}
            actorName={actorName} actorId={actorId}
            onSaved={(m) => { setMileageOpen(false); setToast(`Mileage updated to ${m.toLocaleString()} mi.`) }}
            updateMileage={updateMileage} />

          {/* Verify confirmation */}
          <ReasonPromptModal open={verifyOpen} onClose={() => setVerifyOpen(false)}
            action="Mark Verified" onConfirm={handleVerify} />

          {/* Driver profile editor */}
          {ownerEditing && (
            <OwnerProfileEditModal
              ownerId={ownerEditing.id}
              userName={ownerEditing.user}
              actorName={actorName}
              actorId={actorId}
              onClose={() => setOwnerEditing(null)}
              onSaved={(n) => { setOwnerEditing(null); setToast(n > 0 ? `Saved ${n} profile change${n === 1 ? '' : 's'}.` : 'No changes.') }} />
          )}

          {/* Owner specs editor (tires actually on car + modifications + packages) */}
          {ownerSpecsEditing && (
            <OwnerSpecsEditModal
              ownerId={ownerSpecsEditing.id}
              userName={ownerSpecsEditing.user}
              actorName={actorName}
              actorId={actorId}
              onClose={() => setOwnerSpecsEditing(null)}
              onSaved={(n) => { setOwnerSpecsEditing(null); setToast(n > 0 ? `Saved ${n} owner-spec change${n === 1 ? '' : 's'}.` : 'No changes.') }} />
          )}

          {/* Make/model/trim tier rule, prefilled from this car */}
          <TierRuleModal
            open={tierRuleOpen}
            onClose={() => setTierRuleOpen(false)}
            prefill={{ make: detail.make, model: detail.model, trim: detail.trim }}
            onSaved={(msg) => { setTierRuleOpen(false); setToast(msg) }} />

          <Toast msg={toast} />
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// VehicleSpecEditModal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MileageUpdateModal
// ---------------------------------------------------------------------------

const MileageUpdateModal = ({
  open, onClose, carId, currentMileage, actorName, actorId, onSaved, updateMileage,
}: {
  open: boolean
  onClose: () => void
  carId: Id<'vehicles'> | null
  currentMileage?: number
  actorName: string
  actorId?: Id<'director_users'>
  onSaved: (m: number) => void
  updateMileage: ReturnType<typeof useMutation<typeof api.directorVehicleActions.updateVehicleMileage>>
}) => {
  const [m, setM] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setM(currentMileage != null ? String(currentMileage) : '')
  }, [open, currentMileage])

  const handle = async () => {
    if (!carId) return
    const num = Number(m)
    if (!isFinite(num) || num < 0) return
    setSaving(true)
    try {
      await updateMileage({ id: carId, mileage: num, actorName, actorId })
      onSaved(num)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={460}
      title="Update mileage"
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handle} disabled={saving || m.trim() === ''}>{saving ? 'Saving…' : 'Save mileage'}</Button>
      </>}>
      <div style={{ padding:22, display:'flex', flexDirection:'column', gap:12 }}>
        <div style={{ fontSize:12, color:'var(--slate-600)' }}>
          Patches the vehicle passport and the primary owner's recorded mileage. Audit-logged.
        </div>
        <div>
          <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Mileage</label>
          <Input value={m} onChange={e => setM(e.target.value)} placeholder="e.g. 47200" type="number" />
        </div>
      </div>
    </Modal>
  )
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div style={{ display:'grid', gridTemplateColumns:'140px 1fr', gap:8, alignItems:'center' }}>
    <span style={{ fontSize:11, color:'var(--slate-500)' }}>{k}</span>
    <span style={{ fontSize:12, color:'var(--slate-800)' }}>{v}</span>
  </div>
)

const SpecsBlock = ({ title, rows, empty }: { title: string; rows: [string, unknown][]; empty?: boolean }) => {
  const filled = rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (empty || filled.length === 0) {
    return (
      <div style={{ marginBottom:18 }}>
        <SectionTitle label={title} />
        <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No data resolved yet.</div>
      </div>
    )
  }
  return (
    <div style={{ marginBottom:18 }}>
      <SectionTitle label={title} />
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        {filled.map(([k, v]) => (
          <div key={k} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'6px 10px' }}>
            <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:2 }}>{k}</div>
            <div style={{ fontSize:12, color:'var(--slate-900)' }}>{String(v)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab shell
// ---------------------------------------------------------------------------

type CarRow = {
  id:           Id<'vehicles'>
  vin:          string
  ymm:          string
  year?:        number
  make:         string
  model:        string
  trim:         string
  image_url?:   string
  ownerId?:     Id<'users'>
  ownerName?:   string
  ownerEmail?:  string
  ownerCount:   number
  mileage?:     number
  bookingCount: number
  enrichment: {
    status:           string
    fillRate?:        number
    confidence?:      number
    lastEnrichedAt?:  number
  }
  pricing_tier?:   string | null
  tier_effective?: string | null
  tier_source?:    string | null
  createdAt?:   number
  updatedAt?:   number
}

// ---------------------------------------------------------------------------
// OwnerProfileEditModal — driving profile (vehicle_owners table)
// ---------------------------------------------------------------------------

const OwnerProfileEditModal = ({
  ownerId, userName, actorName, actorId, onClose, onSaved,
}: {
  ownerId: Id<'vehicle_owners'>
  userName: string
  actorName: string
  actorId?: Id<'director_users'>
  onClose: () => void
  onSaved: (changes: number) => void
}) => {
  const profile = useQuery(api.directorVehicleActions.getOwnerProfile, { ownerId })
  const update  = useMutation(api.directorVehicleActions.updateOwnerProfile)

  const [nickname, setNickname]     = useState('')
  const [mileage, setMileage]       = useState('')
  const [mileageAtPurchase, setMileageAtPurchase] = useState('')
  const [ownershipType, setOwnershipType] = useState('')
  const [ownershipDuration, setOwnershipDuration] = useState('')
  const [annualMileageBand, setAnnualMileageBand] = useState('')
  const [usagePattern, setUsagePattern] = useState('')
  const [avgMonthly, setAvgMonthly]   = useState('')
  const [drivingConditions, setDrivingConditions] = useState('')
  const [lastServiceWhen, setLastServiceWhen] = useState('')
  const [lastServiceWhat, setLastServiceWhat] = useState('')
  const [serviceLoc, setServiceLoc] = useState('')
  const [garageRole, setGarageRole] = useState('')
  const [ownershipPlan, setOwnershipPlan] = useState('')
  const [vehicleMode, setVehicleMode] = useState('')
  const [healthScore, setHealthScore] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profile) return
    const p = profile.profile
    setNickname(p.nickname ?? '')
    setMileage(p.mileage != null ? String(p.mileage) : '')
    setMileageAtPurchase(p.mileageAtPurchase != null ? String(p.mileageAtPurchase) : '')
    setOwnershipType(p.ownershipType ?? '')
    setOwnershipDuration(p.ownershipDuration ?? '')
    setAnnualMileageBand(p.annualMileageBand ?? '')
    setUsagePattern(p.usagePattern ?? '')
    setAvgMonthly(p.avgMonthlyDriving ?? '')
    setDrivingConditions(p.drivingConditions ?? '')
    setLastServiceWhen(p.lastServiceWhen ?? '')
    setLastServiceWhat(p.lastServiceWhat ?? '')
    setServiceLoc(p.serviceLocationPreference ?? '')
    setGarageRole(p.garageRole ?? '')
    setOwnershipPlan(p.ownership_plan ?? '')
    setVehicleMode(p.vehicle_mode ?? '')
    setHealthScore(p.health_score != null ? String(p.health_score) : '')
  }, [profile?.ownerId])

  const handleSave = async () => {
    setSaving(true)
    try {
      const n = (s: string) => s.trim() === '' ? undefined : Number(s)
      const res = await update({
        ownerId,
        nickname,
        mileage: n(mileage),
        mileageAtPurchase: n(mileageAtPurchase),
        ownershipType,
        ownershipDuration,
        annualMileageBand,
        usagePattern,
        avgMonthlyDriving: avgMonthly,
        drivingConditions,
        lastServiceWhen,
        lastServiceWhat,
        serviceLocationPreference: serviceLoc,
        garageRole,
        ownership_plan: ownershipPlan,
        vehicle_mode: vehicleMode,
        health_score: n(healthScore),
        actorName, actorId,
      })
      onSaved((res as any)?.changes ?? 0)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} width={720}
      title={`Driver profile — ${userName}`}
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving || !profile}>{saving ? 'Saving…' : 'Save profile'}</Button>
      </>}>
      {!profile ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <div style={{ padding:22, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          <ProfileField label="Nickname"><Input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="e.g. Daily driver" /></ProfileField>
          <ProfileField label="Ownership type">
            <Select value={ownershipType} onChange={e => setOwnershipType(e.target.value)}
              options={[
                { value:'', label:'(unchanged)' },
                { value:'owned',  label:'Owned' },
                { value:'leased', label:'Leased' },
                { value:'financed', label:'Financed' },
                { value:'company_car', label:'Company car' },
              ]} />
          </ProfileField>
          <ProfileField label="Mileage"><Input value={mileage} onChange={e => setMileage(e.target.value)} placeholder="e.g. 47200" type="number" /></ProfileField>
          <ProfileField label="Mileage at purchase"><Input value={mileageAtPurchase} onChange={e => setMileageAtPurchase(e.target.value)} placeholder="e.g. 12000" type="number" /></ProfileField>
          <ProfileField label="Ownership duration">
            <Select value={ownershipDuration} onChange={e => setOwnershipDuration(e.target.value)}
              options={[
                { value:'', label:'(unchanged)' },
                { value:'<1yr',  label:'< 1 year' },
                { value:'1-3yr', label:'1–3 years' },
                { value:'3-5yr', label:'3–5 years' },
                { value:'5+yr',  label:'5+ years' },
              ]} />
          </ProfileField>
          <ProfileField label="Annual mileage band">
            <Select value={annualMileageBand} onChange={e => setAnnualMileageBand(e.target.value)}
              options={[
                { value:'', label:'(unchanged)' },
                { value:'<5k',     label:'< 5,000' },
                { value:'5-10k',   label:'5,000–10,000' },
                { value:'10-15k',  label:'10,000–15,000' },
                { value:'15-25k',  label:'15,000–25,000' },
                { value:'25k+',    label:'25,000+' },
              ]} />
          </ProfileField>
          <ProfileField label="Usage pattern">
            <Select value={usagePattern} onChange={e => setUsagePattern(e.target.value)}
              options={[
                { value:'', label:'(unchanged)' },
                { value:'daily_commuter', label:'Daily commuter' },
                { value:'weekend_driver', label:'Weekend driver' },
                { value:'long_distance',  label:'Long distance' },
                { value:'occasional',     label:'Occasional' },
                { value:'rideshare',      label:'Rideshare / delivery' },
                { value:'track',          label:'Track / performance' },
              ]} />
          </ProfileField>
          <ProfileField label="Avg monthly driving">
            <Input value={avgMonthly} onChange={e => setAvgMonthly(e.target.value)} placeholder="e.g. ~1200 mi/mo" />
          </ProfileField>
          <ProfileField label="Driving conditions">
            <Select value={drivingConditions} onChange={e => setDrivingConditions(e.target.value)}
              options={[
                { value:'', label:'(unchanged)' },
                { value:'city',         label:'City' },
                { value:'highway',      label:'Highway' },
                { value:'mixed',        label:'Mixed' },
                { value:'severe',       label:'Severe (cold/dust/towing)' },
                { value:'off_road',     label:'Off-road' },
              ]} />
          </ProfileField>
          <ProfileField label="Vehicle mode">
            <Select value={vehicleMode} onChange={e => setVehicleMode(e.target.value)}
              options={[
                { value:'', label:'(unchanged)' },
                { value:'active',   label:'Active' },
                { value:'stored',   label:'Stored / seasonal' },
                { value:'for_sale', label:'For sale' },
                { value:'totaled',  label:'Totaled' },
                { value:'sold',     label:'Sold' },
              ]} />
          </ProfileField>
          <ProfileField label="Garage role">
            <Input value={garageRole} onChange={e => setGarageRole(e.target.value)} placeholder="e.g. Primary / Secondary" />
          </ProfileField>
          <ProfileField label="Ownership plan">
            <Select value={ownershipPlan} onChange={e => setOwnershipPlan(e.target.value)}
              options={[
                { value:'', label:'(unchanged)' },
                { value:'keep_long',  label:'Keep long-term' },
                { value:'trade_soon', label:'Trade in soon' },
                { value:'sell_soon',  label:'Sell soon' },
                { value:'lease_end',  label:'Lease ending' },
              ]} />
          </ProfileField>
          <ProfileField label="Last service when">
            <Input value={lastServiceWhen} onChange={e => setLastServiceWhen(e.target.value)} placeholder="e.g. 6 months ago" />
          </ProfileField>
          <ProfileField label="Last service what">
            <Input value={lastServiceWhat} onChange={e => setLastServiceWhat(e.target.value)} placeholder="e.g. Oil change + tires rotated" />
          </ProfileField>
          <ProfileField label="Service location pref.">
            <Input value={serviceLoc} onChange={e => setServiceLoc(e.target.value)} placeholder="e.g. Dealer / independent / chain" />
          </ProfileField>
          <ProfileField label="Health score (0-100)">
            <Input value={healthScore} onChange={e => setHealthScore(e.target.value)} placeholder="e.g. 86" type="number" />
          </ProfileField>
        </div>
      )}
    </Modal>
  )
}

const ProfileField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:500 }}>{label}</span>
    {children}
  </div>
)

// ---------------------------------------------------------------------------
// OwnerSpecsEditModal — vehicle_owner_specs (actual tires on car, mods, packages)
// ---------------------------------------------------------------------------

const OwnerSpecsEditModal = ({
  ownerId, userName, actorName, actorId, onClose, onSaved,
}: {
  ownerId: Id<'vehicle_owners'>
  userName: string
  actorName: string
  actorId?: Id<'director_users'>
  onClose: () => void
  onSaved: (changes: number) => void
}) => {
  const profile = useQuery(api.directorVehicleActions.getOwnerProfile, { ownerId })
  const update  = useMutation(api.directorVehicleActions.updateOwnerSpecs)

  const [frontBrand, setFrontBrand] = useState('')
  const [frontModel, setFrontModel] = useState('')
  const [frontSize,  setFrontSize]  = useState('')
  const [rearBrand,  setRearBrand]  = useState('')
  const [rearModel,  setRearModel]  = useState('')
  const [rearSize,   setRearSize]   = useState('')
  const [confirmed,  setConfirmed]  = useState<string>('')
  const [denied,     setDenied]     = useState<string>('')
  const [mods,       setMods]       = useState<Array<{ type: string; brand?: string; note?: string }>>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profile) return
    const s = profile.specs
    setFrontBrand(s?.tire_setup?.front?.brand ?? '')
    setFrontModel(s?.tire_setup?.front?.model ?? '')
    setFrontSize(s?.tire_setup?.front?.size ?? '')
    setRearBrand(s?.tire_setup?.rear?.brand ?? '')
    setRearModel(s?.tire_setup?.rear?.model ?? '')
    setRearSize(s?.tire_setup?.rear?.size ?? '')
    setConfirmed((s?.confirmed_packages ?? []).join(', '))
    setDenied((s?.denied_packages ?? []).join(', '))
    setMods(s?.modifications ?? [])
  }, [profile?.ownerId])

  const handleSave = async () => {
    setSaving(true)
    try {
      const splitCsv = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
      const res = await update({
        ownerId,
        tire_front_brand: frontBrand || undefined,
        tire_front_model: frontModel || undefined,
        tire_front_size:  frontSize  || undefined,
        tire_rear_brand:  rearBrand  || undefined,
        tire_rear_model:  rearModel  || undefined,
        tire_rear_size:   rearSize   || undefined,
        confirmed_packages: splitCsv(confirmed),
        denied_packages:    splitCsv(denied),
        modifications: mods.filter(m => m.type.trim() !== ''),
        actorName, actorId,
      })
      onSaved((res as any)?.changes ?? 0)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} width={720}
      title={`Owner specs — ${userName}`}
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving || !profile}>{saving ? 'Saving…' : 'Save specs'}</Button>
      </>}>
      {!profile ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <div style={{ padding:22, display:'flex', flexDirection:'column', gap:18 }}>
          <div>
            <SectionTitle label="Tires actually on this car" />
            <div style={{ fontSize:11, color:'var(--slate-500)', marginBottom:8 }}>
              Different from OEM fitment — what's currently mounted. Source will be marked as &quot;director&quot;.
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <ProfileField label="Front brand"><Input value={frontBrand} onChange={e => setFrontBrand(e.target.value)} placeholder="e.g. Michelin" /></ProfileField>
              <ProfileField label="Rear brand"><Input value={rearBrand} onChange={e => setRearBrand(e.target.value)} placeholder="e.g. Michelin" /></ProfileField>
              <ProfileField label="Front model"><Input value={frontModel} onChange={e => setFrontModel(e.target.value)} placeholder="e.g. Pilot Sport 4S" /></ProfileField>
              <ProfileField label="Rear model"><Input value={rearModel} onChange={e => setRearModel(e.target.value)} placeholder="e.g. Pilot Sport 4S" /></ProfileField>
              <ProfileField label="Front size"><Input value={frontSize} onChange={e => setFrontSize(e.target.value)} placeholder="245/40R19" /></ProfileField>
              <ProfileField label="Rear size"><Input value={rearSize} onChange={e => setRearSize(e.target.value)} placeholder="275/35R19" /></ProfileField>
            </div>
          </div>

          <div>
            <SectionTitle label="Package answers" />
            <div style={{ fontSize:11, color:'var(--slate-500)', marginBottom:8 }}>
              Comma-separated package codes. "Confirmed" = user said yes. "Denied" = permanent no.
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <ProfileField label="Confirmed packages">
                <Input value={confirmed} onChange={e => setConfirmed(e.target.value)} placeholder="e.g. m_performance, premium" />
              </ProfileField>
              <ProfileField label="Denied packages">
                <Input value={denied} onChange={e => setDenied(e.target.value)} placeholder="e.g. towing, off_road" />
              </ProfileField>
            </div>
          </div>

          <div>
            <SectionTitle label={`Modifications (${mods.length})`} right={
              <Button size="sm" onClick={() => setMods([...mods, { type: '' }])}>+ Add</Button>
            } />
            {mods.length === 0
              ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No modifications recorded.</div>
              : (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {mods.map((m, i) => (
                    <div key={i} style={{ display:'grid', gridTemplateColumns:'140px 1fr 1fr 36px', gap:6, alignItems:'center' }}>
                      <Select value={m.type} onChange={e => {
                        const next = [...mods]; next[i] = { ...m, type: e.target.value }; setMods(next)
                      }} options={[
                        { value:'', label:'Select…' },
                        { value:'exhaust', label:'Exhaust' },
                        { value:'intake',  label:'Intake' },
                        { value:'suspension', label:'Suspension' },
                        { value:'brakes',  label:'Brakes' },
                        { value:'wheels',  label:'Wheels' },
                        { value:'tune',    label:'Tune' },
                        { value:'other',   label:'Other' },
                      ]} />
                      <Input value={m.brand ?? ''} onChange={e => {
                        const next = [...mods]; next[i] = { ...m, brand: e.target.value }; setMods(next)
                      }} placeholder="Brand" />
                      <Input value={m.note ?? ''} onChange={e => {
                        const next = [...mods]; next[i] = { ...m, note: e.target.value }; setMods(next)
                      }} placeholder="Note" />
                      <Button size="sm" variant="danger" onClick={() => setMods(mods.filter((_, j) => j !== i))}>×</Button>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      )}
    </Modal>
  )
}

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

export const TabCars = () => {
  const [q, setQ] = useState('')
  const [enrichFilter, setEnrichFilter] = useState('all')
  const [makeFilter,   setMakeFilter]   = useState('all')
  const [tierFilter,   setTierFilter]   = useState('all')
  const [openId, setOpenId] = useState<Id<'vehicles'> | null>(null)

  useEffect(() => {
    const goto = consumeGoto()
    if (goto && goto.tab === 'cars') setOpenId(goto.entityId as Id<'vehicles'>)
  }, [])

  const cars = useQuery(api.directorCars.carsList, {}) as CarRow[] | undefined

  const makes = Array.from(new Set((cars ?? []).map(c => c.make).filter(m => m && m !== '—'))).sort()

  const filtered = (cars ?? []).filter(c => {
    if (makeFilter !== 'all' && c.make !== makeFilter) return false
    if (enrichFilter !== 'all' && c.enrichment.status !== enrichFilter) return false
    if (tierFilter !== 'all') {
      if (tierFilter === 'needs_review') { if (c.tier_effective) return false }
      else if (c.tier_effective !== tierFilter) return false
    }
    if (q) {
      const needle = q.toLowerCase()
      const hay = [c.vin, c.ymm, c.ownerName, c.ownerEmail, c.make, c.model, c.trim].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })

  const enrichOptions = (() => {
    const counts: Record<string, number> = {}
    for (const c of cars ?? []) counts[c.enrichment.status] = (counts[c.enrichment.status] ?? 0) + 1
    return [
      { value:'all', label:'All enrichment' },
      ...Object.entries(counts).map(([k, n]) => ({ value:k, label:`${k} (${n})` })),
    ]
  })()

  const tierOptions = (() => {
    const order = ['T1','T2a','T2b','T2c','T3a','T3b','T4']
    const counts: Record<string, number> = {}
    let needsReview = 0
    for (const c of cars ?? []) {
      if (c.tier_effective) counts[c.tier_effective] = (counts[c.tier_effective] ?? 0) + 1
      else needsReview++
    }
    return [
      { value:'all', label:'All tiers' },
      ...order.filter(t => counts[t]).map(t => ({ value:t, label:`${t} (${counts[t]})` })),
      ...(needsReview ? [{ value:'needs_review', label:`Needs review (${needsReview})` }] : []),
    ]
  })()

  const hasFilter = q || makeFilter !== 'all' || enrichFilter !== 'all' || tierFilter !== 'all'

  return (
    <SectionAnchor id="cars" title="Cars"
      subtitle={cars === undefined ? 'Loading…' : `${cars.length} vehicles in catalog · ${filtered.length} shown`}>

      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search VIN, YMM, owner…" style={{ width:320 }} />
        <Select value={makeFilter} onChange={e => setMakeFilter(e.target.value)}
          options={[{ value:'all', label:'All makes' }, ...makes.map(m => ({ value: m, label: m }))]} />
        <Select value={enrichFilter} onChange={e => setEnrichFilter(e.target.value)}
          options={enrichOptions} />
        <Select value={tierFilter} onChange={e => setTierFilter(e.target.value)}
          options={tierOptions} />
        <span style={{ flex:1 }} />
        {hasFilter && (
          <Button size="sm" onClick={() => { setQ(''); setMakeFilter('all'); setEnrichFilter('all'); setTierFilter('all') }}>
            <IconX size={12} /> Clear
          </Button>
        )}
      </div>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Vehicle</th>
            <th style={tableStyles.th}>VIN</th>
            <th style={tableStyles.th}>Owner</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Mileage</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Bookings</th>
            <th style={tableStyles.th}>Enrichment</th>
            <th style={tableStyles.th}>Tier</th>
            <th style={tableStyles.th}>Last enriched</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {cars === undefined
              ? <tr><td colSpan={9} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={9} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No vehicles match.</td></tr>
                : filtered.map(c => (
                  <tr key={String(c.id)} onClick={() => setOpenId(c.id)} style={{ cursor:'pointer' }}>
                    <td style={tableStyles.td}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ width:36, height:36, borderRadius:8, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)', overflow:'hidden' }}>
                          {c.image_url
                            ? <img src={c.image_url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                            : <IconCar size={18} />}
                        </span>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{c.ymm || '—'}</div>
                          <div style={{ fontSize:11, color:'var(--slate-500)' }}>{c.trim && c.trim !== '—' ? c.trim : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td style={tableStyles.td} className="mono">{c.vin}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>
                      {c.ownerName ? (
                        <div>
                          <div style={{ fontSize:13, color:'var(--slate-900)' }}>{c.ownerName}</div>
                          {c.ownerCount > 1 && <div style={{ fontSize:11, color:'var(--slate-500)' }}>+ {c.ownerCount - 1} more</div>}
                        </div>
                      ) : <span style={{ color:'var(--slate-400)' }}>Unowned</span>}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">
                      {c.mileage != null ? c.mileage.toLocaleString() : '—'}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{c.bookingCount}</td>
                    <td style={tableStyles.td}>{enrichmentChip(c.enrichment.status, c.enrichment.fillRate)}</td>
                    <td style={tableStyles.td}>{tierChip(c.tier_effective, c.tier_source)}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{ageLabel(c.enrichment.lastEnrichedAt)}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                      <Button size="sm" onClick={() => setOpenId(c.id)}>View</Button>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>

      <CarModal carId={openId} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
