import { useEffect, useCallback, useState, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useLibraryStore } from '@/stores/libraryStore'
import { useManagerConnection } from '@/hooks/useManagerConnection'
import { useToast } from '@/components/common/Toast'
import { formatFileSize } from '@/utils/wavIO'
import { exportKitAsPack, downloadBlob, validateEventIds } from '@/utils/kitExporter'
import type { LibraryClip, LibraryViewMode } from '@/types/library'
import type { DeviceInfo } from '@/types/manager'
import { CapacityGauge } from './CapacityGauge'
import { KitEventRow } from './editor/KitEventRow'
import { ClipCard } from './shared/ClipCard'
import { ClipEditModal } from './shared/ClipEditModal'
import './KitManager.css'

const DND_TYPE_CLIP = 'application/x-hapbeat-clip'
const DND_TYPE_KIT_EVENT = 'application/x-hapbeat-kit-event'

function randomKitName(): string {
  const adj = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Zeta', 'Nova', 'Pulse', 'Volt', 'Rush']
  const noun = ['Kit', 'Pack', 'Set', 'Mix', 'Drop', 'Vibe', 'Hit', 'Boom', 'Wave', 'Beat']
  return `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}`
}

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

  // Stacked mode keeps a vertical resize handle so the user can trade library
  // vs kit height. Side mode uses fixed widths — the draggable range was too
  // small to be useful, and fixing removes a whole class of layout bugs.
  const stackedResize = useResizeHandle('vertical', 50)

  useEffect(() => { loadLibrary() }, [loadLibrary])

  if (isLoading) return <div className="kit-manager-wrapper"><div className="kit-loading">Loading...</div></div>

  return (
    <div className="kit-manager-wrapper">
      {!workDirSupported && (
        <div className="browser-warning">
          Your browser does not support local folder access. Use <strong>Chrome</strong> or <strong>Edge</strong>.
        </div>
      )}
      <WorkDirBar />
      {viewMode === 'stacked' ? (
        <div className="kit-manager kit-manager-stacked" ref={stackedResize.containerRef}>
          <div className="kit-manager-top" style={{ height: `${stackedResize.pct}%` }}><ClipsPanel /></div>
          <div className="resize-handle v" onMouseDown={stackedResize.onMouseDown} />
          <div className="kit-manager-bottom" style={{ flex: 1 }}><KitEditor /></div>
        </div>
      ) : (
        <div className="kit-manager">
          <div className="kit-manager-left"><ClipsPanel /></div>
          <div className="kit-manager-right"><KitEditor /></div>
        </div>
      )}
    </div>
  )
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
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const setShowClipDetails = useLibraryStore((s) => s.setShowClipDetails)
  const { devices } = useManagerConnection()
  const volumeWiper = devices[0]?.volumeWiper ?? null
  const { toast } = useToast()

  const views: { value: LibraryViewMode; label: string; title: string }[] = [
    { value: 'side', label: '\u2503', title: 'Clips left, kit editor right' },
    { value: 'stacked', label: '\u2501', title: 'Clips top, kit editor full width bottom' },
  ]

  return (
    <div className="workdir-bar">
      <div className="view-mode-group">
        {views.map((m) => (
          <button key={m.value} className={`view-mode-btn ${viewMode === m.value ? 'active' : ''}`}
            onClick={() => setViewMode(m.value)} title={m.title}>{m.label}</button>
        ))}
      </div>
      <button
        className={`view-mode-btn info-toggle ${showClipDetails ? 'active' : ''}`}
        onClick={() => setShowClipDetails(!showClipDetails)}
        title={showClipDetails ? 'Hide clip details (duration, sample rate, tags…)' : 'Show clip details'}
      >i</button>
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
              {volumeWiper !== null && (
                <>
                  <span className="workdir-divider" />
                  <span className="workdir-vol" title="Connected Hapbeat device volume (MCP4018 wiper 0–127)">Vol {volumeWiper}</span>
                </>
              )}
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
// Tree grouping — builds a nested folder tree from clip.sourceFilename
// ("template/booster.wav" → template / booster.wav). Clips with no
// path prefix land in the root bucket.
// ============================================================

interface ClipTreeNode {
  name: string
  path: string
  children: Map<string, ClipTreeNode>
  clips: LibraryClip[]
}

function buildClipTree(clips: LibraryClip[]): ClipTreeNode {
  const root: ClipTreeNode = { name: '', path: '', children: new Map(), clips: [] }
  for (const clip of clips) {
    const src = clip.sourceFilename || ''
    const parts = src.split('/').filter(Boolean)
    if (parts.length <= 1) {
      root.clips.push(clip)
      continue
    }
    // All but the last segment are folder names.
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      let child = node.children.get(name)
      if (!child) {
        child = { name, path: node.path ? `${node.path}/${name}` : name, children: new Map(), clips: [] }
        node.children.set(name, child)
      }
      node = child
    }
    node.clips.push(clip)
  }
  return root
}

