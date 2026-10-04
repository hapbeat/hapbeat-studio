import { useEffect, useId, useMemo, useState } from 'react'
import { useWaveformStore } from '@/stores/waveformStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useI18n } from '@/i18n/I18nProvider'
import { normalizeProjectName } from '@/utils/editorFolder'
import { effectiveProject, knownProjectNames, type EffectiveProject } from '@/utils/clipProjects'
import { useEditor } from './editorContext'

/** Known project names (explicit labels of the open clips + the user's auto-group list), sorted for pickers. */
export function useProjectNames(): string[] {
  const documents = useWaveformStore(s => s.documents)
  const listed = useEditorSettings(s => s.projectNames)
  return useMemo(() => knownProjectNames(documents.map(doc => doc.clip.project), listed), [documents, listed])
}

/** Explicit project, else the one derived from the clip-name prefix. */
export function useEffectiveProject(clip: { name: string; project?: string }): EffectiveProject {
  const known = useProjectNames()
  return useMemo(() => effectiveProject(clip, known), [clip.name, clip.project, known])
}

/**
 * Project picker: type a new name or pick an existing one. The value is
 * committed (normalized) on blur / Enter so spaces can be typed freely.
 */
export function ProjectField({ clipId, value, autoProject, autoFocus, onDone }: { clipId: string; value: string | undefined; autoProject?: string; autoFocus?: boolean; onDone?: () => void }) {
  const { t } = useI18n()
  const listId = useId()
  const projects = useProjectNames()
  const processing = useWaveformStore(s => s.isProcessing)
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => { setDraft(value ?? '') }, [value, clipId])
  const commit = () => {
    const next = normalizeProjectName(draft)
    if (next !== value) useWaveformStore.getState().updateClipInfo(clipId, { project: next })
    setDraft(next ?? '')
    onDone?.()
  }
  return <>
    <input list={listId} value={draft} placeholder={autoProject ? t('editor.projectAutoPlaceholder', { name: autoProject }) : t('editor.projectPlaceholder')} title={t('editor.projectHint')} aria-label={t('editor.project')} disabled={processing} autoFocus={autoFocus}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(value ?? ''); onDone?.() } }} />
    <datalist id={listId}>{projects.map(name => <option key={name} value={name} />)}</datalist>
  </>
}

const NO_CLIP = { name: '' }

/** Selected clip's name, usage note and project, then one detail per line (wraps in narrow panels). */
export function PropertiesPanel() {
  const { t } = useI18n()
  const clip = useWaveformStore(s => s.clip)
  const processing = useWaveformStore(s => s.isProcessing)
  const folder = useWaveformStore(s => s.folder)
  const { openRecipe, provenanceText, auditionKey } = useEditor()
  const project = useEffectiveProject(clip ?? NO_CLIP)
  if (!clip) return <div className="editor-panel editor-panel-empty">{t('editor.noClip')}</div>
  const update = useWaveformStore.getState().updateClipInfo
  const provenance = provenanceText(clip)
  return <div className="editor-panel editor-properties">
    <fieldset className="editor-properties-fields" disabled={processing || !!auditionKey}>
      <label>{t('editor.name')}<input value={clip.name} onChange={e => update(clip.id, { name: e.target.value })} /></label>
      <label>{t('editor.descriptionLabel')}<input placeholder={t('editor.description')} value={clip.description ?? ''} onChange={e => update(clip.id, { description: e.target.value })} /></label>
      <label>
        <span className="editor-project-label">{t('editor.project')}{project.auto && <span className="editor-project-auto" title={t('editor.projectAutoHint', { name: project.project })}>{t('editor.projectAuto')}</span>}</span>
        <ProjectField clipId={clip.id} value={clip.project} autoProject={project.auto ? project.project : undefined} />
        <small className="editor-project-hint">{t('editor.projectHint')}</small>
      </label>
    </fieldset>
    <ul className="editor-properties-details" aria-label={t('editor.details')}>
      {clip.sourceFileName && <li title={clip.sourceFileName}>{t('editor.sourceFile')}: {clip.sourceFileName}</li>}
      {provenance && <li className="editor-provenance" title={clip.provenance?.referrerUrl ?? undefined}>{provenance}</li>}
      {clip.recipe && <li>{t('editor.generatorLayers', { count: clip.recipe.layers.length })}{' '}
        <button className="toolbar-btn" disabled={!folder || processing} onClick={e => openRecipe(e.currentTarget.ownerDocument, clip.recipe)}>{t('editor.recipe.edit')}</button></li>}
    </ul>
  </div>
}
