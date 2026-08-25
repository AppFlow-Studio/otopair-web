'use client'

import { useState, useContext, useEffect } from 'react'
import QRCode from 'qrcode'
import { useQuery, useAction, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Avatar, Input, Select, Toggle } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'
import { OVERLAP_FAMILIES } from '@/convex/lib/serviceLaborReference'

type DirectorUser = {
  _id: Id<'director_users'>
  name: string
  role: string
  email?: string
  created_at: number
  last_login?: number
}

const ROLE_BADGE: Record<string, { tone: 'orange'|'blue'|'slate'; label: string }> = {
  superadmin: { tone: 'orange', label: 'Superadmin' },
  admin:      { tone: 'blue',   label: 'Admin' },
  viewer:     { tone: 'slate',  label: 'Viewer' },
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts
  const m = Math.floor(d / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const SecretReveal = ({ secret, name, email }: { secret: string; name: string; email?: string }) => {
  const [copied,   setCopied]  = useState(false)
  const [qrUrl,    setQrUrl]   = useState<string | null>(null)
  const formatted = secret.match(/.{1,4}/g)?.join(' ') ?? secret
  // Label by email when available so a re-created account produces a *distinct*
  // authenticator entry — labelling by name alone made duplicate accounts
  // indistinguishable in the user's app, which is how the old "Abubeckr" lingered.
  const account   = email ?? name
  const otpauth   = `otpauth://totp/${encodeURIComponent(`Otopair Director (${account})`)}?secret=${secret}&issuer=Otopair%20Director&algorithm=SHA1&digits=6&period=30`

  useEffect(() => {
    QRCode.toDataURL(otpauth, { width: 200, margin: 2, color: { dark: '#0F172A', light: '#FFFFFF' } })
      .then(setQrUrl)
      .catch(() => setQrUrl(null))
  }, [otpauth])

  const copy = () => {
    navigator.clipboard.writeText(secret)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={{ marginTop: 16, padding: 16, background: 'var(--blue-50)', border: '1px solid var(--blue-200)', borderRadius: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--blue-700)', marginBottom: 12 }}>
        New TOTP secret — save this now, it won't be shown again.
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* QR code */}
        <div style={{ flexShrink: 0 }}>
          {qrUrl
            ? <img src={qrUrl} alt="TOTP QR code" width={160} height={160}
                style={{ borderRadius: 8, border: '1px solid var(--blue-100)', display: 'block' }} />
            : <div style={{ width: 160, height: 160, borderRadius: 8, background: '#fff',
                border: '1px solid var(--blue-100)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 12, color: 'var(--slate-400)' }}>Generating…</div>
          }
          <div style={{ fontSize: 10, color: 'var(--blue-600)', marginTop: 6, textAlign: 'center' }}>
            Scan with your authenticator
          </div>
        </div>
        {/* Secret key + actions */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Or enter manually
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 700, letterSpacing: 3, color: 'var(--slate-900)',
            background: '#fff', border: '1px solid var(--blue-100)', borderRadius: 8, padding: '10px 12px',
            marginBottom: 10, wordBreak: 'break-all', lineHeight: 1.6 }}>
            {formatted}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" onClick={copy}>{copied ? '✓ Copied' : 'Copy key'}</Button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--blue-600)' }}>
            Account: <code>Otopair Director ({account})</code>
          </div>
        </div>
      </div>
    </div>
  )
}

const AddUserModal = ({ onClose, actorName, actorId }: { onClose: () => void; actorName: string; actorId: Id<'director_users'> | undefined }) => {
  const addUser = useAction(api.director_auth.addUser)
  const [name,   setName]   = useState('')
  const [email,  setEmail]  = useState('')
  const [role,   setRole]   = useState<'super_admin'|'ops_admin'|'support'|'readonly'|'data_admin'|'shop_success'>('ops_admin')
  const [secret, setSecret] = useState<{ text: string; forName: string; email: string } | null>(null)
  const [error,  setError]  = useState('')
  const [nameWarn, setNameWarn] = useState<{ existingEmail?: string } | null>(null)
  const [busy,   setBusy]   = useState(false)

  const handleCreate = async (force = false) => {
    const trimEmail = email.trim().toLowerCase()
    if (!name.trim()) { setError('Name is required.'); return }
    if (!trimEmail || !trimEmail.includes('@')) { setError('A valid email address is required.'); return }
    setError(''); setNameWarn(null)
    setBusy(true)
    const res = await addUser({ name: name.trim(), email: trimEmail, role, actorName, actorId, force })
    setBusy(false)
    if (!res.ok) {
      if (res.reason === 'email_taken') {
        setError('An account with that email already exists.')
      } else if (res.reason === 'name_exists') {
        setNameWarn({ existingEmail: res.existingEmail })
      }
      return
    }
    setSecret({ text: res.totp_secret, forName: name.trim(), email: trimEmail })
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 480,
        padding: 24, boxShadow: '0 20px 50px rgba(15,23,42,0.25)' }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 18 }}>Add director account</div>

        {!secret ? (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-600)', display: 'block', marginBottom: 6 }}>Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Priya Singh" style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-600)', display: 'block', marginBottom: 6 }}>
                Email <span style={{ color: 'var(--red-500)' }}>*</span>
              </label>
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="name@otopair.com"
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 4 }}>
                Required — this email is used to sign in to the Director panel.
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-600)', display: 'block', marginBottom: 6 }}>Role</label>
              <Select value={role} onChange={e => setRole(e.target.value as 'super_admin'|'ops_admin'|'support'|'readonly'|'data_admin'|'shop_success')}
                options={[{ value:'super_admin', label:'Super Admin' },{ value:'ops_admin', label:'Ops Admin' },{ value:'support', label:'Support' },{ value:'readonly', label:'Read-only' },{ value:'data_admin', label:'Data Admin' },{ value:'shop_success', label:'Shop Success' }]}
                style={{ width: '100%' }} />
            </div>
            {error && (
              <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--red-600)', fontWeight: 500 }}>{error}</div>
            )}
            {nameWarn && (
              <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--amber-50, #fffbeb)',
                border: '1px solid var(--amber-200, #fde68a)', borderRadius: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--amber-700, #b45309)', fontWeight: 600 }}>
                  An account named “{name.trim()}” already exists{nameWarn.existingEmail ? ` (${nameWarn.existingEmail})` : ''}.
                </div>
                <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 4 }}>
                  Re-creating a person instead of editing the existing account orphans their 2FA.
                  Edit that account from the list, or continue only if this is genuinely a different person.
                </div>
                <div style={{ marginTop: 8 }}>
                  <Button size="sm" variant="primary" onClick={() => handleCreate(true)} disabled={busy}>
                    {busy ? 'Creating…' : 'Create anyway'}
                  </Button>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={() => handleCreate()} disabled={busy || !name.trim() || !email.trim()}>
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: 'var(--green-700)', fontWeight: 500, marginBottom: 4 }}>
              ✓ Account created for {secret.forName}
            </div>
            <SecretReveal secret={secret.text} name={secret.forName} email={secret.email} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
              <Button variant="primary" onClick={onClose}>Done</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Inline email editor for an existing user row. */
