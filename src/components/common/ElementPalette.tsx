import { useState } from 'react'
import type { DisplayElementMeta, DisplayElementType } from '@/types/display'
import { getElementSize } from '@/types/display'
import { setCurrentDragType, setCurrentDragVariant } from '@/components/display/DisplayEditor'
import './ElementPalette.css'

// ============================================================================
// パレット定義
// ----------------------------------------------------------------------------
// グループ化方針 (5 セクション):
//  1. ステータス  — 動的に変化、運用中の常時表示候補 (vol / battery / status)
//  2. 操作可能    — ボタン操作で増減 (player / group / page)
//  3. 識別        — 設定で固定 (device name / address / app / position)
//  4. ネットワーク — 通信状態・接続情報 (wifi signal / SSID / IP)
//  5. メタ        — サポート情報 (firmware version)
//
// variant (compact=4 / standard=8 / wide=16) を持つ要素は 1 カードに集約し、
// カード内インラインの S/M/L picker で切替える (= flat 列挙の肥大化を防ぐ)。
// 配置済みの variant が分かるように、選択中 variant がカードの drag/click
// 動作に反映される (palette-local state)。
// ============================================================================

interface VariantOption { value: string; label: string }

interface PaletteItemDef {
  type: DisplayElementType
  label: string
  description: string
  icon: string
  /** 同 type で別カードを並べる識別 (battery %/Bar の様な「意味が違う」分裂用) */
  variant?: string
  /** S/M/L picker を出す場合の variant 候補 (compact/standard/wide パターン) */
  variants?: VariantOption[]
}

interface PaletteSection {
  title: string
  hint: string
  items: PaletteItemDef[]
}

const sizeVariants: VariantOption[] = [
  { value: 'compact',  label: 'S' },
  { value: 'standard', label: 'M' },
  { value: 'wide',     label: 'L' },
]

const PALETTE_SECTIONS: PaletteSection[] = [
  {
    title: 'ステータス',
    hint: '動的に変化 / 常時表示向き',
    items: [
      { type: 'volume',            label: 'Volume',     description: '音量',        icon: '♪' },
      { type: 'volume_mode',       label: 'Vol Mode',   description: 'Fix/Var',     icon: 'M' },
      { type: 'battery',                                   label: 'Battery %',   description: '残量%',     icon: '⚡' },
      { type: 'battery', variant: 'bar',                   label: 'Battery Bar', description: '残量バー',   icon: '█' },
      { type: 'connection_status', label: 'Status',     description: 'Wi-Fi+アプリ', icon: '◉' },
    ],
  },
  {
    title: '操作可能',
    hint: 'ボタン押下で増減',
    items: [
      { type: 'player_number', label: 'Player', description: 'プレイヤー番号', icon: 'P' },
      { type: 'group_id',      label: 'Group',  description: 'グループID',     icon: 'Gr' },
      { type: 'page_indicator', label: 'Page',  description: 'ページ番号',     icon: '#' },
    ],
  },
  {
    title: '識別',
    hint: '設定で決まる固定情報',
    items: [
      { type: 'device_name', label: 'Device Name', description: 'ホスト名',   icon: 'D' },
      { type: 'address',     label: 'Address',     description: 'prefix',     icon: 'A', variants: sizeVariants },
      { type: 'app_name',    label: 'AppName',     description: '接続アプリ名', icon: 'A', variants: sizeVariants },
      { type: 'position',    label: 'Position',    description: '装着位置',     icon: '⬦' },
    ],
  },
  {
    title: 'ネットワーク',
    hint: '通信状態・接続情報',
    items: [
      { type: 'wifi_status', label: 'Wi-Fi Signal', description: 'RSSI',           icon: '◎' },
      { type: 'wifi_ssid',   label: 'Wi-Fi SSID',   description: 'SSID 左 N 文字', icon: '○', variants: sizeVariants },
      { type: 'ip_address',  label: 'IP Address',   description: 'IP 左 N 文字',   icon: '⌖', variants: sizeVariants },
    ],
  },
  {
    title: 'メタ',
    hint: 'サポート情報',
    items: [
      { type: 'firmware_version', label: 'FW Ver', description: 'バージョン', icon: 'v' },
    ],
  },
]

// ============================================================================
// 既存 export 互換: フラットな elementMetas / getElementMeta は OledSimulator や
// PopupPalette が要素の label / icon 引きに使っている。セクション再編後も
// 同じ形で派生させる。
// ============================================================================

