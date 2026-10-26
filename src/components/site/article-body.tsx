import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'

/**
 * Sanitised post body renderer.
 *
 * React-markdown never renders raw HTML by default, so user content cannot
 * inject scripts — the XSS-safe way to render rich text. The component
 * whitelist below is the full allowed surface; links are forced to open in a
 * new tab with `noopener noreferrer` and only http(s) schemes survive.
 */

function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

const components: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href)
    if (!safe) return <>{children}</>
    const external = !safe.startsWith('/')
    return (
      <a
        href={safe}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
      >
        {children}
      </a>
    )
  },
}

export function ArticleBody({ body }: { body: string }) {
  return (
    <div className="article-body">
      <ReactMarkdown components={components}>{body}</ReactMarkdown>
    </div>
  )
}
