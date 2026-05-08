import { useState, useCallback, useMemo, useRef, useEffect, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import type {
  DisplayElementType,
  DisplayLayout,
  DisplayPage,
  ButtonActionType,
  SingleButtonAction,
  PerButtonActions,
  DisplayOrientation,
  LedConfig,
  VolumeConfig,
} from '@/types/display'
import { getElementSize, LED_CONDITION_METAS } from '@/types/display'
import type { DeviceModel, DeviceHardwareSpec } from '@/types/device'
import { DEVICE_SPECS } from '@/types/device'
import { ElementPalette, getElementMeta, PALETTE_SECTIONS } from '@/components/common/ElementPalette'
import { getElementPreviewText, DEFAULT_SIM_STATE } from '@/utils/displayPreview'
import type { SimState } from '@/utils/displayPreview'
import {
  getPagePresetsFor, duoStandardTemplate, bandStandardTemplate,
  buildInitialLayoutByModel,
  INITIAL_PER_BUTTON_ACTIONS,
  INITIAL_LED_CONFIG,
  INITIAL_VOLUME_CONFIG,
  INITIAL_UI_SETTINGS,
  INITIAL_ORIENTATION_BY_MODEL,
} from '@/utils/templates'
import {
  exportDisplayLayout,
  importDisplayLayout,
  saveDisplayToIDB,
  toFirmwareFormat,
  type DisplaySavedState,
} from '@/utils/displayLayoutIO'
import type { UiSettings } from '@/types/display'
import { UiSettingsModal } from './UiSettingsModal'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceStore } from '@/stores/deviceStore'
import { useToast } from '@/components/common/Toast'
import { useConfirm } from '@/components/common/useConfirm'
import { LedConfigModal } from './LedConfigModal'
import { VolumeConfigModal } from './VolumeConfigModal'
import { DevicePill } from '@/components/devices/DevicePill'
import './DisplayEditor.css'

/** パレットからドラッグ中の要素タイプ + variant */
let _dragTypeCallback: ((type: DisplayElementType | null) => void) | null = null
let _dragVariant: string | undefined
export function setCurrentDragType(type: DisplayElementType | null) {
  _dragTypeCallback?.(type)
}
export function setCurrentDragVariant(variant: string | undefined) {
  _dragVariant = variant
}
export function getCurrentDragVariant(): string | undefined {
  return _dragVariant
}

// OLED: 128x32 = 16文字×2行（8x16px/文字）
const GRID_COLS = 16
const GRID_ROWS = 2
const CELL_W = 32   // 1文字セルの表示幅
const CELL_H = 56   // 1文字セルの表示高さ
const GRID_WIDTH = GRID_COLS * CELL_W   // 512
const GRID_HEIGHT = GRID_ROWS * CELL_H  // 112
const BORDER_W = 2  // CSS border width on .oled-screen

/** グリッド行内のアイテム（空セルまたは要素カード） */
type GridItem =
  | { kind: 'empty'; col: number }
  | { kind: 'element'; col: number; span: number; el: import('@/types/display').DisplayElement; text: string }

/** 各行を「空セル / 要素カード」のリストに変換 */
function buildGridRows(page: DisplayPage | undefined, simState: SimState): GridItem[][] {
  const rows: GridItem[][] = Array.from({ length: GRID_ROWS }, () => [])
  if (!page) {
    for (let r = 0; r < GRID_ROWS; r++)
      for (let c = 0; c < GRID_COLS; c++) rows[r].push({ kind: 'empty', col: c })
    return rows
  }

  // 占有マップ: どのセルがどの要素に属するか
  const occupied: (string | null)[][] = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => null)
  )
  for (const el of page.elements) {
    const size = getElementSize(el.type, el.variant)
    for (let dx = 0; dx < size[0]; dx++) {
      const col = el.pos[0] + dx
      if (col < GRID_COLS && el.pos[1] < GRID_ROWS) occupied[el.pos[1]][col] = el.id
    }
  }

  for (let r = 0; r < GRID_ROWS; r++) {
    let c = 0
    while (c < GRID_COLS) {
      const elId = occupied[r][c]
      if (elId) {
        const el = page.elements.find((e) => e.id === elId)!
        const size = getElementSize(el.type, el.variant)
        const text = getElementPreviewText(el.type, simState, el.variant)
        rows[r].push({ kind: 'element', col: c, span: size[0], el, text })
        c += size[0]
      } else {
        rows[r].push({ kind: 'empty', col: c })
        c++
      }
    }
  }
  return rows
}

const DEFAULT_BUTTON_ACTION: SingleButtonAction = {
  short_press: 'none', long_press: 'none',
  // hold_tmp / hold_latch を独立保持。`hold` は serialize 時に派生される
  // ので UI/ロジックでは使わない。
  hold_tmp: 'none', hold_latch: 'none', hold_mode: 'momentary',
}

/**
 * `action.hold_mode` に対応する hold action を返す。
 * Tmp/Exec を独立保持する仕組みのため、UI / シミュレータは常にこの helper を
 * 経由して active 値を読む (= legacy `action.hold` を直接読まない)。
 */
function getActiveHoldAction(action: SingleButtonAction | undefined): ButtonActionType {
  if (!action) return 'none'
  const mode = action.hold_mode ?? 'momentary'
  return (mode === 'momentary' ? action.hold_tmp : action.hold_latch) ?? 'none'
}

