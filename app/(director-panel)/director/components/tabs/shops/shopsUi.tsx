'use client'

// Small shared presentational bits for the director Shops surfaces, in the
// panel's inline-style theme.

export const HealthDot = ({ health, failingChecks, size = 10 }:
  { health: 'green' | 'amber'; failingChecks: string[]; size?: number }) => (
  <span
    title={health === 'green' ? 'All health checks passing' : `Failing: ${failingChecks.join(' · ')}`}
    style={{ display:'inline-block', width:size, height:size, borderRadius:999, flexShrink:0,
      background: health === 'green' ? 'var(--green-500, #22C55E)' : 'var(--amber-500, #F59E0B)',
      boxShadow:'0 0 0 2px #fff' }} />
)

export const BoolMark = ({ on }: { on: boolean }) =>
  on
    ? <span style={{ color:'var(--green-600)', fontWeight:600 }}>✓</span>
    : <span style={{ color:'var(--slate-300)' }}>—</span>

export const Stars = ({ rating }: { rating: number }) => (
  <span style={{ color:'#F59E0B' }}>{'★'.repeat(Math.max(0, Math.round(rating)))}</span>
)

// Loading placeholder row-set shared by the shops list surfaces.
export const LoadingBlock = ({ label }: { label: string }) => (
  <div style={{ padding:'40px 0', textAlign:'center', color:'var(--slate-400)', fontSize:13 }}>Loading {label}…</div>
)
