import { useEffect, useState } from 'react'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSerialMaster } from '@/stores/serialMaster'
import { isWebSerialSupported } from '@/utils/serialConfig'
import { FirmwareSubTab } from './FirmwareSubTab'
import './OnboardingWizard.css'

const SERIAL_DEVICE_PREFIX = 'serial:'

type Step = 'probe' | 'flash' | 'configure'

/**
 * One-track onboarding wizard. Drives all serial activity through the
 * `serialMaster` store — never touches `navigator.serial` directly so
 * Studio's single-master invariant holds (see serialMaster.ts).
 *
 * Step transitions:
 *   probe (success)  → configure
 *   probe (failed)   → user clicks「先にファームウェアを書き込む」→ flash
 *   flash (done)     → master auto-runs post-flash reprobe → configure
 *   configure       → finish (sidebar pickup) or back to probe
 */
export function OnboardingWizard() {
  const mode = useSerialMaster((s) => s.mode)
  const probeStatus = useSerialMaster((s) => s.probeStatus)
  const probeMessage = useSerialMaster((s) => s.probeMessage)
  const conn = useSerialMaster((s) => s.conn)
  const openConfig = useSerialMaster((s) => s.openConfig)
  const release = useSerialMaster((s) => s.release)

  const [step, setStep] = useState<Step>('probe')

  // Auto-route based on probe outcome.
  //
  //   success → step 3 (set the Serial pseudo-device as the
  //             primary selection so the regular DeviceDetail
  //             sub-tab UI takes over the right pane)
  //   failed  → step 2 (firmware flash) after 0.8 s
  //
  // Keying on probeStatus (not mode) avoids the mid-handshake jump
  // where mode briefly flipped to 'config' before get_info returned.
  useEffect(() => {
    if (probeStatus === 'success' && mode === 'config' && conn && step === 'probe') {
      setStep('configure')
      // Reach into deviceStore at-call-time (avoids a re-render
      // dependency loop) and select the freshly-published Serial
      // pseudo-device by its `serial:<mac>` id. The DeviceList
      // synthesizes the same id from master.info, so the IDs match.
      const info = useSerialMaster.getState().info
      if (info) {
        const id = `${SERIAL_DEVICE_PREFIX}${info.mac ?? 'active'}`
        useDeviceStore.getState().selectDevice(id)
      }
      return
    }
    if (probeStatus === 'failed' && step === 'probe') {
      // 応答なし = 新品 / ファーム未書込 が大半。即遷移して操作テンポを稼ぐ。
      // (旧 800ms 待ちは「赤字エラー文を読ませる」意図だったが、エラーではなく
      //  通常フローなので待たせる必要がない。)
      setStep('flash')
    }
  }, [probeStatus, mode, conn, step])

  // Auto-return to Step 1 when the live serial conn drops mid-setup.
  // Triggered when:
  //   - User physically unplugs the USB cable while in Step 3
  //   - Device reboots after `set_wifi` (firmware emits "disconnected"
  //     to onDisconnect callback)
  //   - User power-cycles the device after Step 2 flash to re-enter
  //     run mode → wizard already nudged them back to Step 1 via
  //     flashLastResult, but if they were lingering on Step 3 from a
  //     previous session this catches it too.
  useEffect(() => {
    if (step === 'configure' && (mode !== 'config' || !conn)) {
      setStep('probe')
    }
  }, [step, mode, conn])

  const goProbe = () => setStep('probe')

  return (
    <section className="onboarding-wizard">
      <header className="onboarding-wizard-header">
        <div className="onboarding-wizard-title">Hapbeat 初期セットアップ</div>
        <div className="onboarding-wizard-subtitle">
          USB ケーブル経由でデバイスを 3 ステップで初期設定します。
        </div>
      </header>

      <ol className="onboarding-stepper">
        <StepPill index={1} label="シリアル接続" state={stepStateFor('probe', step)}
          onClick={() => setStep('probe')} />
        <StepArrow />
        <StepPill index={2} label="ファーム書き込み" state={stepStateFor('flash', step)}
          onClick={() => setStep('flash')} />
        <StepArrow />
        <StepPill index={3} label="Wi-Fi 設定" state={stepStateFor('configure', step)}
          onClick={() => mode === 'config' && conn ? setStep('configure') : undefined}
          disabledReason={mode === 'config' && conn ? null : 'Step 1 でデバイスに接続してから移動できます'} />
      </ol>

      {!isWebSerialSupported() && (
        <div className="form-section">
          <div className="form-status err">
            このブラウザは Web Serial API をサポートしていません。
            Chrome / Edge を使ってください (HTTPS または http://localhost のみ動作)。
          </div>
        </div>
      )}

      {step === 'probe' && (
        <ProbeStep
          probeStatus={probeStatus}
          probeMessage={probeMessage}
          onTryProbe={() => openConfig()}
          onCancel={() => { void release() }}
        />
      )}

      {step === 'flash' && (
        <FlashStep onBack={goProbe} />
      )}

      {step === 'configure' && conn && (
        <ConfigureStep onDisconnect={async () => { await release(); setStep('probe') }} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------
// Step renderers
// ---------------------------------------------------------------------

function ProbeStep({
  probeStatus,
  probeMessage,
  onTryProbe,
  onCancel,
}: {
  probeStatus: ReturnType<typeof useSerialMaster> extends never ? never : string
  probeMessage: string | null
  onTryProbe: () => void
  onCancel: () => void
}) {
  const busy = probeStatus === 'connecting'
  return (
    <div className="form-section onboarding-step">
      <div className="form-section-title">Step 1 — USB Serial で接続</div>
      <div className="onboarding-step-body">
        <p>
          デバイスを USB ケーブルで PC に繋ぎ、下のボタンを押して COM ポートを選択してください。
        </p>
        <p className="onboarding-step-routing-hint">
          接続後、デバイスの応答内容に応じて自動で次のステップに進みます:
        </p>
        <ol className="onboarding-substeps">
          <li>ファーム入り → <strong>Step 3 (Wi-Fi 設定)</strong> に自動遷移</li>
          <li>応答なし (新品 / ブートローダー破損) → <strong>Step 2 (ファーム書き込み)</strong> に自動遷移</li>
        </ol>
        <div className="form-action-row">
          <button
            className="form-button onboarding-cta"
            onClick={onTryProbe}
            disabled={busy || !isWebSerialSupported()}
          >
            {busy ? '接続中…' : '🔌 USB Serial で接続'}
          </button>
          {/* 接続が応答しないとき (port.open() で詰まる / get_info に応答が来ない 等)、
              guardian の 20 秒を待たずに UI からキャンセルできるように 中止 ボタンを
              並べる。release() で port.close + state リセット。 */}
          {busy && (
            <button
              className="form-button-secondary"
              onClick={onCancel}
              title="接続を中止して Step 1 に戻る"
            >
              ⨯ 中止
            </button>
          )}
        </div>
        {probeMessage && (
          <div className={`form-status ${
            // failed = 「ファーム未書込」など通常フローのケースが大半。
            // 赤エラー (err) ではなく info/muted で表示し、ユーザーに
            // 「異常が起きた」印象を与えない。
            probeStatus === 'success' ? 'ok' : 'muted'}`}
          >
            {probeMessage}
          </div>
        )}
      </div>
    </div>
  )
}

function FlashStep({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="form-section onboarding-step">
        <div className="form-section-title">Step 2 — ファームウェア書き込み</div>
        <div className="onboarding-step-body">
          <p>
            Hapbeat 用のファームウェアを USB Serial 経由で書き込みます。
            「Serial 書き込み」ボタンを押して完了するまで待ってください。
          </p>
          <div className="form-status muted">
            👉 書き込み完了後、デバイスは書き込みモードのままなので
            <strong> 電源を一度 OFF→ON </strong>してください。その後 Step 1 に戻って「USB Serial で接続」を押せば自動で Step 3 (Wi-Fi 設定) に進みます。
          </div>
          <div className="form-action-row" style={{ marginTop: 8 }}>
            <button className="form-button-secondary" onClick={onBack}>
              ← Step 1 に戻る
            </button>
          </div>
        </div>
      </div>

      <FirmwareSubTab serialOnly postFlashReprobeMs={0} />
    </>
  )
}

function ConfigureStep({
  onDisconnect,
}: {
  onDisconnect: () => void
}) {
  // Step 3 doesn't ship its own duplicated identity / Wi-Fi forms —
  // the user explicitly asked (2026-04-30) for "one Identity form,
  // shared with the 設定 sub-tab". Selecting the Serial pseudo-
  // device in the sidebar now drops them into the regular per-
  // device sub-tab UI (Identity / Wi-Fi / UI Config / Debug Dump),
  // which routes through `useDeviceTransport` and works over USB
  // Serial transparently. So Step 3 is just a hand-off card.
  return (
    <div className="form-section onboarding-step">
      <div className="form-section-title">Step 3 — 設定 (左サイドバーで続行)</div>
      <div className="onboarding-step-body">
        <p>
          シリアル接続できました。<strong>左サイドバーの「USB Serial」 と書かれたカード</strong>を
          選ぶと、設定タブ (デバイス識別 / Wi-Fi / UI Config / Debug Dump) が開きます。
          Wi-Fi に接続するとデバイスが LAN 上に出てきて、別カードとして表示されるので、
          以降はそちらを選んでください (初期セットアップ完了)。
        </p>
        <div className="form-action-row">
          <button className="form-button-secondary" onClick={onDisconnect}>
            切断して Step 1 に戻る
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Stepper indicator
// ---------------------------------------------------------------------

type StepState = 'idle' | 'active' | 'done'

function stepStateFor(target: Step, current: Step): StepState {
  if (target === current) return 'active'
  if (current === 'configure') {
    if (target === 'probe') return 'done'
    return 'idle'
  }
  if (current === 'flash') {
    if (target === 'probe') return 'done'
    return 'idle'
  }
  return 'idle'
}

function StepPill({
  index,
  label,
  state,
  subtle,
  onClick,
  disabledReason,
}: {
  index: number
  label: string
  state: StepState
  subtle?: string
  onClick?: () => void
  /** When set, the pill is rendered disabled and the reason becomes
   *  the title tooltip. Used for Step 3 before probe success. */
  disabledReason?: string | null
}) {
  const disabled = !!disabledReason || !onClick
  return (
    <li className="onboarding-step-pill-li">
      <button
        type="button"
        className={`onboarding-step-pill state-${state}${disabled ? ' is-disabled' : ''}`}
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        title={disabledReason ?? `Step ${index} へ移動`}
      >
        <span className="onboarding-step-pill-num">{state === 'done' ? '✓' : index}</span>
        <span className="onboarding-step-pill-label">
          {label}
          {subtle && <span className="onboarding-step-pill-subtle"> {subtle}</span>}
        </span>
      </button>
    </li>
  )
}

function StepArrow() {
  return <li className="onboarding-step-arrow" aria-hidden>→</li>
}
