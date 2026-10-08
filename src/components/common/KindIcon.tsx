import { useI18n } from '@/i18n/I18nProvider'

type Props = {
  /** px; 16 in lists, 14 inline. */
  size?: number
  /** Next to a text that already says 音 / 触覚: hidden from assistive tech (no title). */
  decorative?: boolean
}

/** Speaker with waves: marks sound (colour `--sound`). */
export function SoundIcon({ size = 16, decorative = false }: Props) {
  const { t } = useI18n()
  const label = t('kind.sound')
  return <svg className="kind-icon sound" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}>
    {!decorative && <title>{label}</title>}
    <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" fillOpacity=".35" />
    <path d="M10.5 5.8a3 3 0 0 1 0 4.4" />
    <path d="M12.5 3.8a5.8 5.8 0 0 1 0 8.4" />
  </svg>
}

/** Device with vibration lines: marks haptics (colour `--haptic`). */
export function HapticIcon({ size = 16, decorative = false }: Props) {
  const { t } = useI18n()
  const label = t('kind.haptic')
  return <svg className="kind-icon haptic" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}>
    {!decorative && <title>{label}</title>}
    <rect x="5" y="2" width="6" height="12" rx="1.5" fill="currentColor" fillOpacity=".35" />
    <path d="M3 5l-1 1.5L3 8l-1 1.5L3 11" />
    <path d="M13 5l1 1.5L13 8l1 1.5L13 11" />
  </svg>
}

/** The icon of `kind`. */
export function KindIcon({ kind, ...props }: Props & { kind: 'sound' | 'haptic' }) {
  return kind === 'sound' ? <SoundIcon {...props} /> : <HapticIcon {...props} />
}
