'use client'

import { useState, useEffect, useRef, useContext } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import {
  Badge, Button, Card, Input, Select, Modal, AuditButton,
  tableStyles, IconSearch, IconX, IconCar, IconRefresh,
} from '../Primitives'
import { DirectorNotesPanel } from '../DirectorNotesPanel'
import { SectionAnchor } from '../Shell'
import { consumeGoto, gotoEntity } from '../directorNav'
import { TiresSection } from '../TiresSection'
import { AdminActionPanel, ActionRow, Toast } from '../AdminActionPanel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
}

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

const fmtFillRate = (rate?: number): string => {
  if (rate == null) return '—'
  const pct = rate <= 1 ? rate * 100 : rate
  return `${Math.min(100, Math.round(pct))}%`
}

const ENRICHMENT_TONE: Record<string, 'green' | 'yellow' | 'red' | 'slate' | 'blue'> = {
  verified:    'green',
  enriched:    'green',
  complete:    'green',
  partial:     'yellow',
  pending:     'yellow',
  in_progress: 'blue',
  failed:      'red',
  error:       'red',
  seeded:      'slate',
  unknown:     'slate',
}

const enrichmentChip = (status: string, fillRate?: number) => {
  const tone = ENRICHMENT_TONE[status] ?? 'slate'
  const pct = fillRate != null ? ` · ${fmtFillRate(fillRate)}` : ''
  return <Badge tone={tone} dot>{status}{pct}</Badge>
}

// "Bookable" is a stricter fact than "complete": every applicable core role
// carries a part AND a trusted price. The round-2 fleet read complete · 91%
// while spark plugs / ATF / battery had no part on file — the status chip
// alone was lying to whoever opened the booking flow. Renders nothing while
// either gaps query is still loading.
const bookabilityChip = (
  partGaps: number | undefined,
  priceGaps: number | undefined,
) => {
  if (partGaps == null || priceGaps == null) return null
  if (partGaps === 0 && priceGaps === 0) return <Badge tone="green">bookable</Badge>
  const bits = [
    partGaps > 0 ? `${partGaps} part${partGaps === 1 ? '' : 's'} missing` : null,
    priceGaps > 0 ? `${priceGaps} unpriced` : null,
  ].filter(Boolean).join(', ')
  return <Badge tone="orange">not bookable · {bits}</Badge>
}

// "3m ago" / "1h ago" / "Just now". Lower-resolution than ageLabel — used for
// the action-row pills where we want a glanceable freshness signal.
function relativeTime(ts?: number): string {
  if (!ts) return ''
  const diff = Math.max(0, Date.now() - ts)
  const secs = Math.floor(diff / 1000)
  if (secs < 30) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// Action-row status pill — derives the visual state from the most recent
// enrichment_runs row for this config. Clicking jumps to the matching row in
// the Enrichment runs section. Trigger is not yet distinct between
// 'full' and 'parts' clicks (single 'new_vehicle' string), so the same pill
// is shown next to both Re-enrich and Backfill parts buttons.
type RunStatusPillProps = {
  run: EnrichmentRunRow | undefined
  onClick?: () => void
}

const RunStatusPill = ({ run, onClick }: RunStatusPillProps) => {
  if (!run) return null
  const isRunning =
    run.completedAt == null && run.status !== 'complete' && run.status !== 'failed'
  const tone: 'green' | 'red' | 'blue' = isRunning
    ? 'blue'
    : run.status === 'failed'
    ? 'red'
    : 'green'
  const label = isRunning
    ? `Running ${relativeTime(run.startedAt ?? run.createdAt)}`
    : run.status === 'failed'
    ? `Failed ${relativeTime(run.completedAt ?? run.createdAt)}`
    : `Done ${relativeTime(run.completedAt ?? run.createdAt)}`
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, marginTop:4, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
      title={onClick ? 'Jump to run in Enrichment runs' : undefined}>
      <Badge tone={tone} dot>{label}</Badge>
    </span>
  )
}

// Reprice doesn't write enrichment_runs — only audit_log. The latest matching
// audit row's detail string carries the state: "scheduled" vs "complete" vs
// the error message. The pill renders read-only (no scroll target).
const RepriceStatusPill = ({ row }: { row: LatestRepriceAudit }) => {
  if (!row) return null
  const detail = row.detail ?? ''
  const failed = /error|failed|exception/i.test(detail)
  const scheduled = /scheduled/i.test(detail)
  const tone: 'green' | 'red' | 'blue' = failed ? 'red' : scheduled ? 'blue' : 'green'
  const label = failed
    ? `Failed ${relativeTime(row.createdAt)}`
    : scheduled
    ? `Running ${relativeTime(row.createdAt)}`
    : `Done ${relativeTime(row.createdAt)}`
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, marginTop:4 }}
      title={detail}>
      <Badge tone={tone} dot>{label}</Badge>
    </span>
  )
}

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div style={{ display:'grid', gridTemplateColumns:'160px 1fr', gap:8, alignItems:'center' }}>
    <span style={{ fontSize:11, color:'var(--slate-500)' }}>{k}</span>
    <span style={{ fontSize:12, color:'var(--slate-800)' }}>{v}</span>
  </div>
)

const GapPartAdder = ({
  gap,
  onAdd,
}: {
  gap: { serviceSlug: string; serviceName: string; roleKey: string; roleLabel: string }
  onAdd: (oemNumber: string, partName: string) => Promise<void>
}) => {
  const [oem, setOem] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!oem.trim() || busy) return
    setBusy(true)
    try { await onAdd(oem.trim(), name.trim()); setOem(''); setName('') }
    finally { setBusy(false) }
  }
  const inputStyle: React.CSSProperties = {
    border:'1px solid var(--slate-200)', borderRadius:6, padding:'6px 8px',
    fontSize:12, color:'var(--slate-800)', background:'#fff', minWidth:0,
  }
  return (
    <div style={{ border:'1px solid var(--amber-200, #fde68a)', background:'var(--amber-25, #fffbeb)', borderRadius:8, padding:'10px 12px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:8 }}>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--slate-700)', textTransform:'uppercase', letterSpacing:'0.06em' }}>
          {gap.serviceName} · {gap.roleLabel}
        </span>
        <Badge tone="yellow">no part on file</Badge>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1.4fr) minmax(0,1.6fr) 88px', gap:8, alignItems:'center' }}>
        <input value={oem} onChange={e => setOem(e.target.value)} placeholder="OEM part number" className="mono" style={inputStyle} />
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Part name (optional)" style={inputStyle} />
        <button
          onClick={submit}
          disabled={busy || !oem.trim()}
          style={{
            border:'none', borderRadius:6, padding:'7px 10px', fontSize:12, fontWeight:600,
            cursor: busy || !oem.trim() ? 'default' : 'pointer',
            background: busy || !oem.trim() ? 'var(--slate-200)' : 'var(--blue-600, #2563eb)',
            color: busy || !oem.trim() ? 'var(--slate-500)' : '#fff',
          }}
        >
          {busy ? 'Adding…' : 'Add part'}
        </button>
      </div>
    </div>
  )
}

const SpecsBlock = ({ title, rows, empty }: { title: string; rows: [string, unknown][]; empty?: boolean }) => {
  const filled = rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (empty || filled.length === 0) {
    return (
      <div style={{ marginBottom:18 }}>
        <SectionTitle label={title} />
        <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No data resolved.</div>
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
// OEM rotor minimum thickness.
//
// Deliberately NOT folded into SpecsBlock: that helper hides empty rows, and a
// MISSING minimum is the thing we most need visible — it's what tells the
// director this vehicle grades ungraded in the bay. Minimum and nominal are
// always shown apart and captioned, because a nominal ("330x22mm" → 22) read as
// a minimum makes healthy rotors read "Below min" and has us recommending brake
// jobs that aren't needed.
// ---------------------------------------------------------------------------

type RotorSpecs = {
  frontMinMm: number | null
  rearMinMm: number | null
  frontNominalMm: number | null
  rearNominalMm: number | null
  frontQuality: string | null
  rearQuality: string | null
  sourceUrl: string | null
  observedLabel: string | null
}

const ROTOR_QUALITY_BADGE: Record<string, { tone: string; label: string; title: string }> = {
  oem_spec:            { tone:'green',  label:'sourced',        title:'Read from a source that labelled it a minimum' },
  mechanic_read:       { tone:'green',  label:'read off rotor', title:'A mechanic read the number cast on the rotor hat' },
  director_verified:   { tone:'green',  label:'verified',       title:'A director confirmed this against a source link' },
  derived_from_nominal:{ tone:'orange', label:'est.',           title:'Derived from the nominal — NOT an OEM minimum. Never auto-recommends replacement.' },
  default_fallback:    { tone:'orange', label:'est.',           title:'Fallback estimate — NOT an OEM minimum.' },
}

const RotorAxleRow = ({ axle, minMm, nominalMm, quality }: {
  axle: string; minMm: number | null; nominalMm: number | null; quality: string | null
}) => {
  const badge = quality ? ROTOR_QUALITY_BADGE[quality] : undefined
  return (
    <div style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'8px 10px' }}>
      <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:4 }}>{axle}</div>
      {minMm != null ? (
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
          <span style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>{minMm.toFixed(1)} mm</span>
          {badge && <span title={badge.title}><Badge tone={badge.tone as never}>{badge.label}</Badge></span>}
        </div>
      ) : (
        <div style={{ fontSize:12, color:'var(--amber-700, #b45309)', marginBottom:4 }}>
          No OEM minimum on file
        </div>
      )}
      <div style={{ fontSize:11, color:'var(--slate-500)' }}>
        {nominalMm != null
          ? <>New thickness {nominalMm.toFixed(1)} mm <span style={{ fontStyle:'italic' }}>— not a minimum</span></>
          : <span style={{ color:'var(--slate-400)' }}>New thickness unknown</span>}
      </div>
    </div>
  )
}

