import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { useWaveformStore } from '@/stores/waveformStore'

interface WsRegion {
  id: string
  start: number
  end: number
  remove: () => void
}

export interface WaveformDisplayHandle {
  wavesurfer: WaveSurfer | null
}

export const WaveformDisplay = forwardRef<WaveformDisplayHandle>(
  function WaveformDisplay(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const wsRef = useRef<WaveSurfer | null>(null)
    const regionsRef = useRef<RegionsPlugin | null>(null)
    const activeRegionRef = useRef<WsRegion | null>(null)
    const currentUrlRef = useRef<string | null>(null)
    const [ready, setReady] = useState(false)

    const clip = useWaveformStore((s) => s.clip)
    const zoom = useWaveformStore((s) => s.zoom)
    const setSelectedRegion = useWaveformStore((s) => s.setSelectedRegion)

    useImperativeHandle(ref, () => ({
      get wavesurfer() { return wsRef.current },
    }))

    // 1. Init WaveSurfer once on mount
    useEffect(() => {
      if (!containerRef.current) return

      const regions = RegionsPlugin.create()
      regionsRef.current = regions

      const ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: '#7c5cbf',
        progressColor: '#a78bfa',
        cursorColor: '#e0e0e0',
        cursorWidth: 1,
        height: 128,
        minPxPerSec: 200,
        normalize: true,
        plugins: [regions],
      })

      wsRef.current = ws

      regions.enableDragSelection({ color: 'rgba(124, 92, 191, 0.25)' })

      regions.on('region-created', (region: WsRegion) => {
        if (activeRegionRef.current && activeRegionRef.current.id !== region.id) {
          activeRegionRef.current.remove()
        }
        activeRegionRef.current = region
        setSelectedRegion({ start: region.start, end: region.end })
      })

      regions.on('region-updated', (region: WsRegion) => {
        setSelectedRegion({ start: region.start, end: region.end })
      })

      ws.on('ready', () => setReady(true))

      return () => {
        if (currentUrlRef.current) {
          URL.revokeObjectURL(currentUrlRef.current)
          currentUrlRef.current = null
        }
        ws.destroy()
        wsRef.current = null
        regionsRef.current = null
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 2. Load audio when displayBlob changes
    useEffect(() => {
      const ws = wsRef.current
      if (!ws) return

      // Revoke previous URL
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = null
      }

      if (clip?.displayBlob) {
        // Clear region
        if (activeRegionRef.current) {
          activeRegionRef.current.remove()
          activeRegionRef.current = null
        }

        const url = URL.createObjectURL(clip.displayBlob)
        currentUrlRef.current = url
        setReady(false)
        ws.load(url)
      } else {
        ws.empty()
        setReady(false)
      }
    }, [clip?.displayBlob])

    // 3. Zoom
    useEffect(() => {
      if (wsRef.current && ready) {
        wsRef.current.zoom(zoom)
      }
    }, [zoom, ready])

    const handleZoomChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        useWaveformStore.getState().setZoom(Number(e.target.value))
      },
      []
    )

    return (
      <div className="waveform-display">
        <div
          ref={containerRef}
          className="waveform-container"
          style={{ display: clip ? 'block' : 'none' }}
        />
        {!clip && (
          <div className="waveform-container waveform-container-empty">
            No audio loaded
          </div>
        )}
        <div className="waveform-controls">
          <label className="zoom-control">
            <span>Zoom</span>
            <input
              type="range"
              min="10"
              max="2000"
              step="10"
              value={zoom}
              onChange={handleZoomChange}
            />
          </label>
          {clip && (
            <span className="duration-info">
              {clip.buffer.duration.toFixed(3)}s |{' '}
              {clip.buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo'} |{' '}
              {clip.buffer.sampleRate} Hz
            </span>
          )}
        </div>
      </div>
    )
  }
)
