import type { CSSProperties, ReactNode } from 'react'

/** 全部图标：24 网格、1.9 描边、圆头，与设计稿一致 */
const paths = {
  home: (
    <>
      <path d="M3.6 10.9 12 4l8.4 6.9" />
      <path d="M5.9 9.7V19a1.1 1.1 0 0 0 1.1 1.1h10a1.1 1.1 0 0 0 1.1-1.1V9.7" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.6" y="5.2" width="16.8" height="15" rx="3.2" />
      <path d="M8.2 3.2v4M15.8 3.2v4M3.6 10.2h16.8" />
    </>
  ),
  bell: (
    <>
      <path d="M12 3.3a5.5 5.5 0 0 1 5.5 5.5c0 4.9 1.8 6.1 1.8 6.1H4.7s1.8-1.2 1.8-6.1A5.5 5.5 0 0 1 12 3.3Z" />
      <path d="M9.7 18.3a2.5 2.5 0 0 0 4.6 0" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.1 3.3 19.5h17.4L12 4.1Z" />
      <path d="M12 9.8v4.2" />
      <path d="M12 16.9v.4" />
    </>
  ),
  alarm: (
    <>
      <circle cx="12" cy="13.4" r="7" />
      <path d="M12 13.4V9.5" />
      <path d="M12 13.4l2.6 1.7" />
      <path d="M4.9 4.7 7.1 3" />
      <path d="M19.1 4.7 16.9 3" />
    </>
  ),
  pause: <path d="M9.3 6.2v11.6M14.7 6.2v11.6" />,
  skip: (
    <>
      <path d="M5.8 12h8" />
      <path d="M10.6 8.1 14.6 12l-4 3.9" />
      <path d="M18 7v10" />
    </>
  ),
  check: <path d="M5 12.8 9.4 17 19 7" />,
  speaker: (
    <>
      <path d="M11.2 4.9 6.6 9H4v6h2.6l4.6 4.1V4.9Z" />
      <path d="M15 9.4a3.6 3.6 0 0 1 0 5.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.7V12l2.9 1.8" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4.5v15h16" />
      <path d="M7.6 15.4l3.5-4.1 2.9 2.4 4.3-5.6" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.6 19.4a6.4 6.4 0 0 1 12.8 0" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8.5h4.4M13.2 8.5H20" />
      <circle cx="10.8" cy="8.5" r="2.1" />
      <path d="M4 15.5h8.2M17 15.5H20" />
      <circle cx="14.6" cy="15.5" r="2.1" />
    </>
  ),
  play: <path d="M8.6 5.8 18 12l-9.4 6.2V5.8Z" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof paths

type Props = {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}

export function Icon({ name, size = 16, strokeWidth = 1.9, className, style }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}
