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

export const TabCustomJobs = () => {
  const session = useContext(DirectorSessionCtx)
  const token = session?.token ?? ''
  const view = useQuery(api.directorCustomJobs.patternView, token ? { token } : 'skip')
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
      </div>

      {/* Detail drawer — the complaints are the point. A name tells a reviewer
          nothing; "rough idle, valves coked at 78k" tells them what to build. */}
      {detailKey ? (
        <Modal
          open
          onClose={() => setDetailKey(null)}
          title={detailCluster?.name ?? 'Cluster'}
        >
          <div style={{ display: 'grid', gap: 16, maxHeight: '70vh', overflowY: 'auto' }}>
            {detailCluster?.sample_complaints?.length ? (
              <div>
                <MicroH>Why it happened</MicroH>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.55, color: 'var(--slate-700)' }}>
                  {detailCluster.sample_complaints.map((text: string, i: number) => (
                    <li key={i} style={{ marginBottom: 4 }}>{text}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {parts && parts.length > 0 ? (
              <div>
                <MicroH>Parts used</MicroH>
                <div style={{ fontSize: 12, color: 'var(--slate-500)', margin: '4px 0 8px' }}>
                  Most of the catalog work for this service is already done here.
                </div>
                <table style={tableStyles.table}>
                  <thead>
                    <tr>
                      <th style={tableStyles.th}>Part</th>
                      <th style={tableStyles.th}>OEM</th>
                      <th style={tableStyles.th}>Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parts.map((p: any, i: number) => (
                      <tr key={i}>
                        <td style={tableStyles.td}>{p.name}</td>
                        <td style={{ ...tableStyles.td, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                          {p.oem_number ?? '—'}
                        </td>
                        <td style={tableStyles.td}>{p.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div>
              <MicroH>Every job in this cluster</MicroH>
              <table style={tableStyles.table}>
                <thead>
                  <tr>
                    <th style={tableStyles.th}>Shop</th>
                    <th style={tableStyles.th}>Vehicle</th>
                    <th style={tableStyles.th}>Complaint</th>
                    <th style={tableStyles.th}>Parts</th>
                    <th style={tableStyles.th}>Resolution</th>
                    <th style={tableStyles.th}>Min</th>
                    <th style={tableStyles.th}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail ?? []).map((row: any) => (
                    <tr key={String(row._id)}>
                      <td style={tableStyles.td}>{row.shop_name ?? '—'}</td>
                      <td style={tableStyles.td}>
                        {row.config_key ?? (
                          // No config means a pseudo-VIN walk-in: the labor and
                          // price on this row aren't scoped to a real car.
                          <Badge tone="yellow">unidentified</Badge>
                        )}
                      </td>
                      <td style={{ ...tableStyles.td, maxWidth: 220 }}>{row.complaint ?? '—'}</td>
                      <td style={{ ...tableStyles.td, maxWidth: 200 }}>
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
    </SectionAnchor>
  )
}
