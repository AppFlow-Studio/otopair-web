'use client'

// Needs Attention · Unpriced parts — CORE-role parts fitted with no trusted
// price (no part_prices row survives the poison/non-pooled/price-band
// filter), so the service they belong to can't actually be quoted. A live
// scan (convex/directorPartQuality.ts scanUnpricedParts) — the wrong-part
// counterpart lives in WrongPartsPanel.tsx. Same searchable/filterable/
// paginated table + side-drawer ceremony as Wrong Parts: a row opens a
// drawer where BOTH a price and a source link (where the director found
// that price) are required, gated behind a confirmation popup before
// writing. directorConfigActions.addManualPartPrice stamps the price row
// itself with source_url and refreshed_at/created_at, and writes its own
// audit_log entry (who/when/source) — same ceremony as every other admin
// write in this console.

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Sidebar, MicroH, Input, IconSearch } from '../../Primitives'
import { Panel, Empty, SkeletonBlock, CopyableMono, ConfirmPopup, TableWrap, th, td, thRight, PageNav, fmtWhen, fmtWhenExact, RunChip, DateRangeFilter, dateInRange } from './helpers'

type UnpricedPartFlag = FunctionReturnType<typeof api.directorPartQuality.scanUnpricedParts>['flags'][number]

const PAGE_SIZE = 15
const drawerInput: React.CSSProperties = { border: '1px solid var(--slate-200)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--slate-800)', background: '#fff', fontFamily: 'inherit', width: '100%' }

const ERROR_MESSAGES: Record<string, string> = {
  invalid_price: 'Enter a valid price.',
  source_url_required: 'Enter a source link (where you found this price).',
  invalid_source_url: 'That doesn’t look like a valid link (needs http:// or https://).',
  part_not_found: 'This part no longer exists.',
}

