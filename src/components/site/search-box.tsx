'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Hero search box — submits to /search on Enter or button click. */
export function SearchBox({
  initialValue = '',
  autoFocus = false,
  action = '/search',
  name = 'q',
}: {
  initialValue?: string
  autoFocus?: boolean
  action?: string
  name?: string
}) {
  const t = useTranslations('search')
  const tc = useTranslations('common')
  const [value, setValue] = useState(initialValue)
  const router = useRouter()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const q = value.trim()
    router.push(q ? `${action}?q=${encodeURIComponent(q)}` : action)
  }

  return (
    <form className="search-box" role="search" onSubmit={submit}>
      <Search className="muted" width={22} height={22} aria-hidden />
      <input
        aria-label={t('placeholder')}
        name={name}
        placeholder={t('placeholder')}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        type="submit"
        style={{ background: 'var(--link)', color: '#081219', borderColor: 'var(--link)' }}
      >
        {tc('search')}
      </Button>
    </form>
  )
}
