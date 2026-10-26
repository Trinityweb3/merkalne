import { NextResponse } from 'next/server'
import { jsonError, jsonOk } from '@/lib/api'
import { rateLimit } from '@/lib/rate-limit'
import { discordAdminIds, discordIngestionEnabled } from '@/lib/bots/config'
import {
  DISCORD_INTERACTION_TYPES,
  discordInteractionUserId,
  discordOptionMap,
  discordReply,
  verifyDiscordSignature,
  type DiscordInteraction,
} from '@/lib/bots/discord'
import { createJobFromSpec, listRecentJobs, publishPostById } from '@/lib/bots/intake'
import { POST_SECTIONS, type PostSection } from '@/lib/constants'

/**
 * POST /api/webhooks/discord — Discord interactions endpoint (slash commands).
 *
 * Admin-facing Discord twin of the Telegram ingestion bot:
 *   /addjob  title company url section [tags body level employment workplace salary location stack publish]
 *   /jobs    — recent postings
 *   /publish <id>
 *
 * Security model (server-to-server):
 *   • every request is Ed25519-verified against DISCORD_BOT_PUBLIC_KEY
 *     (X-Signature-Ed25519 + X-Signature-Timestamp, 5-minute freshness window)
 *   • write commands restricted to DISCORD_ADMIN_USER_IDS
 *   • responses are ephemeral (flags=64) — job data never spams the channel
 *
 * Register the commands once with: bun scripts/register-discord-commands.ts
 */

function sectionFromOption(value: string | undefined): PostSection {
  const aliases: Record<string, PostSection> = {
    junior: 'intern-junior',
    intern: 'intern-junior',
    'intern-junior': 'intern-junior',
    mid: 'mid-senior',
    senior: 'mid-senior',
    'mid-senior': 'mid-senior',
    opportunities: 'opportunities',
    opp: 'opportunities',
    markets: 'markets',
    insights: 'insights',
    blog: 'blog',
  }
  return aliases[(value ?? '').toLowerCase()] ?? 'mid-senior'
}

export async function POST(req: Request) {
  if (!discordIngestionEnabled()) {
    return jsonError('Discord bot is not configured (DISCORD_APPLICATION_ID / DISCORD_BOT_PUBLIC_KEY).', 503, { code: 'bot_not_configured' })
  }

  // Signature verification must see the RAW body bytes.
  const rawBody = await req.text()
  const verification = verifyDiscordSignature(
    rawBody,
    req.headers.get('x-signature-ed25519'),
    req.headers.get('x-signature-timestamp'),
  )
  if (!verification.valid) {
    return jsonError('Invalid request signature', 401, { code: verification.reason })
  }

  let interaction: DiscordInteraction
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  // Discord handshake.
  if (interaction.type === DISCORD_INTERACTION_TYPES.PING) {
    // Discord requires the RAW {type:1} object — no JSON envelope.
    return NextResponse.json({ type: 1 })
  }
  if (interaction.type !== DISCORD_INTERACTION_TYPES.APPLICATION_COMMAND) {
    return NextResponse.json(discordReply('Unsupported interaction type.'))
  }

  const userId = discordInteractionUserId(interaction) ?? 'unknown'
  const rl = rateLimit(`discord-webhook:${userId}`, 20, 60_000)
  if (!rl.ok) return NextResponse.json(discordReply('⏳ Slow down — try again in a minute.'))

  const isAdmin = discordAdminIds().has(userId)
  const name = interaction.data?.name ?? ''
  const options = discordOptionMap(interaction)

  try {
    switch (name) {
      case 'addjob': {
        if (!isAdmin) return NextResponse.json(discordReply('⛔ Admin commands require your Discord id in DISCORD_ADMIN_USER_IDS.'))

        const title = options.get('title')
        const company = options.get('company')
        const applyUrl = options.get('url')
        if (!title || !company || !applyUrl) {
          return NextResponse.json(discordReply('⚠️ title, company and url are required.'))
        }

        const result = await createJobFromSpec(
          {
            title,
            company,
            applyUrl,
            section: sectionFromOption(options.get('section')),
            tags: (options.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
            kind: options.get('kind') ?? undefined,
            location: options.get('location'),
            workplace: options.get('workplace'),
            employment: options.get('employment'),
            level: options.get('level'),
            salary: options.get('salary'),
            stack: options.get('stack'),
            body: options.get('body') ?? undefined,
            publish: /^(yes|true|1)$/i.test(options.get('publish') ?? ''),
            sourceRef: applyUrl,
          },
          { source: 'discord', actor: `discord:${userId}` },
        )

        if (!result.ok) return NextResponse.json(discordReply(`⚠️ ${result.message}`))
        return NextResponse.json(
          discordReply(
            result.post.deduped
              ? `♻️ Already in the database: **${result.post.title}** (${result.post.status})`
              : `✅ ${result.post.status === 'published' ? 'Published' : 'Draft created'}: **${result.post.title}**\n` +
                  `id: \`${result.post.id}\` · section: ${result.post.section}` +
                  (result.post.status === 'draft' ? `\nPublish with \`/publish ${result.post.id}\`` : '\nPremium alerts are being dispatched.'),
          ),
        )
      }

      case 'jobs': {
        if (!isAdmin) return NextResponse.json(discordReply('⛔ Admin command.'))
        const jobs = await listRecentJobs(5)
        if (jobs.length === 0) return NextResponse.json(discordReply('No postings yet — add the first with /addjob.'))
        return NextResponse.json(
          discordReply(jobs.map((j) => `${j.status === 'draft' ? '📝' : '🟢'} \`${j.id.slice(-6)}\` ${j.title} — ${j.company ?? '?'} (${j.section})`).join('\n')),
        )
      }

      case 'publish': {
        if (!isAdmin) return NextResponse.json(discordReply('⛔ Admin command.'))
        const id = options.get('id')
        if (!id) return NextResponse.json(discordReply('⚠️ Usage: /publish <job id>'))
        const res = await publishPostById(id)
        return NextResponse.json(discordReply(res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`))
      }

      default:
        return NextResponse.json(discordReply(`Unknown command \`${name}\`.`))
    }
  } catch (err) {
    console.error('[discord-webhook] handler error:', err)
    return NextResponse.json(discordReply('⚠️ Something went wrong — check the server logs.'))
  }
}

/** GET → wiring status. */
export async function GET() {
  return jsonOk({
    configured: discordIngestionEnabled(),
    adminConfigured: discordAdminIds().size > 0,
    interactions: 'POST /api/webhooks/discord',
    sections: POST_SECTIONS,
  })
}
