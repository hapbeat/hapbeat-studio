import { create } from 'zustand'
import type {
  WaveformClip,
  EffectEntry,
  EffectParams,
  WaveformRegion,
  UndoSnapshot,
  SampleRate,
} from '@/types/waveform'
import { getDefaultParams } from '@/types/waveform'
import { decodeAudioFile, encodeWavBlob, encodeMonoWavBlob, validateWavForExport } from '@/utils/wavIO'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Create a new AudioBuffer from snapshot data */
function snapshotToBuffer(snapshot: UndoSnapshot): AudioBuffer {
  const ctx = new AudioContext()
  const buffer = ctx.createBuffer(
    snapshot.numberOfChannels,
    snapshot.channelData[0].length,
    snapshot.sampleRate
  )
  for (let ch = 0; ch < snapshot.numberOfChannels; ch++) {
    buffer.copyToChannel(snapshot.channelData[ch] as Float32Array<ArrayBuffer>, ch)
  }
  return buffer
}

/** Create a snapshot from an AudioBuffer */
function bufferToSnapshot(buffer: AudioBuffer, label: string): UndoSnapshot {
  const channelData: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channelData.push(buffer.getChannelData(ch).slice())
  }
  return {
    channelData,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    label,
  }
}

/** Clone an AudioBuffer */
function cloneBuffer(buffer: AudioBuffer): AudioBuffer {
  const ctx = new AudioContext()
  const clone = ctx.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate
  )
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    clone.copyToChannel(new Float32Array(buffer.getChannelData(ch)), ch)
  }
  return clone
}

/** Encode AudioBuffer to WAV Blob for WaveSurfer display */
function bufferToDisplayBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels
  const length = buffer.length
  const sampleRate = buffer.sampleRate
  const dataSize = length * numChannels * 2
  const ab = new ArrayBuffer(44 + dataSize)
  const view = new DataView(ab)

  const w = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
  }

  w(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * 2, true)
  view.setUint16(32, numChannels * 2, true)
  view.setUint16(34, 16, true)
  w(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([ab], { type: 'audio/wav' })
}

/** Update clip with new buffer and regenerate displayBlob */
function clipWithNewBuffer(clip: WaveformClip, buffer: AudioBuffer): WaveformClip {
  return { ...clip, buffer, displayBlob: bufferToDisplayBlob(buffer) }
}

interface WaveformState {
  clip: WaveformClip | null
  effects: EffectEntry[]
  selectedRegion: WaveformRegion | null
  isProcessing: boolean
  zoom: number
  undoStack: UndoSnapshot[]
  redoStack: UndoSnapshot[]
  exportAsMono: boolean

  loadFile: (file: File) => Promise<void>
  setClipName: (name: string) => void
  setExportSampleRate: (rate: SampleRate) => void
  setEventId: (eventId: string) => void
  setExportAsMono: (mono: boolean) => void

  addEffect: (type: EffectParams['type']) => void
  updateEffect: (id: string, params: EffectParams) => void
  removeEffect: (id: string) => void
  toggleEffect: (id: string) => void

  setSelectedRegion: (region: WaveformRegion | null) => void
  cropToRegion: () => void
  deleteRegion: () => void

  undo: () => void
  redo: () => void
  pushUndoSnapshot: (label: string) => void

  replaceBuffer: (buffer: AudioBuffer, label: string) => void

  setZoom: (zoom: number) => void
  setProcessing: (processing: boolean) => void

  exportWav: () => Promise<Blob>

  revertToOriginal: () => void
  clear: () => void
}

const MAX_UNDO_DEPTH = 30

