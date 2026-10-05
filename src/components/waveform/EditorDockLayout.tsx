import { useEffect, useRef, useState, type FunctionComponent, type ReactNode } from 'react'
import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanel, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { useEditorSettings } from '@/stores/editorSettings'
import { useAgentTrialStore } from '@/stores/agentTrialStore'
import { filterTrials, trialQueue } from '@/utils/trialQueue'
import { ClipsPanel } from './ClipsPanel'
import { WaveformPanel } from './WaveformPanel'
import { PropertiesPanel } from './PropertiesPanel'
import { EffectsDockPanel } from './EffectsPanel'
import { AgentTrialsPanel } from './AgentTrialsPanel'
import { EditorScenePanel } from './EditorScenePanel'
import { EventsPanel } from './EventsPanel'
import { showDockPanel } from '@/utils/dockPanels'

export const EDITOR_PANELS = ['clips', 'events', 'waveform', 'properties', 'effects', 'agent', 'scene'] as const
export type EditorPanelId = typeof EDITOR_PANELS[number]
export const PANEL_TITLES: Record<EditorPanelId, MessageId> = {
  clips: 'editor.panel.clips', events: 'editor.panel.events', waveform: 'editor.panel.waveform', properties: 'editor.panel.properties',
  effects: 'editor.panel.effects', agent: 'editor.agent.tab', scene: 'editor.panel.scene',
}
type Translate = (id: MessageId, params?: Record<string, string | number>) => string

/** Same-origin blank page dockview moves popped-out groups into (public/popout.html). */
export const POPOUT_URL = `${import.meta.env.BASE_URL}popout.html`

/**
 * Every panel sits in a focusable frame: a click anywhere in it focuses the panel, and the
 * frame (always reserved, coloured while focused) shows which panel has the keyboard.
 */
function PanelFrame({ children }: { children: ReactNode }) {
  return <div className="editor-dock-panel" tabIndex={-1}>{children}</div>
}

/** dockview needs stable component references; each panel reads shared editor state from context. */
const COMPONENTS: Record<EditorPanelId, FunctionComponent<IDockviewPanelProps>> = {
  clips: () => <PanelFrame><ClipsPanel /></PanelFrame>,
  events: () => <PanelFrame><EventsPanel /></PanelFrame>,
  waveform: () => <PanelFrame><WaveformPanel /></PanelFrame>,
  properties: () => <PanelFrame><PropertiesPanel /></PanelFrame>,
  effects: () => <PanelFrame><EffectsDockPanel /></PanelFrame>,
  agent: () => <PanelFrame><AgentTrialsPanel /></PanelFrame>,
  scene: () => <PanelFrame><EditorScenePanel /></PanelFrame>,
}

/** Where a panel goes when it is (re)opened from the View menu without a saved position. */
function addPanel(api: DockviewApi, id: EditorPanelId, t: Translate, inactive = false): IDockviewPanel {
  const base = { id, component: id, title: t(PANEL_TITLES[id]), inactive }
  const near = (reference: EditorPanelId, direction: 'left' | 'right' | 'above' | 'below' | 'within') =>
    api.getPanel(reference) ? { position: { referencePanel: reference, direction } } : {}
  switch (id) {
    case 'waveform': return api.addPanel(base)
    case 'clips': return api.addPanel({ ...base, ...(api.getPanel('waveform') ? near('waveform', 'left') : { position: { direction: 'left' } }), initialWidth: 270 })
    // A tab next to Clips (the game project's events and their decided sound / haptic).
    case 'events': return api.addPanel({ ...base, ...(api.getPanel('clips') ? near('clips', 'within') : api.getPanel('waveform') ? near('waveform', 'left') : { position: { direction: 'left' } }), initialWidth: 270 })
    case 'effects': return api.addPanel({ ...base, ...(api.getPanel('agent') ? near('agent', 'within') : api.getPanel('waveform') ? near('waveform', 'right') : { position: { direction: 'right' } }), initialWidth: 380 })
    case 'agent': return api.addPanel({ ...base, ...(api.getPanel('effects') ? near('effects', 'within') : { position: { direction: 'right' } }), initialWidth: 380 })
    // Not in the default layout: shown from the View menu, next to the AI trials it belongs to.
    case 'scene': return api.addPanel({ ...base, ...(api.getPanel('agent') ? near('agent', 'above') : api.getPanel('waveform') ? near('waveform', 'right') : { position: { direction: 'right' } }), initialWidth: 380, initialHeight: 260 })
    case 'properties': return api.addPanel({ ...base, ...(api.getPanel('waveform') ? near('waveform', 'below') : { position: { direction: 'below' } }), initialHeight: 180 })
  }
}

export function buildDefaultLayout(api: DockviewApi, t: Translate) {
  api.clear()
  addPanel(api, 'waveform', t)
  addPanel(api, 'clips', t)
  addPanel(api, 'events', t, true)
  addPanel(api, 'effects', t)
  addPanel(api, 'agent', t, true)
  addPanel(api, 'properties', t)
  api.getPanel('waveform')?.api.setActive()
}

/** Shows the panel (re-adding it if it was closed) and brings its tab to the front. */
export function focusPanel(api: DockviewApi, id: EditorPanelId, t: Translate) {
  // A panel already shown keeps its scroll position (see showDockPanel).
  showDockPanel(api.getPanel(id) ?? addPanel(api, id, t))
}

export function togglePanel(api: DockviewApi, id: EditorPanelId, t: Translate) {
  const panel = api.getPanel(id)
  if (panel) panel.api.close(); else addPanel(api, id, t)
}

