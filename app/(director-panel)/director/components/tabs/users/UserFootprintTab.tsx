'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge } from '../../Primitives'
import { H2, Loading, Stars, fmtDate, fmtMoney, statusTone, openShop } from './usersUi'

export const UserFootprintTab = ({ userId, onOpenBooking }:
  { userId: Id<'users'>; onOpenBooking: (id: Id<'bookings'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const data = useQuery(api.opsUsers.footprint, { token: session?.token ?? '', id: userId })

  if (data === undefined) return <Loading label="footprint" />

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, alignItems:'start' }}>
      <Card>
        <H2>Reviews written ({data.reviews.length})</H2>
        {data.reviews.length === 0
          ? <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-400)' }}>This user hasn’t written any reviews.</p>
          : <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
            {data.reviews.map(r => (
              <div key={r.id} style={{ borderBottom:'1px solid var(--slate-50)', paddingBottom:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <Stars rating={r.rating} />
                  {r.shop && r.shopId && <a onClick={() => openShop(r.shopId!)} style={{ fontSize:12, fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>{r.shop}</a>}
                  {r.hidden && <Badge tone="slate">hidden</Badge>}
                  <span style={{ marginLeft:'auto', fontSize:11, color:'var(--slate-400)' }}>{fmtDate(r.at)}</span>
                </div>
                {r.comment && <p style={{ margin:'4px 0 0', fontSize:12, color:'var(--slate-600)' }}>{r.comment}</p>}
              </div>
            ))}
          </div>}
      </Card>

      <Card>
        <H2>Disputes filed ({data.disputes.length})</H2>
        {data.disputes.length === 0
          ? <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-400)' }}>No disputes filed by this user.</p>
          : <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
            {data.disputes.map(d => (
              <div key={d.id} style={{ borderRadius:8, border:'1px solid #FEE2E2', background:'rgba(254,242,242,0.5)', padding:12, fontSize:12 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ fontWeight:500, color:'var(--slate-800)' }}>{d.reason.replace(/_/g, ' ')}</span>
                  <Badge tone={statusTone(d.status)}>{d.status.replace(/_/g, ' ')}</Badge>
                </div>
                <div style={{ marginTop:4, fontSize:11, color:'var(--slate-400)' }}>
                  filed {fmtDate(d.filedAt)}{d.resolvedAt ? ` · resolved ${fmtDate(d.resolvedAt)}` : ''}{d.resolution ? ` · ${d.resolution.replace(/_/g, ' ')}` : ''}{d.refund != null ? ` · refund ${fmtMoney(d.refund)}` : ''}
                </div>
                <span onClick={() => onOpenBooking(d.bookingId as Id<'bookings'>)} style={{ marginTop:4, display:'inline-block', fontSize:12, fontWeight:500, color:'var(--blue-600)', cursor:'pointer' }}>booking →</span>
              </div>
            ))}
          </div>}
      </Card>
    </div>
  )
}
