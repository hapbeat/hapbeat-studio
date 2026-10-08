import { describe, expect, it, vi } from 'vitest'
import { decidedSoundEvents } from './decidedSound'
import { representativeSound } from './cueEvents'
import { CompanionSound } from './companionSound'
import { sampleLib, sampleTable } from './sceneTestFixtures'

describe('decided sound with what the editor shows', () => {
  const base = { auditioning: false, audition: null, preview: null, adjusting: null, openProject: 'mill' }

  it('an adjusted haptic material plays its event\'s representative sound once (one source started)', () => {
    const names = decidedSoundEvents({ ...base, adjusting: { project: 'mill', event: 'button', target: 'haptic' } })
    expect(names).toEqual(['button'])
    const buffers = { Click: { duration: 0.2 } as AudioBuffer }
    const picked = representativeSound(sampleTable(), sampleLib(), names, buffers)
    expect(picked?.buffer).toBe(buffers.Click)
    const start = vi.fn(() => ({ stop: vi.fn() }))
    const companion = new CompanionSound(start)
    companion.setSource(picked)
    companion.play(0)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(picked, 0, 0)
  })

  it('no extra sound with an adjusted sound material, another project, or a sound preview; auditions as before', () => {
    expect(decidedSoundEvents({ ...base, adjusting: { project: 'mill', event: 'button', target: 'sound' } })).toEqual([])
    expect(decidedSoundEvents({ ...base, adjusting: { project: 'other', event: 'button', target: 'haptic' } })).toEqual([])
    expect(decidedSoundEvents({ ...base, preview: { event: 'button', target: 'sound' } })).toEqual([])
    expect(decidedSoundEvents({ ...base, preview: { event: 'button', target: 'haptic' } })).toEqual(['button'])
    expect(decidedSoundEvents({ ...base, auditioning: true, audition: { project: 'mill', cues: ['button', 'grab'] } })).toEqual(['button', 'grab'])
    expect(decidedSoundEvents({ ...base, auditioning: true, audition: null })).toEqual([])
  })
})
