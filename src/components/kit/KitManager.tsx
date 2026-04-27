import { useEffect, useCallback, useMemo, useState, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useLibraryStore, validateKitName } from '@/stores/libraryStore'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useToast } from '@/components/common/Toast'
import { formatFileSize } from '@/utils/wavIO'
import { exportKitAsPack, validateEventIds } from '@/utils/kitExporter'
import type { LibraryClip, LibraryViewMode, KitDefinition } from '@/types/library'
import type { DeviceInfo } from '@/types/manager'
import { CapacityGauge } from './CapacityGauge'
import { KitEventRow } from './editor/KitEventRow'
import { ClipModeInfoModal } from './editor/ClipModeInfoModal'
import { ClipCard } from './shared/ClipCard'
import { ClipEditModal } from './shared/ClipEditModal'
import './KitManager.css'

const DND_TYPE_CLIP = 'application/x-hapbeat-clip'
const DND_TYPE_KIT_EVENT = 'application/x-hapbeat-kit-event'

function randomKitName(): string {
  // Lowercase + hyphen-only by default so the suggestion already obeys
  // the contracts regex (`^[a-z0-9_-]+$`).
  const adj = ['alpha', 'beta', 'gamma', 'delta', 'echo', 'zeta', 'nova', 'pulse', 'volt', 'rush']
  const noun = ['kit', 'pack', 'set', 'mix', 'drop', 'vibe', 'hit', 'boom', 'wave', 'beat']
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

  // キーボード操作中はマウスカーソル / hover 状態を抑制する。
  // キーボードでカードを選択移動している最中に、別のカードの hover が
  // 効いていると「どちらが選択中か」が視覚的にわかりにくくなるため。
  // keydown を検知した時点で body に .using-keyboard を付け、
  // 次の mousemove で外す。CSS 側で hover と cursor を殺している。
  useEffect(() => {
    const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar', 'Enter', 'Delete', 'Backspace', 'Tab'])
    const onKey = (e: KeyboardEvent) => {
      if (!NAV_KEYS.has(e.key)) return
      document.body.classList.add('using-keyboard')
    }
    const onMouse = () => { document.body.classList.remove('using-keyboard') }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousemove', onMouse)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousemove', onMouse)
      document.body.classList.remove('using-keyboard')
    }
  }, [])

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
// Amp Preset Bar — Library の amp 一括セーブ/適用
// ============================================================

const NEW_PRESET_VALUE = '__new__'

/** Save as のデフォルト名: `amp-YYYYMMDD` */
function defaultPresetName(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `amp-${y}${m}${day}`
}

