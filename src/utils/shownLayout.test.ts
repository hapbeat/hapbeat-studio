import { describe, expect, it } from 'vitest'
import { layoutPlacements, layoutStatus } from './shownLayout'
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
