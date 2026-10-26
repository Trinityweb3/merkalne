import { cookies } from 'next/headers'
import { jsonError, jsonOk } from '@/lib/api'
import { parseJsonBody, localeSchema } from '@/lib/validation'
import { assertMutationSafe } from '@/lib/csrf'
import { handleRouteError } from '@/lib/api'
import { LANGUAGES } from '@/lib/constants'

/**
 * GET/PUT /api/preferences — interface locale preference (cookie-backed so
 * it works for guests as well as signed-in users). The chosen locale drives
 * <html lang> and the document direction (RTL for ar/fa/ur).
 */
const LOCALE_COOKIE = 'merklane_locale'

export async function GET() {
  const store = await cookies()
  const locale = store.get(LOCALE_COOKIE)?.value ?? 'en'
  return jsonOk({ locale: LANGUAGES.some((l) => l.code === locale) ? locale : 'en' })
}

export async function PUT(req: Request) {
  try {
    await assertMutationSafe(req)
    const body = await parseJsonBody(req, localeSchema)
    if (!body.ok) return jsonError(body.message, 422)

    if (!LANGUAGES.some((l) => l.code === body.data.locale)) {
      return jsonError('Unsupported locale', 422)
    }

    const store = await cookies()
    store.set(LOCALE_COOKIE, body.data.locale, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })

    return jsonOk({ locale: body.data.locale })
  } catch (err) {
    return handleRouteError(err)
  }
}
