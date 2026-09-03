import { useEffect, useState } from 'react'

export type StudioLocale = 'ja' | 'en'

const LOCALE_KEY = 'hapbeat-studio-locale'
const translatableAttributes = ['title', 'aria-label', 'placeholder', 'data-tip', 'alt'] as const

/*
 * Studio already has a large, mature Japanese UI.  Keeping its Japanese
 * strings as the source avoids coupling device/protocol behaviour to a
 * translation framework: this layer only changes rendered text and assistive
 * labels.  New DOM produced by a mounted tab or modal is observed as well.
 */
const exact: Record<string, string> = {
  '保存': 'Save',
  '保存中…': 'Saving…',
  '読み込み': 'Import',
  '読み込み中…': 'Loading…',
  '書き込み': 'Write',
  '書き込み中…': 'Writing…',
  '追加': 'Add',
  '削除': 'Remove',
  'キャンセル': 'Cancel',
  '閉じる': 'Close',
  '更新': 'Update',
  '設定': 'Settings',
  '接続': 'Connect',
  '接続中': 'Connected',
  '未接続': 'Disconnected',
  '再接続': 'Reconnect',
  '再試行': 'Retry',
  '確認': 'Confirm',
  '完了': 'Done',
  '戻る': 'Back',
  '次へ': 'Next',
  'スキップ': 'Skip',
  'リセット': 'Reset',
  '初期化': 'Reset to defaults',
  '新規': 'New',
  '選択': 'Select',
  '選択中': 'Selected',
  '全て': 'All',
  'なし': 'None',
  '詳細': 'Details',
  'エラー': 'Error',
  '警告': 'Warning',
  '成功': 'Succeeded',
  '失敗': 'Failed',
  '不明': 'Unknown',
  '名前': 'Name',
  '説明': 'Help',
  'メモ': 'Note',
  'デバイス': 'Device',
  'デバイス名': 'Device name',
  'デバイス情報': 'Device information',
  'デバイス設定': 'Device settings',
  'ファームウェア': 'Firmware',
  'ファームウェア種別': 'Firmware family',
  'ファームウェアバージョン': 'Firmware version',
  'ハード版': 'Hardware version',
  '最新': 'Latest',
  'アーカイブ': 'Archive',
  'ライブラリ': 'Library',
  'イベント': 'Event',
  'イベント ID': 'Event ID',
  '音量': 'Volume',
  '輝度': 'Brightness',
  'プレビュー': 'Preview',
  '再生': 'Play',
  '停止': 'Stop',
  '有効': 'Enabled',
  '無効': 'Disabled',
  'オン': 'On',
  'オフ': 'Off',
  'コピー': 'Copy',
  'エクスポート': 'Export',
  'インポート': 'Import',
  'ダウンロード': 'Download',
  'アップロード': 'Upload',
  '更新手順を表示': 'Show update instructions',
  'Helper 接続中': 'Helper connected',
  'Helper 未接続': 'Helper disconnected',
  'Helper 要更新': 'Helper update required',
  'Studio バージョン': 'Studio version',
  '操作説明': 'Controls help',
  '閉じる (Esc)': 'Close (Esc)',
  '先頭へ': 'Go to start',
  '末尾へ': 'Go to end',
  '音源フォルダを選択': 'Choose audio folder',
  '並び順': 'Sort order',
  '一致なし': 'No match',
  '全台': 'All devices',
  'ハードウェア': 'Hardware',
  '周辺機器': 'Peripheral',
  'デフォルト': 'Default',
  '任意': 'Optional',
  '必須': 'Required',
  '読み込んだ設定': 'Loaded settings',
  '現在値を取り込む': 'Use current value',
  'デバイスに保存': 'Save to device',
  'JSON ファイルから読み込む': 'Import from JSON file',
  'JSON ファイルに保存': 'Save as JSON file',
  '空欄 = 全台': 'Blank = all devices',
}

