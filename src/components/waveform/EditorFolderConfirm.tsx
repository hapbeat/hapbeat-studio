import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { useWaveformStore } from '@/stores/waveformStore'

/** Asks whether a folder without haptic-knowledge/ becomes the editor folder (Waveform editor and Scene tab alike). */
export function EditorFolderConfirm() {
  const { t } = useI18n()
  const prompt = useWaveformStore(s => s.folderPrompt)
  if (!prompt) return null
  return (
    <ConfirmDialog
      open
      title={t('editor.folderConfirm.title')}
      message={t('editor.folderConfirm.message', { name: prompt.name })}
      confirmLabel={t('editor.folderConfirm.yes')}
      cancelLabel={t('editor.folderConfirm.no')}
      onConfirm={() => prompt.answer(true)}
      onCancel={() => prompt.answer(false)}
    />
  )
}
