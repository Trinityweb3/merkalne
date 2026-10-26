'use client'

import { useState } from 'react'
import { Link } from '@/i18n/navigation'
import { BellRing, Send, MessageCircle, Copy, Check, Trash2, Power, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api, ApiError } from '@/lib/api-client'

interface TelegramState {
  configured: boolean
  linked: boolean
  username: string | null
  notificationsEnabled: boolean
}

interface DiscordState {
  saved: boolean
  masked: string | null
  label: string | null
  notificationsEnabled: boolean
}

interface Props {
  premium: { active: boolean; until: string | null; email: string }
  telegram: TelegramState
  discord: DiscordState
}

/**
 * Premium job-alert channel manager (server-fed state, client mutations via
 * the CSRF-protected /api/bots/* endpoints).
 */
export function AlertsManager({ premium, telegram: tgInitial, discord: dcInitial }: Props) {
  const [telegram, setTelegram] = useState(tgInitial)
  const [discord, setDiscord] = useState(dcInitial)
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [tgBusy, setTgBusy] = useState(false)
  const [dcBusy, setDcBusy] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookLabel, setWebhookLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : 'Something went wrong')

  async function generateLink() {
    setError(null)
    setTgBusy(true)
    try {
      const res = await api<{ linkUrl: string }>('/api/bots/telegram/link', { method: 'POST', body: {} })
      setLinkUrl(res.linkUrl)
      setNotice(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setError('Telegram alerts are not enabled on this deployment yet.')
      } else {
        fail(err)
      }
    } finally {
      setTgBusy(false)
    }
  }

  async function toggleTelegram(enabled: boolean) {
    setError(null)
    setTgBusy(true)
    try {
      await api('/api/bots/telegram/link', { method: 'PATCH', body: { notificationsEnabled: enabled } })
      setTelegram((s) => ({ ...s, notificationsEnabled: enabled }))
    } catch (err) {
      fail(err)
    } finally {
      setTgBusy(false)
    }
  }

  async function unlinkTelegram() {
    setError(null)
    setTgBusy(true)
    try {
      await api('/api/bots/telegram/link', { method: 'DELETE' })
      setTelegram((s) => ({ ...s, linked: false, username: null, notificationsEnabled: true }))
      setLinkUrl(null)
      setNotice('Telegram unlinked.')
    } catch (err) {
      fail(err)
    } finally {
      setTgBusy(false)
    }
  }

  async function saveWebhook(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setDcBusy(true)
    try {
      const res = await api<{ masked: string }>('/api/bots/discord/webhook', {
        method: 'POST',
        body: { url: webhookUrl, label: webhookLabel || undefined },
      })
      setDiscord((s) => ({ ...s, saved: true, masked: res.masked, label: webhookLabel || null, notificationsEnabled: true }))
      setWebhookUrl('')
      setWebhookLabel('')
      setNotice('Discord webhook saved — it is stored encrypted.')
    } catch (err) {
      fail(err)
    } finally {
      setDcBusy(false)
    }
  }

  async function toggleDiscord(enabled: boolean) {
    setError(null)
    setDcBusy(true)
    try {
      await api('/api/bots/discord/webhook', { method: 'PATCH', body: { notificationsEnabled: enabled } })
      setDiscord((s) => ({ ...s, notificationsEnabled: enabled }))
    } catch (err) {
      fail(err)
    } finally {
      setDcBusy(false)
    }
  }

  async function removeWebhook() {
    setError(null)
    setDcBusy(true)
    try {
      await api('/api/bots/discord/webhook', { method: 'DELETE' })
      setDiscord((s) => ({ ...s, saved: false, masked: null, label: null, notificationsEnabled: true }))
      setNotice('Discord webhook removed.')
    } catch (err) {
      fail(err)
    } finally {
      setDcBusy(false)
    }
  }

  return (
    <div className="container page">
      <section className="hero" style={{ textAlign: 'center' }}>
        <span className="eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <BellRing width={14} height={14} aria-hidden /> PREMIUM JOB ALERTS
        </span>
        <h1 style={{ fontSize: 'clamp(2.1rem, 4.5vw, 2.9rem)', marginTop: 13 }}>
          New postings, the moment they land.
        </h1>
        <p className="hero-sub muted" style={{ maxWidth: 620, marginInline: 'auto' }}>
          Premium subscribers choose exactly where each new Merklane posting arrives — email,
          a Telegram DM, or their own Discord server. You can pause or rewire any channel here,
          any time.
        </p>
        <div className="quick-links" style={{ justifyContent: 'center' }}>
          <span className="chip">Email is always on</span>
          <span className="chip">Telegram DMs</span>
          <span className="chip">Your Discord server</span>
          <span className="chip">Pause anytime</span>
        </div>
      </section>

      {/* Status banner */}
      <section className="section-block" style={{ maxWidth: 780, marginInline: 'auto' }}>
        <div className="card" style={{ padding: 22 }}>
          <div className="row between wrap" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10, minWidth: 0 }}>
              <ShieldCheck width={20} height={20} style={{ color: premium.active ? 'var(--positive)' : 'var(--muted)' }} aria-hidden />
              <div>
                <strong>{premium.active ? 'Premium is active' : 'Premium is not active'}</strong>
                <p className="muted small" style={{ marginTop: 2 }}>
                  {premium.active
                    ? `Alerts are dispatched to every enabled channel below${premium.until ? ` — subscription runs until ${premium.until}` : ''}.`
                    : 'Upgrade to Premium and every new posting is pushed to your channels automatically.'}
                </p>
              </div>
            </div>
            {!premium.active && (
              <Link href="/premium" className="link" style={{ whiteSpace: 'nowrap' }}>
                See Premium →
              </Link>
            )}
          </div>
        </div>
        {notice ? (
          <p className="small" style={{ color: 'var(--positive)', marginTop: 10 }}>
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="field-error" style={{ marginTop: 10 }}>
            {error}
          </p>
        ) : null}
      </section>

      <div style={{ maxWidth: 780, marginInline: 'auto', display: 'grid', gap: 22, paddingBottom: 40 }}>
        {/* Telegram card */}
        <section className="section-block" style={{ margin: 0 }}>
          <div className="section-title">
            <div className="row">
              <span className="section-icon">
                <Send width={19} height={19} />
              </span>
              <div>
                <h2>Telegram</h2>
                <p>Direct messages from the Merklane bot for every new posting.</p>
              </div>
            </div>
          </div>
          <div className="card" style={{ padding: 22 }}>
            {!telegram.configured ? (
              <p className="muted">
                Telegram delivery is not configured on this deployment yet. Email alerts still work.
              </p>
            ) : telegram.linked ? (
              <div className="row between wrap" style={{ gap: 12 }}>
                <div>
                  <strong>Linked{telegram.username ? ` as @${telegram.username}` : ''}</strong>
                  <p className="muted small" style={{ marginTop: 2 }}>
                    Alerts {telegram.notificationsEnabled ? 'are delivered' : 'are paused'} for this chat.
                  </p>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <Switch
                    checked={telegram.notificationsEnabled}
                    onCheckedChange={toggleTelegram}
                    disabled={tgBusy}
                    aria-label="Toggle Telegram alerts"
                  />
                  <Button variant="outline" size="sm" onClick={unlinkTelegram} disabled={tgBusy}>
                    <Trash2 width={14} height={14} /> Unlink
                  </Button>
                </div>
              </div>
            ) : linkUrl ? (
              <div>
                <p style={{ marginBottom: 10 }}>
                  <strong>1.</strong> Open this link on the device where Telegram is installed:
                </p>
                <div className="row" style={{ gap: 8 }}>
                  <code
                    className="small"
                    style={{
                      background: 'var(--bg-inset, #0b0d10)',
                      border: '1px solid var(--border, #2b3039)',
                      borderRadius: 8,
                      padding: '8px 12px',
                      overflowWrap: 'anywhere',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {linkUrl}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(linkUrl)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1600)
                    }}
                    aria-label="Copy linking link"
                  >
                    {copied ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}
                  </Button>
                </div>
                <p className="muted small" style={{ marginTop: 10 }}>
                  <strong>2.</strong> Press <em>Start</em> in the chat — the bot confirms the link instantly.
                  The code is one-time and only its hash is stored.
                </p>
              </div>
            ) : (
              <div className="row between wrap" style={{ gap: 12 }}>
                <p className="muted" style={{ margin: 0 }}>
                  Link your Telegram in two clicks — the bot sends a confirmation when it is done.
                </p>
                <Button onClick={generateLink} disabled={tgBusy} style={{ background: 'var(--link)', color: '#081219', borderColor: 'var(--link)' }}>
                  {tgBusy ? 'Generating…' : 'Link Telegram'}
                </Button>
              </div>
            )}
          </div>
        </section>

        {/* Discord card */}
        <section className="section-block" style={{ margin: 0 }}>
          <div className="section-title">
            <div className="row">
              <span className="section-icon">
                <MessageCircle width={19} height={19} />
              </span>
              <div>
                <h2>Discord</h2>
                <p>Postings delivered into your own server through a personal webhook.</p>
              </div>
            </div>
          </div>
          <div className="card" style={{ padding: 22 }}>
            {discord.saved ? (
              <div className="row between wrap" style={{ gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{discord.label || 'Webhook saved'}</strong>
                  <p className="muted small" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>
                    {discord.masked} · alerts {discord.notificationsEnabled ? 'on' : 'paused'}
                  </p>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <Switch
                    checked={discord.notificationsEnabled}
                    onCheckedChange={toggleDiscord}
                    disabled={dcBusy}
                    aria-label="Toggle Discord alerts"
                  />
                  <Button variant="outline" size="sm" onClick={removeWebhook} disabled={dcBusy}>
                    <Trash2 width={14} height={14} /> Remove
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={saveWebhook}>
                <p className="muted small" style={{ marginTop: 0 }}>
                  In your Discord server: <em>Server Settings → Integrations → Webhooks → New Webhook →
                  Copy Webhook URL</em>. The URL is validated and stored AES-256-GCM encrypted — only
                  Merklane can use it, and you can delete it any time.
                </p>
                <div className="row wrap" style={{ gap: 10 }}>
                  <Input
                    type="url"
                    required
                    placeholder="https://discord.com/api/webhooks/…"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    style={{ flex: 2, minWidth: 240 }}
                    aria-label="Discord webhook URL"
                  />
                  <Input
                    type="text"
                    placeholder="Label (optional)"
                    value={webhookLabel}
                    onChange={(e) => setWebhookLabel(e.target.value)}
                    style={{ flex: 1, minWidth: 160 }}
                    aria-label="Webhook label"
                  />
                  <Button type="submit" disabled={dcBusy} style={{ background: 'var(--link)', color: '#081219', borderColor: 'var(--link)' }}>
                    <Power width={14} height={14} /> {dcBusy ? 'Saving…' : 'Save webhook'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </section>

        <p className="muted small" style={{ textAlign: 'center' }}>
          Email alerts always go to <strong>{premium.email}</strong> while Premium is active.
          Manage your subscription and channels here any time — nothing is shared with third parties.
        </p>
      </div>
    </div>
  )
}
