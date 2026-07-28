'use client'

// Tab · Needs Attention — the primary triage hub, sub-tabbed (Failed runs /
// Open reviews / Wrong parts / Unpriced parts / Data Incidents) so the whole
// tab is scannable without scrolling a long vertical stack — mirrors
// LiveRunsTab's SubTabs pattern. Each tab carries a numbered badge (its live
// count) so a director can see which sections need work before clicking in.
//
//  - Failed runs: unacknowledged, ANY age (not time-windowed — see
//    dataOverview.ts attention.failed_runs_all).
//  - Open reviews: the FULL open + claimed review_queue (not just Overview's
//    >72h-stale slice). Clicking a row opens the shared ReviewSidebar.
//  - Wrong parts / Unpriced parts: live scans for defects sanity_flags can't
//    see — cross-make/refuted fitments, and CORE parts with no trusted price
//    (convex/directorPartQuality.ts).
//  - Data Incidents: the manual-declare workflow for defect classes the
//    system can't detect on its own (convex/dataProvenance.ts).

import { useMemo, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Input, IconSearch } from '../../Primitives'
import { Panel, Empty, StatusPill, SkeletonBlock, SubTabs, TableWrap, th, td, thRight, tdRight, fmtWhen, PageNav, RunChip, DateRangeFilter, dateInRange, type OpenTrigger, type ReviewRow } from './helpers'
import { WrongPartsPanel } from './WrongPartsPanel'
import { UnpricedPartsPanel } from './PartQualityPanel'
import { IncidentsPanel } from './IncidentsPanel'

const STREAMS = ['consensus', 'correction', 'report', 'survey'] as const
type StreamFilter = 'all' | (typeof STREAMS)[number]
type Section = 'failed' | 'reviews' | 'wrong' | 'unpriced' | 'incidents'
const REVIEWS_PAGE_SIZE = 15

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }

/** Numbered tab badge — count pill, red when non-zero and worth flagging red. */
function countBadge(n: number | undefined, redWhenNonZero = false) {
  if (n == null) return undefined
  const hot = redWhenNonZero && n > 0
  return (
    <span className="mono" style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
      background: hot ? 'var(--red-50)' : 'var(--slate-100)', color: hot ? 'var(--red-700)' : 'var(--slate-600)' }}>
      {n}
    </span>
  )
}