/** Stable hue palette — high-contrast, easily distinguishable colours.
 *  Order: red, green, blue, orange, cyan, pink, yellow, teal, magenta, lime */
const TREE_HUES = [0, 130, 220, 30, 185, 330, 50, 165, 290, 90]

function TreeFolder({ node, defaultOpen, index, children }: { node: ClipTreeNode; defaultOpen: boolean; index: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const clipCount = countClipsInTree(node)
  const hue = TREE_HUES[index % TREE_HUES.length]
  return (
    <div className={`tree-group ${open ? 'is-open' : ''}`} style={{ '--tree-hue': hue } as React.CSSProperties}>
      <button className="tree-group-header" onClick={() => setOpen(!open)}>
        <span className="tree-arrow">{open ? '\u25BE' : '\u25B8'}</span>
        <span className="tree-label">{node.name}</span>
        <span className="tree-count">{clipCount}</span>
      </button>
      {open && <div className="tree-group-children">{children}</div>}
    </div>
  )
}

function countClipsInTree(node: ClipTreeNode): number {
  let n = node.clips.length
  for (const c of node.children.values()) n += countClipsInTree(c)
  return n
}

// ============================================================
// Clips Panel — unified list (built-ins are auto-imported into the
// user's work folder so there is no separate built-in/user split)
// ============================================================

type ClipListMode = 'flat' | 'tree'

function ClipsPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const clips = useLibraryStore((s) => s.clips)
  const filteredClips = useLibraryStore((s) => s.filteredClips)
  const filter = useLibraryStore((s) => s.filter)
  const setFilter = useLibraryStore((s) => s.setFilter)
  const addClipFromFile = useLibraryStore((s) => s.addClipFromFile)
  const archiveClip = useLibraryStore((s) => s.archiveClip)
  const updateClip = useLibraryStore((s) => s.updateClip)
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const refreshClipsFromDir = useLibraryStore((s) => s.refreshClipsFromDir)
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const addEventToKit = useLibraryStore((s) => s.addEventToKit)
  const activeKitId = useLibraryStore((s) => s.activeKitId)
  const editingClipId = useLibraryStore((s) => s.editingClipId)
  const setEditingClipId = useLibraryStore((s) => s.setEditingClipId)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const { toast } = useToast()
  const [dragOver, setDragOver] = useState(false)
  const [listMode, setListMode] = useState<ClipListMode>('tree')
  const { playingId, toggle } = useAudioPreview()
  const displayed = filteredClips()
  const editingClip = editingClipId ? clips.find((c) => c.id === editingClipId) ?? null : null

  useEffect(() => {
    if (!workDirHandle) return
    const onFocus = () => refreshClipsFromDir()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [workDirHandle, refreshClipsFromDir])

  const handleImport = useCallback(async (files: FileList) => {
    for (const f of Array.from(files)) { try { await addClipFromFile(f) } catch (e) { console.error(e) } }
  }, [addClipFromFile])

  const addClipToActiveKit = useCallback(async (clip: LibraryClip) => {
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }
    if (!clip.eventId) { toast('Set Event ID first', 'error'); return }
    const newId = await addEventToKit(activeKitId, {
      eventId: clip.eventId, clipId: clip.id, loop: false, intensity: 0.5, deviceWiper: null,
    })
    if (newId) toast(`Added "${clip.name}" to kit`, 'success')
    else toast('Kit not found', 'error')
  }, [activeKitId, addEventToKit, toast])

  const renderClipRow = (c: LibraryClip) => (
    <ClipRow
      key={c.id}
      clip={c}
      onStartEdit={() => setEditingClipId(c.id)}
      playingId={playingId}
      onToggle={(id, intensity) => toggle(id, () => getClipAudio(id), intensity)}
      onAddToKit={() => addClipToActiveKit(c)}
      kitAvailable={!!activeKitId}
      showDetails={showClipDetails}
    />
  )

  const renderTreeNode = (node: ClipTreeNode, isRoot: boolean): React.ReactNode => {
    const childFolders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    const sortedClips = [...node.clips].sort((a, b) => a.name.localeCompare(b.name))
    const body = (
      <>
        {childFolders.map((child, i) => (
          <TreeFolder key={child.path} node={child} defaultOpen={true} index={i}>
            {renderTreeNode(child, false)}
          </TreeFolder>
        ))}
        {sortedClips.map((c) => renderClipRow(c))}
      </>
    )
    return isRoot ? body : body
  }

  if (!workDirHandle) {
    return (
      <div className="clip-panel">
        <div className="panel-header"><h3>Clips</h3></div>
        <div className="library-list">
          <div className="library-empty workdir-prompt">
            <div className="workdir-prompt-content">
              <div className="workdir-prompt-icon">&#x1F4C2;</div>
              <div className="workdir-prompt-text">
                {workDirSupported
                  ? 'Pick a work folder to start. We\'ll copy the built-in clips into it so you can edit anything freely.'
                  : 'Use Chrome or Edge.'}
              </div>
              {workDirSupported && <button className="library-btn primary" onClick={pickWorkDir}>Choose Folder</button>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`clip-panel ${dragOver ? 'drag-over' : ''}`}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length > 0) handleImport(e.dataTransfer.files) }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}>
      <div className="panel-header">
        <h3>Clips</h3>
        <span className="library-count">{clips.length}</span>
        <div className="panel-header-actions">
          <button
            className={`panel-mode-btn ${listMode === 'flat' ? 'active' : ''}`}
            onClick={() => setListMode('flat')}
            title="Flat list (all clips, no folders)"
          >=</button>
          <button
            className={`panel-mode-btn ${listMode === 'tree' ? 'active' : ''}`}
            onClick={() => setListMode('tree')}
            title="Tree view (grouped by folder)"
          >&#x25B8;</button>
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
      <div className="library-list">
        {displayed.length === 0
          ? <div className="library-empty">{clips.length === 0 ? 'Drop files or + Import.' : 'No match.'}</div>
          : listMode === 'flat'
            ? displayed.map((c) => renderClipRow(c))
            : renderTreeNode(buildClipTree(displayed), true)
        }
      </div>

      {editingClip && (
        <ClipEditModal
          clip={editingClip}
          onClose={() => setEditingClipId(null)}
          onUpdate={updateClip}
          onArchive={async (id) => { await archiveClip(id) }}
        />
      )}
    </div>
  )
}

