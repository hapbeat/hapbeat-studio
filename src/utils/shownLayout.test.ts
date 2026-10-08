import { describe, expect, it } from 'vitest'
import { foldTime, layoutPlacements, layoutStatus, unfoldTime } from './shownLayout'
import { loopPhaseAt } from './loopStretch'
import { DEFAULT_UI_SETTINGS, sanitizeUiSettings } from './editorUiSettings'
import { formatMessage, messages } from '@/i18n/messages'
import { applyEmits } from './sceneEmit'
import { resolveTrialScene } from './trialScene'
import type { CueEmit } from './sceneCueTable'
import { sampleData, sampleLib, sampleTable } from './sceneTestFixtures'

const text = (layout: Parameters<typeof layoutStatus>[0], locale: 'ja' | 'en') => {
  const { id, params } = layoutStatus(layout)
  return formatMessage(messages[id][locale], params)
}

describe('waveform panel: one file or the material at its firings', () => {
  it('says one file with its own length', () => {
    const layout = { materialSec: 0.12, starts: null }
    expect(text(layout, 'ja')).toBe('素材ファイル 1 本（0.12 s）')
    expect(text(layout, 'en')).toBe('One material file (0.12 s)')
    expect(layoutPlacements(layout)).toEqual([])
  })

  it('says a sequence with the firing count and the file length, one span per firing', () => {
    const layout = { materialSec: 0.12, starts: [0, 0.4, 0.9, 1.3, 1.8, 2.2] }
    expect(text(layout, 'ja')).toBe('発生に合わせた並び（6 回・素材 0.12 s）')
    expect(text(layout, 'en')).toBe('Placed at the firings (6× · material 0.12 s)')
    const spans = layoutPlacements(layout)
    expect(spans).toHaveLength(6)
    expect(spans.map(p => p.start)).toEqual(layout.starts)
    spans.forEach(p => expect(p.end - p.start).toBeCloseTo(0.12))
  })

  it('a single firing placed at the scene is still a sequence of one', () => {
    expect(text({ materialSec: 0.2, starts: [0] }, 'ja')).toBe('発生に合わせた並び（1 回・素材 0.20 s）')
  })
})

describe('emit cue (DEC-088): the sequence follows the generated firings', () => {
  it('the representative run of an emitting cue is cut from the generated firings, not the recorded one', () => {
    const lib = sampleLib(), table = sampleTable()
    table.cues.grab.emit = { during: 'feed_loop', intervalSec: 0.5, jitterPct: 30 } as CueEmit
    const data = applyEmits(sampleData(), table, lib, 1)
    const generated = data.full.events.filter(e => e.name === 'grab').map(e => e.t)
    const state = resolveTrialScene({ lib, data, scene: { project: lib.project_name, cues: ['grab'] }, targets: ['grab'] })
    expect(state.kind).toBe('ready')
    const chosen = state.kind === 'ready' ? state.chosen : null
    // As useAuditionPlan: the targets' times, from the first firing.
    const fired = chosen!.marks.filter(m => m.target).map(m => m.t)
    expect(fired.length).toBeGreaterThan(1)
    fired.forEach(t => expect(generated).toContain(t))
    expect(fired).not.toContain(3.1)
  })
})

describe('「発生に合わせて並べる」 off: the scene-timed playback folded onto the file drawn once', () => {
  it('is off by default (folder-synced editor setting)', () => {
    expect(DEFAULT_UI_SETTINGS.placeAtFirings).toBe(false)
    expect(sanitizeUiSettings({ ...DEFAULT_UI_SETTINGS, placeAtFirings: true }).placeAtFirings).toBe(true)
    expect(sanitizeUiSettings({ placeAtFirings: 'yes' }).placeAtFirings).toBe(false)
  })

  it('one-shots: the playhead is the time since the latest firing, hidden after the material until the next one', () => {
    const view = { materialSec: 0.12, starts: [0, 0.4, 0.9], loop: null }
    expect(foldTime(view, 0.05)).toBeCloseTo(0.05)
    expect(foldTime(view, 0.2)).toBeNull()
    expect(foldTime(view, 0.45)).toBeCloseTo(0.05)
    expect(foldTime(view, 1.0)).toBeCloseTo(0.1)
    expect(foldTime(view, 1.5)).toBeNull()
    // A click at material time t plays from the first firing + t.
    expect(unfoldTime(view, 0.07)).toBeCloseTo(0.07)
    expect(unfoldTime({ ...view, starts: [0.3, 0.8] }, 0.07)).toBeCloseTo(0.37)
  })

  it('loop: the playhead is the phase within the material, hidden between segments; a click maps from the first segment', () => {
    const loop = { segments: [{ start: 0.1, end: 2.1 }, { start: 3, end: 4 }], level: () => ({ gain: 1, rate: 1 }) }
    const view = { materialSec: 0.5, starts: [0], loop }
    expect(foldTime(view, 0.05)).toBeNull()
    expect(foldTime(view, 0.3)).toBeCloseTo(0.2)
    expect(foldTime(view, 0.85)).toBeCloseTo(0.25)
    expect(foldTime(view, 2.5)).toBeNull()
    expect(foldTime(view, 3.2)).toBeCloseTo(0.2)
    expect(unfoldTime(view, 0.2)).toBeCloseTo(0.3)
  })

  it('loop phase follows the recorded rate', () => {
    const loop = { segments: [{ start: 0, end: 2 }], level: () => ({ gain: 1, rate: 2 }) }
    expect(loopPhaseAt(loop, 0.5, 0.2)).toBeCloseTo(0.4)
    expect(loopPhaseAt(loop, 0.5, 0.3)).toBeCloseTo(0.1)
  })
})
