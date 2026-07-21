'use client'

import { useContext, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card, Badge } from '../../Primitives'
import { Field, Loading, MicroLabel, fmtDate, statusTone } from './usersUi'

const RecordBox = ({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) => (
  <div style={{ borderRadius:8, background:'var(--slate-50)', padding:12, fontSize:12 }}>
    <MicroLabel>{title}{count != null ? ` (${count})` : ''}</MicroLabel>
    <div style={{ marginTop:4 }}>{children}</div>
  </div>
)

const VehicleRecordsPanel = ({ userId, ownerId, vin, onOpenBooking }:
  { userId: Id<'users'>; ownerId: Id<'vehicle_owners'>; vin: string; onOpenBooking: (id: Id<'bookings'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const [open, setOpen] = useState(false)
  const data = useQuery(api.opsUsers.vehicleRecords, open ? { token: session?.token ?? '', userId, ownerId, vin } : 'skip')

  return (
    <div style={{ marginTop:12, borderTop:'1px solid var(--slate-100)', paddingTop:12 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background:'none', border:'none', cursor:'pointer', fontSize:12, fontWeight:500, color:'var(--blue-600)', padding:0, fontFamily:'inherit' }}>
        {open ? '▾ Hide records & history' : '▸ Records & history'}
      </button>
      {open && (
        <div style={{ marginTop:12 }}>
          {data === undefined ? <div style={{ height:64, borderRadius:8, background:'var(--slate-100)' }} className="animate-pulse" />
            : (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                {(data.classification || data.drivingProfile || data.healthPoints) && (
                  <RecordBox title="Profile">
                    <div style={{ color:'var(--slate-600)', display:'flex', flexDirection:'column', gap:2 }}>
                      {data.classification && <div>Mode: <span style={{ color:'var(--slate-800)' }}>{data.classification.vehicleMode}</span>{data.classification.ownerSegment ? ` · ${data.classification.ownerSegment}` : ''}{data.classification.annualMileage != null ? ` · ~${data.classification.annualMileage.toLocaleString()} mi/yr` : ''}</div>}
                      {data.drivingProfile && <div>{[data.drivingProfile.usagePattern, data.drivingProfile.annualMileageBand, data.drivingProfile.ownershipDuration].filter(Boolean).join(' · ') || '—'}</div>}
                      {data.healthPoints && <div>Health points: <span style={{ color:'var(--slate-800)' }}>{data.healthPoints.points}</span></div>}
                    </div>
                  </RecordBox>
                )}
                <RecordBox title="Maintenance" count={data.maintenance.length}>
                  {data.maintenance.length === 0 ? <p style={{ margin:0, color:'var(--slate-400)' }}>No records.</p>
                    : <ul style={{ margin:0, padding:0, listStyle:'none', color:'var(--slate-600)' }}>{data.maintenance.slice(0, 6).map(m => <li key={m.id}>{m.type.replace(/_/g, ' ')}{m.lastServiceMileage != null ? ` · ${m.lastServiceMileage.toLocaleString()} mi` : ''}{m.lastServiceDate ? ` · ${m.lastServiceDate}` : ''}{m.confidence ? ` (${m.confidence})` : ''}</li>)}</ul>}
                </RecordBox>
                <RecordBox title="Odometer" count={data.odometer.length}>
                  {data.odometer.length === 0 ? <p style={{ margin:0, color:'var(--slate-400)' }}>No readings.</p>
                    : <ul style={{ margin:0, padding:0, listStyle:'none', color:'var(--slate-600)' }}>{data.odometer.slice(0, 5).map(o => <li key={o.id}>{o.distance.toLocaleString()} {o.unit} · {fmtDate(o.recordedAt)}</li>)}</ul>}
                </RecordBox>
                <RecordBox title="Documents" count={data.documents.length}>
                  {data.documents.length === 0 ? <p style={{ margin:0, color:'var(--slate-400)' }}>No documents.</p>
                    : <ul style={{ margin:0, padding:0, listStyle:'none' }}>{data.documents.map(d => <li key={d.id}>{d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--blue-600)' }}>{d.filename}</a> : <span style={{ color:'var(--slate-600)' }}>{d.filename}</span>}<span style={{ color:'var(--slate-400)' }}> · {d.source.replace(/_/g, ' ')} · {d.parseStatus}</span></li>)}</ul>}
                </RecordBox>
                <RecordBox title="Inspections" count={data.inspections.length}>
                  {data.inspections.length === 0 ? <p style={{ margin:0, color:'var(--slate-400)' }}>No inspections.</p>
                    : <ul style={{ margin:0, padding:0, listStyle:'none', color:'var(--slate-600)' }}>{data.inspections.slice(0, 6).map(i => <li key={i.id}><a onClick={() => onOpenBooking(i.bookingId as Id<'bookings'>)} style={{ color:'var(--blue-600)', cursor:'pointer' }}>{fmtDate(i.createdAt)}</a><span style={{ color:'var(--slate-400)' }}> · {i.attention} attention · {i.monitor} monitor</span>{i.pdfUrl && <a href={i.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ marginLeft:4, color:'var(--blue-600)' }}>PDF</a>}</li>)}</ul>}
                </RecordBox>
                <RecordBox title="Service states" count={data.serviceStates.length}>
                  {data.serviceStates.length === 0 ? <p style={{ margin:0, color:'var(--slate-400)' }}>None surfaced.</p>
                    : <ul style={{ margin:0, padding:0, listStyle:'none', color:'var(--slate-600)' }}>{data.serviceStates.slice(0, 8).map((s, i) => <li key={i}>{s.service}{s.urgency ? ` · ${s.urgency}` : ''}{s.dueAtMileage != null ? ` · due ${s.dueAtMileage.toLocaleString()} mi` : ''}</li>)}</ul>}
                </RecordBox>
                <RecordBox title="Check-ins" count={data.checkins.length}>
                  {data.checkins.length === 0 ? <p style={{ margin:0, color:'var(--slate-400)' }}>No check-ins.</p>
                    : <ul style={{ margin:0, padding:0, listStyle:'none', color:'var(--slate-600)' }}>{data.checkins.slice(0, 5).map(c => <li key={c.id}>{c.completedAt ? fmtDate(c.completedAt) : 'in progress'}{c.mileageReported != null ? ` · ${c.mileageReported.toLocaleString()} mi` : ''}{c.symptoms ? ` · "${c.symptoms.slice(0, 40)}"` : ''}</li>)}</ul>}
                </RecordBox>
              </div>
            )}
        </div>
      )}
    </div>
  )
}

export const UserGarageTab = ({ userId, onOpenBooking }: { userId: Id<'users'>; onOpenBooking: (id: Id<'bookings'>) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const rows = useQuery(api.opsUsers.garage, { token: session?.token ?? '', id: userId })

  if (rows === undefined) return <Loading label="garage" />
  if (rows.length === 0) return <Card><div style={{ padding:'20px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>No vehicles in this user’s garage yet.</div></Card>

  const active = rows.filter(r => r.status !== 'removed')
  const removed = rows.filter(r => r.status === 'removed')

  const VehicleCard = ({ v }: { v: (typeof rows)[number] }) => (
    <Card>
      <div style={{ display:'flex', alignItems:'flex-start', gap:16 }}>
        {v.imageUrl
          ? <img src={v.imageUrl} alt="" style={{ height:64, width:96, flexShrink:0, borderRadius:8, objectFit:'cover' }} />
          : <div style={{ height:64, width:96, flexShrink:0, borderRadius:8, background:'var(--slate-100)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:'var(--slate-400)' }}>No image</div>}
        <div style={{ minWidth:0, flex:1 }}>
          <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:15, fontWeight:600, color:'var(--slate-900)' }}>{v.nickname ?? v.ymm}</span>
            {v.isPrimary && <Badge tone="green">Primary</Badge>}
            <Badge tone={statusTone(v.status)}>{v.status}</Badge>
            <a href={`/director/data/vins/${v.vin}`} title="Open VIN in the data portal" className="mono" style={{ borderRadius:4, background:'var(--slate-100)', padding:'1px 6px', fontSize:11, color:'var(--slate-500)', textDecoration:'none' }}>{v.vin}</a>
          </div>
          <div style={{ marginTop:4, fontSize:13, color:'var(--slate-500)' }}>{[v.ymm, v.trim, v.engine].filter(Boolean).join(' · ') || 'Spec unresolved'}</div>
          <div style={{ marginTop:8, display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
            <Field label="Mileage" value={v.mileage != null ? `${v.mileage.toLocaleString()} mi` : '—'} />
            <Field label="Health score" value={v.healthScore != null ? v.healthScore : '—'} />
            <Field label="Added" value={fmtDate(v.addedAt)} />
            <Field label={v.status === 'removed' ? 'Removed' : 'Segment'} value={v.status === 'removed' ? fmtDate(v.removedAt) : v.ownerSegment ?? '—'} />
          </div>
          {(v.avgMonthlyDriving || v.drivingConditions) && (
            <div style={{ marginTop:8, fontSize:12, color:'var(--slate-500)' }}>Driving: {[v.avgMonthlyDriving, v.drivingConditions].filter(Boolean).join(' · ')}</div>
          )}
        </div>
      </div>
      <VehicleRecordsPanel userId={userId} ownerId={v.ownerId} vin={v.vin} onOpenBooking={onOpenBooking} />
    </Card>
  )

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {active.map(v => <VehicleCard key={v.ownerId} v={v} />)}
      {removed.length > 0 && (
        <>
          <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--slate-400)' }}>Removed vehicles</div>
          {removed.map(v => <VehicleCard key={v.ownerId} v={v} />)}
        </>
      )}
    </div>
  )
}
