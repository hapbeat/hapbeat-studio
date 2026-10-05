/**
 * Bringing a dock panel to the front without disturbing it. dockview's
 * `setActive()` on the panel its group already shows re-renders it (the
 * content element is removed and appended again), which resets every scroll
 * position inside the panel — e.g. the AI trials list jumped to the top on each
 * Space / ▶. So a panel that is already the shown tab of its group is left alone.
 */
export interface ActivatablePanel { api: { isVisible: boolean; setActive: () => void } }

/** Activates `panel` only when it is not already shown; returns whether it was activated. */
export function showDockPanel(panel: ActivatablePanel): boolean {
  if (panel.api.isVisible) return false
  panel.api.setActive()
  return true
}
