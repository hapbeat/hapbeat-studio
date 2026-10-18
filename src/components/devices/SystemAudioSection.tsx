import { useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import {
  DELAY_MS_MAX,
  GAIN_PCT_MAX,
  systemAudioMode,
  useSystemAudio,
  type SystemAudioNotice,
} from '@/stores/systemAudioStore'
import type { DeviceInfo } from '@/types/manager'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'

const NOTICE_TEXT: Record<SystemAudioNotice, MessageId> = {
  denied: 'manage.systemAudio.notice.denied',
  noAudio: 'manage.systemAudio.notice.noAudio',
  noHelper: 'manage.systemAudio.notice.noHelper',
  noDevice: 'manage.systemAudio.notice.noDevice',
  helperLost: 'manage.systemAudio.notice.helperLost',
  ended: 'manage.systemAudio.notice.ended',
  displaced: 'manage.systemAudio.notice.displaced',
  unreachable: 'manage.systemAudio.notice.unreachable',
  no_session: 'manage.systemAudio.notice.displaced',
}

interface Props {
  /** The device shown in Manage: the target when no device is ticked (as the streaming test). */
  device: DeviceInfo
}

/**
 * PC sound → Hapbeat, in the playback test tab: what the PC plays goes to the ticked
 * devices (or the one shown) as vibration, with its level and delay. The desktop app
 * (Windows) captures without a picker; a browser shows its own (entire screen +
 * system audio).
 */
export function SystemAudioSection({ device }: Props) {
  const { t } = useI18n()
  const { devices } = useHelperConnection()
  const selectedIps = useDeviceStore((s) => s.selectedIps)
  const state = useSystemAudio((s) => s.state)
  const notice = useSystemAudio((s) => s.notice)
  const level = useSystemAudio((s) => s.level)
  const deviceCount = useSystemAudio((s) => s.deviceCount)
  const gainPct = useSystemAudio((s) => s.gainPct)
  const delayMs = useSystemAudio((s) => s.delayMs)
  const start = useSystemAudio((s) => s.start)
  const stop = useSystemAudio((s) => s.stop)
  const setTargets = useSystemAudio((s) => s.setTargets)
  const setGainPct = useSystemAudio((s) => s.setGainPct)
  const setDelayMs = useSystemAudio((s) => s.setDelayMs)
  const [mode] = useState(systemAudioMode)
  // Typed delay, applied on Enter / leaving the field (so clearing it to retype is not 0 ms).
  const [delayDraft, setDelayDraft] = useState<string | null>(null)

  const chosen = useMemo(
    () => (selectedIps.length > 0 ? selectedIps : [device.ipAddress]),
    [selectedIps, device.ipAddress],
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

  if (!mode) return null

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

  const commitDelay = () => {
    if (delayDraft === null) return
    const ms = Number(delayDraft)
    if (delayDraft.trim() !== '' && Number.isFinite(ms)) setDelayMs(ms)
    setDelayDraft(null)
  }

  return (
    <div className="form-section">
      <div className="form-section-title">
        <span className="mode-prefix mode-prefix-clip">♪&nbsp;LIVE</span>
        {t('manage.systemAudio.title')}
        <span className="form-section-sub-inline">
          {' '}{t('manage.systemAudio.description')}
        </span>
      </div>
      {mode === 'browser' && (
        <div className="form-status muted" style={{ padding: '0 4px 6px', marginTop: 0 }}>
          {t('manage.systemAudio.pickerHint')}
        </div>
      )}

      <div className="form-row">
        <label>{t('manage.systemAudio.gain')}</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            type="range"
            min={0}
            max={GAIN_PCT_MAX}
            step={5}
            value={gainPct}
            onChange={(e) => setGainPct(Number(e.target.value))}
            style={{ flex: 1 }}
            aria-label={t('manage.systemAudio.gainAria')}
          />
          <span className="form-input mono short" style={{ textAlign: 'right', minWidth: 60 }}>
            {gainPct}%
          </span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>{t('manage.systemAudio.delay')}</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            type="range"
            min={0}
            max={DELAY_MS_MAX}
            step={5}
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value))}
            style={{ flex: 1 }}
            aria-label={t('manage.systemAudio.delayAria')}
          />
          <input
            type="number"
            className="form-input mono short"
            min={0}
            max={DELAY_MS_MAX}
            step={1}
            value={delayDraft ?? String(delayMs)}
            onChange={(e) => setDelayDraft(e.target.value)}
            onBlur={commitDelay}
            onKeyDown={(e) => { if (e.key === 'Enter') commitDelay() }}
            style={{ textAlign: 'right' }}
            aria-label={t('manage.systemAudio.delayAria')}
          />
          <span className="system-audio-unit">ms</span>
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ padding: '0 4px', marginTop: -4 }}>
        {t('manage.systemAudio.settingsHint')}
      </div>

      <div className="form-action-row system-audio-actions">
        <button
          type="button"
          className="form-button system-audio-btn"
          onClick={() => (live || starting ? stop() : void start(targets))}
          disabled={!live && !starting && targets.length === 0}
          aria-pressed={live}
        >
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
        <span className={`form-status ${warn ? 'warn' : 'muted'} system-audio-status`} title={status}>
          {status}
        </span>
      </div>
    </div>
  )
}
