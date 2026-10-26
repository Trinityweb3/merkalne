/**
 * External job-feed ingestion — the "automated scraper / API worker" half of
 * the Job Ingestion Bot.
 *
 * Supports two feed shapes:
 *
 * 1. Remotive public API (https://remotive.com/api/remote-jobs?limit=N)
 *      { jobs: [{ id, url, title, company_name, category, job_type,
 *                candidate_required_location, salary, description, ... }] }
 *
 * 2. Generic "Merklane feed" (documented in README) — a JSON file you host
 *    anywhere, so recruiters/partners can push vacancies without Telegram:
 *      { jobs: [{ title, company, url, section?, tags?, location?, workplace?,
 *                 employment?, level?, salary?, stack?, body?, publish? }] }
 *
 * Every item is deduped by (source='worker-feed', sourceRef=url) and lands as
 * a DRAFT for admin review unless AUTO_PUBLISH_INGESTED_JOBS=true.
 *
 * HTML in feed descriptions is stripped — post bodies are markdown-lite and
 * rendered with react-markdown, never raw HTML.
 */
import { db } from '../db'
import { createJobFromSpec, type JobIntakeSpec } from './intake'
import type { PostSection } from '../constants'

export interface FeedIngestStats {
  feedUrl: string
  fetched: number
  created: number
  duplicates: number
  invalid: number
  published: boolean
  error?: string
}

const MAX_BODY_CHARS = 4000

/** Strips HTML tags/entities down to plain markdown-ish text. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Section inference for feeds that do not specify one. */
function inferSection(input: {
  title?: string
  category?: string
  level?: string
  employment?: string
}): PostSection {
  const hay = `${input.title ?? ''} ${input.category ?? ''} ${input.level ?? ''} ${input.employment ?? ''}`.toLowerCase()
  if (/(intern|junior|graduate|trainee|entry[- ]level)/.test(hay)) return 'intern-junior'
  if (/(senior|lead|principal|staff|director|head of|vp\b)/.test(hay)) return 'mid-senior'
  if (/(bounty|quest|testnet|airdrop|campaign|hackathon|grant)/.test(hay)) return 'opportunities'
  return 'mid-senior' // safe default for generic job listings
}

function normaliseTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean).slice(0, 12)
  }
  if (typeof input === 'string') {
    return input.split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean).slice(0, 12)
  }
  return []
}

interface RawFeedJob {
  // Remotive
  id?: number | string
  url?: string
  title?: string
  company_name?: string
  category?: string
  job_type?: string
  candidate_required_location?: string
  salary?: string
  description?: string
  // Generic
  company?: string
  section?: string
  tags?: string[] | string
  location?: string
  workplace?: string
  employment?: string
  level?: string
  stack?: string
  body?: string
  publish?: boolean
}

export async function ingestFeed(feedUrl: string, autoPublish: boolean): Promise<FeedIngestStats> {
  const stats: FeedIngestStats = {
    feedUrl,
    fetched: 0,
    created: 0,
    duplicates: 0,
    invalid: 0,
    published: autoPublish,
  }

  let payload: { jobs?: RawFeedJob[] }
  try {
    const res = await fetch(feedUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'MerklaneBot/1.0 (+https://merklane.example)' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    payload = (await res.json()) as { jobs?: RawFeedJob[] }
  } catch (err) {
    stats.error = err instanceof Error ? err.message : 'fetch_failed'
    await db.ingestionLog.create({
      data: { source: 'worker-feed', action: 'feed-fetch-failed', ok: false, detail: `${feedUrl} — ${stats.error}` },
    })
    return stats
  }

  const jobs = Array.isArray(payload.jobs) ? payload.jobs.slice(0, 200) : []
  stats.fetched = jobs.length

  for (const raw of jobs) {
    const url = raw.url?.trim()
    const title = raw.title?.trim()
    const company = (raw.company_name ?? raw.company)?.trim()
    if (!url || !title || !company) {
      stats.invalid += 1
      continue
    }

    const section = (raw.section as PostSection | undefined) ?? inferSection(raw)
    const body =
      raw.body?.trim() ||
      (raw.description ? htmlToText(raw.description).slice(0, MAX_BODY_CHARS) : undefined)

    const spec: JobIntakeSpec = {
      title: title.slice(0, 160),
      company: company.slice(0, 120),
      applyUrl: url,
      section,
      tags: normaliseTags(raw.tags ?? raw.category),
      kind: section === 'opportunities' ? 'Opportunity' : 'Job',
      location: raw.location?.slice(0, 120) ?? raw.candidate_required_location?.slice(0, 120),
      workplace: raw.workplace?.slice(0, 40),
      employment:
        raw.employment?.slice(0, 40) ??
        (raw.job_type
          ? raw.job_type
              .replace(/_/g, '-')
              .replace(/^\w/, (c) => c.toUpperCase())
          : undefined),
      level: raw.level?.slice(0, 40),
      salary: raw.salary?.slice(0, 80),
      stack: raw.stack?.slice(0, 160),
      body,
      publish: autoPublish || raw.publish === true,
      sourceRef: url,
    }

    const result = await createJobFromSpec(spec, {
      source: 'worker-feed',
      actor: `feed:${new URL(feedUrl).hostname}`,
    })

    if (result.ok) {
      if (result.post.deduped) {
        stats.duplicates++
      } else {
        stats.created++
      }
    } else {
      stats.invalid++
    }
  }

  await db.ingestionLog.create({
    data: {
      source: 'worker-feed',
      action: 'feed-ingested',
      ok: !stats.error,
      detail: `${feedUrl} — fetched ${stats.fetched}, created ${stats.created}, dup ${stats.duplicates}, invalid ${stats.invalid}`,
    },
  })

  return stats
}