export function UnpricedPartsPanel({ token, goDeepDive }: {
  token: string
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const data = useQuery(api.directorPartQuality.scanUnpricedParts, { token })
  const [search, setSearch] = useState('')
  const [serviceFilter, setServiceFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<UnpricedPartFlag | null>(null)

  const serviceTypes = useMemo(() => {
    const set = new Set<string>()
    for (const f of data?.flags ?? []) if (f.serviceType) set.add(f.serviceType)
    return [...set].sort()
  }, [data])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.flags.filter(f => {
      if (serviceFilter !== 'all' && f.serviceType !== serviceFilter) return false
      if (!dateInRange(f.firstSeenAt, dateFrom, dateTo)) return false
      if (!q) return true
      const hay = [f.vin, f.configKey, f.oemNumber, f.partName, f.make, f.model, f.trim, String(f.year ?? '')]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [data, search, serviceFilter, dateFrom, dateTo])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE)

  return (
    <Panel title="Unpriced parts" sub={data ? `${data.flags.length}${data.truncated ? '+' : ''} flagged` : undefined}
      right={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input icon={<IconSearch size={14} />} value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}
            placeholder="Search VIN, config, part…" style={{ width: 200, height: 30 }} />
          {serviceTypes.length > 0 && (
            <select value={serviceFilter} onChange={e => { setServiceFilter(e.target.value); setPage(0) }}
              style={{ ...drawerInput, width: 'auto', height: 30, cursor: 'pointer' }}>
              <option value="all">All services ({data?.flags.length ?? 0})</option>
              {serviceTypes.map(s => (
                <option key={s} value={s}>{s} ({(data?.flags ?? []).filter(f => f.serviceType === s).length})</option>
              ))}
            </select>
          )}
          <DateRangeFilter from={dateFrom} to={dateTo}
            onFrom={v => { setDateFrom(v); setPage(0) }} onTo={v => { setDateTo(v); setPage(0) }} />
        </div>
      }>
      {!data ? <SkeletonBlock height={200} /> : filtered.length === 0 ? (
        <Empty>{data.flags.length === 0 ? 'No unpriced core parts found in the most recently confirmed fitments.' : 'No flags match this search/filter.'}</Empty>
      ) : (
        <>
          <TableWrap>
            <thead><tr>
              <th style={th}>Vehicle</th>
              <th style={th}>Part</th>
              <th style={th}>Service</th>
              <th style={thRight}>First seen</th>
              <th style={thRight}>Run</th>
              <th style={thRight}>Price</th>
            </tr></thead>
            <tbody>
              {pageRows.map(f => {
                const carLabel = [f.year, f.make, f.model, f.trim].filter(Boolean).join(' ')
                return (
                  <tr key={f.fitmentId} onClick={() => setSelected(f)} style={{ cursor: 'pointer' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--slate-50)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                    <td style={{ ...td, padding: '16px 18px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--slate-800)' }}>{carLabel || f.configKey || f.configId}</div>
                      {f.vin && <div className="mono" style={{ fontSize: 11, color: 'var(--slate-400)' }}>{f.vin}</div>}
                    </td>
                    <td style={{ ...td, padding: '16px 18px' }}>
                      <CopyableMono value={f.oemNumber} style={{ fontWeight: 600 }} />
                      <div style={{ fontSize: 11, color: 'var(--slate-500)' }}>{f.partName}</div>
                      {f.scrapedName && f.scrapedName !== f.partName && (
                        <div style={{ fontSize: 11, color: 'var(--slate-400)', fontStyle: 'italic' }}>
                          listed as “{f.scrapedName}”
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, padding: '16px 18px' }}>{f.serviceType ?? '—'}</td>
                    <td style={{ ...thRight, padding: '16px 18px', color: 'var(--slate-500)' }} title={fmtWhenExact(f.firstSeenAt)}>{fmtWhen(f.firstSeenAt)}</td>
                    <td style={{ ...thRight, padding: '16px 18px' }}>
                      <RunChip runId={f.runId} runStatus={f.runStatus} approx
                        onOpen={() => goDeepDive(f.configId, f.configKey, f.runId ?? undefined)} />
                    </td>
                    <td style={{ ...thRight, padding: '16px 18px', color: 'var(--slate-300)' }}>Add price →</td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
          <PageNav page={clampedPage} pageCount={pageCount} total={filtered.length} pageSize={PAGE_SIZE}
            note={data.truncated ? 'scan capped — older fitments excluded' : undefined} onPage={setPage} />
        </>
      )}
      <UnpricedPartDrawer key={selected?.fitmentId ?? 'none'} token={token} flag={selected}
        onClose={() => setSelected(null)} goDeepDive={goDeepDive} />
    </Panel>
  )
}

export type { UnpricedPartFlag }

/** The unpriced-part drawer (add a price + source, audited). Exported so the
 *  car-centric Needs Attention tabs (Incomplete Car Configs) can launch the
 *  same ceremony a director already knows from the Unpriced parts tab. */
export function UnpricedPartDrawer({ token, flag, onClose, goDeepDive }: {
  token: string
  flag: UnpricedPartFlag | null
  onClose: () => void
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const addPrice = useMutation(api.directorConfigActions.addManualPartPrice)
  const [price, setPrice] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  // The price + source-link inputs gate whether this CAN be submitted;
  // `pending` gates whether the director MEANT to click — same two-stage
  // ceremony as WrongPartsPanel's drawer and ReviewSidebar's flag actions.
  const [pending, setPending] = useState(false)

  if (!flag) return <Sidebar open={false} onClose={onClose} title="Unpriced part" />

  const carLabel = [flag.year, flag.make, flag.model, flag.trim].filter(Boolean).join(' ')
  const parsedPrice = Number(price)
  const openDeepDive = () => { onClose(); goDeepDive(flag.configId, flag.configKey, flag.runId ?? undefined) }

  const requestSubmit = () => {
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) { setErr('Enter a valid price.'); return }
    if (!sourceUrl.trim()) { setErr('Enter a source link (where you found this price).'); return }
    setErr('')
    setPending(true)
  }
  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const res = await addPrice({ token, partId: flag.partId as Id<'oem_parts'>, price: parsedPrice, sourceUrl: sourceUrl.trim() })
      if (!res.ok) { setBusy(false); setPending(false); setErr(ERROR_MESSAGES[res.reason] ?? 'Failed to save.'); return }
      setBusy(false); setPending(false); setDone(true)
    } catch (e) {
      setBusy(false); setPending(false); setErr(e instanceof Error ? e.message : 'Failed to save.')
    }
  }

  return (
    <Sidebar open onClose={onClose} title="Unpriced part" width={480}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {done ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--green-700)' }}>✓ Price added — trusted for quoting from now on.</div>
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <div>
              <MicroH style={{ marginBottom: 7 }}>Vehicle</MicroH>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                {carLabel && <CopyableMono mono={false} label="YMMT" value={carLabel} />}
                {flag.vin && <CopyableMono value={flag.vin} label="VIN" />}
                {flag.configKey && <CopyableMono value={flag.configKey} label="config" />}
                <button type="button" className="mono" onClick={openDeepDive}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500 }}>
                  Open in Deep-Dive →
                </button>
              </div>
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Part</MicroH>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--slate-800)' }}>
                <CopyableMono value={flag.oemNumber} style={{ fontWeight: 600 }} /> — {flag.partName}
              </div>
              <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>
                {flag.serviceType && <>Service: <span className="mono">{flag.serviceType}</span> · </>}
                First seen {fmtWhen(flag.firstSeenAt)}
              </div>
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Run to investigate</MicroH>
              <RunChip runId={flag.runId} runStatus={flag.runStatus} approx onOpen={openDeepDive} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--slate-200)', borderRadius: 8, padding: '16px 18px' }}>
              <MicroH>Price</MicroH>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ ...drawerInput, width: 'auto', display: 'flex', alignItems: 'center', color: 'var(--slate-400)' }}>$</span>
                <input value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" inputMode="decimal" style={drawerInput} />
              </div>
              <MicroH>Source link — where you found this price</MicroH>
              <input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://…" className="mono" style={drawerInput} />
            </div>

            {err && <div style={{ fontSize: 12, color: 'var(--red-600)' }}>{err}</div>}

            <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid var(--slate-200)' }}>
              <Button variant="primary" size="sm" disabled={busy} onClick={requestSubmit}>Add price</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
      {pending && (
        <ConfirmPopup open onCancel={() => setPending(false)} onConfirm={submit} busy={busy}
          title="Add this price?"
          message={<>Adds <b className="mono">${parsedPrice.toFixed(2)}</b> for <b className="mono">{flag.oemNumber}</b>, sourced from <span style={{ wordBreak: 'break-word' }}>{sourceUrl.trim()}</span>. Trusted for quoting from now on.</>}
          confirmLabel="Add price" />
      )}
    </Sidebar>
  )
}
