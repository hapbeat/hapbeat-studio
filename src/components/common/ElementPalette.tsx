import type { DisplayElementMeta, DisplayElementType } from '@/types/display'
import { getElementSize } from '@/types/display'
import { setCurrentDragType, setCurrentDragVariant } from '@/components/display/DisplayEditor'
import './ElementPalette.css'

export const elementMetas: DisplayElementMeta[] = [
  { type: 'volume',            label: 'Volume',             description: 'vol:00',         icon: '\u266a' },
  { type: 'volume_mode',       label: 'Vol Mode',           description: 'Fix/Var',        icon: 'M' },
  { type: 'battery',           label: 'Battery %',         description: '残量パーセント', icon: '\u26a1' },
  { type: 'battery', variant: 'bar', label: 'Battery Bar', description: '残量バーメーター', icon: '\u2588' },
  { type: 'wifi_status',       label: 'Wi-Fi 強度',       description: 'RSSI表示',       icon: '\u25ce' },
  { type: 'wifi_ssid',         label: 'Wi-Fi 接続先',     description: 'SSID/AP名',      icon: '\u25cb' },
  { type: 'connection_status', label: '接続状態',          description: 'Wi-Fi+アプリ',   icon: '\u25c9' },
  { type: 'ip_address',        label: 'IP アドレス',      description: 'IP',             icon: '\u2316' },
  { type: 'firmware_version',  label: 'FW Ver',           description: 'バージョン',     icon: 'v' },
  { type: 'device_name',       label: 'デバイス名',        description: '設定名称',       icon: 'D' },
  { type: 'app_name', variant: 'compact',  label: 'App Name S',  description: 'Short — 4 chars',  icon: 'A' },
  { type: 'app_name',                       label: 'App Name M',  description: 'Medium — 8 chars', icon: 'A' },
  { type: 'app_name', variant: 'wide',      label: 'App Name L',  description: 'Long — 16 chars',  icon: 'A' },
  { type: 'gain',              label: 'ゲイン',            description: '出力ゲイン',     icon: 'G' },
  { type: 'address',           label: 'アドレス',          description: 'player/pos',     icon: 'A' },
  { type: 'player_number',     label: 'プレイヤー',        description: 'Player番号',     icon: 'P' },
  { type: 'position',          label: 'ポジション',        description: '装着位置',       icon: '\u2b26' },
  { type: 'page_indicator',    label: 'Page',               description: 'Page indicator', icon: '#' },
  { type: 'group_id',          label: 'グループ',          description: 'グループID',     icon: 'Gr' },
]

function metaKey(meta: DisplayElementMeta): string {
  return meta.variant ? `${meta.type}:${meta.variant}` : meta.type
}

/**
 * 指定 type (+ variant) の meta を返す。
 *
 * variant 必須化 (2026-05-07): 旧実装は variant を無視して最初に見つかった
 * meta を返していたため、複数 variant を持つ要素 (app_name S/M/L など) は
 * 配置済みカードの label が常に palette 1 番目のもの (e.g. "App Name S")
 * になるバグがあった。variant を明示渡しで一致 meta を選ぶ。
 *
 * variant 省略時は variant なし meta (= "標準") を優先し、無ければ
 * 同 type の最初のものを返す (battery 互換)。
 */
export function getElementMeta(
  type: DisplayElementType,
  variant?: string,
): DisplayElementMeta | undefined {
  if (variant && variant !== 'standard') {
    return elementMetas.find((m) => m.type === type && m.variant === variant)
  }
  return elementMetas.find((m) => m.type === type && !m.variant)
    ?? elementMetas.find((m) => m.type === type)
}

interface ElementPaletteProps {
  selectedType: DisplayElementType | null
  onSelectType: (type: DisplayElementType | null) => void
  usedTypes: Set<DisplayElementType>
}

export function ElementPalette({ selectedType, onSelectType, usedTypes }: ElementPaletteProps) {
  return (
    <div className="element-palette">
      <div className="panel-title">要素パレット</div>
      <div className="palette-hint">
        OLED 上をクリック or パレットからドラッグ
      </div>
      <div className="palette-grid">
        {elementMetas.map((meta) => {
          const size = getElementSize(meta.type, meta.variant)
          const key = metaKey(meta)
          const isSelected = selectedType === meta.type && !meta.variant
          // app_name は variant (compact / standard / wide) で表示幅が
          // 違うだけで意味は同一。1 ページに 1 個だけ配置可とし、
          // どれか 1 variant が置かれたら 3 つとも palette でグレーアウト
          // する (= 残り 2 つの異 variant も "使用中" 扱い)。
          // battery は variant 毎に意味が違う (% / bar) ので per-variant 個別
          // 配置可能。これは既存挙動を維持。
          const isUsed = meta.type === 'app_name'
            ? usedTypes.has('app_name')
            : usedTypes.has(meta.type) && !meta.variant
          return (
            <button
              key={key}
              className={`palette-item ${isSelected ? 'selected' : ''} ${isUsed ? 'used' : ''}`}
              onClick={() => {
                if (isUsed) return
                onSelectType(isSelected ? null : meta.type)
              }}
              disabled={isUsed}
              onMouseDown={(e) => {
                if (isUsed || e.button !== 0) return
                e.preventDefault()
                setCurrentDragType(meta.type)
                setCurrentDragVariant(meta.variant)
              }}
            >
              <span className="palette-icon">{meta.icon}</span>
              <div className="palette-info">
                <span className="palette-label">{meta.label}</span>
                <span className="palette-desc">
                  {meta.description} ({size[0]}x{size[1]})
                </span>
              </div>
              {isUsed && <span className="palette-used-badge">使用中</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