export const useWaveformStore = create<WaveformState>((set, get) => ({
  clip: null,
  effects: [],
  selectedRegion: null,
  isProcessing: false,
  zoom: 200,
  undoStack: [],
  redoStack: [],
  exportAsMono: false,

  loadFile: async (file: File) => {
    set({ isProcessing: true })
    try {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = await decodeAudioFile(arrayBuffer)
      const name = file.name.replace(/\.(wav|mp3|ogg|flac|aac|m4a)$/i, '')

      // Use the original file as displayBlob (WaveSurfer can decode WAV/MP3/etc natively)
      const displayBlob = new Blob([arrayBuffer], { type: file.type || 'audio/wav' })

      const clip: WaveformClip = {
        id: generateId(),
        name,
        buffer,
        originalBuffer: cloneBuffer(buffer),
        displayBlob,
        exportSampleRate: 44100,
        eventId: undefined,
      }

      set({
        clip,
        effects: [],
        selectedRegion: null,
        undoStack: [],
        redoStack: [],
        isProcessing: false,
      })
    } catch (err) {
      console.error('音声ファイルの読み込みに失敗:', err)
      set({ isProcessing: false })
      throw err
    }
  },

  setClipName: (name) => {
    const { clip } = get()
    if (!clip) return
    set({ clip: { ...clip, name } })
  },

  setExportSampleRate: (rate) => {
    const { clip } = get()
    if (!clip) return
    set({ clip: { ...clip, exportSampleRate: rate } })
  },

  setEventId: (eventId) => {
    const { clip } = get()
    if (!clip) return
    set({ clip: { ...clip, eventId } })
  },

  setExportAsMono: (mono) => {
    set({ exportAsMono: mono })
  },

  addEffect: (type) => {
    const entry: EffectEntry = {
      id: generateId(),
      params: getDefaultParams(type),
      enabled: true,
    }
    set((state) => ({ effects: [...state.effects, entry] }))
  },

  updateEffect: (id, params) => {
    set((state) => ({
      effects: state.effects.map((e) => (e.id === id ? { ...e, params } : e)),
    }))
  },

  removeEffect: (id) => {
    set((state) => ({
      effects: state.effects.filter((e) => e.id !== id),
    }))
  },

  toggleEffect: (id) => {
    set((state) => ({
      effects: state.effects.map((e) =>
        e.id === id ? { ...e, enabled: !e.enabled } : e
      ),
    }))
  },

  setSelectedRegion: (region) => {
    set({ selectedRegion: region })
  },

  cropToRegion: () => {
    const { clip, selectedRegion } = get()
    if (!clip || !selectedRegion) return

    get().pushUndoSnapshot('Crop')

    const { start, end } = selectedRegion
    const buffer = clip.buffer
    const startSample = Math.floor(start * buffer.sampleRate)
    const endSample = Math.floor(end * buffer.sampleRate)
    const newLength = endSample - startSample
    if (newLength <= 0) return

    const ctx = new AudioContext()
    const newBuffer = ctx.createBuffer(buffer.numberOfChannels, newLength, buffer.sampleRate)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch)
      const dst = newBuffer.getChannelData(ch)
      for (let i = 0; i < newLength; i++) dst[i] = src[startSample + i]
    }

    set({
      clip: clipWithNewBuffer(clip, newBuffer),
      selectedRegion: null,
      redoStack: [],
    })
  },

  deleteRegion: () => {
    const { clip, selectedRegion } = get()
    if (!clip || !selectedRegion) return

    get().pushUndoSnapshot('Delete Region')

    const { start, end } = selectedRegion
    const buffer = clip.buffer
    const startSample = Math.floor(start * buffer.sampleRate)
    const endSample = Math.floor(end * buffer.sampleRate)
    const newLength = buffer.length - (endSample - startSample)
    if (newLength <= 0) return

    const ctx = new AudioContext()
    const newBuffer = ctx.createBuffer(buffer.numberOfChannels, newLength, buffer.sampleRate)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch)
      const dst = newBuffer.getChannelData(ch)
      for (let i = 0; i < startSample; i++) dst[i] = src[i]
      for (let i = endSample; i < buffer.length; i++) dst[i - (endSample - startSample)] = src[i]
    }

    set({
      clip: clipWithNewBuffer(clip, newBuffer),
      selectedRegion: null,
      redoStack: [],
    })
  },

  pushUndoSnapshot: (label) => {
    const { clip, undoStack } = get()
    if (!clip) return
    const snapshot = bufferToSnapshot(clip.buffer, label)
    const newStack = [...undoStack, snapshot]
    if (newStack.length > MAX_UNDO_DEPTH) newStack.shift()
    set({ undoStack: newStack })
  },

  undo: () => {
    const { clip, undoStack, redoStack } = get()
    if (!clip || undoStack.length === 0) return

    const snapshot = undoStack[undoStack.length - 1]
    const currentSnapshot = bufferToSnapshot(clip.buffer, 'redo')
    const restoredBuffer = snapshotToBuffer(snapshot)

    set({
      clip: clipWithNewBuffer(clip, restoredBuffer),
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, currentSnapshot],
    })
  },

  redo: () => {
    const { clip, undoStack, redoStack } = get()
    if (!clip || redoStack.length === 0) return

    const snapshot = redoStack[redoStack.length - 1]
    const currentSnapshot = bufferToSnapshot(clip.buffer, 'undo')
    const restoredBuffer = snapshotToBuffer(snapshot)

    set({
      clip: clipWithNewBuffer(clip, restoredBuffer),
      undoStack: [...undoStack, currentSnapshot],
      redoStack: redoStack.slice(0, -1),
    })
  },

  replaceBuffer: (buffer, label) => {
    const { clip } = get()
    if (!clip) return
    get().pushUndoSnapshot(label)
    set({
      clip: clipWithNewBuffer(clip, buffer),
      redoStack: [],
    })
  },

  setZoom: (zoom) => {
    set({ zoom: Math.max(10, Math.min(2000, zoom)) })
  },

  setProcessing: (processing) => {
    set({ isProcessing: processing })
  },

  exportWav: async () => {
    const { clip, exportAsMono } = get()
    if (!clip) throw new Error('No clip loaded')

    const validation = validateWavForExport(clip.buffer, clip.exportSampleRate)
    if (!validation.valid) throw new Error(validation.errors.join('; '))

    if (exportAsMono) return encodeMonoWavBlob(clip.buffer, clip.exportSampleRate)
    return encodeWavBlob(clip.buffer, clip.exportSampleRate)
  },

  revertToOriginal: () => {
    const { clip } = get()
    if (!clip) return
    get().pushUndoSnapshot('Revert')
    set({
      clip: clipWithNewBuffer(clip, cloneBuffer(clip.originalBuffer)),
      redoStack: [],
    })
  },

  clear: () => {
    set({
      clip: null,
      effects: [],
      selectedRegion: null,
      isProcessing: false,
      undoStack: [],
      redoStack: [],
    })
  },
}))
