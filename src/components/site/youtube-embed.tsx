'use client'

/**
 * Click-to-load YouTube embed for the About-page monthly recaps.
 *
 * Privacy: nothing is requested from YouTube until the visitor clicks —
 * only a static thumbnail from i.ytimg.com renders first (CSP allows
 * img-src i.ytimg.com and frame-src youtube-nocookie.com). The iframe uses
 * the privacy-enhanced youtube-nocookie.com domain.
 */
import { useState } from 'react'
import { Play } from 'lucide-react'

export function YoutubeEmbed({ id, title }: { id: string; title: string }) {
  const [playing, setPlaying] = useState(false)

  if (playing) {
    return (
      <div className="video-embed">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      className="video-embed video-thumb"
      onClick={() => setPlaying(true)}
      aria-label={`Play video: ${title}`}
    >
      <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" />
      <span className="video-play" aria-hidden>
        <Play width={22} height={22} fill="currentColor" />
      </span>
    </button>
  )
}
