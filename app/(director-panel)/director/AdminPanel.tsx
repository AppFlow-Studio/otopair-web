'use client'

import { useState, useEffect } from 'react'
import { Sidebar } from './components/Shell'
import { TabOverview }  from './components/tabs/TabOverview'
import { TabShops }     from './components/tabs/TabShops'
import { TabUsers }     from './components/tabs/TabUsers'
import { TabBookings }  from './components/tabs/TabBookings'
import { TabBugs }      from './components/tabs/TabBugs'
import { TabFeedback }  from './components/tabs/TabFeedback'
import { TabStripe }    from './components/tabs/TabStripe'
import { TabAudit }     from './components/tabs/TabAudit'

const TABS: Record<string, React.ComponentType> = {
  overview: TabOverview,
  shops:    TabShops,
  users:    TabUsers,
  bookings: TabBookings,
  bugs:     TabBugs,
  feedback: TabFeedback,
  stripe:   TabStripe,
  audit:    TabAudit,
}

const VALID_IDS = Object.keys(TABS)

function getHashTab(): string {
  if (typeof window === 'undefined') return 'overview'
  const hash = window.location.hash.replace('#', '')
  return VALID_IDS.includes(hash) ? hash : 'overview'
}

export const AdminPanel = () => {
  const [active, setActive] = useState('overview')

  useEffect(() => {
    setActive(getHashTab())
    const onHash = () => setActive(getHashTab())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = (id: string) => {
    window.location.hash = id
    setActive(id)
  }

  const Tab = TABS[active] ?? TabOverview

  return (
    <div style={{ display:'flex', height:'100vh', background:'var(--slate-50)', fontFamily:"'Inter', system-ui, sans-serif" }}>
      <Sidebar active={active} onNavigate={navigate} />
      <main style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Tab />
      </main>
    </div>
  )
}
