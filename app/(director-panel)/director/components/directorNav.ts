type GotoTarget = { tab: string; entityId: string }

let _pending: GotoTarget | null = null

export const gotoEntity = (tab: string, entityId: string) => {
  _pending = { tab, entityId }
  window.location.hash = tab
}

export const consumeGoto = (): GotoTarget | null => {
  const v = _pending
  _pending = null
  return v
}

// ---------------------------------------------------------------------------
// sessionStorage-backed goto — survives a full page load, so the /ops + /shops
// redirect shims can hand a detail id to the destination tab. In-app cross-tab
// nav keeps using the in-memory `gotoEntity` above.
// ---------------------------------------------------------------------------

const STASH_KEY = 'director_goto'

export const stashGoto = (tab: string, entityId: string) => {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ tab, entityId }))
  } catch {
    /* sessionStorage unavailable (private mode / SSR) — deep link degrades to the tab root */
  }
}

/** Read + clear a stashed goto for `tab`. Returns null if none / mismatched. */
export const consumeStashedGoto = (tab: string): GotoTarget | null => {
  try {
    const raw = sessionStorage.getItem(STASH_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GotoTarget
    if (parsed?.tab !== tab) return null
    sessionStorage.removeItem(STASH_KEY)
    return parsed
  } catch {
    return null
  }
}
