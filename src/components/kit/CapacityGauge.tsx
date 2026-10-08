import type { DeviceInfo } from '@/types/manager'
import type { CapacityProblem, TargetSpaceSummary } from '@/utils/deviceSpace'
import type { KitStorageEstimate } from '@/utils/kitSizeEstimate'
import { formatFileSize } from '@/utils/wavIO'
import { useI18n } from '@/i18n/I18nProvider'
import { summarizeCapacityProblems } from './capacityText'

interface CapacityGaugeProps {
  /** Bytes the kit's clips will take on the device (stored-size estimate). */
  estimate: KitStorageEstimate
  managerConnected: boolean
  /** Devices the kit would be deployed to. */
  targets: DeviceInfo[]
  summary: TargetSpaceSummary
  problems: CapacityProblem[]
  onRefresh: () => void
}

/**
 * Device clip storage of the deploy targets vs. the kit's stored size.
 * Shows the device's own reading; with several targets, the one with the
 * least free space. Without a reading the bar is grey and Used / Free say
 * "unknown" — never an assumed capacity.
 */
export function CapacityGauge({ estimate, managerConnected, targets, summary, problems, onRefresh }: CapacityGaugeProps) {
  const { t } = useI18n()
  const kitBytes = estimate.clipBytes
  const space = summary.limiting?.space ?? null
  const problemText = summarizeCapacityProblems(problems, t)

  const usedPct = space ? (space.usedBytes / space.totalBytes) * 100 : 0
  const kitPct = space ? (kitBytes / space.totalBytes) * 100 : 0

  let note: string
  if (problemText) note = problemText
  else if (!managerConnected) note = t('kit.capacity.helperOffline')
  else if (targets.length === 0) note = t('kit.capacity.noDevice')
  else if (space && summary.targetCount > 1) {
    note = t('kit.capacity.lowest', { device: summary.limiting!.name || summary.limiting!.ip, count: summary.targetCount })
    if (summary.knownCount < summary.targetCount) {
      note += t('kit.capacity.partial', { known: summary.knownCount, count: summary.targetCount })
    }
  } else if (space) note = ''
  else if (summary.pendingCount > 0) note = t('kit.capacity.querying')
  else if (summary.boardEstimate) {
    note = t('kit.capacity.boardEstimate', { board: summary.boardEstimate.board, size: formatFileSize(summary.boardEstimate.bytes) })
  } else note = t('kit.capacity.unknown')

  const volumeDevice = targets[0]

  return (
    <div className="capacity-gauge">
      <div className={`capacity-bar${space ? '' : ' unknown'}`}>
        {space && (
          <>
            <div className="capacity-used" style={{ width: `${Math.min(usedPct, 100)}%` }} />
            <div
              className={`capacity-kit ${problems.length > 0 ? 'exceed' : ''}`}
              style={{ width: `${Math.max(0, Math.min(kitPct, 100 - usedPct))}%`, left: `${Math.min(usedPct, 100)}%` }}
            />
          </>
        )}
      </div>
      <div className="capacity-labels">
        <span title={t('kit.capacity.usedTitle')}>
          {space
            ? t('kit.capacity.used', { used: formatFileSize(space.usedBytes), total: formatFileSize(space.totalBytes) })
            : t('kit.capacity.usedUnknown')}
        </span>
        <span className={problems.length > 0 ? 'capacity-warning' : ''} title={t('kit.capacity.kitTitle', { count: estimate.clipCount })}>
          {t('kit.capacity.kit', { size: formatFileSize(kitBytes) })}
        </span>
        <span title={t('kit.capacity.freeTitle')}>
          {space ? t('kit.capacity.free', { free: formatFileSize(space.freeBytes) }) : t('kit.capacity.freeUnknown')}
        </span>
        {volumeDevice?.volumeWiper != null && (
          <span className="capacity-vol" title={t('kit.volumeWiperTitle')}>
            Vol {volumeDevice.volumeWiper}/128 ({Math.round((volumeDevice.volumeWiper / 127) * 100)}%)
          </span>
        )}
      </div>
      {/* Always one line tall so the status text never moves the events list. */}
      <div className={`capacity-note${problemText ? ' capacity-warning' : ''}`} title={note}>
        <span className="capacity-note-text">{note}</span>
        {managerConnected && targets.length > 0 && (
          <button type="button" className="capacity-refresh" onClick={onRefresh} title={t('kit.capacity.refresh')} aria-label={t('kit.capacity.refresh')}>↻</button>
        )}
      </div>
    </div>
  )
}
