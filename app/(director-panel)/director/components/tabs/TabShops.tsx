'use client'

import { useEffect, useState } from 'react'
import { SectionAnchor } from '../Shell'
import { consumeGoto, consumeStashedGoto } from '../directorNav'
import { ShopsDirectory } from './shops/ShopsDirectory'
import { ShopsMapTab } from './shops/ShopsMapTab'
import { MechanicsDirectory } from './shops/MechanicsDirectory'
import { NetworkReviews } from './shops/NetworkReviews'
import { AttentionList } from './shops/AttentionList'
import { ShopDetail } from './shops/ShopDetail'
import { MechanicDetail } from './shops/MechanicDetail'

// Shops — the merged /shops portal. Network SUB-TABS (Directory · Map ·
// Mechanics · Reviews · Attention) plus a full-page 7-tab shop detail and a
// mechanic detail. All data comes from the same requireDirector-gated
// api.shops*.* queries the portal used — the director session token works
// as-is, so no backend changes were needed.

const SUBTABS = [
  { id: 'directory', label: 'Directory' },
  { id: 'map', label: 'Map' },
  { id: 'mechanics', label: 'Mechanics' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'attention', label: 'Attention' },
] as const
type SubTab = (typeof SUBTABS)[number]['id']

export const TabShops = () => {
  const [sub, setSub] = useState<SubTab>('directory')
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null)
  const [selectedMechanicId, setSelectedMechanicId] = useState<string | null>(null)

  // Deep-link: in-app gotoEntity('shops', id) or a redirect-shim stash open the
  // shop (or mechanic) detail on mount.
  useEffect(() => {
    const g = consumeGoto() ?? consumeStashedGoto('shops')
    if (g?.entityId) { setSelectedShopId(g.entityId); return }
    const gm = consumeStashedGoto('shops-mechanic')
    if (gm?.entityId) setSelectedMechanicId(gm.entityId)
  }, [])

  const openShop = (id: string) => { setSelectedMechanicId(null); setSelectedShopId(id) }
  const openMechanic = (id: string) => { setSelectedShopId(null); setSelectedMechanicId(id) }

  // ── Full-page detail swaps ──
  if (selectedShopId) {
    return (
      <SectionAnchor id="shops" title="Shops" subtitle="Full shop detail — profile, hours, services, mechanics, calendar, bookings, insights.">
        <ShopDetail shopId={selectedShopId} onBack={() => setSelectedShopId(null)} onOpenMechanic={openMechanic} />
      </SectionAnchor>
    )
  }
  if (selectedMechanicId) {
    return (
      <SectionAnchor id="shops" title="Shops" subtitle="Mechanic detail — utilization, jobs, reviews, availability, data contributions.">
        <MechanicDetail mechanicId={selectedMechanicId} onBack={() => setSelectedMechanicId(null)} onOpenShop={openShop} />
      </SectionAnchor>
    )
  }

  // ── Sub-tab index ──
  return (
    <SectionAnchor id="shops" title="Shops" subtitle="Every shop on the platform — network map, directory, mechanics, and reviews.">
      <div style={{ display:'flex', gap:2, marginBottom:16, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:4 }}>
        {SUBTABS.map(t => {
          const isActive = sub === t.id
          return (
            <button key={t.id} onClick={() => setSub(t.id)}
              style={{ flex:1, padding:'8px 12px', border:'none', borderRadius:7, cursor:'pointer', fontSize:13, fontWeight:500,
                background: isActive ? 'var(--blue-50)' : 'transparent', color: isActive ? 'var(--blue-700)' : 'var(--slate-600)', transition:'background 80ms', fontFamily:'inherit' }}>
              {t.label}
            </button>
          )
        })}
      </div>

      {sub === 'directory' && <ShopsDirectory onOpenShop={openShop} />}
      {sub === 'map' && <ShopsMapTab onOpenShop={openShop} onGoDirectory={() => setSub('directory')} />}
      {sub === 'mechanics' && <MechanicsDirectory onOpenMechanic={openMechanic} onOpenShop={openShop} />}
      {sub === 'reviews' && <NetworkReviews onOpenShop={openShop} onOpenMechanic={openMechanic} />}
      {sub === 'attention' && <AttentionList onOpenShop={openShop} />}
    </SectionAnchor>
  )
}
