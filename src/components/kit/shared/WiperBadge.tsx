import './WiperBadge.css'

export interface WiperBadgeProps {
  /** Wiper value 0–127, or null to hide. */
  value: number | null
  /** Tooltip context ("playing at this wiper", "captured at record time", etc). */
  title?: string
}

/**
 * Compact inline badge showing device volume level.
 * Renders nothing when value is null. Designed to sit at the right end
 * of the details row rather than being absolute-positioned.
 */
export function WiperBadge({ value, title = 'Device volume (wiper 0–127, 128段階)' }: WiperBadgeProps) {
  if (value === null) return null
  const pct = Math.round((value / 127) * 100)
  return (
    <span className="wiper-badge" title={title}>Vol {value}/128 ({pct}%)</span>
  )
}
