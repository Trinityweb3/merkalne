import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createSession } from '@/lib/auth'
import { verifyState } from '@/lib/csrf'
import { env, configuredOAuthProviders } from '@/lib/env'
import { clientIp, rateLimit } from '@/lib/rate-limit'

/**
 * GET /api/auth/oauth/[provider]/callback — finishes the OAuth dance:
 * validates state, exchanges the code, fetches the verified profile and
 * links (or provisions) the local account. Unverified emails from providers
 * never auto-verify the local record.
 */

interface OAuthProfile {
  providerAccountId: string
  email: string
  emailVerified: boolean
  name: string | null
  image: string | null
}

async function exchangeGoogle(code: string): Promise<OAuthProfile> {
  const redirectUri = `${env.APP_URL}/api/auth/oauth/google/callback`
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!tokenRes.ok) throw new Error(`google token exchange failed: ${tokenRes.status}`)
  const tokens = (await tokenRes.json()) as { access_token?: string }
  if (!tokens.access_token) throw new Error('google token exchange returned no access token')

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  if (!infoRes.ok) throw new Error(`google userinfo failed: ${infoRes.status}`)
  const info = (await infoRes.json()) as {
    sub: string
    email?: string
    email_verified?: boolean
    name?: string
    picture?: string
  }
  if (!info.email) throw new Error('google account has no email')
  return {
    providerAccountId: info.sub,
    email: info.email.toLowerCase(),
    emailVerified: Boolean(info.email_verified),
    name: info.name ?? null,
    image: info.picture ?? null,
  }
}

async function exchangeGithub(code: string): Promise<OAuthProfile> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
    }),
  })
  if (!tokenRes.ok) throw new Error(`github token exchange failed: ${tokenRes.status}`)
  const tokens = (await tokenRes.json()) as { access_token?: string }
  if (!tokens.access_token) throw new Error('github token exchange returned no access token')

  const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/vnd.github+json' }
  const userRes = await fetch('https://api.github.com/user', { headers })
  if (!userRes.ok) throw new Error(`github user failed: ${userRes.status}`)
  const ghUser = (await userRes.json()) as {
    id: number
    login: string
    name?: string | null
    email?: string | null
    avatar_url?: string
  }

  // GitHub may hide the primary email — fetch it explicitly (includes verified flag).
  let email = ghUser.email?.toLowerCase() ?? null
  let emailVerified = false
  const emailsRes = await fetch('https://api.github.com/user/emails', { headers })
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[]
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
    if (primary) {
      email = primary.email.toLowerCase()
      emailVerified = primary.verified
    }
  }
  if (!email) throw new Error('github account has no accessible email')

  return {
    providerAccountId: String(ghUser.id),
    email,
    emailVerified,
    name: ghUser.name ?? ghUser.login,
    image: ghUser.avatar_url ?? null,
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const fail = (reason: string) =>
    NextResponse.redirect(`${env.APP_URL}/auth?mode=login&error=${encodeURIComponent(reason)}`)

  try {
    const { provider } = await ctx.params
    if (provider !== 'google' && provider !== 'github') return fail('unsupported_provider')

    const configured = configuredOAuthProviders()
    if (!configured[provider]) return fail('provider_not_configured')

    const ip = clientIp(req)
    const rl = rateLimit(`oauth-cb:${ip}`, 20, 60_000)
    if (!rl.ok) return fail('rate_limited')

    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const providerError = url.searchParams.get('error')

    if (providerError) return fail(providerError)
    if (!code) return fail('missing_code')
    if (!verifyState(state)) return fail('invalid_state')

    const profile = provider === 'google' ? await exchangeGoogle(code) : await exchangeGithub(code)

    // Find or link the account atomically-ish: match Account first, then a
    // verified email match, otherwise provision a new user.
    const account = await db.account.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId } },
      include: { user: true },
    })

    let userId: string
    if (account) {
      // Refresh stale profile fields opportunistically.
      userId = account.userId
      await db.user
        .update({
          where: { id: userId },
          data: {
            name: profile.name ?? account.user.name,
            image: profile.image ?? account.user.image,
          },
        })
        .catch(() => undefined)
    } else {
      const existingUser = await db.user.findUnique({ where: { email: profile.email } })
      if (existingUser) {
        userId = existingUser.id
        await db.account.create({
          data: { userId, provider, providerAccountId: profile.providerAccountId },
        })
        // A verified provider email verifies the local record too.
        if (profile.emailVerified && !existingUser.emailVerified) {
          await db.user.update({ where: { id: userId }, data: { emailVerified: new Date() } })
        }
      } else {
        const user = await db.user.create({
          data: {
            email: profile.email,
            name: profile.name,
            image: profile.image,
            emailVerified: profile.emailVerified ? new Date() : null,
            accounts: { create: { provider, providerAccountId: profile.providerAccountId } },
          },
        })
        userId = user.id
      }
    }

    await createSession(userId, { userAgent: req.headers.get('user-agent'), ip })

    const next = url.searchParams.get('next')
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
    return NextResponse.redirect(`${env.APP_URL}${safeNext}`)
  } catch (err) {
    console.error('[oauth] callback failed', err)
    return fail('oauth_failed')
  }
}
