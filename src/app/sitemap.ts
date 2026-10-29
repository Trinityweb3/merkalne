import type { MetadataRoute } from 'next'
import { db } from '@/lib/db'
import { EDITORIAL_SECTIONS } from '@/lib/constants'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

/**
 * Sitemap: published editorial posts only. Blog is excluded by design
 * (noindex policy) along with private/profile routes.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env.APP_URL

  const staticRoutes: MetadataRoute.Sitemap = [
    '',
    '/search',
    '/about',
    '/premium',
    '/contact',
    '/terms',
    '/privacy',
    '/cookies',
    '/risk',
    '/recruiter',
    ...EDITORIAL_SECTIONS.map((s) => `/${s}`),
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: 'daily' as const,
    priority: path === '' ? 1 : 0.7,
  }))

  const posts = await db.post
    .findMany({
      where: { status: 'published', section: { not: 'blog' } },
      select: { slug: true, section: true, updatedAt: true },
      take: 2000,
    })
    .catch(() => [])

  const postRoutes: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${base}/${post.section}/${post.slug}`,
    lastModified: post.updatedAt,
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }))

  return [...staticRoutes, ...postRoutes]
}