export function NeedsAttentionTab({ token, goDeepDive, openTrigger, canWrite, canTrigger, claimReview, activeReviewId, onOpenReview }: {
  token: string
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
  openTrigger: OpenTrigger
  canWrite: boolean
  canTrigger: boolean
  claimReview: (id: string) => Promise<void>
  activeReviewId: string | null
  onOpenReview: (id: string, title: string) => void
}) {
  const [section, setSection] = useState<Section>('failed')
  const [stream, setStream] = useState<StreamFilter>('all')
  const [reviewSearch, setReviewSearch] = useState('')
  const [reviewDateFrom, setReviewDateFrom] = useState('')
  const [reviewDateTo, setReviewDateTo] = useState('')
  const [reviewPage, setReviewPage] = useState(0)

  const attention = useQuery(api.dataOverview.attention, { token })
  const openReviewsQ = useQuery(api.dataOverview.openReviews, { token })
  // Badge-only reads for the tabs whose detail panel queries independently —
  // convex/react shares one subscription per identical (query, args), so
  // this doesn't double the network cost of the panel's own useQuery below.
  const wrongPartsQ = useQuery(api.directorPartQuality.scanWrongParts, { token })
  const unpricedPartsQ = useQuery(api.directorPartQuality.scanUnpricedParts, { token })
  const incidentsQ = useQuery(api.dataProvenance.listIncidents, { token })

  const streamRows = (openReviewsQ?.rows ?? []).filter(r => stream === 'all' || r.stream === stream)
  const rows = useMemo(() => {
    const q = reviewSearch.trim().toLowerCase()
    return streamRows.filter(r => {
      if (!dateInRange(r.created_at, reviewDateFrom, reviewDateTo)) return false
      if (!q) return true
      const hay = [r.title, r.vin, r.config_key, r.make, r.model, r.trim, String(r.year ?? '')]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [streamRows, reviewSearch, reviewDateFrom, reviewDateTo])
  const streamCounts = STREAMS.reduce<Record<string, number>>((acc, s) => {
    acc[s] = (openReviewsQ?.rows ?? []).filter(r => r.stream === s).length
    return acc
  }, {})
  const openIncidentsCount = (incidentsQ ?? []).filter(i => i.status !== 'resolved').length

  const reviewPageCount = Math.max(1, Math.ceil(rows.length / REVIEWS_PAGE_SIZE))
  const reviewClampedPage = Math.min(reviewPage, reviewPageCount - 1)
  const reviewPageRows = rows.slice(reviewClampedPage * REVIEWS_PAGE_SIZE, reviewClampedPage * REVIEWS_PAGE_SIZE + REVIEWS_PAGE_SIZE)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SubTabs<Section> value={section} onChange={setSection} tabs={[
        { id: 'failed', label: 'Failed runs', badge: countBadge(attention?.failed_runs_all_total, true) },
        { id: 'reviews', label: 'Open reviews', badge: countBadge(openReviewsQ?.rows.length) },
        { id: 'wrong', label: 'Wrong parts', badge: countBadge(wrongPartsQ?.flags.length, true) },
        { id: 'unpriced', label: 'Unpriced parts', badge: countBadge(unpricedPartsQ?.flags.length) },
        { id: 'incidents', label: 'Data Incidents', badge: countBadge(openIncidentsCount) },
      ]} />

      {section === 'failed' && (
        <Panel title="Failed runs" sub={attention ? `${attention.failed_runs_all_total} unacknowledged, any age` : undefined}>
          {!attention ? <SkeletonBlock height={100} /> : attention.failed_runs_all.length === 0 ? (
            <Empty>No unacknowledged failed runs.</Empty>
          ) : (
            <div>
              {attention.failed_runs_all.map(r => (
                <div key={r.id} onClick={() => goDeepDive(r.vehicle_config_id, null, r.id)}
                  title="Open this run in Deep-Dive"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 8px', margin: '0 -8px',
                    borderRadius: 6, cursor: 'pointer', borderBottom: '1px solid var(--slate-50)' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                  <StatusPill status="failed" />
                  <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-600)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.first_error ?? '—'}</span>
                  {r.error_count > 1 && <span style={{ color: 'var(--slate-400)' }}>+{r.error_count - 1} more</span>}
                  <span style={{ color: 'var(--slate-400)' }}>{fmtWhen(r.at)}</span>
                  <button style={{ ...linkBtn, flexShrink: 0 }} onClick={() => goDeepDive(r.vehicle_config_id, null, r.id)}>Deep-dive</button>
                  {canWrite && (
                    <button style={{ ...linkBtn, color: 'var(--slate-500)', flexShrink: 0 }}
                      onClick={e => { e.stopPropagation(); openTrigger({ kind: 'acknowledgeRun', runId: r.id, label: r.first_error ?? String(r.id) }) }}>Ack</button>
                  )}
                </div>
              ))}
              {(attention.failed_runs_all_total > attention.failed_runs_all.length || attention.failed_runs_all_truncated) && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--slate-400)' }}>
                  Showing {attention.failed_runs_all.length} of {attention.failed_runs_all_total}{attention.failed_runs_all_truncated ? '+' : ''} — capped.
                </div>
              )}
            </div>
          )}
        </Panel>
      )}

      {section === 'reviews' && (
        <Panel title="Open reviews" sub={openReviewsQ ? `${rows.length}${rows.length !== openReviewsQ.rows.length ? ` of ${openReviewsQ.rows.length}` : ''} open` : undefined}
          right={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Input icon={<IconSearch size={14} />} value={reviewSearch}
                onChange={e => { setReviewSearch(e.target.value); setReviewPage(0) }}
                placeholder="Search VIN, config, title…" style={{ width: 200, height: 30 }} />
              <div style={{ display: 'inline-flex', gap: 2, background: '#fff', border: '1px solid var(--slate-200)', borderRadius: 8, padding: 3 }}>
                {(['all', ...STREAMS] as const).map(s => (
                  <button key={s} onClick={() => { setStream(s); setReviewPage(0) }}
                    style={{ padding: '5px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
                      background: stream === s ? 'var(--blue-50)' : 'transparent', color: stream === s ? 'var(--blue-700)' : 'var(--slate-600)' }}>
                    {s === 'all' ? 'All' : s}{s !== 'all' ? ` (${streamCounts[s] ?? 0})` : ''}
                  </button>
                ))}
              </div>
              <DateRangeFilter from={reviewDateFrom} to={reviewDateTo}
                onFrom={v => { setReviewDateFrom(v); setReviewPage(0) }} onTo={v => { setReviewDateTo(v); setReviewPage(0) }} />
            </div>
          }>
          {!openReviewsQ ? <SkeletonBlock height={200} /> : rows.length === 0 ? (
            <Empty>{openReviewsQ.rows.length === 0 ? 'Review queue is clear.' : 'No items match this search/filter.'}</Empty>
          ) : (
            <>
              <TableWrap>
                <thead><tr>
                  <th style={th}>Stream</th>
                  <th style={th}>Vehicle</th>
                  <th style={th}>Status</th>
                  <th style={thRight}>Created</th>
                  <th style={thRight}>Run</th>
                  <th style={thRight}>Actions</th>
                </tr></thead>
                <tbody>
                  {reviewPageRows.map(r => (
                    <ReviewTableRow key={r.id} r={r} active={activeReviewId === r.id}
                      onOpen={() => onOpenReview(r.id, r.title)}
                      canClaim={canWrite} onClaim={() => claimReview(r.id)} goDeepDive={goDeepDive} />
                  ))}
                </tbody>
              </TableWrap>
              <PageNav page={reviewClampedPage} pageCount={reviewPageCount} total={rows.length} pageSize={REVIEWS_PAGE_SIZE}
                note={openReviewsQ.truncated ? 'showing the oldest 150 open/claimed items' : undefined} onPage={setReviewPage} />
            </>
          )}
        </Panel>
      )}

      {section === 'wrong' && <WrongPartsPanel token={token} goDeepDive={goDeepDive} />}
      {section === 'unpriced' && <UnpricedPartsPanel token={token} goDeepDive={goDeepDive} />}
      {section === 'incidents' && <IncidentsPanel token={token} canWrite={canWrite} canTrigger={canTrigger} goDeepDive={goDeepDive} />}
    </div>
  )
}

