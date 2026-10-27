/**
 * Localized serving of job content with a DB translation cache.
 *
 * Pipeline (per the i18n requirement — check cache → translate → save → serve):
 *   1. posts are fetched with their `translations` JSON column
 *      (shape: { ru: { title?, body? }, es: { … } })
 *   2. fields already cached are used as-is
 *   3. missing fields are machine-translated (LibreTranslate, one batched
 *      request per list) and merged back into the cache column
 *   4. the render always gets SOMETHING — any failure along the way serves
 *      the English original, so a down/slow translation service can never
 *      break or slow a page beyond the client's 3.5 s request timeout
 *
 * Granularity:
 *   • 'title'  — list pages (cards show the title + a body snippet): only the
 *     cheap field is translated; the body snippet stays English until the
 *     article page fills the body translation
 *   • 'full'   — article pages: title + body (body only when ≤ 20 000 chars;
 *     longer bodies keep English — translation latency would dwarf the render)
 */
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { translateBatch, localeTranslatable, translationConfigured } from '@/lib/translate'

/** Fields of a post we machine-translate. */
export interface PostTranslation {
  title?: string
  body?: string
}

type TranslationMap = Record<string, PostTranslation>

/** Upper bound for inline body translation (chars). */
const MAX_TRANSLATABLE_BODY = 20_000

export interface LocalizablePost {
  id: string
  title: string
  body: string
  translations: Prisma.JsonValue | null
}

/** Defensive parse of the JSON column (never trusts the stored shape). */
function parseMap(raw: Prisma.JsonValue | null): TranslationMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: TranslationMap = {}
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    out[locale] = {
      ...(typeof v.title === 'string' && v.title.trim() ? { title: v.title } : {}),
      ...(typeof v.body === 'string' && v.body.trim() ? { body: v.body } : {}),
    }
  }
  return out
}

/** In-flight de-duplication: two concurrent renders of the same list share one translation pass. */
const inflight = new Map<string, Promise<unknown>>()

async function runGuarded<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const p = fn().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Best-effort cache write — a lost race only means a re-translate later. */
async function saveTranslation(postId: string, locale: string, patch: PostTranslation): Promise<void> {
  try {
    const current = await db.post.findUnique({ where: { id: postId }, select: { translations: true } })
    const map = parseMap(current?.translations ?? null)
    map[locale] = { ...map[locale], ...patch }
    await db.post.update({ where: { id: postId }, data: { translations: map as Prisma.InputJsonValue } })
  } catch (err) {
    console.warn(`[localize] could not persist ${locale} translation for post ${postId}:`, err)
  }
}

/**
 * Localize a list of posts (title-only granularity — section pages, home
 * rails, related sidebars). Returns NEW objects; the inputs are untouched.
 */
export async function localizePostList<T extends LocalizablePost>(posts: T[], locale: string): Promise<T[]> {
  if (posts.length === 0 || locale === 'en' || !translationConfigured()) return posts
  if (!(await localeTranslatable(locale))) return posts

  return runGuarded(`list:${locale}:${posts.map((p) => p.id).join(',')}`, async () => {
    const cached = posts.map((p) => parseMap(p.translations)[locale]?.title)
    const missing = posts.filter((p, i) => !cached[i])

    let translated: string[] | null = null
    if (missing.length > 0) {
      translated = await translateBatch(
        missing.map((p) => p.title),
        locale,
      )
    }

    const byId = new Map<string, string>()
    if (translated) {
      missing.forEach((p, i) => {
        const t = translated?.[i]
        if (t && t.trim()) byId.set(p.id, t)
      })
    }

    // Persist the fresh title translations (best effort, parallel).
    await Promise.all(
      [...byId.entries()].map(([id, title]) => saveTranslation(id, locale, { title })),
    )

    return posts.map((p) => {
      const title = byId.get(p.id) ?? parseMap(p.translations)[locale]?.title
      return title ? { ...p, title } : p
    })
  })
}

/**
 * Localize ONE post fully (title + body — article pages). Related/sibling
 * posts should use localizePostList instead (title-only).
 */
export async function localizePostFull<T extends LocalizablePost>(post: T, locale: string): Promise<T> {
  if (locale === 'en' || !translationConfigured()) return post
  if (!(await localeTranslatable(locale))) return post

  return runGuarded(`full:${post.id}:${locale}`, async () => {
    const map = parseMap(post.translations)
    const existing = map[locale] ?? {}
    const needTitle = !existing.title
    const bodyEligible = post.body.length > 0 && post.body.length <= MAX_TRANSLATABLE_BODY
    const needBody = bodyEligible && !existing.body

    let patch: PostTranslation = {}
    if (needTitle || needBody) {
      const source: string[] = []
      if (needTitle) source.push(post.title)
      if (needBody) source.push(post.body)
      const result = await translateBatch(source, locale)
      if (result) {
        let i = 0
        if (needTitle && result[i]?.trim()) patch.title = result[i]
        i += needTitle ? 1 : 0
        if (needBody && result[i]?.trim()) patch.body = result[i]
      }
    }

    if (needTitle || needBody) await saveTranslation(post.id, locale, patch)

    const merged = { ...existing, ...patch }
    return {
      ...post,
      title: merged.title ?? post.title,
      body: merged.body ?? post.body,
    }
  })
}
