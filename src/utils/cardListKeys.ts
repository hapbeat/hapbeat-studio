import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isTypingTarget } from '@/utils/playbackShortcut'

/**
 * Arrow keys in card lists — one rule for the Kit editor (library clips, kit events), the AI trials' candidates and an
 * event's materials (editor Events panel): ↑/↓ select the previous / next card (it scrolls into view, what played
 * stops), Space plays the selected one (playbackShortcut), ←/→ belong to its strength slider.
 *
 * Who keeps the arrows: a text field, a select or contenteditable keeps every key (typing first); a range slider keeps
 * ←/→ and hands ↑/↓ to the list (it is left, so ←/→ then reach the new card); an element inside `data-keeps-arrows`
 * (the ★ of a rating) keeps them too.
 */
export type ArrowKeyOwner = 'typing' | 'range' | 'list'
export function arrowKeyOwner(el: Element | null): ArrowKeyOwner {
  if (!el) return 'list'
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range') return 'range'
  if (el.tagName === 'INPUT' || isTypingTarget(el) || el.closest?.('[data-keeps-arrows]')) return 'typing'
  return 'list'
}

/** Where ↑/↓ go from `current` in a list of `length` (nothing selected: the first), clamped to its ends. */
export function stepIndex(current: number, length: number, key: string): number {
  return Math.max(0, Math.min(length - 1, current < 0 ? 0 : current + (key === 'ArrowDown' ? 1 : -1)))
}

/** A card of a list: `[data-card]`, focusable, with what selecting it does (cardProps). */
const selects = new WeakMap<Element, () => void>()
const isSlider = (el: EventTarget | null) => el instanceof HTMLInputElement && el.type === 'range'
/**
 * Tab stops of a card: the card itself and its strength slider(s) only. Everything else inside (★, comments, buttons,
 * selects, ▶) stays usable with the mouse but leaves the Tab order — keyboard work on a card is ↑/↓, Space, ←/→.
 * Applied after every render of the card (its ref), so controls that appear later follow too. Tab from a field
 * entered with a click goes on to the next stop in page order (the next card).
 */
function keepTabStops(card: HTMLElement) {
  for (const el of card.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')) {
    if (el !== card && !isSlider(el) && el.tabIndex !== -1) el.tabIndex = -1
  }
}
/**
 * Props for a card: `select` runs when the card or its strength slider takes focus (Tab, a click, ↑/↓), so Space plays
 * the card the keyboard is on (it shows it in the waveform panel).
 */
export const cardProps = (select: () => void) => ({
  'data-card': '',
  tabIndex: 0,
  ref: (el: HTMLElement | null) => { if (el) { selects.set(el, select); keepTabStops(el) } },
  onFocus: (event: ReactFocusEvent<HTMLElement>) => { if (event.target === event.currentTarget || isSlider(event.target)) select() },
})

/**
 * A card list's keydown: ↑/↓ move focus to the previous / next `[data-card]` inside `event.currentTarget` (DOM order),
 * scroll it into view (nearest, like the Kit editor), run `onMove` (stop what plays) and select it. Returns false when
 * the key is not the list's (other keys, modifiers, a field that keeps the arrows, no card).
 */
export function onCardListKey(event: ReactKeyboardEvent<HTMLElement>, onMove?: () => void): boolean {
  if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return false
  const target = event.target as HTMLElement
  const owner = arrowKeyOwner(target)
  if (owner === 'typing') return false
  const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-card]')]
  const current = target.closest<HTMLElement>('[data-card]')
  const next = cards[stepIndex(current ? cards.indexOf(current) : -1, cards.length, event.key)]
  if (!next) return false
  event.preventDefault()
  if (next === current) return true
  if (owner === 'range') target.blur()
  next.focus({ preventScroll: true })
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  onMove?.()
  selects.get(next)?.()
  return true
}
