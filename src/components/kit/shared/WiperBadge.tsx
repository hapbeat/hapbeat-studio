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
export function WiperBadge({ value, title = 'Device volume (0–127)' }: WiperBadgeProps) {
  if (value === null) return null
  return (
    <span className="wiper-badge" title={title}>Vol {value}</span>
  )
}
