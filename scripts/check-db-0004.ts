/** Verify the sandbox SQLite DB has the 0004 migration objects (via Prisma). */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const stateRows = await db.telegramAdminState.findMany()
const post = await db.post.findFirst({ select: { translations: true } })
console.log('TelegramAdminState table: YES (query ok,', stateRows.length, 'rows)')
console.log('Post.translations column: YES (query ok, sample =', JSON.stringify(post?.translations ?? null).slice(0, 80) + ')')
await db.$disconnect()
