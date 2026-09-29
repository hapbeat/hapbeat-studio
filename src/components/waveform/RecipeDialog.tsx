import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import { RECIPE_PRESETS, validateRecipe, type Recipe } from '@/utils/recipe'
import '@/components/common/ConfirmDialog.css'

const CUSTOM = 'custom'
const presetJson = (recipe: Recipe) => JSON.stringify(recipe, null, 2)

/**
 * Generator dialog: preset picker + editable `hapbeat-recipe@1` JSON.
 * Always creates a new clip; `initial` (Edit recipe) only pre-fills the form.
 * Portalled into `container` so it also works in the popped-out editor window.
 */
export function RecipeDialog({ container, initial, onCreate, onClose }: {
  container: HTMLElement
  initial?: Recipe
  onCreate: (recipe: Recipe, presetId: string | null) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [text, setText] = useState(() => presetJson(initial ?? RECIPE_PRESETS[0].recipe))
  const presetId = useMemo(() => RECIPE_PRESETS.find(p => presetJson(p.recipe) === text)?.id ?? CUSTOM, [text])
  const result = useMemo((): { recipe: Recipe } | { error: string } => {
    let value: unknown
    try { value = JSON.parse(text) }
    catch (error) { return { error: t('editor.recipe.invalidJson', { message: error instanceof Error ? error.message : String(error) }) } }
    const problem = validateRecipe(value)
    return problem ? { error: t('editor.recipe.invalid', { message: problem }) } : { recipe: value as Recipe }
  }, [text, t])

  useEffect(() => {
    const view = container.ownerDocument.defaultView
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    view?.addEventListener('keydown', onKey)
    return () => view?.removeEventListener('keydown', onKey)
  }, [container, onClose])

  const submit = () => { if ('recipe' in result) onCreate(result.recipe, presetId === CUSTOM ? null : presetId) }

  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={onClose}>
      <div className="confirm-dialog recipe-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('editor.recipe.title')}>
        <div className="confirm-dialog-title">{t('editor.recipe.title')}</div>
        <div className="confirm-dialog-body recipe-dialog-body">
          <label className="recipe-dialog-field">{t('editor.recipe.preset')}
            <select value={presetId} onChange={(e) => {
              const preset = RECIPE_PRESETS.find(p => p.id === e.target.value)
              if (preset) setText(presetJson(preset.recipe))
            }}>
              {RECIPE_PRESETS.map(p => <option key={p.id} value={p.id}>{t(`editor.recipe.preset.${p.id}` as MessageId)}</option>)}
              <option value={CUSTOM} disabled>{t('editor.recipe.custom')}</option>
            </select>
          </label>
          <p className="recipe-dialog-note recipe-dialog-desc">
            {presetId === CUSTOM ? t('editor.recipe.custom') : t(`editor.recipe.preset.${presetId}.desc` as MessageId)}
            <br />{t('editor.recipe.hypothesis')}
          </p>
          <label className="recipe-dialog-field">{t('editor.recipe.json')}
            <textarea className="recipe-dialog-json" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <p className={`recipe-dialog-status ${'error' in result ? 'error' : 'ok'}`} role="status">{'error' in result ? result.error : t('editor.recipe.valid')}</p>
          <p className="recipe-dialog-note">{t('editor.recipe.newClipHint')}</p>
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="form-button-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="form-button" disabled={'error' in result} onClick={submit}>{t('editor.recipe.submit')}</button>
        </div>
      </div>
    </div>,
    container,
  )
}