const RotorSpecsBlock = ({ rotor, onBackfill, busy }: {
  rotor: RotorSpecs | null | undefined
  onBackfill?: () => void
  busy?: boolean
}) => {
  const r = rotor
  const nothing = !r || (r.frontMinMm == null && r.rearMinMm == null &&
    r.frontNominalMm == null && r.rearNominalMm == null)
  return (
    <div style={{ marginBottom:18 }}>
      <SectionTitle label="Brakes — OEM rotor minimum" right={onBackfill && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={onBackfill}>
          {busy ? 'Checking…' : 'Re-check cached page'}
        </Button>
      )} />
      {nothing ? (
        <div style={{ fontSize:12, color:'var(--slate-500)' }}>
          No OEM rotor minimum on file. Rotor readings are recorded but{' '}
          <strong>not graded</strong> in the inspection until one is supplied —
          add it with a source link, or a mechanic can enter the number cast on
          the rotor hat.
        </div>
      ) : (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <RotorAxleRow axle="Front" minMm={r!.frontMinMm} nominalMm={r!.frontNominalMm} quality={r!.frontQuality} />
            <RotorAxleRow axle="Rear"  minMm={r!.rearMinMm}  nominalMm={r!.rearNominalMm}  quality={r!.rearQuality} />
          </div>
          {(r!.observedLabel || r!.sourceUrl) && (
            <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8, marginTop:6, fontSize:11, color:'var(--slate-500)' }}>
              {r!.observedLabel && (
                // Verbatim, so a director can tell a real minimum from a bare
                // "Thickness" without opening the source.
                <span>Read under label: <span className="mono" style={{ color:'var(--slate-700)' }}>&ldquo;{r!.observedLabel}&rdquo;</span></span>
              )}
              {r!.sourceUrl && (
                <a href={r!.sourceUrl} target="_blank" rel="noreferrer" style={{ color:'var(--blue-700)' }}>
                  {(() => { try { return new URL(r!.sourceUrl!).hostname } catch { return 'source' } })()}
                </a>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail modal — every spec on a vehicle_config
// ---------------------------------------------------------------------------

type PackageInfo = {
  code: string
  label: string
  services_affected?: string[]
  detected_from?: string
  confidence?: number
}

type ServiceIntervalRow = {
  serviceName: string
  miles?: number
  months?: number
  confidence?: number
  verified?: boolean
  display?: string
  dataQuality?: string | null
  monthsSource?: string | null
}

type ManualRow = {
  id: string
  sourceUrl: string
  domain: string
  isOemDomain: boolean
  docKind: string
  pageCount?: number | null
  fileBytes?: number | null
  hasFile: boolean
  failureReason?: string | null
  attempts?: number | null
  rejectedCount: number
  fetchedAt: number
  expiresAt?: number | null
}

const MANUAL_DOC_KIND_LABEL: Record<string, string> = {
  owners_manual: "Owner's manual",
  maintenance_schedule: 'Maintenance schedule',
  warranty_guide: 'Warranty guide',
}

const fmtMb = (bytes?: number | null): string | null =>
  bytes == null ? null : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/** Mirrors MANUAL_REJECTION_PREFIX / MANUAL_MAX_REJECTIONS in manualLibrary.ts.
 *  A rejected-after-extraction row is NOT an ordinary failure: the PDF fetched
 *  and uploaded fine and was only unmasked as the wrong document once the
 *  extractor read it (the Forester that resolved a BRZ quick guide). Worth its
 *  own label, because "download failed" and "we had the wrong book" lead a
 *  director to completely different next steps. */
const MANUAL_REJECTED_PREFIX = 'rejected_after_extraction'
const MANUAL_MAX_REJECTIONS = 3
const isWrongDocument = (m: ManualRow): boolean =>
  !!m.failureReason?.startsWith(MANUAL_REJECTED_PREFIX)

/** True when the manual library is what produced this interval — either the
 *  whole row, or just its months (which carries its own provenance). */
const fromManual = (r: ServiceIntervalRow): boolean =>
  r.dataQuality === 'oem_manual' || r.monthsSource === 'oem_manual'

type LaborTimeRow = {
  serviceName: string
  hours: number | null
  source: string | null
  confidence: number | null
}

type FitmentSummaryRow = { service: string; count: number }

// Shapes returned by directorCars.vehicleConfigFitments / partFitmentDetail.
// Declared locally so the file compiles even when Convex codegen is mid-flight.
type FitmentItem = {
  fitmentId:        string
  partId:           string
  serviceType:      string
  packageCode:      string | null
  quantity:         number | null
  confidence:       number | null
  sourceCount:      number | null
  mechanicVerified: boolean
  partNumber:       string | null
  partName:         string | null
  brand:            string | null
  category:         string | null
  subcategory:      string | null
  partTier:         string | null
  priceCount:       number
}
type FitmentGroup = { service: string; items: FitmentItem[] }

type PartPriceRow = {
  price: number
  priceType: string | null
  sourceUrl: string | null
  sourceDomain: string | null
  refreshedAt: number | null
  msrp: number | null
  discount: number | null
}
type PartEvidenceRow = {
  field: string | null
  value: unknown
  sourceUrl: string | null
  sourceDomain: string | null
  sourceType: string | null
  confidence: number | null
  observedAt: number | null
  isLatest: boolean | null
}

type EnrichmentRunRow = {
  id: Id<'enrichment_runs'>
  version?: string
  trigger?: string
  status?: string
  fillRate?: number
  fieldsFilled?: number
  fieldsTotal?: number
  durationMs?: number
  startedAt?: number
  completedAt?: number
  createdAt?: number
  scrapeCacheHit?: boolean
  errors?: string[]
  fieldGaps?: { field: string; reason: string }[]
  totalTokensIn?: number
  totalTokensOut?: number
  estimatedCostUsd?: number
}

type VehicleSampleRow = {
  id:        Id<'vehicles'>
  vin:       string
  year?:     number
  createdAt?: number
}

type LatestRepriceAudit = {
  id: Id<'audit_log'>
  detail?: string
  createdAt: number
  actor?: string
} | null

// ---------------------------------------------------------------------------
// PartFitmentDrawerBody — drill-down into a single OEM part attached to this
// vehicle_config. Mirrors the ModalAuditDrawerBody chrome (header + scrollable
// body + footer) so the look matches the existing audit panel.
// ---------------------------------------------------------------------------

const PartFitmentDrawerBody = ({ partId, configId, onClose }: {
  partId: Id<'oem_parts'>
  configId: Id<'vehicle_configs'>
  onClose: () => void
}) => {
  const data = useQuery(api.directorCars.partFitmentDetail,
    { part_id: partId, vehicle_config_id: configId })

  const tierTone: Record<string, 'green' | 'blue' | 'yellow' | 'slate' | 'purple'> = {
    oem: 'green', performance: 'purple', aftermarket: 'blue', economy: 'yellow',
  }

  return (
    <>
      <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--slate-200)',
        background:'var(--slate-25)', borderRadius:'0 12px 0 0',
        display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:10, fontWeight:600, color:'var(--blue-600)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:4 }}>OEM part</div>
          <div className="mono" style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)', wordBreak:'break-all' }}>{data?.partNumber ?? '—'}</div>
          {data?.name && <div style={{ fontSize:12, color:'var(--slate-600)', marginTop:2 }}>{data.name}</div>}
        </div>
        <button onClick={onClose} style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--slate-500)', padding:4, borderRadius:6, display:'inline-flex' }}>
          <IconX size={18} />
        </button>
      </div>

      <div style={{ flex:1, overflowY:'auto', padding:18, display:'flex', flexDirection:'column', gap:18 }}>
        {!data ? (
          <div style={{ color:'var(--slate-400)', fontSize:12, textAlign:'center', padding:20 }}>Loading…</div>
        ) : (
          <>
            {/* Identity */}
            <div>
              <SectionTitle label="Identity" />
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {data.brand && <Row k="Brand" v={data.brand} />}
                {data.category && <Row k="Category" v={data.category} />}
                {data.subcategory && <Row k="Subcategory" v={data.subcategory} />}
                {data.partTier && <Row k="Tier" v={<Badge tone={tierTone[data.partTier] ?? 'slate'}>{data.partTier}</Badge>} />}
                {data.sourceCount != null && <Row k="Source count" v={String(data.sourceCount)} />}
              </div>
            </div>

            {/* Prices */}
            <div>
              <SectionTitle label={`Prices (${data.prices.length})`} />
              {data.prices.length === 0 ? (
                <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No prices recorded.</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {(data.prices as PartPriceRow[]).map((p: PartPriceRow, i: number) => (
                    <div key={i} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'8px 10px' }}>
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:4 }}>
                        <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>${p.price.toFixed(2)}</span>
                        {p.msrp != null && p.discount != null ? (
                          <span style={{ color:'var(--slate-500)', fontSize:11, marginLeft:6 }}>
                            (was ${p.msrp.toFixed(2)} · save ${p.discount.toFixed(2)})
                          </span>
                        ) : null}
                        {p.priceType && <Badge tone="slate">{p.priceType}</Badge>}
                      </div>
                      {(p.sourceDomain || p.sourceUrl) && (
                        <div style={{ fontSize:11, color:'var(--slate-600)', wordBreak:'break-all' }}>
                          {p.sourceUrl
                            ? <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color:'var(--blue-700)', textDecoration:'none' }}>{p.sourceDomain ?? p.sourceUrl}</a>
                            : p.sourceDomain}
                        </div>
                      )}
                      {p.refreshedAt && (
                        <div style={{ fontSize:10, color:'var(--slate-400)', marginTop:2 }}>{fmtDate(p.refreshedAt)} ({ageLabel(p.refreshedAt)})</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Evidence */}
            <div>
              <SectionTitle label={`Evidence (${data.evidence.length})`} />
              {data.evidence.length === 0 ? (
                <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No enrichment evidence for this config.</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {(data.evidence as PartEvidenceRow[]).map((e: PartEvidenceRow, i: number) => (
                    <div key={i} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'8px 10px' }}>
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:4 }}>
                        <span className="mono" style={{ fontSize:11, color:'var(--slate-700)' }}>{e.field ?? '—'}</span>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          {e.sourceType && <Badge tone="slate">{e.sourceType}</Badge>}
                          {e.confidence != null && <span className="mono" style={{ fontSize:10, color:'var(--slate-500)' }}>{e.confidence.toFixed(2)}</span>}
                        </div>
                      </div>
                      {e.value != null && (
                        <div className="mono" style={{ fontSize:11, color:'var(--slate-800)', marginBottom:4, wordBreak:'break-all' }}>{String(e.value)}</div>
                      )}
                      {(e.sourceDomain || e.sourceUrl) && (
                        <div style={{ fontSize:11, color:'var(--slate-600)', wordBreak:'break-all' }}>
                          {e.sourceUrl
                            ? <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color:'var(--blue-700)', textDecoration:'none' }}>{e.sourceDomain ?? e.sourceUrl}</a>
                            : e.sourceDomain}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div style={{ padding:'10px 18px', borderTop:'1px solid var(--slate-200)', fontSize:11, color:'var(--slate-500)',
        background:'var(--slate-25)', borderRadius:'0 0 12px 0' }}>
        Click any source link to verify provenance.
      </div>
    </>
  )
}

const ConfigModal = ({ configId, onClose }: { configId: Id<'vehicle_configs'> | null; onClose: () => void }) => {
  const session   = useContext(DirectorSessionCtx)
  // Every config-edit mutation + backfill action validates this server-side
  // and derives the audit actor from the session — actorName/actorId are no
  // longer accepted args anywhere in this modal.
  const sessionToken = session?.token ?? ''
  const [auditOpen, setAuditOpen] = useState(false)
  const [editOpen,  setEditOpen]  = useState(false)
  const [engineOpen,  setEngineOpen]  = useState(false)
  const [transOpen,   setTransOpen]   = useState(false)
  const [chassisOpen, setChassisOpen] = useState(false)
  const [trimOpen,    setTrimOpen]    = useState(false)
  const [partDrawerPartId, setPartDrawerPartId] = useState<Id<'oem_parts'> | null>(null)
  const [expandedServices, setExpandedServices] = useState<Set<string>>(new Set())
  const [toast,     setToast]     = useState<string | null>(null)
  const detail = useQuery(api.directorCars.vehicleConfigDetail,
    configId ? { id: configId } : 'skip')
  const fitments = useQuery(api.directorCars.vehicleConfigFitments,
    configId ? { vehicle_config_id: configId } : 'skip')
  const serviceGaps = useQuery(api.serviceParts.getServiceGapsForConfig,
    configId ? { vehicleConfigId: configId } : 'skip')
  const priceGaps = useQuery(api.serviceParts.getPriceGapsForConfig,
    configId ? { vehicleConfigId: configId } : 'skip')
  const addConfigFitment = useMutation(api.directorConfigActions.addConfigFitment)
  const updateBasics       = useMutation(api.directorConfigActions.updateConfigBasics)
  const updateEngine       = useMutation(api.directorConfigActions.updateEngineFields)
  const updateTransmission = useMutation(api.directorConfigActions.updateTransmissionFields)
  const updateChassisSpecs = useMutation(api.directorConfigActions.updateChassisSpecsFields)
  const updateTrimSpecs    = useMutation(api.directorConfigActions.updateTrimSpecsFields)
  const markVerified       = useMutation(api.directorConfigActions.markConfigVerified)
  const reEnrichConfig     = useAction(api.directorConfigBackfills.reEnrichConfig)
  const backfillConfigParts = useAction(api.directorConfigBackfills.backfillConfigParts)
  const repriceConfigParts = useAction(api.directorConfigBackfills.repriceConfigParts)
  const backfillRotorMinimums = useAction(api.directorConfigBackfills.backfillRotorMinimums)
  // Independent busy flags so one running backfill doesn't grey out the others.
  const [busyFull,   setBusyFull]   = useState(false)
  const [busyParts,  setBusyParts]  = useState(false)
  const [busyPrices, setBusyPrices] = useState(false)
  const [busyRotorMin, setBusyRotorMin] = useState(false)

  // Refs + highlight state for scrolling from the action-row pill to the
  // matching Enrichment runs row.
  const runsSectionRef = useRef<HTMLDivElement | null>(null)
  const runRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [highlightedRunId, setHighlightedRunId] = useState<string | null>(null)

  const jumpToLatestRun = () => {
    const latest = (detail?.enrichmentRuns as EnrichmentRunRow[] | undefined)?.[0]
    if (!latest) return
    runsSectionRef.current?.scrollIntoView({ behavior:'smooth', block:'start' })
    const row = runRowRefs.current[String(latest.id)]
    row?.scrollIntoView({ behavior:'smooth', block:'center' })
    setHighlightedRunId(String(latest.id))
  }
  useEffect(() => {
    if (!highlightedRunId) return
    const t = setTimeout(() => setHighlightedRunId(null), 1800)
    return () => clearTimeout(t)
  }, [highlightedRunId])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  // Reset drill-down + accordion state when the modal closes or jumps configs.
  useEffect(() => {
    setPartDrawerPartId(null)
    setExpandedServices(new Set())
  }, [configId])

  const toggleService = (service: string) => {
    setExpandedServices(prev => {
      const next = new Set(prev)
      if (next.has(service)) next.delete(service); else next.add(service)
      return next
    })
  }

  const rawAudit = useQuery(api.audit_log.listByEntity,
    configId ? { entity_type: 'vehicle_config', entity_id: configId, token: sessionToken } : 'skip')
  type AuditRow = { created_at: number; action: string; actor: string; detail?: string }
  const auditEntries = (rawAudit as AuditRow[] | undefined)?.map(e => ({
    timestamp: new Date(e.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
    action: e.action, actor: e.actor, detail: e.detail ?? '',
  }))

  const handleVerify = async () => {
    if (!configId) return
    const res = await markVerified({ id: configId, token: sessionToken })
    setToast(`Config marked verified. Total: ${(res as any)?.verifications ?? '?'}.`)
  }

  // --- Backfill triggers -----------------------------------------------------
  // All three kick off async jobs and return immediately so the click can't time
  // out; the toast confirms scheduling. Full + parts run a Claude batch (progress
  // in the enrichment-runs panel). Reprice runs a live scrape in a scheduled
  // internal action and records the priced count in the audit log when it lands.
  const handleReEnrich = async () => {
    if (!configId || busyFull) return
    if (!window.confirm('Re-enrich the ENTIRE car? Re-runs the full pipeline (engine, transmission, parts, intervals, labor) and overwrites resolved specs. Costs an LLM batch and finishes in a few minutes.')) return
    setBusyFull(true)
    try {
      const res = await reEnrichConfig({ id: configId, token: sessionToken }) as { status?: string; message?: string }
      setToast(res?.status === 'scheduled'
        ? 'Full re-enrich scheduled — check Enrichment runs in a few minutes.'
        : `Could not start: ${res?.message ?? res?.status ?? 'unknown'}.`)
    } catch (e) {
      setToast(`Re-enrich failed: ${(e as Error).message}`)
    } finally { setBusyFull(false) }
  }

  const handleBackfillParts = async () => {
    if (!configId || busyParts) return
    if (!window.confirm('Re-discover only this car’s PARTS (which parts apply per service)? Preserves hand-edited engine/transmission/chassis specs. Costs an LLM batch and finishes in a few minutes. Prices are not changed — use "Reprice parts" for that.')) return
    setBusyParts(true)
    try {
      const res = await backfillConfigParts({ id: configId, token: sessionToken }) as { status?: string; message?: string }
      setToast(res?.status === 'scheduled'
        ? 'Parts backfill scheduled — check Enrichment runs in a few minutes.'
        : `Could not start: ${res?.message ?? res?.status ?? 'unknown'}.`)
    } catch (e) {
      setToast(`Parts backfill failed: ${(e as Error).message}`)
    } finally { setBusyParts(false) }
  }

  const handleRepriceParts = async () => {
    if (!configId || busyPrices) return
    setBusyPrices(true)
    try {
      const res = await repriceConfigParts({ id: configId, token: sessionToken }) as { status?: string; message?: string }
      setToast(res?.status === 'scheduled'
        ? 'Reprice started — the priced count lands in the audit log in a moment.'
        : `Could not start: ${res?.message ?? res?.status ?? 'unknown'}.`)
    } catch (e) {
      setToast(`Reprice failed: ${(e as Error).message}`)
    } finally { setBusyPrices(false) }
  }

  // Re-parses the parts page ALREADY cached for this config with the
  // label-aware parser. No scrape, no LLM, no spend — so it is safe to run
  // freely. A page carrying only a nominal yields no minimum, by design.
  const handleBackfillRotorMin = async () => {
    if (!configId || busyRotorMin) return
    setBusyRotorMin(true)
    try {
      const res = await backfillRotorMinimums({ id: configId, token: sessionToken }) as
        { status?: string; message?: string; written?: number; hadCache?: boolean; outcomes?: string[] }
      if (res?.status !== 'done') {
        setToast(`Could not run: ${res?.message ?? res?.status ?? 'unknown'}.`)
      } else if ((res.written ?? 0) > 0) {
        setToast(`Rotor minimum backfilled — ${res.outcomes?.join(', ')}.`)
      } else {
        setToast(res.hadCache
          ? 'No rotor minimum in the cached page (it likely publishes only the new thickness).'
          : 'No cached parts page for this config — run a parts backfill first.')
      }
    } catch (e) {
      setToast(`Rotor minimum backfill failed: ${(e as Error).message}`)
    } finally { setBusyRotorMin(false) }
  }

  const ymmt = detail
    ? [detail.year, detail.make, detail.model, detail.trimName && detail.trimName !== '—' ? detail.trimName : null].filter(Boolean).join(' ')
    : ''

  return (
    <Modal open={!!configId} onClose={onClose} width={1140}
      eyebrow={detail && <>
        <span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--blue-700)' }}>{detail.configKey}</span>
        {enrichmentChip(detail.enrichment.status ?? 'unknown', detail.enrichment.fillRate)}
        {bookabilityChip(serviceGaps?.gaps.length, priceGaps?.gaps.length)}
        {detail.enrichment.version && <Badge tone="indigo">{detail.enrichment.version}</Badge>}
      </>}
      title={ymmt}
      headerRight={<AuditButton onClick={() => setAuditOpen(o => !o)} count={auditEntries?.length} />}
      auditDrawer={{
        open: auditOpen, onClose: () => setAuditOpen(false),
        title: 'Vehicle config audit log',
        subtitle: detail ? `${detail.configKey} · ${ymmt}` : '',
        entries: auditEntries,
      }}
      rightDrawer={{
        open: !!partDrawerPartId,
        onClose: () => setPartDrawerPartId(null),
        children: partDrawerPartId && configId
          ? <PartFitmentDrawerBody
              partId={partDrawerPartId}
              configId={configId}
              onClose={() => setPartDrawerPartId(null)}
            />
          : null,
      }}
      footer={<Button onClick={onClose}>Close</Button>}>
      {!detail ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <>
          {/* Top strip */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', borderBottom:'1px solid var(--slate-200)' }}>
            {[
              { label:'Year', value: detail.year ?? '—' },
              { label:'Make', value: detail.make },
              { label:'Model', value: detail.model },
              { label:'Trim', value: detail.trimName ?? '—' },
              { label:'Drivetrain', value: detail.drivetrain ?? '—' },
            ].map(stat => (
              <div key={stat.label} style={{ padding:'14px 18px', borderRight:'1px solid var(--slate-100)' }}>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>{stat.label}</div>
                <div style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)' }}>{String(stat.value)}</div>
              </div>
            ))}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', borderBottom:'1px solid var(--slate-200)' }}>
            {/* Left column: ALL specs */}
            <div style={{ padding:22, borderRight:'1px solid var(--slate-100)' }}>
              <SpecsBlock title="Engine" empty={!detail.engine} rows={detail.engine ? [
                ['Code',                  detail.engine.code],
                ['Family',                detail.engine.family],
                ['Configuration',         detail.engine.configuration],
                ['Cylinders',             detail.engine.cylinders],
                ['Displacement (L)',      detail.engine.displacement_l],
                ['Aspiration',            detail.engine.aspiration],
                ['Fuel type',             detail.engine.fuel_type],
                ['Fuel injection',        detail.engine.fuel_injection],
                ['Timing system',         detail.engine.timing_system],
                ['Oil viscosity',         detail.engine.oil_viscosity],
                ['Oil capacity (qts)',    detail.engine.oil_capacity_qts],
                ['Coolant type',          detail.engine.coolant_type],
                ['Coolant capacity (qts)', detail.engine.coolant_capacity_qts],
                ['Spark plugs',           detail.engine.spark_plug_quantity],
                ['Spark plug gap (mm)',   detail.engine.spark_plug_gap_mm],
                ['Water-pump on timing',  detail.engine.water_pump_timing_driven],
                ['Data quality',          detail.engine.data_quality],
                ['Last enriched',         detail.engine.last_enriched_at && fmtDate(detail.engine.last_enriched_at)],
              ] : []} />

              <SpecsBlock title="Transmission" empty={!detail.transmission} rows={detail.transmission ? [
                ['Type',                 detail.transmission.type],
                ['Code',                 detail.transmission.code],
                ['Speeds',               detail.transmission.speeds],
                ['Manufacturer',         detail.transmission.manufacturer],
                ['Fluid type',           detail.transmission.fluid_type],
                ['Drain & fill (qts)',   detail.transmission.fluid_capacity_drain_fill_qts],
                ['Lifetime fill',        detail.transmission.is_lifetime_fill],
                ['Serviceable filter',   detail.transmission.has_serviceable_filter],
                ['Service method',       detail.transmission.service_method],
                ['Data quality',         detail.transmission.data_quality],
              ] : []} />

              <SpecsBlock title="Drivetrain" empty={!detail.drivetrainConfig} rows={detail.drivetrainConfig ? [
                ['Drivetrain type',         detail.drivetrainConfig.drivetrain_type],
                ['Has differential',        detail.drivetrainConfig.has_differential],
                ['Diff fluid type',         detail.drivetrainConfig.diff_fluid_type],
                ['Diff fluid cap (qts)',    detail.drivetrainConfig.diff_fluid_capacity_qts],
                ['LSD additive required',   detail.drivetrainConfig.lsd_additive_required],
                ['Has transfer case',       detail.drivetrainConfig.has_transfer_case],
                ['TC fluid type',           detail.drivetrainConfig.tc_fluid_type],
                ['TC fluid cap (qts)',      detail.drivetrainConfig.tc_fluid_capacity_qts],
                ['Data quality',            detail.drivetrainConfig.data_quality],
              ] : []} />

              <SpecsBlock title="Chassis & platform" empty={!detail.chassisSpecs} rows={detail.chassisSpecs ? [
                ['Chassis code',          detail.chassisSpecs.chassis_code],
                ['Brake fluid',           detail.chassisSpecs.brake_fluid_type],
                ['Brake fluid cap (oz)',  detail.chassisSpecs.brake_fluid_capacity_oz],
                ['PS fluid',              detail.chassisSpecs.ps_fluid_type],
                ['PS fluid cap (oz)',     detail.chassisSpecs.ps_fluid_capacity_oz],
                ['Lug-nut torque (ft-lbs)', detail.chassisSpecs.lug_nut_torque_ft_lbs],
                ['Steering type',         detail.chassisSpecs.steering_type],
                ['Parking brake',         detail.chassisSpecs.parking_brake_type],
                ['Has rear wiper',        detail.chassisSpecs.has_rear_wiper],
                ['Wiper driver (in)',     detail.chassisSpecs.wiper_blade_driver_size_in],
                ['Wiper passenger (in)',  detail.chassisSpecs.wiper_blade_passenger_size_in],
                ['Wiper rear (in)',       detail.chassisSpecs.wiper_blade_rear_size_in],
                ['Battery group',         detail.chassisSpecs.battery_group],
                ['Battery type',          detail.chassisSpecs.battery_type],
                ['Brake-pad sensor',      detail.chassisSpecs.has_brake_pad_sensor],
                ['Data quality',          detail.chassisSpecs.data_quality],
                ['Last enriched',         detail.chassisSpecs.last_enriched_at && fmtDate(detail.chassisSpecs.last_enriched_at)],
              ] : []} />

              <RotorSpecsBlock rotor={detail.rotor} onBackfill={handleBackfillRotorMin} busy={busyRotorMin} />

              <TiresSection trim={detail.trimSpecs} />

              {/* Packages */}
              {detail.packages && detail.packages.length > 0 && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label={`Packages available (${detail.packages.length})`} />
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {(detail.packages as PackageInfo[]).map((p, i) => (
                      <div key={i} style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:8, padding:'8px 12px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{p.label}</div>
                            <div className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{p.code}</div>
                          </div>
                          {p.detected_from && <Badge tone="purple">{p.detected_from}</Badge>}
                          {p.confidence != null && <span style={{ fontSize:11, color:'var(--slate-500)' }} className="mono">{p.confidence.toFixed(2)}</span>}
                        </div>
                        {p.services_affected && p.services_affected.length > 0 && (
                          <div style={{ fontSize:11, color:'var(--slate-600)', marginTop:4 }}>
                            Affects: {p.services_affected.join(', ')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Service intervals */}
              {detail.serviceIntervals && detail.serviceIntervals.length > 0 && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle
                    label={`OEM service intervals (${detail.serviceIntervals.length})`}
                    right={detail.manualBackedIntervals > 0
                      ? <Badge tone="indigo">{detail.manualBackedIntervals} from manual</Badge>
                      : undefined}
                  />
                  <div style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
                    <div style={{ display:'grid', gridTemplateColumns:'1.6fr 90px 90px 100px 80px', padding:'8px 12px', background:'var(--slate-25)', borderBottom:'1px solid var(--slate-200)', fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                      <span>Service</span>
                      <span style={{ textAlign:'right' }}>Miles</span>
                      <span style={{ textAlign:'right' }}>Months</span>
                      <span style={{ textAlign:'center' }}>Verified</span>
                      <span style={{ textAlign:'right' }}>Conf.</span>
                    </div>
                    {(detail.serviceIntervals as ServiceIntervalRow[]).map((r, i) => (
                      <div key={i} style={{
                        display:'grid', gridTemplateColumns:'1.6fr 90px 90px 100px 80px',
                        padding:'8px 12px', alignItems:'center',
                        borderBottom: i < detail.serviceIntervals.length - 1 ? '1px solid var(--slate-100)' : 'none',
                        fontSize:12, color:'var(--slate-700)',
                      }}>
                        <span style={{ fontWeight:500, color:'var(--slate-900)', display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
                          <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.serviceName}</span>
                          {fromManual(r) && (
                            <span title={r.dataQuality === 'oem_manual'
                              ? 'Extracted from the OEM manual PDF'
                              : 'Months interval extracted from the OEM manual PDF'}>
                              <Badge tone="indigo">manual</Badge>
                            </span>
                          )}
                        </span>
                        <span className="mono" style={{ textAlign:'right' }}>{r.miles != null ? r.miles.toLocaleString() : '—'}</span>
                        <span className="mono" style={{ textAlign:'right' }}>{r.months ?? '—'}</span>
                        <span style={{ textAlign:'center' }}>{r.verified ? <Badge tone="green">✓</Badge> : <span style={{ color:'var(--slate-400)' }}>—</span>}</span>
                        <span className="mono" style={{ textAlign:'right' }}>{r.confidence != null ? r.confidence.toFixed(2) : '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* OEM manuals — the documents behind the "manual" interval rows
                  above. Keyed by year/make/model, so this is the same library
                  every config of this YMM shares. Failed lookups are listed on
                  purpose: an empty intervals table plus "wrong document" here
                  is a diagnosis, whereas silence is a mystery. */}
              {detail.manuals && detail.manuals.length > 0 && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle
                    label={`OEM manuals (${detail.manuals.length})`}
                    right={(() => {
                      // A rejected-after-extraction row still carries a file_id,
                      // so hasFile alone would overcount it as usable.
                      const usable = (detail.manuals as ManualRow[])
                        .filter(m => m.hasFile && !isWrongDocument(m)).length
                      return usable === 0
                        ? <Badge tone="yellow">none usable</Badge>
                        : <Badge tone="slate">{usable} usable</Badge>
                    })()}
                  />
                  <div style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
                    {(detail.manuals as ManualRow[]).map((m, i) => (
                      <div key={m.id} style={{
                        padding:'10px 12px',
                        borderBottom: i < detail.manuals.length - 1 ? '1px solid var(--slate-100)' : 'none',
                        background: m.hasFile && !isWrongDocument(m) ? 'transparent' : 'var(--slate-25)',
                      }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                          <span style={{ fontSize:12, fontWeight:600, color:'var(--slate-900)' }}>
                            {MANUAL_DOC_KIND_LABEL[m.docKind] ?? m.docKind}
                          </span>
                          {m.isOemDomain
                            ? <span title="Hosted on the manufacturer's own domain — the provenance tier that lets an extracted interval count as OEM-backed"><Badge tone="green">OEM domain</Badge></span>
                            : <span title="Third-party mirror — usable, but not manufacturer-hosted"><Badge tone="slate">mirror</Badge></span>}
                          {isWrongDocument(m)
                            ? <span title="Downloaded and uploaded fine, but the extractor found it was not this vehicle's manual"><Badge tone="red">wrong document</Badge></span>
                            : !m.hasFile && <Badge tone="yellow">not usable</Badge>}
                          {m.rejectedCount > 0 && (
                            <span title={m.rejectedCount >= MANUAL_MAX_REJECTIONS
                              ? `Rejection limit reached (${m.rejectedCount}) — the library has stopped retrying this vehicle until the negative cache expires`
                              : `${m.rejectedCount} URL(s) already tried and rejected, so a retry picks a different candidate`}>
                              <Badge tone={m.rejectedCount >= MANUAL_MAX_REJECTIONS ? 'yellow' : 'slate'}>
                                {m.rejectedCount} rejected{m.rejectedCount >= MANUAL_MAX_REJECTIONS ? ' · gave up' : ''}
                              </Badge>
                            </span>
                          )}
                        </div>

                        <div style={{ marginTop:4, fontSize:11, color:'var(--slate-500)', display:'flex', gap:10, flexWrap:'wrap' }}>
                          <span className="mono">{m.domain}</span>
                          {m.pageCount != null && <span>{m.pageCount} pp</span>}
                          {fmtMb(m.fileBytes) && <span>{fmtMb(m.fileBytes)}</span>}
                          <span>fetched {fmtDate(m.fetchedAt)}</span>
                          {m.attempts != null && m.attempts > 1 && <span>{m.attempts} attempts</span>}
                        </div>

                        {m.failureReason && (
                          <div style={{ marginTop:6, fontSize:11, color:'var(--amber-700, #b45309)' }}>
                            {m.failureReason}
                          </div>
                        )}

                        <div style={{ marginTop:6 }}>
                          <a
                            href={m.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize:11, color:'var(--indigo-600, #4f46e5)', wordBreak:'break-all' }}
                          >
                            {m.sourceUrl}
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Labor times — per-service book hours + source + confidence.
                  Confidence chip is colored by the 0.75 quote gate so it's
                  obvious which services have real (OLP-backed) labor vs the
                  tier-estimate fallback. */}
              {detail.laborTimes && detail.laborTimes.length > 0 && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label={`Labor times (${detail.laborTimes.length})`} />
                  <div style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
                    <div style={{ display:'grid', gridTemplateColumns:'1.6fr 80px 1fr 80px', padding:'8px 12px', background:'var(--slate-25)', borderBottom:'1px solid var(--slate-200)', fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                      <span>Service</span>
                      <span style={{ textAlign:'right' }}>Hours</span>
                      <span>Source</span>
                      <span style={{ textAlign:'right' }}>Conf.</span>
                    </div>
                    {(detail.laborTimes as LaborTimeRow[]).map((r, i) => (
                      <div key={i} style={{
                        display:'grid', gridTemplateColumns:'1.6fr 80px 1fr 80px',
                        padding:'8px 12px', alignItems:'center',
                        borderBottom: i < detail.laborTimes.length - 1 ? '1px solid var(--slate-100)' : 'none',
                        fontSize:12, color:'var(--slate-700)',
                      }}>
                        <span style={{ fontWeight:500, color:'var(--slate-900)' }}>{r.serviceName}</span>
                        <span className="mono" style={{ textAlign:'right' }}>{r.hours != null ? `${r.hours.toFixed(1)} h` : '—'}</span>
                        <span style={{ fontSize:11, color:'var(--slate-500)' }}>{r.source ?? '—'}</span>
                        <span style={{ textAlign:'right' }}>
                          {r.confidence != null
                            ? <Badge tone={r.confidence >= 0.75 ? 'green' : 'yellow'}>{r.confidence.toFixed(2)}</Badge>
                            : <span style={{ color:'var(--slate-400)' }}>—</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Missing parts — parts-requiring services this config has NO
                  usable OEM part for (dropped by OEM-strict enrichment, e.g. the
                  2001 740iA battery). Add the OEM number to make the service
                  available for booking + the mechanic pre-job flow. */}
              {configId && serviceGaps && serviceGaps.gaps.length > 0 && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle label={`Missing parts (${serviceGaps.gaps.length})`} />
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {serviceGaps.gaps.map((gap) => (
                      <GapPartAdder
                        key={`${gap.serviceSlug}:${gap.roleKey}`}
                        gap={gap}
                        onAdd={async (oemNumber, partName) => {
                          const res = await addConfigFitment({
                            vehicleConfigId: configId,
                            serviceSlug: gap.serviceSlug,
                            roleKey: gap.roleKey,
                            oemNumber,
                            partName: partName || undefined,
                            token: sessionToken,
                          })
                          if (res?.ok) setToast(`Added ${gap.roleLabel} — ${gap.serviceName} is now available`)
                          else setToast('Could not add part')
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Fitments — collapsible accordion per service. Default state
                  is compact (just headers + counts). Click a service header to
                  expand its parts inline; click a part row to open the right
                  drawer with full part details + sources. */}
              {fitments && fitments.total > 0 && (
                <div style={{ marginBottom:18 }}>
                  <SectionTitle
                    label={`Part fitments (${fitments.total})`}
                    right={
                      <button
                        onClick={() => {
                          const all = (fitments.groups as FitmentGroup[]).map(g => g.service)
                          setExpandedServices(prev => prev.size === all.length ? new Set() : new Set(all))
                        }}
                        style={{ border:'none', background:'transparent', cursor:'pointer', fontSize:11, color:'var(--blue-700)', padding:'2px 6px' }}
                      >
                        {expandedServices.size === fitments.groups.length ? 'Collapse all' : 'Expand all'}
                      </button>
                    }
                  />
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {(fitments.groups as FitmentGroup[]).map((group: FitmentGroup) => {
                      const isOpen = expandedServices.has(group.service)
                      const basePartCount   = group.items.filter(it => it.packageCode == null).length
                      const pkgVariantCount = group.items.length - basePartCount
                      return (
                        <div key={group.service} style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden', background:'#fff' }}>
                          <button
                            onClick={() => toggleService(group.service)}
                            style={{
                              width:'100%', textAlign:'left', cursor:'pointer',
                              display:'flex', alignItems:'center', justifyContent:'space-between',
                              padding:'8px 12px', background:'var(--slate-25)',
                              // Split into longhands — React warns when mixing
                              // `border` shorthand with `borderBottom` longhand
                              // in the same style object.
                              borderTop:'none', borderLeft:'none', borderRight:'none',
                              borderBottom: isOpen ? '1px solid var(--slate-200)' : 'none',
                              borderTopLeftRadius:8, borderTopRightRadius:8,
                              borderBottomLeftRadius: isOpen ? 0 : 8, borderBottomRightRadius: isOpen ? 0 : 8,
                              fontSize:12, color:'var(--slate-800)', transition:'background 80ms',
                            }}
                          >
                            <span style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                              <span style={{ display:'inline-block', width:10, color:'var(--slate-500)', fontSize:10, lineHeight:1 }}>{isOpen ? '▾' : '▸'}</span>
                              <span style={{ fontSize:11, fontWeight:600, color:'var(--slate-700)', textTransform:'uppercase', letterSpacing:'0.06em' }}>{group.service}</span>
                              {pkgVariantCount > 0 && (
                                <Badge tone="purple">{pkgVariantCount} pkg variant{pkgVariantCount === 1 ? '' : 's'}</Badge>
                              )}
                            </span>
                            <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{group.items.length}</span>
                          </button>
                          {isOpen && (
                            <div>
                              {group.items.map((it: FitmentItem, i: number) => {
                                const isSelected = partDrawerPartId === (it.partId as unknown as Id<'oem_parts'>)
                                return (
                                  <button
                                    key={it.fitmentId}
                                    onClick={() => setPartDrawerPartId(it.partId as unknown as Id<'oem_parts'>)}
                                    style={{
                                      width:'100%', textAlign:'left', cursor:'pointer',
                                      display:'grid', gridTemplateColumns:'minmax(0, 2fr) minmax(0, 2fr) 110px 60px 70px',
                                      gap:10, padding:'8px 12px', alignItems:'center',
                                      borderTop:'none', borderLeft:'none', borderRight:'none',
                                      borderBottom: i < group.items.length - 1 ? '1px solid var(--slate-100)' : 'none',
                                      background: isSelected ? 'var(--blue-50)' : '#fff',
                                      fontSize:12, color:'var(--slate-800)', transition:'background 80ms',
                                    }}
                                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'var(--slate-25)' }}
                                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = '#fff' }}
                                  >
                                    <span className="mono" style={{ fontWeight:600, color:'var(--slate-900)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                      {it.partNumber ?? '—'}
                                    </span>
                                    <span style={{ color:'var(--slate-700)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                      {it.partName ?? '—'}
                                      {it.brand && <span style={{ color:'var(--slate-400)', marginLeft:6 }}>· {it.brand}</span>}
                                    </span>
                                    <span>
                                      {it.packageCode
                                        ? <Badge tone="purple">{it.packageCode}</Badge>
                                        : <Badge tone="slate">base</Badge>}
                                    </span>
                                    <span className="mono" style={{ textAlign:'right', color:'var(--slate-500)' }}>
                                      {it.quantity != null ? `×${it.quantity}` : '—'}
                                    </span>
                                    <span className="mono" style={{ textAlign:'right', color:'var(--slate-500)' }}>
                                      {it.confidence != null ? it.confidence.toFixed(2) : '—'}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Right column: enrichment + IDs + vehicles using this config */}
            <div style={{ padding:22, background:'var(--slate-25)' }}>
              <div style={{ marginBottom:18 }}>
                <SectionTitle label="Enrichment" />
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  <Row k="Status"           v={enrichmentChip(detail.enrichment.status ?? 'unknown', detail.enrichment.fillRate)} />
                  <Row k="Config key"       v={<span className="mono" style={{ fontSize:11 }}>{detail.configKey}</span>} />
                  {detail.nhtsaVinKey && <Row k="NHTSA VIN key" v={<span className="mono" style={{ fontSize:11 }}>{detail.nhtsaVinKey}</span>} />}
                  {detail.chassisCode && <Row k="Chassis code" v={detail.chassisCode} />}
                  {detail.enrichment.fillRate != null && <Row k="Fill rate" v={fmtFillRate(detail.enrichment.fillRate)} />}
                  {detail.enrichment.confidenceAvg != null && <Row k="Avg confidence" v={detail.enrichment.confidenceAvg.toFixed(2)} />}
                  {detail.enrichment.version && <Row k="Pipeline version" v={<span className="mono" style={{ fontSize:11 }}>{detail.enrichment.version}</span>} />}
                  {detail.enrichment.lastEnrichedAt && <Row k="Last enriched" v={`${fmtDate(detail.enrichment.lastEnrichedAt)} (${ageLabel(detail.enrichment.lastEnrichedAt)})`} />}
                  {detail.enrichment.lastVerifiedAt && <Row k="Last verified" v={fmtDate(detail.enrichment.lastVerifiedAt)} />}
                  {detail.enrichment.verificationCount != null && <Row k="Verifications" v={String(detail.enrichment.verificationCount)} />}
                </div>
              </div>

              {detail.enrichmentRuns && detail.enrichmentRuns.length > 0 && (
                <div style={{ marginBottom:18 }} ref={runsSectionRef}>
                  <SectionTitle label={`Enrichment runs (${detail.enrichmentRuns.length})`} />
                  <div style={{ maxHeight:220, overflowY:'auto', display:'flex', flexDirection:'column', gap:6 }}>
                    {(detail.enrichmentRuns as EnrichmentRunRow[]).map(run => (
                      <div key={String(run.id)}
                        ref={(el) => { runRowRefs.current[String(run.id)] = el }}
                        style={{
                          background: highlightedRunId === String(run.id) ? 'var(--blue-50, #EFF6FF)' : '#fff',
                          border: `1px solid ${highlightedRunId === String(run.id) ? 'var(--blue-300, #93C5FD)' : 'var(--slate-200)'}`,
                          borderRadius:6, padding:'6px 10px',
                          transition: 'background 220ms ease, border-color 220ms ease',
                        }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6 }}>
                          <Badge tone={run.status === 'complete' ? 'green' : run.status === 'failed' ? 'red' : 'slate'} dot>{run.status ?? 'unknown'}</Badge>
                          <span className="mono" style={{ fontSize:11, color:'var(--slate-500)' }}>{fmtDate(run.createdAt)}</span>
                        </div>
                        <div style={{ fontSize:11, color:'var(--slate-600)', marginTop:3, display:'flex', flexWrap:'wrap', gap:8 }}>
                          {run.version && <span>{run.version}</span>}
                          {run.trigger && <span>· {run.trigger}</span>}
                          {run.fillRate != null && <span>· {fmtFillRate(run.fillRate)}</span>}
                          {run.fieldsFilled != null && run.fieldsTotal != null && <span>· {run.fieldsFilled}/{run.fieldsTotal} fields</span>}
                          {run.durationMs != null && <span>· {Math.round(run.durationMs / 1000)}s</span>}
                          {run.estimatedCostUsd != null && <span>· ${run.estimatedCostUsd.toFixed(2)}</span>}
                          {run.scrapeCacheHit && <Badge tone="indigo">cache hit</Badge>}
                        </div>
                        {run.errors && run.errors.length > 0 && (
                          <div style={{ fontSize:10, color:'var(--red-700)', marginTop:3 }}>{run.errors.slice(0, 2).join(' · ')}{run.errors.length > 2 ? ` (+${run.errors.length - 2})` : ''}</div>
                        )}
                        {run.fieldGaps && run.fieldGaps.filter(g => g.reason !== 'not_applicable').length > 0 && (
                          <details style={{ marginTop:3 }}>
                            <summary style={{ fontSize:10, color:'var(--amber-700, #B45309)', cursor:'pointer' }}>
                              {run.fieldGaps.filter(g => g.reason !== 'not_applicable').length} field gaps
                            </summary>
                            <div style={{ fontSize:10, color:'var(--slate-600)', marginTop:2, display:'flex', flexDirection:'column', gap:1 }}>
                              {run.fieldGaps.filter(g => g.reason !== 'not_applicable').map(g => (
                                <span key={g.field} className="mono">{g.field} — {g.reason}</span>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom:18 }}>
                <SectionTitle label={`Vehicles using this config (${detail.vehicleCount})`} />
                {detail.vehicles.length === 0 ? (
                  <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No VINs yet.</div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:4, maxHeight:180, overflowY:'auto' }}>
                    {(detail.vehicles as VehicleSampleRow[]).map(v => (
                      <div key={String(v.id)}
                        onClick={() => gotoEntity('cars', String(v.id))}
                        style={{ background:'#fff', border:'1px solid var(--slate-200)', borderRadius:6, padding:'6px 10px', display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer', transition:'background 80ms' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--slate-25)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#fff'}>
                        <span className="mono" style={{ fontSize:11, color:'var(--blue-700)' }}>{v.vin}</span>
                        <span style={{ fontSize:11, color:'var(--slate-500)' }}>{v.year ?? ''} · {fmtDate(v.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Admin controls — per-entity drill */}
              <div style={{ marginBottom:18 }}>
                <AdminActionPanel title="Admin controls"
                  subtitle="Each Edit opens a form for the resolved entity. Audit-logged.">
                  <ActionRow label="Edit config core"
                    hint="Trim name, chassis code, drivetrain, brake/PS fluid, status"
                    action={<Button size="sm" onClick={() => setEditOpen(true)}>Edit</Button>} />
                  <ActionRow label="Edit engine"
                    hint={detail.engine
                      ? `${detail.engine.code ?? '—'} · ${detail.engine.configuration ?? ''} ${detail.engine.cylinders ?? ''} ${detail.engine.displacement_l ?? ''}L`
                      : 'No engine resolved'}
                    action={<Button size="sm" disabled={!detail.engine} onClick={() => setEngineOpen(true)}>Edit</Button>} />
                  <ActionRow label="Edit transmission"
                    hint={detail.transmission
                      ? `${detail.transmission.type ?? '—'} · ${detail.transmission.code ?? ''} · ${detail.transmission.speeds ?? '?'}-spd`
                      : 'No transmission resolved'}
                    action={<Button size="sm" disabled={!detail.transmission} onClick={() => setTransOpen(true)}>Edit</Button>} />
                  <ActionRow label="Edit chassis specs"
                    hint={detail.chassisCode
                      ? `${detail.chassisCode} — brake fluid, lug-nut torque, wipers, battery, steering`
                      : 'No chassis_code on config'}
                    action={<Button size="sm" disabled={!detail.chassisCode} onClick={() => setChassisOpen(true)}>Edit</Button>} />
                  <ActionRow label="Edit trim specs (tires)"
                    hint={detail.trimSpecs
                      ? `Front ${detail.trimSpecs.tire_size_front ?? '?'} · Rear ${detail.trimSpecs.tire_size_rear ?? '?'}`
                      : 'No trim_specs row yet — will create on save'}
                    action={<Button size="sm" onClick={() => setTrimOpen(true)}>Edit</Button>} />
                  <ActionRow label="Mark verified"
                    hint={`Bumps verification count (current: ${detail.enrichment.verificationCount ?? 0})`}
                    action={<Button size="sm" variant="primary" onClick={handleVerify}>Verify</Button>} />
                  <ActionRow label="Re-enrich entire car"
                    hint={<>
                      Full pipeline re-run (specs + parts + intervals + labor). Async — a few minutes.
                      <RunStatusPill run={(detail.enrichmentRuns as EnrichmentRunRow[] | undefined)?.[0]} onClick={jumpToLatestRun} />
                    </>}
                    action={<Button size="sm" disabled={busyFull} onClick={handleReEnrich}>{busyFull ? 'Scheduling…' : 'Re-enrich'}</Button>} />
                  <ActionRow label="Backfill parts only"
                    hint={<>
                      Re-discover which parts apply per service. Keeps hand-edited specs. Async — a few minutes.
                      <RunStatusPill run={(detail.enrichmentRuns as EnrichmentRunRow[] | undefined)?.[0]} onClick={jumpToLatestRun} />
                    </>}
                    action={<Button size="sm" disabled={busyParts} onClick={handleBackfillParts}>{busyParts ? 'Scheduling…' : 'Backfill parts'}</Button>} />
                  <ActionRow label="Reprice parts only"
                    hint={<>
                      Re-scrape correct prices for the parts already on this car. Async — the priced count lands in the audit log.
                      <RepriceStatusPill row={(detail.latestRepriceAudit as LatestRepriceAudit) ?? null} />
                    </>}
                    action={<Button size="sm" disabled={busyPrices} icon={<IconRefresh size={11} />} onClick={handleRepriceParts}>{busyPrices ? 'Repricing…' : 'Reprice parts'}</Button>} />
                </AdminActionPanel>
              </div>

              <div>
                <SectionTitle label="Raw IDs" />
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  <Row k="config_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.id)}</span>} />
                  {detail.makeId && <Row k="make_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.makeId)}</span>} />}
                  {detail.modelId && <Row k="model_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.modelId)}</span>} />}
                  {detail.engine?.id && <Row k="engine_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.engine.id)}</span>} />}
                  {detail.transmission?.id && <Row k="transmission_id" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.transmission.id)}</span>} />}
                  {detail.clonedFromConfigId && <Row k="cloned_from" v={<span className="mono" style={{ fontSize:11 }}>{String(detail.clonedFromConfigId)}</span>} />}
                </div>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div style={{ padding:22, background:'var(--slate-25)', borderTop:'1px solid var(--slate-200)' }}>
            {configId && <DirectorNotesPanel entityType="vehicle_config" entityId={configId} placeholder="Add an internal note about this config…" />}
          </div>

          {/* Edit forms */}
          <ConfigEditModal open={editOpen} onClose={() => setEditOpen(false)}
            configId={configId} detail={detail}
            token={sessionToken}
            onSaved={(n) => { setEditOpen(false); setToast(n > 0 ? `Saved ${n} field${n === 1 ? '' : 's'}.` : 'No changes.') }}
            updateBasics={updateBasics} />

          {detail.engine && (
            <EngineEditModal open={engineOpen} onClose={() => setEngineOpen(false)}
              engineId={detail.engine.id} current={detail.engine}
              token={sessionToken}
              onSaved={(n) => { setEngineOpen(false); setToast(n > 0 ? `Saved ${n} engine field${n === 1 ? '' : 's'}.` : 'No changes.') }}
              updateFields={updateEngine} />
          )}

          {detail.transmission && (
            <TransmissionEditModal open={transOpen} onClose={() => setTransOpen(false)}
              transmissionId={detail.transmission.id} current={detail.transmission}
              token={sessionToken}
              onSaved={(n) => { setTransOpen(false); setToast(n > 0 ? `Saved ${n} transmission field${n === 1 ? '' : 's'}.` : 'No changes.') }}
              updateFields={updateTransmission} />
          )}

          {detail.chassisCode && (
            <ChassisSpecsEditModal open={chassisOpen} onClose={() => setChassisOpen(false)}
              chassisCode={detail.chassisCode}
              current={detail.chassisSpecs ?? null}
              token={sessionToken}
              onSaved={(n) => { setChassisOpen(false); setToast(n > 0 ? `Saved ${n} chassis-spec field${n === 1 ? '' : 's'}.` : 'No changes.') }}
              updateFields={updateChassisSpecs} />
          )}

          {configId && (
            <TrimSpecsEditModal open={trimOpen} onClose={() => setTrimOpen(false)}
              vehicleConfigId={configId}
              current={detail.trimSpecs ?? null}
              token={sessionToken}
              onSaved={(n) => { setTrimOpen(false); setToast(n > 0 ? `Saved ${n} trim-spec field${n === 1 ? '' : 's'}.` : 'No changes.') }}
              updateFields={updateTrimSpecs} />
          )}

          <Toast msg={toast} />
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ConfigEditModal
// ---------------------------------------------------------------------------

const ConfigEditModal = ({
  open, onClose, configId, detail, token, onSaved, updateBasics,
}: {
  open: boolean
  onClose: () => void
  configId: Id<'vehicle_configs'> | null
  detail: any
  token: string
  onSaved: (changes: number) => void
  updateBasics: ReturnType<typeof useMutation<typeof api.directorConfigActions.updateConfigBasics>>
}) => {
  const [trim,         setTrim]       = useState('')
  const [chassis,      setChassis]    = useState('')
  const [drivetrain,   setDrivetrain] = useState('')
  const [brake,        setBrake]      = useState('')
  const [ps,           setPs]         = useState('')
  const [status,       setStatus]     = useState('')
  const [saving,       setSaving]     = useState(false)

  useEffect(() => {
    if (!open || !detail) return
    setTrim(detail.trimName ?? '')
    setChassis(detail.chassisCode ?? '')
    setDrivetrain(detail.drivetrain ?? '')
    setBrake(detail.brakeFluidType ?? '')
    setPs(detail.psFluidType ?? '')
    setStatus(detail.enrichment?.status ?? '')
  }, [open, detail?.id])

  const handleSave = async () => {
    if (!configId) return
    setSaving(true)
    try {
      const res = await updateBasics({
        id: configId,
        trim_name:         trim,
        chassis_code:      chassis,
        drivetrain:        drivetrain,
        brake_fluid_type:  brake,
        ps_fluid_type:     ps,
        enrichment_status: status,
        token,
      })
      onSaved((res as any)?.changes ?? 0)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={620}
      title="Edit vehicle config"
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save config'}</Button>
      </>}>
      <div style={{ padding:22, display:'flex', flexDirection:'column', gap:12 }}>
        <div style={{ fontSize:12, color:'var(--slate-600)' }}>
          Patches the vehicle_configs row. Leave any field blank to keep the current value.
        </div>
        <EditRow label="Trim name">
          <Input value={trim} onChange={e => setTrim(e.target.value)} placeholder="e.g. xDrive" />
        </EditRow>
        <EditRow label="Chassis code">
          <Input value={chassis} onChange={e => setChassis(e.target.value)} placeholder="e.g. G30" />
        </EditRow>
        <EditRow label="Drivetrain">
          <Input value={drivetrain} onChange={e => setDrivetrain(e.target.value)} placeholder="AWD / FWD / RWD / 4WD" />
        </EditRow>
        <EditRow label="Brake fluid">
          <Input value={brake} onChange={e => setBrake(e.target.value)} placeholder="e.g. DOT 4" />
        </EditRow>
        <EditRow label="Power-steering fluid">
          <Input value={ps} onChange={e => setPs(e.target.value)} placeholder="e.g. Pentosin CHF 11S" />
        </EditRow>
        <EditRow label="Enrichment status">
          <Select value={status} onChange={e => setStatus(e.target.value)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'enriching', label:'enriching' },
              { value:'partial',   label:'partial' },
              { value:'complete',  label:'complete' },
              { value:'verified',  label:'verified' },
              { value:'failed',    label:'failed' },
            ]} />
        </EditRow>
      </div>
    </Modal>
  )
}

const EditRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display:'grid', gridTemplateColumns:'180px 1fr', gap:10, alignItems:'center' }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:500 }}>{label}</span>
    {children}
  </div>
)

// ---------------------------------------------------------------------------
// EngineEditModal — patches the resolved engines row
// ---------------------------------------------------------------------------

const EngineEditModal = ({
  open, onClose, engineId, current, token, onSaved, updateFields,
}: {
  open: boolean
  onClose: () => void
  engineId: Id<'engines'>
  current: any
  token: string
  onSaved: (n: number) => void
  updateFields: ReturnType<typeof useMutation<typeof api.directorConfigActions.updateEngineFields>>
}) => {
  const [code, setCode] = useState('')
  const [family, setFamily] = useState('')
  const [config, setConfig] = useState('')
  const [cyl, setCyl] = useState('')
  const [disp, setDisp] = useState('')
  const [asp, setAsp] = useState('')
  const [fuel, setFuel] = useState('')
  const [inj, setInj] = useState('')
  const [timing, setTiming] = useState('')
  const [oilV, setOilV] = useState('')
  const [oilCap, setOilCap] = useState('')
  const [cool, setCool] = useState('')
  const [coolCap, setCoolCap] = useState('')
  const [spQty, setSpQty] = useState('')
  const [spGap, setSpGap] = useState('')
  const [wpTiming, setWpTiming] = useState<'' | 'true' | 'false'>('')
  const [dq, setDq] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setCode(current?.code ?? '')
    setFamily(current?.family ?? '')
    setConfig(current?.configuration ?? '')
    setCyl(current?.cylinders != null ? String(current.cylinders) : '')
    setDisp(current?.displacement_l != null ? String(current.displacement_l) : '')
    setAsp(current?.aspiration ?? '')
    setFuel(current?.fuel_type ?? '')
    setInj(current?.fuel_injection ?? '')
    setTiming(current?.timing_system ?? '')
    setOilV(current?.oil_viscosity ?? '')
    setOilCap(current?.oil_capacity_qts != null ? String(current.oil_capacity_qts) : '')
    setCool(current?.coolant_type ?? '')
    setCoolCap(current?.coolant_capacity_qts != null ? String(current.coolant_capacity_qts) : '')
    setSpQty(current?.spark_plug_quantity != null ? String(current.spark_plug_quantity) : '')
    setSpGap(current?.spark_plug_gap_mm != null ? String(current.spark_plug_gap_mm) : '')
    setWpTiming(current?.water_pump_timing_driven == null ? '' : (current.water_pump_timing_driven ? 'true' : 'false'))
    setDq(current?.data_quality ?? '')
  }, [open, engineId])

  const handleSave = async () => {
    setSaving(true)
    try {
      const n = (s: string) => s.trim() === '' ? undefined : Number(s)
      const res = await updateFields({
        id: engineId,
        engine_code:              code,
        engine_family:            family,
        configuration:            config,
        cylinders:                n(cyl),
        displacement_l:           n(disp),
        aspiration:               asp,
        fuel_type:                fuel,
        fuel_injection:           inj,
        timing_system:            timing,
        oil_viscosity:            oilV,
        oil_capacity_qts:         n(oilCap),
        coolant_type:             cool,
        coolant_capacity_qts:     n(coolCap),
        spark_plug_quantity:      n(spQty),
        spark_plug_gap_mm:        n(spGap),
        water_pump_timing_driven: wpTiming === '' ? undefined : wpTiming === 'true',
        data_quality:             dq,
        token,
      })
      onSaved((res as any)?.changes ?? 0)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={720} title="Edit engine"
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save engine'}</Button>
      </>}>
      <div style={{ padding:22, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <EditField label="Engine code"><Input value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. N63B44T4" /></EditField>
        <EditField label="Engine family"><Input value={family} onChange={e => setFamily(e.target.value)} placeholder="e.g. N63" /></EditField>
        <EditField label="Configuration"><Input value={config} onChange={e => setConfig(e.target.value)} placeholder="e.g. V / inline" /></EditField>
        <EditField label="Cylinders"><Input value={cyl} onChange={e => setCyl(e.target.value)} placeholder="e.g. 8" type="number" /></EditField>
        <EditField label="Displacement (L)"><Input value={disp} onChange={e => setDisp(e.target.value)} placeholder="e.g. 4.4" type="number" /></EditField>
        <EditField label="Aspiration"><Input value={asp} onChange={e => setAsp(e.target.value)} placeholder="natural / turbo / supercharged" /></EditField>
        <EditField label="Fuel type"><Input value={fuel} onChange={e => setFuel(e.target.value)} placeholder="Gasoline / Diesel / Hybrid / EV" /></EditField>
        <EditField label="Fuel injection"><Input value={inj} onChange={e => setInj(e.target.value)} placeholder="direct / port / dual" /></EditField>
        <EditField label="Timing system"><Input value={timing} onChange={e => setTiming(e.target.value)} placeholder="chain / belt / DOHC" /></EditField>
        <EditField label="Oil viscosity"><Input value={oilV} onChange={e => setOilV(e.target.value)} placeholder="e.g. 0W-30" /></EditField>
        <EditField label="Oil capacity (qts)"><Input value={oilCap} onChange={e => setOilCap(e.target.value)} placeholder="e.g. 8.5" type="number" /></EditField>
        <EditField label="Coolant type"><Input value={cool} onChange={e => setCool(e.target.value)} placeholder="e.g. BMW HT-12" /></EditField>
        <EditField label="Coolant cap. (qts)"><Input value={coolCap} onChange={e => setCoolCap(e.target.value)} placeholder="e.g. 10.6" type="number" /></EditField>
        <EditField label="Spark plug count"><Input value={spQty} onChange={e => setSpQty(e.target.value)} placeholder="e.g. 8" type="number" /></EditField>
        <EditField label="Spark plug gap (mm)"><Input value={spGap} onChange={e => setSpGap(e.target.value)} placeholder="e.g. 0.7" type="number" /></EditField>
        <EditField label="Water-pump on timing">
          <Select value={wpTiming} onChange={e => setWpTiming(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes (driven by timing)' },
              { value:'false', label:'No (separate / belt)' },
            ]} />
        </EditField>
        <EditField label="Data quality"><Input value={dq} onChange={e => setDq(e.target.value)} placeholder="enriched / verified / partial" /></EditField>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// TransmissionEditModal
// ---------------------------------------------------------------------------

const TransmissionEditModal = ({
  open, onClose, transmissionId, current, token, onSaved, updateFields,
}: {
  open: boolean
  onClose: () => void
  transmissionId: Id<'transmissions'>
  current: any
  token: string
  onSaved: (n: number) => void
  updateFields: ReturnType<typeof useMutation<typeof api.directorConfigActions.updateTransmissionFields>>
}) => {
  const [type, setType] = useState('')
  const [code, setCode] = useState('')
  const [speeds, setSpeeds] = useState('')
  const [mfr, setMfr] = useState('')
  const [fluid, setFluid] = useState('')
  const [capacity, setCapacity] = useState('')
  const [lifetime, setLifetime] = useState<'' | 'true' | 'false'>('')
  const [filter, setFilter] = useState<'' | 'true' | 'false'>('')
  const [method, setMethod] = useState('')
  const [dq, setDq] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setType(current?.type ?? '')
    setCode(current?.code ?? '')
    setSpeeds(current?.speeds != null ? String(current.speeds) : '')
    setMfr(current?.manufacturer ?? '')
    setFluid(current?.fluid_type ?? '')
    setCapacity(current?.fluid_capacity_drain_fill_qts != null ? String(current.fluid_capacity_drain_fill_qts) : '')
    setLifetime(current?.is_lifetime_fill == null ? '' : (current.is_lifetime_fill ? 'true' : 'false'))
    setFilter(current?.has_serviceable_filter == null ? '' : (current.has_serviceable_filter ? 'true' : 'false'))
    setMethod(current?.service_method ?? '')
    setDq(current?.data_quality ?? '')
  }, [open, transmissionId])

  const handleSave = async () => {
    setSaving(true)
    try {
      const n = (s: string) => s.trim() === '' ? undefined : Number(s)
      const res = await updateFields({
        id: transmissionId,
        transmission_type: type,
        code,
        speeds: n(speeds),
        manufacturer: mfr,
        fluid_type: fluid,
        fluid_capacity_drain_fill_qts: n(capacity),
        is_lifetime_fill:       lifetime === '' ? undefined : lifetime === 'true',
        has_serviceable_filter: filter   === '' ? undefined : filter   === 'true',
        service_method: method,
        data_quality: dq,
        token,
      })
      onSaved((res as any)?.changes ?? 0)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={680} title="Edit transmission"
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save transmission'}</Button>
      </>}>
      <div style={{ padding:22, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <EditField label="Type"><Input value={type} onChange={e => setType(e.target.value)} placeholder="Automatic / Manual / DCT / CVT" /></EditField>
        <EditField label="Code"><Input value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. 8HP70" /></EditField>
        <EditField label="Speeds"><Input value={speeds} onChange={e => setSpeeds(e.target.value)} placeholder="e.g. 8" type="number" /></EditField>
        <EditField label="Manufacturer"><Input value={mfr} onChange={e => setMfr(e.target.value)} placeholder="e.g. ZF / Aisin / GM" /></EditField>
        <EditField label="Fluid type"><Input value={fluid} onChange={e => setFluid(e.target.value)} placeholder="e.g. ZF Lifeguard 8" /></EditField>
        <EditField label="Drain & fill (qts)"><Input value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="e.g. 4.5" type="number" /></EditField>
        <EditField label="Lifetime fill?">
          <Select value={lifetime} onChange={e => setLifetime(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes' },
              { value:'false', label:'No' },
            ]} />
        </EditField>
        <EditField label="Serviceable filter?">
          <Select value={filter} onChange={e => setFilter(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes' },
              { value:'false', label:'No' },
            ]} />
        </EditField>
        <EditField label="Service method"><Input value={method} onChange={e => setMethod(e.target.value)} placeholder="drain_fill / exchange / both" /></EditField>
        <EditField label="Data quality"><Input value={dq} onChange={e => setDq(e.target.value)} placeholder="enriched / verified / partial" /></EditField>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// ChassisSpecsEditModal — patches by chassis_code; row is created if missing
// ---------------------------------------------------------------------------

const ChassisSpecsEditModal = ({
  open, onClose, chassisCode, current, token, onSaved, updateFields,
}: {
  open: boolean
  onClose: () => void
  chassisCode: string
  current: any
  token: string
  onSaved: (n: number) => void
  updateFields: ReturnType<typeof useMutation<typeof api.directorConfigActions.updateChassisSpecsFields>>
}) => {
  const [brakeFluid, setBrakeFluid] = useState('')
  const [brakeCap, setBrakeCap] = useState('')
  const [psFluid, setPsFluid] = useState('')
  const [psCap, setPsCap] = useState('')
  const [lugTorque, setLugTorque] = useState('')
  const [wiperDriver, setWiperDriver] = useState('')
  const [wiperPassenger, setWiperPassenger] = useState('')
  const [wiperRear, setWiperRear] = useState('')
  const [batteryGroup, setBatteryGroup] = useState('')
  const [batteryType, setBatteryType] = useState('')
  const [steering, setSteering] = useState('')
  const [parkingBrake, setParkingBrake] = useState('')
  const [hasRearWiper, setHasRearWiper] = useState<'' | 'true' | 'false'>('')
  const [hasPadSensor, setHasPadSensor] = useState<'' | 'true' | 'false'>('')
  const [dq, setDq] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setBrakeFluid(current?.brake_fluid_type ?? '')
    setBrakeCap(current?.brake_fluid_capacity_oz != null ? String(current.brake_fluid_capacity_oz) : '')
    setPsFluid(current?.ps_fluid_type ?? '')
    setPsCap(current?.ps_fluid_capacity_oz != null ? String(current.ps_fluid_capacity_oz) : '')
    setLugTorque(current?.lug_nut_torque_ft_lbs != null ? String(current.lug_nut_torque_ft_lbs) : '')
    setWiperDriver(current?.wiper_blade_driver_size_in != null ? String(current.wiper_blade_driver_size_in) : '')
    setWiperPassenger(current?.wiper_blade_passenger_size_in != null ? String(current.wiper_blade_passenger_size_in) : '')
    setWiperRear(current?.wiper_blade_rear_size_in != null ? String(current.wiper_blade_rear_size_in) : '')
    setBatteryGroup(current?.battery_group ?? '')
    setBatteryType(current?.battery_type ?? '')
    setSteering(current?.steering_type ?? '')
    setParkingBrake(current?.parking_brake_type ?? '')
    setHasRearWiper(current?.has_rear_wiper == null ? '' : (current.has_rear_wiper ? 'true' : 'false'))
    setHasPadSensor(current?.has_brake_pad_sensor == null ? '' : (current.has_brake_pad_sensor ? 'true' : 'false'))
    setDq(current?.data_quality ?? '')
  }, [open, chassisCode])

  const handleSave = async () => {
    setSaving(true)
    try {
      const n = (s: string) => s.trim() === '' ? undefined : Number(s)
      const res = await updateFields({
        chassis_code: chassisCode,
        brake_fluid_type: brakeFluid,
        brake_fluid_capacity_oz: n(brakeCap),
        ps_fluid_type: psFluid,
        ps_fluid_capacity_oz: n(psCap),
        lug_nut_torque_ft_lbs: n(lugTorque),
        wiper_blade_driver_size_in:    n(wiperDriver),
        wiper_blade_passenger_size_in: n(wiperPassenger),
        wiper_blade_rear_size_in:      n(wiperRear),
        battery_group: batteryGroup,
        battery_type: batteryType,
        steering_type: steering,
        parking_brake_type: parkingBrake,
        has_rear_wiper:       hasRearWiper === '' ? undefined : hasRearWiper === 'true',
        has_brake_pad_sensor: hasPadSensor === '' ? undefined : hasPadSensor === 'true',
        data_quality: dq,
        token,
      })
      onSaved((res as any)?.changes ?? 0)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={760} title={`Edit chassis specs · ${chassisCode}`}
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save chassis specs'}</Button>
      </>}>
      <div style={{ padding:22, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <EditField label="Brake fluid type"><Input value={brakeFluid} onChange={e => setBrakeFluid(e.target.value)} placeholder="e.g. DOT 4" /></EditField>
        <EditField label="Brake fluid cap (oz)"><Input value={brakeCap} onChange={e => setBrakeCap(e.target.value)} placeholder="e.g. 16" type="number" /></EditField>
        <EditField label="PS fluid type"><Input value={psFluid} onChange={e => setPsFluid(e.target.value)} placeholder="e.g. Pentosin CHF 11S" /></EditField>
        <EditField label="PS fluid cap (oz)"><Input value={psCap} onChange={e => setPsCap(e.target.value)} placeholder="e.g. 32" type="number" /></EditField>
        <EditField label="Lug-nut torque (ft-lbs)"><Input value={lugTorque} onChange={e => setLugTorque(e.target.value)} placeholder="e.g. 103" type="number" /></EditField>
        <EditField label="Wiper driver (in)"><Input value={wiperDriver} onChange={e => setWiperDriver(e.target.value)} placeholder="e.g. 26" type="number" /></EditField>
        <EditField label="Wiper passenger (in)"><Input value={wiperPassenger} onChange={e => setWiperPassenger(e.target.value)} placeholder="e.g. 20" type="number" /></EditField>
        <EditField label="Wiper rear (in)"><Input value={wiperRear} onChange={e => setWiperRear(e.target.value)} placeholder="e.g. 14" type="number" /></EditField>
        <EditField label="Has rear wiper?">
          <Select value={hasRearWiper} onChange={e => setHasRearWiper(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes' },
              { value:'false', label:'No' },
            ]} />
        </EditField>
        <EditField label="Battery group"><Input value={batteryGroup} onChange={e => setBatteryGroup(e.target.value)} placeholder="e.g. H9 / Group 95R" /></EditField>
        <EditField label="Battery type"><Input value={batteryType} onChange={e => setBatteryType(e.target.value)} placeholder="AGM / flooded / EFB / Li-ion" /></EditField>
        <EditField label="Brake-pad sensor?">
          <Select value={hasPadSensor} onChange={e => setHasPadSensor(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes' },
              { value:'false', label:'No' },
            ]} />
        </EditField>
        <EditField label="Steering type">
          <Select value={steering} onChange={e => setSteering(e.target.value)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'electric', label:'Electric' },
              { value:'hydraulic', label:'Hydraulic' },
              { value:'electro-hydraulic', label:'Electro-hydraulic' },
            ]} />
        </EditField>
        <EditField label="Parking brake type">
          <Select value={parkingBrake} onChange={e => setParkingBrake(e.target.value)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'electronic', label:'Electronic' },
              { value:'manual_drum', label:'Manual drum' },
              { value:'manual_disc', label:'Manual disc' },
            ]} />
        </EditField>
        <EditField label="Data quality"><Input value={dq} onChange={e => setDq(e.target.value)} placeholder="enriched / verified / partial" /></EditField>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// TrimSpecsEditModal — tire sizes + pressures + flags
// ---------------------------------------------------------------------------

const TrimSpecsEditModal = ({
  open, onClose, vehicleConfigId, current, token, onSaved, updateFields,
}: {
  open: boolean
  onClose: () => void
  vehicleConfigId: Id<'vehicle_configs'>
  current: any
  token: string
  onSaved: (n: number) => void
  updateFields: ReturnType<typeof useMutation<typeof api.directorConfigActions.updateTrimSpecsFields>>
}) => {
  const [sizeF, setSizeF] = useState('')
  const [sizeR, setSizeR] = useState('')
  const [pressF, setPressF] = useState('')
  const [pressR, setPressR] = useState('')
  const [staggered, setStaggered] = useState<'' | 'true' | 'false'>('')
  const [directional, setDirectional] = useState<'' | 'true' | 'false'>('')
  const [runFlat, setRunFlat] = useState<'' | 'true' | 'false'>('')
  const [alignment, setAlignment] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setSizeF(current?.tire_size_front ?? '')
    setSizeR(current?.tire_size_rear ?? '')
    setPressF(current?.recommended_tire_pressure_front_psi != null ? String(current.recommended_tire_pressure_front_psi) : '')
    setPressR(current?.recommended_tire_pressure_rear_psi  != null ? String(current.recommended_tire_pressure_rear_psi)  : '')
    setStaggered(current?.is_staggered == null ? '' : (current.is_staggered ? 'true' : 'false'))
    setDirectional(current?.tire_directional == null ? '' : (current.tire_directional ? 'true' : 'false'))
    setRunFlat(current?.is_run_flat == null ? '' : (current.is_run_flat ? 'true' : 'false'))
    setAlignment(current?.alignment_type ?? '')
  }, [open, vehicleConfigId])

  const handleSave = async () => {
    setSaving(true)
    try {
      const n = (s: string) => s.trim() === '' ? undefined : Number(s)
      const res = await updateFields({
        vehicle_config_id: vehicleConfigId,
        tire_size_front: sizeF,
        tire_size_rear:  sizeR,
        recommended_tire_pressure_front_psi: n(pressF),
        recommended_tire_pressure_rear_psi:  n(pressR),
        is_staggered:     staggered   === '' ? undefined : staggered   === 'true',
        tire_directional: directional === '' ? undefined : directional === 'true',
        is_run_flat:      runFlat     === '' ? undefined : runFlat     === 'true',
        alignment_type:   alignment,
        token,
      })
      onSaved((res as any)?.changes ?? 0)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} width={620} title="Edit trim specs (tires)"
      footer={<>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save trim specs'}</Button>
      </>}>
      <div style={{ padding:22, display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <EditField label="Tire size front"><Input value={sizeF} onChange={e => setSizeF(e.target.value)} placeholder="e.g. 245/40R19" /></EditField>
        <EditField label="Tire size rear"><Input value={sizeR} onChange={e => setSizeR(e.target.value)} placeholder="e.g. 275/35R19" /></EditField>
        <EditField label="Pressure front (psi)"><Input value={pressF} onChange={e => setPressF(e.target.value)} placeholder="e.g. 35" type="number" /></EditField>
        <EditField label="Pressure rear (psi)"><Input value={pressR} onChange={e => setPressR(e.target.value)} placeholder="e.g. 35" type="number" /></EditField>
        <EditField label="Staggered?">
          <Select value={staggered} onChange={e => setStaggered(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes' },
              { value:'false', label:'No' },
            ]} />
        </EditField>
        <EditField label="Directional?">
          <Select value={directional} onChange={e => setDirectional(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes' },
              { value:'false', label:'No' },
            ]} />
        </EditField>
        <EditField label="Run-flat?">
          <Select value={runFlat} onChange={e => setRunFlat(e.target.value as any)}
            options={[
              { value:'', label:'(unchanged)' },
              { value:'true',  label:'Yes' },
              { value:'false', label:'No' },
            ]} />
        </EditField>
        <EditField label="Alignment type"><Input value={alignment} onChange={e => setAlignment(e.target.value)} placeholder="standard / aggressive / lowered" /></EditField>
      </div>
    </Modal>
  )
}

const EditField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:500 }}>{label}</span>
    {children}
  </div>
)

// ---------------------------------------------------------------------------
// Tab shell
// ---------------------------------------------------------------------------

type ConfigRow = {
  id:                Id<'vehicle_configs'>
  configKey:         string
  nhtsaVinKey?:      string
  year:              number
  make:              string
  model:             string
  trim:              string
  drivetrain?:       string
  chassisCode?:      string
  engineCode?:       string
  engineFamily?:     string
  transmissionType?: string
  enrichmentStatus:  string
  fillRate?:         number
  confidenceAvg?:    number
  enrichmentVersion?: string
  lastEnrichedAt?:   number
  lastVerifiedAt?:   number
  verificationCount: number
  packagesCount:     number
  rotorFrontMinMm:   number | null
  rotorRearMinMm:    number | null
  rotorMinEstimated: boolean
  vehicleCount:      number
  latestRunStatus?:  string
  latestRunAt?:      number
  createdAt?:        number
}

export const TabVehicleConfigs = () => {
  const [q,              setQ]              = useState('')
  const [statusFilter,   setStatusFilter]   = useState('all')
  const [makeFilter,     setMakeFilter]     = useState('all')
  const [openId,         setOpenId]         = useState<Id<'vehicle_configs'> | null>(null)

  useEffect(() => {
    const goto = consumeGoto()
    if (goto && goto.tab === 'configs') setOpenId(goto.entityId as Id<'vehicle_configs'>)
  }, [])

  const configs = useQuery(api.directorCars.vehicleConfigsList, {}) as ConfigRow[] | undefined

  const makes = Array.from(new Set((configs ?? []).map(c => c.make).filter(m => m && m !== '—'))).sort()
  const statusOptions = (() => {
    const counts: Record<string, number> = {}
    for (const c of configs ?? []) counts[c.enrichmentStatus] = (counts[c.enrichmentStatus] ?? 0) + 1
    return [
      { value:'all', label:'All statuses' },
      ...Object.entries(counts).map(([k, n]) => ({ value:k, label:`${k} (${n})` })),
    ]
  })()

  const filtered = (configs ?? []).filter(c => {
    if (makeFilter !== 'all' && c.make !== makeFilter) return false
    if (statusFilter !== 'all' && c.enrichmentStatus !== statusFilter) return false
    if (q) {
      const needle = q.toLowerCase()
      const hay = [c.configKey, c.nhtsaVinKey, c.make, c.model, c.trim, c.chassisCode, c.engineCode, c.engineFamily].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })

  const hasFilter = q || makeFilter !== 'all' || statusFilter !== 'all'

  return (
    <SectionAnchor id="configs" title="Vehicle configs"
      subtitle={configs === undefined ? 'Loading…' : `${configs.length} configs · ${filtered.length} shown · platform-level catalog (1 row per YMMT)`}>

      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12, flexWrap:'wrap' }}>
        <Input icon={<IconSearch size={14} />} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search config key, NHTSA key, YMMT, engine code, chassis code…" style={{ width:380 }} />
        <Select value={makeFilter} onChange={e => setMakeFilter(e.target.value)}
          options={[{ value:'all', label:'All makes' }, ...makes.map(m => ({ value: m, label: m }))]} />
        <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          options={statusOptions} />
        <span style={{ flex:1 }} />
        {hasFilter && (
          <Button size="sm" onClick={() => { setQ(''); setMakeFilter('all'); setStatusFilter('all') }}>
            <IconX size={12} /> Clear
          </Button>
        )}
      </div>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Config</th>
            <th style={tableStyles.th}>Engine</th>
            <th style={tableStyles.th}>Trans</th>
            <th style={tableStyles.th}>Chassis</th>
            <th style={tableStyles.th}>Enrichment</th>
            <th style={tableStyles.th}>Rotor min</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># VINs</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Packages</th>
            <th style={tableStyles.th}>Last enriched</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {configs === undefined
              ? <tr><td colSpan={10} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={10} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No configs match.</td></tr>
                : filtered.map(c => (
                  <tr key={String(c.id)} onClick={() => setOpenId(c.id)} style={{ cursor:'pointer' }}>
                    <td style={tableStyles.td}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={{ width:34, height:34, borderRadius:6, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-500)' }}>
                          <IconCar size={16} />
                        </span>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:500, color:'var(--slate-900)' }}>{[c.year, c.make, c.model].join(' ')}</div>
                          <div style={{ fontSize:11, color:'var(--slate-500)' }}>{c.trim !== '—' ? c.trim : ''}{c.drivetrain ? ` · ${c.drivetrain}` : ''}</div>
                          <div className="mono" style={{ fontSize:10, color:'var(--slate-400)', marginTop:2, maxWidth:280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.configKey}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>
                      <div style={{ fontSize:12 }}>{c.engineCode ?? '—'}</div>
                      {c.engineFamily && <div style={{ fontSize:11, color:'var(--slate-500)' }}>{c.engineFamily}</div>}
                    </td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>{c.transmissionType ?? '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }} className="mono">{c.chassisCode ?? '—'}</td>
                    <td style={tableStyles.td}>{enrichmentChip(c.enrichmentStatus, c.fillRate)}</td>
                    <td style={{ ...tableStyles.td, fontSize:12 }} className="mono"
                        title={c.rotorFrontMinMm == null && c.rotorRearMinMm == null
                          ? 'No OEM rotor minimum — inspection records rotor readings but does not grade them'
                          : 'front / rear OEM minimum (mm)'}>
                      {c.rotorFrontMinMm == null && c.rotorRearMinMm == null
                        ? <span style={{ color:'var(--slate-400)' }}>—</span>
                        : <>
                            <span style={{ color:'var(--slate-700)' }}>
                              {c.rotorFrontMinMm != null ? c.rotorFrontMinMm.toFixed(1) : '—'}
                              {' / '}
                              {c.rotorRearMinMm != null ? c.rotorRearMinMm.toFixed(1) : '—'}
                            </span>
                            {c.rotorMinEstimated && <span style={{ display:'block', fontSize:10, color:'var(--amber-700, #b45309)' }}>est.</span>}
                          </>}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{c.vehicleCount}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{c.packagesCount}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>
                      {c.lastEnrichedAt ? `${ageLabel(c.lastEnrichedAt)}` : '—'}
                      {c.enrichmentVersion && <span style={{ display:'block', fontSize:10, color:'var(--slate-400)' }}>{c.enrichmentVersion}</span>}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                      <Button size="sm" onClick={() => setOpenId(c.id)}>View</Button>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>

      <ConfigModal configId={openId} onClose={() => setOpenId(null)} />
    </SectionAnchor>
  )
}
