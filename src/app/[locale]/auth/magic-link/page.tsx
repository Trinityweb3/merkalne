'use client'

import { useEffect, useState } from 'react'
import { Link } from '@/i18n/navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { toast } from 'sonner'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api-client'
import { useSession } from '@/components/providers/session-provider'

function MagicLinkInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const next = searchParams.get('next') ?? '/'
  const { refresh } = useSession()
  // Missing token is a synchronous condition — derive the initial state.
  const [state, setState] = useState<'working' | 'fail'>(token ? 'working' : 'fail')
  const [message, setMessage] = useState(
    token ? '' : 'This page needs a sign-in link from your email.',
  )

  useEffect(() => {
    if (!token) return
    let cancelled = false
    api('/api/auth/magic-link/verify', { method: 'POST', body: { token } })
      .then(async () => {
        if (cancelled) return
        toast.success('Signed in with your magic link')
        await refresh()
        const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/'
        router.push(safe)
        router.refresh()
      })
      .catch((err) => {
        if (cancelled) return
        setState('fail')
        setMessage(err instanceof Error ? err.message : 'This link could not be used.')
      })
    return () => {
      cancelled = true
    }
  }, [token, next, router, refresh])

  return (
    <div className="auth-layout">
      <div className="card auth-card" style={{ textAlign: 'center' }}>
        {state === 'working' ? (
          <>
            <Sparkles width={44} height={44} style={{ color: 'var(--link)', margin: '0 auto 14px' }} />
            <h1>Signing you in…</h1>
            <p className="muted small" style={{ marginTop: 10 }}>
              One moment while we validate your link.
            </p>
          </>
        ) : (
          <>
            <h1>Link problem</h1>
            <p className="muted small" style={{ marginTop: 10 }}>
              {message}
            </p>
            <div className="button-row" style={{ justifyContent: 'center', marginTop: 20 }}>
              <Link href="/auth?mode=login">
                <Button style={{ background: 'var(--link)', color: '#081219' }}>
                  Back to sign in
                </Button>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function MagicLinkPage() {
  return (
    <div className="container page">
      <Suspense fallback={<div className="auth-layout card auth-card muted">Loading…</div>}>
        <MagicLinkInner />
      </Suspense>
    </div>
  )
}
