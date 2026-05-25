'use client'

import { useState, useContext, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import {
  Badge, Button, Card, Select, Modal, tableStyles,
  IconStripe, IconCheck, IconExternal, IconTag, IconBolt, IconClock, IconRefresh,
} from '../Primitives'
import { SectionAnchor } from '../Shell'
import { gotoEntity } from '../directorNav'
import {
  StatCard, DeltaChip, BarRow, DualSparkline,
  fmtCurrency, fmtPct, fmtNumber, fmtRelative,
} from '../Charts'

type Period = '7d' | '30d' | '90d' | 'ytd'
const PERIOD_LABELS: Record<Period, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', ytd: 'Year to date' }

const SUBTABS = [
  { id:'overview',  label:'Financial overview' },
  { id:'accounts',  label:'Connected accounts' },
  { id:'payments',  label:'Payments' },
  { id:'refunds',   label:'Refunds' },
  { id:'webhooks',  label:'Webhook health' },
] as const
type SubTab = typeof SUBTABS[number]['id']

const REFUND_REASONS: Record<string, { label: string; tone: 'red'|'orange'|'slate'|'yellow' }> = {
  service_quality:  { label: 'Service quality',  tone: 'red' },
  customer_no_show: { label: 'Customer no-show', tone: 'orange' },
  shop_no_show:     { label: 'Shop no-show',     tone: 'red' },
  goodwill:         { label: 'Goodwill',         tone: 'slate' },
  duplicate:        { label: 'Duplicate charge', tone: 'yellow' },
}

const STRIPE_CONNECT_URL =
  'https://dashboard.stripe.com/connect/accounts/overview'

// ---------------------------------------------------------------------------
// Tag refund modal (preserved from previous version)
// ---------------------------------------------------------------------------

const TagRefundModal = ({ bookingId, onClose }: { bookingId: Id<'bookings'> | null; onClose: () => void }) => {
  const session = useContext(DirectorSessionCtx)
  const actorName = session?.name ?? 'Director'
  const actorId   = session?.userId as Id<'director_users'> | undefined
  const [reason, setReason] = useState('')
  const tagRefund = useMutation(api.director.tagRefund)

  const handleSave = async () => {
    if (!bookingId || !reason) return
    await tagRefund({ id: bookingId, reason, actorName, actorId })
    setReason('')
    onClose()
  }

  return (
    <Modal open={!!bookingId} onClose={onClose} width={480}
      title="Tag refund reason"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={!reason}>Save tag</Button>
      </>}>
      <div style={{ padding:22 }}>
        <div style={{ fontSize:13, color:'var(--slate-600)', marginBottom:14 }}>
          Select a reason for this refund. This will be logged in the audit trail.
        </div>
        <label style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', display:'block', marginBottom:6 }}>Reason</label>
        <Select value={reason} onChange={e => setReason(e.target.value)}
          options={[{ value:'', label:'Select a reason…' }, ...Object.entries(REFUND_REASONS).map(([v, r]) => ({ value:v, label:r.label }))]}
          style={{ width:'100%' }} />
        {reason && (
          <div style={{ marginTop:12, padding:'10px 12px', background:'var(--slate-25)', borderRadius:8, border:'1px solid var(--slate-100)', fontSize:12, color:'var(--slate-600)' }}>
            Tagged as <b>{REFUND_REASONS[reason]?.label}</b> — will appear in the refund report.
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Section title
// ---------------------------------------------------------------------------

const SectionTitle = ({ label, right }: { label: string; right?: React.ReactNode }) => (
  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, marginTop:6 }}>
    <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
    {right}
  </div>
)

// ---------------------------------------------------------------------------
// Status tone for payments
// ---------------------------------------------------------------------------

const paymentTone = (s: string): 'green' | 'yellow' | 'red' | 'slate' | 'blue' => ({
  succeeded:'green' as const, paid:'green' as const,
  pending:'yellow' as const, processing:'blue' as const,
  failed:'red' as const, canceled:'slate' as const,
  refunded:'purple' as any,
}[s] ?? 'slate')

// Stripe returns minor units (cents). Display as dollar amounts.
function fmtMinor(amount: number, currency?: string): string {
  const sign = amount < 0 ? '−' : ''
  const dollars = Math.abs(amount) / 100
  const cur = (currency ?? 'usd').toUpperCase()
  if (cur === 'USD') return `${sign}$${dollars.toFixed(2)}`
  return `${sign}${dollars.toFixed(2)} ${cur}`
}

function fmtMinorTotals(rows?: { amount: number; currency: string }[]): string {
  if (!rows || rows.length === 0) return '$0.00'
  return rows.map(r => fmtMinor(r.amount, r.currency)).join(' + ')
}

// ---------------------------------------------------------------------------
// LiveStripeCard — calls checkStripeConfig + getPlatformLiveData
// ---------------------------------------------------------------------------

type LiveStripeData = {
  configured: boolean
  mode: 'test' | 'live' | 'unknown'
  balance?: { available: { amount: number; currency: string }[]; pending: { amount: number; currency: string }[] }
  nextPayout?: { amount: number; currency: string; arrivalDateMs: number; status: string }
  pendingPayoutsCount?: number
  pendingPayoutsTotal?: { amount: number; currency: string }[]
  openDisputesCount?: number
  openDisputesTotal?: { amount: number; currency: string }[]
  error?: string
}

type ConfigCheck =
  | { configured: false; mode: 'unknown'; error: 'missing_key' }
  | { configured: true;  mode: 'test'|'live'|'unknown'; accountId: string; businessName?: string; country?: string }
  | { configured: false; mode: 'test'|'live'|'unknown'; error: string }

const LiveStripeCard = () => {
  const checkConfig = useAction(api.directorStripeLive.checkStripeConfig)
  const getLive     = useAction(api.directorStripeLive.getPlatformLiveData)
  const [config, setConfig] = useState<ConfigCheck | null>(null)
  const [data,   setData]   = useState<LiveStripeData | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastFetched, setLastFetched] = useState<number | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const c = await checkConfig({}) as ConfigCheck
      setConfig(c)
      if (c.configured) {
        const d = await getLive({}) as LiveStripeData
        setData(d)
      } else {
        setData(null)
      }
      setLastFetched(Date.now())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const notConfigured = config?.configured === false

  return (
    <Card>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
          Live Stripe data
        </span>
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          {config && config.configured && (
            <>
              <Badge tone={config.mode === 'live' ? 'green' : 'yellow'}>{config.mode === 'live' ? 'Live mode' : 'Test mode'}</Badge>
              <Button size="sm" onClick={refresh} disabled={loading} icon={<IconRefresh size={11} />}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </Button>
            </>
          )}
          {notConfigured && <Badge tone="slate">Not connected</Badge>}
        </div>
      </div>

      {!config ? (
        <div style={{ fontSize:12, color:'var(--slate-400)', padding:'12px 0' }}>Checking Stripe connection…</div>
      ) : notConfigured ? (
        <>
          <div style={{ fontSize:13, color:'var(--slate-600)', lineHeight:1.5, marginBottom:12 }}>
            Account balance, payout schedule, and dispute counts require the Stripe Connect API.
            {config && 'error' in config && config.error !== 'missing_key' && (
              <div style={{ marginTop:6, color:'var(--red-700)', fontSize:12 }}>Stripe error: {config.error}</div>
            )}
          </div>
          <div style={{ background:'var(--slate-25)', border:'1px solid var(--slate-100)', borderRadius:8, padding:'10px 12px', fontFamily:'ui-monospace, monospace', fontSize:11, color:'var(--slate-700)', marginBottom:10, whiteSpace:'pre-wrap' }}>
            npx convex env set STRIPE_SECRET_KEY sk_test_…
          </div>
          <div style={{ fontSize:11, color:'var(--slate-500)' }}>
            Use your platform secret key (starts with <code>sk_test_</code> or <code>sk_live_</code>) from the{' '}
            <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" style={{ color:'var(--blue-700)' }}>Stripe API keys page</a>.
          </div>
        </>
      ) : data?.error ? (
        <div style={{ background:'var(--red-50)', border:'1px solid #FECACA', borderRadius:8, padding:'10px 12px', fontSize:12, color:'var(--red-700)' }}>
          {data.error}
        </div>
      ) : data ? (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
            <div style={{ background:'var(--slate-25)', border:'1px solid var(--slate-100)', borderRadius:8, padding:'10px 12px' }}>
              <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:4 }}>Available balance</div>
              <div style={{ fontSize:18, fontWeight:600, color:'var(--slate-900)' }} className="mono">{fmtMinorTotals(data.balance?.available)}</div>
            </div>
            <div style={{ background:'var(--slate-25)', border:'1px solid var(--slate-100)', borderRadius:8, padding:'10px 12px' }}>
              <div style={{ fontSize:10, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:4 }}>Pending balance</div>
              <div style={{ fontSize:18, fontWeight:600, color:'var(--slate-900)' }} className="mono">{fmtMinorTotals(data.balance?.pending)}</div>
            </div>
          </div>

          <div style={{ display:'flex', flexDirection:'column', gap:8, fontSize:13, color:'var(--slate-700)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0', borderBottom:'1px solid var(--slate-100)' }}>
              <span style={{ color:'var(--slate-500)' }}>Pending payouts</span>
              <span className="mono" style={{ fontWeight:500 }}>
                {data.pendingPayoutsCount ?? 0}{data.pendingPayoutsTotal && data.pendingPayoutsTotal.length > 0
                  ? ` · ${fmtMinorTotals(data.pendingPayoutsTotal)}` : ''}
              </span>
            </div>
            {data.nextPayout && (
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0', borderBottom:'1px solid var(--slate-100)' }}>
                <span style={{ color:'var(--slate-500)' }}>Next payout</span>
                <span className="mono" style={{ fontWeight:500 }}>
                  {fmtMinor(data.nextPayout.amount, data.nextPayout.currency)} · arrives {new Date(data.nextPayout.arrivalDateMs).toLocaleDateString()}
                </span>
              </div>
            )}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0' }}>
              <span style={{ color:'var(--slate-500)' }}>Open disputes</span>
              <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                {data.openDisputesCount && data.openDisputesCount > 0
                  ? <Badge tone="red">{data.openDisputesCount}</Badge>
                  : <Badge tone="green">0</Badge>}
                {data.openDisputesTotal && data.openDisputesTotal.length > 0 && (
                  <span className="mono" style={{ fontSize:12 }}>{fmtMinorTotals(data.openDisputesTotal)}</span>
                )}
              </span>
            </div>
          </div>

          <div style={{ marginTop:14, display:'flex', gap:8 }}>
            <a href="https://dashboard.stripe.com/payouts" target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
              <Button size="sm" variant="dark" iconRight={<IconExternal size={11} />}>Payouts</Button>
            </a>
            <a href="https://dashboard.stripe.com/disputes" target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
              <Button size="sm" iconRight={<IconExternal size={11} />}>Disputes</Button>
            </a>
            {lastFetched && (
              <span style={{ marginLeft:'auto', fontSize:11, color:'var(--slate-500)', alignSelf:'center' }}>
                Updated {fmtRelative(lastFetched)}
              </span>
            )}
          </div>
        </>
      ) : null}
    </Card>
  )
}

