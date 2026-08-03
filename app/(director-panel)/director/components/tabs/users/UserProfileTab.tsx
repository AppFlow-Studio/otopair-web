'use client'

import { useContext } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { DirectorSessionCtx } from '../../DirectorSessionCtx'
import { Card } from '../../Primitives'
import { Field, H2, Loading, fmtDate, fmtDateTime, providerLabel, sourceLabel } from './usersUi'

export const UserProfileTab = ({ userId }: { userId: Id<'users'> }) => {
  const session = useContext(DirectorSessionCtx)
  const profile = useQuery(api.opsUsers.profile, { token: session?.token ?? '', id: userId })

  if (profile === undefined) return <Loading label="profile" />
  if (profile === null) return <Loading label="profile" />

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, alignItems:'start' }}>
      <Card>
        <H2>Identity</H2>
        <div style={{ marginTop:14, display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          <Field label="First name" value={profile.firstName ?? '—'} />
          <Field label="Last name" value={profile.lastName ?? '—'} />
          <Field label="Email" value={profile.email ?? '—'} />
          <Field label="Phone" value={profile.phone ?? '—'} />
          <Field label="Auth provider" value={providerLabel(profile.authProvider)} />
          <Field label="Acquisition source" value={sourceLabel(profile.acquisitionSource)} />
          <Field label="Role" value={profile.role} />
          <Field label="Language" value={profile.language ?? '—'} />
          <Field label="Units" value={profile.units ?? '—'} />
          <Field label="Created" value={fmtDate(profile.created)} />
          <Field label="Last active" value={fmtDate(profile.lastUpdated)} />
          {profile.walkInClaimedAt != null && <Field label="Walk-in claimed" value={fmtDate(profile.walkInClaimedAt)} />}
          <Field label="Clerk ID" value={profile.clerkUserId} mono />
          <Field label="Stripe customer" value={profile.stripeCustomerId ?? '—'} mono />
        </div>
      </Card>

      <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
        <Card>
          <H2>Onboarding</H2>
          <div style={{ marginTop:14, display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:14 }}>
            <Field label="Essential" value={profile.essentialOnboardingCompleted ? 'Done' : 'Not done'} />
            <Field label="Tell-us-about" value={profile.tellUsAboutCompleted ? 'Done' : 'Not done'} />
            <Field label="Overall" value={profile.onboardingCompleted ? 'Completed' : 'In progress'} />
          </div>
        </Card>

        {profile.isPendingDeletion ? (
          <div style={{ borderRadius:10, border:'1px solid #FECACA', background:'var(--red-50)', padding:20 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--red-800, #991B1B)' }}>Deletion requested</div>
            <div style={{ marginTop:14, display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              <Field label="Requested" value={fmtDateTime(profile.deletionRequestedAt)} />
              <Field label="Survey response" value={profile.deletionSurveySkipped ? 'Skipped' : profile.deletionSurveyResponse ?? '—'} />
            </div>
            <p style={{ margin:'12px 0 0', fontSize:12, color:'var(--red-700)' }}>Processing and restore happen on the Deletion Queue.</p>
          </div>
        ) : (
          <Card>
            <H2>Deletion state</H2>
            <p style={{ margin:'8px 0 0', fontSize:13, color:'var(--slate-500)' }}>No deletion request on file.</p>
          </Card>
        )}
      </div>
    </div>
  )
}
