import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import type { DeviceInfo } from '@/types/manager'
import { streamClip } from '@/utils/audioStreamer'
import {
  isFileSystemAccessSupported,
  loadDirectoryHandle,
  pickWorkDirectory,
  saveDirectoryHandle,
  verifyPermission,
} from '@/utils/localDirectory'

interface Props {
  device: DeviceInfo
  /** Live intensity ref (0..100 %). Polled per chunk by streamClip
   *  so dragging the slider re-modulates an in-flight stream without
   *  rebuilding it. */
  intensityRef: MutableRefObject<number>
  /** Intensity slider value (0..100 %), controlled by the parent. */
  intensityPct: number
  onIntensityChange: (next: number) => void
}

/** Subset of audio/video extensions the browser can decode via
 *  Web Audio API. Mirrors hapbeat-manager test_page._AUDIO_EXTS. */
const AUDIO_EXTS = new Set([
  '.wav', '.mp3', '.aac', '.m4a', '.ogg', '.flac',
  '.mp4', '.mkv', '.avi', '.mov', '.webm',
])

/** Min visual column width in px. Mirrors Manager's _MIN_COL_W. */
const MIN_COL_W = 170

/** localStorage keys for navigation persistence. The chosen root
 *  directory itself is persisted via IndexedDB (key "streamdir"); these
 *  carry the sub-path inside that root + the last-selected entry so a
 *  device-detail subtab switch (which unmounts this component) doesn't
 *  reset the user's exploration. */
const NAV_PATH_KEY = 'hapbeat-studio-streamtest-path'
const NAV_SEL_KEY = 'hapbeat-studio-streamtest-selected'

