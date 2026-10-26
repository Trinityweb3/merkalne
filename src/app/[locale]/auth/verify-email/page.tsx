'use client'

import { useEffect, useState } from 'react'
import { Link } from '@/i18n/navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { toast } from 'sonner'
import { MailCheck, MailX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api-client'

function VerifyEmailInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const isChange = searchParams.get('change') === '1'
  // Missing token is a synchronous condition — derive the initial state.
  const [state, setState] = useState<'working' | 'ok' | 'fail'>(token ? 'working' : 'fail')
  const [message, setMessage] = useState(
    token ? '' : 'This page needs a verification link from your email.',
  )

  useEffect(() => {
    if (!token) return
    let cancelled = false
    api('/api/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => {
        if (cancelled) return
        setState('ok')
        setMessage(
          isChange
            ? 'Your new email address is confirmed and active.'
            : 'Your email is verified. Everything is unlocked now.',
        )
        toast.success('Email verified')
        setTimeout(() => {
          router.push('/profile')
          router.refresh()
        }, 1800)
      })
      .catch((err) => {
        if (cancelled) return
        setState('fail')
        setMessage(err instanceof Error ? err.message : 'Verification failed.')
      })
    return () => {
      cancelled = true
    }
  }, [token, isChange, router])

  return (
    <div className="auth-layout">
      <div className="card auth-card" style={{ textAlign: 'center' }}>
        {state === 'working' ? (
          <>
            <h1>Verifying…</h1>
            <p className="muted small" style={{ marginTop: 10 }}>
              Checking your verification link.
            </p>
          </>
        ) : state === 'ok' ? (
          <>
            <MailCheck width={44} height={44} style={{ color: 'var(--positive)', margin: '0 auto 14px' }} />
            <h1>Verified</h1>
            <p className="muted small" style={{ marginTop: 10 }}>
              {message} Redirecting to your profile…
            </p>
          </>
        ) : (
          <>
            <MailX width={44} height={44} style={{ color: 'var(--negative)', margin: '0 auto 14px' }} />
            <h1>Link problem</h1>
            <p className="muted small" style={{ marginTop: 10 }}>
              {message}
            </p>
            <div className="button-row" style={{ justifyContent: 'center', marginTop: 20 }}>
              <Button
                variant="outline"
                onClick={() =>
                  api('/api/auth/verify-email/request', { method: 'POST', body: {} }).then(
                    () => toast.success('A fresh verification email is on its way'),
                    (err) => toast.error(err instanceof Error ? err.message : 'Could not resend'),
                  )
                }
              >
                Send a new link
              </Button>
              <Link href="/">
                <Button variant="ghost">Go home</Button>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function VerifyEmailPage() {
  return (
    <div className="container page">
      <Suspense fallback={<div className="auth-layout card auth-card muted">Loading…</div>}>
        <VerifyEmailInner />
      </Suspense>
    </div>
  )
}
