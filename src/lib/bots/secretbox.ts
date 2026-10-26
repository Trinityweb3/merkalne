/**
 * Symmetric encryption for secrets stored in the database (currently: user
 * Discord webhook URLs). AES-256-GCM, key derived from AUTH_SECRET with
 * scrypt — rotating AUTH_SECRET invalidates stored ciphertexts (documented in
 * POST-EXPORT-GUIDE.md), but nothing is ever stored in plaintext.
 */
import crypto from 'node:crypto'
import { botEnv } from './config'

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const
const KEY_CONTEXT = 'merklane:discord-webhook:v1'

let cachedKey: Buffer | null = null

function derivedKey(): Buffer {
  if (cachedKey) return cachedKey
  const secret = botEnv.AUTH_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET must be set (>=16 chars) to store Discord webhooks securely. ' +
        'Generate one with: openssl rand -base64 48',
    )
  }
  cachedKey = crypto.scryptSync(secret, KEY_CONTEXT, 32, SCRYPT_PARAMS)
  return cachedKey
}

/** Returns `v1.<iv>.<ciphertext>.<authTag>` — all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.')
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, dataB64, tagB64] = payload.split('.')
  if (version !== 'v1' || !ivB64 || !dataB64 || !tagB64) {
    throw new Error('Unrecognised ciphertext format')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(ivB64, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
