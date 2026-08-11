'use client'

// Needs Attention · Missing parts — the fleet-wide view of parts-bearing
// services a config has NO usable OEM fitment for (the per-config version is
// serviceParts.getServiceGapsForConfig, reachable only from a review item's
// sidebar today). Grouped by car (YMMT) with an accordion so a director expands
// one vehicle and fills every hole it has in one place. Each missing role
// launches AddMissingPartDrawer — the same OEM#+name form + addConfigFitment
// writer the review sidebar already uses (creates the oem_parts row if missing,
// writes a mechanic-verified fitment). Adding a part clears the row reactively:
// scanMissingParts live-re-checks the fitment on its next run.

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@/convex/_generated/dataModel'
import { Button, Sidebar, MicroH, Input, IconSearch } from '../../Primitives'
import { Panel, Empty, SkeletonBlock, CarAccordionItem, CountPill, CopyableMono, RunChip, RunLink } from './helpers'

export type MissingPartFlag = FunctionReturnType<typeof api.directorPartQuality.scanMissingParts>['flags'][number]

const drawerInput: React.CSSProperties = { border: '1px solid var(--slate-200)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--slate-800)', background: '#fff', fontFamily: 'inherit', width: '100%' }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--blue-700)', fontSize: 12, fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap' }

export type CarGroup<T extends { configId: string; year: number | null; make: string | null; model: string | null; trim: string | null; vin: string | null; configKey: string | null }> = {
  configId: string
  car: T
  items: T[]
}

/** Fold a flat per-item flag array into one group per config, richest first —
 *  the shared car-centric transform behind both the Missing parts tab and the
 *  Incomplete Car Configs merge. */
export function groupByConfig<T extends { configId: string; year: number | null; make: string | null; model: string | null; trim: string | null; vin: string | null; configKey: string | null }>(flags: T[]): CarGroup<T>[] {
  const map = new Map<string, CarGroup<T>>()
  for (const f of flags) {
    const g = map.get(f.configId)
    if (g) g.items.push(f)
    else map.set(f.configId, { configId: f.configId, car: f, items: [f] })
  }
  return [...map.values()].sort((a, b) => b.items.length - a.items.length)
}

export function carLabelOf(f: { year: number | null; make: string | null; model: string | null; trim: string | null }): string {
  return [f.year, f.make, f.model, f.trim].filter(Boolean).join(' ')
}

export function MissingPartsPanel({ token, goDeepDive }: {
  token: string
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const data = useQuery(api.directorPartQuality.scanMissingParts, { token })
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<MissingPartFlag | null>(null)

  const allGroups = useMemo(() => groupByConfig(data?.flags ?? []), [data])
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allGroups
    return allGroups.filter(g => {
      const hay = [carLabelOf(g.car), g.car.vin, g.car.configKey, ...g.items.map(i => i.serviceName), ...g.items.map(i => i.roleLabel)]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [allGroups, search])

  return (
    <Panel title="Missing parts" sub={data ? `${data.flags.length}${data.truncated ? '+' : ''} across ${allGroups.length} ${allGroups.length === 1 ? 'car' : 'cars'}` : undefined}
      right={
        <Input icon={<IconSearch size={14} />} value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search YMMT, VIN, service…" style={{ width: 220, height: 30 }} />
      }>
      {!data ? <SkeletonBlock height={200} /> : groups.length === 0 ? (
        <Empty>{data.flags.length === 0 ? 'No configs are missing a core part in the most recent runs.' : 'No cars match this search.'}</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groups.map(g => (
            <CarAccordionItem key={g.configId} open={expanded === g.configId}
              onToggle={() => setExpanded(expanded === g.configId ? null : g.configId)}
              title={carLabelOf(g.car) || g.car.configKey || g.configId}
              subtitle={g.car.vin ?? g.car.configKey ?? undefined}
              badges={<CountPill n={g.items.length} label="missing" tone="orange" />}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {g.items.map(item => (
                  <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '8px 10px', border: '1px solid var(--slate-100)', borderRadius: 8 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: 'var(--slate-800)' }}>{item.serviceName}</span>
                      <span style={{ color: 'var(--slate-400)' }}> · {item.roleLabel}</span>
                    </span>
                    <RunLink runId={item.runId} runStatus={item.runStatus}
                      onOpen={() => goDeepDive(item.configId, item.configKey, item.runId ?? undefined)} />
                    <button style={linkBtn} onClick={() => setSelected(item)}>Add part →</button>
                  </div>
                ))}
              </div>
            </CarAccordionItem>
          ))}
          {data.truncated && (
            <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 2 }}>Scan capped — older runs excluded.</div>
          )}
        </div>
      )}
      <AddMissingPartDrawer key={selected?.key ?? 'none'} token={token} flag={selected}
        onClose={() => setSelected(null)} goDeepDive={goDeepDive} />
    </Panel>
  )
}

