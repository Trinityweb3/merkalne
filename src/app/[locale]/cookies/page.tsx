import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Cookie Policy',
  description: 'Which cookies Merklane sets and how to control them.',
}

interface CookieRow {
  name: string
  purpose: string
  duration: string
  category: 'Strictly necessary' | 'Optional'
}

const COOKIES: CookieRow[] = [
  {
    name: 'merklane_session',
    purpose: 'Keeps you signed in. Contains an opaque token; only its hash exists server-side.',
    duration: '30 days (rolling)',
    category: 'Strictly necessary',
  },
  {
    name: 'merklane_csrf',
    purpose: 'Double-submit CSRF protection for forms and API mutations.',
    duration: '12 hours',
    category: 'Strictly necessary',
  },
  {
    name: 'merklane_locale',
    purpose: 'Remembers your interface language and text direction.',
    duration: '1 year',
    category: 'Strictly necessary',
  },
  {
    name: 'mv_<post-id>',
    purpose: 'View de-duplication: marks a post as counted for your browser (12h window).',
    duration: '12 hours',
    category: 'Strictly necessary',
  },
  {
    name: 'merklane_theme',
    purpose: 'Remembers your dark/light theme choice.',
    duration: '1 year',
    category: 'Strictly necessary',
  },
  {
    name: 'merklane_cookie_choice',
    purpose: 'Stores your cookie consent decision (localStorage, not a cookie).',
    duration: 'Until you clear it',
    category: 'Strictly necessary',
  },
]

export default function CookiesPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>Cookie Policy</h1>
          <p>
            Merklane sets a minimal set of strictly necessary cookies. Optional analytics and
            marketing cookies exist in the consent system but stay off until you allow them —
            closing the banner without choosing keeps them disabled.
          </p>
        </div>
      </div>

      <div className="table-wrap" style={{ marginBottom: 30 }}>
        <table>
          <thead>
            <tr>
              <th>Cookie</th>
              <th>Purpose</th>
              <th>Duration</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {COOKIES.map((row) => (
              <tr key={row.name}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <code>{row.name}</code>
                </td>
                <td className="muted">{row.purpose}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{row.duration}</td>
                <td>
                  <span className="badge">{row.category}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="narrow stack" style={{ gap: 22 }}>
        <section>
          <h2 style={{ fontSize: '1.25rem' }}>Changing your choice</h2>
          <p className="muted" style={{ lineHeight: 1.75, fontSize: '0.95rem' }}>
            Open the footer and use “Cookie settings” to review or change your consent at any
            time. Disabling optional cookies never blocks reading, searching or account features.
          </p>
        </section>
        <section>
          <h2 style={{ fontSize: '1.25rem' }}>Third-party cookies</h2>
          <p className="muted" style={{ lineHeight: 1.75, fontSize: '0.95rem' }}>
            Merklane itself sets no advertising or cross-site tracking cookies. If advertising
            campaigns launch later, their measurement cookies will only load for visitors who
            explicitly allowed marketing cookies.
          </p>
        </section>
      </div>
    </div>
  )
}
