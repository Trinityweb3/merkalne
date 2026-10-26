import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The rules for using Merklane.',
}

const SECTIONS = [
  {
    title: '1. What Merklane is',
    body: [
      'Merklane is an information service that collects Web3, crypto, blockchain and AI related jobs, opportunities, market signals and educational material in one place. We are not an employer, recruiter, exchange, custodian or financial adviser, and we never take custody of user funds.',
      'Unless explicitly stated, material on Merklane originates from third parties. Each post links to its original source where available, and the source remains the authoritative version.',
    ],
  },
  {
    title: '2. Your account',
    body: [
      'You may browse without an account. Registered users get bookmarks, comments, reactions and free Blog publishing. You are responsible for keeping your credentials safe; notify us immediately about unauthorised access.',
      'One person, one account. Automated registration, scraping or spamming through the API is prohibited and rate limited. We may suspend accounts that abuse the service.',
    ],
  },
  {
    title: '3. User content',
    body: [
      'You keep ownership of everything you publish on Merklane. By publishing, you grant us the non-exclusive right to store, display and translate your material as part of operating the service.',
      'You may edit or remove your posts at any time. Removed posts disappear from public views; archival copies may persist in backups for a limited period.',
    ],
  },
  {
    title: '4. Acceptable use',
    body: [
      'Do not publish illegal content, malware, scams, phishing, deliberately false information, or material that impersonates others. Do not attempt to bypass access controls, rate limits or the moderation system.',
      'Reports are reviewed by moderators. A report alone never removes content — decisions are made with the reported material open.',
    ],
  },
  {
    title: '5. No financial advice',
    body: [
      'Nothing on Merklane — including market signals, token mentions and analysis — is financial, investment, legal or tax advice. Figures and charts may be delayed, incomplete or wrong. Always verify against primary sources before acting.',
    ],
  },
  {
    title: '6. Liability',
    body: [
      'The service is provided “as is”. To the maximum extent permitted by applicable law, Merklane’s liability is limited as described in the governing law section, and we are not liable for indirect or consequential damages arising from third-party content.',
    ],
  },
  {
    title: '7. Changes',
    body: [
      'We may update these terms as the service evolves. Material changes will be announced on the site. Continuing to use Merklane after a change means you accept the updated terms.',
    ],
  },
]

export default function TermsPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>Terms of Service</h1>
          <p>Last updated: October 2026 · This template text describes the operating service and its operator.</p>
        </div>
      </div>
      <div className="narrow stack" style={{ gap: 28 }}>
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h2 style={{ fontSize: '1.25rem', marginBottom: 10 }}>{section.title}</h2>
            {section.body.map((p, i) => (
              <p key={i} className="muted" style={{ lineHeight: 1.75, fontSize: '0.95rem' }}>
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
