import { useCallback, useState } from 'react'
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog'

type AskOptions = Omit<ConfirmDialogProps, 'open' | 'onConfirm' | 'onCancel'>

interface PendingAsk extends AskOptions {
  resolve: (ok: boolean) => void
}

/**
 * Hook that gives a single component an async `confirm()` API backed
 * by `<ConfirmDialog>`. Drop `dialog` somewhere in the JSX tree and
 * call `await ask({ message, danger? })` from any handler — resolves
 * `true` if the user confirms, `false` on cancel / Escape / backdrop.
 *
 * Designed as a 1:1 replacement for `window.confirm` while keeping the
 * call site as terse: `if (!await ask({ message: '…' })) return`.
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingAsk | null>(null)

  const ask = useCallback((opts: AskOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve })
    })
  }, [])

  const dialog = pending ? (
    <ConfirmDialog
      open
      title={pending.title}
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      danger={pending.danger}
      onConfirm={() => {
        pending.resolve(true)
        setPending(null)
      }}
      onCancel={() => {
        pending.resolve(false)
        setPending(null)
      }}
    />
  ) : null

  return { ask, dialog }
}