const SetEmailInline = ({ user, actorName, actorId, onDone }: {
  user: DirectorUser; actorName: string; actorId: Id<'director_users'> | undefined; onDone: () => void
}) => {
  const setUserEmail = useMutation(api.director_auth.setUserEmail)
  const [val,  setVal]  = useState(user.email ?? '')
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState('')

  const save = async () => {
    const trimmed = val.trim().toLowerCase()
    if (!trimmed || !trimmed.includes('@')) { setErr('Enter a valid email.'); return }
    setBusy(true); setErr('')
    const res = await setUserEmail({ id: user._id, email: trimmed, actorName, actorId })
    setBusy(false)
    if (res && !res.ok) {
      setErr(res.reason === 'email_taken' ? 'That email is already used by another account.' : 'Error saving email.')
    } else {
      onDone()
    }
  }

  return (
    <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
      <Input
        type="email"
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder="email@otopair.com"
        style={{ flex: 1, fontSize: 13 }}
        disabled={busy}
      />
      <Button size="sm" variant="primary" onClick={save} disabled={busy}>{busy ? '…' : 'Save'}</Button>
      <Button size="sm" onClick={onDone}>Cancel</Button>
      {err && <span style={{ fontSize: 12, color: 'var(--red-600)' }}>{err}</span>}
    </div>
  )
}

