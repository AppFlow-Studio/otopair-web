'use client'

// Needs Attention · Incomplete Car Configs — the car-centric hub. Instead of
// hopping between the Wrong / Unpriced / Missing / Open-review tables hunting
// the same YMMT in each, this merges all four live scans BY config and shows
// one accordion per car: expand it and every hole that car has (missing parts,
// wrong parts, unpriced parts, open reviews) is listed together, each item a
// launcher for the exact drawer/sidebar that fixes it. Fixing an item removes
// it and shrinks the header badges reactively — the underlying scans re-run.
//
// Client-side merge (no dedicated backend query) — reuses the subscriptions the
// sibling tabs already hold (convex/react shares one subscription per identical
// query+args), bounded by each scan's own window. Reviews with no config_id
// stay in the Open reviews tab; they can't be grouped under a car.

import { useMemo, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Button, Input, IconSearch } from '../../Primitives'
import { Panel, Empty, SkeletonBlock, CarAccordionItem, CountPill, RunLink, fmtWhen, fmtWhenExact, type ReviewRow } from './helpers'
import { AddMissingPartDrawer, carLabelOf, type MissingPartFlag } from './MissingPartsPanel'
import { WrongPartDrawer, type WrongPartFlag } from './WrongPartsPanel'
import { UnpricedPartDrawer, type UnpricedPartFlag } from './PartQualityPanel'

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }

type Bucket = {
  configId: string
  year: number | null; make: string | null; model: string | null; trim: string | null
  vin: string | null; configKey: string | null
  missing: MissingPartFlag[]
  wrong: WrongPartFlag[]
  unpriced: UnpricedPartFlag[]
  reviews: ReviewRow[]
}

type CarIdentity = { year: number | null; make: string | null; model: string | null; trim: string | null; vin: string | null; configKey: string | null }

const bucketTotal = (b: Bucket) => b.missing.length + b.wrong.length + b.unpriced.length + b.reviews.length

function buildBuckets(missing: MissingPartFlag[], wrong: WrongPartFlag[], unpriced: UnpricedPartFlag[], reviews: ReviewRow[]): Bucket[] {
  const map = new Map<string, Bucket>()
  const ensure = (configId: string, car: CarIdentity): Bucket => {
    let b = map.get(configId)
    if (!b) {
      b = { configId, year: car.year, make: car.make, model: car.model, trim: car.trim, vin: car.vin, configKey: car.configKey, missing: [], wrong: [], unpriced: [], reviews: [] }
      map.set(configId, b)
    } else {
      // Backfill any car field a later source knows and an earlier one didn't.
      b.year ??= car.year; b.make ??= car.make; b.model ??= car.model
      b.trim ??= car.trim; b.vin ??= car.vin; b.configKey ??= car.configKey
    }
    return b
  }
  for (const f of missing) ensure(f.configId, f).missing.push(f)
  for (const f of wrong) ensure(f.configId, f).wrong.push(f)
  for (const f of unpriced) ensure(f.configId, f).unpriced.push(f)
  for (const r of reviews) {
    if (!r.config_id) continue // no car to group under — stays in the Open reviews tab
    ensure(r.config_id, { year: r.year, make: r.make, model: r.model, trim: r.trim, vin: r.vin, configKey: r.config_key }).reviews.push(r)
  }
  return [...map.values()].sort((a, b) => bucketTotal(b) - bucketTotal(a))
}

