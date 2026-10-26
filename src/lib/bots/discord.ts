/**
 * Discord helpers — two responsibilities:
 *
 * 1. Interaction webhook verification (Ed25519, per
 *    https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization)
 *    implemented with node:crypto — no external SDK required.
 * 2. Executing user-owned incoming webhooks to deliver premium job alerts
 *    into a subscriber's own Discord server.
 *
 * Runtime-agnostic (Next.js routes + standalone worker), like the whole
 * src/lib/bots package.
 */
import crypto from 'node:crypto'
import { botEnv } from './config'
import { decryptSecret } from './secretbox'

// ---------------------------------------------------------------------------
// Interaction signature verification
// ---------------------------------------------------------------------------

/** DER SPKI prefix that turns a raw 32-byte Ed25519 public key into a KeyObject. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function ed25519PublicKeyFromHex(hexKey: string): crypto.KeyObject | null {
  const raw = Buffer.from(hexKey, 'hex')
  if (raw.length !== 32) return null
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw])
  try {
    return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' })
  } catch {
    return null
  }
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * Verifies a Discord interaction request signature.
 * `rawBody` must be the unparsed request body (signature covers exact bytes).
 */
export function verifyDiscordSignature(
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
): { valid: boolean; reason?: string } {
  const publicKeyHex = botEnv.DISCORD_BOT_PUBLIC_KEY
  if (!publicKeyHex) return { valid: false, reason: 'discord_not_configured' }

  if (!signatureHex || !timestamp) return { valid: false, reason: 'missing_signature' }
  if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) return { valid: false, reason: 'malformed_signature' }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_CLOCK_SKEW_MS / 1000) {
    return { valid: false, reason: 'stale_timestamp' }
  }

  const key = ed25519PublicKeyFromHex(publicKeyHex)
  if (!key) return { valid: false, reason: 'bad_public_key' }

  const message = Buffer.from(`${timestamp}${rawBody}`, 'utf8')
  const signature = Buffer.from(signatureHex, 'hex')

  const ok = crypto.verify(null, message, key, signature)
  return ok ? { valid: true } : { valid: false, reason: 'signature_mismatch' }
}

// ---------------------------------------------------------------------------
// Interaction types & payloads (subset)
// ---------------------------------------------------------------------------

export const DISCORD_INTERACTION_TYPES = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const

export interface DiscordInteractionDataOption {
  name: string
  type: number
  value?: string | number | boolean
}

export interface DiscordInteraction {
  id: string
  type: number
  data?: {
    id: string
    name: string
    options?: DiscordInteractionDataOption[]
  }
  guild_id?: string
  member?: { user?: { id: string; username: string } }
  user?: { id: string; username: string }
}

/** ephemeral channel message with source (only the invoking user sees it) */
export function discordReply(content: string): unknown {
  return { type: 4, data: { content: content.slice(0, 2000), flags: 64 } }
}

export function discordOptionMap(interaction: DiscordInteraction): Map<string, string> {
  const map = new Map<string, string>()
  for (const opt of interaction.data?.options ?? []) {
    if (opt.value !== undefined) map.set(opt.name, String(opt.value))
  }
  return map
}

export function discordInteractionUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null
}

// ---------------------------------------------------------------------------
// Webhook execution (premium job alerts → subscriber's own server)
// ---------------------------------------------------------------------------

export interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

export async function executeDiscordWebhook(
  webhookUrl: string,
  content: string,
  embed?: { title: string; url?: string; description?: string; fields?: DiscordEmbedField[] },
): Promise<{ delivered: boolean; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Merklane Jobs',
        content: content.slice(0, 1500),
        embeds: embed
          ? [
              {
                title: embed.title.slice(0, 256),
                url: embed.url,
                description: embed.description?.slice(0, 2048),
                color: 0x54c4f5,
                fields: embed.fields?.slice(0, 10).map((f) => ({
                  name: f.name.slice(0, 256),
                  value: f.value.slice(0, 1024),
                  inline: f.inline ?? false,
                })),
              },
            ]
          : undefined,
      }),
    })

    // Discord answers 204 No Content on successful webhook delivery.
    if (res.status === 204) return { delivered: true }
    if (res.status === 429) {
      const retry = res.headers.get('retry-after')
      return { delivered: false, error: `rate_limited (retry after ${retry ?? '?'}s)` }
    }
    const body = await res.text().catch(() => '')
    return { delivered: false, error: `HTTP ${res.status} ${body.slice(0, 140)}` }
  } catch (err) {
    return { delivered: false, error: err instanceof Error ? err.message : 'network error' }
  }
}

/** Validates that a user-provided URL is a Discord incoming webhook. */
export function isDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    // https://discord.com/api/webhooks/{id}/{token}  (also discordapp.com)
    const hostOk = parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com'
    const pathOk = /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(parsed.pathname)
    return hostOk && pathOk
  } catch {
    return false
  }
}

/** Never log or display full webhook URLs — mask the token part. */
export function maskDiscordWebhook(url: string): string {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const id = parts[2] ?? 'unknown'
    return `discord.com/api/webhooks/${id}/•••••`
  } catch {
    return 'invalid-webhook-url'
  }
}

/** Display helper for stored (encrypted) webhook rows. */
export function maskStoredWebhook(urlEnc: string): string {
  try {
    return maskDiscordWebhook(decryptSecret(urlEnc))
  } catch {
    return 'discord.com/api/webhooks/•••/••••• (unreadable — AUTH_SECRET changed?)'
  }
}
