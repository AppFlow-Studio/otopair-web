'use client'

// Director · Custom jobs — what shops are doing that we don't model
// (Off-Catalog Work spec, §8).
//
// This is a READ, not a workflow. There is no promotion pipeline and no
// approval queue: deciding to build a service is a human product call made
// outside this screen. Three bands, in this order for a reason:
//
//   1. Probably already a service — the CORRECTNESS band. While a cluster sits
//      here, every driver whose custom job it covers is quietly losing
//      maintenance credit. It should normally be empty; a non-empty band is a
//      bug report about the match gate. The single alias action clears it, and
//      that alias is the only feedback path into the gate.
//   2. Shortcuts drifting — buttons whose actuals scatter. Either one key is
//      covering several jobs or the work is genuinely config-dependent; the
//      complaint texts settle it, so we flag rather than guess.
//   3. What shops are doing — the roadmap read. No buttons at all.
//
// Ranked by DISTINCT SHOPS, not occurrences: one shop doing something forty
// times is that shop's specialty, four shops doing it three times each is a
// category we're missing.

import { useContext, useMemo, useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { can } from '@/lib/portal/capabilities'
import {
  Badge, Button, Card, Modal, MicroH, tableStyles,
} from '../Primitives'
import { SectionAnchor } from '../Shell'
import { StatCard, fmtNumber } from '../Charts'

const fmtMoney = (cents: number | null) =>
  cents == null ? '—' : `$${(cents / 100).toFixed(0)}`

const fmtRange = (
  lo: number | null,
  hi: number | null,
  fmt: (n: number) => string,
) => {
  if (lo == null || hi == null) return '—'
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

/** Positive trend reads as growth; we only badge it when it's actually moving. */
function TrendPill({ trend }: { trend: number }) {
  if (trend === 0) return <span style={{ color: 'var(--slate-400)' }}>flat</span>
  const up = trend > 0
  return (
    <Badge tone={up ? 'green' : 'slate'}>
      {up ? '+' : ''}
      {trend}
    </Badge>
  )
}

type Cluster = {
  match_key: string
  name: string
  occurrences: number
  distinct_shops: number
  distinct_vehicles: number
  distinct_configs: number
  taxonomy_key: string | null
  taxonomy_label: string | null
  systems: string[]
  trend: number
  recent_count: number
  median_charged_cents: number | null
  min_charged_cents: number | null
  max_charged_cents: number | null
  median_minutes: number | null
  min_minutes: number | null
  max_minutes: number | null
  total_charged_cents: number
  sample_complaints: string[]
  resolution_rate: number | null
  outcomes_recorded: number
  from_shortcut: number
  jobs_with_parts: number
  common_parts: string[]
  median_parts_cents: number | null
  last_seen_at: number
  canonical_suggestion: {
    service_id: string
    service_name: string
    confidence: string
    score: number
  } | null
}

type RecCluster = {
  match_key: string
  name: string
  occurrences: number
  distinct_shops: number
  distinct_vehicles: number
  trend: number
  recent_count: number
  open_count: number
  driver_visible: number
  urgency_soon: number
  urgency_3mo: number
  urgency_next: number
  sample_reasons: string[]
  last_seen_at: number
  canonical_suggestion: {
    service_id: string
    service_name: string
    confidence: string
    score: number
  } | null
}

export const TabCustomJobs = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const view = useQuery(api.directorCustomJobs.patternView, token ? { token } : 'skip')
  const recView = useQuery(
    api.directorCustomJobs.recommendedPatternView,
    token ? { token } : 'skip',
  )
  const linkAlias = useMutation(api.serviceMatch.linkAlias)

  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [linking, setLinking] = useState<Cluster | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const writable = can(session?.role ?? 'readonly', 'data.write')

  const detail = useQuery(
    api.directorCustomJobs.clusterDetail,
    token && detailKey ? { token, matchKey: detailKey } : 'skip',
  )
  const parts = useQuery(
    api.directorCustomJobs.clusterParts,
    token && detailKey ? { token, matchKey: detailKey } : 'skip',
  )

  // Recommended band: detail drawer (where + who) and the promote action.
  const [recDetailKey, setRecDetailKey] = useState<string | null>(null)
  const [promoting, setPromoting] = useState<RecCluster | null>(null)
  const [promoteBusy, setPromoteBusy] = useState(false)
  const [promoteError, setPromoteError] = useState('')
  const [promoteDone, setPromoteDone] = useState<{ slug: string } | null>(null)
  const promoteCluster = useMutation(
    api.directorCustomJobs.promoteRecommendationCluster,
  )
  const recDetail = useQuery(
    api.directorCustomJobs.recommendedClusterDetail,
    token && recDetailKey ? { token, matchKey: recDetailKey } : 'skip',
  )
  const recDetailCluster = useMemo(
    () => recView?.clusters.find((c: RecCluster) => c.match_key === recDetailKey) ?? null,
    [recView, recDetailKey],
  )

  async function confirmPromote() {
    if (!promoting) return
    setPromoteBusy(true)
    setPromoteError('')
    try {
      const res = await promoteCluster({
        token,
        name: promoting.name,
        matchKey: promoting.match_key,
      })
      setPromoteDone({ slug: res.slug })
    } catch (err: unknown) {
      setPromoteError(err instanceof Error ? err.message : 'Could not promote that.')
    } finally {
      setPromoteBusy(false)
    }
  }

  const totals = view?.totals
  const exposure = totals?.exposed_vehicles ?? 0

  const detailCluster = useMemo(() => {
    if (!detailKey || !view) return null
    return (
      [...view.likelyCanonical, ...view.clusters].find(
        (c: Cluster) => c.match_key === detailKey,
      ) ?? null
    )
  }, [detailKey, view])

  async function confirmLink() {
    if (!linking?.canonical_suggestion) return
    setBusy(true)
    setError('')
    try {
      await linkAlias({
        token,
        // The cluster's own dominant spelling — so the alias key matches the
        // cluster key and the band actually clears.
        alias: linking.name,
        serviceId: linking.canonical_suggestion.service_id as Id<'services'>,
      })
      setLinking(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not link that alias.')
    } finally {
      setBusy(false)
    }
  }

  if (!view) {
    return (
      <SectionAnchor id="customJobs" title="Custom jobs">
        <Card>
          <div style={{ padding: 24, fontSize: 13, color: 'var(--slate-500)' }}>
            Loading…
          </div>
        </Card>
      </SectionAnchor>
    )
  }

  return (
    <SectionAnchor
      id="customJobs"
      title="Custom jobs"
      subtitle="Off-catalog work, clustered. Ranked by how many shops do it, not how often."
    >
      <div style={{ display: 'grid', gap: 20 }}>
        {/* Exposure leads, because it's the only number here that measures harm
            rather than opportunity. */}
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          }}
        >
          <StatCard
            label="Vehicles exposed"
            value={fmtNumber(exposure)}
            hint="Drivers losing maintenance credit right now"
            tone={exposure > 0 ? 'red' : 'green'}
          />
          <StatCard
            label="Needs aliasing"
            value={fmtNumber(totals?.likely_canonical ?? 0)}
            hint="Should normally be zero"
          />
          <StatCard
            label="Shortcuts drifting"
            value={fmtNumber(totals?.high_variance ?? 0)}
          />
          <StatCard
            label="Distinct clusters"
            value={fmtNumber(totals?.clusters ?? 0)}
          />
          <StatCard
            label="Recommended, unmodelled"
            value={fmtNumber(recView?.totals?.clusters ?? 0)}
            hint="Names shops recommend that we don't offer"
          />
        </div>

        {/* ── Band 1: correctness ────────────────────────────────────────── */}
        <Card padded={false}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--slate-200)' }}>
            <MicroH>Probably already a service we offer</MicroH>
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--slate-500)', maxWidth: '72ch', lineHeight: 1.5 }}>
              Every job in these clusters was billed as custom work, so it wrote no
              maintenance record. Linking a cluster teaches the match gate the name,
              which stops the next mechanic creating the same mismatch. Past jobs are
              not re-scored — that's offered to the driver at their next visit.
            </p>
          </div>
          {view.likelyCanonical.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--green-700, var(--slate-500))' }}>
              Nothing here. The match gate is catching them at entry.
            </div>
          ) : (
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>Typed as</th>
                  <th style={tableStyles.th}>Looks like</th>
                  <th style={tableStyles.th}>Vehicles</th>
                  <th style={tableStyles.th}>Shops</th>
                  <th style={tableStyles.th}>Jobs</th>
                  <th style={tableStyles.th} />
                </tr>
              </thead>
              <tbody>
                {view.likelyCanonical.map((c: Cluster) => (
                  <tr key={c.match_key}>
                    <td style={tableStyles.td}>
                      <button
                        onClick={() => setDetailKey(c.match_key)}
                        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--slate-900)', fontWeight: 600, textAlign: 'left' }}
                      >
                        {c.name}
                      </button>
                      {c.taxonomy_label ? (
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--slate-500)', marginTop: 3 }}>
                          {c.taxonomy_label}
                        </div>
                      ) : null}
                    </td>
                    <td style={tableStyles.td}>
                      {c.canonical_suggestion?.service_name}{' '}
                      <Badge tone={c.canonical_suggestion?.confidence === 'exact' ? 'red' : 'yellow'}>
                        {c.canonical_suggestion?.confidence}
                      </Badge>
                    </td>
                    <td style={tableStyles.td}>{c.distinct_vehicles}</td>
                    <td style={tableStyles.td}>{c.distinct_shops}</td>
                    <td style={tableStyles.td}>{c.occurrences}</td>
                    <td style={tableStyles.td}>
                      {writable ? (
                        <Button size="sm" variant="primary" onClick={() => setLinking(c)}>
                          Link
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* ── Band 2: drift ──────────────────────────────────────────────── */}
        {view.highVariance.length > 0 ? (
          <Card padded={false}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--slate-200)' }}>
              <MicroH>Shortcuts drifting</MicroH>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--slate-500)', maxWidth: '72ch', lineHeight: 1.5 }}>
                One button, scattered actuals. Either it's being pressed for several
                different jobs, or the work genuinely costs different amounts on
                different cars. The complaints on its jobs tell you which.
              </p>
            </div>
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>Shortcut</th>
                  <th style={tableStyles.th}>Uses</th>
                  <th style={tableStyles.th}>Mean</th>
                  <th style={tableStyles.th}>Spread</th>
                  <th style={tableStyles.th}>Off-default</th>
                </tr>
              </thead>
              <tbody>
                {view.highVariance.map((s: any) => (
                  <tr key={String(s._id)}>
                    <td style={{ ...tableStyles.td, fontWeight: 600 }}>{s.name}</td>
                    <td style={tableStyles.td}>{s.use_count}</td>
                    <td style={tableStyles.td}>
                      {s.mean_minutes ? `${Math.round(s.mean_minutes)}m` : '—'}
                    </td>
                    <td style={tableStyles.td}>
                      <Badge tone={(s.cv ?? 0) > 0.8 ? 'red' : 'yellow'}>
                        ±{Math.round((s.cv ?? 0) * 100)}%
                      </Badge>
                    </td>
                    <td style={tableStyles.td}>{s.deviation_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : null}

        {/* ── Band 3: the roadmap read ───────────────────────────────────── */}
        <Card padded={false}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--slate-200)' }}>
            <MicroH>What shops are doing that we don&apos;t model</MicroH>
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--slate-500)', maxWidth: '72ch', lineHeight: 1.5 }}>
              Sorted by distinct shops first. Breadth is the signal — one shop doing
              something forty times is that shop&apos;s specialty; four shops doing it
              three times each is a category we&apos;re missing.
            </p>
          </div>
          {view.clusters.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--slate-500)' }}>
              No off-catalog work recorded yet.
            </div>
          ) : (
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>Work</th>
                  <th style={tableStyles.th}>Shops</th>
                  <th style={tableStyles.th}>Jobs</th>
                  <th style={tableStyles.th}>Cars</th>
                  <th style={tableStyles.th}>90d trend</th>
                  <th style={tableStyles.th}>Charged</th>
                  <th style={tableStyles.th}>Minutes</th>
                  <th style={tableStyles.th}>Fixed it</th>
                  <th style={tableStyles.th}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {view.clusters.map((c: Cluster) => (
                  <tr key={c.match_key}>
                    <td style={tableStyles.td}>
                      <button
                        onClick={() => setDetailKey(c.match_key)}
                        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--slate-900)', fontWeight: 600, textAlign: 'left' }}
                      >
                        {c.name}
                      </button>
                      {c.taxonomy_label ? (
                        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--slate-500)', marginTop: 3 }}>
                          {c.taxonomy_label}
                          {c.jobs_with_parts > 0 ? (
                            <span style={{ color: 'var(--slate-400)' }}>
                              {' · '}{c.jobs_with_parts}/{c.occurrences} w/ parts
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {/* The parts a cluster keeps reaching for are the strongest
                          signal that it's a service we could actually price. */}
                      {c.common_parts.length > 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 2, maxWidth: '38ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.common_parts.join(' · ')}
                        </div>
                      ) : null}
                      {c.sample_complaints[0] ? (
                        <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 3, maxWidth: '38ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.sample_complaints[0]}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...tableStyles.td, fontWeight: 600 }}>{c.distinct_shops}</td>
                    <td style={tableStyles.td}>{c.occurrences}</td>
                    <td style={tableStyles.td}>{c.distinct_vehicles}</td>
                    <td style={tableStyles.td}><TrendPill trend={c.trend} /></td>
                    <td style={tableStyles.td}>
                      {fmtMoney(c.median_charged_cents)}
                      <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                        {fmtRange(c.min_charged_cents, c.max_charged_cents, (n) => `$${Math.round(n / 100)}`)}
                      </div>
                    </td>
                    <td style={tableStyles.td}>
                      {c.median_minutes != null ? `${Math.round(c.median_minutes)}m` : '—'}
                      <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                        {fmtRange(c.min_minutes, c.max_minutes, (n) => `${Math.round(n)}m`)}
                      </div>
                    </td>
                    <td style={tableStyles.td}>
                      {c.resolution_rate == null ? (
                        <span style={{ color: 'var(--slate-400)' }}>no data</span>
                      ) : (
                        <>
                          {Math.round(c.resolution_rate * 100)}%
                          <div style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                            of {c.outcomes_recorded}
                          </div>
                        </>
                      )}
                    </td>
                    <td style={tableStyles.td}>{fmtDate(c.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* ── Band 4: recommended, not yet modelled ──────────────────────────
            patternView's forward-looking twin. Band 3 is work shops already DID
            off-catalog; this is work they keep RECOMMENDING with no catalog
            service behind it — the "Tail Light Replacement" a mechanic types
            into "Something for next time". Same breadth-first ranking. */}
        <Card padded={false}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--slate-200)' }}>
            <MicroH>What shops keep recommending that we don&apos;t model</MicroH>
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--slate-500)', maxWidth: '72ch', lineHeight: 1.5 }}>
              Forward-looking demand: freeform &ldquo;something for next time&rdquo;
              recommendations with no catalog service behind them. Same signal as
              above — breadth across shops, not raw volume — but for work drivers
              have been told they&apos;ll need, not work already done.
            </p>
          </div>
          {!recView ? (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--slate-500)' }}>Loading…</div>
          ) : recView.clusters.length === 0 ? (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--slate-500)' }}>
              No off-catalog recommendations recorded yet.
            </div>
          ) : (
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>Recommended work</th>
                  <th style={tableStyles.th}>Shops</th>
                  <th style={tableStyles.th}>Recs</th>
                  <th style={tableStyles.th}>Cars</th>
                  <th style={tableStyles.th}>Open</th>
                  <th style={tableStyles.th}>Urgency</th>
                  <th style={tableStyles.th}>90d trend</th>
                  <th style={tableStyles.th}>Last seen</th>
                  <th style={tableStyles.th} />
                </tr>
              </thead>
              <tbody>
                {recView.clusters.map((c: RecCluster) => (
                  <tr key={c.match_key}>
                    <td style={tableStyles.td}>
                      <button
                        onClick={() => setRecDetailKey(c.match_key)}
                        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--slate-900)', fontWeight: 600, textAlign: 'left' }}
                      >
                        {c.name}
                      </button>
                      {c.canonical_suggestion ? (
                        <span style={{ marginLeft: 6 }}>
                          <Badge tone={c.canonical_suggestion.confidence === 'exact' ? 'red' : 'yellow'}>
                            looks like {c.canonical_suggestion.service_name}
                          </Badge>
                        </span>
                      ) : null}
                      {c.sample_reasons[0] ? (
                        <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 3, maxWidth: '44ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.sample_reasons[0]}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...tableStyles.td, fontWeight: 600 }}>{c.distinct_shops}</td>
                    <td style={tableStyles.td}>{c.occurrences}</td>
                    <td style={tableStyles.td}>{c.distinct_vehicles}</td>
                    <td style={tableStyles.td}>{c.open_count}</td>
                    <td style={tableStyles.td}>
                      <span style={{ fontSize: 11, color: 'var(--slate-500)' }}>
                        {[
                          c.urgency_soon ? `${c.urgency_soon} soon` : null,
                          c.urgency_3mo ? `${c.urgency_3mo} few-mo` : null,
                          c.urgency_next ? `${c.urgency_next} next` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </span>
                    </td>
                    <td style={tableStyles.td}><TrendPill trend={c.trend} /></td>
                    <td style={tableStyles.td}>{fmtDate(c.last_seen_at)}</td>
                    <td style={tableStyles.td}>
                      {writable ? (
                        c.canonical_suggestion?.confidence === 'exact' ? (
                          // Already a service we offer — promoting would create a
                          // duplicate. The name-level "looks like" badge says so;
                          // the fix is aliasing, not a new service.
                          <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                            exists
                          </span>
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => { setPromoting(c); setPromoteError(''); setPromoteDone(null) }}>
                            Promote
                          </Button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Detail drawer — the complaints are the point. A name tells a reviewer
          nothing; "rough idle, valves coked at 78k" tells them what to build. */}
      {/* ── Cluster sheet ──────────────────────────────────────────────────
          Was an 880px modal whose only real content was a job table. The
          question a director opens this to answer — "is this a service we
          should build, and what does it take?" — needs evidence side by side,
          not stacked in a column narrower than the data.

          Full width, and ordered as the decision is actually made: how much of
          it is there, what it takes, why it happens, then the individual jobs
          as the audit trail underneath. */}
      {detailKey ? (
        <Modal
          open
          width={1240}
          onClose={() => setDetailKey(null)}
          eyebrow={
            detailCluster?.taxonomy_label ? (
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--slate-500)' }}>
                {detailCluster.taxonomy_label}
              </span>
            ) : undefined
          }
          statusBadge={
            detailCluster?.canonical_suggestion ? (
              <Badge tone={detailCluster.canonical_suggestion.confidence === 'exact' ? 'red' : 'yellow'}>
                looks like {detailCluster.canonical_suggestion.service_name}
              </Badge>
            ) : undefined
          }
          title={detailCluster?.name ?? 'Cluster'}
        >
          <div style={{ display: 'grid', gap: 18, maxHeight: '74vh', overflowY: 'auto' }}>

            {/* Scale first. Breadth is the signal — four shops doing something
                three times each is a category we're missing; one shop doing it
                forty times is that shop's speciality. */}
            {detailCluster ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 1, background: 'var(--slate-200)', border: '1px solid var(--slate-200)', borderRadius: 8, overflow: 'hidden' }}>
                {[
                  { k: 'Shops', v: String(detailCluster.distinct_shops), n: 'breadth' },
                  { k: 'Jobs', v: String(detailCluster.occurrences), n: 'total logged' },
                  { k: 'Cars', v: String(detailCluster.distinct_vehicles), n: 'distinct VINs' },
                  { k: 'Median time', v: detailCluster.median_minutes != null ? `${detailCluster.median_minutes}m` : '—', n: 'actual' },
                  { k: 'Median charged', v: fmtMoney(detailCluster.median_charged_cents), n: 'per job' },
                  {
                    k: 'Fixed it',
                    v: detailCluster.resolution_rate == null ? '—' : `${Math.round(detailCluster.resolution_rate * 100)}%`,
                    n: `${detailCluster.outcomes_recorded} reported`,
                  },
                  {
                    k: 'Needs parts',
                    v: `${detailCluster.jobs_with_parts}/${detailCluster.occurrences}`,
                    n: 'of jobs',
                  },
                ].map((cell) => (
                  <div key={cell.k} style={{ background: '#fff', padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--slate-400)' }}>{cell.k}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{cell.v}</div>
                    <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 1 }}>{cell.n}</div>
                  </div>
                ))}
              </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
              {/* What it takes. The parts a cluster keeps reaching for are the
                  strongest evidence it's a service we could actually price. */}
              <div>
                <MicroH>What it takes</MicroH>
                {parts && parts.parts.length > 0 ? (
                  <table style={tableStyles.table}>
                    <thead>
                      <tr>
                        <th style={tableStyles.th}>Part</th>
                        <th style={tableStyles.th}>OEM</th>
                        <th style={tableStyles.th}>Seen</th>
                        <th style={tableStyles.th}>Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parts.parts.map((p: any, i: number) => (
                        <tr key={i}>
                          <td style={tableStyles.td}>{p.name}</td>
                          <td style={{ ...tableStyles.td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                            {p.oem_number ?? '—'}
                          </td>
                          <td style={tableStyles.td}>{p.count}×</td>
                          <td style={tableStyles.td}>{p.total_cents ? fmtMoney(p.total_cents) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 8 }}>
                    No parts recorded against this work yet.
                  </div>
                )}
                {/* Said plainly rather than shown as an empty column: these are
                    jobs that billed a part before per-line attribution existed,
                    and claiming the part belongs to THIS work would be a guess. */}
                {parts && parts.unattributed_jobs > 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 8, lineHeight: 1.5 }}>
                    {parts.unattributed_jobs} job{parts.unattributed_jobs === 1 ? '' : 's'} billed parts that name no line — recorded before parts could be attributed, so they aren&apos;t counted above.
                  </div>
                ) : null}
              </div>

              {/* Why it happens. The verbatim complaints are the only thing
                  here that says what the work actually IS. */}
              <div>
                <MicroH>Why it happens</MicroH>
                {detailCluster?.sample_complaints?.length ? (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: 'var(--slate-700)' }}>
                    {detailCluster.sample_complaints.map((text: string, i: number) => (
                      <li key={i} style={{ marginBottom: 6 }}>{text}</li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 8 }}>
                    Nobody recorded why. Without it a cluster is a name and a number.
                  </div>
                )}
                {detailCluster && detailCluster.systems.length > 0 ? (
                  <div style={{ marginTop: 14 }}>
                    <MicroH>Systems touched</MicroH>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {detailCluster.systems.map((sys: string) => (
                        <Badge key={sys} tone="slate">{sys.replace(/_/g, ' ')}</Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div>
              <MicroH>Every job in this cluster</MicroH>
              <table style={tableStyles.table}>
                <thead>
                  <tr>
                    <th style={tableStyles.th}>Shop</th>
                    <th style={tableStyles.th}>Vehicle</th>
                    <th style={tableStyles.th}>Found</th>
                    <th style={tableStyles.th}>Complaint</th>
                    <th style={tableStyles.th}>Parts</th>
                    <th style={tableStyles.th}>Resolution</th>
                    <th style={tableStyles.th}>Min</th>
                    <th style={tableStyles.th}>Charged</th>
                    <th style={tableStyles.th}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail ?? []).map((row: any) => (
                    <tr key={String(row._id)}>
                      <td style={tableStyles.td}>{row.shop_name ?? '—'}</td>
                      <td style={{ ...tableStyles.td, maxWidth: 210 }}>
                        {row.config_key ?? (
                          // No config means a pseudo-VIN walk-in: the labor and
                          // price on this row aren't scoped to a real car.
                          <Badge tone="yellow">unidentified</Badge>
                        )}
                      </td>
                      <td style={tableStyles.td}>
                        {/* Work nobody planned for is the strongest evidence
                            the catalog is short. */}
                        {row.source === 'mid_job'
                          ? <Badge tone="yellow">mid-job</Badge>
                          : <span style={{ color: 'var(--slate-400)' }}>booked</span>}
                      </td>
                      <td style={{ ...tableStyles.td, maxWidth: 200 }}>{row.complaint ?? '—'}</td>
                      <td style={{ ...tableStyles.td, maxWidth: 190 }}>
                        {row.parts && row.parts.length > 0 ? (
                          <div>
                            {row.parts.map((part: any, i: number) => (
                              <div key={i} style={{ fontSize: 12 }}>
                                {part.part_name}
                                {part.quantity > 1 ? ` ×${part.quantity}` : ''}
                                {part.oem_number ? (
                                  <span style={{ color: 'var(--slate-500)', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                                    {' '}{part.oem_number}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                            {row.quoted_parts_cents ? (
                              <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 2 }}>
                                {fmtMoney(row.quoted_parts_cents)}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--slate-400)' }}>none</span>
                        )}
                      </td>
                      <td style={{ ...tableStyles.td, maxWidth: 220 }}>
                        {row.resolution ?? <span style={{ color: 'var(--slate-400)' }}>none recorded</span>}
                        {row.resolved_complaint === true ? ' ✓' : null}
                        {row.resolved_complaint === false ? ' ✕' : null}
                      </td>
                      <td style={tableStyles.td}>{row.actual_minutes ?? row.estimated_minutes ?? '—'}</td>
                      <td style={tableStyles.td}>{fmtMoney(row.charged_price_cents)}</td>
                      <td style={tableStyles.td}>{fmtDate(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* The one write on this screen. */}
      {linking ? (
        <Modal
          open
          onClose={() => { setLinking(null); setError('') }}
          title="Link to an existing service"
        >
          <div style={{ display: 'grid', gap: 14, fontSize: 13, lineHeight: 1.55 }}>
            <p style={{ margin: 0 }}>
              Record that <strong>&ldquo;{linking.name}&rdquo;</strong> means{' '}
              <strong>{linking.canonical_suggestion?.service_name}</strong>.
            </p>
            <p style={{ margin: 0, color: 'var(--slate-600)' }}>
              From now on, a mechanic typing that name lands on the catalog service
              instead of creating custom work. The {linking.occurrences} job(s) already
              recorded are <strong>not</strong> re-scored — those are offered back to
              each driver for confirmation at their next visit.
            </p>
            {error ? (
              <p style={{ margin: 0, color: 'var(--red-600, #b3261e)' }}>{error}</p>
            ) : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => { setLinking(null); setError('') }}>
                Cancel
              </Button>
              <Button onClick={confirmLink} disabled={busy}>
                {busy ? 'Linking…' : 'Link alias'}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* Recommended-cluster detail — where and who recommends it. */}
      {recDetailKey ? (
        <Modal
          open
          width={1000}
          onClose={() => setRecDetailKey(null)}
          eyebrow={
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--slate-500)' }}>
              Recommended · where &amp; who
            </span>
          }
          title={recDetailCluster?.name ?? 'Recommended work'}
        >
          <div style={{ display: 'grid', gap: 16, maxHeight: '72vh', overflowY: 'auto' }}>
            {recDetailCluster ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 1, background: 'var(--slate-200)', border: '1px solid var(--slate-200)', borderRadius: 8, overflow: 'hidden' }}>
                {[
                  { k: 'Shops', v: String(recDetailCluster.distinct_shops), n: 'breadth' },
                  { k: 'Recs', v: String(recDetailCluster.occurrences), n: 'total flagged' },
                  { k: 'Cars', v: String(recDetailCluster.distinct_vehicles), n: 'distinct VINs' },
                  { k: 'Open', v: String(recDetailCluster.open_count), n: 'still live' },
                  { k: 'Shown driver', v: String(recDetailCluster.driver_visible), n: 'of recs' },
                ].map((cell) => (
                  <div key={cell.k} style={{ background: '#fff', padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--slate-400)' }}>{cell.k}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{cell.v}</div>
                    <div style={{ fontSize: 11, color: 'var(--slate-500)', marginTop: 1 }}>{cell.n}</div>
                  </div>
                ))}
              </div>
            ) : null}

            <div>
              <MicroH>Every recommendation in this cluster</MicroH>
              {recDetail === undefined ? (
                <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 8 }}>Loading…</div>
              ) : recDetail.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 8 }}>Nothing here.</div>
              ) : (
                <table style={tableStyles.table}>
                  <thead>
                    <tr>
                      <th style={tableStyles.th}>Shop</th>
                      <th style={tableStyles.th}>Mechanic</th>
                      <th style={tableStyles.th}>Vehicle</th>
                      <th style={tableStyles.th}>Urgency</th>
                      <th style={tableStyles.th}>Why</th>
                      <th style={tableStyles.th}>Shown</th>
                      <th style={tableStyles.th}>Status</th>
                      <th style={tableStyles.th}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recDetail.map((r: any) => (
                      <tr key={String(r._id)}>
                        <td style={{ ...tableStyles.td, fontWeight: 600 }}>{r.shop_name ?? '—'}</td>
                        <td style={tableStyles.td}>{r.mechanic_name ?? '—'}</td>
                        <td style={tableStyles.td}>
                          {r.vehicle_year ? `${r.vehicle_year} · ` : ''}
                          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--slate-500)' }}>{r.vehicle_vin}</span>
                        </td>
                        <td style={tableStyles.td}>
                          {r.urgency === 'soon' ? 'Soon' : r.urgency === 'within_3_months' ? 'Few months' : 'Next visit'}
                        </td>
                        <td style={{ ...tableStyles.td, maxWidth: 260 }}>{r.reason ?? <span style={{ color: 'var(--slate-400)' }}>—</span>}</td>
                        <td style={tableStyles.td}>{r.visible_to_driver ? 'driver' : 'internal'}</td>
                        <td style={tableStyles.td}>
                          <Badge tone={r.status === 'open' ? 'green' : r.status === 'completed' ? 'slate' : 'yellow'}>{r.status}</Badge>
                        </td>
                        <td style={tableStyles.td}>{fmtDate(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </Modal>
      ) : null}

      {/* Promote a recommended cluster into a (draft) catalog service. */}
      {promoting ? (
        <Modal
          open
          onClose={() => { setPromoting(null); setPromoteError(''); setPromoteDone(null) }}
          title={promoteDone ? 'Draft service created' : 'Promote to catalog service'}
        >
          <div style={{ display: 'grid', gap: 14, fontSize: 13, lineHeight: 1.55 }}>
            {promoteDone ? (
              <>
                <p style={{ margin: 0 }}>
                  <strong>&ldquo;{promoting.name}&rdquo;</strong> is now a draft service
                  (<code>{promoteDone.slug}</code>).
                </p>
                <p style={{ margin: 0, color: 'var(--slate-600)' }}>
                  It&apos;s <strong>not bookable yet</strong> — set its pricing, labor and
                  parts in <strong>Services</strong> to make it live. The name is aliased,
                  so mechanics typing it now land on this service instead of filing
                  custom work. Existing recommendations are not re-pointed.
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button onClick={() => { setPromoting(null); setPromoteDone(null) }}>Done</Button>
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>
                  Create a catalog service from <strong>&ldquo;{promoting.name}&rdquo;</strong> —
                  recommended by <strong>{promoting.distinct_shops}</strong> shop{promoting.distinct_shops === 1 ? '' : 's'} across{' '}
                  <strong>{promoting.occurrences}</strong> recommendation{promoting.occurrences === 1 ? '' : 's'}.
                </p>
                <p style={{ margin: 0, color: 'var(--slate-600)' }}>
                  It&apos;s created as a <strong>draft (not bookable)</strong> — a cluster
                  has no pricing, so finish it in Services before it goes live. The name
                  is aliased so the next mechanic lands on it instead of re-typing it.
                </p>
                {promoting.canonical_suggestion ? (
                  <p style={{ margin: 0, color: 'var(--amber-700, #b45309)' }}>
                    Heads up: this looks like <strong>{promoting.canonical_suggestion.service_name}</strong>{' '}
                    ({promoting.canonical_suggestion.confidence}). If that&apos;s the same
                    work, alias it instead of creating a duplicate.
                  </p>
                ) : null}
                {promoteError ? (
                  <p style={{ margin: 0, color: 'var(--red-600, #b3261e)' }}>{promoteError}</p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Button variant="secondary" onClick={() => { setPromoting(null); setPromoteError('') }}>Cancel</Button>
                  <Button onClick={confirmPromote} disabled={promoteBusy}>
                    {promoteBusy ? 'Promoting…' : 'Create draft service'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      ) : null}
    </SectionAnchor>
  )
}
