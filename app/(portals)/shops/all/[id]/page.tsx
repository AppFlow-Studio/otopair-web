'use client'

// Merged into /director#shops — stash the shop id so the Shops tab auto-opens
// the full detail after the hard navigation. See ../../_redirect.
import { useParams } from 'next/navigation'
import { ShopsRedirect } from '../../_redirect'

export default function Page() {
  const { id } = useParams<{ id: string }>()
  return <ShopsRedirect to="/director#shops" stash={{ tab: 'shops', entityId: id }} />
}