function generateId(): string {
  return `el-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// `createDefaultPerButtonActions` (= 全 button を 'none' で埋める旧 helper)
// は撤去。出荷時 button actions は templates.ts の
// `INITIAL_PER_BUTTON_ACTIONS` を使う (Duo 5 + Band 3 を JSON 由来の値で埋める)。

/** アクション選択肢を2列グリッドで表示するためにグループ化 */
/** ページ名に応じた goto_page ラベルを動的生成 */
/** ドロップダウン用アイテム。value は ButtonActionType だが goto_page は "goto_page:0" 等の拡張形式 */
interface ActionItem { value: string; label: string }
interface ActionGroup { label: string; items: ActionItem[] }

/** 短押し・長押し用アクション */
function buildActionGroups(pages: DisplayPage[], deviceModel: DeviceModel): ActionGroup[] {
  const pageItems: ActionItem[] = [
    { value: 'prev_page', label: 'Prev Page' },
    { value: 'next_page', label: 'Next Page' },
  ]
  pages.forEach((p, i) => {
    pageItems.push({ value: `goto_page:${i}`, label: `\u2192 ${p.name}` })
  })
  pageItems.push({ value: 'toggle_page', label: 'Toggle Page' })

  const groups: ActionGroup[] = [
    { label: 'Page', items: pageItems },
    {
      // Position はボタン操作対象外 (設定でのみ変更)。
      // Group はマルチプレイヤー時にボタンで切替できる。
      label: 'Player / Group',
      items: [
        { value: 'player_inc', label: 'Player +1' },
        { value: 'player_dec', label: 'Player -1' },
        { value: 'group_inc', label: 'Group +1' },
        { value: 'group_dec', label: 'Group -1' },
      ],
    },
  ]

  // Volume は BandWL のみ（DuoWL はノブで調整）
  if (deviceModel === 'band_wl') {
    groups.push({
      label: 'Volume (Var mode)',
      items: [
        { value: 'volume_up', label: 'Volume +' },
        { value: 'volume_down', label: 'Volume -' },
      ],
    })
  }

  groups.push({
    label: 'System',
    items: [
      { value: 'wifi_select', label: 'Wi-Fi \u9078\u629e\u30e2\u30fc\u30c9' },
    ],
  })

  groups.push({
    label: 'Other',
    items: [
      { value: 'display_toggle', label: 'Display ON/OFF' },
      { value: 'led_toggle', label: 'LED ON/OFF' },
      { value: 'vib_mode', label: 'VibMode Var/Fix' },
      { value: 'none', label: '\u2014 (None)' },
    ],
  })

  return groups
}

/** 押し続け用アクション。Tmp: toggle系 + ページ遷移のみ。Exec: Press と同じ全アクション */
function buildHoldActionGroups(pages: DisplayPage[], holdMode: import('@/types/display').HoldMode, deviceModel: DeviceModel): ActionGroup[] {
  if (holdMode === 'momentary') {
    // Tmp: 離したら戻せるアクションのみ（ファーム側で hold_page: として処理）
    // next_page / prev_page \u3082\u30da\u30fc\u30b8\u79fb\u52d5\u64cd\u4f5c\u3068\u3057\u3066 hold \u306b\u7f6e\u3051\u308b\u3088\u3046\u8ffd\u52a0\u3002
    // (firmware \u306f\u6b21/\u524d\u3078\u300c\u9032\u3081\u308b\u300d\u3060\u3051\u3067\u96e2\u3057\u3066\u3082\u81ea\u52d5\u3067\u623b\u3089\u306a\u3044\u306e\u3067\u3001
    // \u53b3\u5bc6\u306a tmp \u6319\u52d5\u306f hold_page:N \u306e\u307b\u3046\u306e\u307f\u3002next/prev \u306f\u5b9f\u8cea latch \u3068\u540c\u7b49)
    // Tmp: pageItems \u306f hold_page:N \u306e\u307f (= \u96e2\u3057\u305f\u3089\u5143\u30da\u30fc\u30b8\u306b\u623b\u308b)\u3002
    // prev_page / next_page \u306f firmware \u304c\u300c\u9032\u3081\u308b\u300d\u3060\u3051\u3067\u96e2\u3057\u3066\u3082\u623b\u3089\u306a\u3044 =
    // \u5b9f\u8cea latch \u306a\u306e\u3067 Tmp menu \u304b\u3089\u306f\u9664\u5916 (2026-05-09 \u30e6\u30fc\u30b6\u8981\u671b)\u3002
    const pageItems: ActionItem[] = pages.map((p, i) => ({
      value: `hold_page:${i}`, label: `\u2192 ${p.name} (tmp)`,
    }))
    return [
      { label: 'Page', items: pageItems },
      {
        label: 'Toggle',
        items: [
          { value: 'display_toggle', label: 'Display ON/OFF' },
          { value: 'none', label: '\u2014 (None)' },
        ],
      },
    ]
  }
  // Exec: Press と同じ
  return buildActionGroups(pages, deviceModel)
}



/** 衝突チェック: 指定位置に要素を置けるか。
 *
 * variant 必須化 (2026-05-07): 旧実装は ELEMENT_FIXED_SIZES[type] を
 * 直接見ていたため battery 'bar' (8 文字) 等の variant 拡幅サイズを
 * 反映できず、ドラッグ時の影と実サイズが合っていなかった。
 */
function canPlace(
  page: DisplayPage,
  type: DisplayElementType,
  pos: [number, number],
  excludeId?: string,
  variant?: string,
): boolean {
  const size = getElementSize(type, variant)
  if (pos[0] + size[0] > GRID_COLS || pos[1] + size[1] > GRID_ROWS) return false
  return !page.elements.some((el) => {
    if (el.id === excludeId) return false
    const s = getElementSize(el.type, el.variant)
    return (
      pos[0] < el.pos[0] + s[0] && pos[0] + size[0] > el.pos[0] &&
      pos[1] < el.pos[1] + s[1] && pos[1] + size[1] > el.pos[1]
    )
  })
}

// ========================================
// 自動保存
// ========================================

const STORAGE_KEY = 'hapbeat-studio-display'

interface SavedState {
  /** Duo と Band で OLED レイアウトを **個別に** 保持 (2026-05-09 ユーザ要望)。 */
  layoutByModel: Record<DeviceModel, DisplayLayout>
  deviceModel: DeviceModel
  /** デバイスモデル別の回転状態 (Duo / Band 個別に保持)。 */
  orientationByModel: Record<DeviceModel, DisplayOrientation>
  perButtonActions: PerButtonActions
  simState: SimState
  ledConfig: LedConfig
  volumeConfig: VolumeConfig
  uiSettings?: UiSettings
}

/**
 * 旧フォーマットからのマイグレーション込みの読み込み:
 *   - 旧 single `orientation` field → `orientationByModel`
 *   - 旧 single `layout` field → `layoutByModel` (両モデルにクローン
 *     して既存の編集成果を失わないようにする。ユーザは Duo/Band
 *     どちらでも続きを編集できる。)
 * リリース前のローカル開発状態を捨てたくないので一度だけ変換する。
 */
function loadSaved(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<SavedState> & {
      orientation?: DisplayOrientation
      /** 旧 (2026-05-09 以前): 単一 layout を共有していた時代の field。 */
      layout?: DisplayLayout
    }
    if (!data.orientationByModel) {
      const old: DisplayOrientation = data.orientation ?? 'normal'
      const model: DeviceModel = data.deviceModel ?? 'duo_wl'
      data.orientationByModel = { duo_wl: 'normal', band_wl: 'normal' }
      data.orientationByModel[model] = old
      delete data.orientation
    }
    if (!data.layoutByModel && data.layout) {
      // 旧 single layout を両モデルにクローンして移行 (どちらのモデル
      // でも編集成果を失わないようにする)。
      data.layoutByModel = {
        duo_wl: structuredClone(data.layout),
        band_wl: structuredClone(data.layout),
      }
      delete data.layout
    }
    return data as SavedState
  } catch { return null }
}

function saveTo(state: SavedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    // sessionStorage にもバックアップ
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

// ========================================
// メインコンポーネント
// ========================================

export function DisplayEditor() {
  const saved = useRef(loadSaved()).current
  // OLED レイアウトはモデル別に独立保持 (2026-05-09 ユーザ要望)。
  // 表示用に一旦 derived `layout` に展開するが、編集は `setLayout` 経由で
  // 該当モデルのスロットだけが書き換わる。
  const [layoutByModel, setLayoutByModel] = useState<Record<DeviceModel, DisplayLayout>>(
    // 初期出荷状態: Duo は main / exhibit / debug の 3 ページ、
    // Band は main / debug の 2 ページ (2026-05-09 ユーザ提供 JSON 由来)。
    () => saved?.layoutByModel ?? buildInitialLayoutByModel()
  )
  const [activePageIndex, setActivePageIndex] = useState(0)
  const [deviceModel, setDeviceModel] = useState<DeviceModel>(saved?.deviceModel ?? 'duo_wl')
  // 現アクティブモデルの layout を派生。`setLayout` は該当スロットのみ更新する。
  const layout = layoutByModel[deviceModel]
  // `setLayout` は React 標準 setter と同じく **stable reference** で
  // 提供する (= deps を持たない)。理由: handleMoveElement / addElement /
  // handleDeleteElement / handleAddPage 等の useCallback は設計時点では
  // `setLayout` を deps に入れていない (旧実装は React useState setter
  // で stable だったため)。ここで deviceModel を deps に入れた useCallback
  // を返すと、下流コールバックが **初回 render 時の古い setLayout を
  // 捕まえ** て deviceModel 切替後も常に旧モデルのスロットに書き続ける
  // バグを引き起こす (2026-05-09 ユーザ報告: Band 切替後に編集が反映
  // されない)。ref で現 deviceModel を読みに行く形にして deps ゼロを保つ。
  const deviceModelRef = useRef(deviceModel)
  useEffect(() => { deviceModelRef.current = deviceModel }, [deviceModel])
  const setLayout = useCallback(
    (next: DisplayLayout | ((prev: DisplayLayout) => DisplayLayout)) => {
      setLayoutByModel((prev) => {
        const model = deviceModelRef.current
        const cur = prev[model]
        const updated = typeof next === 'function'
          ? (next as (p: DisplayLayout) => DisplayLayout)(cur)
          : next
        return { ...prev, [model]: updated }
      })
    },
    [],
  )
  // 回転状態は Duo / Band 個別に保持。エディタ上のモデル切替で
  // 各デバイスの最後の向き設定が復元される。
  const [orientationByModel, setOrientationByModel] = useState<
    Record<DeviceModel, DisplayOrientation>
  >(saved?.orientationByModel ?? { ...INITIAL_ORIENTATION_BY_MODEL })
  // 表示用 (現アクティブモデルの orientation を派生)。
  const orientation: DisplayOrientation = orientationByModel[deviceModel]
  // 出荷時の per-button actions (Duo 5 + Band 3) を初期値として使う。
  // 旧実装は createDefaultPerButtonActions で「全 button が none」だったため
  // ユーザ提供 JSON の hold (prev_page / next_page 等) が反映されず、
  // 「btn_1/btn_4 の hold が none になっている」報告 (2026-05-09) の原因。
  const [perButtonActions, setPerButtonActions] = useState<PerButtonActions>(
    saved?.perButtonActions ?? structuredClone(INITIAL_PER_BUTTON_ACTIONS)
  )
  const [popupPos, setPopupPos] = useState<{ col: number; row: number; x: number; y: number; screenX: number; screenY: number } | null>(null)
  // 旧バージョンで保存された simState は新規追加フィールド (e.g. 2026-05-08
  // 追加の group) を持たない → そのまま使うと undefined が UI に出てしまう。
  // 必ず DEFAULT を baseline に spread merge する。
  const [simState, setSimState] = useState<SimState>(
    () => ({ ...DEFAULT_SIM_STATE, ...(saved?.simState ?? {}) })
  )
  // Migration: drop rules whose `condition` is no longer in
  // LED_CONDITION_METAS (e.g. legacy `idle_espnow` / `charging` from before
  // 2026-05-08). Without this, deploy would still ship the orphan rules to
  // firmware where they sit silently, and the modal couldn't render them.
  const [ledConfig, setLedConfig] = useState<LedConfig>(() => {
    if (!saved?.ledConfig) {
      return structuredClone(INITIAL_LED_CONFIG)
    }
    // Migration: drop rules whose condition no longer exists, re-add missing
    // default-rule conditions. Baseline は INITIAL_LED_CONFIG を使う。
    const validConditions = new Set(LED_CONDITION_METAS.map((m) => m.condition))
    const kept = saved.ledConfig.rules.filter((r) => validConditions.has(r.condition))
    for (const def of INITIAL_LED_CONFIG.rules) {
      if (!kept.some((r) => r.condition === def.condition)) {
        kept.push({ ...def })
      }
    }
    return { ...saved.ledConfig, rules: kept }
  })
  const [volumeConfig, setVolumeConfig] = useState<VolumeConfig>(
    saved?.volumeConfig ?? { ...INITIAL_VOLUME_CONFIG }
  )
  // 旧バージョンで保存された uiSettings は新規追加フィールド (e.g. 2026-05-08
  // 追加の hold_feedback_color / hold_feedback_start_ms) を持たない可能性が
  // あるため、必ず INITIAL を baseline に spread merge する。
  const [uiSettings, setUiSettings] = useState<UiSettings>(
    () => ({ ...INITIAL_UI_SETTINGS, ...(saved?.uiSettings ?? {}) })
  )
  const [ledModalOpen, setLedModalOpen] = useState(false)
  const [volumeModalOpen, setVolumeModalOpen] = useState(false)
  const [uiSettingsModalOpen, setUiSettingsModalOpen] = useState(false)
  const [dropHint, setDropHint] = useState<{ msg: string; x: number; y: number } | null>(null)
  const [externalDragType, setExternalDragType] = useState<DisplayElementType | null>(null)

  // 共通 confirm ダイアログ (window.confirm 置換)。
  // handleResetToDefault などのハンドラから先に参照されるため、
  // 他の hook より前に取得する。
  const { ask: askConfirm, dialog: confirmDialog } = useConfirm()

  // パレットからのドラッグ通知を受け取る
  useEffect(() => {
    _dragTypeCallback = setExternalDragType
    return () => { _dragTypeCallback = null }
  }, [])

  // 自動保存: 状態変更のたびに localStorage + sessionStorage + IndexedDB に保存
  useEffect(() => {
    const state: DisplaySavedState = { layoutByModel, deviceModel, orientationByModel, perButtonActions, simState, ledConfig, volumeConfig, uiSettings }
    saveTo(state)
    saveDisplayToIDB(state)
  }, [layoutByModel, deviceModel, orientationByModel, perButtonActions, simState, ledConfig, volumeConfig, uiSettings])

  const oledRef = useRef<HTMLDivElement>(null)
  const deviceSpec = DEVICE_SPECS[deviceModel]
  const activePage = layout.pages[activePageIndex] ?? layout.pages[0]
  const isFlipped = orientation === 'flipped'

  const usedTypes = useMemo(() => {
    const set = new Set<DisplayElementType>()
    if (activePage) for (const el of activePage.elements) set.add(el.type)
    return set
  }, [activePage])

  const gridRows = useMemo(() => buildGridRows(activePage, simState), [activePage, simState])

  // --- ハンドラ ---

  const handleDeviceModelChange = useCallback((model: DeviceModel) => {
    setDeviceModel(model)
    // 既存のボタン設定はすべて保持。新モデルのボタンで未設定のもののみ
    // 出荷時の INITIAL_PER_BUTTON_ACTIONS から補完する。
    // (旧実装は createDefaultPerButtonActions で全 'none' を入れていたため、
    //  Band 初回切替時に hold が 'none' のままになっていた。)
    const modelButtonIds = new Set(DEVICE_SPECS[model].buttons.map((b) => b.id))
    setPerButtonActions((prev) => {
      const fill: PerButtonActions = {}
      for (const id of modelButtonIds) {
        if (!prev[id] && INITIAL_PER_BUTTON_ACTIONS[id]) {
          fill[id] = structuredClone(INITIAL_PER_BUTTON_ACTIONS[id])
        }
      }
      return Object.keys(fill).length === 0 ? prev : { ...prev, ...fill }
    })
  }, [])

  // activePageIndex が現モデルのページ数を超えると、
  // setLayout 系ハンドラ (`if (!page) return prev`) が silent bail-out
  // して **編集が反映されない** (2026-05-09 ユーザ報告)。
  //   例: Duo で 2 ページに増やして page 1 表示中 → Band に切替 → Band は
  //       1 ページ → activePageIndex=1 のまま → ハンドラ bail-out。
  // モデル別レイアウト保持で各モデルのページ数が独立になったので、
  // モデル切替 / レイアウト変更のたびに index を有効範囲にクランプする。
  useEffect(() => {
    const max = Math.max(0, layout.pages.length - 1)
    if (activePageIndex > max) setActivePageIndex(max)
  }, [layout.pages.length, activePageIndex])

  const handleMoveElement = useCallback(
    (elementId: string, newPos: [number, number]) => {
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const page = newPages[activePageIndex]
        if (!page) return prev
        const el = page.elements.find((e) => e.id === elementId)
        if (!el) return prev
        const size = getElementSize(el.type, el.variant)
        const clamped: [number, number] = [
          Math.max(0, Math.min(newPos[0], GRID_COLS - size[0])),
          Math.max(0, Math.min(newPos[1], GRID_ROWS - size[1])),
        ]
        if (!canPlace(page, el.type, clamped, elementId, el.variant)) return prev
        const updatedElements = page.elements.map((e) =>
          e.id === elementId ? { ...e, pos: clamped } : e
        )
        newPages[activePageIndex] = { ...page, elements: updatedElements }
        return { ...prev, pages: newPages }
      })
    },
    [activePageIndex]
  )

  const showToast = useCallback((msg: string, x: number, y: number) => {
    setDropHint({ msg, x, y })
    setTimeout(() => setDropHint(null), 2000)
  }, [])

  const addElement = useCallback(
    (type: DisplayElementType, pos: [number, number], mouseX?: number, mouseY?: number, variant?: string): boolean => {
      const page = layout.pages[activePageIndex]
      if (!page) return false
      // 重複チェック:
      //   app_name は variant (4/8/16 文字) が違っても意味は同じ表示なので
      //     1 ページ 1 個だけに制限。
      //   それ以外は (type + variant) 単位でユニーク (battery は % と bar
      //     が共存可能)。
      const dupExists = type === 'app_name'
        ? page.elements.some((el) => el.type === 'app_name')
        : page.elements.some(
            (el) => el.type === type
              && (el.variant ?? 'standard') === (variant ?? 'standard'),
          )
      if (dupExists) {
        if (mouseX != null && mouseY != null) showToast('この要素は既に配置済みです', mouseX, mouseY)
        return false
      }
      const size = getElementSize(type, variant)
      const clampedPos: [number, number] = [
        Math.max(0, Math.min(pos[0], GRID_COLS - size[0])),
        Math.max(0, Math.min(pos[1], GRID_ROWS - size[1])),
      ]
      if (!canPlace(page, type, clampedPos, undefined, variant)) {
        if (mouseX != null && mouseY != null) showToast('スペースが不足しています', mouseX, mouseY)
        return false
      }
      const newEl: import('@/types/display').DisplayElement = { id: generateId(), type, pos: clampedPos }
      if (variant && variant !== 'standard') {
        newEl.variant = variant as 'compact' | 'bar' | 'wide'
      }
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const p = newPages[activePageIndex]
        if (!p) return prev
        newPages[activePageIndex] = {
          ...p, elements: [...p.elements, newEl],
        }
        return { ...prev, pages: newPages }
      })
      return true
    },
    [activePageIndex, layout.pages, showToast]
  )

  // パレットからの mouse ドラッグ
  useEffect(() => {
    if (!externalDragType) return
    document.body.classList.add('is-dragging')
    const onMove = (e: MouseEvent) => {
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const rawCol = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
      const rawRow = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
      if (rawCol >= 0 && rawCol < GRID_COLS && rawRow >= 0 && rawRow < GRID_ROWS) {
        setDragPos((prev) => (prev?.col === rawCol && prev?.row === rawRow) ? prev : { col: rawCol, row: rawRow })
      } else {
        setDragPos((prev) => prev === null ? prev : null)
      }
    }
    const onUp = (e: MouseEvent) => {
      document.body.classList.remove('is-dragging')
      if (oledRef.current) {
        const rect = oledRef.current.getBoundingClientRect()
        const col = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
        const row = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
        if (col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS) {
          addElement(externalDragType, [col, row], e.clientX, e.clientY, getCurrentDragVariant())
        }
      }
      setDragPos(null)
      setExternalDragType(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('is-dragging')
    }
  }, [externalDragType, addElement])

  const handleDeleteElement = useCallback(
    (elementId: string) => {
      setLayout((prev) => {
        const newPages = [...prev.pages]
        const page = newPages[activePageIndex]
        if (!page) return prev
        newPages[activePageIndex] = {
          ...page, elements: page.elements.filter((el) => el.id !== elementId),
        }
        return { ...prev, pages: newPages }
      })
    },
    [activePageIndex]
  )

  // OLED クリック → ポップアップ
  const handleOledClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const col = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
      const row = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
      if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return
      const localX = col * CELL_W
      const localY = row * CELL_H
      setPopupPos({ col, row, x: localX, y: localY, screenX: rect.left + BORDER_W + localX, screenY: rect.top + BORDER_W + localY + CELL_H + 4 })
    },
    []
  )

  const handlePopupSelect = useCallback(
    (type: DisplayElementType) => {
      if (popupPos) addElement(type, [popupPos.col, popupPos.row])
      setPopupPos(null)
    },
    [popupPos, addElement]
  )

  // ドラッグ中の位置と配置可否を追跡
  const [dragPos, setDragPos] = useState<{ col: number; row: number } | null>(null)
  // 内部移動ドラッグ中の要素情報
  const [internalDrag, setInternalDrag] = useState<{ id: string; type: DisplayElementType; offsetCol: number } | null>(null)
  // 内部移動時の最後の有効位置
  const [lastValidPos, setLastValidPos] = useState<{ col: number; row: number } | null>(null)

  /** ドラッグ中の要素タイプ（パレット or 内部移動） */
  const dragType = externalDragType ?? internalDrag?.type ?? null
  const dragOffsetCol = internalDrag?.offsetCol ?? 0

  /** ドラッグ中の variant — 内部移動ならその要素の variant、
   *  パレットからのドラッグなら setCurrentDragVariant() で設定された値。
   *  variant 込みで size 計算しないと battery 'bar' (8 文字) などで
   *  影と実サイズがずれる。 */
  const dragVariant = useMemo(() => {
    if (internalDrag && activePage) {
      return activePage.elements.find((e) => e.id === internalDrag.id)?.variant
    }
    return externalDragType ? getCurrentDragVariant() : undefined
    // externalDragType を依存に入れることで「パレットから新たに drag 開始
    // → variant が更新された」タイミングで再計算される。
  }, [internalDrag, activePage, externalDragType])

  /** マウス位置をクランプした配置候補 */
  const clampedDragPos = useMemo(() => {
    if (!dragType || !dragPos) return null
    const size = getElementSize(dragType, dragVariant)
    return {
      col: Math.max(0, Math.min(dragPos.col - dragOffsetCol, GRID_COLS - size[0])),
      row: Math.max(0, Math.min(dragPos.row, GRID_ROWS - size[1])),
    }
  }, [dragType, dragVariant, dragPos, dragOffsetCol])

  const dragCanPlace = useMemo(() => {
    if (!clampedDragPos || !activePage) return false
    return canPlace(
      activePage, dragType!,
      [clampedDragPos.col, clampedDragPos.row],
      internalDrag?.id, dragVariant,
    )
  }, [clampedDragPos, activePage, dragType, internalDrag, dragVariant])

  // 内部ドラッグ時: 配置可能な位置を記録
  useEffect(() => {
    if (internalDrag && clampedDragPos && dragCanPlace) {
      setLastValidPos(clampedDragPos)
    }
  }, [internalDrag, clampedDragPos, dragCanPlace])

  /** ドラッグ中のプレビュー影 */
  const dragPreview = useMemo(() => {
    if (!dragType) return null
    // variant を考慮したサイズ。battery 'bar' / app_name 各 variant で
    // ELEMENT_FIXED_SIZES とは異なる幅になる。
    const size = getElementSize(dragType, dragVariant)
    if (internalDrag) {
      // 内部移動: 配置可能ならその位置、不可なら最後の有効位置にとどまる
      const pos = dragCanPlace ? clampedDragPos : lastValidPos
      if (!pos) return null
      return { col: pos.col, row: pos.row, w: size[0], h: size[1], canPlace: true }
    }
    // パレットからのドラッグ
    if (!clampedDragPos) return null
    return { col: clampedDragPos.col, row: clampedDragPos.row, w: size[0], h: size[1], canPlace: dragCanPlace }
  }, [dragType, dragVariant, internalDrag, clampedDragPos, dragCanPlace, lastValidPos])

  // 内部移動: mouse イベントで追跡（HTML5 drag を使わないのでカーソルが安定）
  const lastValidPosRef = useRef(lastValidPos)
  lastValidPosRef.current = lastValidPos
  useEffect(() => {
    if (!internalDrag) return
    document.body.classList.add('is-dragging')
    const onMove = (e: MouseEvent) => {
      if (!oledRef.current) return
      const rect = oledRef.current.getBoundingClientRect()
      const rawCol = Math.floor((e.clientX - rect.left - BORDER_W) / CELL_W)
      const rawRow = Math.floor((e.clientY - rect.top - BORDER_W) / CELL_H)
      const col = Math.max(0, Math.min(rawCol, GRID_COLS - 1))
      const row = Math.max(0, Math.min(rawRow, GRID_ROWS - 1))
      setDragPos((prev) => (prev?.col === col && prev?.row === row) ? prev : { col, row })
    }
    const onUp = () => {
      document.body.classList.remove('is-dragging')
      const pos = lastValidPosRef.current
      if (pos) handleMoveElement(internalDrag.id, [pos.col, pos.row])
      setDragPos(null)
      setInternalDrag(null)
      setLastValidPos(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('is-dragging')
    }
  }, [internalDrag, handleMoveElement])

  // HTML5 drag ハンドラは不要（全て mouse ベースに移行済み）

  // 既存のページ名 (例: 'main' / 'exhibit' / 'debug') を保護したいので、
  // 旧 renamePages (= 全ページを `Page N` で書き換え) は撤去。
  // 新規追加ページのデフォルト名のみ衝突しない `Page N` を当てる。
  const nextDefaultPageName = (existing: DisplayPage[]): string => {
    const names = new Set(existing.map((p) => p.name))
    for (let n = existing.length + 1; ; n++) {
      const candidate = `Page ${n}`
      if (!names.has(candidate)) return candidate
    }
  }

  const handleAddPage = useCallback(() => {
    setLayout((prev) => ({
      ...prev,
      pages: [...prev.pages, { name: nextDefaultPageName(prev.pages), elements: [] }],
    }))
    setActivePageIndex(layout.pages.length)
  }, [layout.pages.length])

  /** ページ名を rename。空文字 / 全角空白だけは弾いて元の名前を維持。 */
  const handleRenamePage = useCallback((index: number, rawName: string) => {
    const trimmed = rawName.replace(/　/g, ' ').trim()
    if (trimmed.length === 0) return  // 空入力は無視 (= キャンセル相当)
    setLayout((prev) => {
      if (index < 0 || index >= prev.pages.length) return prev
      if (prev.pages[index].name === trimmed) return prev  // 変化なし
      return {
        ...prev,
        pages: prev.pages.map((p, i) => i === index ? { ...p, name: trimmed } : p),
      }
    })
  }, [])

  const handleDeletePage = useCallback(
    (index: number) => {
      if (layout.pages.length <= 1) return
      // ページ名は保持 (= 削除位置以外のページの name は触らない)。
      setLayout((prev) => ({
        ...prev,
        pages: prev.pages.filter((_, i) => i !== index),
      }))
      if (activePageIndex >= layout.pages.length - 1) {
        setActivePageIndex(Math.max(0, layout.pages.length - 2))
      }
    },
    [layout.pages.length, activePageIndex]
  )

  /** 工場出荷状態に戻す: 現アクティブモデルの **全 state** を初期値に戻す。
   *
   *  対象 (2026-05-09 ユーザ要望):
   *    - 現モデルの OLED ページレイアウト (= INITIAL layout)
   *    - per-button actions (Duo 5 + Band 3 を `INITIAL_PER_BUTTON_ACTIONS` で
   *      丸ごと置換 → 旧版で hold が 'none' になっていたケースが解消)
   *    - LED / volume / UI 設定 (グローバル全体: モデル別ではない)
   *
   *  もう一方のモデルの **layout は touch しない** (Duo を init しても Band
   *  の編集状態は保護)。LED/volume/UI はグローバルなのでリセット対象に含む。
   */
  const handleResetToDefault = useCallback(async () => {
    const ok = await askConfirm({
      title: '初期状態に戻す',
      message:
        '現在のモデル (' + (deviceModel === 'duo_wl' ? 'Duo' : 'Band')
        + ') のページ + ボタン + LED + Volume + UI 設定が初期値に置き換わります。\n'
        + 'もう一方のモデルのレイアウトは触りません。続行しますか？',
      confirmLabel: '初期化する',
      cancelLabel: 'キャンセル',
      danger: true,
    })
    if (!ok) return
    const template = deviceModel === 'duo_wl' ? duoStandardTemplate : bandStandardTemplate
    setLayout(structuredClone(template.layout))
    setPerButtonActions(structuredClone(INITIAL_PER_BUTTON_ACTIONS))
    setLedConfig(structuredClone(INITIAL_LED_CONFIG))
    setVolumeConfig({ ...INITIAL_VOLUME_CONFIG })
    setUiSettings({ ...INITIAL_UI_SETTINGS })
    setActivePageIndex(0)
    setPopupPos(null)
  }, [askConfirm, deviceModel])

  // 現アクティブモデルに紐づく preset 一覧 (Duo: main/exhibit/debug/empty,
  // Band: main/debug/empty)。Insert preset メニューと handleInsertPagePreset
  // の index 解決に使う。
  const activePresets = useMemo(() => getPagePresetsFor(deviceModel), [deviceModel])

  const handleInsertPagePreset = useCallback((presetIndex: number) => {
    const preset = activePresets[presetIndex]
    if (!preset) return
    setLayout((prev) => {
      // preset の name (= 'main' / 'exhibit' / 'debug' / 'empty') をそのまま採用。
      // 既に同名ページが存在する場合は `name (2)` で suffix。
      const usedNames = new Set(prev.pages.map((p) => p.name))
      let pageName = preset.page.name
      let dup = 2
      while (usedNames.has(pageName)) {
        pageName = `${preset.page.name} (${dup++})`
      }
      const inserted: DisplayPage = {
        name: pageName,
        elements: structuredClone(preset.page.elements),
      }
      return { ...prev, pages: [...prev.pages, inserted] }
    })
    setActivePageIndex(layout.pages.length)
    setPopupPos(null)
  }, [layout.pages.length, activePresets])

  // --- Helper 接続 ---
  const { isConnected: managerConnected, lastMessage, send: managerSend, devices } = useHelperConnection()
  const { toast, setAnchor: setToastAnchor } = useToast()
  const [isDeploying, setIsDeploying] = useState(false)
  // Per-target deploy progress sourced from Helper's `write_progress` push.
  // null = aggregate state collapsed (no active deploy or finished long enough ago).
  // 単一ターゲット時はインデターミネートバー、複数時は IP ごとに状態行を表示。
  type DeployTargetState = { phase: 'sending' | 'done' | 'failed'; message?: string }
  const [deployProgress, setDeployProgress] = useState<{
    total: number
    targets: Record<string, DeployTargetState>
  } | null>(null)
  // Serial-only selection → deploy button disabled (write_ui_config is
  // TCP-only; Serial path is not implemented in firmware serial_config.cpp)
  const selectedIps = useDeviceStore((s) => s.selectedIps)
  const selectedIp = useDeviceStore((s) => s.selectedIp)
  const effectiveTargets = selectedIps.length > 0 ? selectedIps : (selectedIp ? [selectedIp] : [])
  const isSerialOnlySelected =
    effectiveTargets.length > 0 && effectiveTargets.every((ip) => ip.startsWith('serial:'))
  const deployBtnRef = useCallback((el: HTMLButtonElement | null) => {
    setToastAnchor(el)
  }, [setToastAnchor])

  // Display 自身の deploy だけ拾うため cmd で filter する。
  // 失敗の汎用 toast は HelperToastBridge (App.tsx 直下) が出すので
  // ここでは Display 専用の "書き込みました" / "選択なし" 系に絞る。
  useEffect(() => {
    if (!lastMessage) return
    // ----- Per-target progress (write_progress) -----
    if (lastMessage.type === 'write_progress') {
      const cmd = lastMessage.payload?.cmd
      if (cmd !== 'write_ui_config') return
      const ip = lastMessage.payload.ip as string
      const total = (lastMessage.payload.total as number) ?? 1
      const phase = lastMessage.payload.phase as DeployTargetState['phase']
      const message = lastMessage.payload.message as string | undefined
      setDeployProgress((prev) => {
        const targets = { ...(prev?.targets ?? {}), [ip]: { phase, message } }
        return { total, targets }
      })
      return
    }
    // ----- Final result (write_result) -----
    if (lastMessage.type !== 'write_result') return
    const cmd = lastMessage.payload?.cmd
    if (cmd !== 'write_ui_config') return
    setIsDeploying(false)
    // 成否確定後、進捗 UI を 1.5s 残してから消す (ユーザーに最終状態を見せる)。
    const fadeOut = window.setTimeout(() => setDeployProgress(null), 1500)
    void fadeOut
    const success = lastMessage.payload.success as boolean
    const deviceConfirmed = lastMessage.payload.device_confirmed as boolean | undefined
    const reason = (lastMessage.payload.error ?? lastMessage.payload.message ?? '') as string
    if (!success && reason.includes('no_device')) {
      toast('デバイスが選択されていません', 'warning')
    } else if (success) {
      if (deviceConfirmed) {
        toast('デバイスに書き込みました', 'success')
      } else {
        toast('Helper に送信しました', 'info')
      }
    }
    // 失敗時は HelperToastBridge が cmd / message を入れた error toast を出すので、
    // ここで重複表示しない。
  }, [lastMessage, toast])

  // --- エクスポート / インポート / デバイス書き込み ---

  const buildSavedState = useCallback((): DisplaySavedState => ({
    layoutByModel, deviceModel, orientationByModel, perButtonActions, simState, ledConfig, volumeConfig, uiSettings,
  }), [layoutByModel, deviceModel, orientationByModel, perButtonActions, simState, ledConfig, volumeConfig, uiSettings])

  const handleDeploy = useCallback(() => {
    if (!managerConnected) {
      toast('Hapbeat Manager を起動してください', 'error')
      return
    }
    // Honor the Devices tab's selection so Display deploys to only
    // the checked device(s) — not every Hapbeat on the LAN. The
    // user explicitly flagged this (2026-04-30) because Display's
    // previous behavior of broadcasting to all devices made multi-
    // device studios dangerous to edit. Empty selection → toast +
    // abort rather than fall back to broadcast.
    const { selectedIps, selectedIp } = useDeviceStore.getState()
    const rawTargets = selectedIps.length > 0
      ? selectedIps
      : (selectedIp ? [selectedIp] : [])
    if (rawTargets.length === 0) {
      toast('Devices タブで対象デバイスを選択してください', 'error')
      return
    }
    // Drop serial: IPs silently (Display deploy は TCP 7701 専用、
    // Serial 経路は firmware の serial_config.cpp に write_ui_config が
    // 未実装)。Serial-only 選択時だけ案内 toast。
    const lanTargets = rawTargets.filter((ip) => !ip.startsWith('serial:'))
    if (lanTargets.length === 0) {
      toast('Serial 接続では Display 書込みは未対応 — Wi-Fi に乗せてから再試行してください', 'error')
      return
    }
    // Helper の現在のデバイス一覧と突き合わせて、オンラインの IP だけを
    // 残す。永続化された stale 選択や、helper が dismiss 済の古い IP を
    // 抱えていてもここで確実に弾ける (deploy 進捗 UI が "2 台" 出る等の
    // ゴーストを防止)。
    const onlineSet = new Set(devices.filter((d) => d.online).map((d) => d.ipAddress))
    const targets = lanTargets.filter((ip) => onlineSet.has(ip))
    if (targets.length === 0) {
      toast('選択中のデバイスが現在オフラインです', 'error')
      return
    }
    if (targets.length < lanTargets.length) {
      // 黙って弾くと "選択した数 != 進捗バーの台数" になって不可解なので
      // 簡潔にログだけ残す (toast は出さない — 失敗ではないため)。
      // eslint-disable-next-line no-console
      console.info(
        `[deploy] dropped ${lanTargets.length - targets.length} offline target(s):`,
        lanTargets.filter((ip) => !onlineSet.has(ip)),
      )
    }
    setIsDeploying(true)
    // Pre-seed progress so the UI shows immediately ("sending" for each
    // target). Helper's per-target `write_progress` will overwrite the
    // phase as each one completes.
    setDeployProgress({
      total: targets.length,
      targets: Object.fromEntries(targets.map((ip) => [ip, { phase: 'sending' }])),
    })
    const uiConfig = toFirmwareFormat(buildSavedState())
    // Helper's `_resolve_targets` looks for `payload.targets` (array)
    // before falling back to `payload.ip` (single) and finally a
    // broadcast. Passing `targets` matches Studio's multi-select
    // behavior precisely; the broadcast fallback is exactly what the
    // user wanted to stop.
    managerSend({
      type: 'write_ui_config',
      payload: { config: uiConfig, targets },
    })
  }, [managerConnected, managerSend, buildSavedState, toast, devices])

  const handleExport = useCallback(() => {
    exportDisplayLayout(buildSavedState())
    toast('ui-config.json をダウンロードしました', 'success')
  }, [buildSavedState, toast])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImport = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importDisplayLayout(file)
      // firmware は単一機種ぶんの ui-config しか持たないので、import は
      // その deviceModel のレイアウトスロットだけを上書きする = もう一方の
      // モデルの編集状態は保護される。deviceModel 自体も切替えるので、
      // ユーザは import 直後にそのモデルの新レイアウトを見ることになる。
      const importedModel: DeviceModel = imported.deviceModel ?? deviceModel
      if (imported.layout) {
        setLayoutByModel((prev) => ({ ...prev, [importedModel]: imported.layout! }))
      }
      if (imported.deviceModel) setDeviceModel(imported.deviceModel)
      // Import 由来は **その deviceModel の orientation のみ** を上書きし、
      // もう一方のモデルの設定は触らない (= ユーザーが両モデル別個に
      // 編集していた状態を保護)。
      if (imported.orientationByModel) {
        setOrientationByModel((prev) => ({ ...prev, ...imported.orientationByModel }))
      }
      if (imported.perButtonActions) setPerButtonActions(imported.perButtonActions)
      if (imported.ledConfig) setLedConfig(imported.ledConfig)
      if (imported.volumeConfig) setVolumeConfig(imported.volumeConfig)
      if (imported.uiSettings) setUiSettings(imported.uiSettings)
      setActivePageIndex(0)
      setPopupPos(null)
      toast('レイアウトを読み込みました', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'インポートに失敗しました', 'error')
    }
    e.target.value = ''
  }, [deviceModel])

  const handlePerButtonActionChange = useCallback(
    (buttonId: string, field: keyof SingleButtonAction, value: ButtonActionType) => {
      setPerButtonActions((prev) => ({
        ...prev,
        [buttonId]: { ...(prev[buttonId] ?? DEFAULT_BUTTON_ACTION), [field]: value },
      }))
    },
    []
  )

  // ボタンシミュレーション — short_press をクリックで実行
  const holdReturnPageRef = useRef<number | null>(null)

  const handleSimButtonClick = useCallback(
    (buttonId: string) => {
      // Tmp hold が発火中なら click（short_press）を抑制
      if (holdActiveRef.current) return
      const action = perButtonActions[buttonId]?.short_press as string
      if (!action || action === 'none') return
      const n = layout.pages.length
      if (action === 'toggle_page' && n > 1) { setActivePageIndex((p) => (p + 1) % n); return }
      if (action === 'next_page' && n > 1) { setActivePageIndex((p) => Math.min(p + 1, n - 1)); return }
      if (action === 'prev_page' && n > 1) { setActivePageIndex((p) => Math.max(p - 1, 0)); return }
      if (action.startsWith('goto_page:')) {
        const idx = parseInt(action.split(':')[1], 10)
        if (!isNaN(idx) && idx >= 0 && idx < n) setActivePageIndex(idx)
        return
      }
      switch (action) {
        case 'player_inc': setSimState((s) => ({ ...s, player: s.player + 1 })); break
        case 'player_dec': setSimState((s) => ({ ...s, player: Math.max(0, s.player - 1) })); break
        case 'group_inc': setSimState((s) => ({ ...s, group: s.group + 1 })); break
        case 'group_dec': setSimState((s) => ({ ...s, group: Math.max(0, s.group - 1) })); break
        case 'vib_mode': setSimState((s) => ({ ...s, volumeAdcEnabled: !s.volumeAdcEnabled })); break
        case 'wifi_select': break // Wi-Fi 選択モード遷移はファーム側で OLED が固定描画する。Studio のプレビューでは表現しない
      }
    },
    [perButtonActions, layout.pages.length]
  )

  // 押し続けシミュレーション
  // holdActiveRef: Tmp hold が発火中かどうか（click 抑制に使用）
  const holdActiveRef = useRef(false)

  const handleSimButtonDown = useCallback(
    (buttonId: string) => {
      const btnAction = perButtonActions[buttonId]
      // Tmp/Exec で別フィールドに保存されているので getActiveHoldAction で
      // mode に応じた値を取り出す。
      const holdAction = getActiveHoldAction(btnAction) as string
      if (!holdAction || holdAction === 'none') return
      const holdMode = btnAction?.hold_mode ?? 'momentary'
      const n = layout.pages.length

      if (holdMode === 'momentary') {
        // Tmp: 押している間だけ
        holdActiveRef.current = true
        if (holdAction.startsWith('hold_page:') || holdAction.startsWith('goto_page:')) {
          const idx = parseInt(holdAction.split(':')[1], 10)
          if (isNaN(idx) || idx < 0 || idx >= n || idx === activePageIndex) return
          holdReturnPageRef.current = activePageIndex
          setActivePageIndex(idx)
        }
        // display_toggle: ファーム側で処理、UI シミュレーションは省略
        return
      }

      // Exec: Press と同じ（離しても戻らない）
      if (holdAction === 'toggle_page' && n > 1) { setActivePageIndex((p) => (p + 1) % n); return }
      if (holdAction === 'next_page' && n > 1) { setActivePageIndex((p) => Math.min(p + 1, n - 1)); return }
      if (holdAction === 'prev_page' && n > 1) { setActivePageIndex((p) => Math.max(p - 1, 0)); return }
      if (holdAction.startsWith('goto_page:')) {
        const idx = parseInt(holdAction.split(':')[1], 10)
        if (!isNaN(idx) && idx >= 0 && idx < n) setActivePageIndex(idx)
        return
      }
      switch (holdAction) {
        case 'player_inc': setSimState((s) => ({ ...s, player: s.player + 1 })); break
        case 'player_dec': setSimState((s) => ({ ...s, player: Math.max(0, s.player - 1) })); break
        case 'group_inc': setSimState((s) => ({ ...s, group: s.group + 1 })); break
        case 'group_dec': setSimState((s) => ({ ...s, group: Math.max(0, s.group - 1) })); break
        case 'vib_mode': setSimState((s) => ({ ...s, volumeAdcEnabled: !s.volumeAdcEnabled })); break
        case 'wifi_select': break // Wi-Fi 選択モード遷移はファーム側で OLED が固定描画する。Studio のプレビューでは表現しない
      }
    },
    [perButtonActions, layout.pages.length, activePageIndex]
  )

  const handleSimButtonUp = useCallback(() => {
    // Tmp: ページを戻す
    if (holdReturnPageRef.current !== null) {
      setActivePageIndex(holdReturnPageRef.current)
      holdReturnPageRef.current = null
    }
    // Tmp: hold が発火していた場合、click を抑制するためリセットを遅延
    if (holdActiveRef.current) {
      // holdActiveRef は click 抑制後にリセット（setTimeout で click より後に）
      setTimeout(() => { holdActiveRef.current = false }, 0)
    }
  }, [])

  // --- レンダリング ---

  return (
    <div className="display-editor">
      {/* 上部固定エリア: シミュレータ + コントロールバー */}
      <div className="fixed-top-area">
        <OledSimulator
          deviceSpec={deviceSpec}
          isFlipped={isFlipped}
          oledRef={oledRef}
          gridRows={gridRows}
          activePage={activePage}
          popupPos={popupPos}
          usedTypes={usedTypes}
          onOledClick={handleOledClick}
          dragPreview={dragPreview}
          onInternalDragStart={(id, type, offsetCol) => {
            setInternalDrag({ id, type, offsetCol })
            const el = activePage?.elements.find((e) => e.id === id)
            if (el) setLastValidPos({ col: el.pos[0], row: el.pos[1] })
          }}
          onDeleteElement={handleDeleteElement}
          onPopupSelect={handlePopupSelect}
          onPopupClose={() => setPopupPos(null)}
          onSimButtonClick={handleSimButtonClick}
          onSimButtonDown={handleSimButtonDown}
          onSimButtonUp={handleSimButtonUp}
          pages={layout.pages}
          perButtonActions={perButtonActions}
          onActionChange={handlePerButtonActionChange}
          onLedClick={() => setLedModalOpen(true)}
          onVolumeClick={() => setVolumeModalOpen(true)}
          onUiSettingsClick={() => setUiSettingsModalOpen(true)}
        />
        <ControlBar
          pages={layout.pages}
          activePageIndex={activePageIndex}
          deviceModel={deviceModel}
          isFlipped={isFlipped}
          onPageChange={(idx) => { setActivePageIndex(idx); setPopupPos(null) }}
          onAddPage={handleAddPage}
          onDeletePage={handleDeletePage}
          onRenamePage={handleRenamePage}
          onInsertPagePreset={handleInsertPagePreset}
          onDeviceModelChange={handleDeviceModelChange}
          onResetToDefault={handleResetToDefault}
          onToggleOrientation={() => setOrientationByModel((prev) => ({
            ...prev,
            [deviceModel]: prev[deviceModel] === 'flipped' ? 'normal' : 'flipped',
          }))}
          onExport={handleExport}
          onImport={() => fileInputRef.current?.click()}
          onDeploy={handleDeploy}
          managerConnected={managerConnected}
          isDeploying={isDeploying}
          isSerialOnlySelected={isSerialOnlySelected}
          deployBtnRef={deployBtnRef}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleImport}
        />
        {deployProgress && (
          <DeployProgressBar
            total={deployProgress.total}
            targets={deployProgress.targets}
          />
        )}
      </div>

      {/* トースト警告 */}
      {dropHint && (
        <div className="drop-toast" style={{ left: dropHint.x, top: dropHint.y }}>
          {dropHint.msg}
        </div>
      )}

      {/* 3. パレット */}
      <ElementPalette selectedType={null} onSelectType={() => {}} usedTypes={usedTypes} />

      {/* LED 設定モーダル */}
      {ledModalOpen && (
        <LedConfigModal
          ledConfig={ledConfig}
          onLedChange={setLedConfig}
          onClose={() => setLedModalOpen(false)}
        />
      )}

      {/* Volume 設定モーダル */}
      {volumeModalOpen && (
        <VolumeConfigModal
          volumeConfig={volumeConfig}
          onVolumeChange={setVolumeConfig}
          onClose={() => setVolumeModalOpen(false)}
        />
      )}

      {/* UI 設定モーダル (OLED 輝度 / Hold 時間) */}
      {uiSettingsModalOpen && (
        <UiSettingsModal
          uiSettings={uiSettings}
          onUiSettingsChange={setUiSettings}
          managerSend={managerSend}
          onClose={() => setUiSettingsModalOpen(false)}
        />
      )}

      {/* 共通 confirm ダイアログ (window.confirm 置換) */}
      {confirmDialog}
    </div>
  )
}

// ========================================
// OledSimulator
// ========================================

interface OledSimulatorProps {
  deviceSpec: DeviceHardwareSpec
  isFlipped: boolean
  oledRef: React.RefObject<HTMLDivElement>
  gridRows: GridItem[][]
  activePage: DisplayPage | undefined
  popupPos: { col: number; row: number; x: number; y: number; screenX: number; screenY: number } | null
  usedTypes: Set<DisplayElementType>
  onOledClick: (e: React.MouseEvent<HTMLDivElement>) => void
  dragPreview: { col: number; row: number; w: number; h: number; canPlace: boolean } | null
  onInternalDragStart: (id: string, type: DisplayElementType, offsetCol: number) => void
  onDeleteElement: (id: string) => void
  onPopupSelect: (type: DisplayElementType) => void
  onPopupClose: () => void
  onSimButtonClick: (buttonId: string) => void
  onSimButtonDown: (buttonId: string) => void
  onSimButtonUp: () => void
  pages: DisplayPage[]
  perButtonActions: PerButtonActions
  onActionChange: (buttonId: string, field: keyof SingleButtonAction, value: ButtonActionType) => void
  onLedClick: () => void
  onVolumeClick: () => void
  onUiSettingsClick: () => void
}

function OledSimulator({
  deviceSpec, isFlipped, oledRef, gridRows, activePage,
  popupPos, usedTypes,
  onOledClick,
  dragPreview, onInternalDragStart,
  onDeleteElement, onPopupSelect, onPopupClose, onSimButtonClick, onSimButtonDown, onSimButtonUp,
  pages, perButtonActions, onActionChange, onLedClick, onVolumeClick, onUiSettingsClick,
}: OledSimulatorProps) {
  // ボタンをグリッドエリアに振り分け
  const leftBtns = deviceSpec.model === 'duo_wl'
    ? deviceSpec.buttons.filter((b) => ['btn_1', 'btn_2', 'btn_3'].includes(b.id))
    : deviceSpec.buttons
  const rightBtns = deviceSpec.model === 'duo_wl'
    ? deviceSpec.buttons.filter((b) => ['btn_4', 'btn_5'].includes(b.id))
    : []

  const actionGroups = buildActionGroups(pages, deviceSpec.model)

  const renderButton = (btn: typeof deviceSpec.buttons[0]) => {
    const act = perButtonActions[btn.id] ?? DEFAULT_BUTTON_ACTION
    const btnHoldMode = act.hold_mode ?? 'momentary'
    const holdGroups = buildHoldActionGroups(pages, btnHoldMode, deviceSpec.model)
    const allItems = [...actionGroups, ...holdGroups].flatMap((g) => g.items)
    return (
      <div key={btn.id} className="device-button-row">
        <div
          className="device-button-dot-wrap"
          title={btn.label}
          onClick={() => onSimButtonClick(btn.id)}
          onMouseDown={() => onSimButtonDown(btn.id)}
          onMouseUp={onSimButtonUp}
          onMouseLeave={onSimButtonUp}
        >
          <div className="device-button-dot" />
          <span className="device-button-label">{btn.label}</span>
        </div>
        <InlineButtonConfig
          action={act} allItems={allItems}
          actionGroups={actionGroups} holdGroups={holdGroups}
          btnId={btn.id} onActionChange={onActionChange}
        />
      </div>
    )
  }

  return (
    <div className="hardware-preview-sticky">
      <div className={`device-grid-container ${deviceSpec.model === 'band_wl' ? 'is-band-wl' : ''} ${isFlipped ? 'is-flipped' : ''}`}>
        {/* OLED — grid-area: oled */}
        <div className="device-grid-oled">
          <div style={{ position: 'relative' }}>
            <div
              ref={oledRef}
              className="oled-screen"
              style={{ width: GRID_WIDTH, height: GRID_HEIGHT }}
              onClick={onOledClick}
            >
              <div className="char-grid">
                {gridRows.map((row, rowIdx) =>
                  row.map((item) => {
                    if (item.kind === 'empty') {
                      return <div key={`${rowIdx}-${item.col}`} className="char-cell empty" />
                    }
                    const meta = getElementMeta(item.el.type, item.el.variant)
                    return (
                      <div
                        key={item.el.id}
                        className="grid-element"
                        style={{ gridColumn: `span ${item.span}` }}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return
                          e.preventDefault()
                          const cardRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const offsetCol = Math.floor((e.clientX - cardRect.left) / CELL_W)
                          onInternalDragStart(item.el.id, item.el.type, offsetCol)
                        }}
                        onClick={(e) => e.stopPropagation()}
                        title={meta?.label ?? item.el.type}
                      >
                        <span className="grid-element-name">{meta?.label ?? item.el.type}</span>
                        <div className="grid-element-chars">
                          {item.text.split('').map((ch, ci) => (
                            <span key={ci} className="char-text">{ch}</span>
                          ))}
                        </div>
                        <button
                          className="grid-element-delete"
                          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
                          onClick={(e) => { e.stopPropagation(); onDeleteElement(item.el.id) }}
                          title="削除"
                        >×</button>
                      </div>
                    )
                  })
                )}
              </div>

              {dragPreview && (
                <div
                  className={`drag-preview-shadow ${dragPreview.canPlace ? '' : 'invalid'}`}
                  style={{
                    left: dragPreview.col * CELL_W, top: dragPreview.row * CELL_H,
                    width: dragPreview.w * CELL_W, height: dragPreview.h * CELL_H,
                  }}
                />
              )}
              {popupPos && (
                <div
                  className="placeholder-cell"
                  style={{ left: popupPos.x, top: popupPos.y, width: CELL_W, height: CELL_H }}
                />
              )}
            </div>
            {popupPos && (
              <PopupPalette
                screenX={popupPos.screenX} screenY={popupPos.screenY}
                gridCol={popupPos.col} gridRow={popupPos.row}
                page={activePage} usedTypes={usedTypes}
                onSelect={onPopupSelect} onClose={onPopupClose}
              />
            )}
          </div>
        </div>

        {/* 左ボタン列 — grid-area: btn1, btn2, btn3 */}
        {leftBtns.map((btn, i) => (
          <div key={btn.id} className={`device-grid-btn btn-l${i + 1}`}>
            {renderButton(btn)}
          </div>
        ))}

        {/* 右ボタン列 — grid-area: btn4, btn5 */}
        {rightBtns.map((btn, i) => (
          <div key={btn.id} className={`device-grid-btn btn-r${i + 1}`}>
            {renderButton(btn)}
          </div>
        ))}

        {/* Volume 設定 — grid-area: vol */}
        <div className="device-grid-vol" onClick={onVolumeClick}>
          <svg className="device-config-vol-icon" viewBox="0 0 16 14" width="14" height="12">
            <polygon points="0,5 0,9 4,9 8,13 8,1 4,5" fill="currentColor" />
            <path d="M10,4 Q13,7 10,10" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12,2 Q16,7 12,12" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <span className="device-config-label">Volume 設定</span>
        </div>

        {/* LED 設定 — grid-area: led */}
        <div className="device-grid-led" onClick={onLedClick}>
          <div className="device-abs-led" />
          <span className="device-config-label">LED 設定</span>
        </div>

        {/* UI 設定 (OLED 輝度 / Hold 時間) — grid-area: ui */}
        <div className="device-grid-ui" onClick={onUiSettingsClick} title="OLED 輝度・Hold 時間">
          <svg className="device-config-ui-icon" viewBox="0 0 16 14" width="14" height="12">
            <circle cx="8" cy="7" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <line x1="8" y1="1" x2="8" y2="3" />
              <line x1="8" y1="11" x2="8" y2="13" />
              <line x1="1" y1="7" x2="3" y2="7" />
              <line x1="13" y1="7" x2="15" y2="7" />
              <line x1="2.8" y1="1.8" x2="4.2" y2="3.2" />
              <line x1="11.8" y1="10.8" x2="13.2" y2="12.2" />
              <line x1="2.8" y1="12.2" x2="4.2" y2="10.8" />
              <line x1="11.8" y1="3.2" x2="13.2" y2="1.8" />
            </g>
          </svg>
          <span className="device-config-label">UI 設定</span>
        </div>
      </div>
    </div>
  )
}

// ========================================
// PopupPalette — OLED クリック時のミニパレット（衝突チェック付き）
// ========================================

interface PopupPaletteProps {
  screenX: number; screenY: number
  gridCol: number; gridRow: number
  page: DisplayPage | undefined
  usedTypes: Set<DisplayElementType>
  onSelect: (type: DisplayElementType) => void
  onClose: () => void
}

function PopupPalette({ screenX, screenY, gridCol, gridRow, page, usedTypes, onSelect, onClose }: PopupPaletteProps) {
  const popupW = 400
  const clampedX = screenX + popupW > window.innerWidth ? window.innerWidth - popupW - 8 : screenX
  return createPortal(
    <>
      <div className="portal-overlay" onClick={onClose} />
      <div className="portal-dropdown popup-palette-content" style={{ left: clampedX, top: screenY }}>
        {PALETTE_SECTIONS.map((sec, sIdx) => (
          <div
            key={sec.title}
            className={`popup-palette-section ${sIdx > 0 ? 'has-divider' : ''}`}
            title={`${sec.title} — ${sec.hint}`}
          >
            {sec.items.map((item) => {
              const used = usedTypes.has(item.type)
              const noSpace = page ? !canPlace(page, item.type, [gridCol, gridRow], undefined, item.variant) : true
              const disabled = used || noSpace
              const key = `${item.type}:${item.variant ?? '-'}`
              return (
                <button
                  key={key}
                  className={`popup-palette-item ${used ? 'used' : ''} ${noSpace && !used ? 'no-space' : ''}`}
                  disabled={disabled}
                  onClick={() => onSelect(item.type)}
                  title={used ? '使用中' : noSpace ? 'スペースが不足しています' : item.label}
                >
                  <span className="popup-palette-icon">{item.icon}</span>
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </>,
    document.body
  )
}

// ========================================
// ControlBar (sticky)
// ========================================

interface ControlBarProps {
  pages: DisplayPage[]
  activePageIndex: number
  deviceModel: DeviceModel
  isFlipped: boolean
  onPageChange: (idx: number) => void
  onAddPage: () => void
  onDeletePage: (idx: number) => void
  onRenamePage: (idx: number, newName: string) => void
  onInsertPagePreset: (idx: number) => void
  onDeviceModelChange: (model: DeviceModel) => void
  onResetToDefault: () => void
  onToggleOrientation: () => void
  onExport: () => void
  onImport: () => void
  onDeploy: () => void
  managerConnected: boolean
  isDeploying: boolean
  isSerialOnlySelected: boolean
  deployBtnRef?: (el: HTMLButtonElement | null) => void
}

function ControlBar({
  pages, activePageIndex, deviceModel, isFlipped,
  onPageChange, onAddPage, onDeletePage, onRenamePage, onInsertPagePreset,
  onDeviceModelChange, onResetToDefault, onToggleOrientation,
  onExport, onImport, onDeploy, managerConnected, isDeploying, isSerialOnlySelected, deployBtnRef,
}: ControlBarProps) {
  // ページ名のインライン編集状態。null = 編集中なし、{idx, draft} = idx 番目を
  // 編集中で draft が現在の入力中文字列。double-click でモード突入、Enter or
  // blur で commit、Escape で cancel。
  const [renaming, setRenaming] = useState<{ idx: number; draft: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renaming])

  const commitRename = () => {
    if (!renaming) return
    onRenamePage(renaming.idx, renaming.draft)
    setRenaming(null)
  }
  const cancelRename = () => setRenaming(null)

  return (
    <div className="editor-control-bar">
      <div className="page-tabs">
        {pages.map((page, idx) => (
          <div key={idx} className="page-tab-wrapper">
            {renaming?.idx === idx ? (
              <input
                ref={renameInputRef}
                className="page-tab page-tab-rename-input"
                value={renaming.draft}
                onChange={(e) => setRenaming({ idx, draft: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                }}
                maxLength={32}
                title="Enter で確定、Esc でキャンセル"
              />
            ) : (
              <button
                className={`page-tab ${idx === activePageIndex ? 'active' : ''}`}
                onClick={() => onPageChange(idx)}
                onDoubleClick={() => setRenaming({ idx, draft: page.name })}
                title="ダブルクリックで rename"
              >{page.name}</button>
            )}
            {pages.length > 1 && renaming?.idx !== idx && (
              <button className="page-tab-delete" onClick={() => onDeletePage(idx)}>x</button>
            )}
          </div>
        ))}
        <button className="btn btn-sm" onClick={onAddPage} title="空ページを追加">+ Page</button>
        <select
          className="select select-sm preset-select"
          defaultValue=""
          title="プリセットからページを追加"
          onChange={(e) => {
            const i = parseInt(e.target.value, 10)
            if (!isNaN(i)) onInsertPagePreset(i)
            e.target.value = ''
          }}
        >
          <option value="" disabled>プリセット…</option>
          {/* preset リストは deviceModel に応じて切替 (Duo: main/exhibit/debug/empty,
              Band: main/debug/empty)。handleInsertPagePreset 側も同じ
              `getPagePresetsFor(deviceModel)` で index 解決するため整合する。 */}
          {getPagePresetsFor(deviceModel).map((p, idx) => (
            <option key={p.name} value={idx} title={p.description}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="control-separator" />
      {(() => {
        // 単一トグル: 現在のモデルを表示し、クリックで次のモデルへ循環。
        // ⇄ アイコンで「切り替え動作」であることを明示する。
        const models = Object.keys(DEVICE_SPECS) as DeviceModel[]
        const idx = models.indexOf(deviceModel)
        const next = models[(idx + 1) % models.length]
        return (
          <button
            type="button"
            className="btn btn-sm device-toggle-btn-single"
            onClick={() => onDeviceModelChange(next)}
            title={`デバイスモデル切替 (現在: ${DEVICE_SPECS[deviceModel].name} → クリックで ${DEVICE_SPECS[next].name})`}
          >
            <span>{DEVICE_SPECS[deviceModel].name}</span>
            <span className="device-toggle-icon" aria-hidden="true">⇄</span>
          </button>
        )
      })()}
      <button
        type="button"
        className="btn btn-sm btn-reset"
        onClick={onResetToDefault}
        title="ページ・ボタン設定を初期レイアウトに戻す (確認あり)"
      >
        ⟲ 初期化
      </button>
      <button className={`btn btn-sm ${isFlipped ? 'active' : ''}`} onClick={onToggleOrientation}>
        {isFlipped ? '\u21bb 180\u00b0' : '\u21bb \u901a\u5e38'}
      </button>
      <div className="control-separator" />
      <button className="btn btn-sm" onClick={onExport} title="display-layout.json をダウンロード">
        保存
      </button>
      <button className="btn btn-sm" onClick={onImport} title="display-layout.json を読み込み">
        読込
      </button>
      <div className="control-separator" />
      {/* Shared DevicePill — Kit tab の WorkDirBar と共通。
          pill 自体クリックで Devices モーダルを開く。
          以前あった "Devices ▸" 補助ボタンは header の Devices タブと
          冗長なため削除済み。 */}
      <DevicePill />
      <div className="control-separator" />
      <span className="tooltip-wrap">
        <button
          ref={deployBtnRef}
          className="btn btn-sm btn-deploy"
          onClick={onDeploy}
          disabled={!managerConnected || isDeploying || isSerialOnlySelected}
        >
          {isDeploying ? '書込中...' : 'デバイスに書込'}
        </button>
        {!managerConnected && (
          <span className="tooltip-text">Hapbeat Manager を起動してください</span>
        )}
        {managerConnected && isSerialOnlySelected && (
          <span className="tooltip-text">Display 書込みは LAN 接続デバイスのみ対応（Serial は未対応）</span>
        )}
      </span>
    </div>
  )
}

// ========================================
// InlineButtonConfig — ボタン横のコンパクト設定 (press + hold)
// ========================================

interface InlineButtonConfigProps {
  action: SingleButtonAction
  allItems: ActionItem[]
  actionGroups: ActionGroup[]
  holdGroups: ActionGroup[]
  btnId: string
  onActionChange: (buttonId: string, field: keyof SingleButtonAction, value: ButtonActionType) => void
}

function InlineButtonConfig({ action, allItems, actionGroups, holdGroups, btnId, onActionChange }: InlineButtonConfigProps) {
  const [openField, setOpenField] = useState<keyof SingleButtonAction | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Hold メニューには hold_page 系も含まれるため、allItems を拡張
  const holdAllItems = useMemo(() => {
    const extra = holdGroups.flatMap((g) => g.items)
    return [...extra, ...allItems]
  }, [holdGroups, allItems])

  const handleSelect = (field: keyof SingleButtonAction, value: string) => {
    // UI 上 'hold' という擬似フィールドで mode 別の hold_tmp / hold_latch
    // を切り替えて編集している。実際のセーブ先は active mode 側だけに送る
    // (もう片方は保持)。
    if (field === 'hold') {
      const target: keyof SingleButtonAction = (action.hold_mode ?? 'momentary') === 'momentary'
        ? 'hold_tmp'
        : 'hold_latch'
      onActionChange(btnId, target, value as ButtonActionType)
    } else {
      onActionChange(btnId, field, value as ButtonActionType)
    }
    setOpenField(null)
  }

  const openMenu = (field: keyof SingleButtonAction) => {
    const el = btnRefs.current[field]
    if (el) {
      const rect = el.getBoundingClientRect()
      const menuW = 240
      const x = rect.left + menuW > window.innerWidth ? window.innerWidth - menuW - 8 : rect.left
      setMenuPos({ x, y: rect.bottom + 2 })
    }
    setOpenField(field)
  }

  const holdMode = action.hold_mode ?? 'momentary'

  return (
    <div className="inline-btn-config">
      {(['short_press', 'hold'] as const).map((field) => {
        const groups = field === 'hold' ? holdGroups : actionGroups
        const items = field === 'hold' ? holdAllItems : allItems
        // hold \u306f mode \u5225 (hold_tmp / hold_latch) \u306b\u72ec\u7acb\u4fdd\u6301\u3057\u3066\u3044\u308b\u306e\u3067
        // active \u306a\u65b9\u3092\u8aad\u3080\u3002short_press \u306f\u305d\u306e\u307e\u307e\u3002
        const currentValue: string = field === 'hold'
          ? (getActiveHoldAction(action) as string)
          : ((action[field] as string) ?? 'none')
        const currentLabel = items.find((i) => i.value === currentValue)?.label ?? '\u2014'
        const isOpen = openField === field
        return (
          <div key={field} className="inline-config-row">
            <span className="inline-config-label">{field === 'short_press' ? 'Press' : 'Hold'}</span>
            <button
              ref={(el) => { btnRefs.current[field] = el }}
              className="inline-config-btn"
              onClick={(e) => {
                e.stopPropagation()
                isOpen ? setOpenField(null) : openMenu(field)
              }}
            >
              {currentLabel}
            </button>
            {isOpen && createPortal(
              <>
                <div className="portal-overlay" onClick={() => setOpenField(null)} />
                <div className="portal-dropdown" style={{ left: menuPos.x, top: menuPos.y }}>
                  {/* Hold メニュー内に hold_mode トグル（常時表示） */}
                  {field === 'hold' && (
                    <div className="hold-mode-bar">
                      <div className="tooltip-wrap">
                        <button
                          className={`hold-mode-btn ${holdMode === 'momentary' ? 'active' : ''}`}
                          onClick={(e) => { e.stopPropagation(); onActionChange(btnId, 'hold_mode', 'momentary' as ButtonActionType) }}
                        >
                          Tmp
                        </button>
                        <span className="tooltip-text">押している間だけ実行。離すと元に戻る</span>
                      </div>
                      <div className="tooltip-wrap">
                        <button
                          className={`hold-mode-btn ${holdMode === 'latch' ? 'active' : ''}`}
                          onClick={(e) => { e.stopPropagation(); onActionChange(btnId, 'hold_mode', 'latch' as ButtonActionType) }}
                        >
                          Exec
                        </button>
                        <span className="tooltip-text">Press と同じ挙動。離しても戻らない</span>
                      </div>
                    </div>
                  )}
                  {groups.map((group) => (
                    <div key={group.label} className="action-dropdown-group">
                      <div className="action-dropdown-group-label">{group.label}</div>
                      <div className="action-dropdown-items">
                        {group.items.map((opt) => (
                          <button
                            key={opt.value + opt.label}
                            className={`action-dropdown-item ${opt.value === currentValue ? 'selected' : ''}`}
                            data-none={opt.value === 'none' ? 'true' : undefined}
                            onClick={() => handleSelect(field, opt.value)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>,
              document.body
            )}
          </div>
        )
      })}
    </div>
  )
}

// ========================================
// DeployProgressBar — write_progress 受信に追従する per-target 進捗 UI
// ========================================
//
// - 1 ターゲット: インデターミネートな (流れる) バーで「動いている」感を表示
// - 多ターゲット: IP ごとに status icon + (任意) 1 行メッセージ
// - 完了: write_result 受信から ~1.5s で fade-out (DisplayEditor 側 setTimeout)

interface DeployProgressBarProps {
  total: number
  targets: Record<string, { phase: 'sending' | 'done' | 'failed'; message?: string }>
}

function DeployProgressBar({ total, targets }: DeployProgressBarProps) {
  const entries = Object.entries(targets)
  const doneCount = entries.filter(([, s]) => s.phase !== 'sending').length
  const okCount = entries.filter(([, s]) => s.phase === 'done').length
  const failCount = entries.filter(([, s]) => s.phase === 'failed').length
  const sendingCount = entries.filter(([, s]) => s.phase === 'sending').length
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const allDone = doneCount === total && total > 0
  const inProgress = !allDone && sendingCount > 0
  const headLabel = allDone
    ? `完了 ${okCount}/${total}${failCount > 0 ? ` (失敗 ${failCount})` : ''}`
    : `書込中 ${doneCount}/${total}`

  // 1 ターゲットのときは細かい行 UI を出さず、indeterminate バーだけで十分。
  const single = total === 1

  return (
    <div className="deploy-progress" role="status" aria-live="polite">
      <div className="deploy-progress-header">
        <span className="deploy-progress-label">{headLabel}</span>
        {inProgress && (
          <span className="deploy-progress-spinner" aria-hidden="true" />
        )}
      </div>
      <div
        className={`deploy-progress-bar ${
          inProgress ? (single ? 'indeterminate' : 'shimmer') : ''
        }`}
      >
        <div
          className={`deploy-progress-fill ${failCount > 0 && allDone ? 'has-fail' : ''}`}
          style={{ width: single && inProgress ? '100%' : `${pct}%` }}
        />
      </div>
      {!single && (
        <ul className="deploy-progress-list">
          {entries.map(([ip, s]) => (
            <li key={ip} className={`deploy-progress-row deploy-progress-row--${s.phase}`}>
              <span className="deploy-progress-icon" aria-hidden="true">
                {s.phase === 'sending'
                  ? <span className="deploy-progress-spinner-inline" />
                  : s.phase === 'done' ? '✓' : '✗'}
              </span>
              <span className="deploy-progress-ip">{ip}</span>
              {s.message && <span className="deploy-progress-msg">{s.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
