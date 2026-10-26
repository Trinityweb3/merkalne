'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api-client'

export function ContactForm() {
  const [email, setEmail] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentId, setSentId] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const result = await api<{ messageId: string }>('/api/contact', {
        method: 'POST',
        body: { email, subject, body },
      })
      setSentId(result.messageId)
      toast.success('Message received')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the message')
    } finally {
      setBusy(false)
    }
  }

  if (sentId) {
    return (
      <div className="card empty-state" style={{ textAlign: 'center' }}>
        <h3>Message received</h3>
        <p className="muted small" style={{ marginTop: 8 }}>
          Your reference is <strong>#{sentId.slice(-8).toUpperCase()}</strong>. We reply to the
          email you provided, usually within two business days.
        </p>
      </div>
    )
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <div className="form-grid">
        <div className="field">
          <Label htmlFor="contact-email" className="field-label">
            Your email
          </Label>
          <Input
            id="contact-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
          <small>So we can reply. Used for this conversation only.</small>
        </div>
        <div className="field">
          <Label htmlFor="contact-subject" className="field-label">
            Subject
          </Label>
          <Input
            id="contact-subject"
            required
            minLength={3}
            maxLength={160}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Question, feedback or report"
          />
        </div>
        <div className="field span-2">
          <Label htmlFor="contact-body" className="field-label">
            Message
          </Label>
          <Textarea
            id="contact-body"
            required
            minLength={10}
            maxLength={5000}
            rows={7}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Tell us what happened. Include links if relevant."
          />
          <small>
            Reporting a post? Use the “Report” button on the post itself — it attaches the post and
            time automatically.
          </small>
        </div>
      </div>
      <div className="button-row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
        <Button type="submit" disabled={busy} style={{ background: 'var(--link)', color: '#081219' }}>
          <Send width={15} height={15} /> {busy ? 'Sending…' : 'Send message'}
        </Button>
      </div>
    </form>
  )
}
