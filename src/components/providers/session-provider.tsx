'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api } from '@/lib/api-client'

export interface SessionUser {
  id: string
  email: string
  name: string | null
  image: string | null
  role: string
  /** "free" | "premium" | "premium_plus" — drives the header badge & paywalls */
  plan: string
  /** ISO date over the wire — null = never expires (or free) */
  premiumUntil: string | Date | null
  emailVerified: string | Date | null
  hasPassword: boolean
  bio: string | null
  links: string | null
  createdAt: string | Date
}

/** Client-side mirror of isPremiumActive (src/lib/premium/plan.ts). */
export function sessionPremiumActive(user: SessionUser | null): boolean {
  if (!user) return false
  if (!['premium', 'premium_plus'].includes(user.plan)) return false
  if (!user.premiumUntil) return true // never-expires grant
  return new Date(user.premiumUntil).getTime() > Date.now()
}

interface SessionState {
  user: SessionUser | null
  bookmarkedSlugs: string[]
  loading: boolean
  refresh: () => Promise<void>
  /** Optimistically flip a bookmark in the local cache (cards stay snappy). */
  setBookmarked: (slug: string, bookmarked: boolean) => void
}

const SessionContext = createContext<SessionState>({
  user: null,
  bookmarkedSlugs: [],
  loading: true,
  refresh: async () => {},
  setBookmarked: () => {},
})

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [bookmarkedSlugs, setBookmarkedSlugs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: SessionUser | null; bookmarkedSlugs?: string[] }>(
        '/api/auth/session',
      )
      setUser(data.user)
      setBookmarkedSlugs(data.bookmarkedSlugs ?? [])
    } catch {
      setUser(null)
      setBookmarkedSlugs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setBookmarked = useCallback((slug: string, bookmarked: boolean) => {
    setBookmarkedSlugs((prev) =>
      bookmarked ? (prev.includes(slug) ? prev : [...prev, slug]) : prev.filter((s) => s !== slug),
    )
  }, [])

  return (
    <SessionContext.Provider value={{ user, bookmarkedSlugs, loading, refresh, setBookmarked }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  return useContext(SessionContext)
}
