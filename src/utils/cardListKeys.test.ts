import { describe, expect, it } from 'vitest'
import { arrowKeyOwner, stepIndex } from './cardListKeys'

/** A stand-in element: tag, input type, and the selectors its ancestors match. */
const el = (tagName: string, extra: { type?: string; within?: string[]; editable?: boolean } = {}) => ({
  tagName, type: extra.type, isContentEditable: !!extra.editable,
  closest: (selector: string) => extra.within?.some(s => selector.includes(s)) ? {} : null,
}) as unknown as Element

describe('card list arrow keys (Kit editor, AI trials, Events)', () => {
  it('typing keeps every key, a range slider keeps ←/→, the rest goes to the list', () => {
    expect(arrowKeyOwner(el('TEXTAREA'))).toBe('typing')
    expect(arrowKeyOwner(el('INPUT', { type: 'text' }))).toBe('typing')
    expect(arrowKeyOwner(el('INPUT', { type: 'checkbox' }))).toBe('typing')
    expect(arrowKeyOwner(el('SELECT'))).toBe('typing')
    expect(arrowKeyOwner(el('DIV', { editable: true }))).toBe('typing')
    expect(arrowKeyOwner(el('BUTTON', { within: ['[data-keeps-arrows]'] }))).toBe('typing') // a rating ★
    expect(arrowKeyOwner(el('INPUT', { type: 'range' }))).toBe('range')
    expect(arrowKeyOwner(el('ARTICLE'))).toBe('list')
    expect(arrowKeyOwner(el('BUTTON'))).toBe('list')
    expect(arrowKeyOwner(null)).toBe('list')
  })

  it('↑/↓ step one card, start at the first when none is selected, and stop at the ends', () => {
    expect(stepIndex(-1, 4, 'ArrowDown')).toBe(0)
    expect(stepIndex(-1, 4, 'ArrowUp')).toBe(0)
    expect(stepIndex(1, 4, 'ArrowDown')).toBe(2)
    expect(stepIndex(1, 4, 'ArrowUp')).toBe(0)
    expect(stepIndex(3, 4, 'ArrowDown')).toBe(3)
    expect(stepIndex(0, 4, 'ArrowUp')).toBe(0)
  })
})
