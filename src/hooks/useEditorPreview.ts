import { useEffect, useRef, useState } from 'react'
import type { EffectEntry, WaveformClip } from '@/types/waveform'
import { EditorPreviewRenderer } from '@/utils/editorPreview'
export function useEditorPreview(clip: WaveformClip | null, effects: EffectEntry[], enabled: boolean) {
  const renderer = useRef<EditorPreviewRenderer>()
  if (!renderer.current) renderer.current = new EditorPreviewRenderer()
  const [result, setResult] = useState<{id: string; buffer: AudioBuffer} | null>(null)
  const [status, setStatus] = useState<'idle' | 'rendering' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled || !clip) {renderer.current!.cancel(); setStatus('idle'); return}
    setStatus('rendering'); setError('')
    renderer.current!.request(clip.originalBuffer, effects, buffer => {setResult({id: clip.id, buffer}); setStatus('ready')}, error => {setError(error instanceof Error ? error.message : String(error)); setStatus('error')})
    return () => renderer.current!.cancel()
  }, [clip?.id, clip?.originalBuffer, effects, enabled])
  return {buffer: result?.id === clip?.id ? result?.buffer : undefined, status, error}
}
