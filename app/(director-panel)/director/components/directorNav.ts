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
