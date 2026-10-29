import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { db } from '@/lib/db'
import { telegramEnabled } from '@/lib/bots/config'
import { isPremiumActive } from '@/lib/premium/plan'
import { AlertsManager } from '@/components/site/alerts-manager'

export const metadata: Metadata = {
  title: 'Job alerts — Merklane Premium',
  description:
    'Choose where new Merklane job postings reach you: email or a Telegram DM. Premium subscribers are notified the moment a posting is published.',
  robots: { index: false, follow: false },
}

/**
 * /alerts — premium job-alert channel management.
 *
 * Server-rendered with the user's current link state; every mutation goes
 * through the session + CSRF protected /api/bots/* endpoints.
 */
export default async function AlertsPage() {
  const session = await getSession()
  if (!session) redirect('/auth?mode=login&next=/alerts')

  const telegramLink = await db.telegramLink.findUnique({ where: { userId: session.user.id } })

  // Shared entitlement gate — Premium OR Premium+, never free.
  const premiumActive = isPremiumActive(session.user)

  return (
    <AlertsManager
      premium={{
        active: premiumActive,
        until: session.user.premiumUntil ? session.user.premiumUntil.toISOString().slice(0, 10) : null,
        email: session.user.email,
      }}
      telegram={{
        configured: telegramEnabled(),
        linked: Boolean(telegramLink?.chatId),
        username: telegramLink?.username ?? null,
        notificationsEnabled: telegramLink ? telegramLink.notificationsEnabled : true,
      }}
    />
  )
}
