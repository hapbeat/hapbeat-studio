import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatMessage, messages, type MessageId, type MessageParams, type StudioLocale } from './messages'

const EN_ROUTE = 'en'

interface I18nContextValue {
  locale: StudioLocale
  setLocale: (locale: StudioLocale) => void
  t: (id: MessageId, params?: MessageParams) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function basePath(): string {
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? base : `${base}/`
}

function localeFromPath(pathname: string): StudioLocale | null {
  const base = basePath()
  return pathname === `${base}${EN_ROUTE}` || pathname.startsWith(`${base}${EN_ROUTE}/`)
    ? 'en'
    : pathname === base || pathname.startsWith(base)
      ? 'ja'
      : null
}

function initialLocale(): StudioLocale {
  // URL is authoritative so a shared /en/ link always opens in English.
  return localeFromPath(window.location.pathname) ?? 'ja'
}

function pathForLocale(locale: StudioLocale): string {
  return locale === 'en' ? `${basePath()}${EN_ROUTE}/` : basePath()
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<StudioLocale>(initialLocale)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: StudioLocale) => {
    const nextPath = pathForLocale(next)
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, '', `${nextPath}${window.location.search}${window.location.hash}`)
    }
    setLocaleState(next)
  }, [])

  useEffect(() => {
    const onPopState = () => setLocaleState(localeFromPath(window.location.pathname) ?? 'ja')
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  const t = useCallback(
    (id: MessageId, params?: MessageParams) => formatMessage(messages[id][locale], params),
    [locale],
  )
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside I18nProvider')
  return context
}

export type { MessageId, MessageParams, StudioLocale }
