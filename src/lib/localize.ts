/**
 * Localized serving of job content with a DB translation cache.
 *
 * Pipeline (per the i18n requirement — check cache → translate → save → serve):
 *   1. posts are fetched with their `translations` JSON column
 *      (shape: { ru: { title?, body?, snippet?, tags? }, es: { … } })
 *   2. fields already cached are used as-is
 *   3. missing fields are machine-translated (LibreTranslate, batched) and
 *      merged back into the cache column
 *   4. the render always gets SOMETHING — any failure along the way serves
 *      the English original, so a down/slow translation service can never
 *      break a page
 *
 * Granularity (which fields a surface translates):
 *   • lists (section pages, home rails, sidebars) — title + SNIPPET.
 *     The card snippet used to be derived from the English body at render
 *     time, which is why localized cards showed translated titles next to
 *     English snippets — the "killer feature" bug. The translated snippet is
 *     cached alongside the title; the body itself stays English on lists
 *     (translating 9 full bodies per list view would dwarf the render).
 *   • article pages — title + BODY (the full granularity).
 *
 * TAGS ARE NEVER TRANSLATED (hashtag policy): tags render as hashtags
 * (#crypto, #defi …), feed /search?q=%23tag lookups and the tag filters, and
 * are therefore functional identifiers — they stay English in every locale.
 * Inline hashtags inside titles/bodies/snippets are protected separately in
 * translate.ts (⟦N⟧ placeholders). Previously-cached translated tags in
 * Post.translations are IGNORED (not applied), so old cache rows are inert.
 *
 * Latency contract (production, CPU-bound self-hosted LibreTranslate):
 *   • cache hits are served with ZERO network I/O;
 *   • a first (uncached) localized view waits at most LIST_BUDGET_MS /
 *     FULL_BUDGET_MS for the translation — if the service is slower, the
 *     page still renders the English original while the translation promise
 *     KEEPS RUNNING in the background and fills the DB cache, so the NEXT
 *     view (or a refresh) is fully localized. Slow-but-working beats
 *     fast-but-English-forever, which is what a hard 3.5 s render timeout
 *     produced before.
 */
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { snippet } from '@/lib/utils'
import { translateBatch, localeTranslatable, translationConfigured } from '@/lib/translate'

/** Fields of a post we machine-translate. */
export interface PostTranslation {
  title?: string
  body?: string
  /** Card snippet (plain-text excerpt) — used by list pages. */
  snippet?: string
  /**
   * Translated hashtags (LEGACY). No longer produced or applied — tags are
   * functional identifiers and stay English in every locale (hashtag
   * policy). Kept in the interface for backwards compatibility with rows
   * already cached in Post.translations; parseMap still tolerates the field.
   */
  tags?: string[]
}

type TranslationMap = Record<string, PostTranslation>

/** Upper bound for inline body translation (chars). */
const MAX_TRANSLATABLE_BODY = 20_000

/** How long a list render may wait for fresh translations. */
const LIST_BUDGET_MS = 8_000
/** How long an article render may wait for fresh translations. */
const FULL_BUDGET_MS = 15_000

