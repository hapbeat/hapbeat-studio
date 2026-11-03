import { useCallback, useEffect, type ReactNode } from 'react'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { helperHasFeature, helperHasType } from '@/config/helperCompat'
import { useConfirm } from '@/components/common/useConfirm'
import { useI18n, type MessageId } from '@/i18n/I18nProvider'
import type { DeviceCaps, StorageArea } from '@/utils/deviceCaps'
import type { ManagerMessage } from '@/types/manager'

const AREA_NAME: Record<StorageArea, MessageId> = {
  audio_partition: 'manage.storage.area.audio_partition',
  kit_manifest: 'manage.storage.area.kit_manifest',
  ui_config: 'manage.storage.area.ui_config',
  nvs: 'manage.storage.area.nvs',
}

const AREA_EFFECT: Record<StorageArea, MessageId> = {
  audio_partition: 'manage.storage.effect.audio_partition',
  kit_manifest: 'manage.storage.effect.kit_manifest',
  ui_config: 'manage.storage.effect.ui_config',
  nvs: 'manage.storage.effect.nvs',
}

/**
 * "Stored data" line of the device header (contracts `serial-config.md` §4.1
 * `storage_incompatible`, §4.23 `reset_storage`). A 1.x device that found
 * stored data of another format version at boot leaves it unused and lists the
 * areas; the user decides whether to reset them. Nothing is reset without the
 * user's consent. The line is always there and keeps its height, so the state
 * changing moves nothing else.
 */
export function StorageStatusRow({ info, isSerial, online, sendTo, onReset }: {
  info: { caps?: DeviceCaps; storage_incompatible?: StorageArea[] } | undefined
  isSerial: boolean
  online: boolean
  sendTo: (msg: ManagerMessage) => Promise<void> | void
  /** Fetch get_info again (the line then shows the new state). */
  onReset: () => void
}) {
  const { t } = useI18n()
  const { helperCaps, subscribe } = useHelperConnection()
  const { ask, dialog } = useConfirm()
  const areas = info?.storage_incompatible ?? []
  // Over LAN the request goes through Helper, which needs `reset_storage` (1.x).
  const canReset = isSerial || helperHasType(helperCaps, 'reset_storage')

  // A finished reset (LAN: Helper's write_result; serial: the injected one) → read the state again.
  useEffect(() => subscribe((message) => {
    const p = message.payload ?? {}
    if (message.type === 'write_result' && p.cmd === 'reset_storage' && p.success) onReset()
  }), [subscribe, onReset])

  const reset = useCallback(async () => {
    const message = [
      t('manage.storage.confirmIntro'),
      ...areas.map((a) => `・${t(AREA_NAME[a])}: ${t(AREA_EFFECT[a])}`),
      t('manage.storage.confirmOutro'),
    ].join('\n')
    const ok = await ask({
      title: t('manage.storage.confirmTitle'),
      message,
      confirmLabel: t('manage.storage.confirm'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    for (const area of areas) await sendTo({ type: 'reset_storage', payload: { area } })
  }, [areas, ask, sendTo, t])

  let state: ReactNode
  if (!info?.caps) {
    // 0.x firmware declares nothing; over LAN a 0.x Helper does not pass it through.
    const hint = !isSerial && !helperHasFeature(helperCaps, 'device_caps')
      ? t('manage.storage.unknownHelperTitle')
      : t('manage.storage.unknownTitle')
    state = <span className="devices-detail-storage-value muted" title={hint}>—</span>
  } else if (areas.length === 0) {
    state = <span className="devices-detail-storage-value">{t('manage.storage.ok')}</span>
  } else {
    const names = areas.map((a) => t(AREA_NAME[a])).join(', ')
    state = (
      <>
        <span className="devices-detail-storage-value warn" title={names}>{t('manage.storage.incompatible', { areas: names })}</span>
        {canReset ? (
          <button type="button" className="form-button-secondary devices-detail-storage-btn" onClick={() => void reset()} disabled={!online}>
            {t('manage.storage.reset')}
          </button>
        ) : (
          <span className="devices-detail-storage-value muted">{t('manage.storage.helperUpdate')}</span>
        )}
      </>
    )
  }

  return (
    <div className="devices-detail-storage">
      <span className="devices-detail-storage-label">{t('manage.storage.label')}</span>
      {state}
      {dialog}
    </div>
  )
}
