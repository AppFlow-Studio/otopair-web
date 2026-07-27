'use client'

// Director panel · Enrichment tab — live enrichment-pipeline observability
// (Overview · Live Runs · Costs · Flags & Quality · Deep-Dive) with per-run
// pipeline trace. Built natively on the panel's inline-style design system
// (Primitives / Charts), sourcing token + role from the director session.

import { useState, useContext } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { can } from '@/lib/portal/capabilities'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { Zone, TriggerCeremony, triggerCapability, type TriggerRequest } from './enrichment/helpers'
import { ReviewSidebar } from './enrichment/ReviewSidebar'
import { NeedsAttentionTab } from './enrichment/NeedsAttentionTab'
import { OverviewTab } from './enrichment/OverviewTab'
import { LiveRunsTab } from './enrichment/LiveRunsTab'
import { CostsTab } from './enrichment/CostsTab'
import { FlagsTab } from './enrichment/FlagsTab'
import { DeepDiveTab, type PickedConfig } from './enrichment/DeepDiveTab'
import { PipelineTab } from './enrichment/PipelineTab'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'attention', label: 'Needs Attention' },
  { id: 'runs', label: 'Live Runs' },
  { id: 'costs', label: 'Costs' },
  { id: 'flags', label: 'Flags & Quality' },
  { id: 'config', label: 'Deep-Dive' },
  { id: 'pipeline', label: 'Pipeline' },
] as const
type TabId = (typeof TABS)[number]['id']

export function TabEnrichment() {
  const session = useContext(DirectorSessionCtx)
  const [tab, setTab] = useState<TabId>('overview')
  const [selected, setSelected] = useState<PickedConfig | null>(null)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  const [ceremony, setCeremony] = useState<TriggerRequest | null>(null)
  // The review sidebar is independent of the ceremony/trigger system — every
  // review row (Overview's stale rail, Needs Attention's full queue) opens
  // this SAME instance, so there is exactly one place that knows how to
  // show/resolve a review item instead of each list owning its own popup.
  const [sidebarItem, setSidebarItem] = useState<{ id: string; title: string } | null>(null)

  const reEnrich = useMutation(api.dataControlRoom.triggerReEnrich)
  const purge = useMutation(api.directorEnrichment.purgeAndReenrich)
  const unstick = useMutation(api.directorEnrichment.forceUnstickRun)
  const bulkUnstick = useMutation(api.directorEnrichment.bulkForceUnstickStale)
  const acknowledgeRun = useMutation(api.directorEnrichment.acknowledgeRun)
  const claimReview = useMutation(api.reviewQueue.claim)

  if (!session) return null
  const token = session.token
  const canTrigger = can(session.role, 'data.trigger')
  const canWrite = can(session.role, 'data.write')
  const hasCap = (cap: 'data.write' | 'data.trigger') => (cap === 'data.write' ? canWrite : canTrigger)

  const goDeepDive = (configId: string, configKey: string | null, runId?: string) => {
    setSelected({ id: configId, config_key: configKey ?? configId })
    setFocusRunId(runId ?? null)
    setTab('config')
  }
  const claim = async (id: string) => { await claimReview({ token, id: id as Id<'review_queue'> }) }
  const openTrigger = (req: TriggerRequest) => { if (hasCap(triggerCapability(req))) setCeremony(req) }
  const openReviewSidebar = (id: string, title: string) => setSidebarItem({ id, title })
  const runTrigger = async (reason: string) => {
    if (!ceremony) return
    if (ceremony.kind === 'reenrich') await reEnrich({ token, reason, vin: ceremony.vin })
    else if (ceremony.kind === 'purge') await purge({ token, reason, vin: ceremony.vin })
    else if (ceremony.kind === 'acknowledgeRun') await acknowledgeRun({ token, reason, runId: ceremony.runId as Id<'enrichment_runs'> })
    else if (ceremony.kind === 'bulkUnstick') {
      // Drain in bounded passes — the mutation caps each pass at 500/status.
      for (let i = 0; i < 20; i++) {
        const res = await bulkUnstick({ token, reason })
        if (!res.remaining) break
      }
    }
    else await unstick({ token, reason, runId: ceremony.runId as Id<'enrichment_runs'> })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header + tab bar */}
      <div style={{ padding: '18px 24px 0', background: '#fff', borderBottom: '1px solid var(--slate-200)' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--slate-900)' }}>Enrichment Console</div>
        <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 2 }}>
          Live pipeline observability — runs, cost, quality, flags, and per-config deep-dive.
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 14 }}>
          {TABS.map(t => {
            const active = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 13, fontWeight: 600, color: active ? 'var(--slate-900)' : 'var(--slate-500)',
                  borderBottom: `2px solid ${active ? 'var(--blue-600)' : 'transparent'}`, marginBottom: -1 }}>
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'var(--slate-50)' }}>
        {!canTrigger && (
          <div style={{ marginBottom: 16, border: '1px solid var(--slate-200)', background: '#fff', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: 'var(--slate-500)' }}>
            Read-only: your role lacks the <span className="mono">data.trigger</span> capability, so run triggers are disabled.
          </div>
        )}

        {tab === 'overview' && <Zone label="Overview"><OverviewTab token={token} goTab={t => setTab(t as TabId)} goDeepDive={goDeepDive} openTrigger={openTrigger} activeReviewId={sidebarItem?.id ?? null} onOpenReview={openReviewSidebar} /></Zone>}
        {tab === 'attention' && <Zone label="Needs Attention"><NeedsAttentionTab token={token} goDeepDive={goDeepDive} openTrigger={openTrigger} canWrite={canWrite} canTrigger={canTrigger} claimReview={claim} activeReviewId={sidebarItem?.id ?? null} onOpenReview={openReviewSidebar} /></Zone>}
        {tab === 'runs' && <Zone label="Live Runs"><LiveRunsTab token={token} openTrigger={openTrigger} goDeepDive={goDeepDive} canTrigger={canTrigger} /></Zone>}
        {tab === 'costs' && <Zone label="Costs"><CostsTab token={token} /></Zone>}
        {tab === 'flags' && <Zone label="Flags & Quality"><FlagsTab token={token} goDeepDive={goDeepDive} goTab={t => setTab(t as TabId)} /></Zone>}
        {tab === 'config' && <Zone label="Deep-Dive"><DeepDiveTab token={token} selected={selected} onSelect={setSelected} openTrigger={openTrigger} focusRunId={focusRunId} /></Zone>}
        {tab === 'pipeline' && <Zone label="Pipeline"><PipelineTab token={token} /></Zone>}
      </div>

      <TriggerCeremony req={ceremony} onClose={() => setCeremony(null)} onConfirm={runTrigger} />
      <ReviewSidebar key={sidebarItem?.id ?? 'none'} token={token} item={sidebarItem}
        onClose={() => setSidebarItem(null)} onResolved={() => setSidebarItem(null)} goDeepDive={goDeepDive} />
    </div>
  )
}
