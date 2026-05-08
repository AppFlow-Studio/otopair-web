'use client'

import { useState, useContext, useEffect } from 'react'
import QRCode from 'qrcode'
import { useQuery, useAction, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Badge, Button, Card, Avatar, Input, Select } from '../Primitives'
import { SectionAnchor } from '../Shell'
import { DirectorSessionCtx } from '../DirectorSessionCtx'

type DirectorUser = {
  _id: Id<'director_users'>
  name: string
  role: string
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

const SecretReveal = ({ secret, name }: { secret: string; name: string }) => {
  const [copied,   setCopied]  = useState(false)
  const [qrUrl,    setQrUrl]   = useState<string | null>(null)
  const formatted = secret.match(/.{1,4}/g)?.join(' ') ?? secret
  const otpauth   = `otpauth://totp/Otopair%20Director:${encodeURIComponent(name)}?secret=${secret}&issuer=Otopair%20Director`

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
            Account: <code>Otopair Director: {name}</code>
          </div>
        </div>
      </div>
    </div>
  )
}

const AddUserModal = ({ onClose, actorName, actorId }: { onClose: () => void; actorName: string; actorId: Id<'director_users'> | undefined }) => {
  const addUser = useAction(api.director_auth.addUser)
  const [name,   setName]   = useState('')
  const [role,   setRole]   = useState<'superadmin'|'admin'|'viewer'>('admin')
  const [secret, setSecret] = useState<{ text: string; forName: string } | null>(null)
  const [busy,   setBusy]   = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) return
    setBusy(true)
    const res = await addUser({ name: name.trim(), role, actorName, actorId })
    setBusy(false)
    setSecret({ text: res.totp_secret, forName: name.trim() })
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
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate-600)', display: 'block', marginBottom: 6 }}>Role</label>
              <Select value={role} onChange={e => setRole(e.target.value as 'superadmin'|'admin'|'viewer')}
                options={[{ value:'superadmin', label:'Superadmin' },{ value:'admin', label:'Admin' },{ value:'viewer', label:'Viewer' }]}
                style={{ width: '100%' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={handleCreate} disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: 'var(--green-700)', fontWeight: 500, marginBottom: 4 }}>
              ✓ Account created for {secret.forName}
            </div>
            <SecretReveal secret={secret.text} name={secret.forName} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
              <Button variant="primary" onClick={onClose}>Done</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const UserRow = ({ user, isSelf, actorName, actorId, canRemove, canRegen }: {
  user: DirectorUser; isSelf: boolean; actorName: string; actorId: Id<'director_users'> | undefined
  canRemove: boolean   // superadmin → non-superadmin targets only
  canRegen: boolean    // superadmin → any non-self target
}) => {
  const removeUser       = useMutation(api.director_auth.removeUser)
  const regenerateSecret = useAction(api.director_auth.regenerateSecret)
  const [newSecret,   setNewSecret]   = useState<string | null>(null)
  const [confirming,  setConfirming]  = useState(false)
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
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--slate-900)' }}>{user.name}</span>
            <Badge tone={rb.tone}>{rb.label}</Badge>
            {isSelf && <Badge tone="green">You</Badge>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
            {user.last_login ? `Last login ${timeAgo(user.last_login)}` : 'Never logged in'} · Added {timeAgo(user.created_at)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
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
      {newSecret && <SecretReveal secret={newSecret} name={user.name} />}
    </div>
  )
}

export const TabSettings = () => {
  const session   = useContext(DirectorSessionCtx)
  const users     = useQuery(api.director_auth.listUsers)
  const [addOpen, setAddOpen] = useState(false)

  const role        = session?.role ?? 'viewer'
  const isSuperadmin = role === 'superadmin'
  const actorName   = session?.name ?? 'Director'
  const actorId     = session?.userId as Id<'director_users'> | undefined

  return (
    <SectionAnchor id="settings" title="Settings"
      subtitle={isSuperadmin ? 'Director access and account management. All actions are audit logged.' : 'You have read-only access to this page.'}>
      <Card padded={false} style={{ marginBottom: 24 }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--slate-200)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Director accounts</div>
            <div style={{ fontSize: 12, color: 'var(--slate-500)', marginTop: 2 }}>
              {isSuperadmin ? 'Each account has its own TOTP 2FA secret.' : 'Read-only — contact a superadmin to make changes.'}
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
                canRemove={isSuperadmin && !isSelf && u.role !== 'superadmin'}
                canRegen={isSuperadmin && !isSelf}
              />
            )
          })
        )}
      </Card>

      {addOpen && <AddUserModal onClose={() => setAddOpen(false)} actorName={actorName} actorId={actorId} />}
    </SectionAnchor>
  )
}
