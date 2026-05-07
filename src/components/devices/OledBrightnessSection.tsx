import type { DeviceInfo, ManagerMessage } from '@/types/manager'

interface Props {
  device: DeviceInfo
  /** Current level from infoCache.oled_brightness or get_oled_brightness result.
   *  undefined = まだ device から値が来ていない (loading)。 */
  level: number | undefined
  sendTo: (msg: ManagerMessage) => void
}

const LEVELS: { value: 1 | 2 | 3; label: string; hint: string }[] = [
  { value: 1, label: 'Low',  hint: '暗所・夜間 (~6%)' },
  { value: 2, label: 'Mid',  hint: '通常室内 (50%)' },
  { value: 3, label: 'High', hint: '明所・展示 (100%)' },
]

/**
 * 3-state segmented button for OLED brightness.
 *
 * Wire path: Studio → Helper (set_oled_brightness) → device TCP 7701.
 * Helper transparently forwards. The store gets updated via the
 * `oled_brightness_result` reply (caught in DeviceDetail) — no optimistic
 * UI here so a rejected change (out-of-range / TCP fail) doesn't show
 * misleading state.
 */
export function OledBrightnessSection({ device, level, sendTo }: Props) {
  const offline = !device.online
  const onPick = (v: 1 | 2 | 3) => {
    if (offline || v === level) return
    sendTo({ type: 'set_oled_brightness', payload: { level: v } })
  }

  return (
    <div className="form-row">
      <label>OLED 輝度</label>
      <div className="device-toggle" role="group" aria-label="OLED brightness">
        {LEVELS.map((l) => {
          const active = level === l.value
          return (
            <button
              key={l.value}
              type="button"
              className={`btn btn-sm device-toggle-btn ${active ? 'active' : ''}`}
              onClick={() => onPick(l.value)}
              disabled={offline}
              title={l.hint}
            >
              {l.label}
            </button>
          )
        })}
      </div>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
        {level === undefined ? '読込中…' : LEVELS.find((l) => l.value === level)?.hint ?? ''}
      </span>
    </div>
  )
}
