'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Badge, IconExternal } from '../../Primitives'
import { licenseLabel } from '@/lib/license-catalog'

// Cross-shop verification queue — every shop with a pending license /
// certification, so a director can work the backlog and open each shop's
// Compliance tab to verify or reject. Backed by shopsDirectory.pendingLicenseReviews.

const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

export const LicenseReviewQueue = ({ onOpenShop }: { onOpenShop: (id: string) => void }) => {
  const session = useContext(DirectorSessionCtx)
  const data = useQuery(api.shopsDirectory.pendingLicenseReviews, { token: session?.token ?? '' }) as
    | { total: number; shopCount: number; rows: Array<{ _id: string; shopId: string; shopName: string; licenseType: string; originalFilename: string | null; url: string | null; createdAt: number }> }
    | undefined

  if (data === undefined) {
    return <div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading…</div>
  }
  if (data.rows.length === 0) {
    return (
      <div style={{ borderRadius:10, background:'var(--green-50)', border:'1px solid #A7F3D0', padding:'28px 24px', textAlign:'center', color:'var(--green-700)', fontSize:14 }}>
        No documents waiting for review — every uploaded license and certification has been actioned.
      </div>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ fontSize:13, color:'var(--slate-500)' }}>
        {data.total} document{data.total === 1 ? '' : 's'} awaiting review across {data.shopCount} shop{data.shopCount === 1 ? '' : 's'}.
      </div>
      {data.rows.map(row => (
        <div key={row._id} style={{ borderRadius:10, border:'1px solid var(--amber-200, #FDE68A)', background:'#fff', padding:'14px 16px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <a onClick={() => onOpenShop(row.shopId)} style={{ fontSize:14, fontWeight:600, color:'var(--slate-900)', cursor:'pointer' }}>{row.shopName}</a>
            <Badge tone="yellow">Pending review</Badge>
            <span style={{ flex:1 }} />
            <button
              onClick={() => onOpenShop(row.shopId)}
              style={{ fontSize:12.5, fontWeight:500, color:'var(--blue-600)', background:'transparent', border:'none', cursor:'pointer', fontFamily:'inherit' }}
            >
              Review in Compliance →
            </button>
          </div>
          <div style={{ marginTop:6, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', fontSize:12.5, color:'var(--slate-600)' }}>
            <span style={{ fontWeight:500, color:'var(--slate-800)' }}>{licenseLabel(row.licenseType)}</span>
            {row.url
              ? <a href={row.url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--blue-600)', textDecoration:'none' }}>{row.originalFilename ?? 'View document'} <IconExternal size={11} /></a>
              : <span style={{ color:'var(--slate-500)' }}>{row.originalFilename ?? 'Document'}</span>}
            <span style={{ color:'var(--slate-400)' }}>Uploaded {fmtDate(row.createdAt)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