export interface LocalizablePost {
  id: string
  title: string
  body: string
  /** Comma-joined tag string (the DB column format). */
  tags: string
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
      ...(typeof v.snippet === 'string' && v.snippet.trim() ? { snippet: v.snippet } : {}),
      ...(Array.isArray(v.tags) && v.tags.every((t) => typeof t === 'string')
        ? { tags: (v.tags as string[]).filter((t) => t.trim()) }
        : {}),
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

/**
 * Race a promise against a render budget. On timeout returns null — the
 * promise itself is NOT aborted: it keeps running, and its own .then fills
 * the DB cache so the next request is a cache hit.
 */
function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/**
 * Saves are serialized PER POST: the article path fills title+tags and the
 * body concurrently (two separate batches), and a naive read-merge-write
 * would let one write clobber the other's fields.
 */
const saveChains = new Map<string, Promise<void>>()

/** Best-effort cache write — a lost race only means a re-translate later. */
function saveTranslation(postId: string, locale: string, patch: PostTranslation): Promise<void> {
  if (Object.keys(patch).length === 0) return Promise.resolve()
  const prev = saveChains.get(postId) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(async () => {
    const current = await db.post.findUnique({ where: { id: postId }, select: { translations: true } })
    const map = parseMap(current?.translations ?? null)
    map[locale] = { ...map[locale], ...patch }
    await db.post.update({ where: { id: postId }, data: { translations: map as Prisma.InputJsonValue } })
  })
  saveChains.set(postId, next)
  return next.finally(() => {
    if (saveChains.get(postId) === next) saveChains.delete(postId)
  })
}

// ---------------------------------------------------------------------------
// List granularity: title + snippet
// ---------------------------------------------------------------------------

/**
 * Localize a list of posts (title + snippet — everything a card shows except
 * the hashtags, which always stay English). Returns NEW objects carrying an
 * optional `snippet` field (the translated card excerpt; components fall
 * back to the English body when absent); the inputs are untouched.
 */
export async function localizePostList<T extends LocalizablePost>(
  posts: T[],
  locale: string,
): Promise<Array<T & { snippet?: string }>> {
  if (posts.length === 0 || locale === 'en' || !translationConfigured()) return posts
  if (!(await localeTranslatable(locale))) return posts

  {
    const maps = posts.map((p) => parseMap(p.translations)[locale] ?? {})

    // Collect every missing field as one batch job (post index, what to do
    // with the result, the English source string). Tags are deliberately
    // absent: they render as hashtags and must stay English everywhere.
    interface Task {
      i: number
      kind: 'title' | 'snippet'
      source: string
    }
    const tasks: Task[] = []
    posts.forEach((p, i) => {
      if (!maps[i].title) tasks.push({ i, kind: 'title', source: p.title })
      if (!maps[i].snippet) tasks.push({ i, kind: 'snippet', source: snippet(p.body) })
    })

    const fill = async (): Promise<PostTranslation[] | null> => {
      if (tasks.length === 0) return posts.map(() => ({}))
      const translated = await translateBatch(
        tasks.map((t) => t.source),
        locale,
      )
      if (!translated) return null
      const patches: PostTranslation[] = posts.map(() => ({}))
      tasks.forEach((t, k) => {
        const v = translated[k]
        if (!v || !v.trim()) return
        if (t.kind === 'title') patches[t.i].title = v
        else patches[t.i].snippet = v
      })
      return patches
    }

    // The translation + persist chain keeps running even if the render
    // budget expires — the cache warms for the next view either way. The
    // guarded promise resolves only when that background work TRULY finishes,
    // so concurrent renders of the same list keep sharing one pass (each
    // render then races its own budget against the shared promise).
    const work = runGuarded(`list-work:${locale}:${posts.map((p) => p.id).join(',')}`, async () => {
      const patches = await fill()
      if (!patches) return null
      await Promise.all(posts.map((p, i) => saveTranslation(p.id, locale, patches[i])))
      return posts.map((p, i) => {
        const t = { ...maps[i], ...patches[i] }
        const out = { ...p } as T & { snippet?: string }
        if (t.title) out.title = t.title
        if (t.snippet) out.snippet = t.snippet
        // NOTE: t.tags (legacy translated tags) is deliberately NOT applied —
        // hashtags stay English in every locale.
        return out
      })
    })
    const merged = await withBudget(work, LIST_BUDGET_MS)
    return merged ?? posts
  }
}

// ---------------------------------------------------------------------------
// Article granularity: title + body
// ---------------------------------------------------------------------------

/**
 * Localize ONE post fully (title + body — article pages). Tags are never
 * translated (hashtag policy — see the file header). Related/sibling posts
 * should use localizePostList instead (title + snippet).
 */
export async function localizePostFull<T extends LocalizablePost>(post: T, locale: string): Promise<T> {
  if (locale === 'en' || !translationConfigured()) return post
  if (!(await localeTranslatable(locale))) return post

  const map = parseMap(post.translations)[locale] ?? {}

  const needTitle = !map.title
  const bodyEligible = post.body.length > 0 && post.body.length <= MAX_TRANSLATABLE_BODY
  const needBody = bodyEligible && !map.body
  if (!needTitle && !needBody) return post

  // FAST lane: the title (short strings translate quickly, so they are most
  // likely to land inside the render budget).
  const fastFill = async (): Promise<PostTranslation | null> => {
    if (!needTitle) return {}
    const translated = await translateBatch([post.title], locale)
    if (!translated) return null
    const patch: PostTranslation = {}
    if (translated[0]?.trim()) patch.title = translated[0]
    return patch
  }

  // SLOW lane: the body (potentially many seconds on CPU Argos). Runs in
  // parallel with the fast lane; the render only waits for it within the
  // budget, but it fills the cache no matter what.
  const bodyFill = async (): Promise<PostTranslation | null> => {
    if (!needBody) return {}
    const translated = await translateBatch([post.body], locale)
    if (!translated || !translated[0]?.trim()) return null
    return { body: translated[0] }
  }

  // Each lane is guarded SEPARATELY: concurrent renders of the same article
  // share the in-flight lanes (not duplicate them), and a lane keeps running
  // for the next view even when some render's budget expires.
  const fastLane = runGuarded(`full-fast:${post.id}:${locale}`, async () => {
    const patch = await fastFill()
    if (patch) await saveTranslation(post.id, locale, patch)
    return patch
  })
  const bodyLane = runGuarded(`full-body:${post.id}:${locale}`, async () => {
    const patch = await bodyFill()
    if (patch) await saveTranslation(post.id, locale, patch)
    return patch
  })

  // The render races each lane independently: titles/tags localize fast even
  // when a long body is still grinding through the translator.
  const [fastPatch, bodyPatch] = await Promise.all([
    withBudget(fastLane, FULL_BUDGET_MS),
    withBudget(bodyLane, FULL_BUDGET_MS),
  ])

  const merged = { ...map, ...(fastPatch ?? {}), ...(bodyPatch ?? {}) }
  return {
    ...post,
    title: merged.title ?? post.title,
    body: merged.body ?? post.body,
    // Tags stay English in every locale (hashtag policy); legacy translated
    // tags in the cache are deliberately ignored.
    tags: post.tags,
  }
}
