'use client'

// Redirect shims — /ops surfaces are being merged into /director tabs. As each
// destination tab reaches parity its /ops route becomes one of these. Dynamic
// detail routes stash the entity id (survives the hard navigation) so the
// destination tab auto-opens that entity via consumeStashedGoto.

import { useEffect } from 'react'

export function OpsRedirect({ to, stash }:
  { to: string; stash?: { tab: string; entityId: string } }) {
  useEffect(() => {
    if (stash) {
      try { sessionStorage.setItem('director_goto', JSON.stringify(stash)) } catch { /* private mode */ }
    }
    window.location.replace(to)
  }, [to, stash?.tab, stash?.entityId])
  return null
}
