import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import {
  DELAY_MS_MAX,
  GAIN_PCT_MAX,
  SILENT_HINT_MS,
  systemAudioSupport,
  useSystemAudio,
  type SystemAudioNotice,
} from '@/stores/systemAudioStore'
import {
  allowDeviceNames,
  defaultPlaybackName,
  listAudioInputs,
  type AudioInputDevice,
  type CaptureInfo,
} from '@/utils/systemAudioCapture'
import type { DeviceInfo } from '@/types/manager'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'

const NOTICE_TEXT: Record<SystemAudioNotice, MessageId> = {
  denied: 'manage.systemAudio.notice.denied',
  noAudio: 'manage.systemAudio.notice.noAudio',
  sourceMissing: 'manage.systemAudio.notice.sourceMissing',
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

/** Value of the source select for the loopback of the default playback device. */
const LOOPBACK = ''

/**
 * PC sound → Hapbeat, in the playback test tab: what the PC plays goes to the ticked
 * devices (or the one shown) as vibration, with its source, level and delay. The
 * source is the default playback device (the desktop app on Windows captures it
 * without a picker; a browser shows its own: entire screen + system audio) or a
 * recording device, shown by name while it runs.
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
  const source = useSystemAudio((s) => s.source)
  const setSource = useSystemAudio((s) => s.setSource)
  const capturing = useSystemAudio((s) => s.capturing)
  const silent = useSystemAudio((s) => s.silent)
  const [support] = useState(systemAudioSupport)
  const [inputs, setInputs] = useState<AudioInputDevice[]>([])
  const [playbackName, setPlaybackName] = useState<string | null>(null)
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

  // Recording devices and the default playback device's name, kept current as devices come and go.
  const refreshDevices = useCallback(async () => {
    if (support.inputs) setInputs(await listAudioInputs())
    if (support.loopback === 'app') setPlaybackName(await defaultPlaybackName())
  }, [support])
  useEffect(() => {
    void refreshDevices()
    const media = navigator.mediaDevices
    media?.addEventListener?.('devicechange', refreshDevices)
    return () => media?.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  // Follow the ticks while live (only on a change of choice, not when a device
  // blinks offline for a moment), including a change made while it was starting.
  const choiceKey = chosen.join(',')
  const live = state === 'live'
  useEffect(() => {
    if (live) setTargets(targetsRef.current)
  }, [choiceKey, live, setTargets])

  if (!support.loopback && !support.inputs) return null

  const starting = state === 'starting'
  const named = inputs.filter((d) => d.deviceId && d.label)
  // A browser names recording devices only after the microphone permission.
  const unnamed = support.inputs && inputs.length > 0 && named.length === 0
  const missing = source !== null && !named.some((d) => d.deviceId === source.deviceId)
  const loopbackLabel = support.loopback === 'picker'
    ? t('manage.systemAudio.source.picker')
    : playbackName
      ? t('manage.systemAudio.source.defaultNamed', { name: playbackName })
      : t('manage.systemAudio.source.default')
  const pickerUsed = support.loopback === 'picker' && source === null
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

  const capturingText = (info: CaptureInfo) => t('manage.systemAudio.capturing', {
    name: info.name ?? (source ? source.label : t('manage.systemAudio.source.default')),
    detail: [
      info.channels ? `${info.channels}ch` : null,
      info.sampleRate ? `${info.sampleRate / 1000} kHz` : null,
    ].filter(Boolean).join('・'),
  })

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
      {(support.loopback ? 1 : 0) + named.length + (missing ? 1 : 0) > 0 && (
        <div className="form-row">
          <label>{t('manage.systemAudio.source')}</label>
          <div className="form-row-multi" style={{ width: '100%', minWidth: 0 }}>
            <select
              className="form-input system-audio-source"
              value={source?.deviceId ?? LOOPBACK}
              onChange={(e) => {
                const id = e.target.value
                const device = named.find((d) => d.deviceId === id)
                setSource(id === LOOPBACK ? null : { deviceId: id, label: device?.label ?? source?.label ?? '' })
              }}
              disabled={live || starting}
              aria-label={t('manage.systemAudio.sourceAria')}
            >
              {support.loopback && <option value={LOOPBACK}>{loopbackLabel}</option>}
              {named.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              {missing && source && (
                <option value={source.deviceId}>{t('manage.systemAudio.source.missing', { name: source.label || source.deviceId.slice(0, 8) })}</option>
              )}
            </select>
            {unnamed && (
              <button
                type="button"
                className="form-button-secondary"
                onClick={() => void allowDeviceNames().then(refreshDevices, () => { /* refused */ })}
                title={t('manage.systemAudio.source.showNamesTitle')}
              >
                {t('manage.systemAudio.source.showNames')}
              </button>
            )}
          </div>
          <span />
        </div>
      )}
      {pickerUsed && (
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
      <div className={`form-status ${silent ? 'warn' : 'muted'} system-audio-detail`}>
        {live && silent
          ? t(support.inputs ? 'manage.systemAudio.silent' : 'manage.systemAudio.silentUpdate', { sec: SILENT_HINT_MS / 1000 })
          : live && capturing
            ? capturingText(capturing)
            : ''}
      </div>
    </div>
  )
}
