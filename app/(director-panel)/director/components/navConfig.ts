// Single source of truth for the director panel's navigable tabs. Both the
// Sidebar (Shell.tsx) and the ⌘K command palette (DirectorCommandK.tsx) read
// from here so the two never drift apart.
import {
  IconHome, IconShop, IconUsers, IconCalendar, IconBug, IconMessage, IconStripe,
  IconAudit, IconSettings, IconCar, IconBolt, IconTag, IconClock, IconStar,
  IconCard, IconRefresh, IconPlug,
} from './Primitives'

export type NavIcon = (p: { size?: number; stroke?: number; style?: React.CSSProperties }) => React.ReactElement
export type NavItem = {
  id: string
  label: string
  Icon: NavIcon
  badge?: string
  /** Extra terms the fuzzy search should match against (synonyms, old names). */
  keywords?: string[]
}
export type NavGroup = { section?: string; items: NavItem[] }

// Grouped control plane — mirrors the retired /ops nav sections so the panel
// stays legible now that it carries the full ops + shops surface area.
export const NAV_GROUPS: NavGroup[] = [
  { items: [
    { id:'overview',     label:'Overview',     Icon:IconHome, keywords:['dashboard','home','kpis','summary'] },
  ] },
  { section:'People', items: [
    { id:'users',         label:'Users',           Icon:IconUsers,   keywords:['customers','accounts','people','members'] },
    { id:'deletionQueue', label:'Deletion queue',  Icon:IconUsers,   badge:'deletionQueue', keywords:['gdpr','delete','removal','purge','account deletion'] },
  ] },
  { section:'Marketplace', items: [
    { id:'shops',        label:'Shops',        Icon:IconShop,     keywords:['garages','partners','mechanics','marketplace'] },
    { id:'applications', label:'Applications', Icon:IconShop,     keywords:['apply','onboarding','partner requests','pending shops'] },
    { id:'bookings',     label:'Bookings',     Icon:IconCalendar, keywords:['appointments','jobs','reservations','orders'] },
    { id:'reviews',      label:'Reviews',      Icon:IconStar,    badge:'reviews', keywords:['ratings','stars','testimonials'] },
  ] },
  { section:'Money', items: [
    { id:'stripe',       label:'Stripe',       Icon:IconStripe,  badge:'stripe', keywords:['payments','connect','payouts','money'] },
    { id:'transactions', label:'Transactions', Icon:IconCard,     keywords:['charges','payments','ledger'] },
    { id:'settlement',   label:'Settlement',   Icon:IconClock,   badge:'settlement', keywords:['payouts','escrow','settle','capture'] },
  ] },
  { section:'Catalog', items: [
    { id:'cars',         label:'Cars',            Icon:IconCar,      keywords:['vehicles','vins','makes','models'] },
    { id:'configs',      label:'Vehicle configs', Icon:IconSettings, keywords:['trims','fitment','engines','configurations'] },
    { id:'enrichment',   label:'Enrichment',      Icon:IconRefresh,  keywords:['parts enrichment','runs','pipeline','scrape'] },
    { id:'pricing',      label:'Pricing & tiers', Icon:IconBolt,     keywords:['price','tiers','labor rates','markup'] },
    { id:'serviceParts', label:'Service Parts',   Icon:IconTag,      keywords:['parts','catalog','oem parts','service parts'] },
    { id:'estimatorLabor', label:'Estimator & Labor', Icon:IconClock, keywords:['labor','estimator','hours','labour'] },
  ] },
  { section:'Engagement', items: [
    { id:'otoConversations', label:'Oto History', Icon:IconMessage, keywords:['oto history','chat','ai conversations','assistant'] },
    { id:'followUps',    label:'Follow-ups',   Icon:IconClock,    keywords:['follow ups','reminders','callbacks'] },
    { id:'otoSim',       label:'Oto Sim',      Icon:IconBolt,     keywords:['oto sim','simulator','ai test'] },
    { id:'otoFeedback',  label:'Oto feedback', Icon:IconBolt,    badge:'otoFeedback', keywords:['oto feedback','ai feedback'] },
  ] },
  { section:'Insight', items: [
    { id:'analytics',    label:'Analytics',    Icon:IconBolt,     keywords:['metrics','charts','reports','insights'] },
    { id:'customJobs',   label:'Custom jobs',  Icon:IconCar,      keywords:['custom jobs','off catalog','off-catalog','clusters','what to build','aliases','gaps'] },
    { id:'systemHealth', label:'System health', Icon:IconRefresh, badge:'systemHealth', keywords:['health','status','monitoring','uptime'] },
  ] },
  { section:'Signals', items: [
    { id:'bugs',         label:'Bugs',         Icon:IconBug,     badge:'bugs', keywords:['issues','errors','reports','defects'] },
    { id:'feedback',     label:'Feedback',     Icon:IconMessage, badge:'feedback', keywords:['user feedback','suggestions'] },
  ] },
  { section:'Governance', items: [
    { id:'audit',         label:'Audit log',      Icon:IconAudit, keywords:['audit','activity','history','logs'] },
    { id:'mechanicEdits', label:'Mechanic Edits', Icon:IconCar,  badge:'mechanicEdits', keywords:['mechanic edits','changes','approvals'] },
  ] },
  { section:'Internal', items: [
    { id:'integrations', label:'Tools & integrations', Icon:IconPlug, keywords:['integrations','services','tools','vendors','subscriptions','saas','convex','slack','stripe','firecrawl','reducto','fly','spend','costs','stack'] },
  ] },
]

// Flattened, search-ready list. `settings` is reachable from the sidebar footer
// gear rather than a nav row, but it's a valid tab so we include it here.
export const NAV_ITEMS: (NavItem & { section: string })[] = [
  ...NAV_GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, section: g.section ?? 'General' }))),
  { id:'settings', label:'Settings', Icon:IconSettings, section:'General', keywords:['preferences','config','director settings','account'] },
]
