'use client'

import { Suspense, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { api, ApiError } from '@/lib/api-client'
import { useSession } from '@/components/providers/session-provider'

function GoogleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.87-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.29a12 12 0 0 0 0 10.78l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.61 4.58 1.8l3.44-3.44A11.98 11.98 0 0 0 1.29 6.61l4 3.1c.94-2.84 3.59-4.95 6.71-4.95Z" />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.69-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.35.96.11-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.04.77 2.1v3.11c0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

const OAUTH_ERRORS: Record<string, string> = {
  oauth_failed: 'The external sign-in failed. Please try again.',
  invalid_state: 'The sign-in window expired. Please try again.',
  provider_not_configured: 'This provider is not configured on this deployment yet.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  unsupported_provider: 'Unknown provider.',
  missing_code: 'The provider did not return an authorization code.',
}

function AuthForm() {
  const t = useTranslations('auth')
  const router = useRouter()
  const searchParams = useSearchParams()
  const { refresh } = useSession()

  const initialMode = searchParams.get('mode') === 'register' ? 'register' : 'login'
  const [mode, setMode] = useState<'login' | 'register'>(initialMode)
  const nextUrl = searchParams.get('next') ?? '/'
  const oauthError = searchParams.get('error')
  // Referral code from /auth?mode=register&ref=CODE — carried through the
  // register call so the new account is bound to its inviter.
  const referralCode = (searchParams.get('ref') ?? '').trim().toUpperCase()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<'login' | 'register' | 'magic' | null>(null)
  const [magicSent, setMagicSent] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)

  function complete(message: string) {
    toast.success(message)
    void refresh()
    // Only allow internal redirect targets (no open redirect).
    const safe = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/'
    router.push(safe)
    router.refresh()
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setFieldError(null)

    if (mode === 'register' && !acceptTerms) {
      setFieldError('Please accept the Terms to continue')
      return
    }

    setBusy(mode)
    try {
      if (mode === 'login') {
        await api('/api/auth/login', { method: 'POST', body: { email, password } })
        complete('Welcome back!')
      } else {
        await api('/api/auth/register', {
          method: 'POST',
          body: {
            email,
            password,
            name: name || undefined,
            acceptTerms,
            ...(referralCode ? { referralCode } : {}),
          },
        })
        toast.success('Account created — check your inbox to verify your email.')
        void refresh()
        const safe = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/'
        router.push(safe)
        router.refresh()
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        toast.error(err.message)
      } else {
        setFieldError(err instanceof Error ? err.message : 'Something went wrong')
      }
    } finally {
      setBusy(null)
    }
  }

  async function sendMagicLink() {
    if (!email.trim()) {
      setFieldError('Enter your email first, then request a sign-in link')
      return
    }
    setFieldError(null)
    setBusy('magic')
    try {
      await api('/api/auth/magic-link', { method: 'POST', body: { email } })
      setMagicSent(true)
      toast.success('If that email is valid, a sign-in link is on its way', {
        description: 'The link expires in 15 minutes and works once.',
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the link')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="auth-layout">
      <div className="card auth-card">
        <h1>{mode === 'login' ? t('welcomeBack') : t('createAccount')}</h1>
        <p className="muted small" style={{ marginTop: 8 }}>
          {mode === 'login' ? t('loginSub') : t('registerSub')}
        </p>

        {oauthError ? (
          <div className="notice" role="alert" style={{ marginTop: 18 }}>
            <span aria-hidden>⚠</span>
            <span>{OAUTH_ERRORS[oauthError] ?? t('externalFailed')}</span>
          </div>
        ) : null}
        {fieldError ? (
          <p className="field-error" role="alert" style={{ marginTop: 14 }}>
            {fieldError}
          </p>
        ) : null}

        <div className="auth-providers">
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              window.location.href = `/api/auth/oauth/google?next=${encodeURIComponent(nextUrl)}`
            }}
          >
            <GoogleIcon /> Google
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              window.location.href = `/api/auth/oauth/github?next=${encodeURIComponent(nextUrl)}`
            }}
          >
            <GitHubIcon /> GitHub
          </Button>
        </div>

        <div className="auth-divider" aria-hidden>
          {t('orContinueEmail')}
        </div>

        <form onSubmit={submit} noValidate>
          {mode === 'register' ? (
            <div className="field">
              <Label htmlFor="auth-name" className="field-label">
                {t('name')} <span className="muted">{t('nameOptional')}</span>
              </Label>
              <Input
                id="auth-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                autoComplete="name"
                maxLength={80}
              />
            </div>
          ) : null}

          <div className="field">
            <Label htmlFor="auth-email" className="field-label">
              {t('email')}
            </Label>
            <Input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              autoComplete="email"
            />
          </div>

          <div className="field">
            <Label htmlFor="auth-password" className="field-label">
              {t('password')}
            </Label>
            <div className="password-input">
              <Input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? t('passwordNewPlaceholder') : t('passwordPlaceholder')}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                minLength={mode === 'register' ? 10 : undefined}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff width={17} height={17} /> : <Eye width={17} height={17} />}
              </button>
            </div>
          </div>

          {mode === 'register' ? (
            <label className="row small" style={{ alignItems: 'flex-start', gap: 10, marginBottom: 18 }}>
              <Checkbox
                checked={acceptTerms}
                onCheckedChange={(v) => setAcceptTerms(v === true)}
                aria-label={t('acceptTerms')}
              />
              <span className="muted">
                {t('acceptPrefix')}{' '}
                <Link href="/terms" className="link">
                  {t('terms')}
                </Link>{' '}
                {t('and')}{' '}
                <Link href="/privacy" className="link">
                  {t('privacyPolicy')}
                </Link>
                .
              </span>
            </label>
          ) : null}

          <Button
            type="submit"
            className="full-width"
            disabled={busy !== null}
            style={{ background: 'var(--link)', color: '#081219' }}
          >
            {busy === mode ? t('pleaseWait') : mode === 'login' ? t('logIn') : t('createAccountBtn')}
          </Button>
        </form>

        <div className="auth-divider" aria-hidden>
          {t('or')}
        </div>

        <Button variant="outline" className="full-width" onClick={sendMagicLink} disabled={busy !== null}>
          {busy === 'magic' ? t('sending') : t('magicLink')}
        </Button>
        {magicSent ? (
          <p className="muted small" style={{ marginTop: 10, textAlign: 'center' }}>
            {t('magicSent', { email })}
          </p>
        ) : null}

        <Separator className="my-6" />

        <div className="row between wrap small" style={{ gap: 12 }}>
          <button
            type="button"
            className="link"
            style={{ background: 'none', border: 0, padding: 0, font: 'inherit' }}
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setFieldError(null)
            }}
          >
            {mode === 'login' ? t('noAccount') + ' ' + t('signUp') : t('haveAccount') + ' ' + t('signIn')}
          </button>
          {mode === 'login' ? (
            <Link href={`/auth/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ''}`} className="link">
              Forgot password?
            </Link>
          ) : null}
        </div>
      </div>

      <p className="muted tiny" style={{ textAlign: 'center', marginTop: 16 }}>
        One account can combine Google, GitHub, email + password and magic links — manage them
        anytime in <Link href="/profile?tab=security" className="link">Security</Link>.
      </p>
    </div>
  )
}

export default function AuthPage() {
  return (
    <div className="container page">
      <Suspense fallback={<div className="auth-layout card auth-card muted">Loading…</div>}>
        <AuthForm />
      </Suspense>
    </div>
  )
}
