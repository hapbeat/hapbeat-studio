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

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A saved dockview layout (`toJSON()`) without the panels `ids` (panels a later Studio removed): they leave the
 * panel map and their group's tabs; a group left without tabs and a split left without children go too. Returns
 * the same object when none of them is in it (a panel unknown to the components would otherwise fail the restore).
 */
export function withoutDockPanels(layout: Json, ids: readonly string[]): Json {
  const panels = isObj(layout.panels) ? layout.panels : {}
  if (!ids.some(id => id in panels)) return layout
  const prune = (node: unknown): Json | null => {
    if (!isObj(node)) return null
    if (node.type === 'leaf' && isObj(node.data)) {
      const views = Array.isArray(node.data.views) ? (node.data.views as string[]).filter(v => !ids.includes(v)) : []
      if (!views.length) return null
      const activeView = views.includes(node.data.activeView as string) ? node.data.activeView : views[0]
      return { ...node, data: { ...node.data, views, activeView } }
    }
    if (node.type === 'branch' && Array.isArray(node.data)) {
      const children = node.data.map(prune).filter((c): c is Json => c !== null)
      return children.length ? { ...node, data: children } : null
    }
    return node
  }
  const grid = isObj(layout.grid) ? layout.grid : null
  const root = grid ? prune(grid.root) : null
  return { ...layout, panels: Object.fromEntries(Object.entries(panels).filter(([id]) => !ids.includes(id))), ...(grid ? { grid: { ...grid, root: root ?? { type: 'branch', data: [], size: 0 } } } : {}) }
}
