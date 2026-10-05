import { useI18n } from '@/i18n/I18nProvider'
import { useEditorSettings } from '@/stores/editorSettings'
import { LISTEN_TIMES_OPTIONS } from '@/utils/editorUiSettings'

/** How many times every editor audition plays (×1 / ×3 / ×5; shared by the AI trials and Events panels, saved in the editor settings). */
export function ListenTimes() {
  const { t } = useI18n()
  const times = useEditorSettings(s => s.listenTimes)
  return <span className="editor-segmented listen-times" role="group" aria-label={t('editor.listenTimes')} title={t('editor.listenTimesHint')}>
    {LISTEN_TIMES_OPTIONS.map(n => <button key={n} type="button" className={`toolbar-btn ${times === n ? 'active' : ''}`} aria-pressed={times === n}
      onClick={() => useEditorSettings.getState().update({ listenTimes: n })}>×{n}</button>)}
  </span>
}
