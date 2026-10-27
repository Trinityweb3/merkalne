/**
 * Job intake — the shared write path behind every ingestion channel:
 *
 *   • Telegram  → /api/webhooks/telegram   (admin commands)
 *   • Discord   → /api/webhooks/discord    (admin slash commands)
 *   • Worker    → src/lib/bots/feeds.ts    (external job feeds)
 *   • Web       → /api/posts               (existing composer, unchanged)
 *
 * All channels funnel through `createJobFromSpec`, which enforces the same
 * Zod rules as the web composer, dedupes by (source, sourceRef), generates a
 * unique slug and writes an IngestionLog audit row.
 *
 * Runtime-agnostic (Next.js routes + standalone worker): relative imports only.
 */
import { z } from 'zod'
import { db } from '../db'
import { POST_SECTIONS, type PostSection } from '../constants'
import { dispatchPendingPosts } from './dispatch'

// ---------------------------------------------------------------------------
// Spec & validation
// ---------------------------------------------------------------------------

export const JOB_SOURCES = ['web', 'telegram', 'discord', 'worker-feed'] as const
export type JobSource = (typeof JOB_SOURCES)[number]

const SECTION_ALIASES: Record<string, PostSection> = {
  junior: 'intern-junior',
  intern: 'intern-junior',
  'intern-junior': 'intern-junior',
  mid: 'mid-senior',
  senior: 'mid-senior',
  'mid-senior': 'mid-senior',
  opportunity: 'opportunities',
  opportunities: 'opportunities',
  opp: 'opportunities',
  markets: 'markets',
  insights: 'insights',
  blog: 'blog',
}

const DEFAULT_KIND: Record<PostSection, string> = {
  'intern-junior': 'Job',
  'mid-senior': 'Job',
  opportunities: 'Opportunity',
  markets: 'News',
  insights: 'Analysis',
  blog: 'Article',
}

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Must be a valid http(s) URL')

const shortText = (max: number) => z.string().trim().max(max).optional()

export const jobIntakeSchema = z.object({
  title: z.string().trim().min(4, 'Title is too short (min 4 chars)').max(160, 'Title is too long (max 160 chars)'),
  // Company is optional — editorial posts (blog/insights/markets) have no
  // employer; the wizard and /addjob may both leave it out.
  company: z.string().trim().min(1, 'Company is too short').max(120).optional(),
  // Apply URL is optional for the same reason (analysis posts have nowhere to
  // "apply"); job listings should still provide one.
  applyUrl: httpUrl.optional(),
  section: z.enum(POST_SECTIONS),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  kind: shortText(40),
  location: shortText(120),
  workplace: shortText(40),
  employment: shortText(40),
  level: shortText(40),
  salary: shortText(80),
  stack: shortText(160),
  body: z.string().trim().max(50_000).optional(),
  /** Publish immediately instead of creating a review draft */
  publish: z.boolean().default(false),
  /** External dedupe key (feed id / source URL). Bots pass null. */
  sourceRef: z.string().trim().max(2048).optional(),
})

export type JobIntakeSpec = z.infer<typeof jobIntakeSchema>

export interface IntakeResultOk {
  ok: true
  post: {
    id: string
    slug: string
    title: string
    section: string
    status: string
    deduped: boolean
  }
}
export interface IntakeResultErr {
  ok: false
  code: 'validation' | 'duplicate' | 'error'
  message: string
  issues?: z.ZodIssue[]
}
export type IntakeResult = IntakeResultOk | IntakeResultErr

