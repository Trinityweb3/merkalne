'use client'

import { useState } from 'react'
import { Link } from '@/i18n/navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { toast } from 'sonner'
import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api-client'

function ResetPasswordInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token, password } })
      toast.success('Password updated — all sessions were signed out', {
        description: 'Sign in again with your new password.',
      })
      router.push('/auth?mode=login')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reset the password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-layout">
      <div className="card auth-card">
        <ShieldCheck width={38} height={38} style={{ color: 'var(--link)', marginBottom: 14 }} />
        <h1>Choose a new password</h1>
        <p className="muted small" style={{ marginTop: 10 }}>
          Setting a new password signs out every device for safety — your other sessions stop
          working immediately.
        </p>
        <form onSubmit={submit} style={{ marginTop: 20 }} noValidate>
          <div className="field">
            <Label htmlFor="new-password" className="field-label">
              New password
            </Label>
            <div className="password-input">
              <Input
                id="new-password"
                type={show ? 'text' : 'password'}
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 10 characters, letters + numbers"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="icon-button"
                aria-label={show ? 'Hide password' : 'Show password'}
                onClick={() => setShow((v) => !v)}
              >
                {show ? <EyeOff width={17} height={17} /> : <Eye width={17} height={17} />}
              </button>
            </div>
            <small>Minimum 10 characters with at least one letter and one number.</small>
          </div>
          <Button
            type="submit"
            className="full-width"
            disabled={busy || !token}
            style={{ background: 'var(--link)', color: '#081219' }}
          >
            {busy ? 'Saving…' : 'Save new password'}
          </Button>
          {!token ? (
            <p className="field-error" style={{ marginTop: 10 }}>
              Missing reset token — open the link from your email.
            </p>
          ) : null}
        </form>
        <p className="muted tiny" style={{ marginTop: 16, textAlign: 'center' }}>
          Link expired?{' '}
          <Link href="/auth/forgot-password" className="link">
            Request a new one
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <div className="container page">
      <Suspense fallback={<div className="auth-layout card auth-card muted">Loading…</div>}>
        <ResetPasswordInner />
      </Suspense>
    </div>
  )
}
