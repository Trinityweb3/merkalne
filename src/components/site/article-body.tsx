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

// ---------------------------------------------------------------------------
// Metadata-line splitting (rendering-level fix for existing posts)
// ---------------------------------------------------------------------------

/**
 * Posts ingested from Telegram/webhooks often carry their metadata as ONE
 * pipe-separated line at the top of the body:
 *
 *   📍 Chandigarh | 🕐 Posted 1 day ago | 💰 Not specified | 🧑‍💻 Not
 *   specified | 🔗 Blockchain / Web3
 *
 * Rendered as-is that becomes a wall of text. At render time (never in the
 * DB, so existing posts are fixed without a migration) any line that BOTH
 * contains a metadata emoji AND at least one pipe is split on the pipes into
 * separate lines.
 *
 * SAFETY: the emoji guard is what keeps this from touching anything else —
 * markdown tables (| col | col |), links containing pipes and ordinary
 * sentences never contain 📍/🕐/💰/🧑‍💻/🔗, so they pass through untouched.
 */
const METADATA_EMOJI_RE = /[📍🕐💰🧑💻🔗]/

/**
 * Split one body line on `|` when it looks like a metadata line. The
 * segments are rejoined with a markdown HARD BREAK (two trailing spaces +
 * newline), so ReactMarkdown renders each on its own line inside one
 * paragraph — visually a tidy metadata list.
 */
function splitMetadataLine(line: string): string {
  if (!line.includes('|') || !METADATA_EMOJI_RE.test(line)) return line
  const parts = line
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length <= 1) return line
  return parts.join('  \n')
}

/** Preprocess the whole body: metadata lines → hard-broken lines. */
export function splitMetadataLines(body: string): string {
  return body
    .split('\n')
    .map((line) => splitMetadataLine(line))
    .join('\n')
}

export function ArticleBody({ body }: { body: string }) {
  return (
    <div className="article-body">
      <ReactMarkdown components={components}>{splitMetadataLines(body)}</ReactMarkdown>
    </div>
  )
}
