import { useI18n } from '@/i18n/I18nProvider'
import { fieldOwner, shareField, splitField, type EffectiveEvent } from '@/utils/cueEvents'
import type { CueTable } from '@/utils/sceneCueTable'
import './EventsPanel.css'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

/**
 * The side of a cue group that does not hold a sound / haptics (DEC-091): no state, buttons or materials, only who
 * holds it, and the one switch. A shared variant says "set by the group" with "separate per variant" (splitField:
 * each variant gets a copy of the cue's materials); a cue whose variants each hold it says "set per variant" with
 * "share in the group" (shareField). Used by the editor's event details and the Scene tab.
 */
export function HeldBy({ table, e, field, edit, buttonClass }: { table: CueTable; e: EffectiveEvent; field: 'sfx' | 'haptics'; edit: Edit; buttonClass: string }) {
  const { t } = useI18n()
  const cue = e.ref.cue, variants = Object.keys(table.cues[cue]?.variants ?? {}).join('・')
  if (e.ref.variant !== null) {
    const owner = fieldOwner(table, cue, field), decided = table.cues[cue]?.[field] !== undefined
    const why = owner !== 'group' ? 'events.split.older' : decided ? 'events.split.hint' : 'events.split.undecided'
    return <span className="events-held">
      <span className="events-held-by" title={t('events.byGroup.hint', { cue })}>{t('events.byGroup')}</span>
      <button type="button" className={buttonClass} disabled={owner !== 'group' || !decided} title={t(why, { cue, variants })}
        onClick={() => edit(tb => splitField(tb, cue, field))}>{t('events.split')}</button>
    </span>
  }
  const first = Object.keys(table.cues[cue]?.variants ?? {})[0] ?? ''
  return <span className="events-held">
    <span className="events-held-by" title={t('events.byEach.hint', { variants })}>{t('events.byEach')}</span>
    <button type="button" className={buttonClass} title={t('events.share.hint', { cue, variants, first })}
      onClick={() => edit(tb => shareField(tb, cue, field))}>{t('events.share')}</button>
  </span>
}
