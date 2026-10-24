import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/i18n/I18nProvider'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import { clampPcOffset, PC_OFFSET_MAX, PC_OFFSET_MIN, usePcTiming } from '@/stores/pcTiming'
import { resolvePlaybackTargets } from '@/utils/playbackDevices'
import { PcTimingTest } from '@/utils/pcTimingTest'
import { NumberField } from '@/components/scene/SceneCuePanels'
import './ConfirmDialog.css'
import './PcTiming.css'

/**
 * This PC's sound / haptics offset (DEC-093) where Studio plays both: the value (ms, + = the haptic later) and
 * "Adjust…", which opens the test pattern to set it by ear and body. Used by the waveform panel's sound lane and the
 * Scene tab; the value is this browser's only (usePcTiming).
 */
export function PcOffsetField() {
  const { t } = useI18n()
  const offset = usePcTiming(s => s.offsetMs)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  return <span ref={anchor} className="pc-offset-field" title={t('pcTiming.hint')}>{t('pcTiming.label')}
    <NumberField value={offset} min={PC_OFFSET_MIN} max={PC_OFFSET_MAX} step={1} label={t('pcTiming.label')} onCommit={x => usePcTiming.getState().setOffsetMs(x)} /> ms
    <button type="button" className="toolbar-btn" onClick={() => setOpen(true)}>{t('pcTiming.adjust')}</button>
    {open && <PcTimingDialog container={anchor.current?.ownerDocument.body ?? document.body} onClose={() => setOpen(false)} />}
  </span>
}

/** The test pattern (PcTimingTest) with the offset to move while it plays; closing stops it. */
function PcTimingDialog({ container, onClose }: { container: HTMLElement; onClose: () => void }) {
  const { t } = useI18n()
  const offset = usePcTiming(s => s.offsetMs)
  const { isConnected, devices, send } = useHelperConnection()
  const kitSelectedIps = useDeviceStore(s => s.kitSelectedIps)
  const targets = useMemo(() => isConnected ? resolvePlaybackTargets(devices, kitSelectedIps).map(d => d.ipAddress) : [], [isConnected, devices, kitSelectedIps])
  const sendRef = useRef(send); sendRef.current = send
  const test = useMemo(() => new PcTimingTest(message => sendRef.current(message),
    async (blob, route, options) => (await import('@/utils/audioStreamer')).streamClip(blob, route, {...options, takeover: true}), () => usePcTiming.getState().offsetMs), [])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => test.stop(), [test])
  // A change of the devices stops the pattern (it streams to the ones it started with).
  useEffect(() => { test.stop(); setRunning(false) }, [test, targets.join(',')])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    container.ownerDocument.defaultView?.addEventListener('keydown', key)
    return () => container.ownerDocument.defaultView?.removeEventListener('keydown', key)
  }, [container, onClose])
  const toggle = () => {
    if (running) { test.stop(); setRunning(false); return }
    setError(null); setRunning(true)
    test.start(targets).catch(e => { setError(e instanceof Error ? e.message : String(e)); setRunning(false) })
  }
  const nudge = (ms: number) => usePcTiming.getState().setOffsetMs(clampPcOffset(offset + ms))
  return createPortal(<div className="confirm-dialog-backdrop" onClick={onClose}>
    <div className="confirm-dialog pc-timing-dialog" role="dialog" aria-modal="true" aria-label={t('pcTiming.title')} onClick={e => e.stopPropagation()}>
      <div className="confirm-dialog-title">{t('pcTiming.title')}</div>
      <div className="confirm-dialog-body">
        <p>{t('pcTiming.body')}</p>
        <div className="pc-timing-row">
          <span className="pc-timing-end">{t('pcTiming.earlier')}</span>
          <input type="range" min={-200} max={200} step={1} value={Math.max(-200, Math.min(200, offset))} aria-label={t('pcTiming.label')}
            onChange={e => usePcTiming.getState().setOffsetMs(Number(e.target.value))} />
          <span className="pc-timing-end">{t('pcTiming.later')}</span>
        </div>
        <div className="pc-timing-row">
          {[-5, -1].map(ms => <button key={ms} type="button" className="toolbar-btn" onClick={() => nudge(ms)}>{ms}</button>)}
          <NumberField value={offset} min={PC_OFFSET_MIN} max={PC_OFFSET_MAX} step={1} label={t('pcTiming.label')} onCommit={x => usePcTiming.getState().setOffsetMs(x)} /> ms
          {[1, 5].map(ms => <button key={ms} type="button" className="toolbar-btn" onClick={() => nudge(ms)}>+{ms}</button>)}
        </div>
        <p className="pc-timing-status" role="status">{error ? t('pcTiming.error', { error }) : !isConnected ? t('pcTiming.noHelper') : targets.length ? t('pcTiming.devices', { count: targets.length }) : t('pcTiming.noDevices')}</p>
      </div>
      <div className="confirm-dialog-actions">
        {/* Both labels stacked in one cell: switching never changes the button's width. */}
        <button type="button" className="toolbar-btn pc-timing-toggle" disabled={!running && !targets.length} onClick={toggle} aria-label={t(running ? 'pcTiming.stop' : 'pcTiming.start')}>
          <span className="pc-timing-stack" aria-hidden="true"><span style={{ visibility: running ? 'hidden' : 'visible' }}>{t('pcTiming.start')}</span>
            <span style={{ visibility: running ? 'visible' : 'hidden' }}>{t('pcTiming.stop')}</span></span>
        </button>
        <button type="button" className="toolbar-btn" onClick={onClose}>{t('pcTiming.close')}</button>
      </div>
    </div>
  </div>, container)
}
