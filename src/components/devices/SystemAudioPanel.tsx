import { useEffect, useMemo, useRef } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSystemAudio, type SystemAudioNotice } from '@/stores/systemAudioStore'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'

const NOTICE_TEXT: Record<SystemAudioNotice, MessageId> = {
  denied: 'manage.systemAudio.notice.denied',
  noHelper: 'manage.systemAudio.notice.noHelper',
  noDevice: 'manage.systemAudio.notice.noDevice',
  helperLost: 'manage.systemAudio.notice.helperLost',
  ended: 'manage.systemAudio.notice.ended',
  displaced: 'manage.systemAudio.notice.displaced',
  unreachable: 'manage.systemAudio.notice.unreachable',
  no_session: 'manage.systemAudio.notice.displaced',
}

/**
 * PC sound → Hapbeat (desktop app on Windows): one button under the Manage device
 * list. It sends to the ticked devices (or the one shown, when none is ticked)
 * and follows the ticks while it runs.
 */
export function SystemAudioPanel() {
  const { t } = useI18n()
  const { devices } = useHelperConnection()
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const selectedIps = useDeviceStore((s) => s.selectedIps)
  const state = useSystemAudio((s) => s.state)
  const notice = useSystemAudio((s) => s.notice)
  const level = useSystemAudio((s) => s.level)
  const deviceCount = useSystemAudio((s) => s.deviceCount)
  const start = useSystemAudio((s) => s.start)
  const stop = useSystemAudio((s) => s.stop)
  const setTargets = useSystemAudio((s) => s.setTargets)

  // Online Wi-Fi devices among the chosen ones (a USB card's `serial:` id is never online here).
  const chosen = useMemo(
    () => (selectedIps.length > 0 ? selectedIps : selectedIp ? [selectedIp] : []),
    [selectedIps, selectedIp],
  )
  const onlineIps = useMemo(
    () => new Set(devices.filter((d) => d.online).map((d) => d.ipAddress)),
    [devices],
  )
  const targets = useMemo(() => chosen.filter((ip) => onlineIps.has(ip)), [chosen, onlineIps])
  const targetsRef = useRef(targets)
  targetsRef.current = targets

  // Follow the ticks while live (only on a change of choice, not when a device
  // blinks offline for a moment), including a change made while it was starting.
  const choiceKey = chosen.join(',')
  const live = state === 'live'
  useEffect(() => {
    if (live) setTargets(targetsRef.current)
  }, [choiceKey, live, setTargets])

  const starting = state === 'starting'
  let status: string
  let warn = false
  if (live) {
    status = t('manage.systemAudio.live', { count: deviceCount })
  } else if (notice && !starting) {
    status = t(NOTICE_TEXT[notice])
    warn = true
  } else if (targets.length > 0) {
    status = t('manage.systemAudio.ready', { count: targets.length })
  } else {
    status = t('manage.systemAudio.noTarget')
  }

  return (
    <div className="system-audio-panel">
      <div className="system-audio-row">
        <button
          type="button"
          className={`system-audio-btn${live ? ' live' : ''}`}
          onClick={() => (live || starting ? stop() : void start(targets))}
          disabled={!live && !starting && targets.length === 0}
          title={t('manage.systemAudio.tip')}
          aria-pressed={live}
        >
          <span className={`system-audio-dot${live ? ' live' : ''}`} aria-hidden="true" />
          {live
            ? t('manage.systemAudio.stop')
            : starting
              ? t('manage.systemAudio.starting')
              : t('manage.systemAudio.start')}
        </button>
        <div
          className="system-audio-meter"
          role="meter"
          aria-label={t('manage.systemAudio.level')}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={live ? level : 0}
        >
          <div className="system-audio-meter-fill" style={{ transform: `scaleX(${live ? level : 0})` }} />
        </div>
      </div>
      <p className={`system-audio-status${warn ? ' warn' : ''}`}>{status}</p>
    </div>
  )
}
