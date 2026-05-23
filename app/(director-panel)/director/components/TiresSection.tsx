'use client'

import { Badge } from './Primitives'

/**
 * TiresSection — shared renderer for tire data on the Car and Config drill-downs.
 *
 * Surfaces three layers:
 *   1. OEM-spec single fitment   — trim_specs.tire_size_front/rear + pressures
 *   2. OEM-spec available options — trim_specs.tire_options[] (every wheel
 *      package this trim ships with, OEM-standard vs optional, with brand,
 *      sizes, pressures, load index, speed rating, run-flat, wheel spec)
 *   3. What's currently installed (per-VIN only) — vehicle_passports.tires
 *      with brand/model/condition.
 */

export type TireOption = {
  oem_name?: string
  size_front: string
  size_rear?: string
  width_mm?: number
  aspect_ratio?: number
  rim_diameter_in?: number
  width_mm_rear?: number
  aspect_ratio_rear?: number
  rim_diameter_in_rear?: number
  pressure_front_psi?: number
  pressure_rear_psi?: number
  load_index?: number
  speed_rating?: string
  load_index_rear?: number
  speed_rating_rear?: string
  is_run_flat?: boolean
  is_oem_standard?: boolean
  wheel_spec?: string
}

export type TrimSpecsForTires = {
  tire_size_front?: string
  tire_size_rear?: string
  recommended_tire_pressure_front_psi?: number
  recommended_tire_pressure_rear_psi?: number
  is_staggered?: boolean
  tire_directional?: boolean
  is_run_flat?: boolean
  alignment_type?: string
  tire_options?: TireOption[]
  tire_options_source?: string
}

export type PassportTires = {
  brand?: string | null
  model?: string | null
  size_front?: string | null
  size_rear?: string | null
  run_flat?: boolean | null
  overall_condition?: string | null
  front_condition?: string | null
  rear_condition?: string | null
  last_verified_at?: number | null
}

const KV = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'6px 10px' }}>
    <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:2 }}>{k}</div>
    <div style={{ fontSize:12, color:'var(--slate-900)' }}>{v}</div>
  </div>
)

const conditionTone = (c?: string | null): 'green' | 'yellow' | 'red' | 'slate' => {
  if (!c) return 'slate'
  const lower = c.toLowerCase()
  if (lower.includes('new') || lower.includes('good')) return 'green'
  if (lower.includes('worn') || lower.includes('fair')) return 'yellow'
  if (lower.includes('bald') || lower.includes('replace') || lower.includes('poor')) return 'red'
  return 'slate'
}

function fmtDate(ts?: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
}

const TireOptionCard = ({ opt }: { opt: TireOption }) => (
  <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8, marginBottom:6 }}>
      <div style={{ minWidth:0 }}>
        {opt.oem_name && <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{opt.oem_name}</div>}
        <div className="mono" style={{ fontSize:12, color:'var(--slate-700)' }}>
          {opt.size_front}{opt.size_rear && opt.size_rear !== opt.size_front ? ` / ${opt.size_rear}` : ''}
        </div>
      </div>
      <div style={{ display:'flex', gap:4, flexWrap:'wrap', justifyContent:'flex-end' }}>
        {opt.is_oem_standard && <Badge tone="green">OEM standard</Badge>}
        {opt.is_oem_standard === false && <Badge tone="slate">Optional</Badge>}
        {opt.is_run_flat && <Badge tone="orange">Run-flat</Badge>}
      </div>
    </div>
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(120px, 1fr))', gap:4, fontSize:11, color:'var(--slate-700)' }}>
      {opt.pressure_front_psi != null && <div><span style={{ color:'var(--slate-500)' }}>Pressure F:</span> <span className="mono">{opt.pressure_front_psi} psi</span></div>}
      {opt.pressure_rear_psi != null && <div><span style={{ color:'var(--slate-500)' }}>Pressure R:</span> <span className="mono">{opt.pressure_rear_psi} psi</span></div>}
      {opt.load_index != null && <div><span style={{ color:'var(--slate-500)' }}>Load:</span> <span className="mono">{opt.load_index}</span>{opt.load_index_rear && opt.load_index_rear !== opt.load_index ? <span className="mono"> / {opt.load_index_rear}</span> : null}</div>}
      {opt.speed_rating && <div><span style={{ color:'var(--slate-500)' }}>Speed:</span> <span className="mono">{opt.speed_rating}</span>{opt.speed_rating_rear && opt.speed_rating_rear !== opt.speed_rating ? <span className="mono"> / {opt.speed_rating_rear}</span> : null}</div>}
      {opt.wheel_spec && <div><span style={{ color:'var(--slate-500)' }}>Wheel:</span> <span className="mono">{opt.wheel_spec}</span></div>}
    </div>
  </div>
)

