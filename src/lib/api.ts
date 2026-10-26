import 'server-only'
import { NextResponse } from 'next/server'
import { ZodIssue } from 'zod'
import { CsrfError } from '@/lib/csrf'

/** Consistent JSON envelope for every API route. */
export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, { status: 200, ...init })
}

export function jsonCreated<T>(data: T) {
  return NextResponse.json({ ok: true, data }, { status: 201 })
}

export function jsonError(message: string, status = 400, extra?: { issues?: ZodIssue[]; code?: string }) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status })
}

export function jsonRateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { ok: false, error: 'Too many requests. Please slow down and try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  )
}

/** Maps thrown errors to safe HTTP responses (never leaks internals). */
export function handleRouteError(err: unknown) {
  if (err instanceof CsrfError) {
    return jsonError(err.message, 403, { code: 'csrf' })
  }
  if (err instanceof HttpError) {
    return jsonError(err.message, err.status, { code: err.code })
  }
  console.error('[api] Unhandled error:', err)
  return jsonError('Internal server error', 500)
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg, 'unauthorized')
export const forbidden = (msg = 'You do not have permission to perform this action') =>
  new HttpError(403, msg, 'forbidden')
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found')
