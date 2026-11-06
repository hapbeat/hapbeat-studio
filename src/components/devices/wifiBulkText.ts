import type { MessageId, MessageParams } from '@/i18n/I18nProvider'
import type { WifiBulkItem } from '@/stores/serialMaster'

type Translate = (id: MessageId, params?: MessageParams) => string

export type WifiBulkTone = 'ok' | 'warn' | 'err' | 'muted'

/** One device's bulk Wi-Fi state as display text: `text` is the short line
 *  (the card), `hint` the explanation shown under it in the Wi-Fi tab. */
export function wifiBulkItemText(
  t: Translate,
  item: WifiBulkItem,
): { text: string; hint?: string; tone: WifiBulkTone } {
  switch (item.state) {
    case 'queued': return { text: t('wifi.bulk.state.queued'), tone: 'muted' }
    case 'connecting': return { text: t('wifi.bulk.state.connecting'), tone: 'muted' }
    case 'sending': return { text: t('wifi.bulk.state.sending'), tone: 'muted' }
    case 'verifying': return { text: t('wifi.bulk.state.verifying'), tone: 'muted' }
    case 'connected': return { text: t('wifi.bulk.state.connected', { ip: item.ip ?? '' }).trim(), tone: 'ok' }
    case 'saved': return { text: t('wifi.bulk.state.saved'), hint: t('wifi.bulk.hint.saved'), tone: 'warn' }
    case 'failed': {
      const reason = item.failure ?? 'no_reply'
      const hint = t(`wifi.bulk.hint.${reason}` as MessageId, { detail: item.detail ?? '' })
      // Detail of a non-firmware failure (an open error) goes after the hint.
      const extra = reason !== 'rejected' && item.detail ? ` (${item.detail})` : ''
      return {
        text: t('wifi.bulk.state.failed', { reason: t(`wifi.bulk.reason.${reason}` as MessageId) }),
        hint: `${hint}${extra}`,
        tone: 'err',
      }
    }
  }
}

/** True once the device's write has finished (success or not). */
export function wifiBulkItemDone(item: WifiBulkItem): boolean {
  return item.state === 'connected' || item.state === 'saved' || item.state === 'failed'
}
