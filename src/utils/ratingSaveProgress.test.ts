import { describe, expect, it } from 'vitest'
import { useLibraryStore } from '@/stores/libraryStore'
import { ratingSavesInFlight, trackRatingSave } from './ratingSaveProgress'

const texts = (id: string) => ({ progress: (left: number) => `${id} (${left} left)`, done: `${id} done`, failed: (m: string) => `${id}: ${m}` })
const footer = () => [useLibraryStore.getState().localFsStatus, useLibraryStore.getState().localFsLastMsg]

describe('rating save progress in the log footer', () => {
  it('counts the saves in flight, names the newest, ends with saved; a failure shows as an error', () => {
    const a = trackRatingSave(texts('T1'))
    expect(footer()).toEqual(['saving', 'T1 (1 left)'])
    const b = trackRatingSave(texts('T2'))
    expect(footer()).toEqual(['saving', 'T2 (2 left)'])
    expect(ratingSavesInFlight()).toBe(2)
    a()
    expect(footer()).toEqual(['saving', 'T2 (1 left)'])
    a() // ending twice changes nothing
    expect(ratingSavesInFlight()).toBe(1)
    b()
    expect(footer()).toEqual(['saved', 'T2 done'])
    expect(ratingSavesInFlight()).toBe(0)
    trackRatingSave(texts('T3'))('disk full')
    expect(footer()).toEqual(['error', 'T3: disk full'])
    expect(ratingSavesInFlight()).toBe(0)
  })
})
