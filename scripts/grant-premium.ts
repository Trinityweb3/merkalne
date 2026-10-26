/**
 * Grant or revoke Merklane Premium for a user (CLI).
 *
 * Until the stage-2 billing provider launches, premium is granted manually —
 * by this script, or live via the admin Telegram bot (/grant, /revoke).
 *
 *   bun scripts/grant-premium.ts user@email.com 30     # grant/extend 30 days
 *   bun scripts/grant-premium.ts user@email.com revoke # revoke
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const [email, actionRaw] = process.argv.slice(2)
  if (!email || !actionRaw) {
    console.error('Usage:\n  bun scripts/grant-premium.ts <email> <days|revoke>')
    process.exit(1)
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user) {
    console.error(`No user with email ${email}`)
    process.exit(1)
  }

  if (actionRaw.toLowerCase() === 'revoke') {
    await prisma.user.update({ where: { id: user.id }, data: { plan: 'free', premiumUntil: null } })
    console.log(`✅ Premium revoked for ${email}`)
    return
  }

  const days = Number(actionRaw)
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    console.error('Days must be a number between 1 and 3650 (or "revoke").')
    process.exit(1)
  }

  const base = user.premiumUntil && user.premiumUntil > new Date() ? user.premiumUntil : new Date()
  const premiumUntil = new Date(base.getTime() + days * 24 * 3600 * 1000)
  await prisma.user.update({ where: { id: user.id }, data: { plan: 'premium', premiumUntil } })
  await prisma.ingestionLog.create({
    data: { source: 'web', action: 'premium-granted', detail: `${email} +${days}d → ${premiumUntil.toISOString()}`, actor: 'cli' },
  })
  console.log(`✅ ${email} is premium until ${premiumUntil.toISOString().slice(0, 10)} (+${days} days)`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
