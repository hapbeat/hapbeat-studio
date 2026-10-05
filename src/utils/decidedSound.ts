/**
 * Which events' decided sound plays on the PC with what the editor shows: an AI haptic candidate (its trial's
 * scene cues, when that project is open), an event's haptic material (the event), or a haptic material being
 * adjusted (its event). A sound shown (candidate, material, adjusted material) is itself the sound: none.
 */
export function decidedSoundEvents(o: {
  /** The auditioned haptic trial's scene (null: no audition, a sound trial, or no scene). */
  audition: { project: string; cues: string[] } | null
  auditioning: boolean
  preview: { event: string; target: 'sound' | 'haptic' } | null
  adjusting: { project: string; event: string; target: 'sound' | 'haptic' } | null
  openProject: string
}): string[] {
  if (o.auditioning) return o.audition && o.audition.project === o.openProject ? o.audition.cues : []
  if (o.preview) return o.preview.target === 'haptic' ? [o.preview.event] : []
  if (o.adjusting) return o.adjusting.target === 'haptic' && o.adjusting.project === o.openProject ? [o.adjusting.event] : []
  return []
}