// Longest phrases first so a specific UI sentence is not broken into smaller
// terms.  The remainder covers dynamic notifications and tooltips.
const phrases: ReadonlyArray<readonly [string, string]> = [
  ['hapbeat-helper の更新が必要です', 'hapbeat-helper must be updated'],
  ['現在 v', 'Current v'],
  ['必要 v', 'required v'],
  ['以上 — 一部の Kit deploy / device 操作が失敗する可能性があります。', ' or later — some Kit deployment and device operations may fail.'],
  ['Studio v', 'Studio v'],
  ['が公開されています', ' is available'],
  ['が利用可能', ' is available'],
  ['このお知らせを閉じる', 'Dismiss this notice'],
  ['このセッション中は非表示', 'Hide for this session'],
  ['クリックでセットアップ方法を表示', 'Show setup instructions'],
  ['クリックで管理', 'Click to manage'],
  ['クリックで直接入力', 'Click to enter directly'],
  ['クリックで', 'Click to '],
  ['新しいタブで開く', 'Open in a new tab'],
  ['ファイルから', 'from file'],
  ['ファイルに', 'to file'],
  ['デバイスから', 'from device'],
  ['デバイスへ', 'to device'],
  ['デバイスに', 'to device'],
  ['デバイスを', 'device '],
  ['デバイスの', 'device '],
  ['デバイスが', 'device '],
  ['デバイス ', 'device '],
  ['設定を', 'settings '],
  ['設定に', 'settings '],
  ['設定が', 'settings '],
  ['設定 ', 'settings '],
  ['接続中', 'connected'],
  ['接続に失敗', 'connection failed'],
  ['接続できません', 'cannot connect'],
  ['選択してください', 'Please select'],
  ['選択中の', 'selected '],
  ['選択した', 'selected '],
  ['選択を', 'selection '],
  ['読み込み中', 'Loading'],
  ['読み込みに失敗', 'Failed to load'],
  ['書き込み中', 'Writing'],
  ['書き込みに失敗', 'Failed to write'],
  ['保存中', 'Saving'],
  ['保存に失敗', 'Failed to save'],
  ['保存しました', 'Saved'],
  ['削除しました', 'Removed'],
  ['追加しました', 'Added'],
  ['更新しました', 'Updated'],
  ['失敗しました', 'Failed'],
  ['完了しました', 'Completed'],
  ['ファームウェア', 'firmware'],
  ['ハードウェア', 'hardware'],
  ['デバイス', 'device'],
  ['ライブラリ', 'library'],
  ['イベント', 'event'],
  ['音源', 'audio'],
  ['音量', 'volume'],
  ['輝度', 'brightness'],
  ['設定', 'settings'],
  ['接続', 'connection'],
  ['切断', 'disconnect'],
  ['更新', 'update'],
  ['保存', 'save'],
  ['読み込み', 'load'],
  ['書き込み', 'write'],
  ['追加', 'add'],
  ['削除', 'remove'],
  ['選択', 'select'],
  ['確認', 'confirm'],
  ['警告', 'warning'],
  ['エラー', 'error'],
  ['成功', 'success'],
  ['失敗', 'failed'],
  ['再生', 'play'],
  ['停止', 'stop'],
  ['全台', 'all devices'],
  ['一覧', 'list'],
  ['現在', 'current'],
  ['初期', 'default'],
  ['有効', 'enabled'],
  ['無効', 'disabled'],
  ['必須', 'required'],
  ['任意', 'optional'],
  ['未接続', 'disconnected'],
  ['接続中', 'connected'],
  ['してください', ''],
  ['できます', 'is available'],
  ['ません', 'not available'],
  ['です', ''],
  ['ます', ''],
  ['を', ' '],
  ['に', ' '],
  ['が', ' '],
  ['の', ' '],
]

function translateJapanese(source: string): string {
  const trimmed = source.trim()
  if (!trimmed || !/[ぁ-んァ-ン一-龯]/.test(trimmed)) return source
  const translated = exact[trimmed]
  if (translated) return source.replace(trimmed, translated)

  let result = source
  for (const [ja, en] of phrases) result = result.split(ja).join(en)
  return result.replace(/[ \t]{2,}/g, ' ')
}

const textSources = new WeakMap<Text, string>()
const translatedTexts = new WeakMap<Text, string>()
const attributeSources = new WeakMap<Element, Map<string, string>>()
const translatedAttributes = new WeakMap<Element, Map<string, string>>()

function localizeText(node: Text, locale: StudioLocale) {
  const parent = node.parentElement
  if (!parent || ['SCRIPT', 'STYLE', 'CODE', 'PRE'].includes(parent.tagName)) return
  const current = node.data
  let source = textSources.get(node)
  if (current !== translatedTexts.get(node)) {
    source = current
    textSources.set(node, source)
  }
  if (source === undefined) return
  if (locale === 'ja') {
    if (current !== source) node.data = source
    translatedTexts.delete(node)
    return
  }
  const translated = translateJapanese(source)
  if (current !== translated) node.data = translated
  translatedTexts.set(node, translated)
}

function localizeAttributes(element: Element, locale: StudioLocale) {
  const sources = attributeSources.get(element) ?? new Map<string, string>()
  const applied = translatedAttributes.get(element) ?? new Map<string, string>()
  attributeSources.set(element, sources)
  translatedAttributes.set(element, applied)
  for (const name of translatableAttributes) {
    const current = element.getAttribute(name)
    if (current === null) continue
    let source = sources.get(name)
    if (current !== applied.get(name)) {
      source = current
      sources.set(name, source)
    }
    if (source === undefined) continue
    if (locale === 'ja') {
      if (current !== source) element.setAttribute(name, source)
      applied.delete(name)
    } else {
      const translated = translateJapanese(source)
      if (current !== translated) element.setAttribute(name, translated)
      applied.set(name, translated)
    }
  }
}

function localizeTree(root: Node, locale: StudioLocale) {
  if (root.nodeType === Node.TEXT_NODE) localizeText(root as Text, locale)
  if (root.nodeType === Node.ELEMENT_NODE) localizeAttributes(root as Element, locale)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.nodeType === Node.TEXT_NODE) localizeText(node as Text, locale)
    else localizeAttributes(node as Element, locale)
  }
}

export function getStoredLocale(): StudioLocale {
  return localStorage.getItem(LOCALE_KEY) === 'en' ? 'en' : 'ja'
}

export function useStudioLocale(): readonly [StudioLocale, (locale: StudioLocale) => void] {
  const [locale, setLocaleState] = useState<StudioLocale>(getStoredLocale)
  useEffect(() => {
    document.documentElement.lang = locale
    localizeTree(document.body, locale)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') localizeText(mutation.target as Text, locale)
        else if (mutation.type === 'attributes') localizeAttributes(mutation.target as Element, locale)
        else for (const node of mutation.addedNodes) localizeTree(node, locale)
      }
    })
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...translatableAttributes],
    })
    return () => observer.disconnect()
  }, [locale])

  const setLocale = (next: StudioLocale) => {
    localStorage.setItem(LOCALE_KEY, next)
    setLocaleState(next)
  }
  return [locale, setLocale] as const
}

export { translateJapanese }