type StripeMetrics = {
  period: Period
  since: number
  gross:       { current: number; prior: number }
  net:         { current: number; prior: number }
  refunds:     { current: number; prior: number; countCurrent: number; countPrior: number }
  processed:   { current: number; count: number }
  payments:    { total: number; succeeded: number; failed: number; pending: number }
  captureRate: { current: number; prior: number }
  refundRate:  { current: number; prior: number }
  avgTicket:   { current: number; prior: number }
  series:      { ts: number; revenue: number; refunds: number; bookings: number }[]
  mix:         { labor: number; parts: number; other: number; total: number }
  bookings?:   unknown
}

// ---------------------------------------------------------------------------
// Financial overview subtab
// ---------------------------------------------------------------------------

const FinancialOverview = ({ period }: { period: Period }) => {
  const metrics = useQuery(api.directorStripe.stripeOverviewMetrics, { period }) as StripeMetrics | undefined

  if (!metrics) {
    return <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading metrics…</div>
  }

  const sparkRev = metrics.series.map((s) => s.revenue)

  const mixPct = (n: number) => metrics.mix.total > 0 ? n / metrics.mix.total : 0

  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Gross revenue" tone="blue"
          value={fmtCurrency(metrics.gross.current)}
          delta={metrics.gross.prior > 0 ? (metrics.gross.current - metrics.gross.prior) / metrics.gross.prior : null}
          hint={`vs ${fmtCurrency(metrics.gross.prior)} prior period`}
          spark={sparkRev} />
        <StatCard label="Net revenue" tone="green"
          value={fmtCurrency(metrics.net.current)}
          delta={metrics.net.prior > 0 ? (metrics.net.current - metrics.net.prior) / metrics.net.prior : null}
          hint="Gross minus refunds"
          spark={sparkRev} />
        <StatCard label="Refund rate" tone="red"
          value={fmtPct(metrics.refundRate.current)}
          delta={metrics.refundRate.prior > 0 ? (metrics.refundRate.current - metrics.refundRate.prior) / metrics.refundRate.prior : null}
          deltaInverted
          hint={`${metrics.refunds.countCurrent} refunds · ${fmtCurrency(metrics.refunds.current)} value`} />
        <StatCard label="Avg ticket" tone="purple"
          value={fmtCurrency(metrics.avgTicket.current)}
          delta={metrics.avgTicket.prior > 0 ? (metrics.avgTicket.current - metrics.avgTicket.prior) / metrics.avgTicket.prior : null}
          hint={`${metrics.bookings ? '' : ''}Completed bookings only`} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Capture rate"
          value={fmtPct(metrics.captureRate.current)}
          delta={metrics.captureRate.prior > 0 ? (metrics.captureRate.current - metrics.captureRate.prior) / metrics.captureRate.prior : null}
          hint={`${metrics.payments.succeeded} of ${metrics.payments.total} payment attempts`} />
        <StatCard label="Payment failures" tone="red"
          value={fmtNumber(metrics.payments.failed)}
          hint={`${metrics.payments.pending} pending`} />
        <StatCard label="Refund value"
          value={fmtCurrency(metrics.refunds.current)}
          hint={`${metrics.refunds.countCurrent} bookings refunded`} />
        <StatCard label="Period"
          value={PERIOD_LABELS[metrics.period as Period]}
          hint={`Since ${new Date(metrics.since).toLocaleDateString()}`} />
      </div>

      <Card style={{ marginBottom:16 }}>
        <SectionTitle label="Daily revenue & bookings"
          right={<span style={{ fontSize:11, color:'var(--slate-500)' }}>Last {metrics.series.length} days</span>} />
        <DualSparkline series={metrics.series} height={130} />
      </Card>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <Card>
          <SectionTitle label="Revenue mix" />
          {metrics.mix.total === 0 ? (
            <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic', padding:'12px 0' }}>No completed bookings in this period.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              <BarRow label="Labor"   value={metrics.mix.labor} max={metrics.mix.total}
                valueLabel={`${fmtCurrency(metrics.mix.labor)} · ${fmtPct(mixPct(metrics.mix.labor))}`}
                color="var(--blue-500)" />
              <BarRow label="Parts"   value={metrics.mix.parts} max={metrics.mix.total}
                valueLabel={`${fmtCurrency(metrics.mix.parts)} · ${fmtPct(mixPct(metrics.mix.parts))}`}
                color="var(--indigo-500, #6366F1)" />
              <BarRow label="Other"   value={metrics.mix.other} max={metrics.mix.total}
                valueLabel={`${fmtCurrency(metrics.mix.other)} · ${fmtPct(mixPct(metrics.mix.other))}`}
                color="var(--slate-400)" />
            </div>
          )}
        </Card>

        <LiveStripeCard />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Connected accounts subtab
// ---------------------------------------------------------------------------

type ShopRollupRow = {
  id: Id<'shops'>
  name: string
  city: string
  stripeConnected: boolean
  stripeAccountId?: string
  payoutsEnabled: boolean
  isActive?: boolean
  isVerified?: boolean
  bookingsCount: number
  completedCount: number
  refundedCount: number
  paymentsCount: number
  succeededCount: number
  failedCount: number
  processed: number
  grossRevenue: number
  refundValue: number
  netRevenue: number
  avgTicket: number
  refundRate: number
  failureRate: number
  lastPaymentAt?: number
  lastPaymentAmount?: number
}

const ConnectedAccounts = ({ period }: { period: Period }) => {
  const rows = useQuery(api.directorStripe.stripeShopRollup, { period }) as ShopRollupRow[] | undefined
  const [filter, setFilter] = useState<'all'|'connected'|'not_connected'|'high_refund'>('all')

  const filtered = useMemo(() => {
    if (!rows) return []
    return rows.filter(r => {
      if (filter === 'connected') return r.stripeConnected
      if (filter === 'not_connected') return !r.stripeConnected
      if (filter === 'high_refund') return r.refundRate > 0.05
      return true
    })
  }, [rows, filter])

  const connected = (rows ?? []).filter(r => r.stripeConnected).length
  const totalProcessed = (rows ?? []).reduce((s, r) => s + r.processed, 0)
  const totalRefunded = (rows ?? []).reduce((s, r) => s + r.refundValue, 0)
  const flagged = (rows ?? []).filter(r => r.refundRate > 0.05 || r.failureRate > 0.03).length

  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Connected accounts" tone="green"
          value={fmtNumber(connected)}
          hint={`of ${rows?.length ?? 0} shops`} />
        <StatCard label="Not connected" tone="yellow"
          value={fmtNumber((rows?.length ?? 0) - connected)} />
        <StatCard label="Processed (period)" tone="blue"
          value={fmtCurrency(totalProcessed)} />
        <StatCard label="Flagged shops" tone="red"
          value={fmtNumber(flagged)}
          hint=">5% refund or >3% failure" />
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff',
        border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12 }}>
        <Select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}
          options={[
            { value:'all',            label:'All accounts' },
            { value:'connected',      label:'Connected' },
            { value:'not_connected',  label:'Not connected' },
            { value:'high_refund',    label:'Refund rate > 5%' },
          ]} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>{filtered.length} shops</span>
      </div>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>Stripe</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Processed</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}># Payments</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Refund rate</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Failure rate</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Avg ticket</th>
            <th style={tableStyles.th}>Last payment</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {rows === undefined
              ? <tr><td colSpan={9} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : filtered.length === 0
                ? <tr><td colSpan={9} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No shops match this filter.</td></tr>
                : filtered.map(s => {
                    const refundHigh = s.refundRate > 0.05
                    const failHigh   = s.failureRate > 0.03
                    return (
                      <tr key={String(s.id)} onClick={() => gotoEntity('shops', String(s.id))} style={{ cursor:'pointer' }}>
                        <td style={tableStyles.td}>
                          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                            <span style={{ width:28, height:28, borderRadius:6,
                              background: s.stripeConnected ? '#635BFF' : 'var(--slate-100)',
                              display:'inline-flex', alignItems:'center', justifyContent:'center',
                              color: s.stripeConnected ? '#fff' : 'var(--slate-400)' }}>
                              <IconStripe size={14} />
                            </span>
                            <div style={{ minWidth:0 }}>
                              <div style={{ fontWeight:500, color:'var(--slate-900)' }}>{s.name}</div>
                              <div style={{ fontSize:11, color:'var(--slate-500)' }}>{s.city}</div>
                            </div>
                          </div>
                        </td>
                        <td style={tableStyles.td}>
                          {s.stripeConnected
                            ? s.payoutsEnabled
                              ? <Badge tone="green" dot>Payouts on</Badge>
                              : <Badge tone="yellow" dot>Payouts paused</Badge>
                            : <Badge tone="slate">Not connected</Badge>}
                        </td>
                        <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{fmtCurrency(s.processed)}</td>
                        <td style={{ ...tableStyles.td, textAlign:'right', color:'var(--slate-600)' }} className="mono">
                          {fmtNumber(s.paymentsCount)}
                          {s.failedCount > 0 && <span style={{ color:'var(--red-700)' }}> / {s.failedCount} failed</span>}
                        </td>
                        <td style={{ ...tableStyles.td, textAlign:'right', color: refundHigh ? 'var(--red-700)' : 'var(--slate-700)', fontWeight: refundHigh ? 600 : 400 }} className="mono">
                          {fmtPct(s.refundRate)}
                          {s.refundedCount > 0 && <span style={{ fontSize:10, color:'var(--slate-500)' }}> · {s.refundedCount}</span>}
                        </td>
                        <td style={{ ...tableStyles.td, textAlign:'right', color: failHigh ? 'var(--red-700)' : 'var(--slate-700)', fontWeight: failHigh ? 600 : 400 }} className="mono">
                          {fmtPct(s.failureRate)}
                        </td>
                        <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{fmtCurrency(s.avgTicket)}</td>
                        <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>
                          {s.lastPaymentAt ? `${fmtCurrency(s.lastPaymentAmount)} · ${fmtRelative(s.lastPaymentAt)}` : '—'}
                        </td>
                        <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                          {s.stripeConnected && s.stripeAccountId
                            ? <a href={`https://dashboard.stripe.com/connect/accounts/${s.stripeAccountId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
                                <Button size="sm" iconRight={<IconExternal size={11} />}>Stripe</Button>
                              </a>
                            : <a href={STRIPE_CONNECT_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
                                <Button size="sm" variant="primary" iconRight={<IconExternal size={11} />}>Send invite</Button>
                              </a>}
                        </td>
                      </tr>
                    )
                  })
            }
          </tbody>
        </table>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------
// Payments subtab
// ---------------------------------------------------------------------------

type PaymentRow = {
  id: Id<'payments'>
  amount: number
  status: string
  paymentMethod?: string
  stripePaymentIntentId?: string
  createdAt?: number
  updatedAt?: number
  userName: string
  userId: Id<'users'>
  shopName: string
  shopId: Id<'shops'>
  bookingId: Id<'bookings'>
  bookingScheduled?: string
  bookingStatus?: string
}

const PaymentsList = () => {
  const [status, setStatus] = useState<'all'|'succeeded'|'pending'|'failed'|'processing'|'canceled'>('all')
  const rows = useQuery(api.directorStripe.stripePaymentsList,
    status === 'all' ? { limit: 200 } : { status, limit: 200 }) as PaymentRow[] | undefined

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12 }}>
        <Select value={status} onChange={e => setStatus(e.target.value as typeof status)}
          options={[
            { value:'all',         label:'All statuses' },
            { value:'succeeded',   label:'Succeeded' },
            { value:'pending',     label:'Pending' },
            { value:'processing',  label:'Processing' },
            { value:'failed',      label:'Failed' },
            { value:'canceled',    label:'Canceled' },
          ]} />
        <span style={{ flex:1 }} />
        <span style={{ fontSize:12, color:'var(--slate-500)' }}>
          {rows === undefined ? 'Loading…' : `${rows.length} payments`}
        </span>
      </div>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>When</th>
            <th style={tableStyles.th}>Status</th>
            <th style={tableStyles.th}>User</th>
            <th style={tableStyles.th}>Shop</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Amount</th>
            <th style={tableStyles.th}>Method</th>
            <th style={tableStyles.th}>Stripe PI</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {rows === undefined
              ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>Loading…</td></tr>
              : rows.length === 0
                ? <tr><td colSpan={8} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No payments found.</td></tr>
                : rows.map(p => (
                  <tr key={String(p.id)}>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>{fmtRelative(p.createdAt)}</td>
                    <td style={tableStyles.td}><Badge tone={paymentTone(p.status)} dot>{p.status}</Badge></td>
                    <td style={tableStyles.td}>{p.userName}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{p.shopName}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{fmtCurrency(p.amount)}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)', fontSize:12 }}>{p.paymentMethod ?? '—'}</td>
                    <td style={{ ...tableStyles.td, color:'var(--blue-700)' }} className="mono" >
                      {p.stripePaymentIntentId ? p.stripePaymentIntentId.slice(0, 18) + '…' : '—'}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }}>
                      <div style={{ display:'flex', gap:4, justifyContent:'flex-end' }}>
                        {p.stripePaymentIntentId && (
                          <a href={`https://dashboard.stripe.com/payments/${p.stripePaymentIntentId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
                            <Button size="sm" iconRight={<IconExternal size={11} />}>Stripe</Button>
                          </a>
                        )}
                        <Button size="sm" onClick={() => gotoEntity('bookings', String(p.bookingId))}>Booking</Button>
                      </div>
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------
// Refunds subtab — refined with reasons + trend + per-shop leaderboard
// ---------------------------------------------------------------------------

type RefundsBreakdown = {
  totalCount: number
  totalValue: number
  untagged: number
  reasons: { reason: string; count: number }[]
  shops: { shopId: Id<'shops'>; shopName: string; total: number; refunded: number; rate: number }[]
  trend: { ts: number; total: number; refunded: number; rate: number }[]
  rows: { id: Id<'bookings'>; user: string; shop: string; scheduled: string; total: number; refundReason?: string; createdAt?: number }[]
}

const RefundsView = ({ period, onTag }: { period: Period; onTag: (id: Id<'bookings'>) => void }) => {
  const data = useQuery(api.directorStripe.stripeRefundsBreakdown, { period }) as RefundsBreakdown | undefined

  if (!data) {
    return <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading refunds…</div>
  }

  const maxReason = Math.max(1, ...data.reasons.map(r => r.count))
  const maxShop = Math.max(0.01, ...data.shops.map(s => s.rate))

  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label="Total refunds" tone="red" value={fmtNumber(data.totalCount)} />
        <StatCard label="Refund value" tone="red" value={fmtCurrency(data.totalValue)} />
        <StatCard label="Untagged" tone="yellow" value={fmtNumber(data.untagged)}
          hint={data.untagged > 0 ? 'Tag for clean reporting' : 'All clean'} />
        <StatCard label="Period" value={PERIOD_LABELS[period]} />
      </div>

      {data.untagged > 0 && (
        <div style={{ padding:'10px 14px', background:'var(--yellow-50)', border:'1px solid var(--yellow-200)', borderRadius:8, marginBottom:16, fontSize:13, color:'var(--yellow-800)', display:'flex', alignItems:'center', gap:8 }}>
          <IconTag size={14} />
          <span><b>{data.untagged} refund{data.untagged !== 1 ? 's' : ''}</b> have no reason tagged.</span>
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
        <Card>
          <SectionTitle label="Reasons breakdown" />
          {data.reasons.length === 0
            ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No tagged refunds in this period.</div>
            : (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {data.reasons.map(r => {
                  const meta = REFUND_REASONS[r.reason]
                  return (
                    <BarRow key={r.reason}
                      label={<><Badge tone={meta?.tone ?? 'slate'}>{meta?.label ?? r.reason}</Badge></>}
                      value={r.count} max={maxReason}
                      valueLabel={fmtNumber(r.count)}
                      color={meta?.tone === 'red' ? 'var(--red-500)' : meta?.tone === 'orange' ? 'var(--orange-500, #F97316)' : meta?.tone === 'yellow' ? 'var(--yellow-500, #EAB308)' : 'var(--slate-400)'} />
                  )
                })}
              </div>
            )}
        </Card>

        <Card>
          <SectionTitle label="Shops by refund rate"
            right={<span style={{ fontSize:11, color:'var(--slate-500)' }}>Top {Math.min(data.shops.length, 8)}</span>} />
          {data.shops.length === 0
            ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No shop activity in this period.</div>
            : (
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {data.shops.slice(0, 8).map(s => (
                  <BarRow key={String(s.shopId)}
                    label={<span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.shopName}</span>}
                    value={s.rate} max={maxShop}
                    valueLabel={<>{fmtPct(s.rate)} · <span style={{ color:'var(--slate-500)' }}>{s.refunded}/{s.total}</span></>}
                    color={s.rate > 0.05 ? 'var(--red-500)' : 'var(--blue-500)'} />
                ))}
              </div>
            )}
        </Card>
      </div>

      <Card style={{ marginBottom:16 }}>
        <SectionTitle label="8-week refund-rate trend" />
        <DualSparkline
          series={data.trend.map(t => ({ ts: t.ts, revenue: t.rate * 100, bookings: t.refunded }))}
          height={100}
          primaryLabel="Refund rate %"
          secondaryLabel="# refunded" />
      </Card>

      <Card padded={false}>
        <table style={tableStyles.table}>
          <thead><tr>
            <th style={tableStyles.th}>Booking</th>
            <th style={tableStyles.th}>User</th>
            <th style={tableStyles.th}>Shop</th>
            <th style={tableStyles.th}>Scheduled</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Amount</th>
            <th style={tableStyles.th}>Reason</th>
            <th style={{ ...tableStyles.th, textAlign:'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {data.rows.length === 0
              ? <tr><td colSpan={7} style={{ ...tableStyles.td, textAlign:'center', color:'var(--slate-400)', padding:32 }}>No refunded bookings in this period.</td></tr>
              : data.rows.map(b => {
                const r = b.refundReason ? REFUND_REASONS[b.refundReason] : null
                return (
                  <tr key={String(b.id)} onClick={() => gotoEntity('bookings', String(b.id))} style={{ cursor:'pointer' }}>
                    <td style={tableStyles.td}><span className="mono" style={{ color:'var(--blue-700)' }}>{String(b.id).slice(-8)}</span></td>
                    <td style={tableStyles.td}>{b.user}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-600)' }}>{b.shop}</td>
                    <td style={{ ...tableStyles.td, color:'var(--slate-500)', fontSize:12 }}>{b.scheduled}</td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} className="mono">{fmtCurrency(b.total)}</td>
                    <td style={tableStyles.td}>
                      {r ? <Badge tone={r.tone}>{r.label}</Badge>
                        : <span style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>Untagged</span>}
                    </td>
                    <td style={{ ...tableStyles.td, textAlign:'right' }} onClick={e => e.stopPropagation()}>
                      <Button size="sm" iconRight={<IconTag size={11} />} onClick={() => onTag(b.id)}>Tag</Button>
                    </td>
                  </tr>
                )
              })
            }
          </tbody>
        </table>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------
// Webhook health subtab
// ---------------------------------------------------------------------------

type WebhookHealth = {
  hours: number
  total: number
  recentCount: number
  lastReceivedAt?: number
  lastEventType?: string
  unprocessed: number
  distribution: { type: string; count: number; lastSeen: number; processed: number }[]
  stream: { id: Id<'stripe_webhook_events'>; eventId: string; eventType: string; livemode?: boolean; stripeAccountId?: string; receivedAt: number; processedAt?: number }[]
}

const WebhookHealthView = () => {
  const [hours, setHours] = useState<number>(24)
  const data = useQuery(api.directorStripe.stripeWebhookHealth, { hours }) as WebhookHealth | undefined

  if (!data) return <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading webhook events…</div>

  const stale = !data.lastReceivedAt || (Date.now() - data.lastReceivedAt) > 60 * 60 * 1000
  const maxType = Math.max(1, ...data.distribution.map(d => d.count))

  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:16 }}>
        <StatCard label={`Events (last ${data.hours}h)`} tone="blue"
          value={fmtNumber(data.recentCount)}
          accent={<IconBolt size={14} style={{ color:'var(--slate-400)' }} />} />
        <StatCard label="Unprocessed" tone="red"
          value={fmtNumber(data.unprocessed)}
          hint={data.unprocessed > 0 ? 'Replay or investigate' : 'All caught up'} />
        <StatCard label="Last event"
          value={data.lastReceivedAt ? fmtRelative(data.lastReceivedAt) : '—'}
          hint={data.lastEventType ?? '—'}
          accent={<IconClock size={14} style={{ color: stale ? 'var(--red-500)' : 'var(--green-600)' }} />} />
        <StatCard label="Lifetime events"
          value={fmtNumber(data.total)} />
      </div>

      {stale && data.total > 0 && (
        <div style={{ padding:'10px 14px', background:'var(--red-50)', border:'1px solid #FECACA', borderRadius:8, marginBottom:16, fontSize:13, color:'var(--red-700)', display:'flex', alignItems:'center', gap:8 }}>
          <IconBolt size={14} />
          <span><b>No webhook events received in the last hour.</b> Check the Stripe endpoint in the dashboard.</span>
        </div>
      )}

      <div style={{ display:'flex', alignItems:'center', gap:10, padding:12, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, marginBottom:12 }}>
        <Select value={String(hours)} onChange={e => setHours(Number(e.target.value))}
          options={[
            { value:'1',  label:'Last hour' },
            { value:'24', label:'Last 24h' },
            { value:'168', label:'Last 7 days' },
          ]} />
        <span style={{ flex:1 }} />
        <a href="https://dashboard.stripe.com/webhooks" target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
          <Button size="sm" iconRight={<IconExternal size={11} />}>Stripe webhooks</Button>
        </a>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1.4fr', gap:12 }}>
        <Card>
          <SectionTitle label={`Event types (${data.distribution.length})`} />
          {data.distribution.length === 0
            ? <div style={{ fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No events in this window.</div>
            : (
              <div style={{ display:'flex', flexDirection:'column', gap:4, maxHeight:380, overflowY:'auto' }}>
                {data.distribution.map(d => (
                  <BarRow key={d.type}
                    label={<span className="mono" style={{ fontSize:11 }}>{d.type}</span>}
                    value={d.count} max={maxType}
                    valueLabel={<>{d.count} <span style={{ color: d.count === d.processed ? 'var(--green-700)' : 'var(--yellow-700)' }}>· {d.processed} ok</span></>}
                    color={d.count === d.processed ? 'var(--blue-500)' : 'var(--yellow-500, #EAB308)'} />
                ))}
              </div>
            )}
        </Card>

        <Card padded={false}>
          <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--slate-200)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
              Event stream
            </span>
            <span style={{ fontSize:11, color:'var(--slate-500)' }}>{data.stream.length} recent</span>
          </div>
          {data.stream.length === 0 ? (
            <div style={{ padding:24, textAlign:'center', fontSize:12, color:'var(--slate-400)', fontStyle:'italic' }}>No events.</div>
          ) : (
            <div style={{ maxHeight:380, overflowY:'auto' }}>
              {data.stream.map(e => (
                <div key={String(e.id)} style={{ padding:'10px 14px', borderBottom:'1px solid var(--slate-100)', display:'grid', gridTemplateColumns:'90px 1fr 80px 60px', gap:10, alignItems:'center', fontSize:12 }}>
                  <span style={{ color:'var(--slate-500)' }}>{fmtRelative(e.receivedAt)}</span>
                  <span className="mono" style={{ color:'var(--slate-800)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.eventType}</span>
                  <span>{e.processedAt ? <Badge tone="green">ok</Badge> : <Badge tone="yellow">pending</Badge>}</span>
                  <span style={{ textAlign:'right' }}>
                    {e.livemode === false ? <Badge tone="slate">test</Badge> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// TabStripe root
// ---------------------------------------------------------------------------

export const TabStripe = () => {
  const [sub, setSub]       = useState<SubTab>('overview')
  const [period, setPeriod] = useState<Period>('30d')
  const [tagTarget, setTagTarget] = useState<Id<'bookings'> | null>(null)

  return (
    <SectionAnchor id="stripe" title="Stripe & Payments"
      subtitle="Financial health derived from the marketplace. Live payout balances require Stripe Connect API."
      right={
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <Select value={period} onChange={e => setPeriod(e.target.value as Period)}
            options={(['7d','30d','90d','ytd'] as Period[]).map(p => ({ value:p, label: PERIOD_LABELS[p] }))} />
          <a href="https://dashboard.stripe.com/" target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>
            <Button variant="dark" iconRight={<IconExternal size={13} />}>Stripe dashboard</Button>
          </a>
        </div>
      }>

      {/* Subtab bar */}
      <div style={{ display:'flex', gap:2, marginBottom:14, background:'#fff', border:'1px solid var(--slate-200)', borderRadius:10, padding:4 }}>
        {SUBTABS.map(t => {
          const isActive = sub === t.id
          return (
            <button key={t.id} onClick={() => setSub(t.id)}
              style={{ flex:1, padding:'8px 12px', border:'none', borderRadius:7, cursor:'pointer', fontSize:13, fontWeight:500,
                background: isActive ? 'var(--blue-50)' : 'transparent',
                color: isActive ? 'var(--blue-700)' : 'var(--slate-600)',
                transition: 'background 80ms' }}>
              {t.label}
            </button>
          )
        })}
      </div>

      {sub === 'overview' && <FinancialOverview period={period} />}
      {sub === 'accounts' && <ConnectedAccounts period={period} />}
      {sub === 'payments' && <PaymentsList />}
      {sub === 'refunds'  && <RefundsView period={period} onTag={setTagTarget} />}
      {sub === 'webhooks' && <WebhookHealthView />}

      <TagRefundModal bookingId={tagTarget} onClose={() => setTagTarget(null)} />
    </SectionAnchor>
  )
}
