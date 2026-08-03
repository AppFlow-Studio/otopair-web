'use client'

// Retired — merged into /director#bookings. Stash the id so the Bookings tab
// auto-opens the 4-tab detail after the hard nav. See ../../_redirect.
import { useParams } from 'next/navigation'
import { OpsRedirect } from '../../_redirect'

export default function Page() {
  const { id } = useParams<{ id: string }>()
  return <OpsRedirect to="/director#bookings" stash={{ tab: 'bookings', entityId: id }} />
}
