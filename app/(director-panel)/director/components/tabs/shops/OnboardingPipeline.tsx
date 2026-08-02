'use client'

import { useContext, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Badge } from '../../Primitives'
import { LoadingBlock } from './shopsUi'
import type { PipelineResult, PipelineCard } from '@/convex/shopsPipeline'

// Kanban-style onboarding pipeline: Lead → Agreed → Stripe → Configured → Staffed → Test run → Live.
// Stages are auto-derived from real DB checks — no checkbox of vibes.

const STAGE_COLORS: Record<string, { bg: string; fg: string; bd: string }> = {
  'Lead':        { bg: '#F1F5F9', fg: 'var(--slate-600)', bd: 'var(--slate-200)' },
  'Agreed':      { bg: '#EFF6FF', fg: 'var(--blue-700)',  bd: '#BFDBFE' },
  'Stripe':      { bg: '#F0FDF4', fg: 'var(--green-700)', bd: '#A7F3D0' },
  'Configured':  { bg: '#FFF7ED', fg: 'var(--orange-700)', bd: '#FED7AA' },
  'Staffed':     { bg: '#FAF5FF', fg: 'var(--purple-700)', bd: '#E9D5FF' },
  'Test run':    { bg: '#FFFBEB', fg: 'var(--yellow-800)', bd: '#FDE68A' },
  'Live':        { bg: '#ECFDF5', fg: 'var(--green-700)', bd: '#6EE7B7' },
}

function fmtMoney(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

const PipelineCardView = ({ card, onOpenShop }: { card: PipelineCard; onOpenShop: (id: string) => void }) => {
  const [expanded, setExpanded] = useState(false)
  const passedCount = card.checklist.filter(c => c.passed).length

  return (
    <div style={{ background: '#fff', border: '1px solid var(--slate-200)', borderRadius: 10, padding: '12px 14px', cursor: 'pointer' }}
      onClick={() => onOpenShop(card.shop_id)}>

      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--slate-900)', marginBottom: 2 }}>{card.name}</div>
      {card.city && <div style={{ fontSize: 12, color: 'var(--slate-500)', marginBottom: 6 }}>{card.city}</div>}

      {card.owner && (
        <div style={{ fontSize: 12, color: 'var(--slate-600)', marginBottom: 6 }}>
          Owner: <span style={{ fontWeight: 500 }}>{card.owner}</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {card.bookings_30d > 0 && (
          <span style={{ fontSize: 11, color: 'var(--slate-500)', background: 'var(--slate-50)', border: '1px solid var(--slate-200)', borderRadius: 4, padding: '2px 6px' }}>
            {card.bookings_30d} booking{card.bookings_30d !== 1 ? 's' : ''} 30d
          </span>
        )}
        {card.revenue_30d > 0 && (
          <span style={{ fontSize: 11, color: 'var(--green-700)', background: 'var(--green-50)', border: '1px solid #A7F3D0', borderRadius: 4, padding: '2px 6px' }}>
            {fmtMoney(card.revenue_30d)} 30d
          </span>
        )}
        {card.age_days != null && (
          <span style={{ fontSize: 11, color: 'var(--slate-400)', background: 'var(--slate-50)', border: '1px solid var(--slate-100)', borderRadius: 4, padding: '2px 6px' }}>
            {card.age_days}d old
          </span>
        )}
      </div>

      {card.next_item && (
        <div style={{ fontSize: 11, color: 'var(--amber-700)', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, padding: '4px 8px', marginBottom: 8 }}>
          Next: {card.next_item}
        </div>
      )}

      {/* checklist toggle */}
      <button
        onClick={e => { e.stopPropagation(); setExpanded(x => !x) }}
        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 11, color: 'var(--slate-400)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{expanded ? '▲' : '▼'}</span>
        <span>{passedCount}/{card.checklist.length} checks</span>
      </button>

      {expanded && (
        <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {card.checklist.map((item, i) => (
            <li key={i} style={{ display: 'flex', gap: 6, fontSize: 11, alignItems: 'flex-start' }}>
              <span style={{ color: item.passed ? 'var(--green-600)' : 'var(--slate-300)', fontWeight: 700, flexShrink: 0, marginTop: 1 }}>
                {item.passed ? '✓' : '○'}
              </span>
              <span>
                <span style={{ color: item.passed ? 'var(--slate-700)' : 'var(--slate-500)' }}>{item.label}</span>
                <span style={{ color: 'var(--slate-400)', marginLeft: 4 }}>— {item.proof}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const OnboardingPipeline = ({ onOpenShop }: { onOpenShop: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const data = useQuery(api.shopsPipeline.board, { token: session?.token ?? '' }) as PipelineResult | undefined

  if (data === undefined) return <LoadingBlock label="pipeline" />

  const totalShops = data.columns.reduce((s, col) => s + col.cards.length, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--slate-600)' }}>
        <span>{totalShops} shop{totalShops !== 1 ? 's' : ''} total</span>
        <span style={{ color: 'var(--green-700)', fontWeight: 600 }}>
          {data.live_count} live
        </span>
        <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>Stages auto-derived from DB checks — advances when facts change.</span>
      </div>

      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
        {data.columns.map(col => {
          const colors = STAGE_COLORS[col.stage] ?? STAGE_COLORS['Lead']
          return (
            <div key={col.stage} style={{ minWidth: 200, maxWidth: 220, flexShrink: 0 }}>
              {/* column header */}
              <div style={{ borderRadius: 8, padding: '6px 12px', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: colors.bg, border: `1px solid ${colors.bd}` }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: colors.fg }}>{col.stage}</span>
                {col.cards.length > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: colors.fg, opacity: 0.75, background: '#fff', borderRadius: 99, padding: '1px 7px', border: `1px solid ${colors.bd}` }}>
                    {col.cards.length}
                  </span>
                )}
              </div>

              {/* cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {col.cards.length === 0 ? (
                  <div style={{ borderRadius: 8, border: '1px dashed var(--slate-200)', padding: '16px 12px', textAlign: 'center', fontSize: 12, color: 'var(--slate-300)' }}>
                    Empty
                  </div>
                ) : (
                  col.cards.map(card => (
                    <PipelineCardView key={card.shop_id} card={card} onOpenShop={onOpenShop} />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
