import { memo, useMemo } from 'react'
import { waveformOutline } from '@/utils/waveformView'
export const WaveformThumbnail = memo(function WaveformThumbnail({buffer}: {buffer: AudioBuffer}) {
  const path = useMemo(() => waveformOutline(buffer), [buffer])
  return <svg className="editor-thumbnail" viewBox="0 0 512 40" preserveAspectRatio="none" aria-hidden="true"><path d={path} fill="currentColor" /></svg>
})