const UserRow = ({ user, isSelf, actorName, actorId, canRemove, canRegen, canEditEmail }: {
  user: DirectorUser; isSelf: boolean; actorName: string; actorId: Id<'director_users'> | undefined
  canRemove: boolean
  canRegen: boolean
  canEditEmail: boolean
}) => {
  const removeUser       = useMutation(api.director_auth.removeUser)
  const regenerateSecret = useAction(api.director_auth.regenerateSecret)
  const [newSecret,   setNewSecret]   = useState<string | null>(null)
  const [confirming,  setConfirming]  = useState(false)
  const [editEmail,   setEditEmail]   = useState(false)
  const [busy,        setBusy]        = useState(false)
  const rb = ROLE_BADGE[user.role] ?? { tone: 'slate' as const, label: user.role }

  const handleRegen = async () => {
    setBusy(true)
    const res = await regenerateSecret({ id: user._id, actorName, actorId })
    setBusy(false)
    setNewSecret(res.totp_secret)
  }

  const handleRemove = async () => {
    setBusy(true)
    await removeUser({ id: user._id, actorName, actorId })
    setBusy(false)
    setConfirming(false)
  }

  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-100)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar name={user.name} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--slate-900)' }}>{user.name}</span>
            <Badge tone={rb.tone}>{rb.label}</Badge>
            {isSelf && <Badge tone="green">You</Badge>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
            {user.last_login ? `Last login ${timeAgo(user.last_login)}` : 'Never logged in'} · Added {timeAgo(user.created_at)}
          </div>
          {/* Email row */}
          {user.email ? (
            <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 3 }}>
              {user.email}
            </div>
          ) : (
            <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--red-500)', fontWeight: 500 }}>⚠ No email — cannot sign in</span>
              {canEditEmail && !editEmail && (
                <button onClick={() => setEditEmail(true)}
                  style={{ fontSize: 11, color: 'var(--blue-500)', background: 'none', border: 'none',
                    cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                  set email
                </button>
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {canRegen && (
            <Button size="sm" onClick={handleRegen} disabled={busy}>{busy ? '…' : 'Regen secret'}</Button>
          )}
          {canRemove && !confirming && (
            <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>Remove</Button>
          )}
          {canRemove && confirming && (
            <>
              <Button size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
              <Button size="sm" variant="danger" onClick={handleRemove} disabled={busy}>Confirm remove</Button>
            </>
          )}
        </div>
      </div>
      {editEmail && (
        <SetEmailInline user={user} actorName={actorName} actorId={actorId} onDone={() => setEditEmail(false)} />
      )}
      {newSecret && <SecretReveal secret={newSecret} name={user.name} email={user.email} />}
    </div>
  )
}

const NumField = ({ label, hint, value, onChange, disabled }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void; disabled?: boolean
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-600)' }}>{label}</label>
    <Input
      value={value}
      onChange={e => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      disabled={disabled}
      style={{ width: 110 }}
    />
    {hint && <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>{hint}</span>}
  </div>
)

const BookingExpirySettings = ({ isSuperadmin, actorName, actorId }: {
  isSuperadmin: boolean; actorName: string; actorId: Id<'director_users'> | undefined
}) => {
  const cfg        = useQuery(api.directorSettings.getGlobal)
  const status     = useQuery(api.bookings.unconfirmedExpiryStatus)
  const saveConfig = useMutation(api.directorSettings.setBookingExpiryConfig)
  const runCleanup = useMutation(api.bookings.runUnconfirmedBacklogCleanup)

  const [enabled, setEnabled] = useState(true)
  const [f, setF]             = useState({ rw: '', grace: '', r1: '', r2: '', silent: '' })
  const [loaded, setLoaded]   = useState(false)
  const [saving, setSaving]   = useState(false)
  const [msg, setMsg]         = useState('')
  const [preview, setPreview] = useState<number | null>(null)
  const [cleanupMsg, setCleanupMsg] = useState('')
  const [busy, setBusy]       = useState(false)

  useEffect(() => {
    if (cfg && !loaded) {
      setEnabled(cfg.unconfirmed_expiry_enabled)
      setF({
        rw:     String(cfg.unconfirmed_response_window_hours),
        grace:  String(cfg.unconfirmed_post_time_grace_minutes),
        r1:     String(cfg.unconfirmed_reminder1_before_hours),
        r2:     String(cfg.unconfirmed_reminder2_before_hours),
        silent: String(cfg.unconfirmed_silent_if_past_deadline_hours),
      })
      setLoaded(true)
    }
  }, [cfg, loaded])

  const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : undefined }

  const onSave = async () => {
    if (!isSuperadmin) return
    setSaving(true); setMsg('')
    try {
      await saveConfig({
        enabled,
        responseWindowHours: num(f.rw),
        postTimeGraceMinutes: num(f.grace),
        reminder1BeforeHours: num(f.r1),
        reminder2BeforeHours: num(f.r2),
        silentIfPastDeadlineHours: num(f.silent),
        actorName, actorId,
      })
      setMsg('Saved ✓')
    } catch {
      setMsg('Save failed')
    }
    setSaving(false)
  }

  const onPreview = async () => {
    if (!isSuperadmin) return
    setBusy(true); setCleanupMsg('')
    try {
      const r: any = await runCleanup({ dryRun: true, actorName, actorId })
      setPreview(r?.wouldCancel ?? 0)
    } catch { setCleanupMsg('Preview failed') }
    setBusy(false)
  }

  const onConfirm = async () => {
    if (!isSuperadmin) return
    setBusy(true)
    try {
      const r: any = await runCleanup({ dryRun: false, actorName, actorId })
      setCleanupMsg(`Silently cancelled ${r?.cancelled ?? 0} request(s).`)
      setPreview(null)
    } catch { setCleanupMsg('Cleanup failed') }
    setBusy(false)
  }

  return (
    <Card padded={false} style={{ marginBottom: 24 }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-200)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Unanswered booking requests</div>
          <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
            Auto-cancel requests a shop never confirms. Cancels at the earlier of the response window or the grace period past the requested time, after nudging the shop.
          </div>
        </div>
        {status && (
          <Badge tone={status.pastDeadline > 0 ? 'orange' : 'slate'}>
            {status.pending} pending · {status.pastDeadline} past deadline
          </Badge>
        )}
      </div>

      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-100)' }}>
        <Toggle
          checked={enabled}
          onChange={e => { if (isSuperadmin) setEnabled(e.target.checked) }}
          label="Auto-cancel unanswered requests"
        />
      </div>

      <div style={{ padding: '16px 18px', display: 'flex', flexWrap: 'wrap', gap: 20 }}>
        <NumField label="Response window" hint="hours after request" value={f.rw} onChange={v => setF(s => ({ ...s, rw: v }))} disabled={!isSuperadmin || !enabled} />
        <NumField label="Grace past appt time" hint="minutes" value={f.grace} onChange={v => setF(s => ({ ...s, grace: v }))} disabled={!isSuperadmin || !enabled} />
        <NumField label="First reminder" hint="hours before deadline (0 = off)" value={f.r1} onChange={v => setF(s => ({ ...s, r1: v }))} disabled={!isSuperadmin || !enabled} />
        <NumField label="Final reminder" hint="hours before deadline (0 = off)" value={f.r2} onChange={v => setF(s => ({ ...s, r2: v }))} disabled={!isSuperadmin || !enabled} />
        <NumField label="Silent-cancel cutoff" hint="hours past deadline → no notice" value={f.silent} onChange={v => setF(s => ({ ...s, silent: v }))} disabled={!isSuperadmin} />
      </div>

      <div style={{ padding: '0 18px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button variant="primary" onClick={onSave} disabled={!isSuperadmin || saving || !loaded}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
        {msg && <span style={{ fontSize: 12, color: msg.includes('fail') ? 'var(--red-600)' : 'var(--green-700)' }}>{msg}</span>}
        {!isSuperadmin && <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>Read-only — superadmin required.</span>}
      </div>

      <div style={{ padding: '14px 18px', borderTop: '1px solid var(--slate-100)', background: 'var(--slate-25, #fafbfc)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-700)' }}>Clear the backlog now</div>
        <div style={{ fontSize: 12, color: 'var(--slate-500)', margin: '2px 0 10px' }}>
          Silently cancels requests already well past their deadline (no customer notices). The cron does this automatically; use this to run it immediately.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Button size="sm" onClick={onPreview} disabled={!isSuperadmin || busy}>Preview</Button>
          {preview !== null && (
            <>
              <span style={{ fontSize: 13, color: 'var(--slate-700)' }}>
                {preview} request(s) will be silently cancelled.
              </span>
              {preview > 0 && (
                <Button size="sm" variant="danger" onClick={onConfirm} disabled={busy}>
                  {busy ? 'Working…' : `Cancel ${preview} now`}
                </Button>
              )}
            </>
          )}
          {cleanupMsg && <span style={{ fontSize: 12, color: cleanupMsg.includes('fail') ? 'var(--red-600)' : 'var(--green-700)' }}>{cleanupMsg}</span>}
        </div>
      </div>
    </Card>
  )
}

// Outer Vehicle Health Score formula (Upkeep vs. Warning Lights, plus the
// Open-recs cap). Bigger blast radius than every other tunable on this page
// — it reshapes every vehicle's score the instant it's saved — so it's the
// one editor here with an explicit confirm step, mirroring
// convex/healthScoreWeights.ts's own confirmation gate.
const HealthScoreWeightsSettings = ({ isSuperadmin, actorName, actorId }: {
  isSuperadmin: boolean; actorName: string; actorId: Id<'director_users'> | undefined
}) => {
  const weights   = useQuery(api.healthScoreWeights.getWeights)
  const setWeights = useMutation(api.healthScoreWeights.setWeights)
  const [upkeep, setUpkeep]   = useState('')
  const [openCap, setOpenCap] = useState('')
  const [loaded, setLoaded]   = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [msg, setMsg]         = useState('')

  useEffect(() => {
    if (weights && !loaded) {
      setUpkeep(String(weights.upkeepWeight))
      setOpenCap(String(weights.openIssuePenaltyMax))
      setLoaded(true)
    }
  }, [weights, loaded])

  const upkeepNum = Number(upkeep)
  const validUpkeep = Number.isFinite(upkeepNum) && upkeepNum >= 0 && upkeepNum <= 100

  const onSave = async () => {
    if (!isSuperadmin || !validUpkeep) return
    setSaving(true); setMsg('')
    try {
      await setWeights({
        upkeepWeight: upkeepNum,
        openIssuePenaltyMax: Number(openCap) || 0,
        confirmed: true,
        actorName, actorId,
      })
      setMsg('Saved ✓')
      setConfirming(false)
    } catch {
      setMsg('Save failed')
    }
    setSaving(false)
  }

  return (
    <Card padded={false} style={{ marginBottom: 24 }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-200)' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Vehicle Health Score weights</div>
        <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
          Upkeep vs. Warning Lights split (must sum to 100 — Warning Lights is
          computed as the remainder) plus the Open-recommendations penalty
          cap. Applies to every vehicle's score instantly.
        </div>
      </div>
      <div style={{ padding: '16px 18px', display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-end' }}>
        <NumField label="Upkeep weight" hint={`Warning Lights = ${100 - (validUpkeep ? upkeepNum : weights?.upkeepWeight ?? 85)}`} value={upkeep} onChange={setUpkeep} disabled={!isSuperadmin} />
        <NumField label="Open-recs penalty cap" hint="max points subtracted" value={openCap} onChange={setOpenCap} disabled={!isSuperadmin} />
      </div>
      <div style={{ padding: '0 18px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        {!confirming ? (
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={!isSuperadmin || !loaded || !validUpkeep}>
            Change weights
          </Button>
        ) : (
          <>
            <span style={{ fontSize: 12, color: 'var(--slate-700)' }}>
              Confirm: apply to every vehicle's score now?
            </span>
            <Button size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="sm" variant="danger" onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Confirm & save'}
            </Button>
          </>
        )}
        {msg && <span style={{ fontSize: 12, color: msg.includes('fail') ? 'var(--red-600)' : 'var(--green-700)' }}>{msg}</span>}
        {!isSuperadmin && <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>Read-only — superadmin required.</span>}
      </div>
    </Card>
  )
}

const URGENCY_OPTIONS = [
  { value: 'soon', label: 'Soon' },
  { value: 'within_3_months', label: 'Within 3 months' },
  { value: 'next_visit', label: 'Next visit' },
]

type InspectionHealthConfigRow = {
  _id: Id<'inspection_health_config'>
  field_key: string
  maps_to?: string
  rec_service_slug?: string
  rec_urgency?: string
  rec_copy?: string
}

const InspectionHealthConfigEditorRow = ({ row, isSuperadmin, actorName, actorId }: {
  row: InspectionHealthConfigRow; isSuperadmin: boolean
  actorName: string; actorId: Id<'director_users'> | undefined
}) => {
  const setRow = useMutation(api.inspectionHealthConfig.setRow)
  const [copy, setCopy]       = useState(row.rec_copy ?? '')
  const [urgency, setUrgency] = useState(row.rec_urgency ?? 'within_3_months')
  const [slug, setSlug]       = useState(row.rec_service_slug ?? '')
  const [dirty, setDirty]     = useState(false)
  const [saving, setSaving]   = useState(false)

  const onSave = async () => {
    setSaving(true)
    try {
      await setRow({
        fieldKey: row.field_key,
        mapsTo: row.maps_to,
        recServiceSlug: slug || undefined,
        recUrgency: urgency || undefined,
        recCopy: copy || undefined,
        actorName, actorId,
      })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', borderBottom: '1px solid var(--slate-100)' }}>
      <div style={{ width: 140, flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-900)' }}>{row.field_key}</div>
        <Badge tone={row.maps_to === 'freeform' ? 'slate' : row.maps_to === 'minor' ? 'blue' : 'orange'}>
          {row.maps_to ?? 'unmapped'}
        </Badge>
      </div>
      <Input
        value={copy}
        onChange={e => { setCopy(e.target.value); setDirty(true) }}
        placeholder="Recommendation copy"
        disabled={!isSuperadmin}
        style={{ flex: 1, fontSize: 13 }}
      />
      <Select
        value={urgency}
        onChange={e => { setUrgency(e.target.value); setDirty(true) }}
        options={URGENCY_OPTIONS}
        style={{ width: 160 }}
      />
      <Input
        value={slug}
        onChange={e => { setSlug(e.target.value); setDirty(true) }}
        placeholder="catalog slug (blank = freeform)"
        disabled={!isSuperadmin}
        style={{ width: 200, fontSize: 13 }}
      />
      <Button size="sm" variant="primary" onClick={onSave} disabled={!isSuperadmin || !dirty || saving} style={{ flexShrink: 0 }}>
        {saving ? '…' : 'Save'}
      </Button>
    </div>
  )
}

// Per-inspection-field severity/recommendation tuning (see
// convex/seed_inspection_health.ts for the default rows). Lower stakes than
// the score-weights editor above — only shapes future findings' copy/urgency
// — so no confirmation gate, just the standard audit-logged save.
const InspectionHealthConfigSettings = ({ isSuperadmin, actorName, actorId }: {
  isSuperadmin: boolean; actorName: string; actorId: Id<'director_users'> | undefined
}) => {
  const rows = useQuery(api.inspectionHealthConfig.list)

  return (
    <Card padded={false} style={{ marginBottom: 24 }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-200)' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Inspection health weights</div>
        <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
          Per-field recommendation copy, urgency, and catalog mapping shown
          when a mechanic's inspection finding is confirmed. Orange = feeds a
          core score tile, blue = Consolidated minor item, slate = freeform
          (never scores).
        </div>
      </div>
      {rows === undefined ? (
        <div style={{ padding: '24px 18px', fontSize: 13, color: 'var(--slate-400)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '24px 18px', fontSize: 13, color: 'var(--slate-400)' }}>
          No config seeded yet — run seed_inspection_health:seedInspectionHealth.
        </div>
      ) : (
        rows.map((row: InspectionHealthConfigRow) => (
          <InspectionHealthConfigEditorRow
            key={String(row._id)}
            row={row}
            isSuperadmin={isSuperadmin}
            actorName={actorName}
            actorId={actorId}
          />
        ))
      )}
    </Card>
  )
}

function CombinedLaborSettings({
  isSuperadmin,
  actorName,
  actorId,
}: {
  isSuperadmin: boolean
  actorName: string
  actorId?: Id<'director_users'>
}) {
  const cfg = useQuery(api.directorSettings.getGlobal)
  const save = useMutation(api.directorSettings.setCombinedLaborConfig)

  const enabled = cfg?.combined_labor_enabled ?? false
  const disabled = new Set<string>(cfg?.combined_labor_disabled_families ?? [])

  const toggleFamily = (id: string, on: boolean) => {
    if (!isSuperadmin) return
    const next = new Set(disabled)
    if (on) next.delete(id)
    else next.add(id)
    save({ disabledFamilies: Array.from(next), actorName, actorId })
  }

  return (
    <Card padded={false} style={{ marginBottom: 24 }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-200)' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Combined labor operations</div>
        <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
          When two booked services share the same teardown, charge that labor once instead of twice
          — the honest way multi-service jobs are quoted (Mitchell1 / ALLDATA combined operations).
          Off by default; enabling it lowers labor on qualifying multi-service bookings.
        </div>
      </div>
      <div style={{ padding: '14px 18px' }}>
        <Toggle
          checked={enabled}
          onChange={e => {
            if (!isSuperadmin) return
            save({ enabled: e.target.checked, actorName, actorId })
          }}
          label="Enable combined labor deduction"
        />
        {!isSuperadmin && (
          <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 6 }}>
            Read-only — contact a superadmin to change this setting.
          </div>
        )}

        <div style={{ marginTop: 16, opacity: enabled ? 1 : 0.5, pointerEvents: enabled ? 'auto' : 'none' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-600)', marginBottom: 8 }}>
            Overlap rules {enabled ? '' : '(enable to configure)'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {OVERLAP_FAMILIES.map(fam => (
              <div
                key={fam.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 16,
                  padding: '10px 12px',
                  border: '1px solid var(--slate-200)',
                  borderRadius: 8,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{fam.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
                    {fam.description}
                  </div>
                </div>
                <Toggle
                  checked={!disabled.has(fam.id)}
                  onChange={e => toggleFamily(fam.id, e.target.checked)}
                  label=""
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  )
}

export const TabSettings = () => {
  const session   = useContext(DirectorSessionCtx)
  const users     = useQuery(api.director_auth.listUsers)
  const globalSettings = useQuery(api.directorSettings.getGlobal)
  const setRoundLaborTo15 = useMutation(api.directorSettings.setRoundLaborTo15)
  const [addOpen, setAddOpen] = useState(false)

  const role         = session?.role ?? 'viewer'
  const isSuperadmin = role === 'super_admin'
  const actorName    = session?.name ?? 'Director'
  const actorId      = session?.userId as Id<'director_users'> | undefined

  return (
    <SectionAnchor id="settings" title="Settings"
      subtitle={isSuperadmin ? 'Director access and account management. All actions are audit logged.' : 'You have read-only access to this page.'}>
      <Card padded={false} style={{ marginBottom: 24 }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-200)' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Labor time rounding</div>
          <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
            Round each labor-time estimate UP to the nearest 15 minutes (e.g. 36 min → 45 min). Applies everywhere the booking flow shows or stores duration.
          </div>
        </div>
        <div style={{ padding: '14px 18px' }}>
          <Toggle
            checked={globalSettings?.round_labor_times_to_15min ?? true}
            onChange={e => {
              if (!isSuperadmin) return
              setRoundLaborTo15({ value: e.target.checked, actorName, actorId })
            }}
            label="Round to 15-minute slots"
          />
          {!isSuperadmin && (
            <div style={{ fontSize: 11, color: 'var(--slate-400)', marginTop: 6 }}>
              Read-only — contact a superadmin to change this setting.
            </div>
          )}
        </div>
      </Card>

      <CombinedLaborSettings isSuperadmin={isSuperadmin} actorName={actorName} actorId={actorId} />

      <BookingExpirySettings isSuperadmin={isSuperadmin} actorName={actorName} actorId={actorId} />

      <HealthScoreWeightsSettings isSuperadmin={isSuperadmin} actorName={actorName} actorId={actorId} />
      <InspectionHealthConfigSettings isSuperadmin={isSuperadmin} actorName={actorName} actorId={actorId} />

      <Card padded={false} style={{ marginBottom: 24 }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-200)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Director accounts</div>
            <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
              {isSuperadmin
                ? 'Each account has its own email + TOTP 2FA. Email is required to sign in.'
                : 'Read-only — contact a superadmin to make changes.'}
            </div>
          </div>
          {isSuperadmin && <Button variant="primary" onClick={() => setAddOpen(true)}>+ Add account</Button>}
        </div>
        {users === undefined ? (
          <div style={{ padding: '24px 18px', fontSize: 13, color: 'var(--slate-400)' }}>Loading…</div>
        ) : users.length === 0 ? (
          <div style={{ padding: '24px 18px', fontSize: 13, color: 'var(--slate-400)' }}>No director accounts yet.</div>
        ) : (
          users.map((u: DirectorUser) => {
            const isSelf = session?.userId === String(u._id)
            return (
              <UserRow
                key={String(u._id)}
                user={u}
                isSelf={isSelf}
                actorName={actorName}
                actorId={actorId}
                canRemove={isSuperadmin && !isSelf && u.role !== 'super_admin'}
                canRegen={isSuperadmin && !isSelf}
                canEditEmail={isSuperadmin}
              />
            )
          })
        )}
      </Card>

      {addOpen && <AddUserModal onClose={() => setAddOpen(false)} actorName={actorName} actorId={actorId} />}
    </SectionAnchor>
  )
}
