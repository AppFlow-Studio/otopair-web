'use client'

// Retired — merged into /director#stripe (Payments subtab). Stash the id so the
// forensic payment detail auto-opens after the hard nav. See ../../_redirect.
import { useParams } from 'next/navigation'
import { OpsRedirect } from '../../_redirect'

export default function Page() {
  const { id } = useParams<{ id: string }>()
  return <OpsRedirect to="/director#stripe" stash={{ tab: 'payments', entityId: id }} />
}
