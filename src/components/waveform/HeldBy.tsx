import { useI18n } from '@/i18n/I18nProvider'
import { useEditorSettings } from '@/stores/editorSettings'
import { addReserves } from '@/utils/agentTrialUi'
import { fieldOwner, shareField, splitAll, splitReserves, undecidedReserves, variantKeys, type EffectiveEvent } from '@/utils/cueEvents'
import type { CueTable } from '@/utils/sceneCueTable'
import type { MaterialReserve } from '@/utils/editorUiSettings'
import './EventsPanel.css'

type Edit = (change: (tb: CueTable) => CueTable | null) => boolean

/**
 * The side of a cue group that does not hold a sound / haptics (DEC-091): no state, buttons or materials, only who
 * holds it, faint — 「グループで指定」 on a shared variant, 「各強弱で指定」 on a cue whose variants hold it. The switch
 * between the two is on the cue (GroupSwitch). Used by the editor's event details and the Scene tab.
 */
export function HeldBy({ e }: { e: EffectiveEvent }) {
  const { t } = useI18n()
  const variant = e.ref.variant !== null
  return <span className="events-held">
    <span className="events-held-by" title={variant ? t('events.byGroup.hint', { cue: e.ref.cue }) : undefined}>{t(variant ? 'events.byGroup' : 'events.byEach')}</span>
  </span>
}

/**
 * On a cue with variants, per sound / haptics (DEC-091): 「まとめる」 (the cue holds it, every variant shares it) or
 * 「分ける」 (each variant holds its own). Separating copies the cue's starred materials to every variant without its
 * own and takes the cue's off (its unstarred alternates go to the cue's reserves); sharing gathers the variants'
 * materials on the cue (shareField; in a table where the cue and some variants both hold it, the variants' own go to
 * their reserves). Neither is pressed while the cue and some variants both hold it (a situational override). Both
 * labels are always there (nothing moves).
 */
export function GroupSwitch({ table, cue, field, edit, buttonClass }: { table: CueTable; cue: string; field: 'sfx' | 'haptics'; edit: Edit; buttonClass: string }) {
  const { t } = useI18n()
  const variants = Object.keys(table.cues[cue]?.variants ?? {})
  if (!variants.length) return null
  const owner = fieldOwner(table, cue, field), decided = table.cues[cue]?.[field] !== undefined
  const names = variants.join('・')
  const keep = (moves: [string, MaterialReserve[]][]) => {
    let reserves = useEditorSettings.getState().eventReserves
    for (const [key, moved] of moves) if (moved.length) reserves = addReserves(reserves, key, moved)
    useEditorSettings.getState().update({ eventReserves: reserves })
  }
  const share = () => {
    if (owner === 'group') return
    const moved: [string, MaterialReserve[]][] = owner === 'both'
      ? variantKeys(table, cue).filter(k => table.cues[cue]?.variants?.[k.slice(cue.length + 1)]?.[field] !== undefined).map(k => [k, undecidedReserves(table, k, field)]) : []
    if (edit(tb => shareField(tb, cue, field))) keep(moved)
  }
  const separate = () => {
    if (owner === 'each' || !decided) return
    const moved = splitReserves(table, cue, field)
    if (edit(tb => splitAll(tb, cue, field))) keep([[cue, moved]])
  }
  return <span className="events-switch" role="group" aria-label={t('events.switch.label')} title={owner === 'both' ? t('events.switch.mixed', { cue }) : undefined}>
    <button type="button" className={buttonClass} aria-pressed={owner === 'group'} onClick={share}
      title={owner === 'group' ? t('events.byGroup.hint', { cue }) : t(owner === 'both' ? 'events.switch.groupFromMixed' : 'events.switch.groupHint', { cue, variants: names })}>{t('events.switch.group')}</button>
    <button type="button" className={buttonClass} aria-pressed={owner === 'each'} aria-disabled={owner !== 'each' && !decided} onClick={separate}
      title={owner === 'each' ? t('events.byEach.hint', { variants: names }) : t(decided ? 'events.switch.eachHint' : 'events.switch.undecided', { cue, variants: names })}>{t('events.switch.each')}</button>
  </span>
}