export const elementMetas: DisplayElementMeta[] = PALETTE_SECTIONS.flatMap((sec) =>
  sec.items.flatMap((item) => {
    if (item.variants) {
      // 各 variant を独立 meta として平展開 (旧 elementMetas と同形)。
      return item.variants.map((v) => ({
        type: item.type,
        // 'standard' は variant 未指定 (= デフォルト) として表現
        variant: v.value === 'standard' ? undefined : (v.value as DisplayElementMeta['variant']),
        label: item.label,
        description: item.description,
        icon: item.icon,
      }))
    }
    return [{
      type: item.type,
      variant: item.variant as DisplayElementMeta['variant'] | undefined,
      label: item.label,
      description: item.description,
      icon: item.icon,
    }]
  }),
)

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

// ============================================================================
// コンポーネント
// ============================================================================

interface ElementPaletteProps {
  selectedType: DisplayElementType | null
  onSelectType: (type: DisplayElementType | null) => void
  usedTypes: Set<DisplayElementType>
}

export function ElementPalette({ selectedType, onSelectType, usedTypes }: ElementPaletteProps) {
  // size variant (S/M/L) の選択状態を type 単位で保持。デフォルトは 'standard'。
  // type をまたぐ集約 state: { 'address': 'wide', 'app_name': 'compact', ... }
  const [variantByType, setVariantByType] = useState<Record<string, string>>({})

  return (
    <div className="element-palette">
      <div className="panel-title">要素パレット</div>
      <div className="palette-hint">
        OLED 上をクリック or パレットからドラッグ
      </div>
      {PALETTE_SECTIONS.map((sec) => (
        <section key={sec.title} className="palette-section">
          <header className="palette-section-header">
            <span className="palette-section-title">{sec.title}</span>
            <span className="palette-section-hint">{sec.hint}</span>
          </header>
          <div className="palette-grid">
            {sec.items.map((item) => {
              const selectedVariant = item.variants
                ? (variantByType[item.type] ?? 'standard')
                : item.variant
              const effectiveVariant: string | undefined = selectedVariant === 'standard'
                ? undefined
                : selectedVariant
              const size = getElementSize(item.type, effectiveVariant)
              const key = item.variants ? item.type : `${item.type}:${item.variant ?? '-'}`
              const isSelected = selectedType === item.type && !item.variant && !item.variants
              // 配置済み判定:
              //  - variant picker 持ち (S/M/L)  → 1 ページに 1 個まで (どの variant でも)
              //  - battery (% / Bar 別カード)   → % と Bar は共存可 (旧仕様維持)
              //  - その他                        → 1 ページに 1 個まで
              const isUsed = item.variants
                ? usedTypes.has(item.type)
                : item.type === 'battery'
                  ? usedTypes.has(item.type) && !item.variant
                  : usedTypes.has(item.type)

              const onPickVariant = (v: string) => {
                setVariantByType((prev) => ({ ...prev, [item.type]: v }))
              }

              return (
                <button
                  key={key}
                  className={`palette-item ${isSelected ? 'selected' : ''} ${isUsed ? 'used' : ''}`}
                  onClick={() => {
                    if (isUsed) return
                    onSelectType(isSelected ? null : item.type)
                  }}
                  disabled={isUsed}
                  onMouseDown={(e) => {
                    if (isUsed || e.button !== 0) return
                    e.preventDefault()
                    setCurrentDragType(item.type)
                    setCurrentDragVariant(effectiveVariant)
                  }}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <div className="palette-info">
                    <span className="palette-label">
                      {item.label} <span className="palette-size">[{size[0]}x{size[1]}]</span>
                    </span>
                    <span className="palette-desc">{item.description}</span>
                  </div>
                  {item.variants && (
                    <div
                      className="palette-variant-picker"
                      // 親 button の onClick / onMouseDown を発火させない
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {item.variants.map((v) => (
                        <button
                          key={v.value}
                          type="button"
                          className={`palette-variant-btn ${selectedVariant === v.value ? 'active' : ''}`}
                          onClick={() => onPickVariant(v.value)}
                          title={`${v.label} = ${getElementSize(item.type, v.value === 'standard' ? undefined : v.value)[0]} 文字`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {isUsed && <span className="palette-used-badge" title="使用中">✓</span>}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
