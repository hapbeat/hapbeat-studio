/**
 * ui-config.json のエクスポート / インポート / IndexedDB バックアップ
 *
 * Studio 内部形式 → ファームウェア形式への変換を担う。
 * display-layout / LED / volume を1ファイルに統合。
 *
 * ファームウェア側ファイルパス: /config/ui-config.json
 */

import { openDB, type IDBPDatabase } from 'idb'
import type {
  DisplayLayout,
  DisplayOrientation,
  PerButtonActions,
  LedConfig,
  LedRule,
  VolumeConfig,
} from '@/types/display'
import {
  ELEMENT_FIXED_SIZES,
  getElementSize,
  DEFAULT_LED_RULES,
  DEFAULT_VOLUME_CONFIG,
} from '@/types/display'
import { DEVICE_SPECS, type DeviceModel } from '@/types/device'
import type { SimState } from '@/utils/displayPreview'

// ---- Firmware-side JSON types (contracts 仕様準拠) -------------------------

interface FirmwareElement {
  type: string
  position: [number, number]
  size: [number, number]
  variant?: string
  font_scale?: number
}

interface FirmwarePage {
  id: string
  name: string
  elements: FirmwareElement[]
}

interface FirmwareButtonActions {
  [buttonId: string]: {
    short_press?: string
    long_press?: string
    hold?: string
    hold_mode?: string
  }
}

interface FirmwareDisplaySection {
  grid: [number, number]
  pages: FirmwarePage[]
  button_actions: FirmwareButtonActions
  orientation?: DisplayOrientation
  device_model?: string
  show_page_indicator?: boolean
}

interface FirmwareLedRule {
  id: string
  condition: string
  enabled: boolean
  color: [number, number, number]
  brightness?: number
  blink_sec: number
  fade: boolean
  priority: number
}

interface FirmwareLedSection {
  global_brightness: number
  rules: FirmwareLedRule[]
}

interface FirmwareVolumeSection {
  steps: number
  direction: string
  default_level: number
}

/** ファームウェアに送る統合 JSON の型 */
export interface FirmwareUiConfig {
  display: FirmwareDisplaySection
  led: FirmwareLedSection
  volume: FirmwareVolumeSection
}

// ---- Studio SavedState (DisplayEditor と同じ構造) ---------------------------

export interface DisplaySavedState {
  layout: DisplayLayout
  deviceModel: DeviceModel
  orientation: DisplayOrientation
  perButtonActions: PerButtonActions
  simState: SimState
  ledConfig: LedConfig
  volumeConfig: VolumeConfig
}

// ---- 変換: Studio → Firmware ------------------------------------------------

export function toFirmwareFormat(state: DisplaySavedState): FirmwareUiConfig {
  const { layout, deviceModel, orientation, perButtonActions, ledConfig, volumeConfig } = state

  const pages: FirmwarePage[] = layout.pages.map((page, idx) => ({
    id: `page_${idx}`,
    name: page.name,
    elements: page.elements.map((el) => {
      const size = getElementSize(el.type, el.variant)
      const out: FirmwareElement = {
        type: el.type,
        position: el.pos,
        size: [size[0], size[1]] as [number, number],
      }
      // battery: standard(no variant) = percent, "bar" = bar meter
      // Other elements: only emit variant if not standard
      if (el.type === 'battery') {
        out.variant = el.variant === 'bar' ? 'bar' : 'percent'
      } else if (el.variant && el.variant !== 'standard') {
        out.variant = el.variant
      }
      if (el.font_scale && el.font_scale !== 1) out.font_scale = el.font_scale
      return out
    }),
  }))

  // Studio 内部名 → ファームウェアアクション名
  const toFirmwareAction = (a: string): string => {
    if (a === 'vib_mode') return 'mode_toggle'
    if (a === 'toggle_page') return 'toggle_page' // ファーム側で追加が必要
    return a
  }

  // 選択中デバイスモデルのボタンIDのみ出力（他モデルのIDが混入するとファーム側で上書き事故）
  const validBtnIds = new Set(DEVICE_SPECS[deviceModel].buttons.map((b) => b.id))
  const button_actions: FirmwareButtonActions = {}
  if (perButtonActions) {
    for (const [btnId, action] of Object.entries(perButtonActions)) {
      if (!validBtnIds.has(btnId)) continue
      const entry: FirmwareButtonActions[string] = {
        short_press: toFirmwareAction(action.short_press ?? 'none'),
        long_press: toFirmwareAction(action.long_press ?? 'none'),
        hold: toFirmwareAction(action.hold ?? 'none'),
      }
      if (action.hold_mode && action.hold_mode !== 'momentary') {
        entry.hold_mode = action.hold_mode
      }
      button_actions[btnId] = entry
    }
  }

  // page_indicator 要素がレイアウトに含まれていれば true
  const hasPageIndicator = layout.pages.some((p) =>
    p.elements.some((el) => el.type === 'page_indicator')
  )

  return {
    display: {
      grid: layout.grid,
      pages,
      button_actions,
      orientation,
      device_model: deviceModel,
      show_page_indicator: hasPageIndicator,
    },
    led: {
      global_brightness: ledConfig?.globalBrightness ?? 255,
      rules: (ledConfig?.rules ?? DEFAULT_LED_RULES).map((r) => {
        const rule: FirmwareLedRule = {
          id: r.id,
          condition: r.condition,
          enabled: r.enabled,
          color: r.color,
          blink_sec: r.blink_sec,
          fade: r.fade,
          priority: r.priority,
        }
        if (r.brightness !== undefined) rule.brightness = r.brightness
        return rule
      }),
    },
    volume: {
      steps: volumeConfig?.steps ?? DEFAULT_VOLUME_CONFIG.steps,
      direction: volumeConfig?.direction ?? DEFAULT_VOLUME_CONFIG.direction,
      default_level: volumeConfig?.default_level ?? DEFAULT_VOLUME_CONFIG.default_level,
    },
  }
}

