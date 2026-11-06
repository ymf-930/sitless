/**
 * 图标统一走 lucide-react：24 网格、圆头圆角、描边随尺寸缩放。
 * 这里只做「语义名 → 组件」的映射，调用方仍然用 <Icon name="pause" />，不感知具体库。
 */
import type { CSSProperties } from 'react'
import {
  AlarmClock,
  Bell,
  Calendar,
  ChartLine,
  Check,
  Clock,
  House,
  Pause,
  Play,
  SkipForward,
  SlidersHorizontal,
  TriangleAlert,
  User,
  Volume2,
  VolumeOff,
  type LucideIcon,
} from 'lucide-react'

const map = {
  home: House,
  calendar: Calendar,
  bell: Bell,
  warning: TriangleAlert,
  alarm: AlarmClock,
  pause: Pause,
  skip: SkipForward,
  check: Check,
  speaker: Volume2,
  speakerOff: VolumeOff,
  clock: Clock,
  chart: ChartLine,
  person: User,
  sliders: SlidersHorizontal,
  play: Play,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof map

type Props = {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}

export function Icon({ name, size = 16, strokeWidth = 1.9, className, style }: Props) {
  const Glyph = map[name]
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    />
  )
}
