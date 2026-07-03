/**
 * Demo/screenshot mode flag check (`?demo=1`).
 *
 * Deliberately tiny and dependency-free so it can be imported statically
 * from `main.tsx` and `useHelperConnection.tsx` without pulling any demo
 * *data* into the production bundle — only this one-line boolean check
 * ships unconditionally. The actual seed data/logic lives in
 * `src/demo/seedDemo.ts` and is loaded via a guarded dynamic `import()`
 * that only resolves when this returns true (see `src/main.tsx`).
 *
 * Read once per page load and cached — `?demo=1` is a startup flag, not
 * a live toggle, so re-checking `location.search` on every call would
 * be pointless and (in SSR-less Vite/browser context) harmless but
 * wasteful.
 */
let cached: boolean | null = null

export function isDemoMode(): boolean {
  if (cached !== null) return cached
  try {
    cached = new URLSearchParams(window.location.search).get('demo') === '1'
  } catch {
    cached = false
  }
  return cached
}