/** One review_queue row in the Open Reviews table. Clicking it opens the
 *  shared ReviewSidebar (side drawer) — the same drawer the Overview rail's
 *  stale-only slice opens — where a director works the flags with a required
 *  source link + confirmation popup per field, and resolves/dismisses the
 *  item with an audited reason. */
function ReviewTableRow({ r, active, onOpen, canClaim, onClaim, goDeepDive }: {
  r: ReviewRow
  active: boolean
  onOpen: () => void
  canClaim?: boolean
  onClaim?: () => void
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const carLabel = [r.year, r.make, r.model, r.trim].filter(Boolean).join(' ')
  return (
    <tr onClick={onOpen} title="Open review detail" style={{ cursor: 'pointer', background: active ? 'var(--blue-50)' : undefined }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
      <td style={td}>
        <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 999, background: 'var(--yellow-50)', color: 'var(--yellow-800)' }}>{r.stream}</span>
      </td>
      <td style={{ ...td, fontWeight: 500 }}>{carLabel || r.title}</td>
      <td style={td}>
        {r.status === 'claimed' ? <span style={{ color: 'var(--blue-700)', fontSize: 12 }}>● {r.claimed_by ?? 'claimed'}</span>
          : <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>open</span>}
      </td>
      <td style={{ ...tdRight, color: 'var(--slate-500)' }} title={new Date(r.created_at).toLocaleString()}>
        {fmtWhen(r.created_at)}<div style={{ fontSize: 10, color: 'var(--slate-400)' }}>{r.age_h}h ago</div>
      </td>
      <td style={tdRight}>
        {r.config_id
          ? <RunChip runId={r.run_id} runStatus={r.run_status}
              onOpen={() => goDeepDive(r.config_id!, r.config_key, r.run_id ?? undefined)} />
          : <span style={{ fontSize: 11, color: 'var(--slate-300)' }}>—</span>}
      </td>
      <td style={tdRight}>
        {canClaim && r.status === 'open' && onClaim && (
          <button style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, marginRight: 10 }}
            onClick={e => { e.stopPropagation(); onClaim() }}>Claim</button>
        )}
        <span style={{ color: 'var(--slate-300)' }}>Open →</span>
      </td>
    </tr>
  )
}
