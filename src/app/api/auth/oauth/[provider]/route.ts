import { NextResponse } from 'next/server'
import { signState } from '@/lib/csrf'
import { env, configuredOAuthProviders } from '@/lib/env'
import { HttpError, handleRouteError, jsonError } from '@/lib/api'

/**
 * GET /api/auth/oauth/[provider] — starts the OAuth 2.0 authorization-code
 * dance for Google or GitHub with an HMAC-signed, expiring `state` parameter
 * (CSRF protection for the redirect round-trip).
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await ctx.params
    const configured = configuredOAuthProviders()
    if (provider !== 'google' && provider !== 'github') {
      return jsonError('Unsupported OAuth provider', 404)
    }
    if (!configured[provider]) {
      return jsonError(
        `${provider === 'google' ? 'Google' : 'GitHub'} sign-in is not configured on this deployment yet. ` +
          'Set the client id/secret in the environment to enable it.',
        503,
      )
    }

    const { state } = signState()
    const redirectUri = `${env.APP_URL}/api/auth/oauth/${provider}/callback`

    let authorizeUrl: string
    if (provider === 'google') {
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      })
      authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
    } else {
      const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID!,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      })
      authorizeUrl = `https://github.com/login/oauth/authorize?${params}`
    }

    return NextResponse.redirect(authorizeUrl)
  } catch (err) {
    if (err instanceof HttpError) return handleRouteError(err)
    console.error('[oauth] start failed', err)
    return NextResponse.redirect(`${env.APP_URL}/auth?mode=login&error=oauth_failed`)
  }
}
