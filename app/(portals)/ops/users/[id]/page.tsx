'use client'

// Merged into /director#users — stash the user id so the Users tab auto-opens
// the 6-tab detail after the hard navigation. See ../../_redirect.
import { useParams } from 'next/navigation'
import { OpsRedirect } from '../../_redirect'

export default function Page() {
  const { id } = useParams<{ id: string }>()
  return <OpsRedirect to="/director#users" stash={{ tab: 'users', entityId: id }} />
}
