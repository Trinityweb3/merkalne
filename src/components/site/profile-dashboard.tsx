'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from '@/i18n/navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  Bookmark,
  FileText,
  Gift,
  LayoutDashboard,
  Lock,
  LogIn,
  Megaphone,
  Monitor,
  PenLine,
  Send,
  ShieldCheck,
  Trash2,
  User as UserIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { useSession, type SessionUser } from '@/components/providers/session-provider'
import { AdsDashboard } from '@/components/site/ads/ads-dashboard'
import { api } from '@/lib/api-client'
import type { SerializedPost } from '@/lib/posts'
import { formatDate, timeAgo } from '@/lib/utils'

interface BookmarkItem {
  id: string
  createdAt: string
  post: SerializedPost
}

interface SessionRow {
  id: string
  userAgent: string | null
  ip: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  current: boolean
}

interface ReferralData {
  referralCode: string
  referralLink: string
  referralBalanceCents: number
  referredCount: number
  earnedTotalCents: number
  withdrawnCents: number
  referredBy: { name: string | null; code: string | null } | null
  withdrawals: {
    id: string
    amountCents: number
    coin: string
    address: string
    status: string
    error: string | null
    createdAt: string
    completedAt: string | null
  }[]
  withdraw: { enabled: boolean; coins: string[]; minCents: number }
}

type Tab = 'overview' | 'bookmarks' | 'posts' | 'security' | 'compose' | 'referral' | 'ads'

interface TabDef {
  key: Tab
  label: string
  icon: React.ComponentType<{ width?: number; height?: number }>
  /** Featured entry — accent colour + "New" pill in the sidebar. */
  highlight?: boolean
}

const TABS: TabDef[] = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'bookmarks', label: 'Saved posts', icon: Bookmark },
  { key: 'posts', label: 'My posts', icon: FileText },
  { key: 'referral', label: 'Referrals', icon: Gift },
  { key: 'ads', label: 'Merklane ADS', icon: Megaphone, highlight: true },
  { key: 'security', label: 'Security', icon: ShieldCheck },
  { key: 'compose', label: 'Write a Blog post', icon: PenLine },
]

const TAB_KEYS = TABS.map((tab) => tab.key)

