import { describe, expect, it } from 'vitest'
import { addKnownProject, assignProject, effectiveProject, knownProjectNames, matchProjectPrefix, rangeSelection, suggestProjectPrefix, toggleSelection } from './clipProjects'

describe('clip projects', () => {
  it('collects known names from explicit values and the user list', () => {
    expect(knownProjectNames(['b', undefined, 'a', 'b'], [' c ', 'a', ''])).toEqual(['a', 'b', 'c'])
  })

  it('matches the longest known prefix followed by "-"', () => {
    const known = ['safety', 'safety-mill', 'safety-mill-vr']
    expect(matchProjectPrefix('safety-mill-vr-cut', known)).toBe('safety-mill-vr')
    expect(matchProjectPrefix('safety-mill-drill', known)).toBe('safety-mill')
    expect(matchProjectPrefix('safety-mill', known)).toBe('safety')
    expect(matchProjectPrefix('safetymill-x', known)).toBeUndefined()
    expect(matchProjectPrefix('Safety-mill-x', known)).toBeUndefined()
  })

  it('prefers the explicit project and flags auto membership', () => {
    const known = ['trex']
    expect(effectiveProject({ name: 'trex-roar', project: 'other' }, known)).toEqual({ project: 'other', auto: false })
    expect(effectiveProject({ name: 'trex-roar' }, known)).toEqual({ project: 'trex', auto: true })
    expect(effectiveProject({ name: 'roar' }, known)).toEqual({ project: undefined, auto: false })
  })

  it('assigns or clears the explicit project of the selected clips only', () => {
    const docs = [{ clip: { id: '1', name: 'a' } }, { clip: { id: '2', name: 'b', project: 'x' } }, { clip: { id: '3', name: 'c' } }]
    const moved = assignProject(docs, ['1', '2'], 'y')
    expect(moved.map(doc => doc.clip.project)).toEqual(['y', 'y', undefined])
    expect(moved[2]).toBe(docs[2])
    const cleared = assignProject(moved, ['2'], undefined)
    expect(cleared.map(doc => doc.clip.project)).toEqual(['y', undefined, undefined])
    expect(assignProject(docs, ['2'], 'x')[1]).toBe(docs[1])
  })

  it('adds a normalized name to the known list once', () => {
    const list = ['b']
    expect(addKnownProject(list, '  a  ')).toEqual(['a', 'b'])
    expect(addKnownProject(list, 'b')).toBe(list)
    expect(addKnownProject(list, '   ')).toBe(list)
  })

  it('suggests the part before the last "-"', () => {
    expect(suggestProjectPrefix('safety-mill-vr-cut')).toBe('safety-mill-vr')
    expect(suggestProjectPrefix('roar')).toBe('')
    expect(suggestProjectPrefix('-x')).toBe('')
  })

  it('toggles and ranges the multi-selection in display order', () => {
    expect(toggleSelection(['a', 'b'], 'b')).toEqual(['a'])
    expect(toggleSelection(['a'], 'c')).toEqual(['a', 'c'])
    const order = ['a', 'b', 'c', 'd']
    expect(rangeSelection(order, 'c', 'a')).toEqual(['a', 'b', 'c'])
    expect(rangeSelection(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeSelection(order, null, 'b')).toEqual(['b'])
    expect(rangeSelection(order, 'z', 'b')).toEqual(['b'])
  })
})
