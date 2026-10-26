import { Link } from '@/i18n/navigation'

/**
 * Numbered pagination (1, 2, 3 …) matching the search contract: up to 10
 * results per page with direct page links and prev/next controls.
 */
export function Pagination({
  page,
  totalPages,
  makeHref,
}: {
  page: number
  totalPages: number
  makeHref: (page: number) => string
}) {
  if (totalPages <= 1) return null

  // Windowed page numbers: 1 … (p-1) p (p+1) … last
  const pages: (number | '…')[] = []
  const window = new Set([1, 2, totalPages - 1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages))
  const sorted = [...window].sort((a, b) => a - b)
  let prev = 0
  for (const p of sorted) {
    if (p - prev > 1) pages.push('…')
    pages.push(p)
    prev = p
  }

  return (
    <nav className="pagination row wrap" aria-label="Pagination">
      {page > 1 ? (
        <Link href={makeHref(page - 1)} className="chip" aria-label="Previous page">
          ← Prev
        </Link>
      ) : null}
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="muted small" style={{ padding: '0 4px' }}>
            …
          </span>
        ) : (
          <Link
            key={p}
            href={makeHref(p)}
            className={`chip ${p === page ? 'selected' : ''}`}
            aria-label={`Page ${p}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </Link>
        ),
      )}
      {page < totalPages ? (
        <Link href={makeHref(page + 1)} className="chip" aria-label="Next page">
          Next →
        </Link>
      ) : null}
    </nav>
  )
}
