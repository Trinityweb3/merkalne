import type { MetadataRoute } from 'next'
import { env } from '@/lib/env'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Blog stays crawlable so bots can see the noindex header — blocking
        // it in robots.txt would hide the very signal we want them to read.
        disallow: ['/profile', '/auth', '/api/'],
      },
    ],
    sitemap: `${env.APP_URL}/sitemap.xml`,
  }
}
