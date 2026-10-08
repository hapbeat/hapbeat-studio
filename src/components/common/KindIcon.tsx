import { useI18n } from '@/i18n/I18nProvider'

type Props = {
  /** px; 16 in lists, 14 inline. */
  size?: number
  /** Next to a text that already says 音 / 触覚: hidden from assistive tech (no title). */
  decorative?: boolean
  /** Crossed out with a diagonal slash: "no sound" / "no haptics" (an approved or tentative none). */
  slashed?: boolean
}

/** The diagonal slash of a `slashed` icon. */
const SLASH = 'M2 2l12 12'

/** Speaker with waves: marks sound (colour `--sound`). */
export function SoundIcon({ size = 16, decorative = false, slashed = false }: Props) {
  const { t } = useI18n()
  const label = t('kind.sound')
  return <svg className={`kind-icon sound${slashed ? ' slashed' : ''}`} viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}>
    {!decorative && <title>{label}</title>}
    <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" fillOpacity=".35" />
    <path d="M10.5 5.8a3 3 0 0 1 0 4.4" />
    <path d="M12.5 3.8a5.8 5.8 0 0 1 0 8.4" />
    {slashed && <path d={SLASH} />}
  </svg>
}

/** Open hand with vibration lines: marks haptics (colour `--haptic`). */
export function HapticIcon({ size = 16, decorative = false, slashed = false }: Props) {
  const { t } = useI18n()
  const label = t('kind.haptic')
  return <svg className={`kind-icon haptic${slashed ? ' slashed' : ''}`} viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}>
    {!decorative && <title>{label}</title>}
    <path d="M6.5 14.5C5.2 14.5 4.5 13.4 4.5 12L2.4 9.3a1.1 1.1 0 0 1 1.7-1.4L4.5 8.4V4.8a1.15 1.15 0 0 1 2.3 0V3.6a1.15 1.15 0 0 1 2.3 0v1.2a1.15 1.15 0 0 1 2.3 0V12c0 1.4-.9 2.5-2.2 2.5z"
      fill="currentColor" fillOpacity=".35" />
    <path d="M13.6 4.5l1 1.5-1 1.5 1 1.5-1 1.5" />
    {slashed && <path d={SLASH} />}
  </svg>
}

/** The icon of `kind`. */
export function KindIcon({ kind, ...props }: Props & { kind: 'sound' | 'haptic' }) {
  return kind === 'sound' ? <SoundIcon {...props} /> : <HapticIcon {...props} />
}
