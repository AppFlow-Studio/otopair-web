'use client'

import { useState, useRef, useEffect } from 'react'
import { useQuery, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { Avatar } from './Primitives'

type DirectorUser = {
  _id: Id<'director_users'>
  name: string
  role: string
}

type Phase =
  | { id: 'loading' }
  | { id: 'no_accounts' }
  | { id: 'select' }
  | { id: 'code'; user: DirectorUser }

const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  viewer: 'Viewer',
}

export const DirectorLogin = ({ onLogin }: {
  onLogin: (token: string, user: { name: string; role: string; userId: string }) => void
}) => {
  const users          = useQuery(api.director_auth.listUsers)
  const verifyAndLogin = useAction(api.director_auth.verifyAndLogin)

  const [phase, setPhase] = useState<Phase>({ id: 'loading' })
  const [code,  setCode]  = useState('')
  const [error, setError] = useState('')
  const [busy,  setBusy]  = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (users === undefined) return
    if (phase.id === 'loading') {
      setPhase(users.length === 0 ? { id: 'no_accounts' } : { id: 'select' })
    }
  }, [users])

  useEffect(() => {
    if (phase.id === 'code') {
      setCode(''); setError('')
      setTimeout(() => codeRef.current?.focus(), 60)
    }
  }, [phase.id])

  const handleCodeChange = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 6)
    setCode(d)
    if (d.length === 6) submitCode(d)
  }

  const submitCode = async (digits: string) => {
    if (phase.id !== 'code') return
    setBusy(true); setError('')
    const res = await verifyAndLogin({ userId: phase.user._id, code: digits })
    setBusy(false)
    if (res.success) {
      onLogin(res.token, { name: phase.user.name, role: phase.user.role, userId: String(phase.user._id) })
    } else {
      setError(res.error ?? 'Invalid code'); setCode('')
      setTimeout(() => codeRef.current?.focus(), 60)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--slate-950, #020617)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ width: 420, background: '#fff', borderRadius: 16,
        boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '26px 28px 20px', borderBottom: '1px solid var(--slate-100)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <span style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--blue-600)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 17 }}>O</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--slate-900)' }}>Otopair Director</div>
              <div style={{ fontSize: 11, color: 'var(--slate-500)' }}>Internal control plane</div>
            </div>
          </div>

          {phase.id === 'loading'     && <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--slate-900)' }}>Loading…</div>}
          {phase.id === 'no_accounts' && (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--slate-900)' }}>Not configured</div>
              <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 4 }}>No director accounts exist yet.</div>
            </>
          )}
          {phase.id === 'select' && (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--slate-900)' }}>Sign in</div>
              <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 4 }}>Select your account to continue.</div>
            </>
          )}
          {phase.id === 'code' && (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--slate-900)' }}>Welcome, {phase.user.name}</div>
              <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 4 }}>Enter the 6-digit code from your authenticator app.</div>
            </>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '22px 28px 28px' }}>

          {phase.id === 'loading' && (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--slate-400)', fontSize: 13 }}>Loading…</div>
          )}

          {/* ── No accounts ── */}
          {phase.id === 'no_accounts' && (
            <div style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.7 }}>
              Contact your administrator to set up director access.
              <br /><br />
              <span style={{ color: 'var(--slate-400)', fontSize: 12 }}>
                Administrators: run <code style={{ background: 'var(--slate-100)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>director_auth.bootstrap</code> in the Convex dashboard to create the first account.
              </span>
            </div>
          )}

          {/* ── User grid ── */}
          {phase.id === 'select' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {(users ?? []).map((u: DirectorUser) => (
                <button key={String(u._id)} onClick={() => setPhase({ id: 'code', user: u })}
                  style={{ background: 'var(--slate-50)', border: '1px solid var(--slate-200)', borderRadius: 10,
                    padding: '14px 10px', cursor: 'pointer', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: 8, fontFamily: 'inherit', transition: 'border-color 120ms, background 120ms' }}
                  onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--blue-400)'; el.style.background = 'var(--blue-50)' }}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--slate-200)'; el.style.background = 'var(--slate-50)' }}>
                  <Avatar name={u.name} size={36} />
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-800)', textAlign: 'center', lineHeight: 1.3 }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--slate-500)' }}>{ROLE_LABEL[u.role] ?? u.role}</div>
                </button>
              ))}
            </div>
          )}

          {/* ── TOTP code entry ── */}
          {phase.id === 'code' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                <Avatar name={phase.user.name} size={40} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--slate-900)' }}>{phase.user.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--slate-500)' }}>{ROLE_LABEL[phase.user.role] ?? phase.user.role}</div>
                </div>
              </div>
              <input ref={codeRef} type="text" inputMode="numeric" placeholder="000000" maxLength={6}
                value={code} onChange={e => handleCodeChange(e.target.value)} disabled={busy}
                style={{ width: '100%', textAlign: 'center', fontSize: 32, fontWeight: 700, letterSpacing: 12,
                  padding: '14px 0', border: `2px solid ${error ? 'var(--red-400)' : 'var(--slate-200)'}`,
                  borderRadius: 10, outline: 'none', fontFamily: 'monospace', color: 'var(--slate-900)',
                  background: busy ? 'var(--slate-50)' : '#fff', boxSizing: 'border-box' }} />
              {error && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--red-600)', textAlign: 'center', fontWeight: 500 }}>{error}</div>}
              {busy  && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--slate-400)', textAlign: 'center' }}>Verifying…</div>}
              <button onClick={() => setPhase({ id: 'select' })}
                style={{ marginTop: 16, width: '100%', padding: '10px 0', background: 'none', border: 'none',
                  fontSize: 13, color: 'var(--slate-500)', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}>
                ← Back
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
