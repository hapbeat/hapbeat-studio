import { useCallback, useEffect, useState } from 'react'

const STORAGE_PREFIX = 'hapbeat-studio-history-'
const DEFAULT_LIMIT = 5

/**
 * Hook that gives a free-text field a small recent-input history,
 * persisted to localStorage and de-duped most-recent-first. Pair the
 * returned `historyId` with `<input list={historyId}>` and render the
 * `<datalist id={historyId}>` populated from `history` so the browser
 * shows the past values as autocomplete suggestions.
 *
 * Call `commit(value)` after a successful "save" action (e.g. when
 * the firmware ACKs a `set_name`) so we only remember values the
 * user actually applied — not every keystroke.
 *
 * @param key   stable key per field (e.g. "device-name", "wifi-ssid").
 *              The localStorage entry is `hapbeat-studio-history-<key>`.
 * @param limit how many entries to keep (oldest is dropped). Default 5.
 */
export function useInputHistory(
  key: string,
  limit: number = DEFAULT_LIMIT,
) {
  const storageKey = STORAGE_PREFIX + key
  const historyId = `${STORAGE_PREFIX}list-${key}`
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((v): v is string => typeof v === 'string').slice(0, limit)
    } catch {
      return []
    }
  })

  // Persist on every change so a tab close still preserves the list.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(history))
    } catch { /* quota / privacy mode — ignore */ }
  }, [storageKey, history])

  const commit = useCallback((rawValue: string) => {
    const value = rawValue.trim()
    if (!value) return
    setHistory((prev) => {
      const next = [value, ...prev.filter((v) => v !== value)].slice(0, limit)
      return next
    })
  }, [limit])

  const clear = useCallback(() => setHistory([]), [])

  return { history, historyId, commit, clear }
}
