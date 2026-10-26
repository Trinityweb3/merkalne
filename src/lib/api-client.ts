'use client'

/**
 * Browser fetch wrapper for the Merklane JSON API.
 * - always sends cookies (same-origin)
 * - automatically echoes the CSRF cookie in the X-CSRF-Token header for
 *   mutating verbs (double-submit pattern)
 * - unwraps the { ok, data } envelope and throws typed errors
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|;\s*)merklane_csrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (method !== 'GET') {
    const csrf = readCsrfCookie()
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  })

  let payload: { ok?: boolean; data?: T; error?: string; code?: string } = {}
  try {
    payload = await res.json()
  } catch {
    // Non-JSON response (proxy error etc.)
  }

  if (!res.ok || payload.ok === false) {
    throw new ApiError(res.status, payload.error ?? `Request failed (${res.status})`, payload.code)
  }
  return payload.data as T
}