// ---------------------------------------------------------------------------
// /addjob argument parser
// ---------------------------------------------------------------------------
//
// Format (documented in /help and README):
//   /addjob Title | Company | Apply URL | Section | tags,comma,separated
//           [key=value]… [publish=yes]
//
// Optional key=value pairs, any order after the 5 pipes:
//   kind= location= workplace= employment= level= salary= stack= body= publish=yes
//
export function parseAddJobArgs(args: string): { ok: true; spec: JobIntakeSpec } | { ok: false; message: string } {
  const lines = args.trim().split('\n')
  const firstLine = lines[0] ?? ''
  const pipes = firstLine.split('|').map((s) => s.trim()).filter((s, i) => s.length > 0 || i < 5)
  const extras = lines.slice(1).join('\n').trim()

  if (pipes.length < 5) {
    return {
      ok: false,
      message:
        'Need 5 pipe-separated fields:\n/addjob Title | Company | Apply URL | Section | tags,comma\n' +
        'Optional extras on following lines: kind= location= workplace= employment= level= salary= stack= body= publish=yes',
    }
  }

  const [title, company, applyUrl, sectionRaw, tagsRaw] = pipes
  const section = SECTION_ALIASES[sectionRaw.toLowerCase()]
  if (!section) {
    return { ok: false, message: `Unknown section "${sectionRaw}". Valid: ${POST_SECTIONS.join(', ')} (or aliases: junior, mid, senior, opp…)` }
  }

  const kv: Record<string, string> = {}
  const kvRe = /^([a-z]+)=(.+)$/i
  for (const token of extras.split('\n')) {
    const t = token.trim()
    if (!t) continue
    const m = kvRe.exec(t)
    if (!m) continue
    kv[m[1].toLowerCase()] = m[2].trim()
  }

  const spec: JobIntakeSpec = {
    title,
    company: company || undefined,
    applyUrl: applyUrl || undefined,
    section,
    tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean),
    kind: kv.kind,
    location: kv.location,
    workplace: kv.workplace,
    employment: kv.employment,
    level: kv.level,
    salary: kv.salary,
    stack: kv.stack,
    body: kv.body,
    publish: /^(yes|true|1)$/i.test(kv.publish ?? ''),
    sourceRef: undefined,
  }

  const parsed = jobIntakeSchema.safeParse(spec)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('\n') }
  }
  return { ok: true, spec: parsed.data }
}

// ---------------------------------------------------------------------------
// Slug helper (local copy of the one in src/lib/posts.ts, which is Next-only)
// ---------------------------------------------------------------------------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '')
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || 'job'
  let candidate = root
  let suffix = 1
  while (await db.post.findUnique({ where: { slug: candidate } })) {
    suffix += 1
    candidate = `${root}-${suffix}`
    if (suffix > 50) {
      candidate = `${root}-${Date.now().toString(36)}`
      break
    }
  }
  return candidate
}

// ---------------------------------------------------------------------------
// Core write path
// ---------------------------------------------------------------------------

export async function createJobFromSpec(
  spec: JobIntakeSpec,
  meta: { source: JobSource; actor: string },
): Promise<IntakeResult> {
  const sourceRef = spec.sourceRef ?? spec.applyUrl

  // Dedupe: same source + same external reference must never create twice.
  // Human posts without any reference (no applyUrl) simply skip dedupe.
  if (sourceRef) {
    const existing = await db.post.findFirst({
      where: { source: meta.source, sourceRef },
      select: { id: true, slug: true, title: true, section: true, status: true },
    })
    if (existing) {
      await db.ingestionLog.create({
        data: {
          source: meta.source,
          action: 'job-duplicate-skipped',
          ok: true,
          detail: sourceRef.slice(0, 300),
          actor: meta.actor,
        },
      })
      return { ok: true, post: { ...existing, deduped: true } }
    }
  }

  const body =
    spec.body?.trim() ||
    [
      `Imported via ${meta.source} on ${new Date().toISOString().slice(0, 10)}.`,
      '',
      spec.company ? `**Company:** ${spec.company}` : null,
      spec.location ? `**Location:** ${spec.location}` : null,
      spec.salary ? `**Salary:** ${spec.salary}` : null,
      spec.stack ? `**Stack:** ${spec.stack}` : null,
      spec.applyUrl ? `Apply: ${spec.applyUrl}` : null,
    ]
      .filter((l) => l !== null)
      .join('\n')

  const status = spec.publish ? 'published' : 'draft'
  const slug = await uniqueSlug(spec.company ? `${spec.title}-${spec.company}` : spec.title)

  const post = await db.post.create({
    data: {
      slug,
      section: spec.section,
      kind: spec.kind ?? DEFAULT_KIND[spec.section],
      title: spec.title,
      company: spec.company ?? null,
      location: spec.location ?? null,
      workplace: spec.workplace ?? null,
      employment: spec.employment ?? null,
      level: spec.level ?? null,
      salary: spec.salary ?? null,
      stack: spec.stack ?? null,
      body,
      applyUrl: spec.applyUrl ?? null,
      originalUrl: meta.source === 'worker-feed' ? (sourceRef ?? null) : null,
      tags: spec.tags.join(','),
      status,
      source: meta.source,
      sourceRef: sourceRef ?? null,
      publishedAt: status === 'published' ? new Date() : null,
    },
    select: { id: true, slug: true, title: true, section: true, status: true },
  })

  await db.ingestionLog.create({
    data: {
      source: meta.source,
      action: 'job-created',
      ok: true,
      detail: `${post.id} · ${post.slug} · ${status}`,
      actor: meta.actor,
    },
  })

  // Publishing through a bot fires the premium dispatch immediately instead of
  // waiting for the next worker tick (failures never block the bot reply).
  if (status === 'published') {
    void dispatchPendingPosts().catch((err) => console.error('[intake] inline dispatch failed:', err))
  }

  return { ok: true, post: { ...post, deduped: false } }
}

