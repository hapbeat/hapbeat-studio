/** Sound / haptic colours for canvas drawing: the `--sound` / `--haptic` (`-soft`, `-strong`) custom properties of App.css. */
export type Kind = 'sound' | 'haptic'

export function kindColor(kind: Kind, tone: '' | 'soft' | 'strong' = ''): string {
  const value = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(`--${kind}${tone ? `-${tone}` : ''}`).trim()
  // Unset (no stylesheet, e.g. tests): neutral grey rather than an ignored empty canvas colour.
  return value || '#888'
}