/** Add the OEM part for a missing CORE role — the launcher target for both the
 *  Missing parts tab and the Incomplete Car Configs tab. OEM# + optional name,
 *  written mechanic-verified via directorConfigActions.addConfigFitment (same
 *  writer + audit trail the review sidebar's "Add part" uses). No confirm
 *  popup: the add is additive, not destructive. */
export function AddMissingPartDrawer({ token, flag, onClose, goDeepDive }: {
  token: string
  flag: MissingPartFlag | null
  onClose: () => void
  goDeepDive: (configId: string, configKey: string | null, runId?: string) => void
}) {
  const addFitment = useMutation(api.directorConfigActions.addConfigFitment)
  const [oem, setOem] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  if (!flag) return <Sidebar open={false} onClose={onClose} title="Add missing part" />

  const carLabel = carLabelOf(flag)
  const openDeepDive = () => { onClose(); goDeepDive(flag.configId, flag.configKey, flag.runId ?? undefined) }

  const submit = async () => {
    if (!oem.trim()) { setErr('Enter the OEM part number.'); return }
    setBusy(true); setErr('')
    try {
      await addFitment({ token, vehicleConfigId: flag.configId as Id<'vehicle_configs'>, serviceSlug: flag.serviceSlug, roleKey: flag.roleKey, oemNumber: oem.trim(), partName: name.trim() || undefined })
      setBusy(false); setDone(true)
    } catch (e) {
      setBusy(false); setErr(e instanceof Error ? e.message : 'Failed to save.')
    }
  }

  return (
    <Sidebar open onClose={onClose} title="Add missing part" width={480}>
      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {done ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--green-700)' }}>✓ Part added — mechanic-verified and trusted for quoting from now on.</div>
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
                <button type="button" className="mono" style={linkBtn} onClick={openDeepDive}>Open in Deep-Dive →</button>
              </div>
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Missing part</MicroH>
              <div style={{ fontSize: 13, color: 'var(--slate-800)' }}>{flag.serviceName} · {flag.roleLabel}</div>
              <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>
                This config has no OEM part on file for this service — add the correct OEM number to make it quotable.
              </div>
            </div>

            <div>
              <MicroH style={{ marginBottom: 7 }}>Run to investigate</MicroH>
              <RunChip runId={flag.runId} runStatus={flag.runStatus} approx onOpen={openDeepDive} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--slate-200)', borderRadius: 8, padding: '16px 18px' }}>
              <MicroH>Part</MicroH>
              <input value={oem} onChange={e => setOem(e.target.value)} placeholder="OEM part number" className="mono" style={drawerInput} />
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Part name (optional)" style={drawerInput} />
            </div>

            {err && <div style={{ fontSize: 12, color: 'var(--red-600)' }}>{err}</div>}

            <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid var(--slate-200)' }}>
              <Button variant="primary" size="sm" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add part'}</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </Sidebar>
  )
}
