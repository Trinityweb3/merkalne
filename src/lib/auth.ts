import 'server-only'
import bcrypt from 'bcryptjs'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { randomToken, sha256 } from '@/lib/csrf'
import { env } from '@/lib/env'

/**
 * Authentication core.
 *
 * Sessions are opaque 256-bit random tokens delivered in an HttpOnly cookie.
 * Only the SHA-256 hash is persisted, so a database dump cannot be replayed.
 * Every request re-validates the session server side, which enables instant
 * revocation ("sign out everywhere") — impossible with pure stateless JWTs.
 */

export const SESSION_COOKIE = 'merklane_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const SESSION_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // refresh when <7 days left

const BCRYPT_ROUNDS = 12

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export interface SessionUser {
  id: string
  email: string
  name: string | null
  image: string | null
  role: string
  /// Phase-4 granular permission tier (owner | editor | analyst | billing) —
  /// see src/lib/ads/permissions.ts. Read from the DB row via the session;
  /// never client-supplied.
  adminRole: string
  plan: string
  premiumUntil: Date | null
  emailVerified: Date | null
  hasPassword: boolean
  bio: string | null
  links: string | null
  createdAt: Date
}

export interface SessionInfo {
  id: string
  tokenHash: string
  userAgent: string | null
  ip: string | null
  createdAt: Date
  lastUsedAt: Date
  expiresAt: Date
  current?: boolean
}

export interface AuthContext {
  user: SessionUser
  sessionId: string
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createSession(userId: string, meta?: { userAgent?: string | null; ip?: string | null }) {
  const token = randomToken(32)
  const tokenHash = sha256(token)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await db.session.create({
    data: {
      tokenHash,
      userId,
      expiresAt,
      userAgent: meta?.userAgent?.slice(0, 250) ?? null,
      ip: meta?.ip ?? null,
    },
  })

  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })

  return { token, expiresAt }
}

export async function getSession(): Promise<AuthContext | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null
  return getSessionFromToken(token)
}

export async function getSessionFromToken(token: string): Promise<AuthContext | null> {
  const tokenHash = sha256(token)
  const session = await db.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  })

  if (!session) return null
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined)
    return null
  }

  // Rolling refresh — extend when less than a week remains.
  if (session.expiresAt.getTime() - Date.now() < SESSION_REFRESH_THRESHOLD_MS) {
    const newExpiry = new Date(Date.now() + SESSION_TTL_MS)
    await db.session
      .update({ where: { id: session.id }, data: { expiresAt: newExpiry, lastUsedAt: new Date() } })
      .catch(() => undefined)
    // Best-effort cookie extension: during a page render Next only allows
    // cookie writes in Server Actions / Route Handlers — a throw here would
    // 500 the page (profile, ads dashboard, …) for users in the refresh
    // window. The DB expiry above is the source of truth; the cookie
    // maxAge catching up on the next action/route call is fine.
    try {
      const store = await cookies()
      store.set(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      })
    } catch {
      // Render context — skip; the session row was already extended.
    }
  }

  return {
    sessionId: session.id,
    user: toSessionUser(session.user),
  }
}

export function toSessionUser(user: {
  id: string
  email: string
  name: string | null
  image: string | null
  role: string
  adminRole?: string | null
  plan: string
  premiumUntil: Date | null
  emailVerified: Date | null
  passwordHash: string | null
  bio: string | null
  links: string | null
  createdAt: Date
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role: user.role,
    adminRole: user.adminRole ?? 'owner',
    plan: user.plan,
    premiumUntil: user.premiumUntil,
    emailVerified: user.emailVerified,
    hasPassword: Boolean(user.passwordHash),
    bio: user.bio,
    links: user.links,
    createdAt: user.createdAt,
  }
}

export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token) {
    await db.session
      .delete({ where: { tokenHash: sha256(token) } })
      .catch(() => undefined)
  }
  store.delete(SESSION_COOKIE)
}

export async function listSessions(userId: string, currentSessionId: string): Promise<SessionInfo[]> {
  const sessions = await db.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  })
  return sessions.map((s) => ({
    id: s.id,
    tokenHash: s.tokenHash,
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt,
    current: s.id === currentSessionId,
  }))
}

export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const result = await db.session.deleteMany({ where: { id: sessionId, userId } })
  return result.count > 0
}

export async function revokeAllOtherSessions(userId: string, currentSessionId: string): Promise<number> {
  const result = await db.session.deleteMany({
    where: { userId, NOT: { id: currentSessionId } },
  })
  return result.count
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await db.session.deleteMany({ where: { userId } })
  return result.count
}

// ---------------------------------------------------------------------------
// One-time tokens (email verification / magic links / password reset)
// ---------------------------------------------------------------------------

export type TokenType = 'email_verify' | 'magic_link' | 'password_reset'

export const TOKEN_TTL: Record<TokenType, number> = {
  email_verify: 24 * 60 * 60 * 1000,
  magic_link: 15 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
}

/** Issues a single-use token and returns the raw (unhashed) value for emailing. */
export async function issueToken(identifier: string, type: TokenType): Promise<string> {
  // Invalidate previous outstanding tokens of the same type for this identifier
  // so only the newest email link works.
  await db.verificationToken.updateMany({
    where: { identifier, type, usedAt: null },
    data: { usedAt: new Date() },
  })

  const raw = randomToken(32)
  await db.verificationToken.create({
    data: {
      identifier: identifier.toLowerCase(),
      tokenHash: sha256(raw),
      type,
      expiresAt: new Date(Date.now() + TOKEN_TTL[type]),
    },
  })
  return raw
}

export interface ConsumeTokenResult {
  ok: boolean
  reason?: 'not_found' | 'expired' | 'used'
}

export async function consumeToken(raw: string, type: TokenType): Promise<ConsumeTokenResult> {
  const tokenHash = sha256(raw)
  const record = await db.verificationToken.findUnique({ where: { tokenHash } })
  if (!record || record.type !== type) return { ok: false, reason: 'not_found' }
  if (record.usedAt) return { ok: false, reason: 'used' }
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' }

  await db.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } })
  return { ok: true }
}

export async function peekToken(raw: string, type: TokenType) {
  const record = await db.verificationToken.findUnique({ where: { tokenHash: sha256(raw) } })
  if (!record || record.type !== type) return null
  return {
    identifier: record.identifier,
    usedAt: record.usedAt,
    expired: record.expiresAt.getTime() < Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Find-or-create helpers shared by OAuth & magic-link flows
// ---------------------------------------------------------------------------

export async function findUserByEmail(email: string) {
  return db.user.findUnique({ where: { email: email.toLowerCase() } })
}

export async function createUserFromEmail(email: string, opts?: { name?: string | null; image?: string | null; emailVerified?: boolean }) {
  return db.user.create({
    data: {
      email: email.toLowerCase(),
      name: opts?.name ?? null,
      image: opts?.image ?? null,
      emailVerified: opts?.emailVerified ? new Date() : null,
    },
  })
}

export function displayName(user: { name: string | null; email: string }): string {
  return user.name?.trim() || user.email.split('@')[0]
}
