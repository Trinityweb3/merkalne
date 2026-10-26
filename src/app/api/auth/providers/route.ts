import { configuredOAuthProviders } from '@/lib/env'
import { jsonOk } from '@/lib/api'

/** GET /api/auth/providers — which OAuth providers are configured. */
export async function GET() {
  return jsonOk({ providers: configuredOAuthProviders() })
}
