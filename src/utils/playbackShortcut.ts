export function handlePlaybackShortcut(event: KeyboardEvent, tab: string, dispatch: (event: Event) => void) {
  if (event.code !== 'Space' || event.isComposing) return
  const target = tab === 'editor' ? 'editor' : tab === 'kit' || tab === 'devices' ? 'kit' : null
  if (!target) return
  // Capture before focused inputs/buttons and hidden panels can consume Space.
  event.preventDefault(); event.stopImmediatePropagation()
  if (!event.repeat) dispatch(new Event(`studio:${target}-playback`))
}
