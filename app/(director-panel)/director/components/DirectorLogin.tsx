'use client'

import { useState, useRef, useEffect } from 'react'
import { useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'

type Phase =
  | { id: 'email' }
  | { id: 'code'; email: string }

export const DirectorLogin = ({ onLogin }: {
  onLogin: (token: string, user: { name: string; role: string; userId: string }) => void
}) => {
  const loginWithEmail = useAction(api.director_auth.loginWithEmail)

  const [phase, setPhase] = useState<Phase>({ id: 'email' })
  const [email, setEmail] = useState('')
  const [code,  setCode]  = useState('')
  const [error, setError] = useState('')
  const [busy,  setBusy]  = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)
  const codeRef  = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (phase.id === 'email') {
      setError('')
      setTimeout(() => emailRef.current?.focus(), 60)
    }
  }, [phase.id])

  useEffect(() => {
    if (phase.id === 'code') {
      setCode(''); setError('')
      setTimeout(() => codeRef.current?.focus(), 60)
    }
  }, [phase.id])

  /* ── Step 1: validate email format and advance ── */
  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || !trimmed.includes('@')) {
      setError('Enter a valid email address.')
      return
    }
    setPhase({ id: 'code', email: trimmed })
  }

  /* ── Step 2: auto-submit when 6 digits are entered ── */
  const handleCodeChange = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 6)
    setCode(d)
    if (d.length === 6) submitCode(d)
  }

  const submitCode = async (digits: string) => {
    if (phase.id !== 'code') return
    setBusy(true); setError('')
    const res = await loginWithEmail({ email: phase.email, code: digits })
    setBusy(false)
    if (res.success) {
      const { token, name, role, userId } = res as { token: string; name: string; role: string; userId: string }
      onLogin(token, { name, role, userId })
    } else {
      setError((res as any).error ?? 'Invalid email or code')
      setCode('')
      setTimeout(() => codeRef.current?.focus(), 60)
    }
  }

  /* ── Shared card shell ── */
  return (
    <div style={{ minHeight: '100vh', background: 'var(--slate-950, #020617)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ width: 420, background: '#fff', borderRadius: 16,
        boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '26px 28px 20px', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <span style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--blue-600)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 17 }}>O</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#0f172a' }}>Otopair Director</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>Internal control plane</div>
            </div>
          </div>

          {phase.id === 'email' && (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, color: '#0f172a' }}>Sign in</div>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>Enter your director email to continue.</div>
            </>
          )}
          {phase.id === 'code' && (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, color: '#0f172a' }}>Verify your identity</div>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>Enter the 6-digit code from your authenticator app.</div>
            </>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '22px 28px 28px' }}>

          {/* ── Email phase ── */}
          {phase.id === 'email' && (
            <form onSubmit={handleEmailSubmit} noValidate>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                color: '#475569', marginBottom: 6 }}>
                Email address
              </label>
              <input
                ref={emailRef}
                type="email"
                autoComplete="email"
                placeholder="you@otopair.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                style={{ width: '100%', fontSize: 15, padding: '10px 12px',
                  border: `1.5px solid ${error ? '#f87171' : '#e2e8f0'}`,
                  borderRadius: 9, outline: 'none', fontFamily: 'inherit',
                  color: '#0f172a', boxSizing: 'border-box',
                  background: '#fff' }}
              />
              {error && (
                <div style={{ marginTop: 8, fontSize: 13, color: '#dc2626', fontWeight: 500 }}>{error}</div>
              )}
              <button type="submit"
                style={{ marginTop: 16, width: '100%', padding: '11px 0',
                  background: '#2563eb', color: '#fff', border: 'none',
                  borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'inherit', letterSpacing: '0.01em' }}>
                Continue →
              </button>
            </form>
          )}

          {/* ── Code phase ── */}
          {phase.id === 'code' && (
            <div>
              {/* Email chip */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18,
                padding: '8px 12px', background: '#f8fafc', borderRadius: 8,
                border: '1px solid #e2e8f0' }}>
                <span style={{ fontSize: 13, color: '#64748b' }}>Signing in as</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {phase.email}
                </span>
              </div>

              <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                color: '#475569', marginBottom: 8 }}>
                Authenticator code
              </label>
              <input
                ref={codeRef}
                type="text"
                inputMode="numeric"
                placeholder="000000"
                maxLength={6}
                value={code}
                onChange={e => handleCodeChange(e.target.value)}
                disabled={busy}
                style={{ width: '100%', textAlign: 'center', fontSize: 32, fontWeight: 700,
                  letterSpacing: 12, padding: '14px 0',
                  border: `2px solid ${error ? '#f87171' : '#e2e8f0'}`,
                  borderRadius: 10, outline: 'none', fontFamily: 'monospace',
                  color: '#0f172a', background: busy ? '#f8fafc' : '#fff',
                  boxSizing: 'border-box' }}
              />
              {error && (
                <div style={{ marginTop: 10, fontSize: 13, color: '#dc2626', textAlign: 'center', fontWeight: 500 }}>{error}</div>
              )}
              {busy && (
                <div style={{ marginTop: 10, fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>Verifying…</div>
              )}
              <button onClick={() => setPhase({ id: 'email' })}
                style={{ marginTop: 16, width: '100%', padding: '10px 0', background: 'none', border: 'none',
                  fontSize: 13, color: '#64748b', cursor: 'pointer', textDecoration: 'underline',
                  fontFamily: 'inherit' }}>
                ← Use a different email
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