// ---- 変換: Firmware → Studio ------------------------------------------------

export function fromFirmwareFormat(fw: FirmwareUiConfig): Partial<DisplaySavedState> {
  const display = fw.display
  const pages = display.pages.map((page) => ({
    name: page.name,
    elements: page.elements.map((el) => {
      const base: import('@/types/display').DisplayElement = {
        id: `el-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: el.type as import('@/types/display').DisplayElementType,
        pos: el.position as [number, number],
      }
      if (el.variant === 'compact') base.variant = 'compact'
      if (el.variant === 'bar') base.variant = 'bar'
      if (el.font_scale && el.font_scale !== 1) base.font_scale = el.font_scale as 1 | 2
      return base
    }),
  }))

  // アクション名の正規化（旧名 → 新名）
  const normalizeAction = (a: string): import('@/types/display').ButtonActionType => {
    if (a === 'toggle_volume_adc' || a === 'mode_toggle') return 'vib_mode'
    if (a === 'previous_page') return 'prev_page'
    return (a ?? 'none') as import('@/types/display').ButtonActionType
  }

  const perButtonActions: PerButtonActions = {}
  if (display.button_actions) {
    for (const [btnId, action] of Object.entries(display.button_actions)) {
      perButtonActions[btnId] = {
        short_press: normalizeAction(action.short_press ?? 'none'),
        long_press: normalizeAction(action.long_press ?? 'none'),
        hold: normalizeAction(action.hold ?? 'none'),
        hold_mode: (action as Record<string, unknown>).hold_mode === 'latch' ? 'latch' : 'momentary',
      }
    }
  }

  const layout: DisplayLayout = {
    grid: display.grid ?? [16, 2],
    pages,
    buttons: { short_press: 'next_page', long_press: 'none' },
  }

  const ledConfig: LedConfig = fw.led
    ? { globalBrightness: fw.led.global_brightness ?? 255, rules: fw.led.rules as LedRule[] }
    : { globalBrightness: 255, rules: [...DEFAULT_LED_RULES] }

  const volumeConfig: VolumeConfig = fw.volume ? {
    steps: fw.volume.steps,
    direction: fw.volume.direction as import('@/types/display').VolumeDirection,
    default_level: fw.volume.default_level,
  } : { ...DEFAULT_VOLUME_CONFIG }

  return {
    layout,
    deviceModel: (display.device_model as DeviceModel) ?? 'duo_wl',
    orientation: display.orientation ?? 'normal',
    perButtonActions,
    ledConfig,
    volumeConfig,
  }
}

// ---- ファイルダウンロード ---------------------------------------------------

export function exportUiConfig(state: DisplaySavedState): void {
  const firmware = toFirmwareFormat(state)
  const json = JSON.stringify(firmware, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
  a.download = `ui-config_${ts}.json`
  document.body.appendChild(a)
  a.click()

  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}

export const exportDisplayLayout = exportUiConfig

// ---- ファイルインポート -----------------------------------------------------

export async function importUiConfig(file: File): Promise<Partial<DisplaySavedState>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = reader.result as string
        const parsed = JSON.parse(text)

        // 統合形式 (display セクションあり) か旧形式 (pages が直下) かを判定
        if (parsed.display && parsed.display.pages) {
          resolve(fromFirmwareFormat(parsed as FirmwareUiConfig))
        } else if (parsed.pages) {
          // 旧 display-layout.json 形式 → display セクションに変換して読み込み
          const compat: FirmwareUiConfig = {
            display: parsed,
            led: parsed.led ?? { global_brightness: 255, rules: DEFAULT_LED_RULES },
            volume: parsed.volume ?? DEFAULT_VOLUME_CONFIG,
          }
          resolve(fromFirmwareFormat(compat))
        } else {
          reject(new Error('無効なファイルです。display.pages または pages 配列がありません。'))
        }
      } catch (err) {
        reject(new Error(`ファイルの解析に失敗しました: ${err}`))
      }
    }
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'))
    reader.readAsText(file)
  })
}

export const importDisplayLayout = importUiConfig

// ---- IndexedDB バックアップ (3重目) -----------------------------------------

const IDB_NAME = 'hapbeat-studio'
const IDB_VERSION = 2 // v1 は projects、v2 で display-backup store 追加
const STORE_DISPLAY = 'display-backup'
const BACKUP_KEY = 'latest'

async function getDisplayDb(): Promise<IDBPDatabase> {
  return openDB(IDB_NAME, IDB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_DISPLAY)) {
        db.createObjectStore(STORE_DISPLAY)
      }
    },
  })
}

export async function saveDisplayToIDB(state: DisplaySavedState): Promise<void> {
  try {
    const db = await getDisplayDb()
    await db.put(STORE_DISPLAY, {
      ...state,
      _savedAt: new Date().toISOString(),
    }, BACKUP_KEY)
  } catch { /* IndexedDB が使えない環境では無視 */ }
}

export async function loadDisplayFromIDB(): Promise<DisplaySavedState | null> {
  try {
    const db = await getDisplayDb()
    const data = await db.get(STORE_DISPLAY, BACKUP_KEY)
    if (!data) return null
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _savedAt, ...state } = data
    return state as DisplaySavedState
  } catch { return null }
}
