import { useEffect, useRef, useState, type FunctionComponent } from 'react'
import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent, type IDockviewPanel, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useSceneSettings } from '@/stores/sceneSettings'
import { SceneVideoPanel } from './SceneVideoPanel'
import { SceneTimelinePanel } from './SceneTimelinePanel'
import { SceneMomentsPanel } from './SceneMomentsPanel'
import { SceneProjectPanel } from './SceneProjectPanel'
import { SceneEventPanel } from './SceneEventPanel'
import { withoutDockPanels } from '@/utils/dockPanels'

export const SCENE_PANELS = ['video', 'timeline', 'moments', 'event', 'project'] as const
/** Panels of earlier Studios, dropped from saved layouts (the old per-cue Haptics / Sound panels: the Event panel edits materials). */
const REMOVED_PANELS = ['haptics', 'sound']
export type ScenePanelId = typeof SCENE_PANELS[number]
export const SCENE_PANEL_TITLES: Record<ScenePanelId, MessageId> = {
  video: 'scene.panel.video', timeline: 'scene.panel.timeline', moments: 'scene.panel.moments',
  event: 'scene.panel.event', project: 'scene.panel.project',
}
type Translate = (id: MessageId, params?: Record<string, string | number>) => string

/** dockview needs stable component references; each panel reads shared state from context / stores. */
const COMPONENTS: Record<ScenePanelId, FunctionComponent<IDockviewPanelProps>> = {
  video: () => <SceneVideoPanel />,
  timeline: () => <SceneTimelinePanel />,
  moments: () => <SceneMomentsPanel />,
  event: () => <SceneEventPanel />,
  project: () => <SceneProjectPanel />,
}

/** Where a panel goes when it is (re)opened from the View menu without a saved position. */
function addPanel(api: DockviewApi, id: ScenePanelId, t: Translate, inactive = false): IDockviewPanel {
  const base = { id, component: id, title: t(SCENE_PANEL_TITLES[id]), inactive }
  const near = (reference: ScenePanelId, direction: 'left' | 'right' | 'above' | 'below' | 'within') =>
    api.getPanel(reference) ? { position: { referencePanel: reference, direction } } : undefined
  switch (id) {
    case 'video': return api.addPanel({ ...base, ...(near('timeline', 'above') ?? {}) })
    case 'timeline': return api.addPanel({ ...base, ...(near('video', 'below') ?? { position: { direction: 'below' } }), initialHeight: 210 })
    case 'moments': return api.addPanel({ ...base, position: { direction: 'left' }, initialWidth: 270 })
    case 'event': return api.addPanel({ ...base, ...(near('project', 'within') ?? { position: { direction: 'right' } }), initialWidth: 420 })
    case 'project': return api.addPanel({ ...base, ...(near('event', 'within') ?? { position: { direction: 'right' } }), initialWidth: 420 })
  }
}

export function buildDefaultSceneLayout(api: DockviewApi, t: Translate) {
  api.clear()
  addPanel(api, 'video', t)
  addPanel(api, 'timeline', t)
  addPanel(api, 'moments', t)
  addPanel(api, 'event', t)
  addPanel(api, 'project', t, true)
  api.getPanel('video')?.api.setActive()
}

export function toggleScenePanel(api: DockviewApi, id: ScenePanelId, t: Translate) {
  const panel = api.getPanel(id)
  if (panel) panel.api.close(); else addPanel(api, id, t)
}

/** The layout as saved, with the panels this Studio knows (later Studios add their new panels once). */
const savedLayout = (api: DockviewApi): Record<string, unknown> => ({ ...(api.toJSON() as unknown as Record<string, unknown>), knownPanels: [...SCENE_PANELS] })

function applySavedLayout(api: DockviewApi, layout: Record<string, unknown> | null, t: Translate): boolean {
  if (!layout) { buildDefaultSceneLayout(api, t); return true }
  try {
    api.fromJSON(withoutDockPanels(layout, REMOVED_PANELS) as unknown as Parameters<DockviewApi['fromJSON']>[0])
    if (!api.panels.length) buildDefaultSceneLayout(api, t)
    // Panels added in a later Studio (not known when the layout was saved) join it once; a panel the user closed stays closed.
    const known = Array.isArray(layout.knownPanels) ? layout.knownPanels as string[] : SCENE_PANELS.filter(id => id !== 'event')
    for (const id of SCENE_PANELS) if (!known.includes(id) && !api.getPanel(id)) addPanel(api, id, t, true)
    return true
  } catch (error) {
    console.warn('[scene] saved dock layout could not be restored', error)
    buildDefaultSceneLayout(api, t)
    return false
  }
}

/**
 * Dockable Scene panels (dockview, like the editor). The layout is saved to
 * the Scene settings on every change and re-applied when settings are replaced
 * (project copy, import, reset).
 */
export function SceneDockLayout({ onApi, onNotice }: { onApi: (api: DockviewApi | null) => void; onNotice: (message: string) => void }) {
  const { t, locale } = useI18n()
  const apiRef = useRef<DockviewApi | null>(null)
  const tRef = useRef(t); tRef.current = t
  const callbacks = useRef({ onApi, onNotice }); callbacks.current = { onApi, onNotice }
  const layoutRevision = useSceneSettings(state => state.layoutRevision)
  const applying = useRef(false)
  const [built, setBuilt] = useState(0)

  const apply = (api: DockviewApi) => {
    applying.current = true
    try {
      if (!applySavedLayout(api, useSceneSettings.getState().dockLayout, tRef.current)) callbacks.current.onNotice(tRef.current('editor.settings.layoutReset'))
    } finally { applying.current = false }
    useSceneSettings.getState().update({ dockLayout: savedLayout(api) })
    setBuilt(n => n + 1)
  }

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api
    apiRef.current = api
    apply(api)
    let timer: ReturnType<typeof setTimeout> | undefined
    api.onDidLayoutChange(() => {
      if (applying.current) return
      clearTimeout(timer)
      timer = setTimeout(() => { if (apiRef.current === api) useSceneSettings.getState().update({ dockLayout: savedLayout(api) }) }, 300)
    })
    callbacks.current.onApi(api)
  }
  useEffect(() => () => { apiRef.current = null; callbacks.current.onApi(null) }, [])
  useEffect(() => { if (layoutRevision && apiRef.current) apply(apiRef.current) }, [layoutRevision])
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    for (const id of SCENE_PANELS) api.getPanel(id)?.api.setTitle(t(SCENE_PANEL_TITLES[id]))
  }, [locale, t, built])

  return <div className="editor-dock-root scene-dock-root">
    <DockviewReact components={COMPONENTS} onReady={onReady} theme={themeDark} />
  </div>
}