function loadSavedPath(): string[] {
  try {
    const raw = localStorage.getItem(NAV_PATH_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}
/** Hysteresis band — must move past +/- this many px past a column
 *  boundary before n flips. Prevents scroll-bar-toggle flicker. */
const COL_HYSTERESIS = 30

interface DirEntry {
  /** Display name including emoji prefix (📁 / 🎵 / 📁 ..). */
  label: string
  /** Stable id used for selection / keyboard nav. */
  id: string
  kind: 'parent' | 'dir' | 'file'
  /** Only set when kind === 'dir' or 'file'. */
  handle?: FileSystemDirectoryHandle | FileSystemFileHandle
}

/**
 * In-tab streaming test — pick a local folder, browse with the keyboard,
 * stream the selected clip to the active device via the Helper.
 *
 * Mirrors the Manager TestPage folder browser:
 *   - 📁 .. row to climb back up the nav stack (capped at the picked root)
 *   - subfolders first, then audio files (sorted natural-ish)
 *   - dynamic column count from container width (170 px min, hysteresis)
 *   - ↑↓←→ moves selection on the grid, Space = play/pause/switch,
 *     Enter / dbl-click = activate (folder → enter, file → stream)
 *   - persistent `streamdir` handle in IndexedDB so re-opens skip the picker
 */
export function StreamingTestSection({
  device,
  intensityRef,
  intensityPct,
  onIntensityChange,
}: Props) {
  const { send } = useHelperConnection()
  const abortRef = useRef<AbortController | null>(null)

  // Folder navigation. `navStack` is the path from the picked root
  // (index 0) to the currently-displayed directory (last element).
  // Going up = pop. Going into a subdir = push. We cannot escape the
  // picked root because FileSystemDirectoryHandle has no parent.
  const [navStack, setNavStack] = useState<FileSystemDirectoryHandle[]>([])
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)

  // Streaming state
  const [streaming, setStreaming] = useState(false)
  const [paused, setPaused] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<string | null>(null)
  const [progress, setProgress] = useState({ current: 0, total: 0, sr: 16000 })
  const [seekPreview, setSeekPreview] = useState<number | null>(null) // 0..1 while dragging
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'muted'; msg: string } | null>(null)

  // Refs for streamClip control surface (read each chunk).
  const pausedRef = useRef(false)
  const seekRequestRef = useRef<number | null>(null)
  pausedRef.current = paused

  // Grid sizing
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [nCols, setNCols] = useState(2)
  const nColsRef = useRef(nCols)
  nColsRef.current = nCols

  // Stop any in-flight stream when device changes / unmount.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [device.ipAddress])

  // ------------------------------------------------------------------
  // Folder loading
  // ------------------------------------------------------------------

  const listEntries = useCallback(
    async (
      stack: FileSystemDirectoryHandle[],
    ): Promise<{ entries: DirEntry[]; error: string | null }> => {
      const cur = stack[stack.length - 1]
      if (!cur) return { entries: [], error: null }
      const dirs: DirEntry[] = []
      const files: DirEntry[] = []
      try {
        for await (const handle of cur.values()) {
          if (handle.kind === 'directory') {
            dirs.push({
              label: `📁 ${handle.name}`,
              id: `dir:${handle.name}`,
              kind: 'dir',
              handle,
            })
          } else if (handle.kind === 'file') {
            const ext = extractExt(handle.name)
            if (AUDIO_EXTS.has(ext)) {
              files.push({
                label: `🎵 ${handle.name}`,
                id: `file:${handle.name}`,
                kind: 'file',
                handle,
              })
            }
          }
        }
      } catch (err) {
        return { entries: [], error: `フォルダ読込失敗: ${String((err as Error).message ?? err)}` }
      }
      dirs.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      files.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
      const out: DirEntry[] = []
      // Parent row is always offered. When we're still inside the
      // picked root it pops the navStack; when we're at the root it
      // re-opens the directory picker scoped near the current dir so
      // the user can pick a parent / sibling. FSAPI doesn't expose
      // a parent handle to JS, so this is the closest analog to the
      // Manager's "climb up to filesystem root" behavior.
      if (stack.length >= 1) {
        out.push({ label: '📁 .. (親フォルダ)', id: '__parent__', kind: 'parent' })
      }
      out.push(...dirs, ...files)
      return { entries: out, error: null }
    },
    [],
  )

  const refreshEntries = useCallback(
    async (
      stack: FileSystemDirectoryHandle[],
      preferSelectedId?: string | null,
    ) => {
      const { entries: list, error } = await listEntries(stack)
      setEntries(list)
      setScanError(error)
      // Prefer the caller-provided selection (used by mount-time
      // restore so a remembered file/folder stays highlighted across a
      // tab switch). Fall back to the first non-parent entry.
      if (preferSelectedId && list.some((e) => e.id === preferSelectedId)) {
        setSelectedId(preferSelectedId)
        return
      }
      const first = list.find((e) => e.kind !== 'parent')
      setSelectedId(first ? first.id : null)
    },
    [listEntries],
  )

  // Restore persisted handle on mount. The user's mid-folder
  // exploration also survives a subtab unmount: replay the saved
  // sub-path off the root + reapply the saved selection.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!isFileSystemAccessSupported()) return
      const handle = await loadDirectoryHandle('streamdir')
      if (cancelled || !handle) return
      const ok = await verifyPermission(handle, false).catch(() => false)
      if (!ok || cancelled) return
      // Walk down the saved sub-path. If a hop is missing (folder was
      // moved/deleted between sessions) we stop where the chain breaks
      // and let the user navigate from there manually.
      const stack: FileSystemDirectoryHandle[] = [handle]
      const savedPath = loadSavedPath()
      for (const segment of savedPath) {
        const next = stack[stack.length - 1]
        try {
          const child = await next.getDirectoryHandle(segment)
          stack.push(child)
        } catch {
          break
        }
      }
      if (cancelled) return
      const savedSel = localStorage.getItem(NAV_SEL_KEY)
      setNavStack(stack)
      await refreshEntries(stack, savedSel)
    })()
    return () => {
      cancelled = true
    }
  }, [refreshEntries])

  // Persist the sub-path as soon as it changes so a tab-switch
  // unmount doesn't lose the user's place. Length 0 means "before
  // root resolved" — leave the saved path alone in that case.
  useEffect(() => {
    if (navStack.length === 0) return
    const subPath = navStack.slice(1).map((h) => h.name)
    try {
      localStorage.setItem(NAV_PATH_KEY, JSON.stringify(subPath))
    } catch { /* quota — ignore */ }
  }, [navStack])

  useEffect(() => {
    if (selectedId) {
      try { localStorage.setItem(NAV_SEL_KEY, selectedId) } catch { /* ignore */ }
    } else {
      try { localStorage.removeItem(NAV_SEL_KEY) } catch { /* ignore */ }
    }
  }, [selectedId])

  // ------------------------------------------------------------------
  // Grid sizing — ResizeObserver + hysteresis
  // ------------------------------------------------------------------

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const recompute = (w: number) => {
      if (w < 10) return
      const cur = nColsRef.current
      const natural = Math.max(1, Math.floor(w / MIN_COL_W))
      let next = cur
      if (cur <= 0) {
        next = natural
      } else if (natural > cur && w >= (cur + 1) * MIN_COL_W + COL_HYSTERESIS) {
        next = cur + 1
      } else if (natural < cur && w < cur * MIN_COL_W - COL_HYSTERESIS && cur > 1) {
        next = cur - 1
      }
      if (next !== cur) setNCols(next)
    }
    recompute(el.clientWidth)
    const ro = new ResizeObserver((records) => {
      for (const r of records) recompute(r.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ------------------------------------------------------------------
  // Activation (Enter / dbl-click) — climb up, descend, or play
  // ------------------------------------------------------------------

  const enterDir = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      const stack = [...navStack, handle]
      setNavStack(stack)
      await refreshEntries(stack)
    },
    [navStack, refreshEntries],
  )

  /** Climb the nav stack. When already at the picked root we instead
   *  prompt the directory picker, scoped at the current root, so the
   *  user can pick a parent or sibling and effectively "escape" the
   *  original sandbox. The browser only exposes parent dirs through
   *  this dialog — there is no API to walk up programmatically. */
  const goUp = useCallback(async () => {
    if (navStack.length === 0) return
    // Switching folders should also halt anything in-flight — otherwise
    // the old stream keeps trickling chunks for a clip whose source
    // folder isn't even visible anymore.
    abortRef.current?.abort()
    if (navStack.length > 1) {
      const stack = navStack.slice(0, -1)
      setNavStack(stack)
      await refreshEntries(stack)
      return
    }
    if (!isFileSystemAccessSupported()) return
    try {
      // showDirectoryPicker accepts a handle as `startIn` — Chrome opens
      // the dialog at that location, letting the user navigate to a
      // parent directory and pick it.
      const handle = await window.showDirectoryPicker({
        id: 'hapbeat-streamdir',
        mode: 'read',
        startIn: navStack[0],
      })
      await saveDirectoryHandle(handle, 'streamdir')
      const stack = [handle]
      setNavStack(stack)
      await refreshEntries(stack)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setStatus({ kind: 'err', msg: `フォルダ選択失敗: ${String(err)}` })
    }
  }, [navStack, refreshEntries])

  const startStreamFromHandle = useCallback(
    async (fileHandle: FileSystemFileHandle) => {
      // Auto-replace any in-flight stream — abort then await briefly so
      // STREAM_END from the old run lands before STREAM_BEGIN of the new.
      abortRef.current?.abort()
      await delay(20)

      let blob: File
      try {
        blob = await fileHandle.getFile()
      } catch (err) {
        setStatus({ kind: 'err', msg: `ファイル読込失敗: ${String(err)}` })
        return
      }
      setNowPlaying(blob.name)
      setStatus({ kind: 'muted', msg: 'デコード + リサンプリング中…' })
      setPaused(false)
      pausedRef.current = false
      seekRequestRef.current = null
      setProgress({ current: 0, total: 0, sr: 16000 })
      setStreaming(true)
      const ctrl = new AbortController()
      abortRef.current = ctrl

      // Read selection at stream-start (not on every chunk — capture
      // the "what was selected when play was pressed" snapshot so
      // toggling devices mid-stream doesn't re-route in flight).
      // Empty selection falls back to the panel's host device so a
      // single-device user without checkboxes ticked still gets a stream.
      const { selectedIps } = useDeviceStore.getState()
      const targets = selectedIps.length > 0 ? selectedIps : [device.ipAddress]
      try {
        const sendForStream: Parameters<typeof streamClip>[1] = (msg) => {
          // Helper's `_resolve_targets` prefers `payload.targets` over
          // `payload.ip`. Sending the array makes stream_begin /
          // stream_data / stream_end fan out to every selected device
          // in one go (UDP per-IP send loop on helper side).
          send({ type: msg.type, payload: { ...msg.payload, targets } })
        }
        setStatus({
          kind: 'muted',
          msg: targets.length > 1
            ? `ストリーミング送信中… (${targets.length} 台へ同時配信)`
            : 'ストリーミング送信中…',
        })
        await streamClip(blob, sendForStream, {
          signal: ctrl.signal,
          control: {
            isPaused: () => pausedRef.current,
            consumeSeek: () => {
              const v = seekRequestRef.current
              seekRequestRef.current = null
              return v
            },
            getIntensity: () => intensityRef.current / 100,
            onProgress: (current, total, sr) =>
              setProgress({ current, total, sr }),
          },
        })
        setStatus({ kind: 'ok', msg: '完了' })
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setStatus({ kind: 'muted', msg: '停止しました' })
        } else {
          setStatus({ kind: 'err', msg: `エラー: ${String(err)}` })
        }
      } finally {
        if (abortRef.current === ctrl) {
          setStreaming(false)
          abortRef.current = null
        }
      }
    },
    [device.ipAddress, intensityRef, send],
  )

  const activateEntry = useCallback(
    async (entry: DirEntry) => {
      if (entry.kind === 'parent') {
        await goUp()
      } else if (entry.kind === 'dir' && entry.handle && entry.handle.kind === 'directory') {
        await enterDir(entry.handle)
      } else if (entry.kind === 'file' && entry.handle && entry.handle.kind === 'file') {
        await startStreamFromHandle(entry.handle)
      }
    },
    [goUp, enterDir, startStreamFromHandle],
  )

  // ------------------------------------------------------------------
  // Toolbar handlers
  // ------------------------------------------------------------------

  const onBrowseDir = useCallback(async () => {
    if (!isFileSystemAccessSupported()) {
      setStatus({
        kind: 'err',
        msg: 'お使いのブラウザは File System Access API をサポートしていません (Chrome / Edge を推奨)',
      })
      return
    }
    // See goUp — picking a different root must also stop any in-flight
    // stream so the player doesn't keep dripping chunks from a folder
    // the user just left.
    abortRef.current?.abort()
    try {
      const handle = await pickWorkDirectory('streamdir')
      if (!handle) return
      await saveDirectoryHandle(handle, 'streamdir')
      const stack = [handle]
      setNavStack(stack)
      await refreshEntries(stack)
    } catch (err) {
      setStatus({ kind: 'err', msg: `フォルダ選択失敗: ${String(err)}` })
    }
  }, [refreshEntries])

  const stopStream = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /** Selection-aware Space (mirrors Manager._toggle_play_or_pause):
   *   - not streaming → activate selected (play file / enter dir / go up)
   *   - streaming + same file → pause/resume toggle
   *   - streaming + different file selected → switch to that file */
  const togglePlayPause = useCallback(() => {
    const sel = entries.find((e) => e.id === selectedId) ?? null
    if (!streaming) {
      if (sel) void activateEntry(sel)
      return
    }
    if (
      sel
      && sel.kind === 'file'
      && sel.handle
      && sel.handle.kind === 'file'
      && sel.handle.name !== nowPlaying
    ) {
      void startStreamFromHandle(sel.handle)
      return
    }
    setPaused((p) => !p)
  }, [entries, selectedId, streaming, nowPlaying, activateEntry, startStreamFromHandle])

  /** Toolbar Play button (mirrors Manager._on_stream_toggle):
   *   - if streaming → stop
   *   - else play selected file → last-played → first file in entries */
  const onToolbarPlayStop = useCallback(() => {
    if (streaming) {
      stopStream()
      return
    }
    const sel = entries.find((e) => e.id === selectedId) ?? null
    let candidate: FileSystemFileHandle | null = null
    if (sel && sel.kind === 'file' && sel.handle?.kind === 'file') {
      candidate = sel.handle as FileSystemFileHandle
    }
    if (!candidate) {
      const firstFile = entries.find(
        (e) => e.kind === 'file' && e.handle?.kind === 'file',
      )
      if (firstFile) {
        candidate = firstFile.handle as FileSystemFileHandle
        setSelectedId(firstFile.id)
      }
    }
    if (!candidate) {
      setStatus({ kind: 'muted', msg: 'リストから音源ファイルを選んでください' })
      return
    }
    void startStreamFromHandle(candidate)
  }, [streaming, stopStream, entries, selectedId, startStreamFromHandle])

  /** Slider drag / click → request seek on every value change.
   *  `consumeSeek` is polled per chunk so rapid drags coalesce into
   *  the latest position naturally. Committing on `onChange`
   *  (instead of waiting for mouseup) means a single click on the
   *  track also seeks immediately, which the previous mouseup-only
   *  handler missed. */
  const onSeekChange = useCallback((frac: number) => {
    setSeekPreview(frac)
    seekRequestRef.current = frac
  }, [])

  const onSeekCommit = useCallback(() => {
    setSeekPreview(null)
  }, [])

  // ------------------------------------------------------------------
  // Drag & drop
  // ------------------------------------------------------------------

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const items = e.dataTransfer.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (typeof (item as DataTransferItem & {
          getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
        }).getAsFileSystemHandle !== 'function') continue
        const handle = await (
          item as DataTransferItem & {
            getAsFileSystemHandle: () => Promise<FileSystemHandle | null>
          }
        ).getAsFileSystemHandle()
        if (!handle) continue
        if (handle.kind === 'directory') {
          await saveDirectoryHandle(handle as FileSystemDirectoryHandle, 'streamdir')
          const stack = [handle as FileSystemDirectoryHandle]
          setNavStack(stack)
          await refreshEntries(stack)
          return
        }
        if (handle.kind === 'file') {
          const ext = extractExt(handle.name)
          if (AUDIO_EXTS.has(ext)) {
            // Drop a single file → just play it. We don't try to remap
            // the navigation root since FSAPI doesn't give parent dirs.
            await startStreamFromHandle(handle as FileSystemFileHandle)
            return
          }
        }
      }
    },
    [refreshEntries, startStreamFromHandle],
  )

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  // ------------------------------------------------------------------
  // Keyboard navigation on the grid
  // ------------------------------------------------------------------

  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (entries.length === 0) return
      const idx = entries.findIndex((en) => en.id === selectedId)
      const cur = idx < 0 ? 0 : idx
      const cols = Math.max(1, nCols)
      let next = cur
      if (e.key === 'ArrowRight') next = Math.min(entries.length - 1, cur + 1)
      else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1)
      else if (e.key === 'ArrowDown') next = Math.min(entries.length - 1, cur + cols)
      else if (e.key === 'ArrowUp') next = Math.max(0, cur - cols)
      else if (e.key === 'Enter') {
        e.preventDefault()
        const sel = entries[cur]
        if (sel) void activateEntry(sel)
        return
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        togglePlayPause()
        return
      } else {
        return
      }
      e.preventDefault()
      const sel = entries[next]
      if (sel) {
        setSelectedId(sel.id)
        // Scroll into view for long lists
        const el = document.getElementById(rowDomId(sel.id))
        el?.scrollIntoView({ block: 'nearest' })
      }
    },
    [entries, selectedId, nCols, activateEntry, togglePlayPause],
  )

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const stack = navStack
  const rootName = stack[0]?.name ?? ''
  // Browser FSAPI deliberately does not hand JS the OS-level absolute
  // path (privacy). The closest we can show is the chain of dir names
  // from the picked root down to the current dir, so the breadcrumb
  // doubles as the path display in the toolbar input.
  const breadcrumb = useMemo(() => {
    if (stack.length === 0) return ''
    return stack.map((h) => h.name).join(' / ')
  }, [stack])

  const fraction =
    progress.total > 0 ? progress.current / progress.total : 0
  const sliderValue = Math.round((seekPreview ?? fraction) * 1000)
  const supports = isFileSystemAccessSupported()

  return (
    <div className="form-section">
      <div className="form-section-title">
        <span className="mode-prefix mode-prefix-clip">♪&nbsp;CLIP</span>
        ストリーミングテスト
      </div>
      <div
        className="form-section-sub-inline"
        style={{ marginBottom: 6, paddingLeft: 4 }}
      >
        Space 再生/一時停止 / ↑↓←→ 選択移動 / Enter フォルダ侵入・再生
      </div>

      <div className="form-row">
        <label>📁 フォルダ</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <span
            className="form-input mono"
            style={{
              flex: 1,
              padding: '6px 8px',
              color: rootName ? 'var(--text-primary)' : 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={
              breadcrumb
                ? `${breadcrumb}\n（ブラウザはセキュリティ上、OS のフルパスを公開しません。表示はピックしたフォルダから現在位置までの相対パスです）`
                : ''
            }
          >
            {breadcrumb || '音源フォルダを選択（参照... ボタン）'}
          </span>
          <button
            type="button"
            className="form-button-secondary"
            onClick={onBrowseDir}
            disabled={streaming}
            title="音源フォルダを選択"
          >
            参照…
          </button>
        </div>
        <span />
      </div>

      <div
        ref={gridRef}
        className="stream-grid"
        tabIndex={0}
        role="listbox"
        aria-label="ストリーミング音源リスト"
        onKeyDown={onGridKeyDown}
        onDragOver={onDragOver}
        onDrop={onDrop}
        style={{
          gridTemplateColumns: `repeat(${nCols}, minmax(0, 1fr))`,
        }}
      >
        {!supports && (
          <div className="stream-grid-empty">
            このブラウザでは File System Access API が使えません。Chrome / Edge を使ってください。
          </div>
        )}
        {supports && entries.length === 0 && !scanError && (
          <div className="stream-grid-empty">
            {rootName
              ? '（このフォルダに音源ファイルもサブフォルダもありません）'
              : 'まずは「参照…」で音源フォルダを選んでください。フォルダごとドラッグ&ドロップしても OK。'}
          </div>
        )}
        {scanError && <div className="stream-grid-empty">{scanError}</div>}
        {entries.map((en) => (
          <div
            id={rowDomId(en.id)}
            key={en.id}
            role="option"
            aria-selected={en.id === selectedId}
            className={`stream-grid-item${en.id === selectedId ? ' selected' : ''}${
              en.kind === 'file' && en.handle?.kind === 'file' && en.handle.name === nowPlaying
                ? ' playing'
                : ''
            }`}
            onClick={() => {
              setSelectedId(en.id)
              gridRef.current?.focus()
            }}
            onDoubleClick={() => void activateEntry(en)}
            title={en.label}
          >
            {en.label}
          </div>
        ))}
      </div>

      <div className="form-row">
        <label>再生中</label>
        <span
          className="form-input mono"
          style={{
            width: '100%',
            padding: '6px 8px',
            color: nowPlaying ? 'var(--text-primary)' : 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {nowPlaying ?? '—'}
        </span>
        <span />
      </div>

      <div className="form-row">
        <label>再生位置</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            type="range"
            min={0}
            max={1000}
            value={sliderValue}
            disabled={!streaming || progress.total === 0}
            onChange={(e) => onSeekChange(Number(e.target.value) / 1000)}
            onPointerUp={onSeekCommit}
            onMouseUp={onSeekCommit}
            onTouchEnd={onSeekCommit}
            onKeyUp={onSeekCommit}
            style={{ flex: 1 }}
          />
          <span
            className="form-input mono short"
            style={{ textAlign: 'right', minWidth: 110 }}
          >
            {fmtTime(progress.current, progress.sr)} / {fmtTime(progress.total, progress.sr)}
          </span>
        </div>
        <span />
      </div>

      <div className="form-row">
        <label>Intensity</label>
        <div className="form-row-multi" style={{ width: '100%' }}>
          <input
            type="range"
            min={0}
            max={100}
            value={intensityPct}
            onChange={(e) => onIntensityChange(Number(e.target.value))}
            style={{ flex: 1 }}
            aria-label="ストリーミング Intensity (CLIP のみ)"
          />
          <span
            className="form-input mono short"
            style={{ textAlign: 'right', minWidth: 60 }}
          >
            {intensityPct}%
          </span>
        </div>
        <span />
      </div>
      <div className="form-status muted" style={{ padding: '0 4px', marginTop: -4 }}>
        ※ Intensity はストリーミング (CLIP) 専用。FIRE は Kit deploy 時の
        manifest intensity が適用されるため、ここで変更しても反映されません。
      </div>

      <div className="form-action-row">
        <button
          className="form-button"
          onClick={onToolbarPlayStop}
          disabled={!device.online || (entries.length === 0 && !streaming)}
          // Fixed min-width so the label flip between "▶ 再生 (stream)"
          // and "■ 停止" doesn't reflow the toolbar — the user reported
          // that watching the button shrink mid-playback is distracting.
          style={{ minWidth: 132, textAlign: 'center' }}
        >
          {streaming ? '■ 停止' : '▶ 再生 (stream)'}
        </button>
        <button
          className="form-button-secondary"
          onClick={() => setPaused((p) => !p)}
          disabled={!streaming}
          aria-pressed={paused}
        >
          {paused ? '▶ 再開' : '⏸ 一時停止'}
        </button>
        {status && (
          <span className={`form-status ${status.kind}`} style={{ alignSelf: 'center' }}>
            {status.msg}
          </span>
        )}
      </div>

      <div className="form-status muted" style={{ marginTop: 6 }}>
        ステレオ素材は LR 両方が送信されます (デバイスがステレオ対応の場合のみ意味あり)。
      </div>
    </div>
  )
}

// ---- Helpers ----

function extractExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

function rowDomId(id: string): string {
  // encodeURIComponent escapes non-ASCII / special chars without collapsing
  // them to a single placeholder, so two distinct Unicode filenames
  // ("あ.wav" / "い.wav") still get distinct DOM ids — important because
  // arrow-key nav uses the id to scrollIntoView the right row. % is the
  // only escape-output char CSS selectors choke on; map it to `_`.
  return `stream-grid-row-${encodeURIComponent(id).replace(/%/g, '_')}`
}

function fmtTime(frames: number, sr: number): string {
  if (!sr || sr <= 0 || !Number.isFinite(frames) || frames <= 0) return '0:00'
  const secs = Math.floor(frames / sr)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
