import { useEffect, useRef, useState } from 'react'

/**
 * Observes an element's inline size via ResizeObserver.
 *
 * Returned width starts at 0 and updates once the element is measured. Use
 * `width > 0 && width < threshold` to avoid flicker on first render.
 *
 * Why not CSS container queries? Self-querying (a row with
 * `container-type: inline-size` + `@container (max-width: N) { .that-row {...} }`)
 * is silently ignored by the spec — containers only match ancestors. This hook
 * sidesteps that pitfall and keeps responsive behavior testable from React.
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        setWidth(Math.round(w))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, width }
}
