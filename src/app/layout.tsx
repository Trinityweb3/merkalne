import type { Metadata, Viewport } from 'next'

/**
 * Pass-through ROOT layout (the official next-intl App-Router pattern).
 *
 * The real root layout — <html>, <body>, providers, header/footer — is
 * app/[locale]/layout.tsx: it needs to own the document so it can set
 * lang + dir per locale (including RTL for Arabic, Persian, Urdu). A root
 * layout must exist for Next.js, but rendering a second <html> here would
 * nest documents, so this one just renders children.
 *
 * The metadata/viewport below remain as the fallback for surfaces outside
 * the [locale] tree (the global 404); locale pages define their own.
 */
export const metadata: Metadata = {
  title: {
    default: 'Merklane | Explore Web3',
    template: '%s | Merklane',
  },
  description:
    'Explore Web3, crypto, blockchain and AI opportunities. Jobs, opportunities and insights — all in one place.',
  icons: { icon: '/api/favicon', apple: '/api/favicon' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children
}
