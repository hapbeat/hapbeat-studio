import { useEffect, useCallback, useState, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useLibraryStore } from '@/stores/libraryStore'
import { useManagerConnection } from '@/hooks/useManagerConnection'
import { useToast } from '@/components/common/Toast'
import { formatDuration, formatFileSize } from '@/utils/wavIO'
import { exportKitAsPack, downloadBlob, validateEventIds } from '@/utils/kitExporter'
import type { LibraryClip, BuiltinClipMeta, LibraryViewMode } from '@/types/library'
import type { DeviceInfo } from '@/types/manager'
import { CapacityGauge } from './CapacityGauge'
import './KitManager.css'

const DND_TYPE_CLIP = 'application/x-hapbeat-clip'
const DND_TYPE_BUILTIN = 'application/x-hapbeat-builtin'
const DND_TYPE_KIT_EVENT = 'application/x-hapbeat-kit-event'

function randomKitName(): string {
  const adj = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Zeta', 'Nova', 'Pulse', 'Volt', 'Rush']
  const noun = ['Kit', 'Pack', 'Set', 'Mix', 'Drop', 'Vibe', 'Hit', 'Boom', 'Wave', 'Beat']
  return `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}`
}

type ClipListMode = 'flat' | 'tree'

// ============================================================
// Resize handle hook
// ============================================================

function useResizeHandle(dir: 'horizontal' | 'vertical', initialPct: number) {
  const [pct, setPct] = useState(initialPct)
  const containerRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()

    const onMove = (ev: globalThis.MouseEvent) => {
      if (dir === 'vertical') {
        const y = ev.clientY - rect.top
        setPct(Math.max(15, Math.min(85, (y / rect.height) * 100)))
      } else {
        const x = ev.clientX - rect.left
        setPct(Math.max(15, Math.min(85, (x / rect.width) * 100)))
      }
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [dir])

  return { pct, containerRef, onMouseDown }
}

// ============================================================
// Main
// ============================================================

