import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useWaveformStore } from '@/stores/waveformStore'
import { useEditorSettings } from '@/stores/editorSettings'
import { useI18n } from '@/i18n/I18nProvider'
import { normalizeProjectName } from '@/utils/editorFolder'
import type { EditorDocument } from '@/utils/editorFolder'
import { addKnownProject, effectiveProject, rangeSelection, suggestProjectPrefix, toggleSelection } from '@/utils/clipProjects'
import { WaveformThumbnail } from './WaveformThumbnail'
import { EditorMenu, EditorMenuItem, EditorMenuSection, useCloseEditorMenu } from './EditorMenu'
import { ProjectField, useProjectNames } from './PropertiesPanel'
import { useEditor } from './editorContext'
import { useEventStore, type DecideTarget } from '@/stores/eventStore'
import { clipEventMarks, EventMarkBadges } from './EventMarkBadges'

const UNASSIGNED = ''
interface ClipGroup { key: string; label: string; docs: EditorDocument[] }

function matches(doc: EditorDocument, project: string | undefined, query: string): boolean {
  if (!query) return true
  const { name, description, sourceFileName } = doc.clip
  return [name, description, project, sourceFileName].some(value => value?.toLocaleLowerCase().includes(query))
}

/** Text field inside a menu: Enter commits the value and closes the menu. */
function MenuNameInput({ placeholder, initial = '', onCommit }: { placeholder: string; initial?: string; onCommit: (value: string) => void }) {
  const close = useCloseEditorMenu()
  return <div className="editor-menu-fields">
    <input autoFocus defaultValue={initial} placeholder={placeholder} aria-label={placeholder}
      onKeyDown={e => { if (e.key === 'Enter') { const value = e.currentTarget.value; close(); onCommit(value) } }} />
  </div>
}

/**
 * Clip list grouped by project (or by source file), with search and per-clip actions in a "…" menu.
 * Project = grouping tag only: explicit, or derived from the clip-name prefix (see clipProjects).
 * Ctrl/Cmd-click and Shift-click build a multi-selection for "Move to project"; the waveform keeps the focused clip.
 */