export function IncompleteConfigsPanel({ token, goDeepDive, onOpenReview }: {
  token: string
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
  onOpenReview: (id: string, title: string) => void
}) {
  const missingQ = useQuery(api.directorPartQuality.scanMissingParts, { token })
  const wrongQ = useQuery(api.directorPartQuality.scanWrongParts, { token })
  const unpricedQ = useQuery(api.directorPartQuality.scanUnpricedParts, { token })
  const reviewsQ = useQuery(api.dataOverview.openReviews, { token })

  const [search, setSearch] = useState('')
  const [fYear, setFYear] = useState('')
  const [fMake, setFMake] = useState('')
  const [fModel, setFModel] = useState('')
  const [fTrim, setFTrim] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addMissing, setAddMissing] = useState<MissingPartFlag | null>(null)
  const [showWrong, setShowWrong] = useState<WrongPartFlag | null>(null)
  const [showUnpriced, setShowUnpriced] = useState<UnpricedPartFlag | null>(null)

  const loading = !missingQ || !wrongQ || !unpricedQ || !reviewsQ
  const buckets = useMemo(
    () => buildBuckets(missingQ?.flags ?? [], wrongQ?.flags ?? [], unpricedQ?.flags ?? [], reviewsQ?.rows ?? []),
    [missingQ, wrongQ, unpricedQ, reviewsQ],
  )

  // Cascading YMMT dropdowns — each list only offers values that still exist
  // under the filters above it (Year → Make → Model → Trim), so a director
  // can't build an empty combination. Options are drawn from the cars actually
  // in the queue, not a static catalog.
  const yearOpts = useMemo(() => uniqSorted(buckets.map(b => b.year), 'desc'), [buckets])
  const makeSrc = useMemo(() => buckets.filter(b => !fYear || String(b.year ?? '') === fYear), [buckets, fYear])
  const makeOpts = useMemo(() => uniqSorted(makeSrc.map(b => b.make)), [makeSrc])
  const modelSrc = useMemo(() => makeSrc.filter(b => !fMake || (b.make ?? '') === fMake), [makeSrc, fMake])
  const modelOpts = useMemo(() => uniqSorted(modelSrc.map(b => b.model)), [modelSrc])
  const trimSrc = useMemo(() => modelSrc.filter(b => !fModel || (b.model ?? '') === fModel), [modelSrc, fModel])
  const trimOpts = useMemo(() => uniqSorted(trimSrc.map(b => b.trim)), [trimSrc])

  const anyFilter = !!(search || fYear || fMake || fModel || fTrim)
  const clearAll = () => { setSearch(''); setFYear(''); setFMake(''); setFModel(''); setFTrim('') }
  // Changing a parent filter clears the narrower ones beneath it.
  const onYear = (v: string) => { setFYear(v); setFMake(''); setFModel(''); setFTrim('') }
  const onMake = (v: string) => { setFMake(v); setFModel(''); setFTrim('') }
  const onModel = (v: string) => { setFModel(v); setFTrim('') }

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return buckets.filter(b => {
      if (fYear && String(b.year ?? '') !== fYear) return false
      if (fMake && (b.make ?? '') !== fMake) return false
      if (fModel && (b.model ?? '') !== fModel) return false
      if (fTrim && (b.trim ?? '') !== fTrim) return false
      if (!q) return true
      const hay = [carLabelOf(b), b.vin, b.configKey,
        ...b.missing.map(i => i.serviceName), ...b.wrong.map(i => i.partName), ...b.unpriced.map(i => i.partName)]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [buckets, search, fYear, fMake, fModel, fTrim])

  return (
    <Panel title="Incomplete Car Configs"
      sub={loading ? undefined : shown.length === buckets.length
        ? `${buckets.length} ${buckets.length === 1 ? 'car' : 'cars'} with open data gaps`
        : `${shown.length} of ${buckets.length} cars`}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <Input icon={<IconSearch size={14} />} value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search VIN, part…" style={{ width: 180, height: 30 }} />
        <FilterSelect label="Year" value={fYear} onChange={onYear} options={yearOpts} />
        <FilterSelect label="Make" value={fMake} onChange={onMake} options={makeOpts} />
        <FilterSelect label="Model" value={fModel} onChange={onModel} options={modelOpts} />
        <FilterSelect label="Trim" value={fTrim} onChange={setFTrim} options={trimOpts} />
        {anyFilter && <button onClick={clearAll} style={linkBtn}>Clear</button>}
      </div>
      {loading ? <SkeletonBlock height={240} /> : shown.length === 0 ? (
        <Empty>{buckets.length === 0 ? 'No cars have missing, wrong, or unpriced parts or open reviews right now.' : 'No cars match these filters.'}</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(b => (
            <CarAccordionItem key={b.configId} open={expanded === b.configId}
              onToggle={() => setExpanded(expanded === b.configId ? null : b.configId)}
              title={carLabelOf(b) || b.configKey || b.configId}
              subtitle={b.vin ?? b.configKey ?? undefined}
              badges={<>
                <CountPill n={b.missing.length} label="missing" tone="orange" />
                <CountPill n={b.wrong.length} label="wrong" tone="red" />
                <CountPill n={b.unpriced.length} label="unpriced" tone="yellow" />
                <CountPill n={b.reviews.length} label="reviews" tone="blue" />
              </>}>
              {b.missing.length > 0 && (
                <BucketSection title="Missing parts">
                  {b.missing.map(item => (
                    <Row key={item.key} label={`${item.serviceName} · ${item.roleLabel}`}
                      run={{ runId: item.runId, runStatus: item.runStatus }}
                      onRun={() => goDeepDive(item.configId, item.configKey, item.runId ?? undefined)}
                      action="Add part" onAction={() => setAddMissing(item)} />
                  ))}
                </BucketSection>
              )}
              {b.wrong.length > 0 && (
                <BucketSection title="Wrong parts">
                  {b.wrong.map(item => (
                    <Row key={item.fitmentId} label={`${item.oemNumber} · ${item.partName}`}
                      run={{ runId: item.runId, runStatus: item.runStatus }}
                      onRun={() => goDeepDive(item.configId, item.configKey, item.runId ?? undefined)}
                      action="Review" onAction={() => setShowWrong(item)} />
                  ))}
                </BucketSection>
              )}
              {b.unpriced.length > 0 && (
                <BucketSection title="Unpriced parts">
                  {b.unpriced.map(item => (
                    <Row key={item.fitmentId} label={`${item.oemNumber} · ${item.partName}`}
                      run={{ runId: item.runId, runStatus: item.runStatus }}
                      onRun={() => goDeepDive(item.configId, item.configKey, item.runId ?? undefined)}
                      action="Add price" onAction={() => setShowUnpriced(item)} />
                  ))}
                </BucketSection>
              )}
              {b.reviews.length > 0 && (
                <BucketSection title="Open reviews">
                  {b.reviews.map(r => (
                    <div key={r.id} style={rowStyle}>
                      <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 999, background: 'var(--yellow-50)', color: 'var(--yellow-800)', flexShrink: 0 }}>{r.stream}</span>
                      <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                      <span style={{ color: 'var(--slate-400)', flexShrink: 0 }} title={fmtWhenExact(r.created_at)}>{fmtWhen(r.created_at)}</span>
                      <Button variant="secondary" size="sm" onClick={() => onOpenReview(r.id, r.title)}>Open</Button>
                    </div>
                  ))}
                </BucketSection>
              )}
            </CarAccordionItem>
          ))}
        </div>
      )}

      <AddMissingPartDrawer key={addMissing?.key ?? 'none'} token={token} flag={addMissing}
        onClose={() => setAddMissing(null)} goDeepDive={goDeepDive} />
      <WrongPartDrawer key={showWrong?.fitmentId ?? 'none'} token={token} flag={showWrong}
        onClose={() => setShowWrong(null)} goDeepDive={goDeepDive} />
      <UnpricedPartDrawer key={showUnpriced?.fitmentId ?? 'none'} token={token} flag={showUnpriced}
        onClose={() => setShowUnpriced(null)} goDeepDive={goDeepDive} />
    </Panel>
  )
}

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '8px 10px', border: '1px solid var(--slate-100)', borderRadius: 8 }
const selectStyle: React.CSSProperties = { border: '1px solid var(--slate-200)', borderRadius: 8, padding: '0 8px', height: 30, fontSize: 12, background: '#fff', fontFamily: 'inherit', cursor: 'pointer' }

