import { useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useSceneStore } from '@/stores/sceneStore'
import { NumberField } from '@/components/scene/SceneCuePanels'
import { detectSyncMs, savedSyncMs, setSyncMs, type SyncBuffer } from '@/utils/syncPoint'
import type { SyncSide, SyncView } from '@/utils/soundLane'

/**
 * Sync points in the waveform panel (DEC-093): with a haptic audition and its event's sound in the lane above, a
 * dashed line marks each one's sync point (the saved `syncMs`, else the detected start). The sound is played and drawn
 * so that its line meets the haptic's; a line dragged along its own waveform (or a number, 1 ms) sets that material's
 * sync point in the cue table, a double click puts it back to the detected one.
 */

/**
 * The sync points of what is shown: the shown haptic (`haptic`: its buffer, and its clip name when it is a cue table
 * clip) and its event's picked sound. Null without a haptic audition with a sound, and for loops (a loop has no start).
 * `starts`: where each copy of the haptic is drawn (seconds; null = once at 0).
 */
export function useSyncView({ enabled, haptic, sound, starts }: {
  enabled: boolean
  haptic: { buffer: SyncBuffer & { duration: number }; name: string | null } | null
  sound: { buffer: SyncBuffer & { duration: number }; name?: string; loop?: boolean } | null
  starts: readonly number[] | null
}): SyncView | null {
  const table = useSceneStore(s => s.table)
  const startsKey = starts ? starts.join(',') : '0'
  return useMemo(() => {
    if (!enabled || !haptic || !sound || sound.loop) return null
    const side = (target: 'sound' | 'haptic', buffer: SyncBuffer & { duration: number }, name: string | null | undefined): SyncSide => {
      const autoMs = detectSyncMs(buffer)
      const editable = !!name && !!table && (target === 'sound' || !!table.clips[name])
      const saved = editable ? savedSyncMs(table!, target, name!) : undefined
      return { ms: saved ?? autoMs, autoMs, auto: saved === undefined, ref: editable ? { target, name: name! } : null, durSec: buffer.duration }
    }
    return { sound: side('sound', sound.buffer, sound.name), haptic: side('haptic', haptic.buffer, haptic.name), starts: startsKey.split(',').map(Number) }
  }, [enabled, haptic?.buffer, haptic?.name, sound?.buffer, sound?.name, sound?.loop, startsKey, table])
}

/** Writes sync points to the cue table in one edit (ms, or null = back to the detected one) and logs it. */
export function commitSync(changes: readonly { ref: NonNullable<SyncSide['ref']>; ms: number | null }[]) {
  const scene = useSceneStore.getState(), table = scene.table
  if (!table || !changes.length) return
  const lines = changes.map(({ ref, ms }) => `${ref.target === 'haptic' ? 'clip' : 'sound'} ${ref.name}: ${savedSyncMs(table, ref.target, ref.name) ?? 'auto'} → ${ms === null ? 'auto' : `${Math.round(ms)} ms`}`)
  if (scene.edit(t => changes.reduce((next, { ref, ms }) => setSyncMs(next, ref.target, ref.name, ms), t))) scene.addLog(`sync point: ${lines.join('; ')}`)
}

const clampMs = (side: SyncSide, ms: number) => Math.max(0, Math.min(Math.round(side.durSec * 1000), Math.round(ms)))

/**
 * A sync point's dashed line at `x` (px) over `top`..`top + height`, dragged along its own waveform (`pxPerSec`): while
 * dragged it follows the pointer (the waveforms stay put), on release the new point is saved and the sound moves to meet
 * the haptic. Double click: back to the detected point. Not draggable when the material cannot be saved.
 */
export function SyncLine({ side, x, top, height, pxPerSec, width, label }: { side: SyncSide; x: number; top: number; height: number; pxPerSec: number; width: number; label: string }) {
  const { t } = useI18n()
  const drag = useRef<{ x: number; pointer: number } | null>(null)
  const [dx, setDx] = useState(0)
  const ms = clampMs(side, side.ms + dx / pxPerSec * 1000), at = x + (ms - side.ms) / 1000 * pxPerSec
  if (at < -4 || at > width + 4) return null
  const title = `${t('editor.sync.line', { kind: label, ms })}${side.ref ? t('editor.sync.lineHint') : t('editor.sync.readonly')}`
  return <div className={`editor-sync-line ${side.ref ? '' : 'readonly'} ${dx ? 'dragging' : ''}`} style={{ left: at, top, height }} title={title}
    role="separator" aria-orientation="vertical" aria-label={title}
    onPointerDown={event => {
      if (!side.ref || event.button !== 0) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.clientX, pointer: event.pointerId }; setDx(0)
    }}
    onPointerMove={event => { if (drag.current) setDx(event.clientX - drag.current.x) }}
    onPointerUp={event => {
      const state = drag.current
      if (!state) return
      drag.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      if (side.ref && ms !== side.ms) commitSync([{ ref: side.ref, ms }])
      setDx(0)
    }}
    onPointerCancel={() => { drag.current = null; setDx(0) }}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); if (side.ref && !side.auto) commitSync([{ ref: side.ref, ms: null }]) }} />
}

/**
 * The sync points in the sound lane's header: each one's ms (1 ms steps) and whether it is detected or set, "back to
 * detected" and "save the detected ones" (so the game gets them: an unsaved sync point is 0 there). Fixed widths:
 * nothing moves when a state changes.
 */
export function SyncFields({ sync }: { sync: SyncView }) {
  const { t } = useI18n()
  const field = (side: SyncSide, label: string) => <label className="editor-sync-field">{label}
    <NumberField value={side.ms} min={0} max={Math.round(side.durSec * 1000)} step={1} disabled={!side.ref} label={t('editor.sync.field', { kind: label })}
      onCommit={x => { if (side.ref) commitSync([{ ref: side.ref, ms: clampMs(side, x) }]) }} /> ms
    <span className={`editor-sync-state ${side.auto ? 'auto' : 'set'}`}>{t(side.auto ? 'editor.sync.auto' : 'editor.sync.set')}</span></label>
  const sides = [sync.sound, sync.haptic]
  const manual = sides.filter(s => s.ref && !s.auto), unsaved = sides.filter(s => s.ref && s.auto)
  /** Haptic start − sound start (ms): > 0 the haptic starts after the sound. */
  const after = sync.sound.ms - sync.haptic.ms
  return <span className="editor-sync-fields" title={t('editor.sync.hint')}>
    <span className="editor-sync-title">{t('editor.sync.title')}</span>
    {field(sync.sound, t('editor.sync.sound'))}
    {field(sync.haptic, t('editor.sync.haptic'))}
    <span className="editor-sync-shift">{t(after >= 0 ? 'editor.sync.after' : 'editor.sync.before', { ms: Math.abs(after) })}</span>
    <button type="button" className="toolbar-btn" style={{ visibility: manual.length ? 'visible' : 'hidden' }} title={t('editor.sync.resetHint')}
      onClick={() => commitSync(manual.map(s => ({ ref: s.ref!, ms: null })))}>{t('editor.sync.reset')}</button>
    <button type="button" className="toolbar-btn" style={{ visibility: unsaved.length ? 'visible' : 'hidden' }} title={t('editor.sync.saveHint')}
      onClick={() => commitSync(unsaved.map(s => ({ ref: s.ref!, ms: s.autoMs })))}>{t('editor.sync.save')}</button>
  </span>
}
