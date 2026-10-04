import { create } from 'zustand'

/**
 * A short read-out the active tab shows in the free space of the bottom log bar
 * (e.g. the editor's "PCM16 WAV · Mono · 2.1 KB"), instead of a status band of its own.
 */
export const useStatusInfo = create<{ text: string | null; set: (text: string | null) => void }>(set => ({
  text: null,
  set: text => set({ text }),
}))
