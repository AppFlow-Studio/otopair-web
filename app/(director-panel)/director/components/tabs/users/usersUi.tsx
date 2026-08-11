'use client'

// Shared bits for the director user-detail tabs (ported from /ops/users/[id]),
// rendered in the panel's inline-style theme. Cross-tab nav helpers route to
// the director's hash tabs instead of the old /ops + /shops URLs.

import type { CSSProperties, ReactNode } from 'react'
import { Card } from '../../Primitives'
import { gotoEntity, stashGoto } from '../../directorNav'

export const fmtDate = (ms: number | null | undefined): string =>
  ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
export const fmtDateTime = (ms: number | null | undefined): string =>
  ms == null ? '—' : new Date(ms).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
export const fmtMoney = (n: number | null | undefined): string =>
  n == null ? '—' : `$${n.toFixed(2)}`

export type Tone = 'slate' | 'green' | 'yellow' | 'blue' | 'red' | 'purple' | 'indigo' | 'teal' | 'orange'
export function statusTone(status: string): Tone {
  const s = (status ?? '').toLowerCase()
  if (['completed', 'succeeded', 'captured', 'paid', 'active'].includes(s)) return 'green'
  if (['pending', 'pending_quote', 'quotes_ready', 'vehicle_at_shop', 'requires_action', 'hold'].includes(s)) return 'yellow'
  if (['cancelled', 'no_show', 'failed', 'refunded', 'removed', 'disputed'].includes(s)) return 'red'
  return 'slate'
}

const PROVIDER_LABEL: Record<string, string> = {
  password: 'Email + password', oauth_google: 'Google', google: 'Google',
  oauth_apple: 'Apple', apple: 'Apple', phone: 'Phone',
}
const SOURCE_LABEL: Record<string, string> = {
  shop_portal_web: 'Shop portal (web)', web_signup: 'Web signup',
  ios_app: 'iOS app', android_app: 'Android app', referral: 'Referral',
}
export const providerLabel = (p: string | null): string => !p ? 'Unknown' : PROVIDER_LABEL[p] ?? p.replace(/_/g, ' ')
export const sourceLabel = (s: string | null): string => !s ? 'Unknown / direct' : SOURCE_LABEL[s] ?? s.replace(/_/g, ' ')

export const Field = ({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) => (
  <div>
    <div style={{ fontSize:11, fontWeight:500, color:'var(--slate-500)' }}>{label}</div>
    <div className={mono ? 'mono' : undefined} style={{ marginTop:2, fontSize: mono ? 12 : 13, color:'var(--slate-900)' }}>{value ?? '—'}</div>
  </div>
)

export const SubCard = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <Card style={style}>{children}</Card>
)

export const H2 = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize:13, fontWeight:600, color:'var(--slate-900)' }}>{children}</div>
)

export const MicroLabel = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', color:'var(--slate-400)' }}>{children}</div>
)

export const Loading = ({ label }: { label: string }) => (
  <div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading {label}…</div>
)

export const Stars = ({ rating }: { rating: number }) => (
  <span style={{ color:'#F59E0B' }}>{'★'.repeat(Math.max(0, Math.round(rating)))}</span>
)

// Cross-tab navigation from inside the user modal.
export const openShop = (shopId: string) => gotoEntity('shops', shopId)
export const openMechanic = (mechanicId: string) => { stashGoto('shops-mechanic', mechanicId); window.location.hash = 'shops' }
export const openPayment = (paymentId: string) => gotoEntity('stripe', paymentId)