// ---------------------------------------------------------------------------
// Publishing / listing / stats (bot commands)
// ---------------------------------------------------------------------------

export async function publishPostById(id: string): Promise<{ ok: boolean; message: string }> {
  const post = await db.post.findUnique({ where: { id }, select: { id: true, status: true, slug: true } })
  if (!post) return { ok: false, message: `No job with id ${id}` }
  if (post.status === 'published') return { ok: true, message: `Already published: /posts/${post.slug}` }
  if (post.status === 'deleted' || post.status === 'archived') {
    return { ok: false, message: `Job ${id} is ${post.status} and cannot be published` }
  }

  await db.post.update({ where: { id }, data: { status: 'published', publishedAt: new Date() } })
  await db.ingestionLog.create({ data: { source: 'web', action: 'job-published', detail: post.id } })

  void dispatchPendingPosts().catch((err) => console.error('[intake] inline dispatch failed:', err))
  return { ok: true, message: `Published: /${post.slug} — premium alerts are being dispatched.` }
}

export async function listRecentJobs(limit = 5) {
  return db.post.findMany({
    where: { status: { in: ['draft', 'published'] } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 10),
    select: { id: true, title: true, company: true, section: true, status: true, createdAt: true },
  })
}

export async function intakeStats() {
  const [published, drafts, waitlist, premium, pendingAlerts, failedAlerts] = await Promise.all([
    db.post.count({ where: { status: 'published' } }),
    db.post.count({ where: { status: 'draft' } }),
    db.waitlistEntry.count(),
    db.user.count({ where: { plan: 'premium', OR: [{ premiumUntil: null }, { premiumUntil: { gt: new Date() } }] } }),
    db.notificationLog.count({ where: { status: 'pending' } }),
    db.notificationLog.count({ where: { status: 'failed' } }),
  ])
  return { published, drafts, waitlist, premium, pendingAlerts, failedAlerts }
}

// ---------------------------------------------------------------------------
// Premium plan management (admin bot commands)
// ---------------------------------------------------------------------------

export async function grantPremium(
  email: string,
  days: number,
): Promise<{ ok: boolean; message: string }> {
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user) return { ok: false, message: `No user with email ${email}` }

  const base = user.premiumUntil && user.premiumUntil > new Date() ? user.premiumUntil : new Date()
  const premiumUntil = new Date(base.getTime() + days * 24 * 3600 * 1000)

  await db.user.update({ where: { id: user.id }, data: { plan: 'premium', premiumUntil } })
  await db.ingestionLog.create({
    data: { source: 'telegram', action: 'premium-granted', detail: `${email} +${days}d → ${premiumUntil.toISOString()}` },
  })
  return { ok: true, message: `${email} is premium until ${premiumUntil.toISOString().slice(0, 10)} (${days} days added).` }
}

export async function revokePremium(email: string): Promise<{ ok: boolean; message: string }> {
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user) return { ok: false, message: `No user with email ${email}` }

  await db.user.update({ where: { id: user.id }, data: { plan: 'free', premiumUntil: null } })
  await db.ingestionLog.create({
    data: { source: 'telegram', action: 'premium-revoked', detail: email },
  })
  return { ok: true, message: `Premium revoked for ${email}.` }
}