export function ClipsPanel() {
  const { t } = useI18n()
  const s = useWaveformStore()
  const { auditionKey, openRecipe, setVisibleClipIds } = useEditor()
  const thumbnails = useEditorSettings(state => state.clipThumbnails)
  const groupBy = useEditorSettings(state => state.clipGroupBy)
  const collapsed = useEditorSettings(state => state.collapsedGroups)
  const update = useEditorSettings(state => state.update)
  const projectNames = useEditorSettings(state => state.projectNames)
  const eventMarks = useEditorSettings(state => state.eventMarks)
  const materialLinks = useEditorSettings(state => state.materialLinks)
  const decide = (target: DecideTarget, clipId: string) => useEventStore.getState().requestDecide({ target, source: { kind: 'clip', clipId }, event: null })
  const projects = useProjectNames()
  const [query, setQuery] = useState('')
  /** Multi-selection for bulk actions; a plain click resets it to the clicked clip. */
  const [selection, setSelection] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  /** Row in inline edit mode: rename or new project name. */
  const [editing, setEditing] = useState<{ id: string; field: 'name' | 'project' } | null>(null)
  const needle = query.trim().toLocaleLowerCase()
  const groups = useMemo((): ClipGroup[] => {
    const map = new Map<string, EditorDocument[]>()
    for (const doc of s.documents) {
      // Event materials being adjusted are not clips of the list (Events panel > Adjust opens them).
      if (materialLinks[doc.clip.id]) continue
      const project = effectiveProject(doc.clip, projects).project
      if (!matches(doc, project, needle)) continue
      const key = groupBy === 'project' ? project ?? UNASSIGNED : doc.clip.sourceFileName ?? UNASSIGNED
      map.set(key, [...(map.get(key) ?? []), doc])
    }
    return [...map.entries()]
      .sort(([a], [b]) => a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b))
      .map(([key, docs]) => ({ key, docs, label: key || t(groupBy === 'project' ? 'editor.unassigned' : 'editor.noSourceFile') }))
  }, [s.documents, projects, needle, groupBy, t, materialLinks])
  const groupId = (key: string) => `${groupBy}:${key}`
  const isCollapsed = (key: string) => !needle && collapsed.includes(groupId(key))
  const toggleGroup = (key: string) => update({ collapsedGroups: isCollapsed(key) ? collapsed.filter(item => item !== groupId(key)) : [...collapsed, groupId(key)] })
  const visibleIds = groups.flatMap(group => isCollapsed(group.key) ? [] : group.docs.map(doc => doc.clip.id))
  const visibleKey = visibleIds.join(',')
  useEffect(() => { setVisibleClipIds(visibleKey ? visibleKey.split(',') : []) }, [visibleKey, setVisibleClipIds])
  const focusedId = s.clip?.id ?? null
  // Keyboard clip switching moves the focus outside the selection: follow it.
  useEffect(() => {
    if (focusedId) setSelection(current => current.includes(focusedId) ? current : [focusedId])
  }, [focusedId])
  const documentIds = useMemo(() => new Set(s.documents.map(doc => doc.clip.id)), [s.documents])
  const targets = selection.filter(id => documentIds.has(id))
  const targetDocs = s.documents.filter(doc => targets.includes(doc.clip.id))
  const busy = s.isProcessing
  const setProject = (id: string, project: string | undefined) => s.updateClipInfo(id, { project })
  const moveSelection = (project: string | undefined) => useWaveformStore.getState().setClipsProject(targets, project)
  const addPrefix = (value: string) => update({ projectNames: [...addKnownProject(projectNames, value)] })
  const clickClip = (event: MouseEvent, id: string) => {
    if (event.ctrlKey || event.metaKey) { setSelection(toggleSelection(targets, id)); setAnchor(id); return }
    if (event.shiftKey) { setSelection(rangeSelection(visibleIds, anchor ?? focusedId, id)); return }
    setSelection([id]); setAnchor(id); s.selectClip(id)
  }
  return <div className="editor-panel editor-clips-panel">
    <div className="editor-clips-toolbar">
      <input type="search" className="editor-clip-search" value={query} placeholder={t('editor.searchClips')} aria-label={t('editor.searchClips')} onChange={e => setQuery(e.target.value)} />
      <EditorMenu label={`${t('editor.moveToProject')} ▾`} title={t('editor.moveToProjectHint')} disabled={busy || !targets.length}>
        <EditorMenuSection label={t('editor.selectedClips', { count: targets.length })}>
          {projects.map(name => <EditorMenuItem key={name} checked={targetDocs.every(doc => doc.clip.project === name)} onSelect={() => moveSelection(name)}>{name}</EditorMenuItem>)}
          <MenuNameInput placeholder={t('editor.newProjectName')} onCommit={value => { const name = normalizeProjectName(value); if (name) moveSelection(name) }} />
          <EditorMenuItem disabled={!targetDocs.some(doc => doc.clip.project)} onSelect={() => moveSelection(undefined)}>{t('editor.clearProject')}</EditorMenuItem>
        </EditorMenuSection>
        <p className="editor-menu-note">{t('editor.projectHint')}</p>
      </EditorMenu>
      <EditorMenu label="⋯" title={t('editor.clipListMenu')}>
        <EditorMenuSection label={t('editor.groupBy')}>
          <EditorMenuItem checked={groupBy === 'project'} onSelect={() => update({ clipGroupBy: 'project' })}>{t('editor.groupByProject')}</EditorMenuItem>
          <EditorMenuItem checked={groupBy === 'source'} onSelect={() => update({ clipGroupBy: 'source' })}>{t('editor.groupBySource')}</EditorMenuItem>
        </EditorMenuSection>
        <EditorMenuItem checked={thumbnails} onSelect={() => update({ clipThumbnails: !thumbnails })}>{t('editor.showThumbnails')}</EditorMenuItem>
        <EditorMenuItem onSelect={() => update({ collapsedGroups: collapsed.filter(item => !item.startsWith(`${groupBy}:`)) })}>{t('editor.expandAll')}</EditorMenuItem>
        <EditorMenuItem onSelect={() => update({ collapsedGroups: [...collapsed.filter(item => !item.startsWith(`${groupBy}:`)), ...groups.map(group => groupId(group.key))] })}>{t('editor.collapseAll')}</EditorMenuItem>
        <EditorMenuSection label={t('editor.autoProjectNames')}>
          {projectNames.map(name => <EditorMenuItem key={name} keepOpen onSelect={() => update({ projectNames: projectNames.filter(item => item !== name) })}>✕ {name}</EditorMenuItem>)}
          <MenuNameInput placeholder={t('editor.prefixPlaceholder')} onCommit={addPrefix} />
        </EditorMenuSection>
      </EditorMenu>
    </div>
    <div className="editor-clip-groups" aria-label={t('editor.clips')}>
      {!s.folder && <p className="editor-muted">{t('editor.chooseFirst')}</p>}
      {s.folder && !s.documents.length && <p className="editor-muted">{t('editor.emptyHint')}</p>}
      {s.folder && s.documents.length > 0 && !groups.length && <p className="editor-muted">{t('editor.noMatches')}</p>}
      {groups.map(group => <section key={group.key} className="editor-clip-group">
        <div className="editor-clip-group-head">
          <button className="editor-clip-group-header" aria-expanded={!isCollapsed(group.key)} onClick={() => toggleGroup(group.key)} title={group.label}>
            <span aria-hidden="true">{isCollapsed(group.key) ? '▸' : '▾'}</span><span className={group.key ? '' : 'editor-muted'}>{group.label}</span><small>{group.docs.length}</small>
          </button>
          {groupBy === 'project' && <EditorMenu label="⋯" title={t('editor.groupMenu', { name: group.label })} className="editor-clip-menu" disabled={busy}>
            <EditorMenuSection label={t('editor.autoGroupByPrefix')}>
              <MenuNameInput placeholder={t('editor.prefixPlaceholder')} initial={suggestProjectPrefix(group.docs[0]?.clip.name ?? '')} onCommit={addPrefix} />
            </EditorMenuSection>
            <p className="editor-menu-note">{t('editor.projectHint')}</p>
          </EditorMenu>}
        </div>
        {!isCollapsed(group.key) && <ul className="editor-clip-rows">
          {group.docs.map(doc => {
            const { clip } = doc, selected = clip.id === s.clip?.id
            const picked = targets.length > 1 && targets.includes(clip.id)
            const edit = editing?.id === clip.id ? editing.field : null
            return <li key={clip.id} className={`editor-clip-row ${selected ? 'selected' : ''} ${picked ? 'picked' : ''}`}>
              {edit === 'name' ? <input className="editor-clip-inline" autoFocus defaultValue={clip.name} aria-label={t('editor.name')}
                onBlur={e => { s.updateClipInfo(clip.id, { name: e.target.value }); setEditing(null) }}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(null) }} />
                : edit === 'project' ? <span className="editor-clip-inline"><ProjectField clipId={clip.id} value={clip.project} autoFocus onDone={() => setEditing(null)} /></span>
                : <button className="editor-clip" disabled={busy} aria-pressed={selected} title={clip.name} onClick={e => clickClip(e, clip.id)}>
                  <strong>{clip.name || '—'}</strong><small>{clip.buffer.duration.toFixed(3)} s</small>
                  <EventMarkBadges marks={clipEventMarks(clip, eventMarks)} />
                  {thumbnails && <WaveformThumbnail buffer={clip.buffer} />}
                </button>}
              <EditorMenu label="⋯" title={t('editor.clipMenu', { name: clip.name })} className="editor-clip-menu" disabled={busy}>
                <EditorMenuItem onSelect={() => setEditing({ id: clip.id, field: 'name' })}>{t('editor.rename')}</EditorMenuItem>
                <EditorMenuItem disabled={!!auditionKey} onSelect={() => { s.selectClip(clip.id); useWaveformStore.getState().duplicateClip() }}>⧉ {t('editor.variant')}</EditorMenuItem>
                {clip.recipe && <EditorMenuItem disabled={!s.folder} onSelect={doc => openRecipe(doc, clip.recipe)}>{t('editor.recipe.edit')}</EditorMenuItem>}
                <EditorMenuSection label={t('events.menuSection')}>
                  <EditorMenuItem onSelect={() => decide('sound', clip.id)}>{t('events.decideSound')}</EditorMenuItem>
                  <EditorMenuItem onSelect={() => decide('haptic', clip.id)}>{t('events.decideHaptic')}</EditorMenuItem>
                </EditorMenuSection>
                <EditorMenuSection label={t('editor.setProject')}>
                  {projects.map(name => <EditorMenuItem key={name} checked={clip.project === name} onSelect={() => setProject(clip.id, normalizeProjectName(name))}>{name}</EditorMenuItem>)}
                  <EditorMenuItem onSelect={() => setEditing({ id: clip.id, field: 'project' })}>{t('editor.newProject')}</EditorMenuItem>
                  <EditorMenuItem disabled={!clip.project} onSelect={() => setProject(clip.id, undefined)}>{t('editor.clearProject')}</EditorMenuItem>
                </EditorMenuSection>
              </EditorMenu>
            </li>
          })}
        </ul>}
      </section>)}
    </div>
    <p className="editor-help">{t('editor.shortcuts')}</p>
  </div>
}
