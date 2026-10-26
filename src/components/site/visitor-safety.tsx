'use client'

import { useEffect, useState } from 'react'
import { Link } from '@/i18n/navigation'
import { ShieldAlert } from 'lucide-react'

/**
 * One-time visitor safety notice (product rule: shown once on first visit;
 * the persistent reminder lives in the footer instead of repeating inside
 * every article).
 */
export function VisitorSafety() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Deferred so the first paint never depends on localStorage (and to keep
    // the effect free of synchronous setState).
    const t = setTimeout(() => {
      try {
        setVisible(!localStorage.getItem('merklane_safety_ack'))
      } catch {
        setVisible(true)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [])

  function dismiss() {
    try {
      localStorage.setItem('merklane_safety_ack', '1')
    } catch {
      // ignore
    }
    setVisible(false)
  }

  if (!visible) return null

  return (
    <aside className="visitor-safety" aria-label="Safety notice">
      <div className="container visitor-safety-inner">
        <ShieldAlert width={20} height={20} aria-hidden />
        <div>
          <strong className="small">Welcome to Merklane — one thing before you explore</strong>
          <p>
            Every job, opportunity and market update here is information, not financial advice.
            Verify material independently before acting on it: requests for payment, unknown
            software or wallet permissions are classic scam patterns.{' '}
            <Link href="/risk" className="link">
              Read the full safety notice
            </Link>
            .
          </p>
          <div className="button-row">
            <button type="button" className="link" onClick={dismiss}>
              Got it — hide this notice
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
