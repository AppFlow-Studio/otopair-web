'use client'

import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Modal, Button, Badge, StatusBadge, IconCar } from './Primitives'

/**
 * UserVehicleHistoryModal
 * Drills down into a (user, vehicle) pair: bookings on this car, services
 * performed, total spend, ownership info. Opens from the user-detail modal
 * when the director clicks one of the vehicle cards.
 */

type Props = {
  userId:    Id<'users'> | null
  vehicleId: Id<'vehicles'> | null
  onClose:   () => void
}

function fmtCurrency(n: number | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`
}

function fmtDate(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
}

export const UserVehicleHistoryModal = ({ userId, vehicleId, onClose }: Props) => {
  const open = !!(userId && vehicleId)
  const data = useQuery(api.directorCars.userVehicleHistory,
    open ? { userId: userId!, vehicleId: vehicleId! } : 'skip')

  const ymmt = data ? [data.year, data.make, data.model, data.trim !== '—' ? data.trim : null].filter(Boolean).join(' ') : ''

  return (
    <Modal open={open} onClose={onClose} width={860}
      eyebrow={data && <>
        <span style={{ width:32, height:32, borderRadius:8, background:'var(--slate-100)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'var(--slate-600)' }}>
          <IconCar size={16} />
        </span>
        <span className="mono" style={{ fontSize:13, color:'var(--slate-500)' }}>{data.vin}</span>
        {data.ownership?.isPrimary && <Badge tone="indigo">Primary</Badge>}
        {data.ownership?.nickname && <Badge tone="slate">{data.ownership.nickname}</Badge>}
      </>}
      title={ymmt || 'Vehicle history'}
      footer={<Button onClick={onClose}>Close</Button>}>
      {!data ? (
        <div style={{ padding:40, textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
      ) : (
        <>
          {/* Stat strip */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', borderBottom:'1px solid var(--slate-200)' }}>
            {[
              { label:'Bookings',    value: String(data.bookingCount) },
              { label:'Completed',   value: String(data.completedCount) },
              { label:'Total spend', value: fmtCurrency(data.totalSpend) },
              { label:'Mileage',     value: data.passportMileage ?? data.ownership?.mileage
                  ? `${(data.passportMileage ?? data.ownership?.mileage)!.toLocaleString()} mi`
                  : '—' },
            ].map(stat => (
              <div key={stat.label} style={{ padding:'14px 18px', borderRight:'1px solid var(--slate-100)' }}>
                <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:4 }}>{stat.label}</div>
                <div style={{ fontSize:18, fontWeight:600, color:'var(--slate-900)' }} className="mono">{stat.value}</div>
              </div>
            ))}
          </div>

          {/* Ownership summary */}
          {data.ownership && (
            <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--slate-200)', fontSize:12, color:'var(--slate-600)', display:'flex', gap:18, flexWrap:'wrap' }}>
              {data.ownership.added_at && <span>Added {fmtDate(data.ownership.added_at)}</span>}
              {data.ownership.ownership_type && <span>Type: <b style={{ color:'var(--slate-800)' }}>{data.ownership.ownership_type}</b></span>}
              {data.ownership.ownership_plan && <span>Plan: <b style={{ color:'var(--slate-800)' }}>{data.ownership.ownership_plan}</b></span>}
              {data.ownership.health_score != null && <span>Health: <b style={{ color:'var(--slate-800)' }}>{Math.round(data.ownership.health_score)}</b></span>}
              <span>Status: <StatusBadge status={data.ownership.status} /></span>
            </div>
          )}

          {/* Bookings */}
          <div style={{ padding:22 }}>
            <div style={{ fontSize:11, color:'var(--slate-500)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>
              Booking history ({data.bookings.length})
            </div>
            {data.bookings.length === 0 ? (
              <div style={{ fontSize:13, color:'var(--slate-400)', fontStyle:'italic', padding:'12px 0' }}>
                No bookings on this vehicle yet.
              </div>
            ) : (
              <div style={{ border:'1px solid var(--slate-200)', borderRadius:8, overflow:'hidden' }}>
                <div style={{ display:'grid', gridTemplateColumns:'110px 1fr 1fr 120px 100px', padding:'10px 12px', background:'var(--slate-25)', borderBottom:'1px solid var(--slate-200)', fontSize:11, fontWeight:600, color:'var(--slate-500)', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                  <span>Date</span>
                  <span>Services</span>
                  <span>Shop</span>
                  <span>Status</span>
                  <span style={{ textAlign:'right' }}>Total</span>
                </div>
                {data.bookings.map((b, i) => (
                  <div key={String(b.id)} style={{
                    display:'grid', gridTemplateColumns:'110px 1fr 1fr 120px 100px',
                    padding:'10px 12px', alignItems:'center',
                    borderBottom: i < data.bookings.length - 1 ? '1px solid var(--slate-100)' : 'none',
                    fontSize:12, color:'var(--slate-700)',
                  }}>
                    <span className="mono">{b.scheduled}</span>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.services.join(', ') || '—'}</span>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.shop}</span>
                    <span><StatusBadge status={b.status} /></span>
                    <span className="mono" style={{ textAlign:'right' }}>{fmtCurrency(b.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
