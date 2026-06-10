'use client'

/**
 * Director-panel error boundary (Jun-10 sweep review fix).
 *
 * The panel's token-gated queries (ai_feedback, audit_log, directorConfig*)
 * throw "unauthorized: invalid or expired director session" from REACTIVE
 * queries once the 8h session lapses — and a reactive query can re-run (and
 * throw) before AdminPanel's validateSession gate notices the expiry. With
 * no boundary that crashed the whole panel; here we clear the stale token
 * and reload so AdminPanel lands on the login screen.
 */
import { useEffect } from 'react'

const SESSION_KEY = 'otopair_director_token'

export default function DirectorError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const sessionExpired = /invalid or expired director session/i.test(
    error?.message ?? '',
  )

  useEffect(() => {
    if (sessionExpired) {
      localStorage.removeItem(SESSION_KEY)
      window.location.reload()
    }
  }, [sessionExpired])

  if (sessionExpired) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--slate-500)' }}>
        Session expired — returning to login…
      </div>
    )
  }

  return (
    <div style={{ padding: 48, textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
        Something went wrong in the director panel
      </div>
      <div style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 16 }}>
        {error?.message ?? 'Unknown error'}
      </div>
      <button
        onClick={reset}
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          border: '1px solid var(--slate-200)',
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  )
}
