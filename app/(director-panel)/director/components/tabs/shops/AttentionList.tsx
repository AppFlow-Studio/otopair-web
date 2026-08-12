'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Badge } from '../../Primitives'
import type { AttentionShop } from './types'

// Shops failing health checks — ported from /shops "Needs attention".

const CHECK_LABEL: Record<string, string> = {
  hours_missing: 'Hours',
  no_services: 'Services',
  stripe_incomplete: 'Stripe',
  rating_low: 'Rating',
  inactive: 'Inactive',
}
const checkTone = (kind: string): 'red' | 'yellow' =>
  kind === 'rating_low' || kind === 'inactive' ? 'red' : 'yellow'

export const AttentionList = ({ onOpenShop }: { onOpenShop: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const attention = useQuery(api.shopsNetwork.attention, { token: session?.token ?? '' }) as AttentionShop[] | undefined

  if (attention === undefined) {
    return <div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
  }
  if (attention.length === 0) {
    return (
      <div style={{ borderRadius:10, background:'var(--green-50)', border:'1px solid #A7F3D0', padding:'28px 24px', textAlign:'center', color:'var(--green-700)', fontSize:14 }}>
        Every shop passes all checks — hours set, services offered, Stripe complete, ratings healthy.
      </div>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ fontSize:13, color:'var(--slate-500)' }}>{attention.length} shop{attention.length === 1 ? '' : 's'} with setup gaps or health-check failures.</div>
      {attention.map(s => (
        <div key={s.id} style={{ borderRadius:10, border:'1px solid var(--amber-200, #FDE68A)', background:'#fff', padding:'14px 16px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <a onClick={() => onOpenShop(s.id)} style={{ fontSize:14, fontWeight:500, color:'var(--slate-900)', cursor:'pointer' }}>{s.name}</a>
            <span style={{ flex:1 }} />
            <span style={{ display:'flex', flexWrap:'wrap', gap:6, justifyContent:'flex-end' }}>
              {s.checks.map(c => <Badge key={c.kind} tone={checkTone(c.kind)}>{CHECK_LABEL[c.kind] ?? c.kind}</Badge>)}
            </span>
          </div>
          <ul style={{ margin:'8px 0 0', padding:0, listStyle:'none', display:'flex', flexDirection:'column', gap:3 }}>
            {s.checks.map(c => <li key={c.kind} style={{ fontSize:12, color:'var(--slate-500)' }}>{c.detail}</li>)}
          </ul>
        </div>
      ))}
    </div>
  )
}
