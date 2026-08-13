'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Sidebar } from './components/Shell'
import { DirectorCommandK } from './components/DirectorCommandK'
import { DirectorLogin } from './components/DirectorLogin'
import { DirectorSessionCtx, type DirectorSession } from './components/DirectorSessionCtx'
import { TabOverview }  from './components/tabs/TabOverview'
import { TabShops }     from './components/tabs/TabShops'
import { TabApplications } from './components/tabs/TabApplications'
import { TabUsers }     from './components/tabs/TabUsers'
import { TabBookings }  from './components/tabs/TabBookings'
import { TabCars }      from './components/tabs/TabCars'
import { TabVehicleConfigs } from './components/tabs/TabVehicleConfigs'
import { TabEnrichment } from './components/tabs/TabEnrichment'
import { TabPricing } from './components/tabs/TabPricing'
import { TabBugs }      from './components/tabs/TabBugs'
import { TabFeedback }  from './components/tabs/TabFeedback'
import { TabOtoFeedback } from './components/tabs/TabOtoFeedback'
import { TabStripe }    from './components/tabs/TabStripe'
import { TabAudit }     from './components/tabs/TabAudit'
import { TabSettings }       from './components/tabs/TabSettings'
import { TabMechanicEdits } from './components/tabs/TabMechanicEdits'
import { TabServiceParts } from './components/tabs/TabServiceParts'
import { TabEstimatorLabor } from './components/tabs/TabEstimatorLabor'
import { TabOtoSim }    from './components/tabs/TabOtoSim'
import { TabOtoConversations } from './components/tabs/TabOtoConversations'
// Merged /ops surfaces (see plan: ops → director merge).
import { TabReviews }       from './components/tabs/TabReviews'
import { TabDeletionQueue } from './components/tabs/TabDeletionQueue'
import { TabFollowUps }     from './components/tabs/TabFollowUps'
import { TabSystemHealth }  from './components/tabs/TabSystemHealth'
import { TabTransactions }  from './components/tabs/TabTransactions'
import { TabSettlement }    from './components/tabs/TabSettlement'
import { TabAnalytics }     from './components/tabs/TabAnalytics'

const SESSION_KEY = 'otopair_director_token'

const TABS: Record<string, React.ComponentType> = {
  overview: TabOverview,
  users:    TabUsers,
  deletionQueue: TabDeletionQueue,
  shops:    TabShops,
  applications: TabApplications,
  bookings: TabBookings,
  reviews:  TabReviews,
  stripe:      TabStripe,
  transactions: TabTransactions,
  settlement:  TabSettlement,
  cars:        TabCars,
  configs:     TabVehicleConfigs,
  enrichment:  TabEnrichment,
  pricing:     TabPricing,
  serviceParts: TabServiceParts,
  estimatorLabor: TabEstimatorLabor,
  otoConversations: TabOtoConversations,
  followUps:   TabFollowUps,
  otoSim:      TabOtoSim,
  otoFeedback: TabOtoFeedback,
  analytics:   TabAnalytics,
  systemHealth: TabSystemHealth,
  bugs:        TabBugs,
  feedback:    TabFeedback,
  audit:          TabAudit,
  mechanicEdits:  TabMechanicEdits,
  settings:       TabSettings,
}

const VALID_IDS = Object.keys(TABS)

function getHashTab(): string {
  if (typeof window === 'undefined') return 'overview'
  const hash = window.location.hash.replace('#', '')
  return VALID_IDS.includes(hash) ? hash : 'overview'
}

const PanelShell = ({ session, onLogout }: { session: DirectorSession; onLogout: () => void }) => {
  const [active, setActive] = useState('overview')
  const [searchOpen, setSearchOpen] = useState(false)
  const counts = useQuery(api.director.sidebarCounts, { token: session.token })

  useEffect(() => {
    setActive(getHashTab())
    const onHash = () => setActive(getHashTab())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // ⌘K / Ctrl+K toggles the global search palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const navigate = (id: string) => {
    window.location.hash = id
    setActive(id)
  }

  const Tab = TABS[active] ?? TabOverview

  return (
    <DirectorSessionCtx.Provider value={session}>
      <div style={{ display:'flex', height:'100vh', background:'var(--slate-50)', fontFamily:"'Inter', system-ui, sans-serif" }}>
        <Sidebar
          active={active}
          onNavigate={navigate}
          counts={counts ?? undefined}
          currentUser={{ name: session.name, role: session.role }}
          onLogout={onLogout}
          onOpenSearch={() => setSearchOpen(true)}
        />
        <main style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <Tab />
        </main>
      </div>
      <DirectorCommandK open={searchOpen} onOpenChange={setSearchOpen} onNavigateTab={navigate} />
    </DirectorSessionCtx.Provider>
  )
}

export const AdminPanel = () => {
  const [token,   setToken]   = useState<string | null>(null)
  const [session, setSession] = useState<DirectorSession | null>(null)
  const doLogout = useMutation(api.director_auth.logout)

  // Initialize token from localStorage after mount
  useEffect(() => {
    setToken(localStorage.getItem(SESSION_KEY) ?? '')
  }, [])

  // Validate session reactively — skip until token is initialized
  const validated = useQuery(
    api.director_auth.validateSession,
    token !== null ? { token: token } : 'skip'
  )

  // Sync validated session into state
  useEffect(() => {
    if (validated === undefined || token === null) return
    if (validated) {
      setSession({
        userId: String(validated.userId),
        name:   validated.name,
        role:   validated.role,
        token:  token,
      })
    } else {
      setSession(null)
      if (token) localStorage.removeItem(SESSION_KEY)
    }
  }, [validated, token])

  const handleLogin = (tok: string, user: { name: string; role: string; userId: string }) => {
    localStorage.setItem(SESSION_KEY, tok)
    setToken(tok)
    setSession({ token: tok, ...user })
  }

  const handleLogout = async () => {
    if (token) await doLogout({ token, actorName: session?.name, actorId: session?.userId as any })
    localStorage.removeItem(SESSION_KEY)
    setToken('')
    setSession(null)
  }

  // Still loading (token not yet read from localStorage, or query in flight)
  if (token === null || (token !== '' && validated === undefined)) {
    return (
      <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
        background:'var(--slate-950, #020617)', color:'var(--slate-400)', fontFamily:"'Inter', system-ui, sans-serif", fontSize:14 }}>
        Loading…
      </div>
    )
  }

  if (!session) {
    return <DirectorLogin onLogin={handleLogin} />
  }

  return <PanelShell session={session} onLogout={handleLogout} />
}
