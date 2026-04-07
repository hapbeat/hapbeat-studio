import { useRef, useEffect, useCallback } from 'react'
import type { EnvelopePoint } from '@/types/waveform'

interface EnvelopeCanvasProps {
  points: EnvelopePoint[]
  onChange: (points: EnvelopePoint[]) => void
}

export function EnvelopeCanvas({ points, onChange }: EnvelopeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draggingRef = useRef<number | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * window.devicePixelRatio
    canvas.height = rect.height * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

    const w = rect.width
    const h = rect.height
    const pad = 8

    // Background
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--bg-primary') || '#1a1a2e'
    ctx.fillRect(0, 0, w, h)

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = pad + ((h - 2 * pad) * i) / 4
      ctx.beginPath()
      ctx.moveTo(pad, y)
      ctx.lineTo(w - pad, y)
      ctx.stroke()
    }

    if (points.length === 0) return

    // Envelope line
    ctx.strokeStyle = '#a78bfa'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < points.length; i++) {
      const x = pad + points[i].time * (w - 2 * pad)
      const y = pad + (1 - points[i].value) * (h - 2 * pad)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Fill under curve
    ctx.fillStyle = 'rgba(124, 92, 191, 0.15)'
    ctx.beginPath()
    ctx.moveTo(pad + points[0].time * (w - 2 * pad), h - pad)
    for (let i = 0; i < points.length; i++) {
      const x = pad + points[i].time * (w - 2 * pad)
      const y = pad + (1 - points[i].value) * (h - 2 * pad)
      ctx.lineTo(x, y)
    }
    ctx.lineTo(pad + points[points.length - 1].time * (w - 2 * pad), h - pad)
    ctx.closePath()
    ctx.fill()

    // Points
    for (let i = 0; i < points.length; i++) {
      const x = pad + points[i].time * (w - 2 * pad)
      const y = pad + (1 - points[i].value) * (h - 2 * pad)

      ctx.fillStyle = i === draggingRef.current ? '#e0e0e0' : '#7c5cbf'
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = '#e0e0e0'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }, [points])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [draw])

  const getPointAt = useCallback(
    (clientX: number, clientY: number): { index: number; time: number; value: number } | null => {
      const canvas = canvasRef.current
      if (!canvas) return null

      const rect = canvas.getBoundingClientRect()
      const pad = 8
      const x = clientX - rect.left
      const y = clientY - rect.top

      const time = Math.max(0, Math.min(1, (x - pad) / (rect.width - 2 * pad)))
      const value = Math.max(0, Math.min(1, 1 - (y - pad) / (rect.height - 2 * pad)))

      // Check if near existing point
      for (let i = 0; i < points.length; i++) {
        const px = pad + points[i].time * (rect.width - 2 * pad)
        const py = pad + (1 - points[i].value) * (rect.height - 2 * pad)
        const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2)
        if (dist < 10) {
          return { index: i, time: points[i].time, value: points[i].value }
        }
      }

      return { index: -1, time, value }
    },
    [points]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const hit = getPointAt(e.clientX, e.clientY)
      if (!hit) return

      if (hit.index >= 0) {
        draggingRef.current = hit.index
      } else {
        // Add new point
        const newPoints = [...points, { time: hit.time, value: hit.value }]
        newPoints.sort((a, b) => a.time - b.time)
        onChange(newPoints)
        // Find index of newly added point
        const newIndex = newPoints.findIndex(
          (p) => p.time === hit.time && p.value === hit.value
        )
        draggingRef.current = newIndex
      }
    },
    [points, onChange, getPointAt]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (draggingRef.current === null) return

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const pad = 8
      const time = Math.max(0, Math.min(1, (e.clientX - rect.left - pad) / (rect.width - 2 * pad)))
      const value = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top - pad) / (rect.height - 2 * pad)))

      const idx = draggingRef.current
      // First and last points: lock time to 0 and 1
      const newPoints = points.map((p, i) => {
        if (i !== idx) return p
        const newTime = i === 0 ? 0 : i === points.length - 1 ? 1 : time
        return { time: newTime, value }
      })
      newPoints.sort((a, b) => a.time - b.time)
      onChange(newPoints)
    },
    [points, onChange]
  )

  const handleMouseUp = useCallback(() => {
    draggingRef.current = null
  }, [])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const hit = getPointAt(e.clientX, e.clientY)
      if (!hit || hit.index < 0) return

      // Don't delete first/last points
      if (hit.index === 0 || hit.index === points.length - 1) return

      const newPoints = points.filter((_, i) => i !== hit.index)
      onChange(newPoints)
    },
    [points, onChange, getPointAt]
  )

  return (
    <div className="envelope-canvas-container">
      <canvas
        ref={canvasRef}
        className="envelope-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
      />
    </div>
  )
}
