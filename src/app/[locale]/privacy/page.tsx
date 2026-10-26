import type { Metadata } from 'next'
import { statsEnv } from '@/lib/stats/config'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'What Merklane stores, why, and the controls you have.',
}

const SECTIONS = [
  {
    title: 'What we collect',
    body: [
      'Account data: your email address, display name, profile picture (if provided via Google or GitHub), optional bio and links, and a securely hashed password when you set one. We never store passwords in readable form.',
      'Usage data: posts, comments, reactions, bookmarks, reports and view counts tied to your account. Sessions store the browser user-agent and IP address so the Security page can show you active devices.',
      `Anonymous statistics: each page view is counted once per visitor per ${statsEnv.TRACK_DEDUPE_MINUTES} minutes using an irreversible fingerprint of IP and browser (a keyed hash — the original values cannot be recovered from it), plus the page section and, when the network provides it, a country code. No account, raw IP or user-agent string is attached to these counts, and they are only ever published as daily aggregates on the About page. Requests with Do-Not-Track enabled are not counted at all.`,
      'Operational data: server logs with request timestamps and coarse error information, kept for debugging and abuse prevention.',
    ],
  },
  {
    title: 'What we never collect',
    body: [
      'We do not read or store your private messages between platforms, we do not require wallet connections, and we do not attach trackers to your browsing outside Merklane. The statistics beacon stores no raw IP addresses and sets no cookies of its own. Optional analytics cookies stay disabled until you explicitly allow them in the cookie banner.',
    ],
  },
  {
    title: 'Why we process data',
    body: [
      'To operate the service: authentication, sessions, showing your bookmarks across devices, delivering email you requested (verification, magic links, password resets, waitlist confirmations).',
      'To keep the service safe: rate limiting, spam and scam prevention, moderation queues and audit records.',
    ],
  },
  {
    title: 'Third parties',
    body: [
      'Email delivery runs through Resend, which processes addresses strictly to send the messages you triggered. OAuth sign-in runs through Google and GitHub — those providers see only the authentication flow, not your Merklane activity.',
    ],
  },
  {
    title: 'Your controls',
    body: [
      'Export or correct your profile data from the profile page. Delete your posts at any time. Revoke individual sessions or all other sessions from Security. For full account deletion, contact us — we remove personal data and keep only what retention law requires.',
    ],
  },
  {
    title: 'Retention',
    body: [
      'Sessions expire automatically (30 days idle) and can be revoked instantly. Verification tokens expire between 15 minutes and 24 hours and are single-use. Backups rotate on a fixed schedule.',
    ],
  },
]

export default function PrivacyPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>Privacy Policy</h1>
          <p>Last updated: October 2026 · Describes the live service and connected providers.</p>
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