function applySavedLayout(api: DockviewApi, layout: Record<string, unknown> | null, t: Translate): boolean {
  if (!layout) { buildDefaultLayout(api, t); return true }
  try {
    api.fromJSON(layout as unknown as Parameters<DockviewApi['fromJSON']>[0])
    if (!api.panels.length) buildDefaultLayout(api, t)
    return true
  } catch (error) {
    console.warn('[editor] saved dock layout could not be restored', error)
    buildDefaultLayout(api, t)
    return false
  }
}

function PopoutAction({ api, containerApi, group, location }: IDockviewHeaderActionsProps) {
  const { t } = useI18n()
  const popped = location?.type === 'popout'
  return <div className="editor-dock-actions">
    <button type="button" className="editor-dock-action" title={t(popped ? 'editor.panel.dockBack' : 'editor.panel.popout')} aria-label={t(popped ? 'editor.panel.dockBack' : 'editor.panel.popout')}
      onClick={() => { if (popped) api.getWindow().close(); else void containerApi.addPopoutGroup(group, { popoutUrl: POPOUT_URL }) }}>{popped ? '⧈' : '⧉'}</button>
  </div>
}

/** True when a native drag ended outside the window it started in (dropped onto the desktop / another app). */
function droppedOutside(event: DragEvent): boolean {
  const view = event.view ?? (event.target as Node | null)?.ownerDocument?.defaultView
  if (!view || event.dataTransfer?.dropEffect !== 'none') return false
  if (event.screenX === 0 && event.screenY === 0 && event.clientX === 0 && event.clientY === 0) return false // Firefox reports no position
  return event.clientX < 0 || event.clientY < 0 || event.clientX > view.innerWidth || event.clientY > view.innerHeight
}

/**
 * Dockable editor panels (dockview, MIT). The layout is saved to editor
 * settings on every change and re-applied when settings are replaced
 * (folder copy, import, reset).
 */
export function EditorDockLayout({ onApi, onPopoutWindows, onNotice }: { onApi: (api: DockviewApi | null) => void; onPopoutWindows: (windows: Window[]) => void; onNotice: (message: string) => void }) {
  const { t, locale } = useI18n()
  const apiRef = useRef<DockviewApi | null>(null)
  const tRef = useRef(t); tRef.current = t
  const callbacks = useRef({ onApi, onPopoutWindows, onNotice }); callbacks.current = { onApi, onPopoutWindows, onNotice }
  const layoutRevision = useEditorSettings(state => state.layoutRevision)
  // Same count as the AI trials header ("n left"): the unrated, not dismissed trials of the chosen project / target.
  const projectFilter = useEditorSettings(state => state.trialProjectFilter)
  const targetFilter = useEditorSettings(state => state.trialTargetFilter)
  const unrated = useAgentTrialStore(state => trialQueue(filterTrials(state.trials, projectFilter, targetFilter)).length)
  const applying = useRef(false)
  /** Bumped after every layout (re)build so titles are re-localized. */
  const [built, setBuilt] = useState(0)

  const apply = (api: DockviewApi) => {
    applying.current = true
    try {
      if (!applySavedLayout(api, useEditorSettings.getState().dockLayout, tRef.current)) callbacks.current.onNotice(tRef.current('editor.settings.layoutReset'))
    } finally { applying.current = false }
    useEditorSettings.getState().update({ dockLayout: api.toJSON() as unknown as Record<string, unknown> })
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
      timer = setTimeout(() => { if (apiRef.current === api) useEditorSettings.getState().update({ dockLayout: api.toJSON() as unknown as Record<string, unknown> }) }, 300)
    })
    const syncWindows = () => callbacks.current.onPopoutWindows(api.getPopouts().map(popout => popout.window))
    api.onDidAddPopoutGroup(syncWindows)
    api.onDidRemovePopoutGroup(syncWindows)
    api.onDidOpenPopoutWindowFail(() => callbacks.current.onNotice(tRef.current('editor.popupBlocked')))
    // Drag a tab out of the browser window → open it in its own window (Chromium reports the drop position; others ignore).
    api.onWillDragPanel(({ nativeEvent, panel }) => {
      if (!('dataTransfer' in nativeEvent) || panel.group.api.location.type === 'popout') return
      const source = nativeEvent.target as EventTarget | null
      source?.addEventListener('dragend', event => {
        const drag = event as DragEvent
        if (!droppedOutside(drag)) return
        void api.addPopoutGroup(panel, { popoutUrl: POPOUT_URL, position: { left: drag.screenX - 40, top: drag.screenY - 20, width: Math.max(360, panel.group.width), height: Math.max(260, panel.group.height) } })
      }, { once: true })
    })
    callbacks.current.onApi(api)
  }
  useEffect(() => () => { apiRef.current = null; callbacks.current.onApi(null) }, [])
  useEffect(() => { if (layoutRevision && apiRef.current) apply(apiRef.current) }, [layoutRevision])
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    for (const id of EDITOR_PANELS) api.getPanel(id)?.api.setTitle(t(PANEL_TITLES[id]) + (id === 'agent' && unrated ? ` ● ${unrated}` : ''))
    // The count's meaning, on hover (dockview has no title option for tabs).
    const tab = (api.getPanel('agent')?.view as { tab?: { element?: HTMLElement } } | undefined)?.tab?.element
    tab?.setAttribute('title', unrated ? t('editor.agent.unratedTitle', { count: unrated }) : t('editor.agent.tab'))
  }, [locale, unrated, t, built])

  return <div className="editor-dock-root">
    <DockviewReact components={COMPONENTS} onReady={onReady} theme={themeDark} popoutUrl={POPOUT_URL} rightHeaderActionsComponent={PopoutAction} />
  </div>
}
