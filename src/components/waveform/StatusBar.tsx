import { useWaveformStore } from '@/stores/waveformStore'
import { estimateWavSize, formatFileSize } from '@/utils/wavIO'
import { useI18n } from '@/i18n/I18nProvider'
export function StatusBar() {
  const { t } = useI18n()
  const clip = useWaveformStore(s => s.clip)
  const mono = useWaveformStore(s => s.exportAsMono)
  return <div className="status-bar"><span>{clip ? `PCM16 WAV · ${mono ? 'Mono' : clip.buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo'} · ${formatFileSize(estimateWavSize(clip.buffer.duration, clip.exportSampleRate, mono ? 1 : clip.buffer.numberOfChannels))}` : t('wave.emptyStatus')}</span><span>{t('editor.pendingHint')}</span></div>
}