export function KitManager() {
  const isLoading = useLibraryStore((s) => s.isLoading)
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const viewMode = useLibraryStore((s) => s.viewMode)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)

  // Resize between library and kit editor (horizontal)
  const mainResize = useResizeHandle('horizontal', 60)
  // Resize between builtin and user panels
  const splitDir = viewMode === 'split-h' ? 'horizontal' : 'vertical'
  const splitResize = useResizeHandle(splitDir, 50)

  // Panel collapse
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set())
  const togglePanel = useCallback((id: string) => {
    setCollapsedPanels((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])

  useEffect(() => { loadLibrary() }, [loadLibrary])

  if (isLoading) return <div className="kit-manager-wrapper"><div className="kit-loading">Loading...</div></div>

  const isSplit = viewMode === 'split-h' || viewMode === 'split-v'
  const splitClass = viewMode === 'split-h' ? 'h' : 'v'

  const libraryContent = isSplit ? (
    <div className={`clip-library-split ${splitClass}`} ref={splitResize.containerRef}>
      {!collapsedPanels.has('builtin') && (
        <div className="split-pane" style={splitDir === 'vertical' ? { height: `${splitResize.pct}%` } : { width: `${splitResize.pct}%` }}>
          <BuiltinClipPanel onCollapse={() => togglePanel('builtin')} />
        </div>
      )}
      {!collapsedPanels.has('builtin') && !collapsedPanels.has('user') && (
        <div className={`resize-handle ${splitClass}`} onMouseDown={splitResize.onMouseDown} />
      )}
      {!collapsedPanels.has('user') && (
        <div className="split-pane" style={{ flex: 1 }}>
          <UserClipPanel onCollapse={() => togglePanel('user')} />
        </div>
      )}
      {collapsedPanels.has('builtin') && <CollapsedBar label="Built-in" onExpand={() => togglePanel('builtin')} />}
      {collapsedPanels.has('user') && <CollapsedBar label="My Clips" onExpand={() => togglePanel('user')} />}
    </div>
  ) : viewMode === 'unified' ? (
    <UnifiedClipPanel />
  ) : (
    <TabbedClipPanel />
  )

  return (
    <div className="kit-manager-wrapper">
      {!workDirSupported && (
        <div className="browser-warning">
          Your browser does not support local folder access. Use <strong>Chrome</strong> or <strong>Edge</strong>.
        </div>
      )}
      <WorkDirBar />
      <div className="kit-manager" ref={mainResize.containerRef}>
        <div className="kit-manager-left" style={{ width: `${mainResize.pct}%` }}>{libraryContent}</div>
        <div className="resize-handle h" onMouseDown={mainResize.onMouseDown} />
        <div className="kit-manager-right" style={{ flex: 1 }}><KitEditor /></div>
      </div>
    </div>
  )
}

function CollapsedBar({ label, onExpand }: { label: string; onExpand: () => void }) {
  return <button className="collapsed-bar" onClick={onExpand} title={`Show ${label}`}>{label}</button>
}

// ============================================================
// Work Dir Bar
// ============================================================

function WorkDirBar() {
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const workDirName = useLibraryStore((s) => s.workDirName)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const disconnectWorkDir = useLibraryStore((s) => s.disconnectWorkDir)
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const { toast } = useToast()

  const views: { value: LibraryViewMode; label: string; title: string }[] = [
    { value: 'split-v', label: '\u2501', title: 'Horizontal split (top/bottom)' },
    { value: 'split-h', label: '\u2503', title: 'Vertical split (left/right)' },
    { value: 'tabs', label: 'Tab', title: 'Tab view' },
    { value: 'unified', label: 'All', title: 'Unified list' },
  ]

  return (
    <div className="workdir-bar">
      <div className="view-mode-group">
        {views.map((m) => (
          <button key={m.value} className={`view-mode-btn ${viewMode === m.value ? 'active' : ''}`}
            onClick={() => setViewMode(m.value)} title={m.title}>{m.label}</button>
        ))}
      </div>
      <span className="workdir-divider" />
      {workDirSupported && (
        <>
          <span className="workdir-icon">&#x1F4C2;</span>
          {workDirName ? (
            <>
              <span className="workdir-path">{workDirName}/</span>
              <span className="workdir-status connected">Connected</span>
              <button className="workdir-btn" onClick={async () => { if (await pickWorkDir()) toast('Folder changed', 'success') }}>Change</button>
              <button className="workdir-btn disconnect" onClick={async () => { await disconnectWorkDir(); toast('Disconnected', 'success') }}>Disconnect</button>
            </>
          ) : (
            <>
              <span className="workdir-hint">No work folder</span>
              <button className="workdir-btn primary" onClick={async () => { if (await pickWorkDir()) toast('Folder set', 'success') }}>Choose Folder</button>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================
// Audio preview hook
// ============================================================

function useAudioPreview() {
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const { isConnected, devices, send } = useManagerConnection()

  const hasDevice = isConnected && devices.length > 0

  const stop = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
    setPlayingId(null)
  }, [])

  /** Toggle play/stop. intensity (0.0-1.0) is applied to PCM before streaming. */
  const toggle = useCallback(async (id: string, getBlob: () => Promise<Blob | undefined>, intensity = 1.0) => {
    if (playingId === id) { stop(); return }
    stop()
    const blob = await getBlob()
    if (!blob) return

    setPlayingId(id)

    if (hasDevice) {
      const target = devices[0].ipAddress
      // Query current device volume (wiper) right at play time → Manager will broadcast device_list update
      send({ type: 'query_volume', payload: { target } })

      const { streamClipToDevice } = await import('@/utils/audioStreamer')
      const controller = new AbortController()
      abortRef.current = controller
      try {
        await streamClipToDevice(blob, target, send, { signal: controller.signal, intensity })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') { /* cancelled */ }
        else console.error('Streaming failed:', err)
      }
      setPlayingId(null)
      abortRef.current = null
    } else {
      // Fallback: browser audio (apply intensity as volume)
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.volume = Math.min(1, Math.max(0, intensity))
      audioRef.current = audio
      audio.onended = () => { setPlayingId(null); URL.revokeObjectURL(url); audioRef.current = null }
      audio.play()
    }
  }, [playingId, stop, hasDevice, devices, send])

  /** Get current device wiper value (null if unavailable) */
  const getDeviceWiper = useCallback((): number | null => {
    if (!hasDevice) return null
    const d = devices[0]
    return (d as DeviceInfo).volumeWiper ?? null
  }, [hasDevice, devices])

  return { playingId, toggle, hasDevice, getDeviceWiper }
}

// ============================================================
// Intensity Slider — reusable component
// ============================================================

interface IntensitySliderProps {
  value: number
  onChange: (v: number) => void
  label?: string
}

function IntensitySlider({ value, onChange, label = 'Amp' }: IntensitySliderProps) {
  const [focused, setFocused] = useState(false)
  return (
    <label
      className={`intensity-slider ${focused ? 'focused' : ''}`}
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
      title="クリックでフォーカス、矢印キーで微調整"
    >
      <span className="intensity-label">{label}</span>
      <input
        type="range"
        min={0} max={1} step={0.05}
        value={value}
        draggable={false}
        onChange={(e) => onChange(Number(e.target.value))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <span className="intensity-val">{Math.round(value * 100)}%</span>
    </label>
  )
}

/** Compact popover trigger for very narrow cards — shown only when slider is hidden */
function IntensityPopover({ value, onChange }: IntensitySliderProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  return (
    <div className="intensity-popover" ref={ref}
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}>
      <button className="intensity-popover-trigger"
        onClick={() => setOpen(!open)}
        title="Amp">
        <span className="intensity-popover-label">Amp</span> {Math.round(value * 100)}%
      </button>
      {open && (
        <div className="intensity-popover-panel">
          <span className="intensity-label">Amp</span>
          <input type="range" min={0} max={1} step={0.05} value={value}
            draggable={false}
            onChange={(e) => onChange(Number(e.target.value))}
            onMouseDown={(e) => e.stopPropagation()} />
          <span className="intensity-val">{Math.round(value * 100)}%</span>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Group clips by category for tree view
// ============================================================

function groupByCategory<T>(items: T[], getCategory: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const cat = getCategory(item) || 'uncategorized'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(item)
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function builtinCategory(c: BuiltinClipMeta): string { return c.category || c.event_id.split('.')[0] }
function userCategory(c: LibraryClip): string { return c.group || c.eventId.split('.')[0] }

// ============================================================
// Built-in Panel
// ============================================================

function BuiltinClipPanel({ onCollapse }: { onCollapse?: () => void }) {
  const builtinIndex = useLibraryStore((s) => s.builtinIndex)
  const filteredBuiltinClips = useLibraryStore((s) => s.filteredBuiltinClips)
  const builtinCategories = useLibraryStore((s) => s.builtinCategories)
  const builtinCategoryFilter = useLibraryStore((s) => s.builtinCategoryFilter)
  const setBuiltinCategoryFilter = useLibraryStore((s) => s.setBuiltinCategoryFilter)
  const filter = useLibraryStore((s) => s.filter)
  const setFilter = useLibraryStore((s) => s.setFilter)
  const [listMode, setListMode] = useState<ClipListMode>('flat')
  const displayed = filteredBuiltinClips()
  const categories = builtinCategories()
  const { playingId, toggle } = useAudioPreview()

  return (
    <div className="clip-panel">
      <div className="panel-header">
        <h3>Built-in</h3>
        <span className="library-count">{builtinIndex?.length ?? 0}</span>
        <div className="panel-header-actions">
          <button className={`panel-mode-btn ${listMode === 'flat' ? 'active' : ''}`} onClick={() => setListMode('flat')} title="Flat list">=</button>
          <button className={`panel-mode-btn ${listMode === 'tree' ? 'active' : ''}`} onClick={() => setListMode('tree')} title="Tree view">&#x25B8;</button>
          {onCollapse && <button className="panel-collapse-btn" onClick={onCollapse} title="Collapse">_</button>}
        </div>
      </div>
      <div className="library-toolbar">
        <input type="text" className="library-search" placeholder="Search..." value={filter.searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })} />
      </div>
      {listMode === 'flat' && categories.length > 0 && (
        <div className="library-filters"><div className="library-tags">
          <button className={`tag-chip ${builtinCategoryFilter === null ? 'active' : ''}`}
            onClick={() => setBuiltinCategoryFilter(null)}>All</button>
          {categories.map((c) => (
            <button key={c} className={`tag-chip ${builtinCategoryFilter === c ? 'active' : ''}`}
              onClick={() => setBuiltinCategoryFilter(builtinCategoryFilter === c ? null : c)}>{c}</button>
          ))}
        </div></div>
      )}
      <div className="library-list">
        {displayed.length === 0
          ? <div className="library-empty">{builtinIndex === null ? 'Loading...' : 'No clips.'}</div>
          : listMode === 'tree' ? (
            [...groupByCategory(displayed, builtinCategory)].map(([cat, clips]) => (
              <TreeGroup key={cat} label={cat}>
                {clips.map((c) => <BuiltinClipRow key={c.id} clip={c} playingId={playingId} onToggle={toggle} />)}
              </TreeGroup>
            ))
          ) : displayed.map((c) => <BuiltinClipRow key={c.id} clip={c} playingId={playingId} onToggle={toggle} />)
        }
      </div>
    </div>
  )
}

// ============================================================
// User Panel
// ============================================================

function UserClipPanel({ onCollapse }: { onCollapse?: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const clips = useLibraryStore((s) => s.clips)
  const filteredClips = useLibraryStore((s) => s.filteredClips)
  const filter = useLibraryStore((s) => s.filter)
  const setFilter = useLibraryStore((s) => s.setFilter)
  const addClipFromFile = useLibraryStore((s) => s.addClipFromFile)
  const removeClip = useLibraryStore((s) => s.removeClip)
  const updateClip = useLibraryStore((s) => s.updateClip)
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const refreshClipsFromDir = useLibraryStore((s) => s.refreshClipsFromDir)
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [listMode, setListMode] = useState<ClipListMode>('flat')
  const { playingId, toggle } = useAudioPreview()
  const displayed = filteredClips()

  useEffect(() => {
    if (!workDirHandle) return
    const onFocus = () => refreshClipsFromDir()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [workDirHandle, refreshClipsFromDir])

  const handleImport = useCallback(async (files: FileList) => {
    for (const f of Array.from(files)) { try { await addClipFromFile(f) } catch (e) { console.error(e) } }
  }, [addClipFromFile])

  if (!workDirHandle) {
    return (
      <div className="clip-panel">
        <div className="panel-header"><h3>My Clips</h3>
          {onCollapse && <div className="panel-header-actions"><button className="panel-collapse-btn" onClick={onCollapse}>_</button></div>}
        </div>
        <div className="library-list">
          <div className="library-empty workdir-prompt">
            <div className="workdir-prompt-content">
              <div className="workdir-prompt-icon">&#x1F4C2;</div>
              <div className="workdir-prompt-text">
                {workDirSupported ? 'Select a work folder to manage clips.' : 'Use Chrome or Edge.'}
              </div>
              {workDirSupported && <button className="library-btn primary" onClick={pickWorkDir}>Choose Folder</button>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderClips = () => {
    if (displayed.length === 0) return <div className="library-empty">{clips.length === 0 ? 'Drop files or Import.' : 'No match.'}</div>
    const rows = displayed.map((c) => (
      <UserClipRow key={c.id} clip={c} isEditing={editingId === c.id}
        onStartEdit={() => setEditingId(c.id)} onEndEdit={() => setEditingId(null)}
        onUpdate={updateClip} onDelete={removeClip}
        playingId={playingId} onToggle={(id, intensity) => toggle(id, () => getClipAudio(id), intensity)} />
    ))
    if (listMode === 'tree') {
      return [...groupByCategory(displayed, userCategory)].map(([cat, items]) => (
        <TreeGroup key={cat} label={cat}>{items.map((c) => (
          <UserClipRow key={c.id} clip={c} isEditing={editingId === c.id}
            onStartEdit={() => setEditingId(c.id)} onEndEdit={() => setEditingId(null)}
            onUpdate={updateClip} onDelete={removeClip}
            playingId={playingId} onToggle={(id, intensity) => toggle(id, () => getClipAudio(id), intensity)} />
        ))}</TreeGroup>
      ))
    }
    return rows
  }

  return (
    <div className={`clip-panel ${dragOver ? 'drag-over' : ''}`}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length > 0) handleImport(e.dataTransfer.files) }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}>
      <div className="panel-header"><h3>My Clips</h3><span className="library-count">{clips.length}</span>
        <div className="panel-header-actions">
          <button className={`panel-mode-btn ${listMode === 'flat' ? 'active' : ''}`} onClick={() => setListMode('flat')} title="Flat">=</button>
          <button className={`panel-mode-btn ${listMode === 'tree' ? 'active' : ''}`} onClick={() => setListMode('tree')} title="Tree">&#x25B8;</button>
          {onCollapse && <button className="panel-collapse-btn" onClick={onCollapse} title="Collapse">_</button>}
        </div>
      </div>
      <div className="library-toolbar">
        <input type="text" className="library-search" placeholder="Search..." value={filter.searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })} />
        <input ref={fileInputRef} type="file" accept=".wav,.mp3,.ogg,.flac,.aac,.m4a,audio/*" multiple
          onChange={(e) => e.target.files && handleImport(e.target.files)} style={{ display: 'none' }} />
        <button className="library-btn" onClick={() => fileInputRef.current?.click()}>+ Import</button>
        <button className="library-btn" onClick={refreshClipsFromDir}>Refresh</button>
      </div>
      <div className="library-list">{renderClips()}</div>
    </div>
  )
}

// ============================================================
// Tree Group
// ============================================================

function TreeGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="tree-group">
      <button className="tree-group-header" onClick={() => setOpen(!open)}>
        <span className="tree-arrow">{open ? '\u25BE' : '\u25B8'}</span>
        <span className="tree-label">{label}</span>
      </button>
      {open && <div className="tree-group-children">{children}</div>}
    </div>
  )
}

// ============================================================
// Tabbed / Unified
// ============================================================

function TabbedClipPanel() {
  const activeTab = useLibraryStore((s) => s.activeTab)
  const setActiveTab = useLibraryStore((s) => s.setActiveTab)
  return (
    <div className="clip-panel clip-panel-full">
      <div className="library-tabs">
        <button className={`library-tab ${activeTab === 'builtin' ? 'active' : ''}`} onClick={() => setActiveTab('builtin')}>Built-in</button>
        <button className={`library-tab ${activeTab === 'user' ? 'active' : ''}`} onClick={() => setActiveTab('user')}>My Clips</button>
      </div>
      {activeTab === 'builtin' ? <BuiltinClipPanel /> : <UserClipPanel />}
    </div>
  )
}

function UnifiedClipPanel() {
  const builtinIndex = useLibraryStore((s) => s.builtinIndex)
  const filteredBuiltinClips = useLibraryStore((s) => s.filteredBuiltinClips)
  const filteredClips = useLibraryStore((s) => s.filteredClips)
  const filter = useLibraryStore((s) => s.filter)
  const setFilter = useLibraryStore((s) => s.setFilter)
  const updateClip = useLibraryStore((s) => s.updateClip)
  const removeClip = useLibraryStore((s) => s.removeClip)
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const [editingId, setEditingId] = useState<string | null>(null)
  const { playingId, toggle } = useAudioPreview()
  const bc = filteredBuiltinClips(), uc = filteredClips()

  return (
    <div className="clip-panel clip-panel-full">
      <div className="panel-header"><h3>All Clips</h3><span className="library-count">{(builtinIndex?.length ?? 0) + uc.length}</span></div>
      <div className="library-toolbar">
        <input type="text" className="library-search" placeholder="Search..." value={filter.searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })} />
      </div>
      <div className="library-list">
        {bc.length > 0 && <><div className="list-section-header">Built-in</div>
          {bc.map((c) => <BuiltinClipRow key={c.id} clip={c} playingId={playingId} onToggle={toggle} />)}</>}
        {uc.length > 0 && <><div className="list-section-header">My Clips</div>
          {uc.map((c) => <UserClipRow key={c.id} clip={c} isEditing={editingId === c.id}
            onStartEdit={() => setEditingId(c.id)} onEndEdit={() => setEditingId(null)}
            onUpdate={updateClip} onDelete={removeClip}
            playingId={playingId} onToggle={(id, intensity) => toggle(id, () => getClipAudio(id), intensity)} />)}</>}
        {bc.length === 0 && uc.length === 0 && <div className="library-empty">No clips.</div>}
      </div>
    </div>
  )
}

// ============================================================
// Clip Rows
// ============================================================

function BuiltinClipRow({ clip, playingId, onToggle }: {
  clip: BuiltinClipMeta; playingId: string | null
  onToggle: (id: string, getBlob: () => Promise<Blob | undefined>, intensity: number) => void
}) {
  const fetchAudio = useLibraryStore((s) => s.fetchBuiltinClipAudio)
  const importToLocal = useLibraryStore((s) => s.importBuiltinToLocal)
  const { toast } = useToast()
  const { devices } = useManagerConnection()
  const wiper = devices[0]?.volumeWiper ?? null
  const [intensity, setIntensity] = useState(0.5)

  return (
    <div className="clip-row">
      <div className="clip-drag-handle" draggable
        onDragStart={(e) => { e.dataTransfer.setData(DND_TYPE_BUILTIN, clip.id); e.dataTransfer.effectAllowed = 'copy' }}
        title="ドラッグして Kit に追加">&#x2630;</div>
      <button className={`clip-play-btn ${playingId === clip.id ? 'playing' : ''}`}
        onClick={() => onToggle(clip.id, () => fetchAudio(clip.id), intensity)}>
        {playingId === clip.id ? '\u25A0' : '\u25B6'}</button>
      <div className="clip-body">
        <div className="clip-row-top">
          <span className="clip-name">{clip.name}</span>
          <span className="clip-meta">{Math.round(clip.duration_ms)}ms {clip.channels === 1 ? 'M' : 'St'} {clip.sample_rate / 1000}k {formatFileSize(clip.filesize_bytes)}</span>
        </div>
        <div className="clip-row-bottom">
          <span className="clip-event-id" title="Event ID">{clip.event_id}</span>
          {clip.tags.length > 0 && <span className="clip-tags-inline">{clip.tags.join(', ')}</span>}
        </div>
      </div>
      <IntensitySlider value={intensity} onChange={setIntensity} />
      <IntensityPopover value={intensity} onChange={setIntensity} />
      <div className="clip-actions">
        <button className="clip-action-btn"
          onClick={async () => { const id = await importToLocal(clip.id); if (id) toast(`Copied "${clip.name}"`, 'success') }}>Copy</button>
      </div>
      {wiper !== null && <span className="clip-wiper-corner" title="Device volume wiper (0–127)">wiper {wiper}/127</span>}
    </div>
  )
}

function UserClipRow({ clip, isEditing, onStartEdit, onEndEdit, onUpdate, onDelete, playingId, onToggle }: {
  clip: LibraryClip; isEditing: boolean
  onStartEdit: () => void; onEndEdit: () => void
  onUpdate: (id: string, u: Partial<LibraryClip>) => Promise<void>
  onDelete: (id: string) => Promise<void>
  playingId: string | null; onToggle: (id: string, intensity: number) => void
}) {
  const [tagInput, setTagInput] = useState('')
  const [intensity, setIntensity] = useState(0.5)
  const { devices } = useManagerConnection()
  const wiper = devices[0]?.volumeWiper ?? null

  // Split eventId into category.name
  const dotIdx = clip.eventId.indexOf('.')
  const eidCategory = dotIdx > 0 ? clip.eventId.substring(0, dotIdx) : ''
  const eidName = dotIdx > 0 ? clip.eventId.substring(dotIdx + 1) : clip.eventId

  const updateEventId = useCallback((cat: string, name: string) => {
    const c = cat.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const n = name.toLowerCase().replace(/[^a-z0-9_.-]/g, '')
    onUpdate(clip.id, { eventId: c && n ? `${c}.${n}` : '' })
  }, [clip.id, onUpdate])

  if (isEditing) {
    return (
      <div className="clip-row clip-row-editing">
        <div className="clip-edit-fields">
          <label className="clip-edit-field"><span>Name</span>
            <input type="text" value={clip.name} onChange={(e) => onUpdate(clip.id, { name: e.target.value })} /></label>
          <div className="clip-edit-field"><span>Event ID <span className="field-hint">(category.name — both required)</span></span>
            <div className="event-id-inputs">
              <input type="text" value={eidCategory} placeholder="category" className="eid-category"
                onChange={(e) => updateEventId(e.target.value, eidName)} />
              <span className="eid-dot">.</span>
              <input type="text" value={eidName} placeholder="name" className="eid-name"
                onChange={(e) => updateEventId(eidCategory, e.target.value)} />
            </div>
            {(!eidCategory || !eidName) && clip.eventId !== '' && <span className="field-error">Both category and name are required</span>}
          </div>
          <label className="clip-edit-field"><span>Group</span>
            <input type="text" value={clip.group} placeholder="impacts"
              onChange={(e) => onUpdate(clip.id, { group: e.target.value })} /></label>
          <div className="clip-edit-field"><span>Tags</span>
            <div className="clip-edit-tags">
              {clip.tags.map((t) => <span key={t} className="tag-chip removable">{t}
                <button onClick={() => onUpdate(clip.id, { tags: clip.tags.filter((x) => x !== t) })}>x</button></span>)}
              <input type="text" value={tagInput} placeholder="+ tag" className="tag-input"
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { const t = tagInput.trim(); if (t && !clip.tags.includes(t)) { onUpdate(clip.id, { tags: [...clip.tags, t] }); setTagInput('') } } }} />
            </div>
          </div>
        </div>
        <div className="clip-edit-actions">
          <button className="library-btn" onClick={onEndEdit}>Done</button>
          <button className="library-btn danger" onClick={() => { onDelete(clip.id); onEndEdit() }}>Delete</button>
        </div>
      </div>
    )
  }

  return (
    <div className="clip-row" onDoubleClick={onStartEdit}>
      <div className="clip-drag-handle" draggable
        onDragStart={(e) => { e.dataTransfer.setData(DND_TYPE_CLIP, clip.id); e.dataTransfer.effectAllowed = 'copy' }}
        title="ドラッグして Kit に追加">&#x2630;</div>
      <button className={`clip-play-btn ${playingId === clip.id ? 'playing' : ''}`}
        onClick={() => onToggle(clip.id, intensity)}>
        {playingId === clip.id ? '\u25A0' : '\u25B6'}</button>
      <div className="clip-body">
        <div className="clip-row-top">
          <span className="clip-name">{clip.name}</span>
          <span className="clip-meta">{formatDuration(clip.duration)} {clip.channels === 1 ? 'M' : 'St'} {clip.sampleRate / 1000}k {formatFileSize(clip.fileSize)}</span>
        </div>
        <div className="clip-row-bottom">
          <span className={`clip-event-id ${!clip.eventId ? 'empty' : ''}`} title="Event ID">{clip.eventId || '(no ID)'}</span>
          {clip.tags.length > 0 && <span className="clip-tags-inline">{clip.tags.join(', ')}</span>}
        </div>
      </div>
      <IntensitySlider value={intensity} onChange={setIntensity} />
      <IntensityPopover value={intensity} onChange={setIntensity} />
      <div className="clip-actions">
        <button className="clip-action-btn" onClick={onStartEdit}>Edit</button>
      </div>
      {wiper !== null && <span className="clip-wiper-corner" title="Device volume wiper (0–127)">wiper {wiper}/127</span>}
    </div>
  )
}

// ============================================================
// Kit Editor
// ============================================================

function KitEditor() {
  const kits = useLibraryStore((s) => s.kits)
  const activeKitId = useLibraryStore((s) => s.activeKitId)
  const clips = useLibraryStore((s) => s.clips)
  const createKit = useLibraryStore((s) => s.createKit)
  const removeKit = useLibraryStore((s) => s.removeKit)
  const setActiveKit = useLibraryStore((s) => s.setActiveKit)
  const removeEventFromKit = useLibraryStore((s) => s.removeEventFromKit)
  const updateKitEvent = useLibraryStore((s) => s.updateKitEvent)
  const updateKit = useLibraryStore((s) => s.updateKit)
  const addEventToKit = useLibraryStore((s) => s.addEventToKit)
  const importBuiltinToLocal = useLibraryStore((s) => s.importBuiltinToLocal)
  const builtinIndex = useLibraryStore((s) => s.builtinIndex)
  const { isConnected: managerConnected, devices, send } = useManagerConnection()
  const { toast } = useToast()
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const { playingId, toggle: togglePreview, getDeviceWiper } = useAudioPreview()

  const [isExporting, setIsExporting] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const placeholderName = useRef(randomKitName())

  const activeKit = kits.find((k) => k.id === activeKitId)

  const handleCreate = useCallback(async (name?: string) => {
    const n = (name ?? placeholderName.current).trim()
    if (!n) return
    await createKit(n)
    placeholderName.current = randomKitName()
  }, [createKit])

  const getClipName = useCallback((clipId: string) => clips.find((c) => c.id === clipId)?.name ?? '?', [clips])

  const handleKitDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDropActive(false); setDragOverIdx(null)
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }
    const bid = e.dataTransfer.getData(DND_TYPE_BUILTIN)
    if (bid) {
      const meta = builtinIndex?.find((c) => c.id === bid); if (!meta) return
      const lid = await importBuiltinToLocal(bid); if (!lid) { toast('Import failed', 'error'); return }
      await addEventToKit(activeKitId, { eventId: meta.event_id, clipId: lid, loop: false, intensity: 0.5, deviceWiper: null })
      toast(`Added "${meta.name}"`, 'success'); return
    }
    const cid = e.dataTransfer.getData(DND_TYPE_CLIP)
    if (cid) {
      const c = clips.find((x) => x.id === cid); if (!c) return
      if (!c.eventId) { toast('Set Event ID first', 'error'); return }
      await addEventToKit(activeKitId, { eventId: c.eventId, clipId: c.id, loop: false, intensity: 0.5, deviceWiper: null })
      toast(`Added "${c.name}"`, 'success'); return
    }
    const evd = e.dataTransfer.getData(DND_TYPE_KIT_EVENT)
    if (evd && activeKit && dragOverIdx !== null) {
      try { const { eventId } = JSON.parse(evd); const evts = [...activeKit.events]; const from = evts.findIndex((e) => e.eventId === eventId); if (from < 0) return; const [moved] = evts.splice(from, 1); evts.splice(dragOverIdx > from ? dragOverIdx - 1 : dragOverIdx, 0, moved); await updateKit(activeKitId, { events: evts }) } catch { /* */ }
    }
  }, [activeKitId, activeKit, builtinIndex, clips, dragOverIdx, importBuiltinToLocal, addEventToKit, updateKit, toast])

  const kitSize = activeKit ? activeKit.events.reduce((s, ev) => s + (clips.find((c) => c.id === ev.clipId)?.fileSize ?? 0), 0) + 1024 : 0

  return (
    <div className="kit-editor">
      {/* Create bar with placeholder */}
      <div className="kit-create-bar">
        <input type="text" className="kit-create-input" placeholder={placeholderName.current}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const input = e.currentTarget
              handleCreate(input.value || undefined)
              input.value = ''
            }
          }} />
        <button className="library-btn primary small" onClick={(e) => {
          const input = (e.currentTarget.previousElementSibling as HTMLInputElement)
          handleCreate(input.value || undefined)
          input.value = ''
        }}>Create</button>
      </div>

      {/* Kit list with inline details */}
      <div className="kit-list-container"
        onDrop={handleKitDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropActive(true) }}
        onDragLeave={() => { setDropActive(false); setDragOverIdx(null) }}>
        {kits.length === 0 ? (
          <div className="kit-empty">Type a name above and press Enter.</div>
        ) : kits.map((k) => {
          const isActive = activeKitId === k.id
          const isThisKit = isActive && activeKit
          return (
            <div key={k.id}>
              {/* Kit header row */}
              <div className={`kit-list-item ${isActive ? 'active' : ''}`}
                onClick={() => setActiveKit(isActive ? null : k.id)}>
                <span className="kit-list-arrow">{isActive ? '\u25BE' : '\u25B8'}</span>
                <span className="kit-list-name">{k.name}</span>
                <span className="kit-list-count">{k.events.length} events</span>
                <button className="kit-list-delete" onClick={(e) => { e.stopPropagation(); removeKit(k.id) }} title="Delete">x</button>
              </div>

              {/* Inline details (only for selected kit) */}
              {isThisKit && (
                <div className={`kit-details-inline ${dropActive ? 'drop-active' : ''}`}>
                  <div className="kit-meta-fields">
                    <label className="kit-meta-field"><span>Name</span>
                      <input type="text" value={activeKit.name} onChange={(e) => updateKit(activeKit.id, { name: e.target.value })} /></label>
                    <label className="kit-meta-field"><span>Version</span>
                      <input type="text" value={activeKit.version} onChange={(e) => updateKit(activeKit.id, { version: e.target.value })} /></label>
                  </div>

                  <CapacityGauge kitSize={kitSize} managerConnected={managerConnected} devices={devices} send={send} />

                  <div className="kit-events-header">
                    <span>Events ({activeKit.events.length})</span>
                    <span className="kit-size-label">{formatFileSize(kitSize)}</span>
                  </div>

                  <div className="kit-events-list">
                    {activeKit.events.length === 0
                      ? <div className="kit-events-empty kit-drop-zone">Drag clips here.</div>
                      : activeKit.events.map((ev, i) => (
                        <div key={ev.eventId} className={`kit-event-row ${dragOverIdx === i ? 'drag-over-indicator' : ''}`}
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverIdx(i) }}>
                          <div className="clip-drag-handle" draggable
                            onDragStart={(e) => { e.dataTransfer.setData(DND_TYPE_KIT_EVENT, JSON.stringify({ eventId: ev.eventId })); e.dataTransfer.effectAllowed = 'move' }}
                            title="ドラッグして並び替え">&#x2630;</div>
                          <button className={`clip-play-btn ${playingId === ev.eventId ? 'playing' : ''}`}
                            onClick={() => {
                              togglePreview(ev.eventId, () => getClipAudio(ev.clipId), ev.intensity)
                              // Capture current device wiper into this event (auto-update)
                              const w = getDeviceWiper()
                              if (w !== null && w !== ev.deviceWiper) updateKitEvent(activeKit.id, ev.eventId, { deviceWiper: w })
                            }}
                            title={`Play at ${Math.round(ev.intensity * 100)}%`}>
                            {playingId === ev.eventId ? '\u25A0' : '\u25B6'}
                          </button>
                          <div className="kit-event-info">
                            <span className="kit-event-id">{ev.eventId}</span>
                            <span className="kit-event-clip">{getClipName(ev.clipId)}</span>
                          </div>
                          <IntensitySlider value={ev.intensity}
                            onChange={(v) => updateKitEvent(activeKit.id, ev.eventId, { intensity: v })} />
                          <IntensityPopover value={ev.intensity}
                            onChange={(v) => updateKitEvent(activeKit.id, ev.eventId, { intensity: v })} />
                          <label className="kit-event-loop">
                            <input type="checkbox" checked={ev.loop} onChange={(e) => updateKitEvent(activeKit.id, ev.eventId, { loop: e.target.checked })} />
                            <span>Loop</span>
                          </label>
                          <button className="clip-action-btn danger" onClick={() => removeEventFromKit(activeKit.id, ev.eventId)}>x</button>
                          {ev.deviceWiper !== null && <span className="clip-wiper-corner" title="Device volume wiper captured when this event was last previewed (0–127)">wiper {ev.deviceWiper}/127</span>}
                        </div>
                      ))}
                  </div>

                  <KitExportSection kit={activeKit} clips={clips} isExporting={isExporting} setIsExporting={setIsExporting}
                    managerConnected={managerConnected} devices={devices} send={send} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================
// Kit Export
// ============================================================

function KitExportSection({ kit, clips, isExporting, setIsExporting, managerConnected, devices, send }: {
  kit: import('@/types/library').KitDefinition; clips: LibraryClip[]
  isExporting: boolean; setIsExporting: (v: boolean) => void
  managerConnected: boolean
  devices: import('@/types/manager').DeviceInfo[]
  send: (msg: import('@/types/manager').ManagerMessage) => void
}) {
  const { toast } = useToast()
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)

  const handleExport = useCallback(async () => {
    const validations = validateEventIds(kit)
    const invalid = validations.filter((v) => !v.valid)
    if (invalid.length > 0) {
      const ids = invalid.map((v) => `  "${v.eventId}" — must be category.name`).join('\n')
      if (!confirm(`Invalid Event IDs:\n${ids}\n\nExport anyway?`)) return
    }
    setIsExporting(true)
    try {
      const result = await exportKitAsPack(kit, clips)
      if (workDirHandle) {
        const { writeKitFolder } = await import('@/utils/localDirectory')
        const zip = await import('jszip').then((m) => m.default)
        const zipData = await zip.loadAsync(result.blob)
        const files: { path: string; blob: Blob }[] = []
        for (const [path, entry] of Object.entries(zipData.files)) {
          if (!entry.dir) {
            const blob = await entry.async('blob')
            const relPath = path.includes('/') ? path.substring(path.indexOf('/') + 1) : path
            if (relPath) files.push({ path: relPath, blob })
          }
        }
        const packId = kit.name.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'unnamed-kit'
        await writeKitFolder(workDirHandle, packId, files)
        toast(`Saved to kits/${packId}/`, 'success')
      } else {
        downloadBlob(result.blob, result.filename)
        toast(`Downloaded "${result.filename}"`, 'success')
      }
    } catch (err) { toast(`Export failed: ${err instanceof Error ? err.message : err}`, 'error') }
    finally { setIsExporting(false) }
  }, [kit, clips, workDirHandle, setIsExporting, toast])

  const handleDeploy = useCallback(async () => {
    if (!managerConnected || devices.length === 0) { toast('No devices', 'error'); return }
    setIsExporting(true)
    try {
      const result = await exportKitAsPack(kit, clips)
      const ab = await result.blob.arrayBuffer(); const bytes = new Uint8Array(ab)
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      send({ type: 'deploy_pack_data', payload: { pack_id: kit.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), zip_base64: btoa(bin), targets: devices.map((d) => d.ipAddress) }})
      toast('Sent for deployment', 'success')
    } catch (err) { toast(`Deploy failed: ${err instanceof Error ? err.message : err}`, 'error') }
    finally { setIsExporting(false) }
  }, [kit, clips, managerConnected, devices, send, setIsExporting, toast])

  return (
    <div className="kit-export-section">
      <button className="library-btn primary" disabled={kit.events.length === 0 || isExporting} onClick={handleExport}>
        {isExporting ? '...' : workDirHandle ? 'Save Kit' : 'Export ZIP'}</button>
      <button className="library-btn primary" disabled={kit.events.length === 0 || isExporting || !managerConnected || devices.length === 0}
        onClick={handleDeploy}>Deploy</button>
      {managerConnected && devices.length > 0 && <div className="kit-export-info">{devices.length} device(s)</div>}
      {!managerConnected && <div className="kit-export-info muted">Manager offline</div>}
    </div>
  )
}
