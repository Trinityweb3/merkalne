'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Flag } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { REPORT_REASONS } from '@/lib/constants'
import { api } from '@/lib/api-client'

/**
 * Report dialog — available to guests (no account required). The reason is
 * required; post and timestamp are attached server-side; reporter details
 * are never published next to the post.
 */
export function ReportDialog({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string>('')
  const [details, setDetails] = useState('')
  const [contact, setContact] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!reason) {
      toast.error('Please choose a reason for the report')
      return
    }
    setSubmitting(true)
    try {
      const result = await api<{ reportId: string }>(`/api/posts/${encodeURIComponent(slug)}/report`, {
        method: 'POST',
        body: { reason, details, contact },
      })
      toast.success(`Report submitted — reference #${result.reportId.slice(-8).toUpperCase()}`, {
        description: 'Our moderators will review this material. Thank you for keeping Merklane safe.',
      })
      setOpen(false)
      setReason('')
      setDetails('')
      setContact('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit the report')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="post-action post-report-inline" aria-label="Report post" type="button">
          <Flag width={18} height={18} />
          <span className="post-action-label">Report</span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report this post</DialogTitle>
          <DialogDescription>
            Describe the problem. The post link and time are attached automatically — registration
            is not required.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="stack" style={{ gap: 16 }}>
          <div className="field">
            <Label htmlFor="report-reason" className="field-label">
              Reason <span style={{ color: 'var(--negative)' }}>*</span>
            </Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id="report-reason" className="full-width">
                <SelectValue placeholder="Choose a reason" />
              </SelectTrigger>
              <SelectContent>
                {REPORT_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="field">
            <Label htmlFor="report-details" className="field-label">
              Details
            </Label>
            <Textarea
              id="report-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="What is wrong with this post?"
              maxLength={2000}
              rows={4}
            />
          </div>
          <div className="field">
            <Label htmlFor="report-contact" className="field-label">
              Contact email <span className="muted">(optional)</span>
            </Label>
            <Input
              id="report-contact"
              type="email"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} variant="destructive">
              {submitting ? 'Submitting…' : 'Submit report'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
