'use client'

import { useState } from 'react'
import { Link } from '@/i18n/navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { toast } from 'sonner'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api-client'

function ForgotPasswordInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState(searchParams.get('email') ?? '')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/api/auth/forgot-password', { method: 'POST', body: { email } })
      setSent(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the reset email')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-layout">
      <div className="card auth-card">
        <KeyRound width={38} height={38} style={{ color: 'var(--link)', marginBottom: 14 }} />
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <p className="muted small" style={{ marginTop: 10 }}>
              If an account exists for <strong>{email}</strong>, a reset link is on its way. It
              expires in 60 minutes and works once.
            </p>
            <div className="button-row" style={{ marginTop: 22, justifyContent: 'center' }}>
              <Link href="/auth?mode=login">
                <Button variant="outline">Back to sign in</Button>
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 10 }}>
              Enter the email you registered with. For security we always show the same answer —
              whether or not the account exists.
            </p>
            <form onSubmit={submit} style={{ marginTop: 20 }} noValidate>
              <div className="field">
                <Label htmlFor="forgot-email" className="field-label">
                  Email
                </Label>
                <Input
                  id="forgot-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>
              <Button
                type="submit"
                className="full-width"
                disabled={busy}
                style={{ background: 'var(--link)', color: '#081219' }}
              >
                {busy ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
            <p className="muted tiny" style={{ marginTop: 16, textAlign: 'center' }}>
              Remembered it?{' '}
              <Link href="/auth?mode=login" className="link">
                Sign in instead
              </Link>
              {' · '}No password yet?{' '}
              <Link href="/auth?mode=login" className="link">
                Use a magic link
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default function ForgotPasswordPage() {
  return (
    <div className="container page">
      <Suspense fallback={<div className="auth-layout card auth-card muted">Loading…</div>}>
        <ForgotPasswordInner />
      </Suspense>
    </div>
  )
}
