import type { ReactNode } from 'react'

export type IconName =
  | 'activity'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up-right'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'clock'
  | 'database'
  | 'download'
  | 'external-link'
  | 'gauge'
  | 'layers'
  | 'menu'
  | 'more'
  | 'play'
  | 'search'
  | 'settings'
  | 'shield'
  | 'sparkles'
  | 'sliders'
  | 'terminal'
  | 'trend-up'
  | 'warning'

type IconProps = {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}

const paths: Record<IconName, ReactNode> = {
  activity: <><path d="M3 12h4l2.2-7 4.1 14L16 12h5" /></>,
  'arrow-left': <><path d="m15 18-6-6 6-6" /><path d="M9 12h12" /></>,
  'arrow-right': <><path d="M3 12h18" /><path d="m15 6 6 6-6 6" /></>,
  'arrow-up-right': <><path d="M7 17 17 7" /><path d="M7 7h10v10" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  'chevron-down': <><path d="m6 9 6 6 6-6" /></>,
  'chevron-right': <><path d="m9 18 6-6-6-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  'external-link': <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  gauge: <><path d="M4.9 19a9 9 0 1 1 14.2 0" /><path d="m12 13 4-4" /><path d="M5 19h14" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  play: <><path d="m8 5 11 7-11 7V5Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  settings: <><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.2a2 2 0 0 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 3.6 12a2 2 0 0 0-.1-.8" /><path d="M3.5 9.5A2 2 0 0 1 6.3 6.7l.1.1A2 2 0 0 0 9.8 5.4v-.2a2 2 0 0 1 4 0v.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1" /></>,
  shield: <><path d="M12 3 20 6v5c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
  sparkles: <><path d="m12 3-1.1 4.3L7 8.5l3.9 1.2L12 14l1.1-4.3L17 8.5l-3.9-1.2L12 3Z" /><path d="m19 14-.6 2.4L16 17l2.4.6L19 20l.6-2.4L22 17l-2.4-.6L19 14Z" /></>,
  sliders: <><path d="M4 7h16M4 17h16" /><circle cx="8" cy="7" r="2" /><circle cx="16" cy="17" r="2" /></>,
  terminal: <><path d="m5 7 5 5-5 5" /><path d="M12 17h7" /></>,
  'trend-up': <><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
}

export function Icon({ name, size = 18, strokeWidth = 1.8, className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  )
}
