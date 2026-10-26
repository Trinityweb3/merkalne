'use client'

import { useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { Moon, Sun } from 'lucide-react'

/**
 * Hydration-safe mounted flag without setState-in-effect: the server snapshot
 * is false, the client snapshot is true, and React handles the transition.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useMounted()
  const isLight = mounted ? resolvedTheme === 'light' : false

  return (
    <button
      className="icon-button"
      aria-label="Toggle theme"
      title="Toggle theme"
      onClick={() => setTheme(isLight ? 'dark' : 'light')}
    >
      {/* Reference shows a sun in dark mode (invite to light) and vice versa. */}
      {isLight ? <Moon width={19} height={19} /> : <Sun width={19} height={19} />}
    </button>
  )
}