export const TiresSection = ({ trim, passport }: {
  trim?: TrimSpecsForTires | null
  passport?: PassportTires | null
}) => {
  const hasTrim = !!trim && (
    trim.tire_size_front || trim.tire_size_rear ||
    (trim.tire_options && trim.tire_options.length > 0)
  )
  const hasPassport = !!passport && (passport.size_front || passport.brand || passport.overall_condition)

  if (!hasTrim && !hasPassport) {
    return (
      <div style={{ marginBottom:18 }}>
        <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:8 }}>Tires</div>
        <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No tire data resolved yet.</div>
      </div>
    )
  }

  const oemFlags: React.ReactNode[] = []
  if (trim?.is_staggered) oemFlags.push(<Badge key="staggered" tone="purple">Staggered</Badge>)
  if (trim?.is_run_flat) oemFlags.push(<Badge key="rf" tone="orange">Run-flat</Badge>)
  if (trim?.tire_directional) oemFlags.push(<Badge key="dir" tone="indigo">Directional</Badge>)
  if (trim?.alignment_type) oemFlags.push(<Badge key="al" tone="slate">Align: {trim.alignment_type}</Badge>)

  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Tires</span>
        {trim?.tire_options_source && (
          <span style={{ fontSize:10, color:'var(--slate-500)' }}>source: <span className="mono">{trim.tire_options_source}</span></span>
        )}
      </div>

      {/* OEM-spec single fitment + flags */}
      {hasTrim && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:6 }}>OEM fitment</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom: oemFlags.length > 0 ? 8 : 0 }}>
            {trim?.tire_size_front && <KV k="Size front" v={<span className="mono">{trim.tire_size_front}</span>} />}
            {trim?.tire_size_rear && <KV k="Size rear" v={<span className="mono">{trim.tire_size_rear}</span>} />}
            {trim?.recommended_tire_pressure_front_psi != null && <KV k="Pressure front" v={<span className="mono">{trim.recommended_tire_pressure_front_psi} psi</span>} />}
            {trim?.recommended_tire_pressure_rear_psi != null && <KV k="Pressure rear" v={<span className="mono">{trim.recommended_tire_pressure_rear_psi} psi</span>} />}
          </div>
          {oemFlags.length > 0 && (
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>{oemFlags}</div>
          )}
        </div>
      )}

      {/* OEM-spec multi-option list */}
      {trim?.tire_options && trim.tire_options.length > 0 && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:6 }}>
            Available OEM options ({trim.tire_options.length})
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {trim.tire_options.map((opt, i) => <TireOptionCard key={i} opt={opt} />)}
          </div>
        </div>
      )}

      {/* What's actually installed on this VIN (passport) */}
      {hasPassport && passport && (
        <div>
          <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:6 }}>Currently installed</div>
          <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'10px 12px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, marginBottom:6 }}>
              <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>
                {[passport.brand, passport.model].filter(Boolean).join(' ') || '—'}
              </div>
              {passport.overall_condition && (
                <Badge tone={conditionTone(passport.overall_condition)} dot>{passport.overall_condition}</Badge>
              )}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(120px, 1fr))', gap:4, fontSize:11, color:'var(--slate-700)' }}>
              {passport.size_front && <div><span style={{ color:'var(--slate-500)' }}>Size F:</span> <span className="mono">{passport.size_front}</span></div>}
              {passport.size_rear && <div><span style={{ color:'var(--slate-500)' }}>Size R:</span> <span className="mono">{passport.size_rear}</span></div>}
              {passport.run_flat && <div><Badge tone="orange">Run-flat</Badge></div>}
              {passport.front_condition && <div><span style={{ color:'var(--slate-500)' }}>Front:</span> {passport.front_condition}</div>}
              {passport.rear_condition && <div><span style={{ color:'var(--slate-500)' }}>Rear:</span> {passport.rear_condition}</div>}
              {passport.last_verified_at && <div><span style={{ color:'var(--slate-500)' }}>Last verified:</span> {fmtDate(passport.last_verified_at)}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
