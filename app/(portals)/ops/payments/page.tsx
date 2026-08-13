'use client'

// Retired — merged into /director#stripe (Payments subtab). See ../_redirect.
import { OpsRedirect } from '../_redirect'

export default function Page() {
  return <OpsRedirect to="/director#stripe" stash={{ tab: 'payments', entityId: '' }} />
}
