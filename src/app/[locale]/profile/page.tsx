import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { getSession } from '@/lib/auth'
import { ProfileDashboard } from '@/components/site/profile-dashboard'

export const metadata: Metadata = {
  title: 'Profile',
  robots: { index: false, follow: false },
}

export default async function ProfilePage() {
  // Server-side authorisation: no session cookie → auth screen. (Proxy
  // already bounces cookie-less visitors; this is the real check.)
  const session = await getSession()
  if (!session) redirect('/auth?mode=login&next=/profile')

  return (
    <Suspense
      fallback={
        <div className="container page">
          <div className="empty-state card">Loading your profile…</div>
        </div>
      }
    >
      <ProfileDashboard />
    </Suspense>
  )
}
