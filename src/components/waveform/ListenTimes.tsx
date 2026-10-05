import { useI18n } from '@/i18n/I18nProvider'
import { useEditorSettings } from '@/stores/editorSettings'
import { LISTEN_TIMES_OPTIONS } from '@/utils/editorUiSettings'
import { useRepeats } from './eventAudio'

/**
 * How many times editor auditions of a repeating cue play (×1 / ×3 / ×5; shared by the AI trials and Events panels,
 * saved in the editor settings). Dimmed (same width) while `event` — the cue open in that panel — fires once.
 */
export function ListenTimes({ event }: { event: string | null }) {
  const { t } = useI18n()
  const times = useEditorSettings(s => s.listenTimes)
  const repeats = useRepeats(event)
  return <span className={`editor-segmented listen-times ${repeats ? '' : 'once'}`} role="group" aria-label={t('editor.listenTimes')}
    title={repeats ? t('editor.listenTimesHint') : `${t('editor.listenOnce')}\n${t('editor.listenTimesHint')}`}>
    {LISTEN_TIMES_OPTIONS.map(n => <button key={n} type="button" disabled={!repeats} className={`toolbar-btn ${times === n ? 'active' : ''}`} aria-pressed={times === n}
      onClick={() => useEditorSettings.getState().update({ listenTimes: n })}>×{n}</button>)}
  </span>
}