/** Distinct non-empty values as strings, numeric-aware sort (so years read
 *  2024, 2023, … not lexically). */
function uniqSorted(vals: (string | number | null)[], dir: 'asc' | 'desc' = 'asc'): string[] {
  const out = [...new Set(vals.filter(v => v != null && v !== '').map(String))]
  out.sort((a, b) => {
    const na = Number(a), nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return dir === 'desc' ? nb - na : na - nb
    return dir === 'desc' ? b.localeCompare(a) : a.localeCompare(b)
  })
  return out
}

/** One YMMT filter dropdown — "<label>: All" when unset, drawn from the cars
 *  actually in the queue. */
function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}
      style={{ ...selectStyle, color: value ? 'var(--slate-800)' : 'var(--slate-400)' }}>
      <option value="">{label}: All</option>
      {options.map(o => <option key={o} value={o} style={{ color: 'var(--slate-800)' }}>{o}</option>)}
    </select>
  )
}

function BucketSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--slate-400)', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  )
}

function Row({ label, run, onRun, action, onAction }: {
  label: string
  run: { runId: string | null; runStatus: string | null }
  onRun: () => void
  action: string
  onAction: () => void
}) {
  return (
    <div style={rowStyle}>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <RunLink runId={run.runId} runStatus={run.runStatus} onOpen={onRun} />
      <Button variant="secondary" size="sm" onClick={onAction}>{action}</Button>
    </div>
  )
}