function AmpPresetBar() {
  const clips = useLibraryStore((s) => s.clips)
  const presets = useLibraryStore((s) => s.ampPresets)
  const savePreset = useLibraryStore((s) => s.saveAmpPreset)
  const applyPreset = useLibraryStore((s) => s.applyAmpPreset)
  const deletePreset = useLibraryStore((s) => s.deleteAmpPreset)
  const setLibraryIntensity = useLibraryStore((s) => s.setLibraryIntensity)
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)
  const { toast } = useToast()
  const [selected, setSelected] = useState<string>(NEW_PRESET_VALUE)
  const [dialog, setDialog] = useState<null | 'save' | 'confirm-delete' | 'confirm-overwrite'>(null)
  const [nameInput, setNameInput] = useState('')

  if (!workDirHandle) return null

  const close = () => { setDialog(null); setNameInput('') }

  const onSelectChange = async (value: string) => {
    setSelected(value)
    if (value === NEW_PRESET_VALUE) {
      // (new) = 全クリップ amp を 0.5 にリセット
      for (const c of clips) {
        if ((c.libraryIntensity ?? 0.5) !== 0.5) await setLibraryIntensity(c.id, 0.5)
      }
      toast('Reset amps to 0.5', 'success')
    } else {
      await applyPreset(value)
      toast(`Applied "${value}"`, 'success')
    }
  }

  const onSaveClick = () => { setNameInput(defaultPresetName()); setDialog('save') }
  const onSubmitSave = async () => {
    const name = nameInput.trim()
    if (!name) return
    if (presets.some((p) => p.name === name)) { setDialog('confirm-overwrite'); return }
    await savePreset(name)
    setSelected(name)
    close()
    toast(`Saved "${name}"`, 'success')
  }
  const onConfirmOverwrite = async () => {
    const name = nameInput.trim()
    await savePreset(name)
    setSelected(name)
    close()
    toast(`Overwrote "${name}"`, 'success')
  }

  const hasRealSelection = selected && selected !== NEW_PRESET_VALUE
  const onDeleteClick = () => { if (hasRealSelection) setDialog('confirm-delete') }
  const onConfirmDelete = async () => {
    await deletePreset(selected)
    toast(`Deleted "${selected}"`, 'success')
    setSelected(NEW_PRESET_VALUE)
    close()
  }

  return (
    <div className="amp-preset-bar">
      <span className="amp-preset-label" title="Library 側の amp プリセット。選択すると即適用。">Amp Preset:</span>
      <select
        className="amp-preset-select"
        value={selected}
        onChange={(e) => void onSelectChange(e.target.value)}
        title="(new) = 全クリップ amp を 0.5 に戻す。保存済みプリセットを選ぶと即適用。"
      >
        <option value={NEW_PRESET_VALUE}>(new)</option>
        {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>
      <button className="library-btn" onClick={onSaveClick} title="現在の amp 設定を新しいプリセットとして保存">Save as…</button>
      <button className="library-btn danger" onClick={onDeleteClick} disabled={!hasRealSelection}
        title={hasRealSelection ? `プリセット "${selected}" を削除` : '削除するプリセットを選択'}>Delete</button>

      {dialog && (
        <div className="amp-preset-dialog-backdrop" onClick={close}>
          <div className="amp-preset-dialog" onClick={(e) => e.stopPropagation()}>
            {dialog === 'save' && (
              <>
                <div className="amp-preset-dialog-title">新規プリセット名</div>
                <input
                  type="text" autoFocus
                  value={nameInput}
                  placeholder={defaultPresetName()}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); onSubmitSave() }
                    if (e.key === 'Escape') close()
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="amp-preset-dialog-actions">
                  <button className="library-btn" onClick={close}>Cancel</button>
                  <button className="library-btn primary" onClick={onSubmitSave} disabled={!nameInput.trim()}>Save</button>
                </div>
              </>
            )}
            {dialog === 'confirm-overwrite' && (
              <>
                <div className="amp-preset-dialog-title">"{nameInput.trim()}" を上書きしますか？</div>
                <div className="amp-preset-dialog-actions">
                  <button className="library-btn" onClick={close}>Cancel</button>
                  <button className="library-btn primary" onClick={onConfirmOverwrite}>Overwrite</button>
                </div>
              </>
            )}
            {dialog === 'confirm-delete' && (
              <>
                <div className="amp-preset-dialog-title">プリセット "{selected}" を削除しますか？</div>
                <div className="amp-preset-dialog-actions">
                  <button className="library-btn" onClick={close}>Cancel</button>
                  <button className="library-btn danger" onClick={onConfirmDelete}>Delete</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Shortcut Help — ヘルプボタン + ポップオーバー
// ============================================================

/**
 * 操作説明 — マウス/キーボードの全操作を 1 つのポップオーバーにまとめた
 * トップバー配置用ヘルプ。Library と Kit の両方のパネルの操作を同時に示す。
 */
function ShortcutHelp() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <span className="shortcut-help-wrap" ref={wrapRef}>
      <button
        className="shortcut-help-btn labeled"
        onClick={() => setOpen((o) => !o)}
        title="マウス/キーボード操作の一覧を開く"
        aria-label="操作説明"
      ><span className="shortcut-help-btn-icon">?</span>操作説明</button>
      {open && (
        <div className="shortcut-help-panel" role="dialog">
          <div className="shortcut-help-title">マウス操作 (Library)</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">クリック</span>カードを選択</li>
            <li><span className="shortcut-help-key">▶</span>再生 / 停止</li>
            <li><span className="shortcut-help-key">☰ ドラッグ</span>Kit にドロップして追加</li>
            <li><span className="shortcut-help-key">Amp スライダー</span>強度 (0–100%)</li>
            <li><span className="shortcut-help-key">Edit ボタン</span>名前 / Event ID / タグ編集</li>
            <li><span className="shortcut-help-key">+ Kit ボタン</span>選択中の Kit に追加</li>
          </ul>

          <div className="shortcut-help-title">マウス操作 (Kit)</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">☰ ドラッグ</span>Kit 内で並び替え</li>
            <li><span className="shortcut-help-key">FIRE / CLIP / LIVE</span>再生モード切替 (ヘッダーの「モード説明」参照)</li>
            <li><span className="shortcut-help-key">×</span>Kit から削除</li>
          </ul>

          <div className="shortcut-help-title">キーボード（選択中）</div>
          <ul className="shortcut-help-list">
            <li><span className="shortcut-help-key">↑ / ↓</span>選択を上下に移動</li>
            <li><span className="shortcut-help-key">← / →</span>Amp を ±5%</li>
            <li><span className="shortcut-help-key">Space</span>再生 / 停止</li>
            <li><span className="shortcut-help-key">Enter</span>アクティブ Kit に追加 (Library 側)</li>
            <li><span className="shortcut-help-key">Delete / Backspace</span>Kit から削除 (Kit 側)</li>
          </ul>

          <div className="shortcut-help-note">
            パネル内にカーソルがある / フォーカスしているときだけ反応します。
            テキスト入力中は無効。Amp スライダーの矢印キーはスライダー自身の微調整が優先されます。
          </div>
        </div>
      )}
    </span>
  )
}

// ============================================================
// Work Dir Bar
// ============================================================

/**
 * Reusable folder chip — icon + path + action buttons in one compact pill.
 * Used in both the Clips panel header (library folder) and the Kit panel
 * header (kit-out folder). Keeps each folder UI next to the panel it scopes.
 */
interface FolderChipProps {
  icon: string
  name: string | null
  onPick: () => Promise<boolean>
  onClear: () => Promise<void>
  label: string          // e.g. "Library" / "Kit"
  setTitle?: string
  emptyTitle?: string
  setLabel?: string      // "+ Library" / "+ Kit"
  changeTitle?: string
  clearTitle?: string
  clearLabel?: string    // "×" or custom
}
function FolderChip({
  icon, name, onPick, onClear, label,
  setTitle, emptyTitle,
  setLabel, changeTitle, clearTitle, clearLabel = '×',
}: FolderChipProps) {
  const { toast } = useToast()
  return (
    <span className="workdir-chip" title={name ? (setTitle ?? `${label}: ${name}`) : (emptyTitle ?? `Choose ${label} folder`)}>
      <span className="workdir-icon">{icon}</span>
      {name ? (
        <>
          <span className="workdir-path" title={name}>{name}</span>
          <button className="workdir-icon-btn" onClick={async () => { if (await onPick()) toast(`${label} folder changed`, 'success') }}
            title={changeTitle ?? `Change ${label} folder`}>⇄</button>
          <button className="workdir-icon-btn danger" onClick={async () => { await onClear(); toast(`${label} folder cleared`, 'success') }}
            title={clearTitle ?? `Clear ${label} folder`}>{clearLabel}</button>
        </>
      ) : (
        <button className="workdir-icon-btn primary" onClick={async () => { if (await onPick()) toast(`${label} folder set`, 'success') }}
          title={emptyTitle ?? `Choose ${label} folder`}>{setLabel ?? `+ ${label}`}</button>
      )}
    </span>
  )
}

function WorkDirBar() {
  const viewMode = useLibraryStore((s) => s.viewMode)
  const setViewMode = useLibraryStore((s) => s.setViewMode)
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const setShowClipDetails = useLibraryStore((s) => s.setShowClipDetails)
  const { isConnected: helperConnected, devices } = useHelperConnection()
  const dev0 = devices[0]
  const volumeWiper = dev0?.volumeWiper ?? null
  // First-online-or-first-known device, displayed in the kit-page
  // header so kit authors don't have to flip to Devices tab to see
  // which Hapbeat is currently active.
  const headerDevice = devices.find((d) => d.online) ?? dev0 ?? null
  const otherCount = headerDevice
    ? Math.max(0, devices.length - 1)
    : 0

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
      <ShortcutHelp />
      {/* Connected Hapbeat indicator. Tap-target for now; future
          revisions will open a device picker modal here. */}
      {headerDevice && (
        <>
          <span className="workdir-divider" />
          <span
            className="workdir-device"
            title={
              `${headerDevice.name || '(unnamed)'}\n` +
              `IP: ${headerDevice.ipAddress || '-'}\n` +
              `${headerDevice.online ? 'online' : 'offline'}` +
              (otherCount > 0 ? `\n他 ${otherCount} 台が接続されています` : '')
            }
          >
            <span
              className={`workdir-device-dot ${headerDevice.online ? 'online' : 'offline'}`}
              aria-hidden="true"
            />
            <span className="workdir-device-name">
              {headerDevice.name || '(unnamed)'}
            </span>
            {otherCount > 0 && (
              <span className="workdir-device-more">+{otherCount}</span>
            )}
          </span>
        </>
      )}
      {!headerDevice && helperConnected && (
        <>
          <span className="workdir-divider" />
          <span className="workdir-device muted" title="No Hapbeat discovered yet">
            <span className="workdir-device-dot offline" aria-hidden="true" />
            no device
          </span>
        </>
      )}
      {volumeWiper !== null && (
        <>
          <span className="workdir-divider" />
          <span className="workdir-vol" title="Connected Hapbeat device volume (MCP4018 wiper 0–127, 128段階)">Vol {volumeWiper}/128 ({Math.round((volumeWiper / 127) * 100)}%)</span>
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
  const { isConnected, devices, send } = useHelperConnection()

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
      // Query volume (wiper) — Manager resolves which device(s) based on its own selection
      send({ type: 'query_volume', payload: {} })

      const { streamClip } = await import('@/utils/audioStreamer')
      const controller = new AbortController()
      abortRef.current = controller
      try {
        await streamClip(blob, send, { signal: controller.signal, intensity })
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

  return { playingId, toggle, stop, hasDevice, getDeviceWiper }
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
 *  Order: red, blue, orange, cyan, pink, yellow, teal, magenta, lime, purple
 *  （green=130 は template 専用に予約して除外） */
const TREE_HUES = [0, 220, 30, 185, 330, 50, 165, 290, 90, 260]
const TEMPLATE_HUE = 130

/** path からハッシュで hue を決定。同名の兄弟でも path 全体で分散する。
 *  ただし "template" だけは常に緑に固定。 */
function hueForPath(path: string): number {
  if (path === 'template' || path.startsWith('template/')) return TEMPLATE_HUE
  let h = 0
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0
  return TREE_HUES[Math.abs(h) % TREE_HUES.length]
}

interface TreeFolderProps {
  node: ClipTreeNode
  /** 親から受け取る open 判定。キーボード選択時に親が強制的に開くため、
   *  ローカル state ではなく parent 管理の Set<string> を参照する。 */
  isOpen: (path: string) => boolean
  toggle: (path: string) => void
  children: React.ReactNode
}
function TreeFolder({ node, isOpen, toggle, children }: TreeFolderProps) {
  const open = isOpen(node.path)
  const clipCount = countClipsInTree(node)
  const hue = hueForPath(node.path)
  return (
    <div className={`tree-group ${open ? 'is-open' : ''}`} style={{ '--tree-hue': hue } as React.CSSProperties}>
      <button className="tree-group-header" onClick={() => toggle(node.path)}>
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

/** Tree の表示順（renderTreeNode の順）で flat 化した clip リスト。
 *  フォルダを先に再帰処理し、各レベルで clip を後に足す。
 *
 *  buildClipTree が clips を入力順 (= filteredClips の sort 順) で
 *  push するので、ここでは並び替えしない — フォルダだけ名前順で
 *  畳む。これによりユーザーがソート select を切り替えると tree
 *  内のクリップ並びも追従する。 */
function flattenTreeInRenderOrder(node: ClipTreeNode): LibraryClip[] {
  const result: LibraryClip[] = []
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const f of folders) result.push(...flattenTreeInRenderOrder(f))
  result.push(...node.clips)
  return result
}

// ============================================================
// Clips Panel — unified list (built-ins are auto-imported into the
// user's work folder so there is no separate built-in/user split)
// ============================================================

type ClipListMode = 'flat' | 'tree'

function ClipsPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const clips = useLibraryStore((s) => s.clips)
  const filteredClips = useLibraryStore((s) => s.filteredClips)
  const filter = useLibraryStore((s) => s.filter)
  const setFilter = useLibraryStore((s) => s.setFilter)
  const addClipFromFile = useLibraryStore((s) => s.addClipFromFile)
  const archiveClip = useLibraryStore((s) => s.archiveClip)
  const updateClip = useLibraryStore((s) => s.updateClip)
  const commitClipRename = useLibraryStore((s) => s.commitClipRename)
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)
  const workDirName = useLibraryStore((s) => s.workDirName)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const pickWorkDir = useLibraryStore((s) => s.pickWorkDir)
  const disconnectWorkDir = useLibraryStore((s) => s.disconnectWorkDir)
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Tree view で開いているフォルダ集合 (path で管理)。キーボード選択が
  // 別フォルダに移ったときに自動で祖先フォルダを開いて、選択カードが
  // 画面からも見えるようにするため、parent 管理にする。
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const { playingId, toggle, stop: stopPreview } = useAudioPreview()
  const displayed = filteredClips()
  const editingClip = editingClipId ? clips.find((c) => c.id === editingClipId) ?? null : null
  const setLibraryIntensity = useLibraryStore((s) => s.setLibraryIntensity)

  const getIntensity = useCallback((id: string) => {
    const c = clips.find((x) => x.id === id)
    return c?.libraryIntensity ?? 0.5
  }, [clips])
  const setIntensity = useCallback((id: string, v: number) => {
    void setLibraryIntensity(id, v)
  }, [setLibraryIntensity])

  useEffect(() => {
    if (!workDirHandle) return
    const onFocus = () => refreshClipsFromDir()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [workDirHandle, refreshClipsFromDir])

  // 選択が変わったら: 祖先フォルダを全部開く → 画面内にスクロール。
  // 閉じたフォルダに選択が移ると DOM に要素が無く、選択のハイライトが
  // 画面から消えてしまうため、キーボード移動に追従して自動展開する。
  useEffect(() => {
    if (!selectedId) return
    const clip = clips.find((c) => c.id === selectedId)
    if (clip) {
      const src = clip.sourceFilename || ''
      const parts = src.split('/').filter(Boolean)
      if (parts.length > 1) {
        // 末尾はファイル名なので除き、すべての祖先 path を open 集合に追加
        const ancestors: string[] = []
        let cur = ''
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur ? `${cur}/${parts[i]}` : parts[i]
          ancestors.push(cur)
        }
        setOpenFolders((prev) => {
          const missing = ancestors.filter((p) => !prev.has(p))
          if (missing.length === 0) return prev
          const next = new Set(prev)
          for (const p of missing) next.add(p)
          return next
        })
      }
    }
    // open 反映を待つため次フレームでスクロール
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const el = panel.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [selectedId, clips])

  // 表示順と一致するナビゲーション順。
  // - flat mode: displayed をそのまま (filteredClips の sort 順)
  // - tree mode: renderTreeNode 順で flat 化 (フォルダ名順 + 中の clip は filter 順)
  const orderedClips = useMemo(() => {
    if (listMode === 'flat') return [...displayed]
    return flattenTreeInRenderOrder(buildClipTree(displayed))
  }, [displayed, listMode])

  const addClipToActiveKit = useCallback(async (clip: LibraryClip) => {
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }
    // eventId is auto-derived inside the store (kit name × clip name).
    const newId = await addEventToKit(activeKitId, {
      eventId: '', clipId: clip.id, loop: false, intensity: getIntensity(clip.id), deviceWiper: null,
    })
    if (newId) toast(`Added "${clip.name}" to kit`, 'success')
    else toast('Kit not found', 'error')
  }, [activeKitId, addEventToKit, toast, getIntensity])

  // キーボードショートカット: Space=再生、↑↓=選択移動、←→=Amp 増減
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current
      if (!panel) return
      // テキスト入力中はスキップ。range スライダー上では Space は通すが矢印はネイティブに任せる
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range'
      const isTextField = tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)
      if (isTextField) return
      if (isRange && e.key.startsWith('Arrow')) return
      if (editingClipId) return
      if (!panel.contains(active) && !panel.matches(':hover')) return
      if (orderedClips.length === 0) return

      const curIdx = selectedId ? orderedClips.findIndex((c) => c.id === selectedId) : -1
      const moveTo = (idx: number) => {
        const clamped = Math.max(0, Math.min(orderedClips.length - 1, idx))
        const next = orderedClips[clamped]
        if (!next || next.id === selectedId) return
        // 選択を動かすときは再生中のプレビューを停止 (= 停止ボタンと同じ挙動)
        stopPreview()
        setSelectedId(next.id)
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx + 1)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx - 1)
          break
        case 'ArrowRight':
          if (selectedId) { e.preventDefault(); setIntensity(selectedId, getIntensity(selectedId) + 0.05) }
          break
        case 'ArrowLeft':
          if (selectedId) { e.preventDefault(); setIntensity(selectedId, getIntensity(selectedId) - 0.05) }
          break
        case ' ':
        case 'Spacebar':
          if (selectedId) {
            e.preventDefault()
            toggle(selectedId, () => getClipAudio(selectedId), getIntensity(selectedId))
          }
          break
        case 'Enter': {
          if (!selectedId) break
          const clip = clips.find((c) => c.id === selectedId)
          if (!clip) break
          e.preventDefault()
          addClipToActiveKit(clip)
          break
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [orderedClips, selectedId, editingClipId, toggle, stopPreview, getClipAudio, getIntensity, setIntensity, clips, addClipToActiveKit])

  const handleImport = useCallback(async (files: FileList) => {
    for (const f of Array.from(files)) { try { await addClipFromFile(f) } catch (e) { console.error(e) } }
  }, [addClipFromFile])

  const renderClipRow = (c: LibraryClip) => (
    <ClipRow
      key={c.id}
      clip={c}
      onStartEdit={() => setEditingClipId(c.id)}
      onRenameCommit={async (next) => {
        await updateClip(c.id, { name: next })
        await commitClipRename(c.id)
      }}
      playingId={playingId}
      onToggle={(id, intensity) => toggle(id, () => getClipAudio(id), intensity)}
      onAddToKit={() => addClipToActiveKit(c)}
      kitAvailable={!!activeKitId}
      showDetails={showClipDetails}
      intensity={getIntensity(c.id)}
      onIntensityChange={(v) => setIntensity(c.id, v)}
      selected={selectedId === c.id}
      onSelect={() => setSelectedId(c.id)}
    />
  )

  const renderTreeNode = (node: ClipTreeNode, isRoot: boolean): React.ReactNode => {
    // Folders alphabetical (familiar from OS Explorer); clips inside
    // each folder honour the global sort because buildClipTree pushed
    // them in the order from `filteredClips()` (= filter.sortBy).
    const childFolders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    const body = (
      <>
        {childFolders.map((child) => (
          <TreeFolder key={child.path} node={child}
            isOpen={(p) => openFolders.has(p)}
            toggle={(p) => setOpenFolders((prev) => {
              const next = new Set(prev)
              if (next.has(p)) next.delete(p); else next.add(p)
              return next
            })}>
            {renderTreeNode(child, false)}
          </TreeFolder>
        ))}
        {node.clips.map((c) => renderClipRow(c))}
      </>
    )
    return isRoot ? body : body
  }

  if (!workDirHandle) {
    return (
      <div className="clip-panel">
        <div className="panel-header">
          <h3>Clips</h3>
          {workDirSupported && (
            <FolderChip
              icon="&#x1F4C2;"
              name={null}
              onPick={pickWorkDir}
              onClear={disconnectWorkDir}
              label="Library"
              emptyTitle="クリップ本体 (wav) を置くフォルダ。ここから Studio が clips / kits-meta を読み書きする。"
              setLabel="+ Library"
            />
          )}
        </div>
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
    <div ref={panelRef} className={`clip-panel ${dragOver ? 'drag-over' : ''}`}
      tabIndex={-1}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length > 0) handleImport(e.dataTransfer.files) }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}>
      <div className="panel-header">
        <h3>Clips</h3>
        <span className="library-count">{clips.length}</span>
        {workDirSupported && (
          <FolderChip
            icon="&#x1F4C2;"
            name={workDirName}
            onPick={pickWorkDir}
            onClear={disconnectWorkDir}
            label="Library"
            emptyTitle="クリップ本体 (wav) を置くフォルダ。ここから Studio が clips / kits-meta を読み書きする。"
            setLabel="+ Library"
          />
        )}
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
        <select
          className="library-sort"
          value={`${filter.sortBy}:${filter.sortOrder}`}
          onChange={(e) => {
            const [sortBy, sortOrder] = e.target.value.split(':') as ['name' | 'date' | 'duration', 'asc' | 'desc']
            setFilter({ sortBy, sortOrder })
          }}
          title="並び順"
        >
          <option value="name:asc">名前 ↑</option>
          <option value="name:desc">名前 ↓</option>
          <option value="date:desc">更新日時 (新しい順)</option>
          <option value="date:asc">更新日時 (古い順)</option>
          <option value="duration:asc">長さ (短い順)</option>
          <option value="duration:desc">長さ (長い順)</option>
        </select>
        <input ref={fileInputRef} type="file" accept=".wav,.mp3,.ogg,.flac,.aac,.m4a,audio/*" multiple
          onChange={(e) => e.target.files && handleImport(e.target.files)} style={{ display: 'none' }} />
        <button className="library-btn" onClick={() => fileInputRef.current?.click()}>+ Import</button>
        <button className="library-btn" onClick={refreshClipsFromDir}>Refresh</button>
      </div>
      <AmpPresetBar />
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
          onCommitRename={commitClipRename}
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
  onRenameCommit: (next: string) => void | Promise<void>
  playingId: string | null
  onToggle: (id: string, intensity: number) => void
  onAddToKit: () => void
  kitAvailable: boolean
  showDetails: boolean
  intensity: number
  onIntensityChange: (v: number) => void
  selected: boolean
  onSelect: () => void
}

function ClipRow({
  clip,
  onStartEdit,
  onRenameCommit,
  playingId,
  onToggle,
  onAddToKit,
  kitAvailable,
  showDetails,
  intensity,
  onIntensityChange,
  selected,
  onSelect,
}: ClipRowProps) {
  const metaSummary = `${Math.round(clip.duration * 1000)}ms | ${clip.channels === 1 ? 'Mono' : 'Stereo'} | ${clip.sampleRate / 1000}kHz | ${formatFileSize(clip.fileSize)}`
  return (
    <ClipCard
      name={clip.name}
      // Library no longer carries an eventId — kit composes it on add.
      eventId={null}
      eventIdEmpty={false}
      details={metaSummary}
      tags={clip.tags}
      showDetails={showDetails}
      intensity={intensity}
      onIntensityChange={onIntensityChange}
      playing={playingId === clip.id}
      onTogglePlay={() => onToggle(clip.id, intensity)}
      selected={selected}
      onSelect={onSelect}
      dataCardId={clip.id}
      wiper={null}
      title={
        clip.note
          ? `${clip.note}\n\n${metaSummary}${clip.tags.length > 0 ? ` | tags: ${clip.tags.join(', ')}` : ''}`
          : `${metaSummary}${clip.tags.length > 0 ? ` | tags: ${clip.tags.join(', ')}` : ''}`
      }
      drag={{ type: DND_TYPE_CLIP, payload: clip.id, dragTitle: 'ドラッグして Kit に追加' }}
      onRenameCommit={(next) => { void onRenameCommit(next) }}
      actions={[
        { label: '+ Kit', variant: 'primary', onClick: onAddToKit, disabled: !kitAvailable,
          title: kitAvailable ? 'Add to active kit' : 'Select a kit first' },
        { label: 'Edit', onClick: onStartEdit, title: 'Edit note, tags…' },
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
  const showClipDetails = useLibraryStore((s) => s.showClipDetails)
  const workDirSupported = useLibraryStore((s) => s.workDirSupported)
  const kitDirName = useLibraryStore((s) => s.kitDirName)
  const pickKitDir = useLibraryStore((s) => s.pickKitDir)
  const disconnectKitDir = useLibraryStore((s) => s.disconnectKitDir)
  const { isConnected: managerConnected, devices, send } = useHelperConnection()
  const { toast } = useToast()
  const getClipAudio = useLibraryStore((s) => s.getClipAudio)
  const { playingId, toggle: togglePreview, stop: stopPreview, getDeviceWiper } = useAudioPreview()

  const [isExporting, setIsExporting] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [modeInfoOpen, setModeInfoOpen] = useState(false)
  const placeholderName = useRef(randomKitName())
  const kitPanelRef = useRef<HTMLDivElement>(null)
  // Throttled "invalid character" toast — same shape as the one inside
  // ClipCard (1.2 s rearm). Used by the Kit Name rename input below.
  const kitNameWarnArmedRef = useRef(true)
  const flagKitNameInvalid = useCallback(() => {
    if (!kitNameWarnArmedRef.current) return
    kitNameWarnArmedRef.current = false
    toast('英小文字 / 数字 / -, _ のみ使用できます', 'warning')
    window.setTimeout(() => { kitNameWarnArmedRef.current = true }, 1200)
  }, [toast])

  const activeKit = kits.find((k) => k.id === activeKitId)

  // Auto-sync active kit's targetDevice with the first connected
  // device. Fires whenever the device's volume_* values change (incl.
  // the initial PONG after a fresh connection). Manual override is
  // still available via the "⟳ デバイスから取り込む" button — that
  // button is just a convenience now.
  //
  // We intentionally only mirror values that the device reports as
  // numbers; missing fields stay untouched so the user can hand-edit
  // them without us clobbering on the next push.
  const dev0 = devices[0]
  const dev0Wiper = dev0?.volumeWiper ?? null
  const dev0Level = dev0?.volumeLevel ?? null
  const dev0Steps = dev0?.volumeSteps ?? null
  useEffect(() => {
    if (!activeKit) return
    const cur = activeKit.targetDevice ?? {}
    const next: NonNullable<KitDefinition['targetDevice']> = { ...cur }
    let changed = false
    if (typeof dev0Wiper === 'number' && dev0Wiper !== cur.volume_wiper) {
      next.volume_wiper = dev0Wiper; changed = true
    }
    if (typeof dev0Level === 'number' && dev0Level !== cur.volume_level) {
      next.volume_level = dev0Level; changed = true
    }
    if (typeof dev0Steps === 'number' && dev0Steps !== cur.volume_steps) {
      next.volume_steps = dev0Steps; changed = true
    }
    if (changed) updateKit(activeKit.id, { targetDevice: next })
  // intentionally skip activeKit reference — drive only off device
  // numbers so editing the kit doesn't retrigger the sync
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev0Wiper, dev0Level, dev0Steps, activeKitId])

  // Sort UI for kit events. Persisted in localStorage so the user's
  // last choice carries between sessions (one global preference, not
  // per-kit — feels closer to OS file explorers).
  const KIT_SORT_KEY = 'hapbeat-studio-kit-sort'
  type KitSortBy = 'name' | 'date' | 'duration' | 'order'
  type KitSortOrder = 'asc' | 'desc'
  const [kitSort, setKitSort] = useState<{ by: KitSortBy; order: KitSortOrder }>(() => {
    try {
      const raw = localStorage.getItem(KIT_SORT_KEY)
      if (raw) {
        const v = JSON.parse(raw)
        if (v?.by && v?.order) return v
      }
    } catch { /* ignore */ }
    return { by: 'name', order: 'asc' }
  })
  useEffect(() => {
    try { localStorage.setItem(KIT_SORT_KEY, JSON.stringify(kitSort)) } catch { /* ignore */ }
  }, [kitSort])

  const sortedEvents = useMemo(() => {
    if (!activeKit) return []
    const arr = [...activeKit.events]
    if (kitSort.by === 'order') {
      // Insertion order — reflect the array as stored. `desc` reverses
      // it so newest-added shows up first.
      return kitSort.order === 'asc' ? arr : arr.reverse()
    }
    arr.sort((a, b) => {
      const ca = clips.find((c) => c.id === a.clipId)
      const cb = clips.find((c) => c.id === b.clipId)
      let cmp = 0
      if (kitSort.by === 'name') {
        cmp = (ca?.name ?? '').toLowerCase().localeCompare((cb?.name ?? '').toLowerCase())
      } else if (kitSort.by === 'date') {
        cmp = (ca?.updatedAt ?? '').localeCompare(cb?.updatedAt ?? '')
      } else if (kitSort.by === 'duration') {
        cmp = (ca?.duration ?? 0) - (cb?.duration ?? 0)
      }
      return kitSort.order === 'asc' ? cmp : -cmp
    })
    return arr
  }, [activeKit, clips, kitSort])

  // Kit を切り替えたら選択をクリアし、再生中のプレビューも止める。
  useEffect(() => {
    setSelectedEventId(null)
    stopPreview()
  }, [activeKitId, stopPreview])

  // 選択変更時に画面内にスクロール（Kit Editor 内で完結）
  useEffect(() => {
    if (!selectedEventId) return
    const panel = kitPanelRef.current
    if (!panel) return
    const el = panel.querySelector<HTMLElement>(`[data-card-id="${selectedEventId}"]`)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedEventId])

  // Kit 内のキーボード操作: Space=再生、↑↓=選択移動、←→=intensity ±0.05
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = kitPanelRef.current
      if (!panel || !activeKit) return
      // テキスト入力中はスキップ。range スライダー上では Space は通すが矢印はネイティブに任せる
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName
      const isRange = tag === 'INPUT' && (active as HTMLInputElement).type === 'range'
      const isTextField = tag === 'TEXTAREA' || (tag === 'INPUT' && !isRange)
      if (isTextField) return
      if (isRange && e.key.startsWith('Arrow')) return
      if (!panel.contains(active) && !panel.matches(':hover')) return
      // 視覚順 (name 昇順) に揃える。追加順で辿ると表示とバラバラに動く。
      const events = sortedEvents
      if (events.length === 0) return

      const curIdx = selectedEventId ? events.findIndex((ev) => ev.id === selectedEventId) : -1
      const moveTo = (idx: number) => {
        const clamped = Math.max(0, Math.min(events.length - 1, idx))
        const next = events[clamped]
        if (!next || next.id === selectedEventId) return
        // 選択を動かすときは再生中のプレビューを停止 (= 停止ボタンと同じ挙動)
        stopPreview()
        setSelectedEventId(next.id)
      }
      const currentEvent = selectedEventId ? events.find((ev) => ev.id === selectedEventId) : null

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx + 1)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveTo(curIdx < 0 ? 0 : curIdx - 1)
          break
        case 'ArrowRight':
          if (currentEvent) {
            e.preventDefault()
            const next = Math.max(0, Math.min(1, currentEvent.intensity + 0.05))
            updateKitEvent(activeKit.id, currentEvent.id, { intensity: next })
          }
          break
        case 'ArrowLeft':
          if (currentEvent) {
            e.preventDefault()
            const next = Math.max(0, Math.min(1, currentEvent.intensity - 0.05))
            updateKitEvent(activeKit.id, currentEvent.id, { intensity: next })
          }
          break
        case ' ':
        case 'Spacebar':
          if (currentEvent) {
            e.preventDefault()
            togglePreview(currentEvent.id, () => getClipAudio(currentEvent.clipId), currentEvent.intensity)
            const w = getDeviceWiper()
            if (w !== null && w !== currentEvent.deviceWiper) {
              updateKitEvent(activeKit.id, currentEvent.id, { deviceWiper: w })
            }
          }
          break
        case 'Delete':
        case 'Backspace':
          // Delete / Backspace — remove the selected event (= × button).
          // 削除後は同位置 (末尾ならその前) のイベントに選択を移す。
          if (currentEvent) {
            e.preventDefault()
            const removedIdx = curIdx
            removeEventFromKit(activeKit.id, currentEvent.id)
            const remaining = events.length - 1
            if (remaining <= 0) {
              setSelectedEventId(null)
            } else {
              const nextIdx = Math.min(removedIdx, remaining - 1)
              const nextEv = activeKit.events.filter((ev) => ev.id !== currentEvent.id)[nextIdx]
              setSelectedEventId(nextEv?.id ?? null)
            }
          }
          break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeKit, sortedEvents, selectedEventId, updateKitEvent, togglePreview, stopPreview, getClipAudio, getDeviceWiper, removeEventFromKit])

  const handleCreate = useCallback(async (name?: string) => {
    // Match the same constraint applied in the rename input — strip
    // disallowed characters silently before persisting.
    const raw = (name ?? placeholderName.current).trim()
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!cleaned) {
      toast('Kit 名は英小文字 / 数字 / -, _ のみ使用できます', 'error')
      return
    }
    await createKit(cleaned)
    placeholderName.current = randomKitName()
  }, [createKit, toast])

  const handleKitDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDropActive(false); setDragOverIdx(null)
    if (!activeKitId) { toast('Select or create a Kit first', 'error'); return }

    const cid = e.dataTransfer.getData(DND_TYPE_CLIP)
    if (cid) {
      const c = clips.find((x) => x.id === cid); if (!c) return
      const newId = await addEventToKit(activeKitId, { eventId: '', clipId: c.id, loop: false, intensity: 0.5, deviceWiper: null })
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

  // Kit のデバイス flash 使用量は FIRE (command) モードのイベントだけ数える。
  // CLIP / LIVE はデバイスに WAV を載せず SDK 側ストリームで送るため flash を消費しない。
  const kitSize = activeKit
    ? activeKit.events.reduce((s, ev) => {
        const m = ev.mode ?? 'command'
        if (m !== 'command') return s
        return s + (clips.find((c) => c.id === ev.clipId)?.fileSize ?? 0)
      }, 0) + 1024
    : 0

  return (
    <div className="kit-editor" ref={kitPanelRef} tabIndex={-1}>
      {/* One-row header: title + count + folder chip + create bar.
          Clips 側と違い Kit は検索/import 行が不要なので 1 行にまとめる。 */}
      <div className="panel-header kit-panel-header">
        <h3>Kits</h3>
        <span className="library-count">{kits.length}</span>
        {workDirSupported && (
          <FolderChip
            icon="&#x1F4E6;"
            name={kitDirName}
            onPick={pickKitDir}
            onClear={disconnectKitDir}
            label="Kit"
            emptyTitle="Kit の書き出し先フォルダ。未指定なら Library フォルダ直下に <packId>/ を作る。Unity Assets 等を選ぶと直接そこに書き出せる。"
            setLabel="+ Kit"
          />
        )}
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
                    <label className="kit-meta-field">
                      <span>Name <span className="field-hint">英小文字 / 数字 / -, _ のみ</span></span>
                      <input
                        type="text"
                        value={activeKit.name}
                        // Strip-on-input: silently drop disallowed chars and
                        // lowercase as the user types, so they cannot create
                        // an invalid kit name in the first place. Pasting "My Kit"
                        // becomes "mykit" — and a (throttled) toast tells the
                        // user *why* their character disappeared.
                        onChange={(e) => {
                          const raw = e.target.value
                          const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
                          if (cleaned !== raw) flagKitNameInvalid()
                          if (cleaned !== activeKit.name) updateKit(activeKit.id, { name: cleaned })
                        }}
                        maxLength={64}
                        pattern="[a-z0-9_-]+"
                        title={validateKitName(activeKit.name) ?? '英小文字 / 数字 / -, _ のみ'}
                        style={validateKitName(activeKit.name) ? { borderColor: 'var(--error)' } : undefined}
                      />
                      {validateKitName(activeKit.name) && (
                        <span className="kit-meta-error" style={{ color: 'var(--error)', fontSize: 11, marginTop: 2 }}>
                          {validateKitName(activeKit.name)}
                        </span>
                      )}
                    </label>
                    <label className="kit-meta-field"><span>Version</span>
                      <input type="text" value={activeKit.version} onChange={(e) => updateKit(activeKit.id, { version: e.target.value })} /></label>
                  </div>

                  <details className="kit-target-device">
                    <summary>
                      Target Device
                      <span className="field-hint">
                        Kit 作者が調整したハードウェア / 設定を manifest に記録（任意）
                      </span>
                    </summary>
                    <div className="kit-meta-fields">
                      <label className="kit-meta-field">
                        <span>Board <span className="field-hint">例: duo_wl_v3</span></span>
                        <input
                          type="text"
                          value={activeKit.targetDevice?.board ?? ''}
                          onChange={(e) => {
                            const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                board: cleaned || undefined,
                              },
                            })
                          }}
                          placeholder="duo_wl_v3"
                        />
                      </label>
                      <label className="kit-meta-field">
                        <span>FW min</span>
                        <input
                          type="text"
                          value={activeKit.targetDevice?.firmware_version_min ?? ''}
                          onChange={(e) => updateKit(activeKit.id, {
                            targetDevice: {
                              ...activeKit.targetDevice,
                              firmware_version_min: e.target.value || undefined,
                            },
                          })}
                          placeholder="0.1.0"
                        />
                      </label>
                    </div>
                    <div className="kit-meta-fields">
                      <label className="kit-meta-field">
                        <span>Volume level</span>
                        <input
                          type="number"
                          min={0}
                          value={activeKit.targetDevice?.volume_level ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                volume_level: v === '' ? undefined : Number(v),
                              },
                            })
                          }}
                        />
                      </label>
                      <label className="kit-meta-field">
                        <span>Wiper (0-127)</span>
                        <input
                          type="number"
                          min={0} max={127}
                          value={activeKit.targetDevice?.volume_wiper ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                volume_wiper: v === '' ? undefined : Number(v),
                              },
                            })
                          }}
                        />
                      </label>
                      <label className="kit-meta-field">
                        <span>Volume steps</span>
                        <input
                          type="number"
                          min={1}
                          value={activeKit.targetDevice?.volume_steps ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            updateKit(activeKit.id, {
                              targetDevice: {
                                ...activeKit.targetDevice,
                                volume_steps: v === '' ? undefined : Number(v),
                              },
                            })
                          }}
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      className="library-btn"
                      style={{ marginTop: 6 }}
                      disabled={!devices[0]?.online}
                      title="現在選択中のデバイスから wiper / volume を取得して反映"
                      onClick={() => {
                        const dev = devices[0]
                        if (!dev) return
                        updateKit(activeKit.id, {
                          targetDevice: {
                            ...activeKit.targetDevice,
                            volume_level: dev.volumeLevel ?? activeKit.targetDevice?.volume_level,
                            volume_wiper: dev.volumeWiper ?? activeKit.targetDevice?.volume_wiper,
                            volume_steps: dev.volumeSteps ?? activeKit.targetDevice?.volume_steps,
                          },
                        })
                      }}
                    >⟳ デバイスから取り込む</button>
                  </details>

                  <CapacityGauge kitSize={kitSize} managerConnected={managerConnected} devices={devices} send={send} />

                  <div className="kit-events-header">
                    <span>Events ({activeKit.events.length})</span>
                    <span className="kit-size-label" title="FIRE (command) モードのクリップだけがデバイス flash に載る容量">{formatFileSize(kitSize)}</span>
                    <select
                      className="library-sort"
                      value={`${kitSort.by}:${kitSort.order}`}
                      onChange={(e) => {
                        const [by, order] = e.target.value.split(':') as [KitSortBy, KitSortOrder]
                        setKitSort({ by, order })
                      }}
                      title="並び順"
                    >
                      <option value="name:asc">名前 ↑</option>
                      <option value="name:desc">名前 ↓</option>
                      <option value="date:desc">更新日時 (新しい順)</option>
                      <option value="date:asc">更新日時 (古い順)</option>
                      <option value="duration:asc">長さ (短い順)</option>
                      <option value="duration:desc">長さ (長い順)</option>
                      <option value="order:asc">追加順</option>
                      <option value="order:desc">追加順 (逆)</option>
                    </select>
                    <button
                      className="kit-events-mode-help-btn"
                      onClick={() => setModeInfoOpen(true)}
                      title="FIRE / CLIP の各モードとデバイス側の挙動を説明"
                    ><span className="kit-events-mode-help-icon">?</span>モード説明</button>
                    <select
                      className="kit-events-mode-bulk"
                      value=""
                      disabled={activeKit.events.length === 0}
                      onChange={(e) => {
                        const m = e.target.value as import('@/types/library').KitEventMode
                        if (!m) return
                        // モードが変わると再生挙動 (device 内蔵 / stream) が変わるので
                        // 鳴りっぱなしを防ぐために現在のプレビューを止める。
                        stopPreview()
                        // 全件を 1 回の updateKit で置き換える。
                        // events 配列ごと差し替えるので UI は 1 フレームで一斉に切り替わる
                        // (updateKitEvent を逐次 await すると 1 件ずつ変わるのが見えてしまう)。
                        const nextEvents = activeKit.events.map((ev) =>
                          (ev.mode ?? 'command') === m ? ev : { ...ev, mode: m }
                        )
                        void updateKit(activeKit.id, { events: nextEvents })
                      }}
                      title="Kit 内の全イベントを選択したモードに一括変更"
                    >
                      <option value="" disabled>一括変更…</option>
                      <option value="command">&gt; FIRE — 全て</option>
                      <option value="stream_clip">♪ CLIP — 全て</option>
                      <option value="stream_source">~ LIVE — 全て</option>
                    </select>
                  </div>

                  <div className="kit-events-list">
                    {sortedEvents.length === 0
                      ? <div className="kit-events-empty kit-drop-zone">Drag clips here.</div>
                      // sortedEvents は keyboard navigation と同じ参照を使い、
                      // 視覚順と keyboard 順を必ず一致させる。
                      : sortedEvents.map((ev, i) => (
                        <KitEventRow
                          key={ev.id}
                          event={ev}
                          clip={clips.find((c) => c.id === ev.clipId) ?? null}
                          playing={playingId === ev.id}
                          showDetails={showClipDetails}
                          selected={selectedEventId === ev.id}
                          onSelect={() => setSelectedEventId(ev.id)}
                          onTogglePlay={() => {
                            togglePreview(ev.id, () => getClipAudio(ev.clipId), ev.intensity)
                            const w = getDeviceWiper()
                            if (w !== null && w !== ev.deviceWiper) updateKitEvent(activeKit.id, ev.id, { deviceWiper: w })
                          }}
                          onIntensityChange={(v) => updateKitEvent(activeKit.id, ev.id, { intensity: v })}
                          onModeChange={(mode) => updateKitEvent(activeKit.id, ev.id, { mode })}
                          onDelete={() => removeEventFromKit(activeKit.id, ev.id)}
                          // 常に名前順表示のため drag-reorder は意味を持たない (= 無効)。
                          // clip を新規 drop する場合は末尾追加にフォールバックする。
                          onDragOverRow={() => { /* noop: 名前順表示のため挿入位置を固定できない */ void i }}
                          dragOverIndicator={false}
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
      {modeInfoOpen && <ClipModeInfoModal onClose={() => setModeInfoOpen(false)} />}
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
  const { lastMessage } = useHelperConnection()
  const workDirHandle = useLibraryStore((s) => s.workDirHandle)

  // Per-IP deploy progress sourced from Helper's `deploy_progress` push.
  // Cleared on a new deploy (`deploy started`) and on completion.
  const [progressByIp, setProgressByIp] = useState<Record<string, { pct: number; msg: string; done?: boolean; ok?: boolean }>>({})

  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    const p = lastMessage.payload as Record<string, unknown>
    if (t === 'deploy_progress' && typeof p.ip === 'string') {
      setProgressByIp((cur) => ({
        ...cur,
        [p.ip as string]: {
          pct: Math.max(0, Math.min(100, Number(p.percent ?? 0))),
          msg: String(p.message ?? ''),
        },
      }))
    } else if (t === 'deploy_result' && typeof p.ip === 'string') {
      // Per-device finish (helper sends one of these per target after
      // its run). We only mark done for the one that finished.
      setProgressByIp((cur) => ({
        ...cur,
        [p.ip as string]: {
          pct: p.success === true ? 100 : (cur[p.ip as string]?.pct ?? 0),
          msg: String(p.message ?? (p.success === true ? 'complete' : 'failed')),
          done: true,
          ok: p.success === true,
        },
      }))
    }
  }, [lastMessage])
  const kitDirHandle = useLibraryStore((s) => s.kitDirHandle)
  // kit-out dir が設定されていればそちらを、無ければ library workDir を root にする。
  // どちらの場合も root 直下に `<packId>/` フォルダを作る (kits/ 階層は挟まない)。
  const outRoot = kitDirHandle ?? workDirHandle

  /** Kit を ZIP 化して <outRoot>/<packId>/ に展開書き出し。
   *  outRoot が必須 (未選択時は呼ばれない前提)。返り値は生成した ZIP Blob + packId。
   *
   *  silent=true は auto-save パスから呼ばれる。バリデーション NG のとき
   *  alert を出さずに null を返すだけ — user-typing 中に毎秒 alert が
   *  飛んでくるのを避けるため。 */
  const buildAndSave = useCallback(async (opts?: { silent?: boolean }) => {
    if (!outRoot) throw new Error('Output folder not selected')
    const silent = opts?.silent ?? false

    // Hard validation — these are blockers, not warnings:
    // 1. Kit name must match the contracts regex (a-z 0-9 _ -)
    // 2. Every FIRE / CLIP event must have a non-empty eventId
    //    (LIVE events stream live audio, no event_id needed)
    const kitErr = validateKitName(kit.name)
    if (kitErr) {
      if (!silent) alert(`Kit name invalid: ${kitErr}`)
      return null
    }

    const needsEventId = kit.events.filter(
      (e) => (e.mode ?? 'command') !== 'stream_source',
    )
    const missing = needsEventId.filter((e) => !e.eventId)
    if (missing.length > 0) {
      if (!silent) {
        alert(
          `${missing.length} event(s) have no Event ID.\n` +
          `These usually have a clip with an empty Name — open the clip and set one.`
        )
      }
      return null
    }

    const validations = validateEventIds(kit)
    const invalid = validations.filter((v) => !v.valid)
    if (invalid.length > 0) {
      const ids = invalid.map((v) => `  "${v.eventId}"`).join('\n')
      if (!silent) {
        alert(
          `${invalid.length} event(s) have an Event ID that breaks the contracts format ` +
          `(category.name, only [a-z 0-9 _ -]):\n${ids}`
        )
      }
      return null
    }
    const result = await exportKitAsPack(kit, clips)
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
    // Version が変わっていたら、上書き前に旧 manifest.json を history/ に退避する。
    // 音声データは容量の都合で残さないが、manifest は小さいので履歴として残しておく。
    // 同じ version で上書きするとき (=実質的な編集) はコピーしない。
    try {
      const thisKitDir = await outRoot.getDirectoryHandle(packId, { create: false })
      const oldHandle = await thisKitDir.getFileHandle('manifest.json', { create: false })
      const oldText = await (await oldHandle.getFile()).text()
      const oldVersion = String((JSON.parse(oldText) as { version?: unknown }).version ?? '')
      if (oldVersion && oldVersion !== (kit.version || '1.0.0')) {
        const histDir = await thisKitDir.getDirectoryHandle('history', { create: true })
        const safeVer = oldVersion.replace(/[^a-zA-Z0-9_.-]/g, '_')
        const archHandle = await histDir.getFileHandle(`manifest-${safeVer}.json`, { create: true })
        const w = await archHandle.createWritable()
        await w.write(oldText)
        await w.close()
      }
    } catch {
      // 既存 manifest が無い、または読めない → 初回保存としてスキップ
    }
    // Race-condition guard: silent (auto-save) writes must not
    // resurrect a kit that the user just removed via ×.  Caller
    // checks `kits.some(k => k.id === kit.id)` before invoking us,
    // but the async exportKitAsPack window is wide enough that the
    // deletion can still race in.  Re-check just before the write.
    if (silent) {
      const stillExists = useLibraryStore.getState().kits.some((k) => k.id === kit.id)
      if (!stillExists) return null
    }
    await writeKitFolder(outRoot, packId, files)
    return { blob: result.blob, packId }
  }, [kit, clips, outRoot])

  // Auto-save status, surfaced as a tiny indicator in the deploy bar.
  // 'idle': nothing to save (last write was ahead of state)
  // 'pending': we have unsaved changes, debounce timer is running
  // 'saving': writing to disk now
  // 'saved': just finished a write
  // 'error': last save failed
  type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle')
  const [autoSaveError, setAutoSaveError] = useState<string>('')
  const lastBuildRef = useRef<{ blob: Blob; packId: string } | null>(null)
  const isMountedRef = useRef(true)
  useEffect(() => () => { isMountedRef.current = false }, [])

  // Debounced auto-save — fires 600 ms after the last kit / clips
  // change. Skips silently when the kit name fails validation
  // (otherwise we'd repeatedly alert the user mid-typing). We rebuild
  // the full ZIP so Deploy has a fresh blob without re-running
  // exportKitAsPack on the click.
  //
  // Race condition guard (2026-04-28): when the user clicks ×, we
  // archive the kit folder and remove it from the kits store. But the
  // debounce timer that's already in flight still fires and writes the
  // folder back. The hard guard is an explicit re-check inside the
  // timer body — `useLibraryStore.getState().kits.some(k => k.id === kit.id)`
  // — done AFTER the clearTimeout cleanup window has passed. If the
  // kit was removed, the auto-save bails out before touching disk.
  useEffect(() => {
    if (!outRoot) return
    if (validateKitName(kit.name)) return
    // Note: we no longer skip when events.length === 0. A brand-new
    // kit should still materialise as `<packId>/manifest.json` on disk
    // so the user immediately sees the folder appear in their Explorer
    // alongside their other kits.
    setAutoSaveStatus('pending')
    const handle = window.setTimeout(async () => {
      // Bail out if the kit was deleted in the meantime — see comment
      // above for why this is necessary even though the cleanup also
      // calls clearTimeout.
      const stillExists = useLibraryStore.getState().kits.some((k) => k.id === kit.id)
      if (!stillExists || !isMountedRef.current) {
        setAutoSaveStatus('idle')
        return
      }
      try {
        setAutoSaveStatus('saving')
        useLibraryStore.getState().setLocalFsStatus(
          'saving', `kit "${kit.name}" 保存中…`,
        )
        const out = await buildAndSave({ silent: true })
        if (!isMountedRef.current) return
        // One more check after the async build — the user may have
        // pressed × while we were generating the ZIP.
        const stillExistsAfter = useLibraryStore.getState().kits.some((k) => k.id === kit.id)
        if (!stillExistsAfter) {
          setAutoSaveStatus('idle')
          return
        }
        if (out) {
          lastBuildRef.current = out
          setAutoSaveStatus('saved')
          setAutoSaveError('')
          useLibraryStore.getState().setLocalFsStatus(
            'saved', `kit "${kit.name}" を保存`,
          )
        } else {
          setAutoSaveStatus('idle')
        }
      } catch (err) {
        if (!isMountedRef.current) return
        setAutoSaveStatus('error')
        const msg = err instanceof Error ? err.message : String(err)
        setAutoSaveError(msg)
        useLibraryStore.getState().setLocalFsStatus(
          'error', `kit "${kit.name}" 保存失敗: ${msg}`,
        )
      }
    }, 600)
    return () => window.clearTimeout(handle)
  // We deliberately depend on the kit object identity + clips so
  // every store update retriggers the timer.
  }, [kit, clips, outRoot, buildAndSave])

  const handleDeploy = useCallback(async () => {
    if (!outRoot) { toast('Select an output folder first', 'error'); return }
    if (!managerConnected || devices.length === 0) { toast('No devices', 'error'); return }
    setIsExporting(true)
    // Reset progress for every target up front so the bars render
    // immediately at 0% instead of popping in once Helper starts
    // pushing progress messages.
    setProgressByIp(
      Object.fromEntries(devices.map((d) => [d.ipAddress, { pct: 0, msg: 'queued…' }])),
    )
    try {
      // Prefer the auto-saved blob if it's fresh (autoSaveStatus === 'saved'
      // means the latest state has already been written to disk + a blob
      // is sitting in lastBuildRef). Otherwise build now.
      const out = autoSaveStatus === 'saved' && lastBuildRef.current
        ? lastBuildRef.current
        : await buildAndSave()
      if (!out) return
      const ab = await out.blob.arrayBuffer(); const bytes = new Uint8Array(ab)
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      send({ type: 'deploy_kit_data', payload: { kit_id: out.packId, zip_base64: btoa(bin), targets: devices.map((d) => d.ipAddress) }})
      toast(`Sent "${out.packId}" to ${devices.length} device(s)`, 'success')
    } catch (err) { toast(`Deploy failed: ${err instanceof Error ? err.message : err}`, 'error') }
    finally { setIsExporting(false) }
  }, [autoSaveStatus, buildAndSave, managerConnected, devices, send, outRoot, setIsExporting, toast])

  // Auto-save status copy shown beside the Deploy button. Blocker
  // conditions take precedence so the user always knows the precise
  // reason saving isn't happening.
  const autoSaveLabel = (() => {
    if (!outRoot) return '⚠ Library / Kit Folder を選択してください'
    if (validateKitName(kit.name)) return '⚠ kit 名が無効'
    switch (autoSaveStatus) {
      case 'pending': return '保存待機…'
      case 'saving': return '保存中…'
      case 'saved': return '✓ 自動保存済み'
      case 'error': return `✗ 保存失敗: ${autoSaveError}`
      case 'idle':
      default: return ''
    }
  })()

  return (
    <div className="kit-export-section-wrap">
      <div className="kit-export-section">
        <button
          className="library-btn primary"
          disabled={kit.events.length === 0 || isExporting || !managerConnected || devices.length === 0 || !outRoot}
          onClick={handleDeploy}
          title="自動保存済み Kit を Helper 経由でデバイスに転送する"
        >Deploy</button>

        {/* Per-device deploy progress sits to the *right* of the
            Deploy button — the user's eye stays on the same row.
            Multiple devices stack vertically inside this column. */}
        <div className="kit-deploy-progress-inline">
          {Object.keys(progressByIp).length === 0 ? (
            <span className="kit-export-info muted">
              {!outRoot
                ? 'Library または Kit Folder を選択してください'
                : !managerConnected ? 'Helper offline'
                : devices.length === 0 ? 'デバイスが見つかりません'
                // autoSaveLabel covers the kit-side state ("クリップを追加",
                // "保存中", etc). When idle and everything is OK it falls
                // through to a passive "device count" hint.
                : autoSaveLabel || `${devices.length} device(s) ready`}
            </span>
          ) : (
            Object.entries(progressByIp).map(([ip, st]) => (
              <div key={ip} className="kit-deploy-progress-row">
                <div className="kit-deploy-progress-head">
                  <span className="kit-deploy-progress-ip">{ip}</span>
                  <span className="kit-deploy-progress-pct">{st.pct}%</span>
                </div>
                <div className="kit-deploy-progress-bar">
                  <div
                    className={`kit-deploy-progress-fill ${st.done ? (st.ok ? 'ok' : 'err') : ''}`}
                    style={{ width: `${st.pct}%` }}
                  />
                </div>
                <div className="kit-deploy-progress-msg">{st.msg}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* (legacy) the per-device progress block now lives inline next
          to the Deploy button. We keep this empty branch for the rare
          case where the user wants the stacked-below-bar layout — the
          inline block above is the default. */}
      {false && Object.keys(progressByIp).length > 0 && (
        <div className="kit-deploy-progress">
          {Object.entries(progressByIp).map(([ip, st]) => (
            <div key={ip} className="kit-deploy-progress-row">
              <div className="kit-deploy-progress-head">
                <span className="kit-deploy-progress-ip">{ip}</span>
                <span className="kit-deploy-progress-pct">{st.pct}%</span>
              </div>
              <div className="kit-deploy-progress-bar">
                <div
                  className={`kit-deploy-progress-fill ${st.done ? (st.ok ? 'ok' : 'err') : ''}`}
                  style={{ width: `${st.pct}%` }}
                />
              </div>
              <div className="kit-deploy-progress-msg">{st.msg}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
