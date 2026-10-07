/** A rectangle in viewport (client) pixels: a trigger's bounding rect, or a point (left = right, top = bottom). */
export interface MenuAnchor { left: number; top: number; right: number; bottom: number }
export interface MenuPlacement { left: number; top: number; /** Set when the menu is taller than the room on either side: it scrolls inside. */ maxHeight?: number }

const MARGIN = 4

/**
 * Where a popup menu of `size` goes in a `view` (window inner size): below the anchor, else above it
 * (when it fits there), else on the roomier side capped to that room (scrolling inside); left-aligned
 * with the anchor, else right-aligned with it (flipped left), and always kept inside the view.
 * `gap` is the space between anchor and menu (2 px under a button, 0 at a pointer).
 */
export function placeMenu(anchor: MenuAnchor, size: { width: number; height: number }, view: { width: number; height: number }, gap = 2): MenuPlacement {
  const below = anchor.bottom + gap, roomBelow = view.height - MARGIN - below
  const roomAbove = anchor.top - gap - MARGIN
  let top: number, maxHeight: number | undefined
  if (size.height <= roomBelow) top = below
  else if (size.height <= roomAbove) top = anchor.top - gap - size.height
  else if (roomBelow >= roomAbove) { maxHeight = Math.max(0, roomBelow); top = below }
  else { maxHeight = Math.max(0, roomAbove); top = anchor.top - gap - maxHeight }
  const fitsRight = anchor.left + size.width <= view.width - MARGIN
  const left = Math.max(MARGIN, Math.min(fitsRight ? anchor.left : anchor.right - size.width, view.width - MARGIN - size.width))
  return maxHeight === undefined ? { left, top: Math.max(MARGIN, top) } : { left, top: Math.max(MARGIN, top), maxHeight }
}