export function ProfileDashboard({ initialTab }: { initialTab?: Tab }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, refresh } = useSession()
  // URL ?tab= wins (validated against the known keys — junk falls through),
  // then the route-provided default (/profile/ads opens on the ads tab),
  // then the legacy ?compose=1 deep link, else Overview.
  const urlTab = searchParams.get('tab') as Tab | null
  const [tab, setTab] = useState<Tab>(
    urlTab && (TAB_KEYS as string[]).includes(urlTab)
      ? urlTab
      : (initialTab ?? (searchParams.get('compose') === '1' ? 'compose' : 'overview')),
  )

  // Data states
  const [stats, setStats] = useState<{ posts: number; bookmarks: number; comments: number } | null>(null)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])
  const [myPosts, setMyPosts] = useState<SerializedPost[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [referral, setReferral] = useState<ReferralData | null>(null)

  const loadBookmarks = useCallback(async () => {
    // Bookmarks are delivered through the session provider's slug list; the
    // full items come from the posts API filtered by the bookmark endpoint.
    const data = await api<{ items: BookmarkItem[] }>('/api/account/bookmarks')
    setBookmarks(data.items)
  }, [])

  const loadPosts = useCallback(async () => {
    const data = await api<{ posts: SerializedPost[] }>('/api/posts?authorId=me&status=all&pageSize=24')
    setMyPosts(data.posts)
  }, [])

  const loadSessions = useCallback(async () => {
    const data = await api<{ sessions: SessionRow[] }>('/api/account/sessions')
    setSessions(data.sessions)
  }, [])

  const loadReferral = useCallback(async () => {
    const data = await api<ReferralData>('/api/account/referral')
    setReferral(data)
  }, [])

  const loadStats = useCallback(async () => {
    const data = await api<{ posts: number; bookmarks: number; comments: number }>('/api/account/stats')
    setStats(data)
  }, [])

  useEffect(() => {
    if (!user) return
    // Deferred via timer: avoids synchronous state updates inside the effect
    // while keeping the loading behaviour identical.
    const t = setTimeout(() => {
      void loadStats()
      if (tab === 'bookmarks') void loadBookmarks()
      if (tab === 'posts') void loadPosts()
      if (tab === 'security') void loadSessions()
      if (tab === 'referral') void loadReferral()
    }, 0)
    return () => clearTimeout(t)
  }, [tab, user, loadStats, loadBookmarks, loadPosts, loadSessions, loadReferral])

  if (!user) {
    return (
      <div className="container page">
        <div className="empty-state card" style={{ textAlign: 'center' }}>
          <h3>Loading your profile…</h3>
        </div>
      </div>
    )
  }

  const initials = (user.name || user.email).slice(0, 2).toUpperCase()

  return (
    <div className="container page">
      <div className="card profile-head">
        <div className="row wrap" style={{ gap: 22 }}>
          <Avatar className="large">
            {user.image ? <AvatarImage src={user.image} alt="" /> : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row wrap" style={{ gap: 12 }}>
              <h1>{user.name || user.email.split('@')[0]}</h1>
              <span className="badge">{user.role === 'admin' ? 'Administrator' : 'Member'}</span>
              {user.emailVerified ? (
                <span className="badge state-published">Email verified</span>
              ) : (
                <span className="badge state-draft">Email not verified</span>
              )}
            </div>
            {user.bio ? <p className="profile-bio">{user.bio}</p> : null}
            <div className="profile-links">
              {(user.links ?? '')
                .split(',')
                .filter(Boolean)
                .map((link) => (
                  <a key={link} href={link} target="_blank" rel="noopener noreferrer" className="link">
                    {link.replace(/^https?:\/\//, '').slice(0, 40)}
                  </a>
                ))}
            </div>
          </div>
          {!user.emailVerified ? (
            <div style={{ flexBasis: '100%' }}>
              <div className="notice" style={{ marginBottom: 0 }}>
                <ShieldCheck width={18} height={18} aria-hidden />
                <span>
                  Verify your email to secure the account.{' '}
                  <button
                    type="button"
                    className="link"
                    style={{ background: 'none', border: 0, padding: 0, font: 'inherit' }}
                    onClick={() =>
                      api('/api/auth/verify-email/request', { method: 'POST', body: {} }).then(
                        () => toast.success('Verification email sent'),
                        (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
                      )
                    }
                  >
                    Send the link again
                  </button>
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="account-layout">
        <aside className="card account-sidebar" aria-label="Account navigation">
          <div className="account-id min-w-0">
            <strong className="break-all">{user.email}</strong>
            <p className="muted tiny" style={{ marginTop: 4 }}>
              Member since {formatDate(user.createdAt)}
            </p>
          </div>
          <nav className="account-nav">
            {TABS.map(({ key, label, icon: Icon, highlight }) => (
              <button
                key={key}
                type="button"
                className={tab === key ? 'active' : ''}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  color: tab === key ? 'var(--foreground)' : highlight ? 'var(--link)' : 'var(--muted-foreground)',
                  background: 'none',
                  border: 0,
                  borderRadius: 7,
                  padding: '11px 12px',
                  fontSize: '0.875rem',
                  fontWeight: highlight ? 600 : undefined,
                  cursor: 'pointer',
                  width: '100%',
                  textAlign: 'left',
                }}
                onClick={() => {
                  setTab(key)
                  router.replace(`/profile?tab=${key}`, { scroll: false })
                }}
              >
                <Icon width={16} height={16} /> <span style={{ flex: 1 }}>{label}</span>
                {highlight ? (
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: '#081219',
                      background: 'var(--link)',
                      borderRadius: 999,
                      padding: '2px 7px',
                      lineHeight: 1.5,
                    }}
                  >
                    New
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
        </aside>

        <div className="account-body" style={{ minWidth: 0 }}>
          {tab === 'overview' ? (
            <OverviewTab user={user} stats={stats} onCompose={() => setTab('compose')} />
          ) : null}
          {tab === 'bookmarks' ? <BookmarksTab items={bookmarks} loading={false} /> : null}
          {tab === 'posts' ? (
            <MyPostsTab
              posts={myPosts}
              onChanged={() => {
                void loadPosts()
                void loadStats()
              }}
            />
          ) : null}
          {tab === 'security' ? (
            <SecurityTab
              user={user}
              sessions={sessions}
              onSessionsChanged={loadSessions}
              onUserChanged={refresh}
            />
          ) : null}
          {tab === 'compose' ? (
            <ComposeTab
              onPublished={() => {
                toast.success('Post published')
                setTab('posts')
                void loadPosts()
                void loadStats()
                router.refresh()
              }}
            />
          ) : null}
          {tab === 'referral' ? (
            <ReferralTab data={referral} onChanged={loadReferral} />
          ) : null}
          {tab === 'ads' ? <AdsDashboard /> : null}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function OverviewTab({
  user,
  stats,
  onCompose,
}: {
  user: SessionUser
  stats: { posts: number; bookmarks: number; comments: number } | null
  onCompose: () => void
}) {
  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Overview</h2>
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Blog posts</div>
          <div className="value">{stats?.posts ?? '—'}</div>
          <div className="detail">Publishing in Blog is free</div>
        </div>
        <div className="stat">
          <div className="label">Saved posts</div>
          <div className="value">{stats?.bookmarks ?? '—'}</div>
          <div className="detail">Synced across devices</div>
        </div>
        <div className="stat">
          <div className="label">Comments</div>
          <div className="value">{stats?.comments ?? '—'}</div>
          <div className="detail">Across all posts</div>
        </div>
        <div className="stat">
          <div className="label">Plan</div>
          <div className="value" style={{ fontSize: '1.3rem' }}>
            Free
          </div>
          <div className="detail">
            <Link href="/premium" className="link">
              Compare plans
            </Link>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Your free toolkit</h3>
        <p className="muted small" style={{ marginTop: 8, lineHeight: 1.7 }}>
          Bookmark anything, comment everywhere, publish in the community Blog and use all 20
          interface languages. Premium delivery and Premium+ publishing quotas arrive with the
          stage-2 billing launch — your account is already prepared for them.
        </p>
        <div className="button-row" style={{ marginTop: 16 }}>
          <Button onClick={onCompose} variant="outline">
            <PenLine width={15} height={15} /> Write a Blog post
          </Button>
          <Link href="/premium">
            <Button style={{ background: 'var(--link)', color: '#081219' }}>See Premium</Button>
          </Link>
        </div>
      </div>
    </div>
  )
}

function BookmarksTab({ items, loading }: { items: BookmarkItem[]; loading: boolean }) {
  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Saved posts</h2>
      {loading ? (
        <p className="muted small">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty-state card">
          <h3>No saved posts yet</h3>
          <p className="muted small" style={{ marginTop: 8 }}>
            Tap the bookmark icon on any card to keep it here — bookmarks are free and sync across
            all your devices.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Post</th>
                <th>Section</th>
                <th>Saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="data-row">
                  <td>
                    <Link href={`/${item.post.section}/${item.post.slug}`} className="link">
                      {item.post.title}
                    </Link>
                  </td>
                  <td className="muted">{item.post.section}</td>
                  <td className="muted">{timeAgo(item.createdAt)}</td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${item.post.title} from saved`}
                      onClick={async () => {
                        try {
                          await api(`/api/posts/${encodeURIComponent(item.post.slug)}/bookmark`, {
                            method: 'POST',
                          })
                          window.location.reload()
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : 'Failed')
                        }
                      }}
                    >
                      <Trash2 width={16} height={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MyPostsTab({
  posts,
  onChanged,
}: {
  posts: SerializedPost[]
  onChanged: () => void
}) {
  return (
    <div>
      <div className="row between wrap" style={{ marginBottom: 16, gap: 12 }}>
        <h2>My posts</h2>
        <span className="muted small">Blog publishing is free — editorial quotas arrive with Premium+.</span>
      </div>
      {posts.length === 0 ? (
        <div className="empty-state card">
          <h3>No posts yet</h3>
          <p className="muted small" style={{ marginTop: 8 }}>
            Your drafts stay private until you publish them.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Views</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td>
                    {post.status === 'published' ? (
                      <Link href={`/blog/${post.slug}`} className="link">
                        {post.title}
                      </Link>
                    ) : (
                      <span>{post.title}</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge state-${post.status === 'published' ? 'published' : 'draft'}`}>
                      {post.status}
                    </span>
                  </td>
                  <td className="muted">{post.views.toLocaleString()}</td>
                  <td className="muted">{timeAgo(post.createdAt)}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {post.status === 'published' ? (
                        <Link
                          href={`/blog/${post.slug}`}
                          className="icon-button"
                          aria-label="Open post"
                          title="Open post"
                        >
                          <FileText width={16} height={16} />
                        </Link>
                      ) : null}
                      <button
                        className="icon-button"
                        aria-label={`Delete ${post.title}`}
                        title="Delete (soft — hides everywhere)"
                        onClick={async () => {
                          if (!confirm(`Delete “${post.title}”? It disappears from public views.`)) return
                          try {
                            await api(`/api/posts/${encodeURIComponent(post.slug)}`, { method: 'DELETE' })
                            toast.success('Post deleted')
                            onChanged()
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : 'Delete failed')
                          }
                        }}
                      >
                        <Trash2 width={16} height={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SecurityTab({
  user,
  sessions,
  onSessionsChanged,
  onUserChanged,
}: {
  user: SessionUser
  sessions: SessionRow[]
  onSessionsChanged: () => void
  onUserChanged: () => void
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  function describeAgent(ua: string | null): string {
    if (!ua) return 'Unknown device'
    if (/iphone/i.test(ua)) return 'iPhone'
    if (/ipad/i.test(ua)) return 'iPad'
    if (/android/i.test(ua)) return 'Android device'
    if (/macintosh/i.test(ua)) return 'Mac'
    if (/windows/i.test(ua)) return 'Windows PC'
    if (/linux/i.test(ua)) return 'Linux PC'
    return ua.slice(0, 40)
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Security</h2>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 className="row" style={{ gap: 8 }}>
          <Lock width={16} height={16} /> {user.hasPassword ? 'Change password' : 'Set a password'}
        </h3>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 16 }}>
          {user.hasPassword
            ? 'Your email + password sign-in works independently of Google and GitHub.'
            : 'You registered without a password. Set one so email sign-in works even without external providers.'}
        </p>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy('password')
            try {
              await api('/api/account/password', {
                method: 'PUT',
                body: user.hasPassword ? { currentPassword, newPassword } : { currentPassword: '', newPassword },
              })
              toast.success('Password updated')
              setCurrentPassword('')
              setNewPassword('')
              onUserChanged()
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Update failed')
            } finally {
              setBusy(null)
            }
          }}
        >
          {user.hasPassword ? (
            <div className="field">
              <Label htmlFor="current-password" className="field-label">
                Current password
              </Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required={user.hasPassword}
              />
            </div>
          ) : null}
          <div className="field">
            <Label htmlFor="profile-new-password" className="field-label">
              New password
            </Label>
            <Input
              id="profile-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
              placeholder="At least 10 characters, letters + numbers"
            />
          </div>
          <div className="span-2">
            <Button type="submit" disabled={busy !== null} style={{ background: 'var(--link)', color: '#081219' }}>
              {busy === 'password' ? 'Saving…' : 'Save password'}
            </Button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 className="row" style={{ gap: 8 }}>
          <UserIcon width={16} height={16} /> Email address
        </h3>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 16 }}>
          Current: <strong>{user.email}</strong>
          {user.emailVerified ? ' (verified)' : ' (not verified)'}
        </p>
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy('email')
            try {
              await api('/api/account/email', {
                method: 'PUT',
                body: { currentPassword, newEmail },
              })
              toast.success('Confirmation link sent to the new address', {
                description: 'The change takes effect once you confirm it from that inbox.',
              })
              setNewEmail('')
              setCurrentPassword('')
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Request failed')
            } finally {
              setBusy(null)
            }
          }}
        >
          <div className="field">
            <Label htmlFor="security-password" className="field-label">
              Confirm with password
            </Label>
            <Input
              id="security-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="field">
            <Label htmlFor="new-email" className="field-label">
              New email
            </Label>
            <Input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
              placeholder="new@example.com"
            />
          </div>
          <div className="span-2">
            <Button type="submit" variant="outline" disabled={busy !== null}>
              {busy === 'email' ? 'Sending…' : 'Request email change'}
            </Button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="row between wrap" style={{ gap: 12 }}>
          <h3 className="row" style={{ gap: 8 }}>
            <Monitor width={16} height={16} /> Active sessions
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const r = await api<{ revoked: number }>('/api/account/sessions', { method: 'DELETE' })
                toast.success(`Signed out ${r.revoked} other ${r.revoked === 1 ? 'session' : 'sessions'}`)
                onSessionsChanged()
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed')
              }
            }}
          >
            <LogIn width={14} height={14} /> Sign out other sessions
          </Button>
        </div>
        <Separator className="my-4" />
        {sessions.length === 0 ? (
          <p className="muted small">Loading sessions…</p>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            {sessions.map((s) => (
              <div className="row between wrap" key={s.id} style={{ gap: 10 }}>
                <div>
                  <strong className="small">{describeAgent(s.userAgent)}</strong>
                  <span className="muted tiny" style={{ display: 'block' }}>
                    {s.ip ? `IP ${s.ip}` : 'IP unknown'} · last active {timeAgo(s.lastUsedAt)}
                  </span>
                </div>
                {s.current ? (
                  <span className="badge state-published">This device</span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await api(`/api/account/sessions/${s.id}`, { method: 'DELETE' })
                        toast.success('Session revoked')
                        onSessionsChanged()
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Failed')
                      }
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ComposeTab({ onPublished }: { onPublished: () => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState<'draft' | 'publish' | null>(null)

  const parsedTags = useMemo(
    () =>
      tags
        .split(',')
        .map((t) => t.trim().replace(/^#/, '').toLowerCase())
        .filter(Boolean)
        .slice(0, 12),
    [tags],
  )

  async function save(status: 'draft' | 'publish') {
    setBusy(status)
    try {
      await api('/api/posts', {
        method: 'POST',
        body: {
          section: 'blog',
          kind: 'Article',
          title,
          body,
          tags: parsedTags,
          // UI action ("publish") maps to the API status ("published").
          status: status === 'publish' ? 'published' : 'draft',
        },
      })
      setTitle('')
      setBody('')
      setTags('')
      onPublished()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the post')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Write a Blog post</h2>
      <div className="card editor">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save('publish')
          }}
        >
          <div className="field">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Post title"
              aria-label="Post title"
              required
              minLength={4}
              maxLength={160}
              style={{ fontSize: '1.25rem', fontWeight: 650 }}
            />
          </div>
          <div className="editor-toolbar">
            <span className="muted tiny">
              Markdown-lite supported: paragraphs, **bold**, lists, [links](https://…), ### headings
            </span>
          </div>
          <div className="field">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Tell the community something useful…"
              aria-label="Post body"
              required
              rows={12}
              maxLength={50000}
              style={{ minHeight: 220 }}
            />
          </div>
          <div className="field">
            <Label htmlFor="post-tags" className="field-label">
              Tags <span className="muted">(comma separated, max 12)</span>
            </Label>
            <Input
              id="post-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="defi, career, tutorial"
            />
            {parsedTags.length > 0 ? (
              <div className="tags" style={{ fontSize: '0.8rem' }}>
                {parsedTags.map((t) => (
                  <span key={t}>#{t}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="editor-footer">
            <small>
              Drafts are private. Publishing makes the post readable by anyone with the link, and
              excluded from search indexes per the Blog policy.
            </small>
            <div className="button-row">
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null || title.length < 4 || !body.trim()}
                onClick={() => void save('draft')}
              >
                {busy === 'draft' ? 'Saving…' : 'Save draft'}
              </Button>
              <Button
                type="submit"
                disabled={busy !== null || title.length < 4 || !body.trim()}
                style={{ background: 'var(--link)', color: '#081219' }}
              >
                <Send width={15} height={15} /> {busy === 'publish' ? 'Publishing…' : 'Publish'}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Referrals — share link, 50% commission balance, crypto withdrawals
// ---------------------------------------------------------------------------

function coinLabel(coin: string): string {
  const [network, token] = coin.includes('_') ? coin.split('_') : [null, coin]
  if (!network) return coin.toUpperCase()
  const net =
    network === 'polygon'
      ? 'Polygon'
      : network === 'bep20'
        ? 'BSC'
        : network === 'erc20'
          ? 'Ethereum'
          : network === 'arbitrum'
            ? 'Arbitrum'
            : network.toUpperCase()
  return `${(token ?? coin).toUpperCase()} · ${net}`
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

const WITHDRAW_STATUS_LABELS: Record<string, string> = {
  pending: 'Preparing',
  processing: 'Sending',
  done: 'Paid out',
  failed: 'Failed',
  expired: 'Expired',
  underfunded: 'Needs review',
}

function ReferralTab({ data, onChanged }: { data: ReferralData | null; onChanged: () => Promise<void> }) {
  const [copied, setCopied] = useState(false)
  const [coin, setCoin] = useState('')
  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data?.withdraw.coins.length && !coin) setCoin(data.withdraw.coins[0])
  }, [data, coin])

  if (!data) {
    return (
      <div className="card">
        <p className="muted">Loading referral data…</p>
      </div>
    )
  }

  const activeWithdrawal = data.withdrawals.find((w) => w.status === 'pending' || w.status === 'processing')
  const canWithdraw =
    data.withdraw.enabled &&
    data.referralBalanceCents >= data.withdraw.minCents &&
    !activeWithdrawal

  async function submitWithdraw(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const amountCents = amount.trim() ? Math.round(Number.parseFloat(amount) * 100) : undefined
      const result = await api<{ status: string; coinAmount: string | null }>(
        '/api/account/referral/withdraw',
        {
          method: 'POST',
          body: { coin, address, ...(amountCents ? { amountCents } : {}) },
        },
      )
      toast.success(
        `Withdrawal submitted — ${result.coinAmount ?? ''} ${coin.split('_').pop()?.toUpperCase() ?? coin} is on its way to your address.`,
      )
      setAddress('')
      setAmount('')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Withdrawal failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {/* Share link */}
      <div className="card">
        <h3>Invite and earn 50%</h3>
        <p className="muted small" style={{ marginTop: 6 }}>
          Share your link — when someone you invited tops up an ad campaign, half of what they pay
          lands in your referral balance. (Premium purchases will earn the same once billing launches.)
        </p>
        <div className="row wrap" style={{ gap: 10, marginTop: 14 }}>
          <Input
            readOnly
            value={data.referralLink}
            style={{ flex: 1, minWidth: 240, fontFamily: 'var(--font-mono, monospace)' }}
            aria-label="Your referral link"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(data.referralLink).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              })
            }}
          >
            {copied ? 'Copied!' : 'Copy link'}
          </Button>
        </div>
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Your code: <strong>{data.referralCode}</strong>
          {data.referredBy?.code ? (
            <>
              {' '}
              · Invited by {data.referredBy.name ?? 'a friend'} ({data.referredBy.code})
            </>
          ) : null}
        </p>
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <div className="stat">
          <p className="label">Available balance</p>
          <p className="value">{money(data.referralBalanceCents)}</p>
        </div>
        <div className="stat">
          <p className="label">Earned total</p>
          <p className="value">{money(data.earnedTotalCents)}</p>
        </div>
        <div className="stat">
          <p className="label">Invited users</p>
          <p className="value">{data.referredCount}</p>
        </div>
        <div className="stat">
          <p className="label">Withdrawn</p>
          <p className="value">{money(data.withdrawnCents)}</p>
        </div>
      </div>

      {/* Withdraw */}
      <div className="card">
        <h3>Withdraw to your wallet</h3>
        {!data.withdraw.enabled ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            Crypto payouts are not enabled on this deployment yet — your balance is safe and will be
            withdrawable once they are.
          </p>
        ) : activeWithdrawal ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            A withdrawal of {money(activeWithdrawal.amountCents)} is in progress
            ({WITHDRAW_STATUS_LABELS[activeWithdrawal.status] ?? activeWithdrawal.status}). It must
            finish before the next one.
          </p>
        ) : (
          <form onSubmit={submitWithdraw} style={{ marginTop: 12 }}>
            <div className="field" style={{ marginBottom: 12 }}>
              <Label>Payout coin</Label>
              <div className="row wrap" style={{ gap: 8 }}>
                {data.withdraw.coins.map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={`chip ${coin === c ? 'selected' : ''}`}
                    aria-pressed={coin === c}
                    onClick={() => setCoin(c)}
                  >
                    {coinLabel(c)}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <Label htmlFor="ref-address">Your {coinLabel(coin)} address</Label>
              <Input
                id="ref-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Paste your wallet address"
                required
                minLength={20}
                maxLength={120}
              />
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <Label htmlFor="ref-amount">Amount (USD) — leave empty for the full balance</Label>
              <Input
                id="ref-amount"
                type="number"
                min={data.withdraw.minCents / 100}
                max={data.referralBalanceCents / 100}
                step={0.01}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={(data.referralBalanceCents / 100).toFixed(2)}
              />
              <small className="muted">
                Minimum {money(data.withdraw.minCents)} · available {money(data.referralBalanceCents)}.
                The payout is sent on-chain via BlockBee; your balance is deducted only after the
                transfer confirms.
              </small>
            </div>
            <Button type="submit" disabled={busy || !canWithdraw || !coin || address.length < 20}>
              {busy ? 'Submitting…' : `Withdraw${amount.trim() ? ` ${money(Math.round(Number.parseFloat(amount || '0') * 100))}` : ` ${money(data.referralBalanceCents)}`}`}
            </Button>
          </form>
        )}
      </div>

      {/* History */}
      {data.withdrawals.length > 0 ? (
        <div className="card">
          <h3>Withdrawal history</h3>
          <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
            {data.withdrawals.map((w) => (
              <div
                key={w.id}
                className="row between wrap"
                style={{ gap: 8, padding: '10px 0', borderBottom: '1px solid var(--border)' }}
              >
                <div style={{ minWidth: 0 }}>
                  <strong>{money(w.amountCents)}</strong>
                  <span className="muted"> · {coinLabel(w.coin)}</span>
                  <p className="tiny muted" style={{ marginTop: 2, wordBreak: 'break-all' }}>
                    {w.address}
                    {w.error ? ` — ${w.error}` : ''}
                  </p>
                </div>
                <span
                  className={`badge ${
                    w.status === 'done'
                      ? 'state-published'
                      : w.status === 'failed' || w.status === 'expired' || w.status === 'underfunded'
                        ? 'state-under-review'
                        : 'state-draft'
                  }`}
                >
                  {WITHDRAW_STATUS_LABELS[w.status] ?? w.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
