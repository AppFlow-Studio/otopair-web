'use client'

// Redirect shims — the /shops portal has been merged into /director#shops.
// These replace the old portal pages so existing links keep working. Dynamic
// detail routes stash the entity id (survives the hard navigation) so the
// destination Shops tab auto-opens that shop/mechanic via consumeStashedGoto.

import { useEffect } from 'react'

export function ShopsRedirect({ to = '/director#shops', stash }:
  { to?: string; stash?: { tab: string; entityId: string } }) {
  useEffect(() => {
    if (stash) {
      try { sessionStorage.setItem('director_goto', JSON.stringify(stash)) } catch { /* private mode */ }
    }
    window.location.replace(to)
  }, [to, stash?.tab, stash?.entityId])
  return null
}