// ============================================================
// Clip Row — uses unified ClipCard primitive
// ============================================================

interface ClipRowProps {
  clip: LibraryClip
  onStartEdit: () => void
  playingId: string | null
  onToggle: (id: string, intensity: number) => void
  onAddToKit: () => void
  kitAvailable: boolean
  showDetails: boolean
}

function ClipRow({
  clip,
  onStartEdit,
  playingId,
  onToggle,
  onAddToKit,
  kitAvailable,
  showDetails,
}: ClipRowProps) {
  const [intensity, setIntensity] = useState(0.5)

  const metaSummary = `${Math.round(clip.duration * 1000)}ms | ${clip.channels === 1 ? 'Mono' : 'Stereo'} | ${clip.sampleRate / 1000}kHz | ${formatFileSize(clip.fileSize)}`
  return (
    <ClipCard
      name={clip.name}
      eventId={clip.eventId}
      eventIdEmpty={!clip.eventId}
      details={metaSummary}
      tags={clip.tags}
      showDetails={showDetails}
      intensity={intensity}
      onIntensityChange={setIntensity}
      playing={playingId === clip.id}
      onTogglePlay={() => onToggle(clip.id, intensity)}
      onNameClick={onStartEdit}
      wiper={null}
      title={`${metaSummary}${clip.tags.length > 0 ? ` | tags: ${clip.tags.join(', ')}` : ''}`}
      drag={{ type: DND_TYPE_CLIP, payload: clip.id, dragTitle: 'ドラッグして Kit に追加' }}
      actions={[
        { label: '+ Kit', variant: 'primary', onClick: onAddToKit, disabled: !kitAvailable || !clip.eventId,
          title: kitAvailable ? 'Add to active kit' : 'Select a kit first' },
        { label: 'Edit', onClick: onStartEdit, title: 'Edit name, event ID, tags…' },
      ]}
    />
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
  const setEditingClipId = useLibraryStore((s) => s.setEditingClipId)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
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

  const handleKitDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDropActive(false); setDragOverIdx(null)
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }

    const cid = e.dataTransfer.getData(DND_TYPE_CLIP)
    if (cid) {
      const c = clips.find((x) => x.id === cid); if (!c) return
      if (!c.eventId) { toast('Set Event ID first', 'error'); return }
      const newId = await addEventToKit(activeKitId, { eventId: c.eventId, clipId: c.id, loop: false, intensity: 0.5, deviceWiper: null })
      if (newId) toast(`Added "${c.name}"`, 'success')
      else toast('Kit not found', 'error')
      return
    }
    const evd = e.dataTransfer.getData(DND_TYPE_KIT_EVENT)
    if (evd && activeKit && dragOverIdx !== null) {
      try {
        const { kitEventId } = JSON.parse(evd)
        const evts = [...activeKit.events]
        const from = evts.findIndex((e) => e.id === kitEventId)
        if (from < 0) return
        const [moved] = evts.splice(from, 1)
        evts.splice(dragOverIdx > from ? dragOverIdx - 1 : dragOverIdx, 0, moved)
        await updateKit(activeKitId, { events: evts })
      } catch { /* */ }
    }
  }, [activeKitId, activeKit, clips, dragOverIdx, addEventToKit, updateKit, toast])

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
                        <KitEventRow
                          key={ev.id}
                          event={ev}
                          clip={clips.find((c) => c.id === ev.clipId) ?? null}
                          playing={playingId === ev.id}
                          showDetails={showClipDetails}
                          onTogglePlay={() => {
                            togglePreview(ev.id, () => getClipAudio(ev.clipId), ev.intensity)
                            const w = getDeviceWiper()
                            if (w !== null && w !== ev.deviceWiper) updateKitEvent(activeKit.id, ev.id, { deviceWiper: w })
                          }}
                          onIntensityChange={(v) => updateKitEvent(activeKit.id, ev.id, { intensity: v })}
                          onLoopChange={(loop) => updateKitEvent(activeKit.id, ev.id, { loop })}
                          onEditClip={() => setEditingClipId(ev.clipId)}
                          onDelete={() => removeEventFromKit(activeKit.id, ev.id)}
                          onDragOverRow={() => setDragOverIdx(i)}
                          dragOverIndicator={dragOverIdx === i}
                        />
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
